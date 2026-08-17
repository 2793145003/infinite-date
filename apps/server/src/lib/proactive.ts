/**
 * NPC主动消息 — 意愿累积机制
 *
 * 核心原则：消息时机由NPC状态决定，不由定时器决定。
 *
 * 机制：
 * - 每个NPC关系维护 sms_urge 和 moment_urge 两个概率值（0~100）
 * - NPC每次结束行程（切换地点）→ 两个意愿各加一点概率
 * - 加完立刻摇骰子：Math.random() < urge/100 → 发，发完清零
 * - 没中就继续攒，下次行程变更再加再摇
 * - 玩家发短信给NPC → sms_urge 清零
 * - 玩家回复NPC朋友圈 → moment_urge 清零
 * - 约会结束 → 照发短信+朋友圈（不受意愿阻断），发完两个都清零
 *
 * 情绪降温（不发"放手"式终结语）：
 * - 短信意愿增量随「连续未被回应的主动消息数」衰减：增量 × 1/(1+未回应数)
 * - 玩家越不理，短信越难攒够意愿，自然稀疏到几乎停发
 * - 短信阶段只有 0=正常 / 1=疑惑；玩家一旦回复，计数归零、热情重置
 * - 朋友圈（moment_urge）不受衰减影响
 *
 * 这样短信和朋友圈各自独立累积、独立触发，节奏不固定。
 */
import { db } from '../db';
import { genId, now, jsonParse } from './util';
import { buildSystemPrompt, buildMessages, generateReply, getHubLocationsText, getPlayerProfile, formatRelationshipDuration, type PromptContext } from '../prompt/builder';
import { retrieveRelevantMemories, maybeFoldSmsIncremental, getUnifiedTimeline } from './memory';
import { loadCharacterData, getCharacterName } from './character';
import { getCurrentSchedule, getNpcCurrentLocationName, getNpcInviteLocationId, classifyPersonality } from './schedule';
import { generateNpcMoment } from '../routes/moments';
import { sendEmail } from '../routes/email';
import type { CharacterData } from '@idate/shared';
import { DEITY_ID } from '@idate/shared';
import type { ChatMessage } from '../llm/adapter';

// ─── 意愿累积参数 ──────────────────────────────────────────

/** 每次行程变更的基础意愿增量（百分点） */
const URGE_INCREMENT_BASE = 1;

/** 写信（邮件）触发所需的「许久不回」时长：距玩家最后回短信超过此值才写信 */
const LETTER_SILENCE_MS = 24 * 60 * 60 * 1000; // 24 小时

// ─── 意愿读写 ──────────────────────────────────────────────

/**
 * 行程变更时累积意愿并尝试触发短信/朋友圈
 */
export async function checkScheduleChange(playerId: string): Promise<ProactiveSmsResult[]> {
  const ts = Date.now();

  const rels = db.prepare(`
    SELECT r.character_id, r.last_schedule_slot, t.id as thread_id,
           r.sms_urge, r.moment_urge
    FROM relationships r
    JOIN message_threads t ON t.player_id = r.player_id AND t.character_id = r.character_id
    WHERE r.player_id = ? AND r.character_id != ?
      AND NOT EXISTS (
        SELECT 1 FROM conversation_sessions s
        WHERE s.player_id = r.player_id AND s.character_id = r.character_id AND s.ended = 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM scene_sessions ss, json_each(ss.character_ids) j
        WHERE ss.player_id = r.player_id AND j.value = r.character_id AND ss.ended = 0
      )
  `).all(playerId, DEITY_ID) as Array<{
    character_id: string; last_schedule_slot: number; thread_id: string;
    sms_urge: number; moment_urge: number;
  }>;

  const results: ProactiveSmsResult[] = [];

  for (const rel of rels) {
    const charData = loadCharacterData(playerId, rel.character_id);
    if (!charData) continue;

    const currSchedule = getCurrentSchedule(playerId, rel.character_id, charData as any, ts);
    const currLocId = currSchedule?.locationId ?? '';

    const locFingerprint = (id: string): number => {
      if (!id) return 0;
      let h = 0;
      for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
      return Math.abs(h);
    };

    const lastFP = rel.last_schedule_slot;
    const currFP = locFingerprint(currLocId);

    if (lastFP === currFP) continue;
    if (lastFP === 0) {
      db.prepare('UPDATE relationships SET last_schedule_slot = ? WHERE player_id = ? AND character_id = ?')
        .run(currFP, playerId, rel.character_id);
      continue;
    }

    // 地点变了，更新记录
    db.prepare('UPDATE relationships SET last_schedule_slot = ? WHERE player_id = ? AND character_id = ?')
      .run(currFP, playerId, rel.character_id);

    const currLocName = currSchedule?.locationName ?? '';

    // ── 累积意愿（短信随连续未回应衰减，朋友圈不衰减） ──
    const personality = classifyPersonality(charData as unknown as Record<string, any>);
    const personalityMult = personality === 'extrovert' ? 1.2 : personality === 'introvert' ? 0.8 : 1.0;
    const jitter = 0.7 + Math.random() * 0.6;

    // 连续没被回的主动消息越多，短信越难攒意愿——不发"算了"式终结语，只是渐渐不主动
    const unansweredCount = getUnansweredProactiveCount(rel.thread_id);
    const decay = 1 / (1 + unansweredCount);

    const smsIncrement = URGE_INCREMENT_BASE * personalityMult * jitter * decay;
    const momentIncrement = URGE_INCREMENT_BASE * personalityMult * jitter;

    const newSmsUrge = Math.min(100, (rel.sms_urge ?? 0) + smsIncrement);
    const newMomentUrge = Math.min(100, (rel.moment_urge ?? 0) + momentIncrement);

    // ── 短信 / 写信 ──────────────────────────────
    // 写信只在「玩家回过短信、之后许久不回」才触发：连续几条没回是必要条件，
    // 还要距玩家最后回短信超过 LETTER_SILENCE_MS（许久）——刚回没多久就写信太激进。
    const lastPlayerReply = db.prepare(
      "SELECT MAX(created_at) AS ts FROM text_messages WHERE thread_id = ? AND sender = 'player'"
    ).get(rel.thread_id) as { ts: number | null };
    const longSilent = lastPlayerReply.ts != null && (ts - lastPlayerReply.ts >= LETTER_SILENCE_MS);

    if (unansweredCount >= 2 && longSilent) {
      // 连发两条短信都没回、且已许久不回 → 认定"短信联系不上"，改写信寄托思念，短信从此停发
      // （防连发：generateProactiveLetter 内部查已写过信则跳过，玩家回短信才解锁）
      await generateProactiveLetter(playerId, rel.thread_id, rel.character_id);
      db.prepare('UPDATE relationships SET sms_urge = 0 WHERE player_id = ? AND character_id = ?')
        .run(playerId, rel.character_id);
    } else if (Math.random() < newSmsUrge / 100) {
      // 只到"疑惑"为止，不再有"体谅放手"档
      const stage = Math.min(unansweredCount, 1) as 0 | 1;
      const result = await generateProactiveSms(playerId, rel.thread_id, rel.character_id, stage);
      if (result) results.push(result);
      db.prepare('UPDATE relationships SET sms_urge = 0 WHERE player_id = ? AND character_id = ?')
        .run(playerId, rel.character_id);
    } else {
      db.prepare('UPDATE relationships SET sms_urge = ? WHERE player_id = ? AND character_id = ?')
        .run(newSmsUrge, playerId, rel.character_id);
    }

    // ── 摇骰子：朋友圈 ────────────────────────────
    if (Math.random() < newMomentUrge / 100) {
      const hint = currLocName
        ? `你刚到了${currLocName}，想发条朋友圈`
        : `你刚完成一段行程，想发条朋友圈`;
      try {
        await generateNpcMoment(playerId, rel.character_id, 'schedule', hint);
      } catch { /* 发朋友圈失败不影响 */ }
      db.prepare('UPDATE relationships SET moment_urge = 0 WHERE player_id = ? AND character_id = ?')
        .run(playerId, rel.character_id);
    } else {
      db.prepare('UPDATE relationships SET moment_urge = ? WHERE player_id = ? AND character_id = ?')
        .run(newMomentUrge, playerId, rel.character_id);
    }
  }

  return results;
}

// ─── 意愿清零（外部调用） ──────────────────────────────────

/** 玩家发短信给NPC → 清零该NPC的短信意愿 */
export function resetSmsUrge(playerId: string, characterId: string): void {
  db.prepare('UPDATE relationships SET sms_urge = 0 WHERE player_id = ? AND character_id = ?')
    .run(playerId, characterId);
}

/** 玩家回复NPC朋友圈 → 清零该NPC的朋友圈意愿 */
export function resetMomentUrge(playerId: string, characterId: string): void {
  db.prepare('UPDATE relationships SET moment_urge = 0 WHERE player_id = ? AND character_id = ?')
    .run(playerId, characterId);
}

/** 约会结束 → 两个意愿都清零（约会结束已直发短信+朋友圈） */
export function clearUrgeAfterDate(playerId: string, characterId: string): void {
  db.prepare('UPDATE relationships SET sms_urge = 0, moment_urge = 0 WHERE player_id = ? AND character_id = ?')
    .run(playerId, characterId);
}

/** 加好友时初始化意愿 */
export function initUrge(playerId: string, characterId: string): void {
  db.prepare('UPDATE relationships SET sms_urge = 0, moment_urge = 0 WHERE player_id = ? AND character_id = ?')
    .run(playerId, characterId);
}

// ─── 统计工具（供其他模块使用） ────────────────────────────

/**
 * 统计尾部连续未回应的NPC主动消息数
 */
export function getUnansweredProactiveCount(threadId: string): number {
  const msgs = db.prepare(`
    SELECT sender, metadata FROM text_messages
    WHERE thread_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(threadId) as Array<{ sender: string; metadata: string }>;

  let count = 0;
  for (const m of msgs) {
    if (m.sender !== 'npc') break;
    try {
      const meta = JSON.parse(m.metadata || '{}');
      if (meta.proactive) count++;
      else break;
    } catch { break; }
  }
  return count;
}

// ─── 主动短信生成 ──────────────────────────────────────────

export interface ProactiveSmsResult {
  threadId: string;
  characterId: string;
  messages: Array<{ id: string; text: string; internal: string; internal_notable: boolean }>;
  invite?: { locationId: string; locationName: string };
}

/**
 * 生成一条主动短信
 *
 * @param stage 补发阶段：0=正常（首次）, 1=疑惑（此前主动消息未被回应）
 */
async function generateProactiveSms(
  playerId: string,
  threadId: string,
  characterId: string,
  stage: 0 | 1,
  displayTs?: number,
): Promise<ProactiveSmsResult | null> {
  const characterData = loadCharacterData(playerId, characterId);
  if (!characterData) return null;

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;
  const recentMsgs = db.prepare("SELECT sender, body FROM text_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 10").all(threadId) as Array<{ sender: string; body: string }>;

  // 记忆检索
  const retrievedMemories = await retrieveRelevantMemories(
    playerId, characterId,
    recentMsgs.map(m => ({ role: m.sender, text: m.body })),
    '',
  );

  // NPC当前位置
  const smsLocation = getNpcCurrentLocationName(playerId, characterId, characterData, Date.now());

  // 检查是否可以发约会邀请（在主城且不在任务/约会中）
  let invite: { locationId: string; locationName: string } | undefined;
  const inviteLocId = getNpcInviteLocationId(playerId, characterId, characterData as unknown as Record<string, any>, Date.now());
  if (inviteLocId) {
    const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(inviteLocId) as { name: string } | undefined;
    if (loc) {
      invite = { locationId: inviteLocId, locationName: loc.name };
    }
  }

  const ctx: PromptContext = {
    characterData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: recentMsgs.reverse().map(m => ({
      role: (m.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
      text: m.body,
    })),
    isTextMessage: true,
    isDeity: false,
    locationName: smsLocation || '（短信中无法确定位置）',
    hubLocations: getHubLocationsText(),
    retrievedMemories,
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx);

  // 根据阶段构造不同的prompt
  let userPrompt: string;
  if (stage === 0) {
    // 正常主动消息
    if (invite) {
      // 有约会邀请——自然地在短信里提到想见面
      userPrompt = `（你主动给对方发条消息。你现在在${invite.locationName}，想见对方。
不要生硬地说"来找我吧"——用你自己的方式自然地表达想见面的意思。可能是聊着聊着顺口提一句"你要不要过来"，可能是直接说"在XX，你来吗"，也可能是绕个弯子。
消息要符合你的性格和你们的关系——如果你们很熟，可以随意一点；如果不熟，可能含蓄一些。
先发一两句正常的聊天内容，然后自然地带出见面的话。简短、随意。）`;
    } else {
      // 普通主动消息
      userPrompt = `（你想到了什么，主动给对方发条消息。简短、随意，符合你发短信的习惯。
可以是分享日常、随口一句感慨、或者注意到什么想告诉对方。不要长篇大论。）`;
    }
  } else {
    // 疑惑——此前主动发了消息，对方一直没回。不发"放手"式终结语。
    userPrompt = `（你之前主动发了消息，但对方一直没回。你有点在意——可能发个"在忙吗？"或者换个话题。
语气因你的性格而异——有的直接问，有的假装不在意地再找话聊。简短，不要显得焦虑或不满。）`;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const reply_data = await generateReply(messages, { temperature: 0.9, maxTokens: 768, playerId });

  const result: ProactiveSmsResult = {
    threadId,
    characterId,
    messages: [],
    invite,
  };

  for (let i = 0; i < reply_data.messages.length; i++) {
    const msg = reply_data.messages[i]!;
    const msgId = genId();
    const msgTs = displayTs ?? now();
    const internal = i === 0 ? reply_data.internal : '';
    const internalNotable = i === 0 && reply_data.internal_notable ? 1 : 0;
    db.prepare(`
      INSERT INTO text_messages (id, thread_id, sender, body, status, internal, internal_notable, internal_viewed, created_at, delivered_at, metadata)
      VALUES (?, ?, 'npc', ?, 'delivered', ?, ?, 0, ?, ?, '{"proactive":true,"stage":${stage}}')
    `).run(msgId, threadId, msg, internal, internalNotable, msgTs, msgTs);
    result.messages.push({
      id: msgId,
      text: msg,
      internal: reply_data.internal,
      internal_notable: reply_data.internal_notable,
    });
  }

  const threadTs = displayTs ?? now();
  db.prepare('UPDATE message_threads SET last_message_at = ?, unread_count = unread_count + ?, updated_at = ? WHERE id = ?').run(threadTs, result.messages.length, threadTs, threadId);

  // 短信记忆折叠
  maybeFoldSmsIncremental(threadId, playerId, characterId).catch(err => console.error('[proactive] maybeFoldSmsIncremental failed:', err instanceof Error ? err.message : err));

  return result;
}

// ─── 男主来信（邮件）生成 ──────────────────────────────

/**
 * 生成一封男主来信（写入 emails 表）
 *
 * 触发：连续两条主动短信未被回应（unansweredCount >= 2）→ 男主认定"短信联系不上了"，
 *       改写信寄托思念。写信后短信停发，直到玩家回应（未回应计数归零）。
 *
 * 防连发：同一男主已写过一封（不管读没读）就不再写，直到玩家回短信才解锁，返回 false。
 */
async function generateProactiveLetter(
  playerId: string,
  threadId: string,
  characterId: string,
): Promise<boolean> {
  const characterData = loadCharacterData(playerId, characterId);
  if (!characterData) return false;

  // 防连发：「写过就不写了」——已写过一封（不管读没读）就不再写，
  // 直到玩家回短信（线程尾部出现 player 消息）才解锁。
  const existing = db.prepare(`
    SELECT 1 FROM emails e
    WHERE e.player_id = ? AND e.sender_type = 'npc' AND e.character_id = ?
      AND e.created_at > COALESCE((
        SELECT MAX(tm.created_at) FROM text_messages tm
        WHERE tm.thread_id = ? AND tm.sender = 'player'
      ), 0)
    LIMIT 1
  `).get(playerId, characterId, threadId);
  if (existing) return false;

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;
  const recentMsgs = db.prepare("SELECT sender, body FROM text_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 10").all(threadId) as Array<{ sender: string; body: string }>;

  const retrievedMemories = await retrieveRelevantMemories(
    playerId, characterId,
    recentMsgs.map(m => ({ role: m.sender, text: m.body })),
    '',
  );

  const ctx: PromptContext = {
    characterData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: recentMsgs.reverse().map(m => ({
      role: (m.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
      text: m.body,
    })),
    isTextMessage: true,
    isDeity: false,
    locationName: getNpcCurrentLocationName(playerId, characterId, characterData, Date.now()) || '（写信时不确定位置）',
    hubLocations: getHubLocationsText(),
    retrievedMemories,
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx);

  const userPrompt = `（你之前主动给对方发过几条短信，但对方一直没回。你以为短信可能联系不到对方了，于是决定写一封信给对方，寄托你的思念和牵挂。写一封真挚的信，符合你的性格和你们的关系——很熟可以亲昵些，不熟可以含蓄些。信可以有几段，比短信长，但不要过于沉重、卑微或怨怼，也不要在信里质问对方为什么一直不回，只自然地表达你的牵挂和近况。保持你一贯的风度。）`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const reply_data = await generateReply(messages, { temperature: 0.9, maxTokens: 1024, playerId });

  const body = reply_data.messages.filter(Boolean).join('\n\n').trim();
  if (!body) return false;

  const name = characterData.name ?? '一个你认识的人';
  sendEmail(playerId, 'npc', `${name}的信`, body, characterId);

  return true;
}
