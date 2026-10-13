/**
 * 并发重入验证 —— 复现「一轮还没跑完，下一轮追尾并发跑」导致的重复推送。
 *
 * 症状（星落报的）：网页端只有一张图/一条消息，QQ 上却有两张/两条，而且**偶发**。
 * 机制：出站循环是 setInterval(20s)，一轮里图片要先上传再发（秒级），很容易超过 20 秒；
 *      追尾的那一轮把同一批消息又读了一遍，而 claim() 看到 outbox 里是
 *      status='queued' / attempts=0，就判定为「重试」并再发一次。
 *
 * 跑法：npx tsx src/qq-bridge/verify-concurrency.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idate-qq-conc-'));
process.env.IDATE_DATA_DIR = tmpDir;
process.env.IDATE_QQ_SECRET_KEY ||= crypto.randomBytes(32).toString('hex');

const { DatabaseSync } = await import('node:sqlite');
const { ensureQqBridgeSchema } = await import('./schema');
const { runOutboundOnce } = await import('./bridge');

const db = new DatabaseSync(path.join(tmpDir, 'infinite-date.sqlite'));
db.exec(`
CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT, pronouns TEXT, persona_notes TEXT, tutorial_step INTEGER, rating_score INTEGER, created_at INTEGER, updated_at INTEGER);
CREATE TABLE message_threads (id TEXT PRIMARY KEY, player_id TEXT NOT NULL, character_id TEXT NOT NULL, last_message_at INTEGER, unread_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(player_id, character_id));
CREATE TABLE text_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'delivered', attachment TEXT, image_asset_id TEXT, delivered_at INTEGER, created_at INTEGER NOT NULL, internal TEXT NOT NULL DEFAULT '', internal_notable BOOLEAN NOT NULL DEFAULT 0, internal_viewed BOOLEAN NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}');
`);
ensureQqBridgeSchema(db);

let failures = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// 一个玩家、一个角色、一条绑定、12 条待发消息
const now = Date.now();
const P = 'p1';
const C = 'c1';
const TH = 'th1';
db.prepare("INSERT INTO players VALUES (?, '甲', '', '', 0, 0, ?, ?)").run(P, now, now);
db.prepare('INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)').run(TH, P, C, now, now);
db.prepare(
  `INSERT INTO qq_bot_bindings (id, player_id, character_id, app_id, app_secret_enc, user_openid, status, since_ts, created_at, updated_at)
   VALUES ('b1', ?, ?, '100000001', 'mock', 'openid-1', 'active', 0, ?, ?)`,
).run(P, C, now, now);
for (let i = 0; i < 12; i++) {
  db.prepare("INSERT INTO text_messages (id, thread_id, sender, body, created_at) VALUES (?, ?, 'npc', ?, ?)").run(`m${i}`, TH, `第 ${i} 条`, now + i);
}

// 假网关：每次调用都记一笔，并故意慢 150ms（模拟上传图片的真实耗时）
const delivered: string[] = [];
function makeDeps() {
  return {
    db,
    gatewayFor: () => ({
      async sendText(_openid: string, content: string) {
        await new Promise(r => setTimeout(r, 150));
        delivered.push(content);
        return { ok: true, qqMsgId: `q${delivered.length}` };
      },
      async sendImage() {
        return { ok: true, qqMsgId: 'x' };
      },
    }),
    async deliverPlayerMessage() {
      return { ok: true };
    },
    log: () => {},
  } as Parameters<typeof runOutboundOnce>[0];
}

console.log('══ QQ 桥 · 出站并发重入验证 ══');
console.log('场景：12 条待发消息，两轮出站循环同时跑（模拟一轮超过 20 秒、下一轮追尾）\n');

// 关键：并发跑两轮（不 await 第一轮就开始第二轮）
const deps = makeDeps();
await Promise.all([runOutboundOnce(deps), runOutboundOnce(deps)]);

const unique = new Set(delivered);
const dup = delivered.length - unique.size;
console.log(`投递次数 ${delivered.length} / 不同消息 ${unique.size} / 重复 ${dup}\n`);

check('每条消息只投递一次', dup === 0 && delivered.length === 12, dup > 0 ? `重复了 ${dup} 条` : '');

// 逐条列出被重复投递的
const count = new Map<string, number>();
for (const d of delivered) count.set(d, (count.get(d) ?? 0) + 1);
const repeated = [...count.entries()].filter(([, n]) => n > 1);
if (repeated.length) {
  console.log('\n被重复投递的：');
  for (const [body, n] of repeated.slice(0, 6)) console.log(`  x${n}  ${body}`);
}

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '✅ 通过：并发下不会重复投递' : '❌ 复现了重复投递 —— 需要给 claim 加原子占用 + 给循环加重入锁'}`);
process.exit(failures === 0 ? 0 : 1);
