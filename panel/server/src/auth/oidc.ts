import { randomBytes } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { decodeJwt } from 'jose';
import type { AuthProvider, User, Role } from './types.js';
import {
  findByUsername,
  findById,
  listRawUsers as storeListUsers,
  userCanAccess as storeUserCanAccess,
  createSub,
  persist,
  type User as StoreUser,
} from '../store.js';
import { createSession, destroySession, getSession } from '../sessions.js';
import { KeycloakRoleSync } from './oidc-keycloak.js';

const COOKIE = 'woc_sess';
const COOKIE_STATE = 'woc_oidc_state';
const COOKIE_NONCE = 'woc_oidc_nonce';

const ISSUER_URL = process.env.WOC_OIDC_ISSUER || '';
const CLIENT_ID = process.env.WOC_OIDC_CLIENT_ID || '';
const _oidc_auth_key_ = (function(){ try { return require('fs').readFileSync('/run/secrets/oidc_secret','utf8').trim(); } catch(e){ return ''; } })();
const REDIRECT_URI = process.env.WOC_OIDC_REDIRECT_URI || '';
const ROLE_CLAIM = process.env.WOC_OIDC_ROLE_CLAIM || `resource_access.${CLIENT_ID}.roles`;
const ADMIN_ROLE = process.env.WOC_OIDC_ADMIN_ROLE || 'woc:admin';
const AUTO_PROVISION = process.env.WOC_OIDC_AUTO_PROVISION !== 'false';
const LOGOUT_REDIRECT_URI = process.env.WOC_OIDC_LOGOUT_REDIRECT_URI || '/login';

interface OidcMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

export class OIDCAuthProvider implements AuthProvider {
  private meta: OidcMeta | null = null;
  private kcSync = new KeycloakRoleSync();

  async init(): Promise<void> {
    if (!ISSUER_URL || !CLIENT_ID) {
      throw new Error('OIDC not configured: WOC_OIDC_ISSUER and WOC_OIDC_CLIENT_ID required');
    }
    this.meta = {
      issuer: ISSUER_URL,
      authorization_endpoint: `${ISSUER_URL}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER_URL}/protocol/openid-connect/token`,
      userinfo_endpoint: `${ISSUER_URL}/protocol/openid-connect/userinfo`,
      end_session_endpoint: `${ISSUER_URL}/protocol/openid-connect/logout`,
    };
    console.log(`[oidc] Using manual issuer: ${this.meta.issuer}`);
    await this.kcSync.init();
  }

  async login(_req: FastifyRequest, reply: FastifyReply): Promise<any> {
    if (!this.meta) throw new Error('OIDC not initialized');

    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');

    const url = new URL(this.meta.authorization_endpoint);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);

    reply.setCookie(COOKIE_STATE, state, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 });
    reply.setCookie(COOKIE_NONCE, nonce, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 });
    return reply.redirect(url.href);
  }

  async callback(req: FastifyRequest, reply: FastifyReply): Promise<any> {
    if (!this.meta) throw new Error('OIDC not initialized');

    const state = req.cookies?.[COOKIE_STATE];
    const nonce = req.cookies?.[COOKIE_NONCE];
    reply.clearCookie(COOKIE_STATE, { secure: true, path: '/' });
    reply.clearCookie(COOKIE_NONCE, { secure: true, path: '/' });

    if (!state) {
      return reply.code(400).send({ error: 'Missing state cookie' });
    }

    const query = req.query as Record<string, string>;
    if (query.state !== state) {
      return reply.code(400).send({ error: 'Invalid state parameter' });
    }
    if (!query.code) {
      return reply.code(400).send({ error: 'Missing authorization code' });
    }

    try {
      const tokenResp = await fetch(this.meta.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          client_secret: _oidc_auth_key_,
        }),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text();
        throw new Error(`Token exchange failed: ${tokenResp.status} ${errText}`);
      }

      const tokenData = await tokenResp.json();
      if (!tokenData.id_token) {
        return reply.code(400).send({ error: 'No id_token in response' });
      }

      const claims: any = decodeJwt(tokenData.id_token);

      if (nonce && claims.nonce !== nonce) {
        return reply.code(400).send({ error: 'Invalid nonce' });
      }

      const roles = this._extractRoles(claims);
      const displayName = String(claims.name || claims.preferred_username || claims.sub);
      const claimsSub = String(claims.sub);

      let user = storeListUsers().find((u) => u.oidcSub === claimsSub);
      if (!user && AUTO_PROVISION) {
        user = findByUsername(`oidc:${claimsSub}`);
      }

      if (!user && AUTO_PROVISION) {
        const role: Role = roles.includes(ADMIN_ROLE) ? 'admin' : 'sub';
        const randomPw = randomBytes(32).toString('hex');
        user = createSub(`oidc:${claimsSub}`, randomPw, [], { displayName, oidcSub: claimsSub });
      }

      if (!user) {
        return reply.code(403).send({ error: '用户未授权，请联系管理员' });
      }

      let needsPersist = false;
      if (user.displayName !== displayName) {
        user.displayName = displayName;
        needsPersist = true;
      }
      if (user.oidcSub !== claimsSub) {
        user.oidcSub = claimsSub;
        needsPersist = true;
      }
      if (needsPersist) persist();

      const expectedRole: Role = roles.includes(ADMIN_ROLE) ? 'admin' : 'sub';
      if (user.role !== expectedRole) {
        user.role = expectedRole;
        persist();
        console.log(`[oidc] Role synced for ${user.username}: ${user.role} -> ${expectedRole}`);
      }

      const token = createSession(user.id);
      reply.setCookie(COOKIE, token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 12,
      });

      return reply.redirect('/');
    } catch (err: any) {
      console.error('[oidc] Callback error:', err);
      return reply.code(400).send({ error: 'OIDC authentication failed: ' + (err.message || err) });
    }
  }

  async logout(req: FastifyRequest, reply: FastifyReply): Promise<any> {
    destroySession(req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { secure: true, path: '/' });

    if (this.meta?.end_session_endpoint) {
      const url = new URL(this.meta.end_session_endpoint);
      url.searchParams.set('client_id', CLIENT_ID);
      url.searchParams.set('post_logout_redirect_uri', LOGOUT_REDIRECT_URI);
      return reply.redirect(url.href);
    }
    return reply.redirect('/login');
  }

  async currentUser(req: FastifyRequest): Promise<User | null> {
    const token = req.cookies?.[COOKIE];
    const s = getSession(token);
    if (!s) return null;
    const u = findById(s.userId);
    if (!u || u.disabled) return null;
    return this._toUser(u);
  }

  async requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const u = await this.currentUser(req);
    if (!u) {
      reply.code(401).send({ error: '未登录' });
      return null;
    }
    return u;
  }

  async requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<User | null> {
    const u = await this.requireAuth(req, reply);
    if (!u) return null;
    if (u.role !== 'admin') {
      reply.code(403).send({ error: '需要管理员权限' });
      return null;
    }
    return u;
  }

  userCanAccess(user: User, instanceId: string): boolean {
    const u = findById(user.id);
    if (!u) return false;
    return storeUserCanAccess(u, instanceId);
  }

  listUsers(): User[] {
    return storeListUsers().map((u) => this._toUser(u));
  }

  async ensureUser(opts: { sub: string; username: string; email?: string; roles?: string[] }): Promise<User> {
    let u = storeListUsers().find((x) => x.oidcSub === String(opts.sub));
    if (!u) {
      u = findByUsername(`oidc:${opts.sub}`);
    }
    if (!u && AUTO_PROVISION) {
      const randomPw = randomBytes(32).toString('hex');
      u = createSub(`oidc:${opts.sub}`, randomPw, [], { displayName: opts.username, oidcSub: opts.sub });
    }
    if (!u) throw new Error('User not found and auto-provision disabled');
    return this._toUser(u);
  }

  async onInstanceCreated(instance: any): Promise<void> {
    await this.kcSync.onInstanceCreated(instance);
  }

  async onInstanceDeleted(instanceId: string): Promise<void> {
    await this.kcSync.onInstanceDeleted(instanceId);
  }

  private _extractRoles(claims: any, claimPath?: string): string[] {
    if (!ROLE_CLAIM) return [];
    const path = claimPath || ROLE_CLAIM;
    const parts = path.split('.');
    let val = claims;
    for (const part of parts) {
      if (val && typeof val === 'object') {
        const key = part.includes('${client_id}') ? part.replace('${client_id}', CLIENT_ID) : part;
        val = val[key];
      } else {
        return [];
      }
    }
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') return [val];
    return [];
  }

  private _toUser(u: StoreUser): User {
    const friendlyName = u.displayName || (u.username.startsWith('oidc:') ? u.username.slice(5) : u.username);
    return {
      id: u.id,
      username: friendlyName,
      role: u.role,
      allowedInstances: u.role === 'admin' ? [] : u.allowedInstances,
      displayName: u.displayName,
      oidcSub: u.oidcSub || (u.username.startsWith('oidc:') ? u.username.slice(5) : undefined),
      oidcIssuer: ISSUER_URL,
      disabled: u.disabled ?? false,
      createdAt: u.createdAt || new Date().toISOString(),
    };
  }
}
