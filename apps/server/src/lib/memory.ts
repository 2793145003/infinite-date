/**
 * 记忆系统 — Chronicle 折叠 + Player Facts 提取
 * 
 * - Chronicle：滚动折叠（每N条消息）+ 约会结束时收尾
 * - Player Facts：每次折叠时从 player 消息中提取事实
 * 
 * 设计见 OPEN_QUESTIONS.md #4
 */
import { db } from '../db';
import { genId, now, jsonParse } from './util';
import { embed, storeEmbedding, retrieveMemories, cosineSim, blobToFloat32 } from './embedding';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import { getCharacterName } from './character';
import type { CharacterData } from '@idate/shared';

// 每 N 条消息触发一次滚动折叠
const FOLD_INTERVAL = 10;

// ─── 并发去重：同一 session 的 foldChronicle 同时只跑一个 ─────────
const inflightFolds = new Map<string, Promise<void>>();

// ─── Chronicle 折叠 ─────────────────────────────────────────────

const CHRONICLE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    key_memories: { type: 'array', items: { type: 'string' } },
    player_facts: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'key_memories', 'player_facts'],
};

/**
 * 获取角色名（委托给 character.ts）
 */
function getCharName(characterId: string): string {
  return getCharacterName(characterId);
}

/**
 * 核心折叠函数 — 总结一批消息，写 chronicle + embedding + player facts
 */
async function foldMessages(
  messages: Array<{ role: string; text: string; internal: string; internal_notable: number }>,
  sessionId: string,
  playerId: string,
  characterId: string,
  characterInstanceId: string | null,
  charName: string,
  msgStart: number,
  msgEnd: number,
  source: 'conversation' | 'sms' = 'conversation',
  skipPlayerFacts: boolean = false,
): Promise<void> {
  if (messages.length < 2) return;

  const dialogText = messages.map(m => {
    const speaker = m.role === 'player' ? '玩家' : charName;
    let line = `${speaker}：${m.text}`;
    if (m.internal) line += ` [内心：${m.internal}]`;
    return line;
  }).join('\n');

  const sourceLabel = source === 'sms' ? '短信' : '约会';

  const systemPrompt = `你是一个记忆整理系统。以下是一段${sourceLabel}对话记录。请生成记忆摘要。

要求：
- summary：2-3句话概括这段对话。只写对话中明确发生的事：见面地点、做了什么、聊了什么话题。用第三人称，客观叙述。
- key_memories：提取对话中明确发生的关键事件。每条一句话。如果没有关键事件，返回空数组。

严格禁止：
- 禁止推测情感、心理状态或关系变化（如"产生了好感""建立了信任""感到轻松"），除非对话中有明确的台词表达
- 禁止添加对话中未出现的细节（如"玩家身上有某种气息""氛围温馨"）
- 禁止美化或扩写——如果对话很简短，摘要也应该很简短
- 对话只有寒暄时，摘要应该只是"两人进行了简短的寒暄"，不要编造深层含义

- player_facts：提取关于玩家的持久事实——玩家透露的个人信息、偏好、喜好、过敏、习惯、性格特征等。每条一句话，用第三人称（"玩家..."）。

  注意：
  - 只提取明确的、未来仍然成立的事实，不要推测
  - 不要提取一次性事件（如"这顿饭点了冰美式""刚到达某地""吃了两个蛋糕"）
  - 不要提取临时情绪反应（如"在某个瞬间感到害羞"），只提取稳定的性格倾向
  - 如果没有可提取的，返回空数组

角色名：${charName}

对话记录：
${dialogText}`;

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请生成记忆摘要。' },
  ];

  const result = await chat(llmMessages, {
    temperature: 0.3,
    maxTokens: 512,
    guidedJson: CHRONICLE_SCHEMA,
  });

  const parsed = tryParseJsonReply(result.content);
  if (!parsed) return;

  const summary = String(parsed.summary ?? '').trim();
  const keyMemories = Array.isArray(parsed.key_memories)
    ? (parsed.key_memories as string[]).map(s => String(s)).filter(Boolean)
    : [];
  const playerFacts = Array.isArray(parsed.player_facts)
    ? (parsed.player_facts as string[]).map(s => String(s)).filter(Boolean)
    : [];

  if (!summary) return;

  // 写 chronicles 表（带消息范围标记）
  const chronicleId = genId();
  db.prepare(`
    INSERT INTO chronicles (id, player_id, character_id, character_instance_id, session_id, summary, key_memories, msg_start, msg_end, created_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chronicleId, playerId, characterId, characterInstanceId, sessionId,
    summary, JSON.stringify(keyMemories), msgStart, msgEnd, now(), source,
  );

  // 向量化 summary
  const summaryVec = await embed(summary);
  if (summaryVec) {
    storeEmbedding(playerId, characterId, 'chronicle', chronicleId, summary, summaryVec);
  }

  // player facts：副本（梦）内容不反映玩家真实偏好，跳过提取
  if (!skipPlayerFacts) {
    // 写 player facts + 向量化（去重：与已有 fact 相似度超过阈值则跳过）
    const FACT_DUP_THRESHOLD = 0.85;

    // 一次性取出该玩家×角色的所有已有 fact embeddings
    const existingFactRows = db.prepare(`
      SELECT source_id, embedding FROM memory_embeddings
      WHERE player_id = ? AND character_id = ? AND source_type = 'fact'
    `).all(playerId, characterId) as Array<{ source_id: string; embedding: Uint8Array }>;
    const existingFactVecs = existingFactRows.map(r => ({
      sourceId: r.source_id,
      vec: blobToFloat32(r.embedding),
    }));

    for (const fact of playerFacts) {
      const factVec = await embed(fact);
      if (factVec) {
        // 检查是否与已有 fact 过于相似
        let isDup = false;
        for (const existing of existingFactVecs) {
          if (cosineSim(factVec, existing.vec) >= FACT_DUP_THRESHOLD) {
            isDup = true;
            break;
          }
        }
        if (isDup) continue;  // 跳过重复 fact

        const factId = genId();
        db.prepare(`
          INSERT INTO player_facts (id, player_id, character_id, character_instance_id, fact, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(factId, playerId, characterId, characterInstanceId, fact, source, now(), now());

        storeEmbedding(playerId, characterId, 'fact', factId, fact, factVec);
        existingFactVecs.push({ sourceId: factId, vec: factVec });  // 加入列表供后续批次去重
      }
    }
  }
}

/**
 * 滚动折叠 — 在约会进行中每 N 条消息触发一次
 * 
 * 查找该 session 中未被 chronicle 覆盖的消息段，如果达到阈值就折叠。
 * 通过 chronicles.msg_end 确定已总结的进度。
 */
export async function maybeFoldIncremental(
  sessionId: string,
  playerId: string,
  characterId: string,
  characterInstanceId: string | null,
): Promise<void> {
  // 当前 session 的消息总数
  const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(sessionId) as { cnt: number };
  if (msgCount.cnt < FOLD_INTERVAL) return;

  // 找到已总结的最大 msg_end（用 rowid 作为消息序号）
  const lastFolded = db.prepare(`
    SELECT msg_end FROM chronicles WHERE session_id = ? ORDER BY msg_end DESC LIMIT 1
  `).get(sessionId) as { msg_end: number | null } | undefined;

  const foldedUpTo = lastFolded?.msg_end ?? 0;

  // 取 rowid > foldedUpTo 的消息数量
  const unfolded = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND rowid > ?
  `).get(sessionId, foldedUpTo) as { cnt: number };

  if (unfolded.cnt < FOLD_INTERVAL) return;

  // 取这批未总结的消息（每次只取 FOLD_INTERVAL 条，避免一次性传入过多文本导致 LLM 超限）
  const messages = db.prepare(`
    SELECT role, text, internal, internal_notable, rowid as rid
    FROM messages WHERE session_id = ? AND rowid > ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(sessionId, foldedUpTo, FOLD_INTERVAL) as Array<{
    role: string; text: string; internal: string; internal_notable: number; rid: number;
  }>;

  if (messages.length < 2) return;

  const charName = getCharName(characterId);
  const msgEnd = messages[messages.length - 1]!.rid;

  try {
    await foldMessages(
      messages.map(m => ({ role: m.role, text: m.text, internal: m.internal, internal_notable: m.internal_notable })),
      sessionId, playerId, characterId, characterInstanceId,
      charName, foldedUpTo, msgEnd,
    );
  } catch {
    // 滚动折叠失败不影响约会
  }
}

// ─── 短信记忆折叠 ─────────────────────────────────────────────

const SMS_FOLD_INTERVAL = 10;

/**
 * 短信滚动折叠 — 每N条短信消息折叠一次
 * 用 thread_id 作为标识，chronicle.session_id 存 threadId
 */
export async function maybeFoldSmsIncremental(
  threadId: string,
  playerId: string,
  characterId: string,
  skipPlayerFacts: boolean = false,
): Promise<void> {
  const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM text_messages WHERE thread_id = ?').get(threadId) as { cnt: number };
  if (msgCount.cnt < SMS_FOLD_INTERVAL) return;

  // 找到已总结的最大 msg_end
  const lastFolded = db.prepare(`
    SELECT msg_end FROM chronicles WHERE session_id = ? AND source = 'sms' ORDER BY msg_end DESC LIMIT 1
  `).get(threadId) as { msg_end: number | null } | undefined;

  const foldedUpTo = lastFolded?.msg_end ?? 0;

  const unfolded = db.prepare(`
    SELECT COUNT(*) as cnt FROM text_messages WHERE thread_id = ? AND rowid > ?
  `).get(threadId, foldedUpTo) as { cnt: number };

  if (unfolded.cnt < SMS_FOLD_INTERVAL) return;

  const messages = db.prepare(`
    SELECT sender, body, internal, internal_notable, rowid as rid
    FROM text_messages WHERE thread_id = ? AND rowid > ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(threadId, foldedUpTo, SMS_FOLD_INTERVAL) as Array<{
    sender: string; body: string; internal: string; internal_notable: number; rid: number;
  }>;

  if (messages.length < 2) return;

  const charName = getCharName(characterId);
  const msgEnd = messages[messages.length - 1]!.rid;

  try {
    await foldMessages(
      messages.map(m => ({
        role: m.sender === 'player' ? 'player' : 'assistant',
        text: m.body,
        internal: m.internal,
        internal_notable: m.internal_notable,
      })),
      threadId, playerId, characterId, null,
      charName, foldedUpTo, msgEnd,
      'sms', skipPlayerFacts,
    );
  } catch {
    // 短信折叠失败不影响对话
  }
}

/**
 * 约会结束时收尾折叠 — 处理剩余未总结的消息 + 生成session整体摘要
 * 并发去重：同一 session 同时只跑一个 foldChronicle，后续调用等前者完成后自动跳过
 */
export async function foldChronicle(
  sessionId: string,
  playerId: string,
  characterId: string,
  characterInstanceId: string | null,
  skipPlayerFacts: boolean = false,
): Promise<void> {
  // 如果该 session 已有折叠在进行中，直接返回（不重复折叠）
  if (inflightFolds.has(sessionId)) return;

  const promise = _foldChronicleImpl(sessionId, playerId, characterId, characterInstanceId, skipPlayerFacts)
    .finally(() => { inflightFolds.delete(sessionId); });
  inflightFolds.set(sessionId, promise);
  return promise;
}

async function _foldChronicleImpl(
  sessionId: string,
  playerId: string,
  characterId: string,
  characterInstanceId: string | null,
  skipPlayerFacts: boolean,
): Promise<void> {
  const charName = getCharName(characterId);

  // 循环折叠所有剩余未总结的消息，每批 FOLD_INTERVAL 条
  for (;;) {
    // 找到已总结的最大 msg_end
    const lastFolded = db.prepare(`
      SELECT msg_end FROM chronicles WHERE session_id = ? AND summary_type = 'segment' ORDER BY msg_end DESC LIMIT 1
    `).get(sessionId) as { msg_end: number | null } | undefined;

    const foldedUpTo = lastFolded?.msg_end ?? 0;

    // 取下一批未总结的消息
    const messages = db.prepare(`
      SELECT role, text, internal, internal_notable, rowid as rid
      FROM messages WHERE session_id = ? AND rowid > ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, foldedUpTo, FOLD_INTERVAL) as Array<{
      role: string; text: string; internal: string; internal_notable: number; rid: number;
    }>;

    if (messages.length < 2) break;  // 剩余太少，结束

    const msgStart = foldedUpTo;
    const msgEnd = messages[messages.length - 1]!.rid;

    try {
      await foldMessages(
        messages.map(m => ({ role: m.role, text: m.text, internal: m.internal, internal_notable: m.internal_notable })),
        sessionId, playerId, characterId, characterInstanceId,
        charName, msgStart, msgEnd,
        'conversation', skipPlayerFacts,
      );
    } catch {
      // 某批折叠失败不影响后续批次
      break;
    }
  }

  // ─── 生成 session 整体摘要 ──────────────────────────────────
  // 收集该 session 的所有碎片 chronicle，合成一条整体摘要
  const segments = db.prepare(`
    SELECT summary, key_memories FROM chronicles
    WHERE session_id = ? AND summary_type = 'segment'
    ORDER BY msg_start ASC
  `).all(sessionId) as Array<{ summary: string; key_memories: string }>;

  if (segments.length < 1) return;  // 至少有1条碎片就生成整体摘要

  // 计算约会序号和日期
  const sessionRow = db.prepare('SELECT created_at FROM conversation_sessions WHERE id = ?').get(sessionId) as { created_at: number } | undefined;
  const sessionDate = sessionRow ? new Date(sessionRow.created_at) : new Date();
  const dateStr = `${sessionDate.getMonth() + 1}月${sessionDate.getDate()}日`;

  // 数这是第几次约会：该session之前有几个已结束的session
  const prevSessions = db.prepare(`
    SELECT COUNT(DISTINCT cs.id) as cnt
    FROM conversation_sessions cs
    WHERE cs.player_id = ? AND cs.character_id = ?
      AND cs.ended = 1 AND cs.id != ?
      AND cs.created_at < ?
  `).get(playerId, characterId, sessionId, sessionRow?.created_at ?? now()) as { cnt: number };
  const dateNum = prevSessions.cnt + 1;
  const ordinal = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'][dateNum - 1] ?? String(dateNum);
  const sessionLabel = `${dateStr}·第${ordinal}次约会`;

  const fragmentText = segments.map((s, i) => {
    const kmem = (() => { try { return JSON.parse(s.key_memories) as string[]; } catch { return []; } })();
    const kmemText = kmem.length > 0 ? `\n关键记忆：${kmem.join('；')}` : '';
    return `片段${i + 1}：${s.summary}${kmemText}`;
  }).join('\n\n');

  const overviewSystem = `你是一个记忆整理系统。以下是${charName}与玩家一次约会的多个记忆片段。请生成这次约会的整体摘要。

这次约会的信息：${sessionLabel}

要求：
- summary：以"【${sessionLabel}】"开头，然后用3-5句话概括整次约会。
- 必须包含：见面地点、两人做了什么事、聊了什么话题、关键情节。
- 写出具体的动作和对话要点，不要只概括为"双方进行了互动""展现了体贴"这种空话。
- 允许写情绪氛围，但必须基于片段中明确出现的内容，不要推测心理状态或关系变化。

- key_memories：提取这次约会中明确发生的关键事件，每条一句话。如果没有关键事件，返回空数组。

记忆片段：
${fragmentText}`;

  try {
    const result = await chat([
      { role: 'system', content: overviewSystem },
      { role: 'user', content: '请生成整体摘要。' },
    ], { temperature: 0.3, maxTokens: 640, guidedJson: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        key_memories: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'key_memories'],
    } });

    const parsed = tryParseJsonReply(result.content);
    if (!parsed) return;

    const overviewSummary = String(parsed.summary ?? '').trim();
    if (!overviewSummary) return;

    const overviewKeyMemories = Array.isArray(parsed.key_memories)
      ? (parsed.key_memories as string[]).map(s => String(s)).filter(Boolean)
      : [];

    const overviewId = genId();
    db.prepare(`
      INSERT INTO chronicles (id, player_id, character_id, character_instance_id, session_id, summary, key_memories, msg_start, msg_end, created_at, summary_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'session')
    `).run(
      overviewId, playerId, characterId, characterInstanceId, sessionId,
      overviewSummary, JSON.stringify(overviewKeyMemories), now(),
    );

    // 向量化整体摘要
    const overviewVec = await embed(overviewSummary);
    if (overviewVec) {
      storeEmbedding(playerId, characterId, 'chronicle', overviewId, overviewSummary, overviewVec);
    }
  } catch {
    // 整体摘要生成失败不影响约会
  }
}

// ─── 记忆检索（供 prompt builder 调用）─────────────────────────

/**
 * 检索相关记忆，返回格式化的文本注入 prompt
 * 
 * 输入：当前对话上下文（最近几条消息）
 * 输出：格式化的记忆片段，或 null（无相关记忆）
 */
export async function retrieveRelevantMemories(
  playerId: string,
  characterId: string,
  recentMessages: { role: string; text: string }[],
  currentInput: string,
): Promise<string | null> {
  // 用最近 2-3 条消息 + 当前输入构造 query
  const recentText = recentMessages.slice(-2).map(m => m.text).join(' ');
  const query = recentText ? `${recentText}\n${currentInput}` : currentInput;

  if (!query.trim()) return null;

  return retrieveMemories(playerId, characterId, query);
}

// ─── 统一时间线 — chronicle + 未折叠短信，按时间合并 ──────────

/**
 * 格式化记忆时间戳为日期标签
 * 今天 → "今天 14:30"，昨天 → "昨天 14:30"，更早 → "8月2日 14:30"
 */
function formatMemoryDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (dateStr === nowStr) return `今天 ${hm}`;
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  if (dateStr === yesterdayStr) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 获取统一记忆时间线：chronicle（已折叠的约会/短信摘要）+ 未折叠的短信消息
 * 全部按 created_at 排序，带来源标签，返回格式化文本
 */
export function getUnifiedTimeline(
  playerId: string,
  characterId: string,
  limit: number = 8,
): string {
  // 1. 取最近N条chronicle（约会和短信的混合）
  // session 摘要附带 key_memories（关键事件），segment 只取 summary
  const chronicles = db.prepare(`
    SELECT summary, source, summary_type, key_memories, created_at FROM chronicles
    WHERE player_id = ? AND character_id = ?
      AND source != 'dream_scenario'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(playerId, characterId, limit) as Array<{ summary: string; source: string; summary_type: string; key_memories: string | null; created_at: number }>;

  // 2. 取未被折叠的短信消息（rowid > 最后折叠的msg_end）
  const threadRow = db.prepare(`
    SELECT t.id as thread_id, 
           (SELECT msg_end FROM chronicles WHERE session_id = t.id AND source = 'sms' ORDER BY msg_end DESC LIMIT 1) as last_folded
    FROM message_threads t
    WHERE t.player_id = ? AND t.character_id = ?
    LIMIT 1
  `).get(playerId, characterId) as { thread_id: string; last_folded: number | null } | undefined;

  const unfoldedSms: Array<{ body: string; sender: string; created_at: number }> = [];
  if (threadRow) {
    const foldedUpTo = threadRow.last_folded ?? 0;
    const smsMsgs = db.prepare(`
      SELECT body, sender, created_at FROM text_messages
      WHERE thread_id = ? AND rowid > ?
      ORDER BY created_at ASC
    `).all(threadRow.thread_id, foldedUpTo) as Array<{ body: string; sender: string; created_at: number }>;

    // 把短信消息按时间窗口聚合成2-3条一组的小摘要（避免逐条注入太多）
    // 简单处理：直接带标签注入
    for (const m of smsMsgs) {
      unfoldedSms.push(m);
    }
  }

  // 3. 合并并排序
  type TimelineEntry = { time: number; text: string };
  const entries: TimelineEntry[] = [];

  for (const c of chronicles) {
    const dateLabel = formatMemoryDate(c.created_at);
    const label = c.source === 'sms' ? `【短信·${dateLabel}】` : `【约会·${dateLabel}】`;
    let text = `${label}${c.summary}`;
    // session 摘要附带关键事件列表
    if (c.summary_type === 'session' && c.key_memories) {
      try {
        const kmem = JSON.parse(c.key_memories) as string[];
        if (kmem.length > 0) {
          text += `\n关键事件：${kmem.join('；')}`;
        }
      } catch { /* ignore */ }
    }
    entries.push({ time: c.created_at, text });
  }

  // 未折叠短信聚合成一条
  if (unfoldedSms.length > 0) {
    const smsText = unfoldedSms.map(m => {
      const speaker = m.sender === 'player' ? '玩家' : '角色';
      const hm = formatMemoryDate(m.created_at);
      return `${hm} ${speaker}：${m.body}`;
    }).join('\n');
    const lastTime = unfoldedSms[unfoldedSms.length - 1]!.created_at;
    entries.push({ time: lastTime, text: `【短信·最近】\n${smsText}` });
  }

  // 3. 新场景约会记忆（memory 统一：角色的记忆不分来源，一律合并进时间线）
  //    turn_memory_fold 里该玩家×角色的 overview（长期总览）与 date_summary（整场收尾）
  const sceneMems = db.prepare(`
    SELECT summary, fold_type, created_at FROM turn_memory_fold
    WHERE player_id = ? AND character_id = ?
      AND fold_type IN ('overview', 'date_summary')
    ORDER BY created_at DESC
  `).all(playerId, characterId) as Array<{ summary: string; fold_type: string; created_at: number }>;

  for (const sm of sceneMems) {
    const dateLabel = formatMemoryDate(sm.created_at);
    const label = sm.fold_type === 'overview' ? `【场景·关系】` : `【场景约会·${dateLabel}】`;
    entries.push({ time: sm.created_at, text: `${label}${sm.summary}` });
  }

  // 4. 最近结束的场景约会原文（对应【短信·最近】的设计）
  //    取该角色最近一场已结束约会的最后几轮对话，让短信 NPC 能接上约会结尾的语境
  const recentSceneSession = db.prepare(`
    SELECT ss.id, ss.updated_at FROM scene_sessions ss
    WHERE ss.player_id = ? AND ss.ended = 1
      AND EXISTS (SELECT 1 FROM scene_messages sm WHERE sm.scene_session_id = ss.id AND sm.character_id = ?)
    ORDER BY ss.updated_at DESC LIMIT 1
  `).get(playerId, characterId) as { id: string; updated_at: number } | undefined;

  if (recentSceneSession) {
    const recentSceneMsgs = db.prepare(`
      SELECT role, character_name, text FROM scene_messages
      WHERE scene_session_id = ? AND role IN ('player', 'npc')
      ORDER BY created_at DESC LIMIT 10
    `).all(recentSceneSession.id) as Array<{ role: string; character_name: string; text: string }>;
    if (recentSceneMsgs.length >= 2) {
      const lines = recentSceneMsgs.reverse().map(m => {
        const speaker = m.role === 'player' ? '玩家' : m.character_name;
        return `${speaker}：${m.text}`;
      }).join('\n');
      entries.push({ time: recentSceneSession.updated_at, text: `【约会·最近】\n${lines}` });
    }
  }


  const recentMoments = db.prepare(`
    SELECT
      m.content AS post_content, m.author_id AS post_author_id, m.location_name, m.created_at,
      '' AS comment_text, '' AS comment_author_id
    FROM moments m
    WHERE m.player_id = ? AND m.author_type = 'character' AND m.author_id = ?
    UNION ALL
    SELECT
      mp.content AS post_content, mp.author_id AS post_author_id, mp.location_name, mi.created_at,
      mi.body AS comment_text, mi.author_id AS comment_author_id
    FROM moment_interactions mi
    JOIN moments mp ON mp.id = mi.moment_id
    WHERE mp.player_id = ? AND mi.author_type = 'character' AND mi.interaction_type = 'comment'
      AND mi.author_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(playerId, characterId, playerId, characterId, Math.ceil(limit / 2)) as Array<{
    post_content: string; post_author_id: string; location_name: string | null;
    created_at: number; comment_text: string; comment_author_id: string;
  }>;

  for (const m of recentMoments) {
    const dateLabel = formatMemoryDate(m.created_at);
    const authorName = getCharName(m.post_author_id);
    if (m.comment_text) {
      // NPC评论
      const commentAuthor = getCharName(m.comment_author_id);
      entries.push({ time: m.created_at, text: `【朋友圈·${dateLabel}】${commentAuthor}评论了${authorName === '玩家' ? '玩家' : authorName}的朋友圈：${m.comment_text}` });
    } else {
      // NPC发帖
      const loc = m.location_name ? `（在${m.location_name}）` : '';
      entries.push({ time: m.created_at, text: `【朋友圈·${dateLabel}】${authorName}发了朋友圈：${m.post_content}${loc}` });
    }
  }

  // 按时间正序排列（最早在前，最近在后）
  entries.sort((a, b) => a.time - b.time);

  // 取最近N条
  const recent = entries.slice(-limit);

  return recent.map(e => e.text).filter(Boolean).join('\n---\n');
}

// ─── 群聊记忆折叠 ─────────────────────────────────────────────

/**
 * 群聊滚动折叠 — 对指定角色提取其参与的对话流
 * 其他角色的话作为"（旁人）"保留在上下文中
 */
export async function maybeFoldGroupIncremental(
  sessionId: string,
  playerId: string,
  characterId: string,
): Promise<void> {
  const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(sessionId) as { cnt: number };
  if (msgCount.cnt < FOLD_INTERVAL) return;

  // 找到已总结的最大 msg_end
  const lastFolded = db.prepare(`
    SELECT msg_end FROM chronicles WHERE session_id = ? ORDER BY msg_end DESC LIMIT 1
  `).get(sessionId) as { msg_end: number | null } | undefined;

  const foldedUpTo = lastFolded?.msg_end ?? 0;

  const unfolded = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND rowid > ?
  `).get(sessionId, foldedUpTo) as { cnt: number };

  if (unfolded.cnt < FOLD_INTERVAL) return;

  // 取这批未总结的消息
  const messages = db.prepare(`
    SELECT role, text, speaker, internal, internal_notable, rowid as rid
    FROM messages WHERE session_id = ? AND rowid > ?
    ORDER BY created_at ASC
    LIMIT ?
  `).all(sessionId, foldedUpTo, FOLD_INTERVAL) as Array<{
    role: string; text: string; speaker: string | null; internal: string; internal_notable: number; rid: number;
  }>;

  if (messages.length < 2) return;

  const charName = getCharName(characterId);
  const msgEnd = messages[messages.length - 1]!.rid;

  // 组装对话流：该角色说的话标为角色名，其他NPC的话标为"（旁人）角色名"
  const otherNames = new Map<string, string>();
  // 获取session中所有参与者名字
  const participants = db.prepare(`
    SELECT sp.character_id FROM session_participants sp WHERE sp.session_id = ?
  `).all(sessionId) as Array<{ character_id: string }>;
  for (const p of participants) {
    if (p.character_id !== characterId) {
      otherNames.set(p.character_id, getCharName(p.character_id));
    }
  }

  const dialogText = messages.map(m => {
    let speaker: string;
    if (m.role === 'player') {
      speaker = '玩家';
    } else if (m.speaker === characterId) {
      speaker = charName;
    } else if (m.speaker && otherNames.has(m.speaker)) {
      speaker = `（旁人）${otherNames.get(m.speaker)}`;
    } else {
      speaker = '（旁人）';
    }
    let line = `${speaker}：${m.text}`;
    // 只保留该角色的内心独白
    if (m.speaker === characterId && m.internal) {
      line += ` [内心：${m.internal}]`;
    }
    return line;
  }).join('\n');

  const sourceLabel = '群聊约会';
  const systemPrompt = `你是一个记忆整理系统。以下是${charName}在一次${sourceLabel}中的对话记录。请从${charName}的视角生成记忆摘要。

要求：
- summary：2-3句话概括这段对话。只写对话中明确发生的事：见面地点、做了什么、聊了什么话题。用第三人称，客观叙述。标记为"（旁人）"的是同场的其他角色
- key_memories：提取${charName}明确经历的关键事件。每条一句话。如果没有关键事件，返回空数组
- player_facts：提取关于玩家的持久事实——玩家透露的个人信息、偏好、喜好等。每条一句话，用第三人称

角色名：${charName}

对话记录：
${dialogText}`;

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请生成记忆摘要。' },
  ];

  try {
    const result = await chat(llmMessages, {
      temperature: 0.3,
      maxTokens: 512,
      guidedJson: CHRONICLE_SCHEMA,
    });

    const parsed = tryParseJsonReply(result.content);
    if (!parsed) return;

    const summary = String(parsed.summary ?? '').trim();
    const keyMemories = Array.isArray(parsed.key_memories)
      ? (parsed.key_memories as string[]).map(s => String(s)).filter(Boolean)
      : [];
    const playerFacts = Array.isArray(parsed.player_facts)
      ? (parsed.player_facts as string[]).map(s => String(s)).filter(Boolean)
      : [];

    if (!summary) return;

    const chronicleId = genId();
    db.prepare(`
      INSERT INTO chronicles (id, player_id, character_id, character_instance_id, session_id, summary, key_memories, msg_start, msg_end, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chronicleId, playerId, characterId, null, sessionId,
      summary, JSON.stringify(keyMemories), foldedUpTo, msgEnd, now(), 'group',
    );

    // 向量化
    const summaryVec = await embed(summary);
    if (summaryVec) {
      storeEmbedding(playerId, characterId, 'chronicle', chronicleId, summary, summaryVec);
    }

    // player facts 去重写入
    const FACT_DUP_THRESHOLD = 0.85;
    const existingFactRows = db.prepare(`
      SELECT source_id, embedding FROM memory_embeddings
      WHERE player_id = ? AND character_id = ? AND source_type = 'fact'
    `).all(playerId, characterId) as Array<{ source_id: string; embedding: Uint8Array }>;
    const existingFactVecs = existingFactRows.map(r => ({
      sourceId: r.source_id,
      vec: blobToFloat32(r.embedding),
    }));

    for (const fact of playerFacts) {
      const factVec = await embed(fact);
      if (factVec) {
        let isDup = false;
        for (const existing of existingFactVecs) {
          if (cosineSim(factVec, existing.vec) >= FACT_DUP_THRESHOLD) {
            isDup = true;
            break;
          }
        }
        if (isDup) continue;

        const factId = genId();
        db.prepare(`
          INSERT INTO player_facts (id, player_id, character_id, character_instance_id, fact, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(factId, playerId, characterId, null, fact, 'group', now(), now());

        storeEmbedding(playerId, characterId, 'fact', factId, fact, factVec);
        existingFactVecs.push({ sourceId: factId, vec: factVec });
      }
    }
  } catch {
    // 滚动折叠失败不影响约会
  }
}

/**
 * 群聊结束时的收尾折叠 — 对指定角色执行完整折叠
 */
export async function foldGroupChronicle(
  sessionId: string,
  playerId: string,
  characterId: string,
): Promise<void> {
  const charName = getCharName(characterId);

  // 循环折叠所有剩余未总结的消息
  for (;;) {
    const lastFolded = db.prepare(`
      SELECT msg_end FROM chronicles WHERE session_id = ? AND source = 'group' ORDER BY msg_end DESC LIMIT 1
    `).get(sessionId) as { msg_end: number | null } | undefined;

    const foldedUpTo = lastFolded?.msg_end ?? 0;

    const messages = db.prepare(`
      SELECT role, text, speaker, internal, internal_notable, rowid as rid
      FROM messages WHERE session_id = ? AND rowid > ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, foldedUpTo, FOLD_INTERVAL) as Array<{
      role: string; text: string; speaker: string | null; internal: string; internal_notable: number; rid: number;
    }>;

    if (messages.length < 2) break;

    const msgStart = foldedUpTo;
    const msgEnd = messages[messages.length - 1]!.rid;

    try {
      // 获取其他参与者
      const otherNames = new Map<string, string>();
      const participants = db.prepare(`
        SELECT sp.character_id FROM session_participants sp WHERE sp.session_id = ?
      `).all(sessionId) as Array<{ character_id: string }>;
      for (const p of participants) {
        if (p.character_id !== characterId) {
          otherNames.set(p.character_id, getCharName(p.character_id));
        }
      }

      const dialogText = messages.map(m => {
        let speaker: string;
        if (m.role === 'player') {
          speaker = '玩家';
        } else if (m.speaker === characterId) {
          speaker = charName;
        } else if (m.speaker && otherNames.has(m.speaker)) {
          speaker = `（旁人）${otherNames.get(m.speaker)}`;
        } else {
          speaker = '（旁人）';
        }
        let line = `${speaker}：${m.text}`;
        if (m.speaker === characterId && m.internal) {
          line += ` [内心：${m.internal}]`;
        }
        return line;
      }).join('\n');

      const systemPrompt = `你是一个记忆整理系统。以下是${charName}在一次群聊约会中的对话记录。请从${charName}的视角生成记忆摘要。

要求：
- summary：2-3句话概括这段对话。只写对话中明确发生的事。用第三人称客观叙述。标记为"（旁人）"的是同场其他角色
- key_memories：提取${charName}明确经历的关键事件。每条一句话。无则返回空数组
- player_facts：提取关于玩家的持久事实。每条一句话。无则返回空数组

角色名：${charName}
对话记录：
${dialogText}`;

      const result = await chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请生成记忆摘要。' },
      ], { temperature: 0.3, maxTokens: 512, guidedJson: CHRONICLE_SCHEMA });

      const parsed = tryParseJsonReply(result.content);
      if (!parsed) break;

      const summary = String(parsed.summary ?? '').trim();
      if (!summary) break;

      const keyMemories = Array.isArray(parsed.key_memories)
        ? (parsed.key_memories as string[]).map(s => String(s)).filter(Boolean)
        : [];

      const chronicleId = genId();
      db.prepare(`
        INSERT INTO chronicles (id, player_id, character_id, character_instance_id, session_id, summary, key_memories, msg_start, msg_end, created_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'group')
      `).run(
        chronicleId, playerId, characterId, null, sessionId,
        summary, JSON.stringify(keyMemories), msgStart, msgEnd, now(),
      );

      const summaryVec = await embed(summary);
      if (summaryVec) {
        storeEmbedding(playerId, characterId, 'chronicle', chronicleId, summary, summaryVec);
      }
    } catch {
      break;
    }
  }
}
