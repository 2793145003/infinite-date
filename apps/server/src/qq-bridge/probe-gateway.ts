/**
 * 网关探针：把 QQ 机器人网关的**原始帧**全打出来。
 *
 * 为什么需要：桥里只打"握手成功 / 关闭"，中间那些"服务器一声不吭"的情况看不见。
 * 实测踩到过：收到 hello、发出 identify 之后就永远没下文 —— 既没有 READY 也没有关闭帧。
 * 这种半开状态只能靠看原始帧定位（是 op 9 会话无效？还是被静默忽略？）。
 *
 * 跑法：
 *   npx tsx src/qq-bridge/probe-gateway.ts                # 用库里第一条绑定的凭证
 *   npx tsx src/qq-bridge/probe-gateway.ts --appid 123 --secret xxx
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { decryptSecret } from './crypto';

const argv = process.argv.slice(2);
const get = (k: string): string | undefined => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dataDir = process.env.IDATE_DATA_DIR || path.resolve(process.cwd(), 'data');
const dbPath = get('--db') || path.join(dataDir, 'infinite-date.sqlite');

let appId = get('--appid') ?? '';
let appSecret = get('--secret') ?? '';
if (!appId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT app_id, app_secret_enc FROM qq_bot_bindings LIMIT 1').get() as
    | { app_id: string; app_secret_enc: string }
    | undefined;
  if (!row) {
    console.error('库里没有绑定，且没给 --appid/--secret');
    process.exit(2);
  }
  appId = row.app_id;
  appSecret = decryptSecret(row.app_secret_enc);
}

const API_BASE = process.env.QQ_API_BASE || 'https://api.sgroup.qq.com';
const TOKEN_URL = process.env.QQ_TOKEN_URL || 'https://bots.qq.com/app/getAppAccessToken';

console.log(`appId=${appId}  密钥长度=${appSecret.length}`);

const tRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ appId, clientSecret: appSecret }),
});
const tData = (await tRes.json()) as { access_token?: string; expires_in?: unknown; code?: number; message?: string };
console.log('取 access_token:', tRes.status, tData.access_token ? `成功（${JSON.stringify(tData.expires_in)}s）` : JSON.stringify(tData));
if (!tData.access_token) process.exit(1);

const gRes = await fetch(`${API_BASE}/gateway`, { headers: { Authorization: `QQBot ${tData.access_token}` } });
const gData = (await gRes.json()) as { url?: string };
console.log('取网关地址:', gRes.status, gData.url ?? JSON.stringify(gData));
if (!gData.url) process.exit(1);

const ws = new WebSocket(gData.url);
let seq: number | null = null;
let hb: ReturnType<typeof setInterval> | null = null;

ws.addEventListener('open', () => console.log('\n--- socket 已打开，等 hello ---'));

ws.addEventListener('message', (e: MessageEvent) => {
  const raw = String(e.data);
  let pkt: { op?: number; s?: number; t?: string; d?: unknown };
  try {
    pkt = JSON.parse(raw);
  } catch {
    console.log('<<< 非 JSON 帧:', raw.slice(0, 200));
    return;
  }
  if (typeof pkt.s === 'number') seq = pkt.s;

  const label = pkt.op === 0 ? `op0 事件 ${pkt.t}` : `op${pkt.op}`;
  const body = raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
  console.log(`<<< ${label}  ${pkt.op === 11 ? '(心跳回执)' : body}`);

  if (pkt.op === 10) {
    const interval = (pkt.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 30000;
    hb = setInterval(() => {
      console.log('>>> op1 心跳');
      ws.send(JSON.stringify({ op: 1, d: seq }));
    }, interval);

    const identify = {
      op: 2,
      d: {
        token: `QQBot ${tData.access_token}`,
        intents: 1 << 25,
        shard: [0, 1],
        properties: { $os: 'linux', $browser: 'probe', $device: 'probe' },
      },
    };
    console.log('>>> op2 identify:', JSON.stringify(identify).slice(0, 200));
    ws.send(JSON.stringify(identify));
  }
});

ws.addEventListener('error', () => console.log('!!! WebSocket error'));
ws.addEventListener('close', (e: { code?: number; reason?: string }) => {
  console.log(`\n!!! socket 关闭 code=${e.code} reason=${e.reason}`);
  if (hb) clearInterval(hb);
});

setTimeout(() => {
  console.log('\n=== 30 秒到，探针结束 ===');
  if (hb) clearInterval(hb);
  ws.close();
  process.exit(0);
}, 30_000);
