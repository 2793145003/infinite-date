/**
 * 发送类「重复提交」抑制（会话消息 / 短信 / 朋友圈发帖 / NPC 主动消息）
 *
 * 背景（2026-09-18 全库排查）：写操作一旦「服务端已落库、响应没回到客户端」，
 * 用户看到没反应就会重发一次；服务端零判重 → 同一条内容落两遍，还会再触发一次 NPC 生成。
 * 实测残留：会话消息 13 处、短信 5 处、场景 7 处、朋友圈 3 处（见 data/rollback-old-duplicates-*.sql）。
 *
 * 这里给出统一的判重 + 「把已生成的结果原样返回」能力，配合各路由做到幂等：
 *   - 同一会话/线程 + 同一作者 + 完全相同文本 + 窗口内 → 视为重复
 *   - 重复时返回已有消息 id 及其后已生成的 NPC 回复，不重复落库、不重复调模型
 *
 * 依赖注入 db / ts / windowMs，便于用真实历史数据离线验证。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 判重时间窗：默认 60s（实测重复集中在 0～5s，60s 留足余量） */
export const SEND_DEDUP_WINDOW_MS = 60_000;

export type MsgTable = 'messages' | 'text_messages' | 'scene_messages';

export interface MsgRef {
  table: MsgTable;
  idColumn: 'session_id' | 'thread_id' | 'scene_session_id';
  idValue: string;
  authorColumn: 'role' | 'sender';
  /** 作者标识：'player' / 'assistant' / 'npc' … */
  authorValue: string;
  textColumn: 'text' | 'body';
}

/** 找窗口内同一会话/线程、同一作者、完全相同的上一条消息 */
export function findRecentDuplicateMessage(
  db: DatabaseSync,
  ref: MsgRef,
  text: string,
  ts: number,
  windowMs: number = SEND_DEDUP_WINDOW_MS,
): { id: string; created_at: number } | undefined {
  if (!text.trim()) return undefined;
  return db.prepare(`
    SELECT id, created_at FROM ${ref.table}
    WHERE ${ref.idColumn} = ? AND ${ref.authorColumn} = ? AND ${ref.textColumn} = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(ref.idValue, ref.authorValue, text, ts - windowMs) as { id: string; created_at: number } | undefined;
}

/**
 * 取某条玩家消息之后、下一条玩家消息之前，已经生成的 NPC 回复。
 * 用途：重复提交时把「第一次已经生成好的回复」原样返回，客户端表现与正常发送一致。
 */
export function loadRepliesAfter(
  db: DatabaseSync,
  ref: MsgRef,
  playerMsg: { id: string; created_at: number },
  limit = 30,
): Array<{ id: string; text: string; internal: string; internal_notable: boolean }> {
  const nextPlayerTs = db.prepare(`
    SELECT MIN(created_at) AS ts FROM ${ref.table}
    WHERE ${ref.idColumn} = ? AND ${ref.authorColumn} = ? AND created_at > ?
  `).get(ref.idValue, ref.authorValue, playerMsg.created_at) as { ts: number | null } | undefined;
  const upper = nextPlayerTs?.ts ?? Number.MAX_SAFE_INTEGER;

  const rows = db.prepare(`
    SELECT id, ${ref.textColumn} AS text, internal, internal_notable
    FROM ${ref.table}
    WHERE ${ref.idColumn} = ? AND ${ref.authorColumn} <> ? AND id <> ?
      AND created_at >= ? AND created_at < ?
    ORDER BY created_at LIMIT ?
  `).all(ref.idValue, ref.authorValue, playerMsg.id, playerMsg.created_at, upper, limit) as
    Array<{ id: string; text: string; internal: string | null; internal_notable: number | null }>;

  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    internal: r.internal ?? '',
    internal_notable: !!r.internal_notable,
  }));
}

/** 朋友圈：同一玩家窗口内发完全相同的内容 → 视为重复发帖 */
export function findRecentDuplicateMoment(
  db: DatabaseSync,
  playerId: string,
  content: string,
  ts: number,
  windowMs: number = SEND_DEDUP_WINDOW_MS,
): { id: string } | undefined {
  if (!content.trim()) return undefined;
  return db.prepare(`
    SELECT id FROM moments
    WHERE player_id = ? AND author_type = 'player' AND content = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(playerId, content, ts - windowMs) as { id: string } | undefined;
}
