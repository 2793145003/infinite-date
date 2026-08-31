/**
 * 短信路由
 * 自由输入回复，NPC风格由角色卡textingStyle驱动
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { buildSystemPrompt, buildMessages, generateReply, getHubLocationsText, getPlayerProfile, formatRelationshipDuration, smsMessageText, type PromptContext } from '../prompt/builder';
import { retrieveRelevantMemories, maybeFoldSmsIncremental, getUnifiedTimeline } from '../lib/memory';
import { resetSmsUrge, checkScheduleChange, insertProactiveImagePlaceholder, fillProactiveImage } from '../lib/proactive';
import type { CharacterData } from '@idate/shared';
import { DEITY_ID } from '@idate/shared';
import { isCreationKeyword } from './creation';
import { spendPlayerPermission } from '../lib/permission';
import { getCosts } from '../lib/permission-config';
import { loadCharacterData, getCharacterName, getCharacterAvatar } from '../lib/character';
import { getCurrentSchedule, getNpcCurrentLocationName, getNpcInviteLocationId, getNpcOnlineState } from '../lib/schedule';
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
      let onlineState = 'online';
      let gender: string | null = null;
      let age: string | null = null;
      let appearance: string | null = null;

      if (t.character_id !== DEITY_ID) {
        name = getCharacterName(t.character_id);
        avatar = getCharacterAvatar(playerId, t.character_id) || null;
        const charData = loadCharacterData(playerId, t.character_id);
        if (charData) {
          onlineState = getNpcOnlineState(playerId, t.character_id, charData as unknown as Record<string, any>, now());
          gender = charData.gender ?? null;
          age = charData.age ?? null;
          appearance = charData.appearance ?? null;
        }
      }

      const lastMsg = db.prepare(`
        SELECT body, sender, image_asset_id, metadata FROM text_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(t.id) as { body: string; sender: string; image_asset_id: string | null; metadata: string | null } | undefined;

      // 最后一条是图片消息（body 为空）时，摘要显示 [图片]，而不是空串（前端会回退成"开始聊天吧"）
      let lastMessageText = lastMsg?.body ?? '';
      if (!lastMessageText) {
        let isPendingImage = false;
        if (lastMsg?.metadata) {
          try { isPendingImage = (JSON.parse(lastMsg.metadata) as { pending?: boolean }).pending === true; } catch { /* ignore */ }
        }
        if (lastMsg?.image_asset_id || isPendingImage) lastMessageText = '[图片]';
      }

      return {
        ...t,
        character_name: name,
        avatar,
        gender,
        age,
        appearance,
        last_message: lastMessageText,
        last_sender: lastMsg?.sender ?? '',
        online_state: onlineState,
      };
    });

    return reply.send({ threads: result });
  });

  // 短信未读总数（所有线程 unread_count 之和，供首页/导航角标）
  app.get('/sms/unread-count', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const row = db.prepare(
      'SELECT COALESCE(SUM(unread_count), 0) as count FROM message_threads WHERE player_id = ?'
    ).get(playerId) as { count: number };

    return reply.send({ count: row.count });
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

    let onlineState = 'online';
    if (thread.character_id !== DEITY_ID) {
      const charData = loadCharacterData(playerId, thread.character_id);
      if (charData) {
        onlineState = getNpcOnlineState(playerId, thread.character_id, charData as unknown as Record<string, any>, now());
      }
    }

    const threadInfo = {
      id: thread.id,
      character_id: thread.character_id,
      character_name: thread.character_id === DEITY_ID ? '主神' : getCharacterName(thread.character_id),
      avatar: thread.character_id === DEITY_ID ? null : (getCharacterAvatar(playerId, thread.character_id) || null),
      online_state: onlineState,
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
      SELECT sender, body, image_asset_id, metadata FROM text_messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 10
    `).all(threadId, ts) as Array<{ sender: string; body: string; image_asset_id: string | null; metadata: string | null }>;

    // 记忆检索（Phase 5）
    let retrievedMemories: string | null = null;
    if (!isDeity) {
      retrievedMemories = await retrieveRelevantMemories(
        playerId, thread.character_id,
        recentMsgs.map(m => ({ role: m.sender, text: smsMessageText(m) })),
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
        text: smsMessageText(m),
      })),
      isTextMessage: true,
      isDeity,
      locationName: smsLocation || '（短信中无法确定位置）',
      hubLocations: getHubLocationsText(),
      retrievedMemories,
      relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
    };

    // 在线状态：NPC 正在睡觉 → 注入被吵醒注脚；任务中（mission）→ 不即时回，等 solo 回归统一回应
    if (!isDeity && characterData) {
      const onlineState = getNpcOnlineState(playerId, thread.character_id, characterData as unknown as Record<string, any>, now());
      if (onlineState === 'sleep') {
        ctx.situationalNote = '【此刻状态】你刚刚在睡觉，被这条短信吵醒了。你带着刚醒来的状态回复这条消息——刚醒的感觉自然流露在语气里，具体是什么样子由你的性格决定。';
      } else if (onlineState === 'mission') {
        // 任务中收不到：玩家短信已落库，但不生成回复，等 solo 回归统一回应（顺序：道歉→回应→总结）
        return reply.send({
          playerMessage: { id: playerMsgId, text: textBody, imageAssetId: imagePath ?? null },
          npcMessages: [],
          invite: undefined,
          delayed: true,
        });
      }
    }

    const systemPrompt = buildSystemPrompt(ctx);
    const messages = buildMessages(systemPrompt, ctx.recentMessages, quotePrefix + textBody);

    // 如果有图片，给最后一条user消息附加imagePath
    if (imagePath && messages.length > 0) {
      messages[messages.length - 1]!.imagePath = imagePath;
    }

    try {
      const reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });

      // 存NPC回复
      const npcSave = saveNpcReply('text_messages', 'thread_id', threadId, reply_data.messages, reply_data.internal, reply_data.internal_notable);
      const npcMsgIds = npcSave.msgIds;

      // 玩家提问触发配图：LLM 输出 image_prompt → 先同步插占位气泡拿 id，再异步出图填图（文字消息已先入库，不阻塞）
      const replyImagePrompt = reply_data.image_prompt?.trim();
      const imagePending = !!replyImagePrompt && !isDeity;
      let imagePendingId: string | undefined;
      if (imagePending) {
        imagePendingId = insertProactiveImagePlaceholder(threadId, replyImagePrompt, now(), false);
        void fillProactiveImage(playerId, threadId, imagePendingId, replyImagePrompt, false)
          .catch(err => console.error('[sms] 配图生成失败:', err instanceof Error ? err.message : err));
      }

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
        imagePending: imagePending ? { id: imagePendingId } : null,
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

    // 先删后扣 + 包事务：任一步失败 ROLLBACK，不产生"白扣费"（修复先扣费后校验的 bug）
    db.exec('BEGIN');
    try {
      const undoResult = undoLastPlayerMessage({ table: 'text_messages', idColumn: 'thread_id', idValue: threadId, playerRole: 'player', roleColumn: 'sender' });
      if (!undoResult.ok) {
        db.exec('ROLLBACK');
        return reply.code(undoResult.code).send({ error: undoResult.error });
      }

      // 删除已确认成功，此时才扣费；余额不足则回滚删除
      const undoCost = getCosts().undo_message;
      const spendResult = spendPlayerPermission(playerId, undoCost, 'undo_sms');
      if (!spendResult.ok) {
        db.exec('ROLLBACK');
        return reply.code(403).send({ error: `权限不足（需要${undoCost}）` });
      }

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 事务可能已不在 */ }
      app.log.error({ err }, '短信撤回失败');
      return reply.code(500).send({ error: '撤回失败，请重试' });
    }

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
    const recentMsgs = db.prepare(`SELECT sender, body, image_asset_id, metadata FROM text_messages WHERE thread_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 10`).all(threadId, lookup.lastPlayer.created_at) as Array<{ sender: string; body: string; image_asset_id: string | null; metadata: string | null }>;

    let retrievedMemories: string | null = null;
    if (!isDeity) {
      retrievedMemories = await retrieveRelevantMemories(
        playerId, thread.character_id,
        recentMsgs.map(m => ({ role: m.sender, text: smsMessageText(m) })),
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
        text: smsMessageText(m),
      })),
      isTextMessage: true,
      isDeity,
      locationName: smsLocation || '（短信中无法确定位置）',
      hubLocations: getHubLocationsText(),
      retrievedMemories,
      relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
    };

    // 在线状态：NPC 正在睡觉 → 注入被吵醒注脚；任务中（mission）→ 不即时回，等 solo 回归统一回应
    if (!isDeity && characterData) {
      const onlineState = getNpcOnlineState(playerId, thread.character_id, characterData as unknown as Record<string, any>, now());
      if (onlineState === 'sleep') {
        ctx.situationalNote = '【此刻状态】你刚刚在睡觉，被这条短信吵醒了。你带着刚醒来的状态回复这条消息——刚醒的感觉自然流露在语气里，具体是什么样子由你的性格决定。';
      } else if (onlineState === 'mission') {
        // 任务中收不到：不生成回复，等 solo 回归统一回应（顺序：道歉→回应→总结）
        return reply.send({
          npcMessages: [],
          invite: undefined,
          delayed: true,
        });
      }
    }

    const systemPrompt = buildSystemPrompt(ctx);
    const messages = buildMessages(systemPrompt, ctx.recentMessages, quotePrefix + textBody);

    try {
      const reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });

      const npcSave = saveNpcReply('text_messages', 'thread_id', threadId, reply_data.messages, reply_data.internal, reply_data.internal_notable);
      const npcMsgIds = npcSave.msgIds;

      // 玩家提问触发配图：LLM 输出 image_prompt → 先同步插占位气泡拿 id，再异步出图填图（文字消息已先入库，不阻塞）
      const replyImagePrompt = reply_data.image_prompt?.trim();
      const imagePending = !!replyImagePrompt && !isDeity;
      let imagePendingId: string | undefined;
      if (imagePending) {
        imagePendingId = insertProactiveImagePlaceholder(threadId, replyImagePrompt, now(), false);
        void fillProactiveImage(playerId, threadId, imagePendingId, replyImagePrompt, false)
          .catch(err => console.error('[sms] 配图生成失败:', err instanceof Error ? err.message : err));
      }

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
        imagePending: imagePending ? { id: imagePendingId } : null,
      });
    } catch (err) {
      app.log.error({ err }, 'LLM生成失败');
      return reply.code(502).send({ error: 'NPC回复生成失败，请稍后重试' });
    }
  });

  // ─── 梦短信重试：删末尾连续 dream 气泡 → 用梦的 context 重新生成 ───
  app.post('/sms/threads/:threadId/retry-dream', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { threadId } = req.params as { threadId: string };

    const thread = db.prepare('SELECT id, character_id FROM message_threads WHERE id = ? AND player_id = ?').get(threadId, playerId) as { id: string; character_id: string } | undefined;
    if (!thread) return reply.code(404).send({ error: '线程不存在' });

    // 从末尾往前，收集连续的 dream 气泡（停在与玩家消息或普通 NPC 消息交界处）
    const recent = db.prepare(
      `SELECT id, sender, metadata FROM text_messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 30`
    ).all(threadId) as Array<{ id: string; sender: string; metadata: string | null }>;

    const dreamIds: string[] = [];
    let sceneSessionId: string | null = null;
    for (const m of recent) {
      if (m.sender !== 'npc') break;
      const meta = m.metadata ? jsonParse<Record<string, unknown>>(m.metadata, {}) : {};
      if (!meta.dream) break;
      dreamIds.push(m.id);
      if (!sceneSessionId && typeof meta.scene_session_id === 'string') sceneSessionId = meta.scene_session_id;
    }
    if (dreamIds.length === 0) return reply.code(400).send({ error: '没有可重试的梦短信' });

    // 回退：存量梦短信没有 scene_session_id，按该角色最近一次 dream_scenario 找
    if (!sceneSessionId) {
      sceneSessionId = (db.prepare(
        `SELECT session_id FROM chronicles WHERE character_id = ? AND source = 'dream_scenario' ORDER BY created_at DESC LIMIT 1`
      ).get(thread.character_id) as { session_id: string } | undefined)?.session_id ?? null;
    }
    if (!sceneSessionId) return reply.code(400).send({ error: '找不到对应的梦，无法重试' });

    // 用梦的 context 生成新的梦短信（先生成，失败不丢旧数据）
    const { buildDreamSmsMessages } = await import('../lib/scene-wiring');
    const dreamMessages = await buildDreamSmsMessages(sceneSessionId, playerId, thread.character_id);
    if (!dreamMessages) return reply.code(502).send({ error: '梦短信生成失败' });

    try {
      const reply_data = await generateReply(dreamMessages, { temperature: 0.9, maxTokens: 768, playerId });

      // 删旧 dream 气泡
      for (const id of dreamIds) {
        db.prepare('DELETE FROM text_messages WHERE id = ?').run(id);
      }

      // 插新 dream 气泡
      const msgIds: string[] = [];
      const ts = now();
      for (let i = 0; i < reply_data.messages.length; i++) {
        const msg = reply_data.messages[i]!;
        const msgId = genId();
        const internal = i === 0 ? reply_data.internal : '';
        const internalNotable = i === 0 && reply_data.internal_notable ? 1 : 0;
        db.prepare(
          `INSERT INTO text_messages (id, thread_id, sender, body, status, internal, internal_notable, internal_viewed, created_at, delivered_at, metadata) VALUES (?, ?, 'npc', ?, 'delivered', ?, ?, 0, ?, ?, ?)`
        ).run(msgId, threadId, msg, internal, internalNotable, ts, ts, `{"proactive":true,"dream":true,"scene_session_id":"${sceneSessionId}"}`);
        msgIds.push(msgId);
      }
      db.prepare('UPDATE message_threads SET last_message_at = ?, unread_count = unread_count + ?, updated_at = ? WHERE id = ?').run(ts, reply_data.messages.length, ts, threadId);

      return reply.send({
        npcMessages: reply_data.messages.map((msg, i) => ({
          id: msgIds[i]!,
          text: msg,
          internal: i === 0 ? reply_data.internal : '',
          internal_notable: i === 0 && reply_data.internal_notable,
          internal_viewed: false,
        })),
      });
    } catch (err) {
      app.log.error({ err }, '梦短信重试失败');
      return reply.code(502).send({ error: '梦短信生成失败，请稍后重试' });
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
    const reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });

    const npcSave = saveNpcReply('text_messages', 'thread_id', threadId, reply_data.messages, reply_data.internal, reply_data.internal_notable);

    // 设为未读
    db.prepare('UPDATE message_threads SET unread_count = ?, last_message_at = ?, updated_at = ? WHERE id = ?').run(reply_data.messages.length, now(), now(), threadId);

    updatePlayerDescription(playerId, characterId, reply_data.player_description, rel?.player_description, 'sms', '');

    return { npcMessages: npcSave.formattedMessages };
  } catch {
    return null;
  }
}
