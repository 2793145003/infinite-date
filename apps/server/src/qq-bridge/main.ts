/**
 * QQ 桥进程入口
 *
 * 跑法（PoC）：
 *   # 1. 离线演练：拿真实库的副本，用假 QQ 网关把出站跑一遍，验证幂等
 *   cp ./data/infinite-date.sqlite /tmp/idate-copy.sqlite
 *   IDATE_QQ_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
 *     npx tsx src/qq-bridge/main.ts --db /tmp/idate-copy.sqlite --mock --once
 *
 *   # 2. 真接：配好库和密钥，跑常驻进程（绑定接口在主服务里，见 src/routes/qq-bridge.ts）
 *   npx tsx src/qq-bridge/main.ts
 *
 * 注意：桥**不 import 服务端的 src/db**，它自己开库 —— 这样桥挂了也不会影响主服务，
 * 更不会在桥启动时顺带跑服务端的 migration。
 */
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureQqBridgeSchema } from './schema';
import { openReadWrite } from './reader';
import { listActiveBindings, runOutboundOnce, handleInbound, type BridgeDeps, type Binding } from './bridge';
import { MockQqGateway, RealQqGateway, QqWebSocketClient, type QqGateway } from './qq-api';
import { decryptSecret } from './crypto';

interface Args {
  db: string;
  mock: boolean;
  once: boolean;
  intervalMs: number;
  player?: string;
  character?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = process.env.IDATE_DATA_DIR || path.resolve(process.cwd(), 'data');
  return {
    db: get('--db') || path.join(dataDir, 'infinite-date.sqlite'),
    mock: argv.includes('--mock'),
    once: argv.includes('--once'),
    intervalMs: Number(get('--interval') || 20_000),
    player: get('--player'),
    character: get('--character'),
  };
}

const args = parseArgs(process.argv.slice(2));
const log = (m: string): void => console.log(`[qq-bridge] ${m}`);

const db: DatabaseSync = openReadWrite(args.db);
ensureQqBridgeSchema(db);
log(`库: ${args.db}`);
log(`模式: ${args.mock ? 'mock（不发网络请求）' : 'real'}`);

// 写下自己的 pid，给 start-all.sh 判活用。
// 不用 pgrep 判活：pgrep -f 会误匹配到「命令行里含同样字串」的调用方 shell，
// 结果是「明明没在跑，却说已在运行」。pid 文件 + kill -0 没有这个问题。
const PID_FILE = process.env.IDATE_QQBRIDGE_PIDFILE || '/tmp/idate_qqbridge.pid';
try {
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch {
  /* 写不了就算了，只是判活会退化成"没在跑" */
}

// ── 网关工厂 ─────────────────────────────────────────────
const mockGateway = new MockQqGateway();
const realGateways = new Map<string, RealQqGateway>();

function gatewayFor(appId: string): QqGateway {
  if (args.mock) return mockGateway;
  let gw = realGateways.get(appId);
  if (!gw) {
    const row = db.prepare('SELECT app_secret_enc FROM qq_bot_bindings WHERE app_id = ?').get(appId) as
      | { app_secret_enc: string }
      | undefined;
    if (!row) throw new Error(`找不到 appId=${appId} 的绑定`);
    gw = new RealQqGateway({ appId, appSecret: decryptSecret(row.app_secret_enc) });
    realGateways.set(appId, gw);
  }
  return gw;
}

// ── 把玩家消息送进无限（和网页同一条路径）─────────────────
// 注意：主服务的所有业务路由都挂在 /api 前缀下（index.ts 里 app.register(..., { prefix: '/api' })），
// 少写这一段就会 404。
const IDATE_API = process.env.IDATE_API_BASE || 'http://127.0.0.1:3000/api';

/**
 * PoC 取巧：从 sessions 表里拿该玩家最新的有效 token 去调线上接口。
 * 正式版应该加一个 service token（或内部鉴权通道），不要复用玩家会话 —— 见 README「已知欠账」。
 */
function resolvePlayerToken(playerId: string): string | null {
  const row = db
    .prepare('SELECT token FROM sessions WHERE player_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
    .get(playerId, Date.now()) as { token: string } | undefined;
  return row?.token ?? null;
}

async function deliverPlayerMessage(playerId: string, threadId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const token = resolvePlayerToken(playerId);
  if (!token) return { ok: false, error: '没有可用的玩家会话 token（PoC 取巧点，见 README）' };

  try {
    const res = await fetch(`${IDATE_API}/sms/threads/${threadId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const deps: BridgeDeps = { db, gatewayFor, deliverPlayerMessage, log };

// ── mock 模式：临时造一条绑定，把出站跑通 ─────────────────
function ensureMockBinding(): void {
  const playerId = args.player;
  const characterId = args.character;
  if (!playerId || !characterId) {
    log('mock 模式需要 --player <playerId> --character <characterId>');
    process.exit(2);
  }
  const existing = db.prepare('SELECT id FROM qq_bot_bindings WHERE player_id = ? AND character_id = ?').get(playerId, characterId);
  if (!existing) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO qq_bot_bindings (id, player_id, character_id, app_id, app_secret_enc, user_openid, status, proactive_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'mock-not-a-secret', ?, 'active', 1, ?, ?)`,
    ).run(`mock-${playerId}-${characterId}`, playerId, characterId, `mock-app-${characterId}`, `mock-openid-${playerId}`, now, now);
    log(`造了一条 mock 绑定：${playerId} × ${characterId}`);
  }
}

// ── 出站循环 ─────────────────────────────────────────────
// 重入锁：一轮要处理所有绑定、图片还要先上传再发（秒级），很容易超过间隔。
// 没有这把锁的话 setInterval 会让下一轮**追尾并发跑**，同一批消息被发两遍
// —— 表现就是星落报的「网页一条、QQ 两条，而且偶发」。
// （lib/moment-scheduler.ts 里对同一个坑已有 ticking 锁，这里是同一套做法。）
let outboundRunning = false;

async function outboundPass(): Promise<void> {
  if (outboundRunning) {
    log('上一轮出站还在跑，跳过本轮（避免追尾重复推送）');
    return;
  }
  outboundRunning = true;
  try {
    const r = await runOutboundOnce(deps);
    if (r.scanned || r.sent || r.failed || r.limited) {
      log(`出站：扫到 ${r.scanned} / 发出 ${r.sent} / 跳过 ${r.skipped} / 失败 ${r.failed}${r.limited ? ` / 限流中断 ${r.limited}` : ''}`);
    }
  } finally {
    outboundRunning = false;
  }
}

// ── 入站：每个绑定一条 WS ────────────────────────────────
const wsClients = new Map<string, QqWebSocketClient>();

async function startWsClients(): Promise<void> {
  if (args.mock) return;
  for (const b of listActiveBindings(db)) {
    if (wsClients.has(b.appId)) continue;
    const row = db.prepare('SELECT app_secret_enc FROM qq_bot_bindings WHERE app_id = ?').get(b.appId) as
      | { app_secret_enc: string }
      | undefined;
    if (!row) continue;
    const client = new QqWebSocketClient(
      { appId: b.appId, appSecret: decryptSecret(row.app_secret_enc) },
      {
        onEvent: evt => handleInbound(deps, evt),
        onError: (appId, err) => log(`⚠️ ${appId} 网关异常: ${err.message}`),
        onLog: (appId, msg) => log(`[${appId}] ${msg}`),
      },
    );
    try {
      await client.connect();
      wsClients.set(b.appId, client);
      log(`已连网关: ${b.appId}（角色 ${b.characterId}）`);
    } catch (err) {
      log(`❌ ${b.appId} 连不上网关: ${err instanceof Error ? err.message : String(err)}`);
      db.prepare("UPDATE qq_bot_bindings SET status = 'invalid', last_error = ?, updated_at = ? WHERE app_id = ?").run(
        err instanceof Error ? err.message : String(err),
        Date.now(),
        b.appId,
      );
    }
  }
}

// ── 主流程 ───────────────────────────────────────────────
async function main(): Promise<void> {
  if (args.mock) ensureMockBinding();

  if (args.once) {
    await outboundPass();
    log('--once 完成');
    return;
  }

  await startWsClients();
  await outboundPass();

  setInterval(() => void outboundPass().catch(err => log(`出站异常: ${err instanceof Error ? err.message : String(err)}`)), args.intervalMs).unref();
  setInterval(() => void startWsClients(), 60_000).unref(); // 拿到新绑定后自动接网关

  log(`常驻运行中（出站每 ${args.intervalMs / 1000}s 一轮）`);
}

void main().catch(err => {
  console.error('[qq-bridge] 启动失败:', err);
  process.exit(1);
});
