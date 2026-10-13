/**
 * 心绪（emotion）—— 角色的八维心理状态，短信路径启用，供「点头像看心绪」弹窗使用。
 *
 * 设计要点（全部经离线实验验证，脚本见 apps/server/verify_emotion_*.ts）：
 *  1. schema 与 prompt 语义说明必须成对：只加 schema 不给说明，模型会写完原有字段后
 *     完全不输出 emotions，改用空白刷满 max_tokens。缺一不可。
 *  2. emotions 在 REPLY_SCHEMA 里是**可选**字段：REPLY_SCHEMA 被约会聊天/剧本/梦境共用，
 *     那些路径没有说明，实测「可选 + 无说明」行为与基线完全一致（零回归）。
 *  3. 注入必须拼进「当前这条 user 消息」（与 quotePrefix 同款做法）：实测组间差 +0.201，
 *     而追加在 system prompt 末尾只有 +0.024（强人设会把末尾注入完全盖过）。
 *  4. 心绪要有惯性且**必须衰减**：无衰减会让情绪单调爬到高位卡住（折线图贴顶），
 *     每轮衰减 25% 后既平滑又不饱和。
 */
import { db } from '../db';
import { now } from './util';
import type { EmotionScores } from '@idate/shared';

/** 花瓣图顺序（最上方顺时针）：愉悦 → 欲望 → 慌乱 → 失落 → 委屈 → 愤怒 → 占有欲 → 怜爱 */
export const EMOTIONS = [
  { key: 'joy', cn: '愉悦' },
  { key: 'desire', cn: '欲望' },
  { key: 'panic', cn: '慌乱' },
  { key: 'loss', cn: '失落' },
  { key: 'grievance', cn: '委屈' },
  { key: 'anger', cn: '愤怒' },
  { key: 'possessiveness', cn: '占有欲' },
  { key: 'tenderness', cn: '怜爱' },
] as const;

export type EmotionKey = (typeof EMOTIONS)[number]['key'];
export const EMOTION_KEYS: string[] = EMOTIONS.map((e) => e.key);

const CN_OF: Record<string, string> = Object.fromEntries(EMOTIONS.map((e) => [e.key, e.cn]));
export const emotionCn = (key: string): string => CN_OF[key] ?? key;

/** 每轮自然衰减系数：没有新刺激的心绪不会原样延续 */
export const EMOTION_DECAY = 0.75;

/** guided_json 片段（固定 key 的嵌套 object，比打平成 8 个顶层字段省 token） */
export const EMOTION_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(EMOTIONS.map((e) => [e.key, { type: 'integer' }])),
  required: EMOTION_KEYS,
  additionalProperties: false,
} as const;

/**
 * 输出说明 —— 必须随 schema 一起注入，否则模型不给 emotions（见文件头第 1 条）。
 * 只注入短信路径（isTextMessage），约会聊天等共享 REPLY_SCHEMA 的路径不注入。
 */
export const EMOTION_OUTPUT_RULE = [
  '【输出格式补充】除了上面要求的字段，你还要输出一个 emotions 字段，记录你「此刻的心绪」：',
  EMOTIONS.map((e) => `${e.key}=${e.cn}`).join('，'),
  '8 个维度各给一个 0-100 的整数（0=完全没有，100=极其强烈）。',
  '这是你此刻真实的心理状态，用于内部记录；不要把这些词、分数或「心绪」二字写进台词里。',
].join('\n');

/** 归一化模型输出的 emotions：必须 8 键齐全的数字，夹取到 0-100；任一不合法返回 null */
export function normalizeEmotions(raw: unknown): EmotionScores | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const e of EMOTIONS) {
    const v = src[e.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[e.key] = Math.max(0, Math.min(100, Math.round(v)));
  }
  return out as unknown as EmotionScores;
}

/** 自然回落：没有新事件时上一轮的心绪按系数衰减 */
export function decayEmotions(e: EmotionScores, factor = EMOTION_DECAY): EmotionScores {
  const out: Record<string, number> = {};
  for (const k of EMOTION_KEYS) out[k] = Math.round(Number((e as unknown as Record<string, number>)[k] ?? 0) * factor);
  return out as unknown as EmotionScores;
}

/** 最强的那一维 —— 弹窗顶部的「此刻心绪」就是它 */
export function topEmotion(e: EmotionScores): { key: string; cn: string; value: number } {
  const src = e as unknown as Record<string, number>;
  let best = { key: EMOTION_KEYS[0]!, cn: emotionCn(EMOTION_KEYS[0]!), value: -1 };
  for (const k of EMOTION_KEYS) {
    const v = Number(src[k] ?? 0);
    if (v > best.value) best = { key: k, cn: emotionCn(k), value: v };
  }
  return best;
}

/**
 * 心绪注入文本 —— 拼进「当前这条 user 消息」的最前面（不是 system prompt，位置决定成败）。
 * 只在上一轮有心绪时调用；首轮无历史，不注入，让模型自由给出。
 */
export function emotionInjectionNote(prev: EmotionScores): string {
  const entries = EMOTIONS.map((e) => ({ cn: e.cn, v: Number((prev as unknown as Record<string, number>)[e.key] ?? 0) }));
  const top = [...entries].sort((a, b) => b.v - a.v)[0]!;
  return [
    `（你此刻的心绪，延续自上一刻：${entries.map((e) => `${e.cn}${e.v}`).join('、')}。）`,
    `你正被「${top.cn}」（${top.v}）占据着，这是上一刻延续下来的状态。这句话必须从这种心绪里说出来——语气、用词、长短都跟着它走，不能若无其事。`,
    '如果玩家这句话没有真正安抚你、也没有出现新的事件，这种心绪不会凭空消失：你可以减弱，但要有理由。',
  ].join('\n');
}

// ─── 存储（挂在 NPC 消息的 metadata 上，不新增列） ───────────────

/** 把本轮心绪挂到该轮第一条 NPC 消息的 metadata 上（保留原有键） */
export function attachEmotionToMessage(table: 'text_messages' | 'messages', msgId: string, emotion: EmotionScores): void {
  try {
    const row = db.prepare(`SELECT metadata FROM ${table} WHERE id = ?`).get(msgId) as { metadata: string | null } | undefined;
    if (!row) return;
    let meta: Record<string, unknown> = {};
    try {
      meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    meta.emotions = emotion;
    db.prepare(`UPDATE ${table} SET metadata = ? WHERE id = ?`).run(JSON.stringify(meta), msgId);
  } catch (err) {
    // 心绪只是展示层，写失败绝不影响消息主流程
    console.warn('[emotion] attach failed:', err instanceof Error ? err.message : err);
  }
}

export interface EmotionTurn {
  messageId: string;
  createdAt: number;
  emotions: EmotionScores;
  top: { key: string; cn: string; value: number };
}

/**
 * 读某条短信线程最近 N 轮心绪（新→旧），供弹窗的「此刻心绪 + 最近五轮」使用。
 * 每轮 = 一条带 emotions 的 NPC 消息（一次回复可能有多条气泡，心绪挂在本轮第一条上）。
 */
export function readThreadEmotions(threadId: string, limit = 5): EmotionTurn[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, metadata FROM text_messages
       WHERE thread_id = ? AND sender = 'npc' AND metadata LIKE '%"emotions"%'
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(threadId, limit) as Array<{ id: string; created_at: number; metadata: string }>;
  const out: EmotionTurn[] = [];
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.metadata) as { emotions?: unknown };
      const e = normalizeEmotions(meta.emotions);
      if (!e) continue;
      out.push({ messageId: r.id, createdAt: r.created_at, emotions: e, top: topEmotion(e) });
    } catch {
      /* 跳过坏数据 */
    }
  }
  return out;
}

/**
 * 跨渠道情绪史：把**短信**与**约会**里该角色的心绪记录合并，按时间取最近 limit 条（返回旧→新）。
 * 弹窗的「最近五轮」用它——于是刚约会完的起伏会接上之后的日常短信，是一条真正的情绪史，
 * 而不是两个渠道各画各的。
 */
export function readCharacterEmotionHistory(playerId: string, characterId: string, limit = 5): EmotionTurn[] {
  const rows: Array<{ id: string; created_at: number; metadata: string }> = [];
  try {
    rows.push(
      ...(db
        .prepare(
          `SELECT m.id, m.created_at, m.metadata FROM text_messages m
           JOIN message_threads t ON t.id = m.thread_id
           WHERE t.player_id = ? AND t.character_id = ? AND m.sender = 'npc'
             AND m.metadata LIKE '%"emotions"%'
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        )
        .all(playerId, characterId, limit) as Array<{ id: string; created_at: number; metadata: string }>),
    );
    rows.push(
      ...(db
        .prepare(
          `SELECT m.id, m.created_at, m.metadata FROM scene_messages m
           JOIN scene_sessions s ON s.id = m.scene_session_id
           WHERE s.player_id = ? AND m.character_id = ? AND m.metadata LIKE '%"emotions"%'
           ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        )
        .all(playerId, characterId, limit) as Array<{ id: string; created_at: number; metadata: string }>),
    );
  } catch {
    return []; // 表缺失等异常一律降级为空，不影响弹窗其它部分
  }

  const out: EmotionTurn[] = [];
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.metadata) as { emotions?: unknown };
      const e = normalizeEmotions(meta.emotions);
      if (!e) continue;
      out.push({ messageId: r.id, createdAt: r.created_at, emotions: e, top: topEmotion(e) });
    } catch {
      /* 跳过坏数据 */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).reverse();
}

/** 读上一轮心绪（用于本轮注入）；没有则返回 null */
export function readLastEmotion(threadId: string): EmotionScores | null {
  const turns = readThreadEmotions(threadId, 1);
  return turns.length ? turns[0]!.emotions : null;
}

/** 注入门槛：最强维度低于此值就不注入（避免「你正被愉悦 0 占据着」这类噪声） */
export const EMOTION_INJECT_MIN = 10;

// ─── 角色级心绪状态（短信与约会共享） ───────────────────────────
//
// 为什么不是挂在消息上：短信走 text_messages、约会走 scene_messages，两套消息表互不可见，
// 挂在消息上的心绪跨不了渠道（发完短信去约会会割裂）。这里和 chronicles / memory_embeddings
// 用同一个键（player_id + character_id），沿用项目既有的记忆维度。

export interface EmotionState {
  emotions: EmotionScores;
  updatedAt: number;
  source: string;
  sourceId: string | null;
}

/** 写入/覆盖角色此刻的心绪状态 */
export function saveEmotionState(
  playerId: string,
  characterId: string,
  emotions: EmotionScores,
  source: 'sms' | 'scene',
  sourceId?: string | null,
): void {
  try {
    db.prepare(
      `INSERT INTO character_emotion_state (player_id, character_id, emotions, source, source_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id, character_id) DO UPDATE SET
         emotions = excluded.emotions,
         source = excluded.source,
         source_id = excluded.source_id,
         updated_at = excluded.updated_at`,
    ).run(playerId, characterId, JSON.stringify(emotions), source, sourceId ?? null, now());
  } catch (err) {
    // 心绪只是状态层，写失败绝不影响消息主流程
    console.warn('[emotion] saveEmotionState failed:', err instanceof Error ? err.message : err);
  }
}

/** 读原始状态（不做时间衰减） */
export function readEmotionState(playerId: string, characterId: string): EmotionState | null {
  const row = db
    .prepare('SELECT emotions, source, source_id, updated_at FROM character_emotion_state WHERE player_id = ? AND character_id = ?')
    .get(playerId, characterId) as { emotions: string; source: string; source_id: string | null; updated_at: number } | undefined;
  if (!row) return null;
  const e = normalizeEmotions(safeJson(row.emotions));
  if (!e) return null;
  return { emotions: e, updatedAt: row.updated_at, source: row.source, sourceId: row.source_id };
}

/**
 * 读角色「此刻」的心绪 —— 直接返回存储值，**不做任何时间衰减**。
 *
 * 为什么刻意不衰减：心绪是给玩家看的恋爱向状态，不是生理指标。隔几天没联系就把它归零，
 * 玩家点开只会看到一张空花瓣图 —— 那是体验事故，不是真实。要变，就等下一次互动由模型重新评。
 * 渠道（短信注入、约会开场、弹窗）统一读这个函数。
 */
export function readCurrentEmotion(playerId: string, characterId: string): { emotions: EmotionScores; updatedAt: number; source: string } | null {
  const st = readEmotionState(playerId, characterId);
  if (!st) return null;
  return { emotions: st.emotions, updatedAt: st.updatedAt, source: st.source };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 组装本轮注入前缀：角色**此刻**的心绪（角色级状态 + 时间衰减）→ 注入文本。
 * 调用方把它拼在「当前这条 user 消息」的最前面（不是 system prompt，位置决定成败）。
 * 因为读的是角色级状态，短信和约会注入的是同一份心绪——不会「刚吵完架去赴约却云淡风轻」。
 * 无状态、或强度过低时返回空串，不注入。
 */
export function buildEmotionInjection(playerId: string, characterId: string): string {
  const cur = readCurrentEmotion(playerId, characterId);
  if (!cur) return '';
  if (topEmotion(cur.emotions).value < EMOTION_INJECT_MIN) return '';
  return emotionInjectionNote(cur.emotions);
}
