/**
 * 玩家在线状态 + NPC主动消息
 *
 * 前端每15s发心跳，报告当前view和闲置时长。
 * 闲置超过阈值时触发 checkScheduleChange（意愿累积机制）。
 *
 * 阈值：约会120s，短信180s
 * 冷却：5min
 */
import { db } from '../db';
import { genId, now, jsonParse } from './util';
import { buildSystemPrompt, buildMessages, generateReply, getHubLocationsText, getPlayerProfile, formatRelationshipDuration, type PromptContext } from '../prompt/builder';
import { retrieveRelevantMemories, maybeFoldSmsIncremental, getUnifiedTimeline } from './memory';
import { retrieveMemories } from './embedding';
import { loadCharacterData } from './character';
import { getCurrentSchedule, getNpcCurrentLocationName } from './schedule';
import { checkScheduleChange } from './proactive';
import type { CharacterData } from '@idate/shared';
import { DEITY_ID } from '@idate/shared';
import type { ChatMessage } from '../llm/adapter';
import { generateNpcMoment } from '../routes/moments';

export interface PresenceEntry {
  view: string;          // 'conversation' | 'sms-thread' | 'none'
  sessionId?: string;
  threadId?: string;
  characterId?: string;
  lastHeartbeat: number;
  idleSince: number;     // 0 = active
  lastProactiveAt: number;
}

const presenceStore = new Map<string, PresenceEntry>();

// 定期清理过期 entry（玩家断线不退出时 lastHeartbeat 不更新，30 分钟后自动清除）
const PRESENCE_TTL = 30 * 60 * 1000; // 30 分钟
setInterval(() => {
  const cutoff = Date.now() - PRESENCE_TTL;
  for (const [pid, entry] of presenceStore) {
    if (entry.lastHeartbeat < cutoff) presenceStore.delete(pid);
  }
}, 5 * 60 * 1000).unref(); // 每 5 分钟扫一次，unref 不阻止进程退出

const IDLE_THRESHOLD: Record<string, number> = {
  'conversation': 120_000,
  'sms-thread': 180_000,
};
const COOLDOWN_MS = 300_000; // 5 min
const TRIGGER_PROBABILITY = 0.5;

export interface ProactiveMessage {
  id: string;
  text: string;
  internal: string;
  internal_notable: boolean;
}

export function updatePresence(
  playerId: string,
  data: { view: string; sessionId?: string; threadId?: string; characterId?: string; idleMs: number },
): void {
  const existing = presenceStore.get(playerId);
  const idleSince = data.idleMs > 0
    ? (existing?.idleSince ?? Date.now() - data.idleMs)
    : Date.now();

  presenceStore.set(playerId, {
    view: data.view,
    sessionId: data.sessionId,
    threadId: data.threadId,
    characterId: data.characterId,
    lastHeartbeat: Date.now(),
    idleSince: data.idleMs > 0 ? idleSince : 0,
    lastProactiveAt: existing?.lastProactiveAt ?? 0,
  });
}

export function clearPresence(playerId: string): void {
  presenceStore.delete(playerId);
}

/**
 * 检查是否应该触发NPC主动消息。
 * 现在统一走意愿累积机制（checkScheduleChange），不再有独立的闲置触发。
 */
export async function checkProactive(playerId: string): Promise<ProactiveMessage[] | null> {
  const entry = presenceStore.get(playerId);
  if (!entry) return null;

  const ts = Date.now();
  const idleMs = entry.idleSince ? ts - entry.idleSince : 0;
  const threshold = IDLE_THRESHOLD[entry.view];
  if (!threshold) return null;

  if (idleMs < threshold) return null;
  if (ts - entry.lastProactiveAt < COOLDOWN_MS) return null;

  // 标记已触发（即使生成失败也计入冷却，避免失败后立刻重试）
  entry.lastProactiveAt = ts;

  // 行程变更意愿累积（可能触发短信，返回给前端）
  try {
    const results = await checkScheduleChange(playerId);
    if (results.length > 0) {
      // 将 ProactiveSmsResult 转为前端需要的 ProactiveMessage 格式
      const messages: ProactiveMessage[] = [];
      for (const r of results) {
        for (const m of r.messages) {
          messages.push({
            id: m.id,
            text: m.text,
            internal: m.internal,
            internal_notable: m.internal_notable,
          });
        }
      }
      return messages.length > 0 ? messages : null;
    }
  } catch {
    // 生成失败不抛错，下次心跳再试
  }

  return null;
}

// ─── 约会主动消息 ──────────────────────────────────────────

export async function generateConversationProactive(
  playerId: string,
  sessionId: string,
  characterId: string,
  force = false,
): Promise<ProactiveMessage[] | null> {
  const session = db.prepare('SELECT * FROM conversation_sessions WHERE id = ? AND player_id = ? AND ended = 0').get(sessionId, playerId) as
    { id: string; character_id: string; location_id: string | null; current_location_id: string | null; mission_id: string | null; is_group: number } | undefined;
  if (!session) return null;

  // 群聊不支持单角色proactive消息（会导致speaker缺失）
  if (session.is_group) return null;

  let proactiveStage = 0; // 0=首次主动, >0=已有未回应的主动消息

  if (!force) {
    // 统计尾部连续未回应的NPC主动消息数
    // 玩家没回 -> NPC可以再追问1次（第2次），之后就不再发了
    const MAX_UNANSWERED = 2;
    const trailingMsgs = db.prepare("SELECT role, metadata FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?").all(sessionId, MAX_UNANSWERED + 1) as Array<{ role: string; metadata: string }>;
    if (trailingMsgs.length === 0) return null;
    
    let unansweredProactive = 0;
    for (const m of trailingMsgs) {
      if (m.role !== 'assistant') break;
      try {
        const meta = JSON.parse(m.metadata || '{}');
        if (meta.proactive) unansweredProactive++;
        else break;
      } catch { break; }
    }
    if (unansweredProactive >= MAX_UNANSWERED) return null;
    proactiveStage = unansweredProactive;
  }

  const isDeity = characterId === DEITY_ID;
  let characterData: CharacterData | null = null;
  if (!isDeity) {
    characterData = loadCharacterData(playerId, characterId);
  }

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;

  // 获取位置名 — 优先用 current_location_id（移动后的实时地点）
  let locationName = '';
  let currentLocationName = '';
  if (session.location_id) {
    const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(session.location_id) as { name: string } | undefined;
    locationName = loc?.name ?? '';
  }
  if (session.current_location_id && session.current_location_id !== session.location_id) {
    const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(session.current_location_id) as { name: string } | undefined;
    currentLocationName = loc?.name ?? '';
  }

  const recentMsgs = db.prepare("SELECT role, text FROM messages WHERE session_id = ? AND role NOT IN ('narration', 'quest_npc') ORDER BY created_at DESC LIMIT 20").all(sessionId) as Array<{ role: string; text: string }>;
  // 注：约会proactive模式过滤narration/quest_npc，与正常发消息路由一致

  // 任务世界设定注入（与 conversation.ts 的 message 路由保持一致）
  let worldContext: string | undefined = undefined;
  if (session.mission_id) {
    const mission = db.prepare(`
      SELECT m.metadata, w.name, w.summary, w.tone, w.rules, w.lore
      FROM missions m JOIN worlds w ON m.world_id = w.id
      WHERE m.id = ?
    `).get(session.mission_id) as { metadata: string; name: string; summary: string; tone: string; rules: string; lore: string } | undefined;
    if (mission) {
      const meta = jsonParse<{ item: string; obsession: string; briefing: string }>(mission.metadata, { item: '', obsession: '', briefing: '' });
      worldContext = `【任务世界】
世界：${mission.name}
环境：${mission.summary}
氛围：${mission.tone}
${mission.rules ? `规则：${mission.rules}\n` : ''}背景：${mission.lore}
任务目标：回收"${meta.item}"
执念背景：${meta.obsession}`;
    }
  }

  // 记忆检索（Phase 5）
  let retrievedMemories: string | null = null;
  if (!isDeity) {
    retrievedMemories = await retrieveRelevantMemories(
      playerId, characterId,
      recentMsgs.map(m => ({ role: m.role, text: m.text })),
      '',
    );
  }

  const ctx: PromptContext = {
    characterData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: recentMsgs.reverse().map(m => ({
      role: (m.role === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
      text: m.text,
    })),
    isTextMessage: false,
    isDeity,
    locationName,
    currentLocationName,
    hubLocations: getHubLocationsText(),
    retrievedMemories,
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
    worldContext,
  };

  const systemPrompt = buildSystemPrompt(ctx);
  const proactivePrompt = (force || proactiveStage === 0)
    ? '（安静了一会儿。你自然地开口说点什么——想到什么就顺口提了，或者注意到对方的某个细节。简短、随意，符合你的性格。不用等对方先说。）'
    : '（你之前主动搭了话，但对方一直没回应。你注意到了这份沉默——可能有点在意，可能觉得对方在发呆。再试一次，语气自然地追问或换个话题。简短，符合你的性格。不要表现出被忽视的不满，更像是随口一提。）';
  const messages: ChatMessage[] = buildMessages(systemPrompt, ctx.recentMessages, proactivePrompt);

  let reply_data = await generateReply(messages, { temperature: 0.9, maxTokens: 768 });

  // nudge时NPC请求搜索记忆：检索后重新生成
  if (reply_data.need_search && reply_data.search_query && !isDeity) {
    const searchResults = await retrieveMemories(playerId, characterId, reply_data.search_query);
    if (searchResults) {
      const enrichedMemories = (ctx.retrievedMemories ?? '') + '\n' + searchResults;
      const enrichedCtx = { ...ctx, retrievedMemories: enrichedMemories };
      const enrichedSystemPrompt = buildSystemPrompt(enrichedCtx);
      const enrichedMessages = buildMessages(enrichedSystemPrompt, enrichedCtx.recentMessages, proactivePrompt);
      const enrichedReply = await generateReply(enrichedMessages, { temperature: 0.9, maxTokens: 768 });
      reply_data = { ...enrichedReply, need_search: false, search_query: '' };
    }
  }

  const result: ProactiveMessage[] = [];
  for (let i = 0; i < reply_data.messages.length; i++) {
    const msg = reply_data.messages[i]!;
    const msgId = genId();
    const internal = i === 0 ? reply_data.internal : '';
    const internalNotable = i === 0 && reply_data.internal_notable ? 1 : 0;
    db.prepare(`
      INSERT INTO messages (id, session_id, role, text, metadata, internal, internal_notable, internal_viewed, created_at)
      VALUES (?, ?, 'assistant', ?, '{"proactive":true}', ?, ?, 0, ?)
    `).run(msgId, sessionId, msg, internal, internalNotable, now());
    result.push({
      id: msgId,
      text: msg,
      internal: reply_data.internal,
      internal_notable: reply_data.internal_notable,
    });
  }

  db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
  return result;
}
// generateSmsProactive 和 maybeNpcRandomMoment 已删除
// 短信和朋友圈统一由 checkScheduleChange 的意愿累积机制驱动
