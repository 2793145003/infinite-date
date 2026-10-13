/**
 * 绑定接口的离线验证 —— 不占端口、不连生产库、不动线上服务。
 *
 * 做法：把 IDATE_DATA_DIR 指到临时目录，用 fastify 的 app.inject() 直接打接口，
 * 所以既不用起端口，也不会碰到 apps/server/data 里的生产库。
 *
 * 跑法：
 *   npx tsx src/qq-bridge/verify-routes.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ⚠️ 必须在 import db 之前设置：db 在模块加载时就会按这个路径打开库
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idate-qq-verify-'));
process.env.IDATE_DATA_DIR = tmpDir;
process.env.IDATE_QQ_SECRET_KEY ||= crypto.randomBytes(32).toString('hex');

const { db } = await import('../db/index');
const { default: Fastify } = await import('fastify');
const { qqBridgeRoutes } = await import('../routes/qq-bridge');

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
}

// ── 造一个玩家 + 会话 token ──────────────────────────────
const playerId = 'verify-player';
const token = 'verify-token-' + crypto.randomUUID();
const now = Date.now();
db.prepare(
  `INSERT INTO players (id, name, pronouns, persona_notes, tutorial_step, rating_score, created_at, updated_at)
   VALUES (?, '验证用', '', '', 0, 0, ?, ?)`,
).run(playerId, now, now);
db.prepare('INSERT INTO sessions (token, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
  token,
  playerId,
  now,
  now + 3600_000,
);

const app = Fastify();
await app.register(qqBridgeRoutes);
await app.ready();

const auth = { authorization: `Bearer ${token}` };
const characterId = 'char-verify-1';

console.log('══ QQ 绑定接口离线验证 ══');
console.log(`临时库: ${tmpDir}\n`);

// ── 1. 未认证要被挡 ──────────────────────────────────────
{
  const res = await app.inject({ method: 'GET', url: '/qq/bindings' });
  check('未带 token 时被拒（401）', res.statusCode === 401, `status=${res.statusCode}`);
}

// ── 2. 初始状态：没有绑定 ────────────────────────────────
{
  const res = await app.inject({ method: 'GET', url: '/qq/bindings', headers: auth });
  const body = res.json() as { bindings: unknown[] };
  check('初始没有任何绑定', res.statusCode === 200 && Array.isArray(body.bindings) && body.bindings.length === 0, `status=${res.statusCode}`);
}

// ── 3. 手填 AppID / AppSecret ────────────────────────────
{
  const res = await app.inject({
    method: 'POST',
    url: '/qq/bind/manual',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { characterId, appId: '102000000', appSecret: 'abcdefghijklmnopqrstuvwxyz123456' },
  });
  check('手填绑定成功', res.statusCode === 200, `status=${res.statusCode} body=${res.body.slice(0, 120)}`);
}

// ── 4. 绑定后能查到，且**不泄露密钥** ────────────────────
{
  const res = await app.inject({ method: 'GET', url: '/qq/bindings', headers: auth });
  const body = res.json() as { bindings: Array<Record<string, unknown>> };
  const b = body.bindings[0];
  check('能查到刚绑的这条', Boolean(b) && b?.characterId === characterId);
  check('接口不返回 AppSecret（也没有任何密钥字段）', !res.body.includes('abcdefghijklmnopqrstuvwxyz') && !res.body.includes('app_secret_enc'));
  check('库里存的是密文不是明文', (() => {
    const row = db.prepare('SELECT app_secret_enc FROM qq_bot_bindings WHERE character_id = ?').get(characterId) as { app_secret_enc: string };
    return !row.app_secret_enc.includes('abcdefghijklmnopqrstuvwxyz') && row.app_secret_enc.length > 20;
  })());
}

// ── 5. 参数校验 ──────────────────────────────────────────
{
  const res = await app.inject({
    method: 'POST',
    url: '/qq/bind/manual',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { characterId: 'other-char', appId: 'abc', appSecret: 'short' },
  });
  check('AppID 非数字被拒', res.statusCode === 400, `status=${res.statusCode}`);

  const res2 = await app.inject({
    method: 'POST',
    url: '/qq/bind/manual',
    headers: { ...auth, 'content-type': 'application/json' },
    payload: { characterId: 'other-char', appId: '102000000', appSecret: 'abcdefghijklmnopqrstuvwxyz123456' },
  });
  check('同一个机器人不能绑给第二个角色', res2.statusCode === 400, `body=${res2.body.slice(0, 100)}`);
}

// ── 6. 扫码：真的去和腾讯建绑定任务并生成二维码 ──────────
{
  let qrOk = false;
  let note = '';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/qq/bind/qr/start',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { characterId: 'char-verify-2' },
    });
    const body = res.json() as { sessionId?: string; qrDataUrl?: string; error?: string };
    if (res.statusCode === 200 && body.qrDataUrl?.startsWith('data:image/png;base64,')) {
      qrOk = true;
      note = `二维码 ${Math.round((body.qrDataUrl.length * 3) / 4 / 1024)}KB`;
      // 顺便验证能轮询到状态
      const poll = await app.inject({ method: 'GET', url: `/qq/bind/qr/${body.sessionId}`, headers: auth });
      const ps = poll.json() as { state?: string };
      check('轮询扫码状态返回 waiting', poll.statusCode === 200 && ps.state === 'waiting', `state=${ps.state}`);
      // 别人的会话查不到
      const other = await app.inject({ method: 'GET', url: `/qq/bind/qr/${body.sessionId}`, headers: { authorization: 'Bearer nope' } });
      check('未认证不能查扫码会话', other.statusCode === 401);
    } else {
      note = body.error ?? res.body.slice(0, 160);
    }
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  check('扫码接口返回可用的二维码 PNG', qrOk, note);
}

// ── 7. 解绑 ──────────────────────────────────────────────
{
  const res = await app.inject({ method: 'DELETE', url: `/qq/bind/${characterId}`, headers: auth });
  const after = await app.inject({ method: 'GET', url: '/qq/bindings', headers: auth });
  const body = after.json() as { bindings: unknown[] };
  check('解绑后列表为空', res.statusCode === 200 && body.bindings.length === 0);
}

await app.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
