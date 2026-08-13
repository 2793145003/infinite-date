/**
 * 对话共享操作 — undo / retry / NPC回复存储 / player_description更新 / 搜索增强
 *
 * 短信(text_messages)、约会(messages)、剧本(messages)三路径的底层操作统一在此。
 * 上层编排逻辑（prompt构建、场景特有逻辑）仍由各路由自行处理。
 */
import { db } from '../db';
import { genId, now } from './util';
import { retrieveMemories } from './embedding';

// ─── 引用功能：根据quoteId从对应表查被引用的消息 ──────────────

export interface ResolvedQuote {
  id: string;
  text: string;
  /** 发送者标识：messages表用role+speaker，text_messages用sender */
  sender: string;
  /** 发送者显示名（NPC名字或"我"） */
  senderName: string;
}

/**
 * 解析引用消息。
 * @param quoteId 被引用的消息ID
 * @param table 消息表名
 * @param idColumn 会话/线程ID列名
 * @param idValue 会话/线程ID值（用于安全校验：只能引用同一会话内的消息）
 * @param speakerNameMap 群聊场景：character_id → 角色名 的映射（单聊传null）
 */
export function resolveQuote(
  quoteId: string,
  table: 'messages' | 'text_messages',
  idColumn: 'session_id' | 'thread_id',
  idValue: string,
  speakerNameMap: Map<string, string> | null,
  fallbackNpcName?: string,
): ResolvedQuote | null {
  const textCol = table === 'messages' ? 'text' : 'body';
  const roleCol = table === 'messages' ? 'role' : 'sender';
  const speakerCol = table === 'messages' ? 'speaker' : 'NULL';

  const row = db.prepare(
    `SELECT id, ${textCol} as text, ${roleCol} as role, ${speakerCol} as speaker FROM ${table} WHERE id = ? AND ${idColumn} = ?`
  ).get(quoteId, idValue) as { id: string; text: string; role: string; speaker: string | null } | undefined;

  if (!row) return null;

  let senderName: string;
  if (row.role === 'player') {
    senderName = '我';
  } else if (table === 'messages' && row.speaker && speakerNameMap) {
    // 群聊：speaker存的是character_id，翻译成角色名
    senderName = speakerNameMap.get(row.speaker) ?? fallbackNpcName ?? 'NPC';
  } else {
    senderName = fallbackNpcName ?? 'NPC';
  }

  return {
    id: row.id,
    text: row.text,
    sender: row.role,
    senderName,
  };
}

/**
 * 将引用内容格式化为注入prompt的前缀文本。
 * 拼在玩家当前输入前面，让NPC知道玩家在回哪句话。
 */
export function formatQuotePrefix(quote: ResolvedQuote): string {
  // 截断过长的引用文本
  const maxLen = 200;
  const text = quote.text.length > maxLen ? quote.text.slice(0, maxLen) + '…' : quote.text;
  return `[引用${quote.senderName}的消息：${text}]\n`;
}

// ─── undo：删除最后一条player消息及其后的NPC回复 ──────────────

export interface UndoConfig {
  /** 消息表名 */
  table: 'messages' | 'text_messages';
  /** 会话/线程ID列名 */
  idColumn: 'session_id' | 'thread_id';
  /** 会话/线程ID值 */
  idValue: string;
  /** player 角色标识值 */
  playerRole: string; // 'player'
  /** role/sender 列名 */
  roleColumn: 'role' | 'sender';
}

export function undoLastPlayerMessage(cfg: UndoConfig): { ok: true } | { ok: false; code: 400; error: string } {
  const { table, idColumn, idValue, playerRole, roleColumn } = cfg;

  const lastPlayer = db.prepare(
    `SELECT id, created_at FROM ${table} WHERE ${idColumn} = ? AND ${roleColumn} = ? ORDER BY created_at DESC LIMIT 1`
  ).get(idValue, playerRole) as { id: string; created_at: number } | undefined;

  if (!lastPlayer) return { ok: false, code: 400, error: '没有可撤回的消息' };

  db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ? AND created_at >= ?`).run(idValue, lastPlayer.created_at);

  // text_messages 还需更新 last_message_at
  if (table === 'text_messages') {
    const lastRemaining = db.prepare(
      `SELECT created_at FROM ${table} WHERE ${idColumn} = ? ORDER BY created_at DESC LIMIT 1`
    ).get(idValue) as { created_at: number } | undefined;
    db.prepare('UPDATE message_threads SET last_message_at = ?, updated_at = ? WHERE id = ?')
      .run(lastRemaining?.created_at ?? null, now(), idValue);
  }

  return { ok: true };
}

// ─── retry 前半段：找最后player消息 + 删其后NPC回复 ──────────

export interface RetryLookup {
  /** 找到的最后一条 player 消息（null = 没有，可能是 greeting 重试） */
  lastPlayer: { id: string; created_at: number } | null;
  /** 消息文本（text_messages 用 body，messages 用 text） */
  text: string | null;
  /** 图片路径（仅 messages 表有） */
  imagePath: string | null;
}

export function findLastPlayerForRetry(
  table: 'messages' | 'text_messages',
  idColumn: 'session_id' | 'thread_id',
  idValue: string,
): RetryLookup {
  const textCol = table === 'messages' ? 'text' : 'body';
  const roleCol = table === 'messages' ? 'role' : 'sender';
  const imageCol = table === 'messages' ? 'image_path' : 'image_asset_id';

  const row = db.prepare(
    `SELECT id, ${textCol} as text, ${imageCol} as image_path, created_at FROM ${table} WHERE ${idColumn} = ? AND ${roleCol} = 'player' ORDER BY created_at DESC LIMIT 1`
  ).get(idValue) as { id: string; text: string; image_path: string | null; created_at: number } | undefined;

  if (!row) return { lastPlayer: null, text: null, imagePath: null };

  // 删除之后的 NPC 回复（保留 player 消息本身）
  db.prepare(
    `DELETE FROM ${table} WHERE ${idColumn} = ? AND ${roleCol} != 'player' AND created_at > ?`
  ).run(idValue, row.created_at);

  return { lastPlayer: { id: row.id, created_at: row.created_at }, text: row.text, imagePath: row.image_path };
}

// ─── NPC 回复存储：多条消息循环 INSERT，第一条存 internal ────

export interface NpcReplySaveResult {
  msgIds: string[];
  formattedMessages: Array<{ id: string; text: string; internal: string; internal_notable: boolean }>;
}

export function saveNpcReply(
  table: 'messages' | 'text_messages',
  idColumn: 'session_id' | 'thread_id',
  idValue: string,
  messages: string[],
  internal: string,
  internalNotable: boolean,
  /** 额外的角色标识（群聊 speaker，任务 quest_npc 等），null = 默认 assistant */
  role?: string,
): NpcReplySaveResult {
  const roleCol = table === 'messages' ? 'role' : 'sender';
  const textCol = table === 'messages' ? 'text' : 'body';
  const actualRole = role ?? (table === 'messages' ? 'assistant' : 'npc');
  const msgIds: string[] = [];
  const formatted: NpcReplySaveResult['formattedMessages'] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const msgId = genId();
    const msgInternal = i === 0 ? internal : '';
    const msgNotable = i === 0 && internalNotable ? 1 : 0;

    if (table === 'messages') {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, ${textCol}, metadata, internal, internal_notable, internal_viewed, created_at) VALUES (?, ?, ?, ?, '{}', ?, ?, 0, ?)`
      ).run(msgId, idValue, actualRole, msg, msgInternal, msgNotable, now());
    } else {
      db.prepare(
        `INSERT INTO text_messages (id, thread_id, sender, body, status, internal, internal_notable, internal_viewed, created_at, delivered_at) VALUES (?, ?, ?, ?, 'delivered', ?, ?, 0, ?, ?)`
      ).run(msgId, idValue, actualRole, msg, msgInternal, msgNotable, now(), now());
    }

    msgIds.push(msgId);
    formatted.push({
      id: msgId,
      text: msg,
      internal: i === 0 ? internal : '',
      internal_notable: i === 0 && internalNotable,
    });
  }

  // text_messages 更新 last_message_at
  if (table === 'text_messages') {
    db.prepare('UPDATE message_threads SET last_message_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), idValue);
  }

  return { msgIds, formattedMessages: formatted };
}

// ─── player_description 更新 + 变更记录 ──────────────────────

export function updatePlayerDescription(
  playerId: string,
  characterId: string,
  newDescription: string,
  oldDescription: string | undefined,
  sourceType: 'sms' | 'conversation' | 'scenario',
  sourceId: string,
): boolean {
  if (!newDescription) return false;
  const old = oldDescription ?? '刚认识的陌生人';
  if (newDescription === old) return false;

  db.prepare('UPDATE relationships SET player_description = ?, updated_at = ? WHERE player_id = ? AND character_id = ?')
    .run(newDescription, now(), playerId, characterId);

  db.prepare(
    `INSERT INTO description_changes (id, player_id, character_id, source_type, source_id, old_description, new_description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(genId(), playerId, characterId, sourceType, sourceId, old, newDescription, now());

  return true;
}

// ─── 搜索增强：need_search → retrieveMemories → 重新生成 ──

/**
 * 如果 LLM 回复标记 need_search，先检索记忆。
 * 返回检索到的记忆文本（null = 不需要搜索或搜索无结果）。
 * 重新生成逻辑由调用方自行处理（因为各场景的生成方式不同）。
 */
export async function maybeRetrieveSearchResults(
  reply: { need_search?: boolean; search_query?: string },
  playerId: string,
  characterId: string,
): Promise<string | null> {
  if (!reply.need_search || !reply.search_query) return null;

  const results = await retrieveMemories(playerId, characterId, String(reply.search_query).trim());
  return results ?? null;
}
