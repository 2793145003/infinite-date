/**
 * 桥的核心循环：出站（无限 → QQ）和入站（QQ → 无限）
 *
 * 关键设计：**出站不挂钩子，靠只读轮询 text_messages**。
 * 因为星落要求生产改动必须先离线验证 —— 用轮询的话，桥跑挂、跑错、重复跑，
 * 都不会碰到线上任何写入路径；而且同一套逻辑可以拿真实历史数据离线回放（replay.ts）。
 * 等这条跑稳了，再把轮询换成 outbox 钩子是纯优化，不是必需。
 */
import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { buildOutbound, type SmsRowForBridge, type Sendable } from './payload';
import { readSmsRows } from './reader';
import type { InboundEvent, QqGateway, PassiveRef, SendResult } from './qq-api';

/** 被动消息窗口：C2C 单聊是 **60 分钟**（群聊才是 5 分钟，别抄错文档）。
 *  窗口内可以用「回复」的形式发，不必依赖玩家开「主动消息」开关。 */
const PASSIVE_WINDOW_MS = 60 * 60 * 1000;
/** 官方：同一个 msg_id 最多回复 4 次 */
const PASSIVE_MAX_REPLIES = 4;
/** 单关系频控 20/qpm，留点余量 */
const PER_BINDING_PER_MIN = 18;
/** bot 维度 30/qpm（未认证），留点余量 */
const PER_APP_PER_MIN = 25;

export interface Binding {
  id: string;
  playerId: string;
  characterId: string;
  appId: string;
  userOpenid: string | null;
  status: string;
  proactiveEnabled: number;
  lastInboundMsgId: string | null;
  lastInboundAt: number;
  /** 只外发这个时刻之后的短信 —— 绑定时定为「此刻」，避免把历史对话重放一遍 */
  sinceTs: number;
}

export interface BridgeDeps {
  db: DatabaseSync;
  /** 每个 appId 一个网关（真实 or mock） */
  gatewayFor(appId: string): QqGateway;
  /** 把玩家消息送进无限的短信接口（和网页同一条路径） */
  deliverPlayerMessage(playerId: string, threadId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  log(msg: string): void;
}

// ── 频控：滑动窗口 ────────────────────────────────────────
const perBindingHits = new Map<string, number[]>();
const perAppHits = new Map<string, number[]>();

function allow(hits: Map<string, number[]>, key: string, max: number, now: number): boolean {
  const arr = (hits.get(key) ?? []).filter(t => now - t < 60_000);
  if (arr.length >= max) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  return true;
}

// ── 绑定读写 ──────────────────────────────────────────────
export function listActiveBindings(db: DatabaseSync): Binding[] {
  const rows = db
    .prepare(
      `SELECT id, player_id, character_id, app_id, user_openid, status,
              proactive_enabled, last_inbound_msg_id, last_inbound_at,
              COALESCE(since_ts, created_at) AS since_ts
         FROM qq_bot_bindings
        WHERE status = 'active'`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: String(r.id),
    playerId: String(r.player_id),
    characterId: String(r.character_id),
    appId: String(r.app_id),
    userOpenid: r.user_openid ? String(r.user_openid) : null,
    status: String(r.status),
    proactiveEnabled: Number(r.proactive_enabled ?? 0),
    lastInboundMsgId: r.last_inbound_msg_id ? String(r.last_inbound_msg_id) : null,
    lastInboundAt: Number(r.last_inbound_at ?? 0),
    sinceTs: Number(r.since_ts ?? 0),
  }));
}

export function findBindingByAppId(db: DatabaseSync, appId: string): Binding | undefined {
  return listActiveBindings(db).find(b => b.appId === appId);
}

/**
 * 出站一轮：把「已被绑定角色」的新 NPC 消息推给 QQ。
 *
 * 幂等：qq_outbox 的主键就是 text_messages.id（图片是 `${id}:img`），
 * INSERT OR IGNORE 保证一条短信只发一次。所以进程重启、多开、崩溃都不会重复推送
 * （这是之前朋友圈重复事故的同类防御）。
 *
 * 限流时**不抢占**：直接 break 掉这个绑定的本轮，剩下的消息留到下一轮，
 * 避免「抢了名额却没发出去、然后永远卡在 queued」。
 */
export async function runOutboundOnce(deps: BridgeDeps): Promise<{ scanned: number; sent: number; skipped: number; failed: number; limited: number }> {
  const { db, log } = deps;
  const bindings = listActiveBindings(db);
  if (bindings.length === 0) return { scanned: 0, sent: 0, skipped: 0, failed: 0, limited: 0 };

  let scanned = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let limited = 0;

  for (const binding of bindings) {
    const rows = readSmsRows(db, {
      playerId: binding.playerId,
      characterId: binding.characterId,
      // 只发绑定之后的短信。少了这一条，一绑上就会把这个角色的全部历史对话倒进 QQ。
      sinceTs: binding.sinceTs || undefined,
      onlyUnsent: true,
      limit: 50,
    });
    scanned += rows.length;

    for (const row of rows) {
      const { sendable, reason } = buildOutbound(row);
      if (sendable.length === 0) {
        // 记一条 skipped 免得每轮重复扫到同一条（pending 图片除外 —— 它需要下一轮重扫）
        if (reason !== 'pending-image') {
          db.prepare(
            `INSERT OR IGNORE INTO qq_outbox (msg_id, binding_id, kind, content, status, created_at)
             VALUES (?, ?, 'text', '', 'skipped', ?)`,
          ).run(row.msgId, binding.id, Date.now());
        }
        skipped++;
        continue;
      }

      for (const item of sendable) {
        const pickup = claim(db, row, binding, item);
        if (pickup === 'done' || pickup === 'busy') continue;

        // 顺序很讲究：**先抢占、再扣名额**。
        // 反过来的话，并发的那一轮会为同一条消息各扣一次名额（实测 12 条被扣掉 24 个额度）。
        // 被限流则把这条**归还**成待发，下一轮再来 —— 不能用 DELETE，
        // 那会把行删成没有状态的僵尸（早先版本就这么干过）。
        if (!rateOk(binding)) {
          db.prepare("UPDATE qq_outbox SET status = 'queued' WHERE msg_id = ?").run(outboxKey(row, item));
          limited++;
          break;
        }

        const ok = await deliver(deps, binding, row, item);
        if (ok) sent++;
        else failed++;
      }
    }
  }

  return { scanned, sent, skipped, failed, limited };
}

function outboxKey(row: SmsRowForBridge, item: Sendable): string {
  return item.kind === 'image' ? `${row.msgId}:img` : row.msgId;
}

function rateOk(binding: Binding): boolean {
  const now = Date.now();
  return allow(perBindingHits, binding.id, PER_BINDING_PER_MIN, now) && allow(perAppHits, binding.appId, PER_APP_PER_MIN, now);
}

/** 一条待发最多重试几次（超过就放弃，不再刷库）*/
const MAX_ATTEMPTS = 3;

type Pickup = 'new' | 'retry' | 'done' | 'busy';

/** 'sending' 超过这个时长视为卡死（进程被杀），允许别的轮次接管 */
const SENDING_STALE_MS = 5 * 60 * 1000;

/**
 * 抢占一条待发。
 *  · 'new'   —— 第一次抢到，去发
 *  · 'retry' —— 之前发失败过且没超次数，再试一次
 *  · 'done'  —— 已经发过 / 跳过的，或者重试次数用尽了
 */
function claim(db: DatabaseSync, row: SmsRowForBridge, binding: Binding, item: Sendable): Pickup {
  const key = outboxKey(row, item);
  const content = item.kind === 'text' ? item.content : item.assetId;
  const now = Date.now();

  // 抢占即写入 status='sending'。这是**原子**的：
  // 并发的另一轮 INSERT OR IGNORE 会拿到 changes=0，然后看到别人正在发 → 让开。
  // 之前新行写的是 'queued'，于是并发那轮把它当成「上次失败待重试」，同一条消息发了两次
  // （实测复现：12 条消息两轮并发 → 投递 18 次、重复 9 条，正是「网页一条、QQ 两条」）。
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO qq_outbox (msg_id, binding_id, kind, content, status, created_at, last_try_at)
       VALUES (?, ?, ?, ?, 'sending', ?, ?)`,
    )
    .run(key, binding.id, item.kind, content, now, now);
  if (Number(res.changes) > 0) return 'new';

  const prev = db.prepare('SELECT status, attempts, last_try_at FROM qq_outbox WHERE msg_id = ?').get(key) as
    | { status: string; attempts: number; last_try_at: number | null }
    | undefined;
  if (!prev) return 'new'; // 理论到不了，当新条目处理
  if (prev.status === 'sent' || prev.status === 'skipped') return 'done';
  if (prev.attempts >= MAX_ATTEMPTS) return 'done';
  // 别人正在发 → 让开；只有明显卡死（进程被杀）才接管
  if (prev.status === 'sending' && now - Number(prev.last_try_at ?? 0) < SENDING_STALE_MS) return 'busy';

  db.prepare("UPDATE qq_outbox SET status = 'sending', last_try_at = ? WHERE msg_id = ?").run(now, key);
  return 'retry';
}

async function deliver(
  deps: BridgeDeps,
  binding: Binding,
  row: SmsRowForBridge,
  item: Sendable,
): Promise<boolean> {
  const { db, log } = deps;
  const now = Date.now();
  const outboxKey = item.kind === 'image' ? `${row.msgId}:img` : row.msgId;

  if (!binding.userOpenid) {
    markOutbox(db, outboxKey, 'failed', '还没拿到玩家的 openid（玩家先给机器人发一条消息）');
    return false;
  }

  // 被动回复：60 分钟内的玩家消息可以用「回复」形式发（不依赖玩家开主动消息开关）。
  // seq 必须**从库里推**而不是内存自增 —— 服务端按 msg_id+msg_seq 持久去重，
  // 进程重启后内存计数器归零会发出重复的 seq，整条消息被判重丢掉（实测踩到过）。
  const passive: PassiveRef | undefined = (() => {
    if (!binding.lastInboundMsgId) return undefined;
    if (now - binding.lastInboundAt >= PASSIVE_WINDOW_MS) return undefined;
    const used = db
      .prepare('SELECT COALESCE(MAX(passive_msg_seq), 0) AS n FROM qq_outbox WHERE passive_msg_id = ?')
      .get(binding.lastInboundMsgId) as { n: number };
    const seq = used.n + 1;
    if (seq > PASSIVE_MAX_REPLIES) return undefined; // 回满了 → 走主动消息
    return { msgId: binding.lastInboundMsgId, seq };
  })();

  // 先把 seq 占下来（写进 outbox），再发 —— 失败重试时用的还是同一个 seq，语义正确
  if (passive) {
    db.prepare('UPDATE qq_outbox SET passive_msg_id = ?, passive_msg_seq = ? WHERE msg_id = ?').run(
      passive.msgId,
      passive.seq,
      outboxKey,
    );
  }

  const gw = deps.gatewayFor(binding.appId);
  const send = (ref?: PassiveRef): Promise<SendResult> =>
    item.kind === 'text'
      ? gw.sendText(binding.userOpenid as string, item.content, ref)
      : gw.sendImage(binding.userOpenid as string, item.assetId, db, ref);

  let res = await send(passive);

  // 去重自愈：报「消息被去重，请检查请求msgseq」说明这个 seq 之前用过了
  // （服务端按 msg_id+msg_seq **持久**去重，老版本代码没把 seq 记进库时就会出现缺口）。
  // 抬一个序号重试即可，最多抬 3 次。
  if (!res.ok && passive && /去重|msgseq|msg_seq/i.test(res.error ?? '')) {
    for (let bump = 1; bump <= 3 && !res.ok; bump++) {
      const ref: PassiveRef = { msgId: passive.msgId, seq: passive.seq + bump };
      db.prepare('UPDATE qq_outbox SET passive_msg_seq = ? WHERE msg_id = ?').run(ref.seq, outboxKey);
      res = await send(ref);
    }
  }

  if (res.ok) {
    markOutbox(db, outboxKey, 'sent', null, res.qqMsgId);
    return true;
  }

  markOutbox(db, outboxKey, 'failed', res.error ?? '未知错误');
  if (res.needProactive) {
    // 玩家没开「主动消息」开关 —— 这是产品要引导的动作，记在绑定上
    db.prepare('UPDATE qq_bot_bindings SET proactive_enabled = 0, last_error = ?, updated_at = ? WHERE id = ?').run(
      '主动消息被拒：玩家需要在机器人资料卡开启「主动消息」',
      Date.now(),
      binding.id,
    );
    deps.log(`⚠️ ${binding.characterId} 主动消息被拒 —— 需要在 QQ 里打开机器人的「主动消息」开关`);
  }
  return false;
}

function markOutbox(db: DatabaseSync, msgId: string, status: string, err: string | null | undefined, qqMsgId?: string): void {
  db.prepare(
    `UPDATE qq_outbox
        SET status = ?, attempts = attempts + 1, last_error = ?, qq_msg_id = ?, sent_at = ?
      WHERE msg_id = ?`,
  ).run(status, err ?? null, qqMsgId ?? null, status === 'sent' ? Date.now() : null, msgId);
}

// ── 入站 ──────────────────────────────────────────────────
/**
 * QQ → 无限。走**已有的短信接口**，和网页完全同一条路径 ——
 * 所以心绪（角色级 saveEmotionState）、记忆、未读数、行程全部自动共用，不会分叉。
 */
export async function handleInbound(deps: BridgeDeps, evt: InboundEvent): Promise<void> {
  const { db, log } = deps;

  // 去重：官方明说同一个 msg_id 可能重复推送
  if (evt.msgId) {
    const key = `${evt.appId}:${evt.msgId}:${evt.msgSeq ?? 0}`;
    const res = db.prepare('INSERT OR IGNORE INTO qq_inbound_seen (key, created_at) VALUES (?, ?)').run(key, Date.now());
    if (Number(res.changes) === 0) return;
  }

  const binding = findBindingByAppId(db, evt.appId);
  if (!binding) {
    log(`⚠️ 收到未绑定 appId 的消息，忽略: ${evt.appId}`);
    return;
  }

  // 主动消息开关事件
  if (evt.proactiveOpened || evt.proactiveClosed) {
    db.prepare('UPDATE qq_bot_bindings SET proactive_enabled = ?, updated_at = ? WHERE id = ?').run(
      evt.proactiveOpened ? 1 : 0,
      Date.now(),
      binding.id,
    );
    log(`✅ ${binding.characterId} 的「主动消息」开关：${evt.proactiveOpened ? '已开启' : '已关闭'}`);
    return;
  }

  if (!evt.content.trim()) return;

  // 隔离护栏：一个 bot 只服务创建者一个人，所以已经有 openid 之后，
  // 换个人来发消息就直接丢掉 —— 否则不仅会把陌生人的话记进这位玩家的 thread，
  // 还会把 user_openid 覆盖掉，导致往后男主的消息发到别人那儿去。
  // （QQ 官方规则是机器人仅创建者可用，但玩家一旦加了「开发体验用户」这个前提就不成立了。）
  if (binding.userOpenid && evt.userOpenid && binding.userOpenid !== evt.userOpenid) {
    log(`⚠️ 非绑定用户给 ${binding.characterId} 的机器人发消息，已丢弃（openid 不匹配）`);
    return;
  }

  // 回填 openid + 记录被动消息窗口
  db.prepare('UPDATE qq_bot_bindings SET user_openid = ?, last_inbound_msg_id = ?, last_inbound_at = ?, updated_at = ? WHERE id = ?').run(
    evt.userOpenid,
    evt.msgId,
    Date.now(),
    Date.now(),
    binding.id,
  );

  const threadId = ensureThread(db, binding.playerId, binding.characterId);
  const res = await deps.deliverPlayerMessage(binding.playerId, threadId, evt.content);
  if (!res.ok) log(`❌ 转发玩家消息失败: ${res.error}`);
}

/** 玩家还没跟这个角色聊过短信时补一个 thread（与 conversation.ts 建 thread 的语义一致）*/
export function ensureThread(db: DatabaseSync, playerId: string, characterId: string): string {
  const row = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as
    | { id: string }
    | undefined;
  if (row) return row.id;

  const id = crypto.randomUUID();
  const ts = Date.now();
  db.prepare(
    `INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 0, ?, ?)`,
  ).run(id, playerId, characterId, ts, ts);
  return id;
}
