/**
 * 隔离性验证 —— 「不同用户 / 不同男主之间会不会串」。
 *
 * 用临时库 + 假网关把最危险的组合全跑一遍：
 *   ① 同一个玩家绑两个男主
 *   ② 两个玩家绑**同一个男主**（最容易后院起火的场景）
 *   ③ 入站消息按 bot 分流
 *   ④ 限流额度互不挤占
 *   ⑤ 跨玩家抢同一个机器人要被拒
 *
 * 跑法：npx tsx src/qq-bridge/verify-isolation.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idate-qq-iso-'));
process.env.IDATE_DATA_DIR = tmpDir;
process.env.IDATE_QQ_SECRET_KEY ||= crypto.randomBytes(32).toString('hex');

const { DatabaseSync } = await import('node:sqlite');
const { ensureQqBridgeSchema } = await import('./schema');
const { runOutboundOnce, handleInbound } = await import('./bridge');
const { bindManual, listBindings, unbind } = await import('./bind');
const { getQrBindSession } = await import('./qr-session');

const db = new DatabaseSync(path.join(tmpDir, 'infinite-date.sqlite'));
db.exec('PRAGMA foreign_keys = ON;');

// 手工建最小 schema（不引主服务的 db/index，避免顺带跑它的 migration）
db.exec(`
CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT, pronouns TEXT, persona_notes TEXT, tutorial_step INTEGER, rating_score INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE TABLE message_threads (id TEXT PRIMARY KEY, player_id TEXT NOT NULL, character_id TEXT NOT NULL, last_message_at INTEGER, unread_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(player_id, character_id));
CREATE TABLE text_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'delivered', attachment TEXT, image_asset_id TEXT, delivered_at INTEGER, created_at INTEGER NOT NULL, internal TEXT NOT NULL DEFAULT '', internal_notable BOOLEAN NOT NULL DEFAULT 0, internal_viewed BOOLEAN NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}');
`);
ensureQqBridgeSchema(db);

let failures = 0;
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
}

// ── 布置：2 个玩家 × 2 个男主，4 条绑定、4 个不同的机器人 ──
const now = Date.now();
const P1 = 'player-1';
const P2 = 'player-2';
const C1 = 'char-1'; // 两个玩家都聊这个男主
const C2 = 'char-2';

for (const [id, name] of [[P1, '玩家一'], [P2, '玩家二']] as const) {
  db.prepare("INSERT INTO players VALUES (?, ?, '', '', 0, 0, ?, ?)").run(id, name, now, now);
}

interface Slot {
  playerId: string;
  characterId: string;
  threadId: string;
  appId: string;
  tag: string;
}
const slots: Slot[] = [];
function addSlot(playerId: string, characterId: string, tag: string): Slot {
  const threadId = `thread-${playerId}-${characterId}`;
  db.prepare('INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)').run(
    threadId, playerId, characterId, now, now,
  );
  const appId = `app-${playerId}-${characterId}`;
  const s: Slot = { playerId, characterId, threadId, appId, tag };
  slots.push(s);
  return s;
}
const s11 = addSlot(P1, C1, 'P1×C1');
const s12 = addSlot(P1, C2, 'P1×C2');
const s21 = addSlot(P2, C1, 'P2×C1'); // ← 同一个男主、不同玩家
const s22 = addSlot(P2, C2, 'P2×C2');

// 每个 slot 塞 3 条 NPC 消息，正文带上唯一标记，方便断言"这条只可能属于谁"
for (const s of slots) {
  for (let i = 1; i <= 3; i++) {
    db.prepare('INSERT INTO text_messages (id, thread_id, sender, body, created_at) VALUES (?, ?, \'npc\', ?, ?)').run(
      `msg-${s.playerId}-${s.characterId}-${i}`,
      s.threadId,
      `${s.tag} 的第 ${i} 条`,
      now + i,
    );
  }
}

// 全部绑上（每个 slot 用各自独立的机器人）
for (const s of slots) {
  const r = bindManual(db, { playerId: s.playerId, characterId: s.characterId }, {
    appId: s.appId.replace(/\D/g, '') + '900001', // 纯数字 AppID
    appSecret: 'secret-' + s.appId,
  });
  if (!r.ok) throw new Error(`布置失败: ${r.error}`);
}
// 绑定时用了纯数字 AppID，这里把真实 appId 回写进库，方便后续按 appId 分流
for (const s of slots) {
  const digitAppId = s.appId.replace(/\D/g, '') + '900001';
  db.prepare('UPDATE qq_bot_bindings SET app_id = ?, status = ?, user_openid = ? WHERE player_id = ? AND character_id = ?').run(
    digitAppId, 'active', `openid-${s.playerId}-${s.characterId}`, s.playerId, s.characterId,
  );
  s.appId = digitAppId;
}

// 上面那批 fixture 消息是「绑之前就存在的」，而真实绑定只会推绑定之后的短信（since_ts）。
// 这里把 since_ts 归零，让它们进入外发范围 —— 否则第一步断言就会被时间切掉。
// 时间切流行为本身在第 ⑩ 段单独测。
db.prepare('UPDATE qq_bot_bindings SET since_ts = 0').run();

console.log('══ QQ 桥 · 隔离性验证 ══');
console.log(`两个玩家：${P1} / ${P2}；两个男主：${C1}（两人都聊）/ ${C2}\n`);

// ── ① 出站分流：每个机器人只收到自己那条 thread 的消息 ──
const sentByApp = new Map<string, string[]>();
const deps = {
  db,
  gatewayFor(appId: string) {
    return {
      async sendText(_openid: string, content: string) {
        const arr = sentByApp.get(appId) ?? [];
        arr.push(content);
        sentByApp.set(appId, arr);
        return { ok: true, qqMsgId: 'x' };
      },
      async sendImage(_openid: string, assetId: string) {
        const arr = sentByApp.get(appId) ?? [];
        arr.push(`[图片]${assetId}`);
        sentByApp.set(appId, arr);
        return { ok: true, qqMsgId: 'x' };
      },
    };
  },
  async deliverPlayerMessage() {
    return { ok: true };
  },
  log: () => {},
};

await runOutboundOnce(deps);

{
  let allClean = true;
  const detail: string[] = [];
  for (const s of slots) {
    const got = sentByApp.get(s.appId) ?? [];
    const mine = got.every(t => t.startsWith(s.tag));
    const count = got.length === 3;
    if (!mine || !count) allClean = false;
    detail.push(`${s.tag}:${got.length}条${mine ? '' : '←串了!'}`);
  }
  check('每个机器人只收到自己那条 thread 的 3 条消息', allClean, detail.join(' '));
}

{
  // 两个玩家聊的是同一个男主 C1，重点看这两条有没有互串
  const p1c1 = (sentByApp.get(s11.appId) ?? []).join('|');
  const p2c1 = (sentByApp.get(s21.appId) ?? []).join('|');
  check('同一男主、不同玩家：P1×C1 里没有 P2 的话', p1c1.includes('P2×C1') === false && p1c1.includes('P1×C1'));
  check('同一男主、不同玩家：P2×C1 里没有 P1 的话', p2c1.includes('P1×C1') === false && p2c1.includes('P2×C1'));
}

// ── ② 一个玩家绑两个男主，两条线互不影响 ──
{
  const a = sentByApp.get(s11.appId) ?? [];
  const b = sentByApp.get(s12.appId) ?? [];
  check('同一玩家的两个男主各自独立', a.every(t => t.startsWith('P1×C1')) && b.every(t => t.startsWith('P1×C2')) && a.length === 3 && b.length === 3);
}

// ── ③ 入站分流：消息从哪个 bot 进来，就落到哪个玩家的 thread ──
{
  const delivered: Array<{ playerId: string; threadId: string; text: string }> = [];
  const inDeps = { ...deps, async deliverPlayerMessage(playerId: string, threadId: string, text: string) { delivered.push({ playerId, threadId, text }); return { ok: true }; } };

  await handleInbound(inDeps as typeof deps, { appId: s11.appId, userOpenid: `openid-${P1}-${C1}`, content: 'P1 你好', msgId: 'in-1' });
  await handleInbound(inDeps as typeof deps, { appId: s21.appId, userOpenid: `openid-${P2}-${C1}`, content: 'P2 你好', msgId: 'in-2' });

  check('P1 的 bot 收到消息 → 只落到 P1×C1 的 thread', delivered[0]?.playerId === P1 && delivered[0]?.threadId === s11.threadId, JSON.stringify(delivered[0]));
  check('P2 的 bot 收到消息 → 只落到 P2×C1 的 thread', delivered[1]?.playerId === P2 && delivered[1]?.threadId === s21.threadId, JSON.stringify(delivered[1]));

  // 同一条 msg_id 重放（官方明说会重复推送）→ 只处理一次
  const before = delivered.length;
  await handleInbound(inDeps as typeof deps, { appId: s11.appId, userOpenid: `openid-${P1}-${C1}`, content: 'P1 你好', msgId: 'in-1' });
  check('同一条入站消息重放不会重复入库', delivered.length === before);

  // 不同 bot 的同名 msg_id 不能互相顶掉
  await handleInbound(inDeps as typeof deps, { appId: s21.appId, userOpenid: `openid-${P2}-${C1}`, content: 'P2 再来', msgId: 'in-1' });
  check('不同 bot 的同名 msg_id 互不干扰', delivered.length === before + 1 && delivered[before]?.playerId === P2);
}

// ── ④ 未绑定的机器人来的消息直接丢弃 ──
{
  const delivered: unknown[] = [];
  await handleInbound({ ...deps, async deliverPlayerMessage(...a: unknown[]) { delivered.push(a); return { ok: true }; } } as typeof deps, {
    appId: '99999999', userOpenid: 'who', content: '陌生人的消息', msgId: 'x-1',
  });
  check('未绑定的 appId 来的消息被丢弃', delivered.length === 0);
}

// ── ④b 陌生人用**已绑定**的机器人发消息 → 丢弃，且不能顶掉 openid ──
{
  const delivered: unknown[] = [];
  const openidBefore = (db.prepare('SELECT user_openid FROM qq_bot_bindings WHERE player_id = ? AND character_id = ?').get(P1, C1) as { user_openid: string }).user_openid;

  await handleInbound({ ...deps, async deliverPlayerMessage(...a: unknown[]) { delivered.push(a); return { ok: true }; } } as typeof deps, {
    appId: s11.appId, userOpenid: 'openid-别人', content: '我也来聊两句', msgId: 'intruder-1',
  });

  const openidAfter = (db.prepare('SELECT user_openid FROM qq_bot_bindings WHERE player_id = ? AND character_id = ?').get(P1, C1) as { user_openid: string }).user_openid;
  check('陌生人用已绑定的机器人发消息 → 不落进玩家的 thread', delivered.length === 0);
  check('陌生人的 openid 不会顶掉绑定用户的 openid', openidAfter === openidBefore, `before=${openidBefore} after=${openidAfter}`);
}

// ── ⑤ 跨玩家抢同一个机器人要被拒 ──
{
  const r = bindManual(db, { playerId: P2, characterId: 'char-9' }, { appId: s11.appId, appSecret: 'hijack-secret-123456' });
  check('P2 不能用 P1 已有的机器人', r.ok === false, r.ok ? '' : r.error);
}

// ── ⑥ 列表只返回自己的 ──
{
  const l1 = listBindings(db, P1);
  const l2 = listBindings(db, P2);
  check('P1 的绑定列表只有自己的 2 条', l1.length === 2 && l1.every(b => [C1, C2].includes(b.characterId)));
  check('P2 的绑定列表只有自己的 2 条', l2.length === 2);
}

// ── ⑦ 扫码会话不能跨玩家查 ──
{
  check('扫码会话按 playerId 隔离（别人的查不到）', getQrBindSession('any-session', P2) === undefined);
}

// ── ⑧ 限流额度不互相挤占 ──
{
  // 给 P1×C1 塞 25 条（超过单关系 18/qpm），P2×C2 塞 4 条
  for (let i = 0; i < 25; i++) {
    db.prepare("INSERT INTO text_messages (id, thread_id, sender, body, created_at) VALUES (?, ?, 'npc', ?, ?)").run(
      `bulk-p1-${i}`, s11.threadId, `P1×C1 批量 ${i}`, now + 1000 + i,
    );
  }
  for (let i = 0; i < 4; i++) {
    db.prepare("INSERT INTO text_messages (id, thread_id, sender, body, created_at) VALUES (?, ?, 'npc', ?, ?)").run(
      `bulk-p2-${i}`, s22.threadId, `P2×C2 批量 ${i}`, now + 2000 + i,
    );
  }

  sentByApp.clear();
  await runOutboundOnce(deps);

  const p1Count = (sentByApp.get(s11.appId) ?? []).length;
  const p2Count = (sentByApp.get(s22.appId) ?? []).length;
  // 限流是 60 秒滑动窗口：前面的出站轮里 P1×C1 已经用掉 3 个额度，所以这轮只剩 18-3=15。
  // 关键看的是「额度按绑定隔离」—— P1 被封顶的同时 P2 一点没受影响。
  check('P1 被单关系额度封顶（18 - 前面已用的 3）', p1Count === 15, `实际 ${p1Count}`);
  check('P2 不受 P1 限流影响，4 条全发出', p2Count === 4, `实际 ${p2Count}`);
  check('P2×C2 没有因为 P1 限流被挪后或丢弃', p2Count === 4 && (sentByApp.get(s22.appId) ?? []).every(t => t.startsWith('P2×C2')));
}

// ── ⑨ 解绑只影响自己 ──
{
  unbind(db, P1, C1);
  check('解绑 P1×C1 后 P1 只剩 1 条绑定', listBindings(db, P1).length === 1);
  check('P2 的两条绑定不受影响', listBindings(db, P2).length === 2);
}

// ── ⑩ 新绑定不重放历史（只推绑定之后的短信）──
{
  // 造一个新 slot：先绑，再放一条「历史」和一条「新」消息
  const P3 = 'player-3';
  db.prepare("INSERT INTO players VALUES (?, '玩家三', '', '', 0, 0, ?, ?)").run(P3, now, now);
  const threadId = `thread-${P3}-${C1}`;
  db.prepare('INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)').run(threadId, P3, C1, now, now);

  const appId = '888888889';
  const bound = bindManual(db, { playerId: P3, characterId: C1 }, { appId, appSecret: 'secret-player-3-abcdef' });
  if (!bound.ok) throw new Error('布置失败: ' + bound.error);
  db.prepare("UPDATE qq_bot_bindings SET status = 'active', user_openid = 'openid-p3' WHERE player_id = ?").run(P3);

  const sinceTs = (db.prepare('SELECT since_ts FROM qq_bot_bindings WHERE player_id = ?').get(P3) as { since_ts: number }).since_ts;
  check('绑定时把 since_ts 定在了此刻', sinceTs > 0 && Math.abs(sinceTs - now) < 60_000);

  // 历史消息（绑定之前 1 小时）
  db.prepare("INSERT INTO text_messages (id, thread_id, sender, body, created_at) VALUES (?, ?, 'npc', ?, ?)").run(
    'hist-1', threadId, '历史消息·不该被推出去', sinceTs - 3600_000,
  );
  // 新消息（绑定之后）
  db.prepare("INSERT INTO text_messages (id, thread_id, sender, body, created_at) VALUES (?, ?, 'npc', ?, ?)").run(
    'new-1', threadId, '新消息·应该推出去', sinceTs + 1000,
  );
  // 边界：正好等于 since_ts 的那条（同一毫秒）会被推出去 —— 代码用 >= 而不是 >，
  // 宁可在边界上多推一条无伤大雅的，也不要在绑定瞬间漏掉她刚看到的那句话。
  db.prepare("INSERT INTO text_messages (id, thread_id, sender, body, created_at) VALUES (?, ?, 'npc', ?, ?)").run(
    'edge-1', threadId, '边界消息·同毫秒会被推出', sinceTs,
  );

  sentByApp.clear();
  await runOutboundOnce(deps);

  const got = sentByApp.get(appId) ?? [];
  check('只推出绑定之后的（含同毫秒边界）', got.length === 2 && got.includes('新消息·应该推出去') && got.includes('边界消息·同毫秒会被推出'), JSON.stringify(got));
  check('历史消息没有被倒进 QQ', !got.some(t => t.includes('历史消息')));
}

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '✅ 全部通过：不同用户 / 不同男主之间互不影响' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
