/**
 * 短信路由
 * 自由输入回复，NPC风格由角色卡textingStyle驱动
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { buildSystemPrompt, buildMessages, generateReply, getHubLocationsText, getPlayerProfile, formatRelationshipDuration, type PromptContext } from '../prompt/builder';
import { retrieveRelevantMemories, maybeFoldSmsIncremental, getUnifiedTimeline } from '../lib/memory';
import { resetSmsUrge, checkScheduleChange } from '../lib/proactive';
import type { CharacterData } from '@idate/shared';
import { DEITY_ID } from '@idate/shared';
import { isCreationKeyword } from './creation';
import { spendPlayerPermission } from '../lib/permission';
import { getCosts } from '../lib/permission-config';
import { loadCharacterData, getCharacterName, getCharacterAvatar } from '../lib/character';
import { getCurrentSchedule, getNpcCurrentLocationName, getNpcInviteLocationId } from '../lib/schedule';
import { undoLastPlayerMessage, findLastPlayerForRetry, saveNpcReply, updatePlayerDescription, maybeRetrieveSearchResults, resolveQuote, formatQuotePrefix } from '../lib/conversation-helpers';

export async function smsRoutes(app: FastifyInstance): Promise<void> {
  // 获取短信联系人列表（线程）
  app.get('/sms/threads', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 顺便检查NPC主动消息eligible（在线轮询机制）
    // 异步触发，不阻塞线程列表返回
    // 行程变更意愿累积（后台5分钟扫一轮，不依赖玩家在线）
    checkScheduleChange(playerId).catch(() => {});

    const threads = db.prepare(`
      SELECT t.id, t.character_id, t.last_message_at, t.unread_count,
             t.created_at, t.updated_at
      FROM message_threads t
      WHERE t.player_id = ?
      ORDER BY t.last_message_at DESC
    `).all(playerId) as Array<{
      id: string; character_id: string; last_message_at: number | null;
      unread_count: number; created_at: number; updated_at: number;
    }>;

    // 获取每个线程的角色名和最后一条消息
    const result = threads.map(t => {
      let name = '主神';
      let avatar = null;

      if (t.character_id !== DEITY_ID) {
        name = getCharacterName(t.character_id);
        avatar = getCharacterAvatar(playerId, t.character_id) || null;
      }

      const lastMsg = db.prepare(`
        SELECT body, sender FROM text_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(t.id) as { body: string; sender: string } | undefined;

      return {
        ...t,
        character_name: name,
        avatar,
        last_message: lastMsg?.body ?? '',
        last_sender: lastMsg?.sender ?? '',
      };
    });

    return reply.send({ threads: result });
  });

  // 获取某个线程的消息
  app.get('/sms/threads/:threadId/messages', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { threadId } = req.params as { threadId: string };
    const thread = db.prepare('SELECT * FROM message_threads WHERE id = ? AND player_id = ?').get(threadId, playerId) as {
      id: string; character_id: string; player_id: string;
    } | undefined;

    if (!thread) {
      return reply.code(404).send({ error: '线程不存在' });
    }

    const messages = db.prepare(`
      SELECT id, sender, body, status, image_asset_id, metadata, internal, internal_notable, internal_viewed, created_at, delivered_at
      FROM text_messages WHERE thread_id = ? ORDER BY created_at ASC
    `).all(threadId) as Array<{
      id: string; sender: string; body: string; status: string; image_asset_id: string | null; metadata: string;
      internal: string; internal_notable: number; internal_viewed: number; created_at: number; delivered_at: number | null;
    }>;

    // 标记已读
    db.prepare('UPDATE message_threads SET unread_count = 0 WHERE id = ?').run(threadId);

    const threadInfo = {
      id: thread.id,
      character_id: thread.character_id,
      character_name: thread.character_id === DEITY_ID ? '主神' : getCharacterName(thread.character_id),
      avatar: thread.character_id === DEITY_ID ? null : (getCharacterAvatar(playerId, thread.character_id) || null),
    };

    return reply.send({ thread: threadInfo, messages });
  });

  // 发送短信
  app.post('/sms/threads/:threadId/send', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { threadId } = req.params as { threadId: string };
    const { text, imagePath, quoteId, quoteText, quoteSenderName } = req.body as { text?: string; imagePath?: string; quoteId?: string; quoteText?: string; quoteSenderName?: string };

    if (!text?.trim() && !imagePath) {
      return reply.code(400).send({ error: '消息不能为空' });
    }

    const thread = db.prepare('SELECT * FROM message_threads WHERE id = ? AND player_id = ?').get(threadId, playerId) as {
      id: string; character_id: string; player_id: string;
    } | undefined;

    if (!thread) {
      return reply.code(404).send({ error: '线程不存在' });
    }

    const ts = now();
    const textBody = text?.trim() || '';

    // 解析引用消息（前端直接传引用内容，不需要查数据库）
    let quoteMetadata = '{}';
    let quotePrefix = '';
    if (quoteId && quoteText) {
      quoteMetadata = JSON.stringify({ quote: { id: quoteId, text: quoteText, senderName: quoteSenderName ?? 'NPC' } });
      quotePrefix = formatQuotePrefix({ id: quoteId, text: quoteText, sender: 'player', senderName: quoteSenderName ?? 'NPC' });
    }

    // 存玩家消息（有图片时存image_asset_id，引用存metadata）
    const playerMsgId = genId();
    db.prepare(`
      INSERT INTO text_messages (id, thread_id, sender, body, status, image_asset_id, metadata, created_at, delivered_at)
      VALUES (?, ?, 'player', ?, 'delivered', ?, ?, ?, ?)
    `).run(playerMsgId, threadId, textBody, imagePath ?? null, quoteMetadata, ts, ts);

    db.prepare('UPDATE message_threads SET last_message_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, threadId);

    // DEITY线程：拦截角色创建意图，引导玩家走正式创建流程
    const isDeity = thread.character_id === DEITY_ID;
    if (isDeity && isCreationKeyword(textBody)) {
      const guideMsg = '角色创建请点击下方的「召唤NPC」按钮，那里有完整的引导流程。';
      const guideMsgId = genId();
      const guideTs = now();
      db.prepare(`
        INSERT INTO text_messages (id, thread_id, sender, body, status, created_at, delivered_at)
        VALUES (?, ?, 'npc', ?, 'delivered', ?, ?)
      `).run(guideMsgId, threadId, guideMsg, guideTs, guideTs);
      db.prepare('UPDATE message_threads SET last_message_at = ?, updated_at = ? WHERE id = ?').run(guideTs, guideTs, threadId);
      return reply.send({
        playerMessage: { id: playerMsgId, text: textBody, imageAssetId: imagePath ?? null },
        npcMessages: [{ id: guideMsgId, text: guideMsg, internal: '', internal_notable: false, internal_viewed: false }],
      });
    }

    // 获取NPC角色数据
    let characterData: CharacterData | null = null;

    if (!isDeity) {
      characterData = loadCharacterData(playerId, thread.character_id);
    }

    // 获取关系和记忆
    const rel = db.prepare(`
      SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?
    `).get(playerId, thread.character_id) as { player_description: string; created_at: number } | undefined;


    // 获取最近消息
    const recentMsgs = db.prepare(`
      SELECT sender, body, image_asset_id FROM text_messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 10
    `).all(threadId, ts) as Array<{ sender: string; body: string; image_asset_id: string | null }>;

    // 记忆检索（Phase 5）
    let retrievedMemories: string | null = null;
    if (!isDeity) {
      retrievedMemories = await retrieveRelevantMemories(
        playerId, thread.character_id,
        recentMsgs.map(m => ({ role: m.sender, text: m.body })),
        textBody,
      );
    }

    // 获取角色当前位置（与地图同一数据源：行程系统）
    let smsLocation = '';
    if (!isDeity) {
      smsLocation = getNpcCurrentLocationName(playerId, thread.character_id, characterData!, now());
    }

    const ctx: PromptContext = {
      characterData,
      playerDescription: rel?.player_description ?? '刚认识的陌生人',
      playerProfile: getPlayerProfile(playerId),
      chronicleSummary: getUnifiedTimeline(playerId, thread.character_id),
      recentMessages: recentMsgs.reverse().map(m => ({
        role: (m.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
        text: m.body,
      })),
      isTextMessage: true,
      isDeity,
      locationName: smsLocation || '（短信中无法确定位置）',
      hubLocations: getHubLocationsText(),
      retrievedMemories,
      relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
    };

    const systemPrompt = buildSystemPrompt(ctx);
    const messages = buildMessages(systemPrompt, ctx.recentMessages, quotePrefix + textBody);

    // 如果有图片，给最后一条user消息附加imagePath
    if (imagePath && messages.length > 0) {
      messages[messages.length - 1]!.imagePath = imagePath;
    }

    try {
      const reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024 });

      // 存NPC回复
      const npcSave = saveNpcReply('text_messages', 'thread_id', threadId, reply_data.messages, reply_data.internal, reply_data.internal_notable);
      const npcMsgIds = npcSave.msgIds;

      // 短信记忆折叠（异步，不阻塞响应）
      if (!isDeity) {
        maybeFoldSmsIncremental(threadId, playerId, thread.character_id).catch(() => {});
        // 玩家发了短信 → 清零该NPC的短信意愿
        resetSmsUrge(playerId, thread.character_id);
      }

      // 更新player_description
      if (!isDeity) {
        updatePlayerDescription(playerId, thread.character_id, reply_data.player_description, rel?.player_description, 'sms', playerMsgId);
      }

      // 检查NPC是否可以发出约会邀请（在家且不在任务/约会中）
      let invite: { locationId: string; locationName: string } | undefined = undefined;
      if (!isDeity && characterData) {
        const inviteLocId = getNpcInviteLocationId(playerId, thread.character_id, characterData as unknown as Record<string, any>, now());
        if (inviteLocId) {
          const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(inviteLocId) as { name: string } | undefined;
          if (loc) {
            invite = { locationId: inviteLocId, locationName: loc.name };
          }
        }
      }

      return reply.send({
        playerMessage: { id: playerMsgId, text: textBody, imageAssetId: imagePath ?? null },
        npcMessages: reply_data.messages.map((msg, i) => ({
          id: npcMsgIds[i],
          text: msg,
          internal: i === 0 ? reply_data.internal : '',
          internal_notable: i === 0 && reply_data.internal_notable,
          internal_viewed: false,
        })),
        invite,
      });
    } catch (err) {
      app.log.error({ err }, 'LLM生成失败');
      return reply.code(502).send({ error: 'NPC回复生成失败，请稍后重试' });
    }
  });

  // 撤回最后一条玩家消息（及其后的NPC回复）
  app.delete('/sms/threads/:threadId/undo', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { threadId } = req.params as { threadId: string };

    const thread = db.prepare('SELECT id FROM message_threads WHERE id = ? AND player_id = ?').get(threadId, playerId);
    if (!thread) return reply.code(404).send({ error: '线程不存在' });

    // 消耗权限
    const undoCost = getCosts().undo_message;
    const spendResult = spendPlayerPermission(playerId, undoCost, 'undo_sms');
    if (!spendResult.ok) {
      return reply.code(403).send({ error: `权限不足（需要${undoCost}）` });
    }

    const undoResult = undoLastPlayerMessage({ table: 'text_messages', idColumn: 'thread_id', idValue: threadId, playerRole: 'player', roleColumn: 'sender' });
    if (!undoResult.ok) return reply.code(undoResult.code).send({ error: undoResult.error });

    return reply.send({ ok: true });
  });

  // 重试 — 保留玩家最后一条消息，删除其后的NPC回复，重新生成
  app.post('/sms/threads/:threadId/retry', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { threadId } = req.params as { threadId: string };

    const thread = db.prepare('SELECT * FROM message_threads WHERE id = ? AND player_id = ?').get(threadId, playerId) as {
      id: string; character_id: string; player_id: string;
    } | undefined;
    if (!thread) return reply.code(404).send({ error: '线程不存在' });

    // 找最后一条 player 消息 + 删除其后 NPC 回复
    const lookup = findLastPlayerForRetry('text_messages', 'thread_id', threadId);
    if (!lookup.lastPlayer) return reply.code(400).send({ error: '没有可重试的消息' });

    const textBody = lookup.text!;
    const playerMsgId = lookup.lastPlayer.id;

    // 从玩家消息的metadata中恢复引用前缀
    let quotePrefix = '';
    const playerRow = db.prepare('SELECT metadata FROM text_messages WHERE id = ?').get(playerMsgId) as { metadata: string } | undefined;
    if (playerRow?.metadata) {
      try {
        const meta = JSON.parse(playerRow.metadata);
        if (meta.quote?.text && meta.quote?.senderName) {
          quotePrefix = formatQuotePrefix({ id: meta.quote.id, text: meta.quote.text, sender: 'player', senderName: meta.quote.senderName });
        }
      } catch {}
    }

    // DEITY线程：拦截角色创建意图，引导玩家走正式创建流程
    const isDeity = thread.character_id === DEITY_ID;
    if (isDeity && isCreationKeyword(textBody)) {
      const guideMsg = '角色创建请点击下方的「召唤NPC」按钮，那里有完整的引导流程。';
      const guideMsgId = genId();
      const guideTs = now();
      db.prepare(`
        INSERT INTO text_messages (id, thread_id, sender, body, status, created_at, delivered_at)
        VALUES (?, ?, 'npc', ?, 'delivered', ?, ?)
      `).run(guideMsgId, threadId, guideMsg, guideTs, guideTs);
      db.prepare('UPDATE message_threads SET last_message_at = ?, updated_at = ? WHERE id = ?').run(guideTs, guideTs, threadId);
      return reply.send({
        npcMessages: [{ id: guideMsgId, text: guideMsg, internal: '', internal_notable: false, internal_viewed: false }],
      });
    }

    // 获取NPC角色数据
    let characterData: CharacterData | null = null;

    if (!isDeity) {
      characterData = loadCharacterData(playerId, thread.character_id);
    }

    const rel = db.prepare(`SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?`).get(playerId, thread.character_id) as { player_description: string; created_at: number } | undefined;
    const recentMsgs = db.prepare(`SELECT sender, body FROM text_messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 10`).all(threadId, lookup.lastPlayer.created_at) as Array<{ sender: string; body: string }>;

    let retrievedMemories: string | null = null;
    if (!isDeity) {
      retrievedMemories = await retrieveRelevantMemories(
        playerId, thread.character_id,
        recentMsgs.map(m => ({ role: m.sender, text: m.body })),
        textBody,
      );
    }

    // 获取角色当前位置（与地图同一数据源：行程系统）
    let smsLocation = '';
    if (!isDeity) {
      smsLocation = getNpcCurrentLocationName(playerId, thread.character_id, characterData!, now());
    }

    const ctx: PromptContext = {
      characterData,
      playerDescription: rel?.player_description ?? '刚认识的陌生人',
      playerProfile: getPlayerProfile(playerId),
      chronicleSummary: getUnifiedTimeline(playerId, thread.character_id),
      recentMessages: recentMsgs.reverse().map(m => ({
        role: (m.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
        text: m.body,
      })),
      isTextMessage: true,
      isDeity,
      locationName: smsLocation || '（短信中无法确定位置）',
      hubLocations: getHubLocationsText(),
      retrievedMemories,
      relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
    };

    const systemPrompt = buildSystemPrompt(ctx);
    const messages = buildMessages(systemPrompt, ctx.recentMessages, quotePrefix + textBody);

    try {
      const reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024 });

      const npcSave = saveNpcReply('text_messages', 'thread_id', threadId, reply_data.messages, reply_data.internal, reply_data.internal_notable);
      const npcMsgIds = npcSave.msgIds;

      // 短信记忆折叠（异步，不阻塞响应）
      if (!isDeity) {
        maybeFoldSmsIncremental(threadId, playerId, thread.character_id).catch(() => {});
        // 玩家发了短信 → 清零该NPC的短信意愿
        resetSmsUrge(playerId, thread.character_id);
      }

      // 检查NPC是否可以发出约会邀请（在家且不在任务/约会中）
      let invite: { locationId: string; locationName: string } | undefined = undefined;
      if (!isDeity && characterData) {
        const inviteLocId = getNpcInviteLocationId(playerId, thread.character_id, characterData as unknown as Record<string, any>, now());
        if (inviteLocId) {
          const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(inviteLocId) as { name: string } | undefined;
          if (loc) {
            invite = { locationId: inviteLocId, locationName: loc.name };
          }
        }
      }

      return reply.send({
        npcMessages: reply_data.messages.map((msg, i) => ({
          id: npcMsgIds[i],
          text: msg,
          internal: i === 0 ? reply_data.internal : '',
          internal_notable: i === 0 && reply_data.internal_notable,
          internal_viewed: false,
        })),
        invite,
      });
    } catch (err) {
      app.log.error({ err }, 'LLM生成失败');
      return reply.code(502).send({ error: 'NPC回复生成失败，请稍后重试' });
    }
  });

  // ─── 重试 greeting（线程只有NPC消息、没有玩家消息时） ───
  app.post('/sms/threads/:threadId/regenerate-greeting', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { threadId } = req.params as { threadId: string };

    const thread = db.prepare('SELECT * FROM message_threads WHERE id = ? AND player_id = ?').get(threadId, playerId) as {
      id: string; character_id: string; player_id: string;
    } | undefined;
    if (!thread) return reply.code(404).send({ error: '线程不存在' });

    // 只有线程里没有玩家消息时才能重试greeting
    const playerMsgCount = db.prepare('SELECT COUNT(*) as cnt FROM text_messages WHERE thread_id = ? AND sender = ?').get(threadId, 'player') as { cnt: number };
    if (playerMsgCount.cnt > 0) {
      return reply.code(400).send({ error: '已有对话消息，请使用重试' });
    }

    // 找最近结束的约会session取上下文
    const lastSession = db.prepare(`
      SELECT id, character_id, location_id, current_location_id FROM conversation_sessions
      WHERE player_id = ? AND character_id = ? AND ended = 1
      ORDER BY updated_at DESC LIMIT 1
    `).get(playerId, thread.character_id) as { id: string; character_id: string; location_id: string | null; current_location_id: string | null } | undefined;

    let dateContext = { locationName: '某处', lastExchange: '' };
    if (lastSession) {
      const charName = getCharacterName(thread.character_id);
      const recentMsgs = db.prepare('SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 5').all(lastSession.id) as Array<{ role: string; text: string }>;
      const lastExchange = recentMsgs.reverse().map(m => `${m.role === 'player' ? '玩家' : charName}：${m.text}`).join('\n');
      const locId = lastSession.current_location_id || lastSession.location_id;
      let locName = '某处';
      if (locId) {
        const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locId) as { name: string } | undefined;
        locName = loc?.name ?? '某处';
      }
      dateContext = { locationName: locName, lastExchange };
    }

    // 删除现有NPC消息（旧greeting）
    db.prepare('DELETE FROM text_messages WHERE thread_id = ? AND sender = ?').run(threadId, 'npc');

    const result = await generateSmsGreeting(playerId, thread.character_id, threadId, dateContext);
    if (!result) {
      return reply.code(502).send({ error: 'greeting生成失败，请稍后重试' });
    }

    return reply.send({ npcMessages: result.npcMessages });
  });

  // 创建主神线程（教程用）
  app.post('/sms/deity/thread', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 检查是否已有主神线程
    const existing = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, DEITY_ID) as { id: string } | undefined;
    if (existing) {
      return reply.send({ threadId: existing.id });
    }

    const threadId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 0, ?, ?)
    `).run(threadId, playerId, DEITY_ID, ts, ts);

    return reply.send({ threadId });
  });
}

// ─── 短信 Greeting — 约会结束加好友后，NPC主动发第一条短信 ──

export async function generateSmsGreeting(
  playerId: string,
  characterId: string,
  threadId: string,
  dateContext: { locationName: string; lastExchange: string },
): Promise<{ npcMessages: { id: string; text: string; internal: string; internal_notable: boolean }[] } | null> {
  const characterData = loadCharacterData(playerId, characterId);
  if (!characterData) return null;

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;

  const smsLocation = getNpcCurrentLocationName(playerId, characterId, characterData, now());

  const ctx: PromptContext = {
    characterData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: [],
    isTextMessage: true,
    isDeity: false,
    locationName: smsLocation || '（短信中无法确定位置）',
    hubLocations: getHubLocationsText(),
    retrievedMemories: null,
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx);
  const greetingHint = `你们刚才在${dateContext.locationName}约会，现在转为短信聊天。这是你们第一次发短信。

约会最后的对话：
${dateContext.lastExchange}

接着约会最后的氛围发第一条短信。不要问"到了吗""到家了吗"之类的话——你们不是在分别报平安，是在延续刚才的对话。如果聊到某个话题没说完就继续，如果气氛暧昧就带着那个余韵，如果刚吵完架就带着情绪。像真人刚约会完随手发条短信一样简短自然。`;

  const messages = buildMessages(systemPrompt, [], greetingHint);

  try {
    const reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024 });

    const npcSave = saveNpcReply('text_messages', 'thread_id', threadId, reply_data.messages, reply_data.internal, reply_data.internal_notable);

    // 设为未读
    db.prepare('UPDATE message_threads SET unread_count = ?, last_message_at = ?, updated_at = ? WHERE id = ?').run(reply_data.messages.length, now(), now(), threadId);

    updatePlayerDescription(playerId, characterId, reply_data.player_description, rel?.player_description, 'sms', '');

    return { npcMessages: npcSave.formattedMessages };
  } catch {
    return null;
  }
}
