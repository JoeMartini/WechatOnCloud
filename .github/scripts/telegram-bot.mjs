// Telegram 命令机器人（轮询版）——跑在 GitHub Actions cron 上，无需任何服务器。
//
// 工作方式：每次运行调用 getUpdates 拉取「自上次确认以来」的待处理更新，逐条处理命令并回复，
// 最后用 offset=最后一条+1 再调一次 getUpdates 向 Telegram「确认」（这些更新随即被服务端清掉，
// 下次不再返回）。Telegram 自己保存 offset 状态（未确认的更新保留 24h），因此本脚本无需任何持久化存储。
//
// 支持私聊与群组（群组里以 /命令 形式发送即可，命令不受 bot 隐私模式影响）。
// 命令：/help /releases /release <tag> /issues /issue <编号>
//
// 局限：受 GitHub cron 最小 5 分钟间隔限制，命令有延迟（非实时）。要实时需改用 webhook（需 serverless 端点）。

const TG = process.env.TG_TOKEN;
const GH = process.env.GH_TOKEN || '';
const REPO = process.env.REPO; // owner/repo
if (!TG) {
  console.log('TELEGRAM_BOT_TOKEN 未配置，跳过');
  process.exit(0);
}

const tgUrl = (method) => `https://api.telegram.org/bot${TG}/${method}`;
const ghHeaders = {
  accept: 'application/vnd.github+json',
  'user-agent': 'woc-telegram-bot',
  ...(GH ? { authorization: `Bearer ${GH}` } : {}),
};

async function tg(method, params) {
  const r = await fetch(tgUrl(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}
async function gh(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: ghHeaders });
  if (!r.ok) throw new Error(`GitHub ${path} → ${r.status}`);
  return r.json();
}
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const send = (chatId, text) => tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });

const HELP = [
  '🤖 云微 WechatOnCloud 机器人命令：',
  '',
  '/releases — 最近发布列表',
  '/release <tag> — 某版本详情（省略 = 最新）',
  '/issues — 打开中的 issue 列表',
  '/issue <编号> — issue 详情',
  '/help — 显示本帮助',
  '',
  '（轮询版，命令可能有几分钟延迟）',
].join('\n');

async function handle(cmd, arg, chatId) {
  switch (cmd) {
    case '/start':
    case '/help':
      return send(chatId, HELP);

    case '/releases': {
      const rels = await gh('/releases?per_page=8');
      if (!rels.length) return send(chatId, '暂无 release');
      const lines = rels.map(
        (r) =>
          `• ${r.tag_name}${r.name && r.name !== r.tag_name ? ' — ' + r.name : ''}  (${(r.published_at || '').slice(0, 10)})`,
      );
      return send(chatId, '📦 最近发布：\n' + lines.join('\n') + '\n\n用 /release <tag> 看某版详情');
    }

    case '/release': {
      const rel = arg ? await gh(`/releases/tags/${encodeURIComponent(arg)}`) : await gh('/releases/latest');
      const title = `${rel.tag_name}${rel.name && rel.name !== rel.tag_name ? ' · ' + rel.name : ''}`;
      return send(
        chatId,
        `📦 ${title}\n发布于 ${(rel.published_at || '').slice(0, 10)}\n\n${trunc(rel.body, 2500)}\n\n🔗 ${rel.html_url}`,
      );
    }

    case '/issues': {
      const items = (await gh('/issues?state=open&per_page=10&sort=updated')).filter((i) => !i.pull_request);
      if (!items.length) return send(chatId, '🎉 当前没有打开的 issue');
      const lines = items.map((i) => `• #${i.number} ${trunc(i.title, 60)}`);
      return send(chatId, `🐛 打开中的 issue（${items.length}）：\n` + lines.join('\n') + '\n\n用 /issue <编号> 看详情');
    }

    case '/issue': {
      if (!arg) return send(chatId, '用法：/issue <编号>');
      const i = await gh(`/issues/${encodeURIComponent(arg)}`);
      if (i.pull_request) return send(chatId, `#${arg} 是个 PR，不是 issue`);
      return send(
        chatId,
        `🐛 #${i.number} ${i.title}\n状态：${i.state} · by ${i.user?.login}\n\n${trunc(i.body, 2500)}\n\n🔗 ${i.html_url}`,
      );
    }

    default:
      return; // 未知命令静默忽略，避免群里刷屏
  }
}

(async () => {
  // 短轮询拉取待处理更新（只要 message）
  const res = await (
    await fetch(tgUrl('getUpdates') + '?timeout=0&allowed_updates=' + encodeURIComponent('["message"]'))
  ).json();
  if (!res.ok) {
    console.error('getUpdates 失败:', JSON.stringify(res));
    process.exit(res.error_code === 409 ? 0 : 1); // 409 = 设了 webhook，与轮询冲突，直接退出
  }
  const updates = res.result || [];
  let maxId = 0;
  for (const u of updates) {
    maxId = Math.max(maxId, u.update_id);
    const m = u.message;
    if (!m || !m.text) continue;
    const text = m.text.trim();
    if (!text.startsWith('/')) continue;
    const parts = text.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase(); // 去掉 @botname 后缀
    const arg = parts.slice(1).join(' ').trim();
    try {
      await handle(cmd, arg, m.chat.id);
    } catch (e) {
      await send(m.chat.id, '⚠️ 出错了：' + (e?.message || e));
    }
  }
  // 向 Telegram 确认已处理（清掉这些更新，下次不再返回）
  if (maxId) {
    await fetch(tgUrl('getUpdates') + `?offset=${maxId + 1}&timeout=0`);
  }
  console.log(`processed ${updates.length} update(s)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
