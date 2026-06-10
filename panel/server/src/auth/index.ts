import type { AuthProvider } from './types.js';
import { LocalAuthProvider } from './local.js';
import { OIDCAuthProvider } from './oidc.js';
import { readFileSync } from 'node:fs';

// 优先级：1) /run/secrets/auth_mode 文件 2) WOC_AUTH_TYPE 环境变量 3) WOC_AUTH_MODE 环境变量 4) 默认 local
function resolveAuthMode(): string {
  try {
    const fromFile = readFileSync('/run/secrets/auth_mode', 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* ignore */ }
  return process.env.WOC_AUTH_TYPE || process.env.WOC_AUTH_MODE || 'local';
}

const MODE = resolveAuthMode();

export function createAuthProvider(): AuthProvider {
  switch (MODE) {
    case 'oidc':
    case 'oidc_full':
      return new OIDCAuthProvider();
    case 'local':
    default:
      return new LocalAuthProvider();
  }
}

export * from './types.js';
