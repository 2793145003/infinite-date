/**
 * 约会路由
 * 约会session管理 + 对话
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now } from '../lib/util';
import { buildSystemPrompt, buildMessages, generateReply, getHubLocationsText, getPlayerProfile, formatRelationshipDuration, type PromptContext, buildGroupSystemPrompt, buildGroupMessages, generateGroupReply, type GroupCharContext } from '../prompt/builder';
import { generateConversationProactive } from '../lib/presence';
import { resetSmsUrge, initUrge, clearUrgeAfterDate } from '../lib/proactive';
import { getCurrentSchedule } from '../lib/schedule';
import { retrieveRelevantMemories, foldChronicle, maybeFoldIncremental, maybeFoldSmsIncremental, getUnifiedTimeline, foldGroupChronicle, maybeFoldGroupIncremental } from '../lib/memory';
import { spendPlayerPermission } from '../lib/permission';
import { getCosts } from '../lib/permission-config';
import { loadCharacterData, getCharacterName } from '../lib/character';
import type { CharacterData } from '@idate/shared';
import { DEITY_ID } from '@idate/shared';
import type { ChatMessage } from '../llm/adapter';
import { generateNpcMoment } from './moments';
import { getActiveLiveSlot } from '../lib/session-mutex';
import { undoLastPlayerMessage, findLastPlayerForRetry, saveNpcReply, updatePlayerDescription, maybeRetrieveSearchResults, resolveQuote, formatQuotePrefix } from '../lib/conversation-helpers';
import { generateSmsGreeting } from './sms';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // 创建约会session
  app.post('/sessions', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { characterId, locationId, mode, trigger } = req.body as {
      characterId?: string; locationId?: string; mode?: string; trigger?: 'talk' | 'invite' | 'deity_pick';
    };

    if (!characterId) {
      return reply.code(400).send({ error: '需要characterId' });
    }

    // 全局现场互斥：人只有一个，同一时间只能"在场"于一个玩法现场。
    // 已有任何进行中的现场（约会/群聊/剧本/旧探索/任务）→ 返回 live 信号，前端弹窗「继续原现场」或「结束它进入新的」。
    const live = getActiveLiveSlot(playerId);
    if (live) {
      return reply.code(409).send({ error: '已有进行中的现场', live });
    }

    const sessionId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO conversation_sessions (id, player_id, character_id, location_id, mode, summary, ended, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', 0, ?, ?)
    `).run(sessionId, playerId, characterId, locationId ?? null, mode ?? 'chat', ts, ts);

    // 创建/更新relationship（第一次互动时自动创建）
    const ts2 = now();
    const existingRel = db.prepare('SELECT id FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId);
    const isFirstMeeting = !existingRel;
    if (isFirstMeeting) {
      db.prepare(`
        INSERT INTO relationships (id, player_id, character_id, player_description, updated_at, created_at)
        VALUES (?, ?, ?, '刚认识的陌生人', ?, ?)
      `).run(genId(), playerId, characterId, ts2, ts2);
    } else {
      db.prepare('UPDATE relationships SET updated_at = ? WHERE player_id = ? AND character_id = ?').run(ts2, playerId, characterId);
    }

    // NPC主动开口 — 按设计文档：偶遇时NPC会主动打招呼
    // greeting失败则回滚session和relationship，不留空壳阻塞后续尝试
    let greeting;
    try {
      greeting = await generateGreeting(sessionId, playerId, characterId, locationId ?? null, trigger, undefined, isFirstMeeting);
    } catch (err) {
      app.log.error({ err }, 'Greeting生成失败，回滚session');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM conversation_sessions WHERE id = ?').run(sessionId);
        if (isFirstMeeting) {
          db.prepare('DELETE FROM relationships WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
        }
        db.exec('COMMIT');
      } catch (rollbackErr) {
        db.exec('ROLLBACK');
        app.log.error({ rollbackErr }, '回滚失败');
      }
      return reply.code(502).send({ error: 'NPC开场白生成失败，请重试' });
    }

    if (greeting) {
      for (let i = 0; i < greeting.messages.length; i++) {
        const msg = greeting.messages[i]!;
        // 第一条消息存 internal_notable，其余清空
        const internal = i === 0 ? greeting.internal : '';
        const internalNotable = i === 0 && greeting.internal_notable ? 1 : 0;
        db.prepare(`
          INSERT INTO messages (id, session_id, role, text, metadata, internal, internal_notable, internal_viewed, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', ?, ?, 0, ?)
        `).run(genId(), sessionId, msg, internal, internalNotable, now());
      }
      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
    } else {
      // greeting返回null（不该发生但防御）— 同样回滚session和relationship
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM conversation_sessions WHERE id = ?').run(sessionId);
        if (isFirstMeeting) {
          db.prepare('DELETE FROM relationships WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
        }
        db.exec('COMMIT');
      } catch (rollbackErr) {
        db.exec('ROLLBACK');
        app.log.error({ rollbackErr }, '回滚失败');
      }
      return reply.code(502).send({ error: 'NPC开场白生成失败，请重试' });
    }

    return reply.send({
      sessionId,
      greeting: greeting ? {
        messages: greeting.messages,
        internal: greeting.internal,
        internal_notable: greeting.internal_notable,
      } : null,
    });
  });

  // 获取session消息
  app.get('/sessions/:sessionId/messages', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare('SELECT * FROM conversation_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as {
      id: string; character_id: string; location_id: string | null; mode: string; ended: number; mission_id: string | null; is_group: number;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: 'Session不存在' });
    }

    // 群聊：返回speaker + participants
    if (session.is_group) {
      const messages = db.prepare(`
        SELECT id, role, text, speaker, metadata, internal, internal_notable, internal_viewed, created_at
        FROM messages WHERE session_id = ? ORDER BY created_at ASC
      `).all(sessionId) as Array<{
        id: string; role: string; text: string; speaker: string | null; metadata: string; internal: string; internal_notable: number; internal_viewed: number; created_at: number;
      }>;

      const participants = db.prepare(`
        SELECT sp.character_id, sp.join_order
        FROM session_participants sp WHERE sp.session_id = ? ORDER BY sp.join_order
      `).all(sessionId) as Array<{ character_id: string; join_order: number }>;

      const participantsWithNames = participants.map(p => ({
        characterId: p.character_id,
        name: getCharacterName(p.character_id),
        joinOrder: p.join_order,
      }));

      // speaker存的是character_id，翻译成角色名再返回给前端
      const speakerNameMap = new Map<string, string>();
      for (const p of participantsWithNames) {
        speakerNameMap.set(p.characterId, p.name);
      }
      const messagesWithSpeakerNames = messages.map(m => ({
        ...m,
        speaker: m.speaker ? (speakerNameMap.get(m.speaker) ?? m.speaker) : m.speaker,
      }));

      return reply.send({ session, messages: messagesWithSpeakerNames, isGroup: true, participants: participantsWithNames });
    }

    const messages = db.prepare(`
      SELECT id, role, text, image_path, metadata, internal, internal_notable, internal_viewed, created_at
      FROM messages WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as Array<{
      id: string; role: string; text: string; image_path: string | null; metadata: string; internal: string; internal_notable: number; internal_viewed: number; created_at: number;
    }>;

    // 查询好友状态
    const isFriend = session.character_id === DEITY_ID ? true :
      !!db.prepare('SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, session.character_id, 'active');

    return reply.send({ session, messages, isFriend });
  });

  // 获取进行中的约会
  app.get('/sessions/active', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const session = db.prepare('SELECT id, character_id, location_id, current_location_id, created_at, is_group FROM conversation_sessions WHERE player_id = ? AND ended = 0 AND scenario_session_id IS NULL').get(playerId) as {
      id: string; character_id: string; location_id: string | null; current_location_id: string | null; created_at: number; is_group: number;
    } | undefined;

    if (!session) {
      return reply.send({ session: null });
    }

    // 取地点名 — 优先用 current_location_id
    const effectiveLocId = session.current_location_id || session.location_id;
    let locationName = '';
    if (effectiveLocId) {
      const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(effectiveLocId) as { name: string } | undefined;
      locationName = loc?.name ?? '';
    }

    // 群聊：返回participants
    if (session.is_group) {
      const participants = db.prepare('SELECT character_id FROM session_participants WHERE session_id = ? ORDER BY join_order').all(session.id) as Array<{ character_id: string }>;
      const participantsWithNames = participants.map(p => ({
        characterId: p.character_id,
        name: getCharacterName(p.character_id),
      }));
      return reply.send({
        session: {
          id: session.id,
          characterId: session.character_id,
          isGroup: true,
          participants: participantsWithNames,
          locationId: effectiveLocId,
          locationName,
          createdAt: session.created_at,
        },
      });
    }

    return reply.send({
      session: {
        id: session.id,
        characterId: session.character_id,
        characterName: getCharacterName(session.character_id),
        locationId: effectiveLocId,
        locationName,
        createdAt: session.created_at,
      },
    });
  });

  // 发送约会消息
  app.post('/sessions/:sessionId/send', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { text, imagePath, quoteId, quoteText, quoteSenderName } = req.body as { text?: string; imagePath?: string; quoteId?: string; quoteText?: string; quoteSenderName?: string };

    if (!text?.trim() && !imagePath) {
      return reply.code(400).send({ error: '消息不能为空' });
    }

    const session = db.prepare('SELECT * FROM conversation_sessions WHERE id = ? AND player_id = ? AND ended = 0').get(sessionId, playerId) as {
      id: string; character_id: string; location_id: string | null; current_location_id: string | null; mode: string; mission_id: string | null;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: 'Session不存在或已结束' });
    }

    const ts = now();
    const textBody = text?.trim() || '';

    // 解析引用消息（前端直接传引用内容）
    let quoteMetadata = '{}';
    let quotePrefix = '';
    if (quoteId && quoteText) {
      quoteMetadata = JSON.stringify({ quote: { id: quoteId, text: quoteText, senderName: quoteSenderName ?? 'NPC' } });
      quotePrefix = formatQuotePrefix({ id: quoteId, text: quoteText, sender: 'player', senderName: quoteSenderName ?? 'NPC' });
    }

    // 存玩家消息（有图片时存image_path）
    const playerMsgId = genId();
    db.prepare(`
      INSERT INTO messages (id, session_id, role, text, metadata, image_path, internal, internal_viewed, created_at)
      VALUES (?, ?, 'player', ?, ?, ?, '', 0, ?)
    `).run(playerMsgId, sessionId, textBody, quoteMetadata, imagePath ?? null, ts);

    // 获取NPC角色数据
    const isDeity = session.character_id === DEITY_ID;
    let characterData: CharacterData | null = null;

    if (!isDeity) {
      characterData = loadCharacterData(playerId, session.character_id);
    }

    // 获取位置名 — 优先用 current_location_id（移动后的实时地点），回退到 location_id（起始地点）
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

    let worldContext: string | undefined = undefined;

    // 获取关系和记忆
    const rel = db.prepare(`
      SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?
    `).get(playerId, session.character_id) as { player_description: string; created_at: number } | undefined;

    // 获取最近消息（排除narration旁白、quest_npc）
    const recentMsgs = db.prepare(`
      SELECT role, text FROM messages WHERE session_id = ? AND created_at < ? AND role NOT IN ('narration', 'quest_npc') ORDER BY created_at DESC LIMIT 20
    `).all(sessionId, ts) as Array<{ role: string; text: string }>;

    // 记忆检索（Phase 5）
    let retrievedMemories: string | null = null;
    if (!isDeity) {
      retrievedMemories = await retrieveRelevantMemories(
        playerId, session.character_id,
        recentMsgs.map(m => ({ role: m.role, text: m.text })),
        textBody,
      );
    }

    const ctx: PromptContext = {
      characterData,
      playerDescription: rel?.player_description ?? '刚认识的陌生人',
      playerProfile: getPlayerProfile(playerId),
      chronicleSummary: getUnifiedTimeline(playerId, session.character_id),
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
    const messages = buildMessages(systemPrompt, ctx.recentMessages, quotePrefix + textBody);

    // 如果有图片，给最后一条user消息附加imagePath
    if (imagePath && messages.length > 0) {
      messages[messages.length - 1]!.imagePath = imagePath;
    }

    try {
      let reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });

      // 短输入且NPC请求搜索记忆：检索后重新生成
      if (!isDeity) {
        const searchResults = await maybeRetrieveSearchResults(reply_data, playerId, session.character_id);
        if (searchResults) {
          const enrichedMemories = (ctx.retrievedMemories ?? '') + '\n' + searchResults;
          const enrichedCtx = { ...ctx, retrievedMemories: enrichedMemories };
          const enrichedSystemPrompt = buildSystemPrompt(enrichedCtx);
          const enrichedMessages = buildMessages(enrichedSystemPrompt, enrichedCtx.recentMessages, textBody);
          if (imagePath && enrichedMessages.length > 0) {
            enrichedMessages[enrichedMessages.length - 1]!.imagePath = imagePath;
          }
          const enrichedReply = await generateReply(enrichedMessages, { temperature: 0.85, maxTokens: 1024, playerId });
          reply_data = { ...enrichedReply, need_search: false, search_query: '' };
        }
      }

      const finalReply = reply_data;

      // 地点移动：LLM 返回 current_location 时，匹配 locations 表更新 session
      let updatedLocationName = currentLocationName || locationName;
      if (finalReply.current_location && finalReply.current_location.trim()) {
        const locName = finalReply.current_location.trim();
        // 模糊匹配地点名（LLM 可能输出不完全精确的名称）
        const matched = db.prepare('SELECT id, name FROM locations WHERE name = ? OR name LIKE ?').get(locName, `%${locName}%`) as { id: string; name: string } | undefined;
        if (matched) {
          db.prepare('UPDATE conversation_sessions SET current_location_id = ?, updated_at = ? WHERE id = ?').run(matched.id, now(), sessionId);
          updatedLocationName = matched.name;
        } else {
          // 没匹配到已知地点——LLM 可能描述了一个新位置，保留名字但不更新 location_id
          updatedLocationName = locName;
        }
      }

      // 存NPC回复
      const npcSave = saveNpcReply('messages', 'session_id', sessionId, finalReply.messages, finalReply.internal, finalReply.internal_notable);
      const npcMsgIds = npcSave.msgIds;

      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

      // 更新player_description
      if (!isDeity) {
        updatePlayerDescription(playerId, session.character_id, finalReply.player_description, rel?.player_description, 'conversation', playerMsgId);
      }

      // 场景自然结束
      if (finalReply.scene_concluded) {
        // 不自动结束，只是标记建议
      }

      // 滚动折叠记忆（异步，不阻塞响应）
      if (!isDeity) {
        maybeFoldIncremental(sessionId, playerId, session.character_id, null).catch(() => {});
      }

      return reply.send({
        playerMessage: { id: playerMsgId, text: textBody, imagePath: imagePath ?? null },
        npcMessages: finalReply.messages.map((msg, i) => ({
          id: npcMsgIds[i],
          text: msg,
          internal: i === 0 ? finalReply.internal : '',
          internal_notable: i === 0 && finalReply.internal_notable,
          internal_viewed: false,
        })),
        scene_concluded: finalReply.scene_concluded,
        currentLocationName: updatedLocationName,
      });
    } catch (err) {
      app.log.error({ err }, 'LLM生成失败');
      return reply.code(502).send({ error: 'NPC回复生成失败' });
    }
  });

  // 结束约会
  app.post('/sessions/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };

    const sessionRow = db.prepare('SELECT character_id, mission_id FROM conversation_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as {
      character_id: string; mission_id: string | null;
    } | undefined;

    if (!sessionRow) {
      return reply.code(404).send({ error: '约会不存在' });
    }

    db.prepare('UPDATE conversation_sessions SET ended = 1, updated_at = ? WHERE id = ? AND player_id = ?').run(now(), sessionId, playerId);

    // 群聊结束：遍历参与者，per-character折叠记忆
    if (sessionRow.character_id !== DEITY_ID) {
      // 检查是否群聊
      const sessionInfo = db.prepare('SELECT is_group FROM conversation_sessions WHERE id = ?').get(sessionId) as { is_group: number } | undefined;
      if (sessionInfo?.is_group) {
        const participants = db.prepare('SELECT character_id FROM session_participants WHERE session_id = ?').all(sessionId) as Array<{ character_id: string }>;
        for (const p of participants) {
          foldGroupChronicle(sessionId, playerId, p.character_id).catch(() => {});
          clearUrgeAfterDate(playerId, p.character_id);
          // 每个角色独立60%概率发朋友圈
          if (Math.random() < 0.6) {
            const charName = getCharacterName(p.character_id);
            const recentMsgs = db.prepare("SELECT role, text, speaker FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 5").all(sessionId) as Array<{ role: string; text: string; speaker: string | null }>;
            const lastExchange = recentMsgs.reverse().map(m => {
              if (m.role === 'player') return `玩家：${m.text}`;
              const name = m.speaker === p.character_id ? charName : '其他人';
              return `${name}：${m.text}`;
            }).join('\n');
            generateNpcMoment(playerId, p.character_id, 'date_end', `你刚和玩家以及另一个朋友一起群聊约会结束。刚才的对话：\n${lastExchange}`).catch(() => {});
          }
        }
      } else {
        // 单聊逻辑（不变）

        foldChronicle(sessionId, playerId, sessionRow.character_id, null).catch(() => {});
        // 约会结束 → 清零意愿（约会结束已直发短信+朋友圈）
        clearUrgeAfterDate(playerId, sessionRow.character_id);

        // NPC有概率发朋友圈（约会结束后，60%概率）
        if (Math.random() < 0.6) {
          const charName = getCharacterName(sessionRow.character_id);
          // 获取约会最后的对话内容作为上下文
          const recentMsgs = db.prepare("SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 5").all(sessionId) as Array<{ role: string; text: string }>;
          const lastExchange = recentMsgs.reverse().map(m => `${m.role === 'player' ? '玩家' : charName}：${m.text}`).join('\n');
          generateNpcMoment(playerId, sessionRow.character_id, 'date_end', `你刚和玩家约会结束，地点是${(() => {
            const sess = db.prepare('SELECT location_id, current_location_id FROM conversation_sessions WHERE id = ?').get(sessionId) as { location_id: string | null; current_location_id: string | null };
            const locId = sess.current_location_id || sess.location_id;
            if (locId) {
              const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locId) as { name: string } | undefined;
              return loc?.name ?? '某处';
            }
            return '某处';
          })()}。刚才的对话：\n${lastExchange}`).catch(() => {});
        }

        // 如果刚加好友且短信线程为空，NPC主动发第一条短信
        const friendship = db.prepare('SELECT created_at FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, sessionRow.character_id, 'active') as { created_at: number } | undefined;
        if (friendship) {
          const thread = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, sessionRow.character_id) as { id: string } | undefined;
          if (thread) {
            const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM text_messages WHERE thread_id = ?').get(thread.id) as { cnt: number };
            if (msgCount.cnt === 0) {
              const charName = getCharacterName(sessionRow.character_id);
              const recentMsgs = db.prepare("SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 5").all(sessionId) as Array<{ role: string; text: string }>;
              const lastExchange = recentMsgs.reverse().map(m => `${m.role === 'player' ? '玩家' : charName}：${m.text}`).join('\n');
              const locName = (() => {
                const sess = db.prepare('SELECT location_id, current_location_id FROM conversation_sessions WHERE id = ?').get(sessionId) as { location_id: string | null; current_location_id: string | null };
                const locId = sess.current_location_id || sess.location_id;
                if (locId) {
                  const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locId) as { name: string } | undefined;
                  return loc?.name ?? '某处';
                }
                return '某处';
              })();
              generateSmsGreeting(playerId, sessionRow.character_id, thread.id, { locationName: locName, lastExchange }).catch(() => {});
            }
          }
        }
      }
    }

    return reply.send({ ok: true });
  });

  // 加好友 — 面对面认识后，建立好友关系并创建短信线程
  app.post('/sessions/:sessionId/add-friend', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare('SELECT character_id FROM conversation_sessions WHERE id = ? AND player_id = ? AND ended = 0').get(sessionId, playerId) as { character_id: string } | undefined;
    if (!session) {
      return reply.code(404).send({ error: '约会不存在或已结束' });
    }
    if (session.character_id === DEITY_ID) {
      return reply.code(400).send({ error: '主神不需要加好友' });
    }

    const characterId = session.character_id;
    const ts = now();

    // 创建好友关系（如果已有则忽略）
    const existingFriend = db.prepare('SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, characterId, 'active');
    if (existingFriend) {
      return reply.send({ alreadyFriend: true });
    }
    db.prepare('INSERT OR REPLACE INTO friendships (player_id, character_id, status, created_at) VALUES (?, ?, ?, ?)').run(playerId, characterId, 'active', ts);

    // 初始化主动消息计时器
    initUrge(playerId, characterId);

    // 创建短信线程（如果已有则忽略）
    const existingThread = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { id: string } | undefined;
    let threadId = existingThread?.id;
    if (!threadId) {
      threadId = genId();
      db.prepare('INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)').run(threadId, playerId, characterId, ts, ts);
    }

    return reply.send({ ok: true, threadId });
  });

  // 撤回 — 删除玩家最后一条消息及NPC的回复
  app.delete('/sessions/:sessionId/undo', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const session = db.prepare('SELECT id FROM conversation_sessions WHERE id = ? AND player_id = ? AND ended = 0').get(sessionId, playerId);
    if (!session) return reply.code(404).send({ error: '约会不存在或已结束' });

    // 先删后扣 + 包事务：任一步失败 ROLLBACK，不产生"白扣费"（修复先扣费后校验的 bug）
    db.exec('BEGIN');
    try {
      const undoResult = undoLastPlayerMessage({ table: 'messages', idColumn: 'session_id', idValue: sessionId, playerRole: 'player', roleColumn: 'role' });
      if (!undoResult.ok) {
        db.exec('ROLLBACK');
        return reply.code(undoResult.code).send({ error: undoResult.error });
      }

      // 删除已确认成功，此时才扣费；余额不足则回滚删除
      const undoCost = getCosts().undo_message;
      const spendResult = spendPlayerPermission(playerId, undoCost, 'undo');
      if (!spendResult.ok) {
        db.exec('ROLLBACK');
        return reply.code(403).send({ error: `权限不足（需要${undoCost}）` });
      }

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 事务可能已不在 */ }
      app.log.error({ err }, '约会撤回失败');
      return reply.code(500).send({ error: '撤回失败，请重试' });
    }

    return reply.send({ ok: true });
  });

  // 重试 — 删除NPC最后回复，用同样的玩家消息重新生成
  app.post('/sessions/:sessionId/retry', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const session = db.prepare('SELECT * FROM conversation_sessions WHERE id = ? AND player_id = ? AND ended = 0').get(sessionId, playerId) as { id: string; character_id: string; location_id: string | null; current_location_id: string | null; mission_id: string | null; created_at: number } | undefined;
    if (!session) return reply.code(404).send({ error: '约会不存在或已结束' });

    // 找最后一条 player 消息 + 删除其后 NPC 回复
    const lookup = findLastPlayerForRetry('messages', 'session_id', sessionId);
    if (!lookup.lastPlayer) {
      // Greeting重试：session里没有player消息，说明只有开场白
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);

      let greetingResult: { messages: string[]; internal: string; internal_notable: boolean };

      {
        // 普通greeting重试
        // 判断是否初见：relationship的created_at >= session的created_at说明是本session创建时建的
        const rel2 = db.prepare('SELECT created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, session.character_id) as { created_at: number } | undefined;
        const wasFirstMeeting = !rel2 || rel2.created_at >= session.created_at;
        try {
          const g = await generateGreeting(sessionId, playerId, session.character_id, session.location_id, undefined, undefined, wasFirstMeeting);
          if (!g) {
            return reply.code(502).send({ error: '开场白重新生成失败' });
          }
          greetingResult = {
            messages: g.messages,
            internal: g.internal,
            internal_notable: g.internal_notable,
          };
        } catch {
          return reply.code(502).send({ error: '开场白重新生成失败' });
        }
      }

      // 存greeting消息
      const npcMsgIds: string[] = [];
      for (let i = 0; i < greetingResult.messages.length; i++) {
        const msg = greetingResult.messages[i]!;
        const msgId = genId();
        const internal = i === 0 ? greetingResult.internal : '';
        const internalNotable = i === 0 && greetingResult.internal_notable ? 1 : 0;
        db.prepare(`
          INSERT INTO messages (id, session_id, role, text, metadata, internal, internal_notable, internal_viewed, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', ?, ?, 0, ?)
        `).run(msgId, sessionId, msg, internal, internalNotable, now());
        npcMsgIds.push(msgId);
      }
      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

      return reply.send({
        npcMessages: greetingResult.messages.map((msg, i) => ({
          id: npcMsgIds[i],
          text: msg,
          internal: i === 0 ? greetingResult.internal : '',
          internal_notable: i === 0 && greetingResult.internal_notable,
        })),
        scene_concluded: false,
        currentLocationName: '',
      });
    }

    // 删除这条 player 消息之后的所有 NPC 回复 + quest_npc台词 + narration旁白
    db.prepare("DELETE FROM messages WHERE session_id = ? AND role IN ('assistant', 'quest_npc', 'narration') AND created_at > ?").run(sessionId, lookup.lastPlayer.created_at);

    // 重新发送
    const textBody = lookup.text!;
    const imagePath = lookup.imagePath ?? undefined;
    const playerMsgId = lookup.lastPlayer.id;
    const ts = now();

    // 从玩家消息的metadata中恢复引用前缀
    let quotePrefix = '';
    const playerRow = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(playerMsgId) as { metadata: string } | undefined;
    if (playerRow?.metadata) {
      try {
        const meta = JSON.parse(playerRow.metadata);
        if (meta.quote?.text && meta.quote?.senderName) {
          quotePrefix = formatQuotePrefix({ id: meta.quote.id, text: meta.quote.text, sender: 'player', senderName: meta.quote.senderName });
        }
      } catch {}
    }

    // 复用 /send 的核心逻辑
    const characterId = session.character_id;
    const isDeity = characterId === DEITY_ID;
    let characterData: CharacterData | null = null;

    if (!isDeity) {
      characterData = loadCharacterData(playerId, characterId);
    }

    const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;
    const recentMsgs = db.prepare("SELECT role, text FROM messages WHERE session_id = ? AND created_at < ? AND role NOT IN ('narration', 'quest_npc') ORDER BY created_at DESC LIMIT 20").all(sessionId, lookup.lastPlayer.created_at) as Array<{ role: string; text: string }>;

    // 获取位置名 — 优先用 current_location_id（移动后的实时地点）
    let locationName = '';
    let currentLocationName = '';
    if (session.location_id) {
      const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(session.location_id) as { name: string } | undefined;
      if (loc) locationName = loc.name;
    }
    if (session.current_location_id && session.current_location_id !== session.location_id) {
      const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(session.current_location_id) as { name: string } | undefined;
      if (loc) currentLocationName = loc.name;
    }

    const retryWorldContext: string | undefined = undefined;

    // 记忆检索（Phase 5）
    let retrievedMemories: string | null = null;
    if (!isDeity) {
      retrievedMemories = await retrieveRelevantMemories(
        playerId, characterId,
        recentMsgs.map(m => ({ role: m.role, text: m.text })),
        textBody,
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
      worldContext: retryWorldContext,
    };

    const systemPrompt = buildSystemPrompt(ctx);
    const messages = buildMessages(systemPrompt, ctx.recentMessages, quotePrefix + textBody);

    // 如果有图片，给最后一条user消息附加imagePath（重试也保留图片）
    if (imagePath && messages.length > 0) {
      messages[messages.length - 1]!.imagePath = imagePath;
    }

    try {
      const reply_data = await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });

      const finalReply = reply_data;

      // 地点移动：LLM 返回 current_location 时，匹配 locations 表更新 session
      let updatedLocationName = currentLocationName || locationName;
      if (finalReply.current_location && finalReply.current_location.trim()) {
        const locName = finalReply.current_location.trim();
        const matched = db.prepare('SELECT id, name FROM locations WHERE name = ? OR name LIKE ?').get(locName, `%${locName}%`) as { id: string; name: string } | undefined;
        if (matched) {
          db.prepare('UPDATE conversation_sessions SET current_location_id = ?, updated_at = ? WHERE id = ?').run(matched.id, now(), sessionId);
          updatedLocationName = matched.name;
        } else {
          updatedLocationName = locName;
        }
      }

      const npcSave = saveNpcReply('messages', 'session_id', sessionId, finalReply.messages, finalReply.internal, finalReply.internal_notable);
      const npcMsgIds = npcSave.msgIds;

      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

      return reply.send({
        npcMessages: npcSave.formattedMessages,
        scene_concluded: finalReply.scene_concluded,
        currentLocationName: updatedLocationName,
      });
    } catch (err) {
      return reply.code(502).send({ error: 'NPC回复生成失败' });
    }
  });

  // 继续对话 — 玩家不用打字，让NPC主动接话
  app.post('/sessions/:sessionId/nudge', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const session = db.prepare('SELECT * FROM conversation_sessions WHERE id = ? AND player_id = ? AND ended = 0').get(sessionId, playerId) as
      { id: string; character_id: string; location_id: string | null; is_group: number } | undefined;
    if (!session) return reply.code(404).send({ error: '约会不存在或已结束' });

    // 群聊不支持nudge
    if (session.is_group) {
      return reply.code(400).send({ error: '群聊不支持继续对话' });
    }

    try {
      const messages = await generateConversationProactive(playerId, sessionId, session.character_id, true);
      if (!messages || messages.length === 0) {
        return reply.code(502).send({ error: 'NPC暂时不知道说什么' });
      }
      return reply.send({ npcMessages: messages });
    } catch {
      return reply.code(502).send({ error: 'NPC回复生成失败' });
    }
  });

  // ─── 群聊约会 ──────────────────────────────────────────────

  // 创建群聊session
  app.post('/sessions/group', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { characterIds, locationId, trigger } = req.body as {
      characterIds?: string[]; locationId?: string; trigger?: 'invite' | 'deity_pick';
    };

    if (!characterIds || characterIds.length !== 2) {
      return reply.code(400).send({ error: '群聊需要选择2个角色' });
    }
    if (!locationId) {
      return reply.code(400).send({ error: '需要locationId' });
    }

    // 排除主神
    if (characterIds.includes(DEITY_ID)) {
      return reply.code(400).send({ error: '不能邀请主神参加群聊' });
    }

    // 全局现场互斥：人只有一个，同一时间只能"在场"于一个玩法现场。
    const live = getActiveLiveSlot(playerId);
    if (live) {
      return reply.code(409).send({ error: '已有进行中的现场', live });
    }

    // 检查两个角色都是好友
    for (const cid of characterIds) {
      const isFriend = db.prepare('SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, cid, 'active');
      if (!isFriend) {
        return reply.code(400).send({ error: '只能邀请好友参加群聊' });
      }
    }

    // 加载角色数据
    const charA = loadCharacterData(playerId, characterIds[0]!);
    const charB = loadCharacterData(playerId, characterIds[1]!);
    if (!charA || !charB) {
      return reply.code(400).send({ error: '角色数据加载失败' });
    }

    // 创建session（character_id存第一个角色，is_group=1）
    const sessionId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO conversation_sessions (id, player_id, character_id, location_id, mode, summary, ended, is_group, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'group', '', 0, 1, ?, ?)
    `).run(sessionId, playerId, characterIds[0]!, locationId, ts, ts);

    // 创建participants
    db.prepare('INSERT INTO session_participants (session_id, character_id, join_order) VALUES (?, ?, 0)').run(sessionId, characterIds[0]!);
    db.prepare('INSERT INTO session_participants (session_id, character_id, join_order) VALUES (?, ?, 1)').run(sessionId, characterIds[1]!);

    // 为每个角色创建/更新relationship
    for (const cid of characterIds) {
      const existingRel = db.prepare('SELECT id FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, cid);
      if (!existingRel) {
        db.prepare(`INSERT INTO relationships (id, player_id, character_id, player_description, updated_at, created_at) VALUES (?, ?, ?, '刚认识的陌生人', ?, ?)`)
          .run(genId(), playerId, cid, ts, ts);
      } else {
        db.prepare('UPDATE relationships SET updated_at = ? WHERE player_id = ? AND character_id = ?').run(ts, playerId, cid);
      }
    }

    // 生成群聊greeting
    let greeting: { messages: { speaker: string; text: string }[]; internals: Record<string, string>; internals_notable: Record<string, boolean> } | null = null;
    try {
      greeting = await generateGroupGreeting(sessionId, playerId, characterIds, locationId, trigger);
    } catch (err) {
      app.log.error({ err }, '群聊greeting生成失败，回滚session');
      db.prepare('DELETE FROM conversation_sessions WHERE id = ?').run(sessionId);
      return reply.code(502).send({ error: '开场白生成失败，请重试' });
    }

    if (greeting) {
      // 存greeting消息
      const speakerMap: Record<string, string> = { [charA.name]: characterIds[0]!, [charB.name]: characterIds[1]! };
      for (let i = 0; i < greeting.messages.length; i++) {
        const msg = greeting.messages[i]!;
        const speakerName = msg.speaker;
        // speaker名→characterId（精确匹配优先，容错：名包含关系）
        const speakerCharId = speakerMap[speakerName]
          ?? (speakerName.includes(charA.name) || charA.name.includes(speakerName) ? characterIds[0]! : characterIds[1]!);
        const internal = greeting.internals[speakerName] ?? '';
        const internalNotable = greeting.internals_notable[speakerName] ?? false;
        db.prepare(`
          INSERT INTO messages (id, session_id, role, text, metadata, speaker, internal, internal_notable, internal_viewed, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', ?, ?, ?, 0, ?)
        `).run(genId(), sessionId, msg.text, speakerCharId, internal, internalNotable ? 1 : 0, now());
      }
      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
    } else {
      db.prepare('DELETE FROM conversation_sessions WHERE id = ?').run(sessionId);
      return reply.code(502).send({ error: '开场白生成失败，请重试' });
    }

    const participants = characterIds.map((cid, i) => ({
      characterId: cid,
      name: i === 0 ? charA.name : charB.name,
    }));

    return reply.send({
      sessionId,
      greeting: {
        messages: greeting.messages,
        internals: greeting.internals,
        internals_notable: greeting.internals_notable,
      },
      participants,
    });
  });

  // 群聊发消息
  app.post('/sessions/:sessionId/group-send', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { text, quoteId, quoteText, quoteSenderName } = req.body as { text?: string; quoteId?: string; quoteText?: string; quoteSenderName?: string };

    if (!text?.trim()) {
      return reply.code(400).send({ error: '消息不能为空' });
    }

    const session = db.prepare('SELECT * FROM conversation_sessions WHERE id = ? AND player_id = ? AND ended = 0 AND is_group = 1').get(sessionId, playerId) as {
      id: string; character_id: string; location_id: string | null; is_group: number;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: '群聊session不存在或已结束' });
    }

    const ts = now();
    const textBody = text.trim();

    // 获取participants（先加载，群聊需要speakerNameMap来解析引用）
    const participants = db.prepare('SELECT character_id, join_order FROM session_participants WHERE session_id = ? ORDER BY join_order').all(sessionId) as
      { character_id: string; join_order: number }[];
    if (participants.length < 2) {
      return reply.code(500).send({ error: '群聊参与者数据异常' });
    }

    const charIdA = participants[0]!.character_id;
    const charIdB = participants[1]!.character_id;

    // 加载两个角色的数据
    const charDataA = loadCharacterData(playerId, charIdA);
    const charDataB = loadCharacterData(playerId, charIdB);
    if (!charDataA || !charDataB) {
      return reply.code(500).send({ error: '角色数据加载失败' });
    }

    const charNames = [charDataA.name, charDataB.name];

    // 解析引用消息（群聊需要speakerNameMap把speaker character_id翻译成角色名）
    const speakerNameMap = new Map<string, string>();
    speakerNameMap.set(charIdA, charDataA.name);
    speakerNameMap.set(charIdB, charDataB.name);

    let quoteMetadata = '{}';
    let quotePrefix = '';
    if (quoteId && quoteText) {
      quoteMetadata = JSON.stringify({ quote: { id: quoteId, text: quoteText, senderName: quoteSenderName ?? 'NPC' } });
      quotePrefix = formatQuotePrefix({ id: quoteId, text: quoteText, sender: 'player', senderName: quoteSenderName ?? 'NPC' });
    }

    // 存玩家消息
    const playerMsgId = genId();
    db.prepare(`
      INSERT INTO messages (id, session_id, role, text, metadata, speaker, internal, internal_viewed, created_at)
      VALUES (?, ?, 'player', ?, ?, NULL, '', 0, ?)
    `).run(playerMsgId, sessionId, textBody, quoteMetadata, ts);

    // 获取位置名
    let locationName = '';
    if (session.location_id) {
      const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(session.location_id) as { name: string } | undefined;
      locationName = loc?.name ?? '';
    }

    // 获取关系和记忆（per-character）
    const relA = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, charIdA) as { player_description: string; created_at: number } | undefined;
    const relB = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, charIdB) as { player_description: string; created_at: number } | undefined;

    const [memA, memB] = await Promise.all([
      retrieveRelevantMemories(playerId, charIdA, [], textBody),
      retrieveRelevantMemories(playerId, charIdB, [], textBody),
    ]);

    // 获取最近消息（带speaker）
    const recentMsgs = db.prepare(`
      SELECT role, text, speaker FROM messages WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 20
    `).all(sessionId, ts) as Array<{ role: string; text: string; speaker: string | null }>;

    // 组装群聊prompt context
    const ctxA: GroupCharContext = {
      characterData: charDataA,
      playerDescription: relA?.player_description ?? '刚认识的陌生人',
      chronicleSummary: getUnifiedTimeline(playerId, charIdA),
      retrievedMemories: memA,
      relationshipDuration: relA?.created_at ? formatRelationshipDuration(relA.created_at) : '',
    };
    const ctxB: GroupCharContext = {
      characterData: charDataB,
      playerDescription: relB?.player_description ?? '刚认识的陌生人',
      chronicleSummary: getUnifiedTimeline(playerId, charIdB),
      retrievedMemories: memB,
      relationshipDuration: relB?.created_at ? formatRelationshipDuration(relB.created_at) : '',
    };

    const systemPrompt = buildGroupSystemPrompt(ctxA, ctxB, getPlayerProfile(playerId), locationName, getHubLocationsText());

    // 历史消息：speaker名映射（speakerNameMap已在前方定义）

    const recentForPrompt = recentMsgs.reverse().map(m => ({
      role: (m.role === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
      text: m.text,
      speakerName: m.speaker ? (speakerNameMap.get(m.speaker) ?? '') : undefined,
    }));

    const messages = buildGroupMessages(systemPrompt, recentForPrompt, quotePrefix + textBody);

    try {
      const groupReply = await generateGroupReply(messages, charNames, { temperature: 0.85, maxTokens: 1024, playerId });

      // 存NPC消息
      const npcMsgIds: string[] = [];
      const npcMessages: { id: string; speaker: string; text: string; internal: string; internal_notable: boolean }[] = [];

      const speakerMap: Record<string, string> = { [charDataA.name]: charIdA, [charDataB.name]: charIdB };
      for (const msg of groupReply.messages) {
        // normalizeGroupReply已保证speaker是合法角色名，但加容错防LLM变体名
        const speakerName = msg.speaker;
        const speakerCharId = speakerMap[speakerName]
          ?? (speakerName.includes(charDataA.name) || charDataA.name.includes(speakerName) ? charIdA : charIdB);
        const internal = groupReply.internals[speakerName] ?? '';
        const internalNotable = groupReply.internals_notable[speakerName] ?? false;
        const msgId = genId();
        db.prepare(`
          INSERT INTO messages (id, session_id, role, text, metadata, speaker, internal, internal_notable, internal_viewed, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', ?, ?, ?, 0, ?)
        `).run(msgId, sessionId, msg.text, speakerCharId, internal, internalNotable ? 1 : 0, now());
        npcMsgIds.push(msgId);
        npcMessages.push({ id: msgId, speaker: msg.speaker, text: msg.text, internal, internal_notable: internalNotable });
      }

      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

      // 更新两个角色的player_description
      for (const [name, desc] of Object.entries(groupReply.player_descriptions)) {
        if (!desc) continue;
        const cid = speakerMap[name]
          ?? (name.includes(charDataA.name) || charDataA.name.includes(name) ? charIdA : charIdB);
        const oldDesc = cid === charIdA ? relA?.player_description : relB?.player_description;
        updatePlayerDescription(playerId, cid, desc, oldDesc, 'conversation', playerMsgId);
      }

      // 滚动折叠记忆（per-character，异步）
      for (const cid of [charIdA, charIdB]) {
        maybeFoldGroupIncremental(sessionId, playerId, cid).catch(() => {});
      }

      return reply.send({
        playerMessage: { id: playerMsgId, text: textBody },
        npcMessages,
        scene_concluded: groupReply.scene_concluded,
      });
    } catch (err) {
      app.log.error({ err }, '群聊LLM生成失败');
      return reply.code(502).send({ error: 'NPC回复生成失败' });
    }
  });

  // 群聊获取消息 — 在GET /sessions/:sessionId/messages中通过is_group返回participants
}

/**
 * 生成群聊NPC开场白 — 两个角色看到玩家邀请，自然地开始对话
 */
async function generateGroupGreeting(
  sessionId: string,
  playerId: string,
  characterIds: string[],
  locationId: string,
  trigger?: 'invite' | 'deity_pick',
): Promise<{ messages: { speaker: string; text: string }[]; internals: Record<string, string>; internals_notable: Record<string, boolean> } | null> {
  const charDataA = loadCharacterData(playerId, characterIds[0]!);
  const charDataB = loadCharacterData(playerId, characterIds[1]!);
  if (!charDataA || !charDataB) return null;

  const charNames = [charDataA.name, charDataB.name];

  let locationName = '';
  const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId) as { name: string } | undefined;
  locationName = loc?.name ?? '';

  // 获取关系和记忆
  const relA = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterIds[0]!) as { player_description: string; created_at: number } | undefined;
  const relB = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterIds[1]!) as { player_description: string; created_at: number } | undefined;

  const isDeityPick = trigger === 'deity_pick';
  const memQuery = isDeityPick
    ? '主神随机抽选把你们送到了同一个地方'
    : '玩家邀请你和另一个人一起出来玩';

  const [memA, memB] = await Promise.all([
    retrieveRelevantMemories(playerId, characterIds[0]!, [], memQuery),
    retrieveRelevantMemories(playerId, characterIds[1]!, [], memQuery),
  ]);

  const ctxA: GroupCharContext = {
    characterData: charDataA,
    playerDescription: relA?.player_description ?? '刚认识的陌生人',
    chronicleSummary: getUnifiedTimeline(playerId, characterIds[0]!),
    retrievedMemories: memA,
    relationshipDuration: relA?.created_at ? formatRelationshipDuration(relA.created_at) : '',
  };
  const ctxB: GroupCharContext = {
    characterData: charDataB,
    playerDescription: relB?.player_description ?? '刚认识的陌生人',
    chronicleSummary: getUnifiedTimeline(playerId, characterIds[1]!),
    retrievedMemories: memB,
    relationshipDuration: relB?.created_at ? formatRelationshipDuration(relB.created_at) : '',
  };

  const systemPrompt = buildGroupSystemPrompt(ctxA, ctxB, getPlayerProfile(playerId), locationName, getHubLocationsText());

  const greetingHint = isDeityPick
    ? `主神随机抽选把你们两个送到了${locationName}，玩家也在。你们刚到，都有些莫名其妙——并不是自己要来的。两个角色对被随机扔到一起这件事、对和对方困在同一场合这件事，各有各的反应——可能困惑主神在想什么，可能对和对方共处感到意外或不自在，也可能觉得碰巧见到认识的人还不错。自然地开始第一轮对话，互相react。`
    : `玩家邀请了你们两个一起来${locationName}。你们刚到，玩家也在。两个角色对被邀请这件事、对和对方一起出来这件事，各有各的反应——可能好奇玩家为什么把你们凑在一起，可能对群聊场合感到兴奋或不自在。自然地开始第一轮对话，互相react。`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: greetingHint },
  ];

  try {
    const reply = await generateGroupReply(messages, charNames, { temperature: 0.85, maxTokens: 1024, playerId });
    return {
      messages: reply.messages,
      internals: reply.internals,
      internals_notable: reply.internals_notable,
    };
  } catch {
    return null;
  }
}

/**
 * 生成NPC开场白 — NPC看到玩家走过来，主动说第一句话。
 * 不需要player input，LLM根据角色性格+关系+地点生成greeting。
 *
 * encounterContext: 可选，偶遇上下文（从探索模式转入时传入）
 */
export async function generateGreeting(
  sessionId: string,
  playerId: string,
  characterId: string,
  locationId: string | null,
  trigger?: 'talk' | 'invite' | 'deity_pick',
  encounterContext?: string,
  isFirstMeetingOverride?: boolean,
) {
  const isDeity = characterId === DEITY_ID;
  let characterData: CharacterData | null = null;

  if (!isDeity) {
    characterData = loadCharacterData(playerId, characterId);
  }

  let locationName = '';
  let currentActivity = '';
  if (locationId) {
    const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(locationId) as { name: string } | undefined;
    locationName = loc?.name ?? '';

    // 从行程系统取NPC当前活动，让greeting与地图显示一致
    if (!isDeity && characterData) {
      const schedule = getCurrentSchedule(playerId, characterId, characterData, Date.now());
      if (schedule && schedule.locationId === locationId) {
        currentActivity = schedule.activity;
      }
    }
  }

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;

  // 向量检索相关记忆（非第一次见面时）
  let retrievedMemories: string | null = null;
  if (!isDeity && rel) {
    const timelineText = getUnifiedTimeline(playerId, characterId);
    retrievedMemories = await retrieveRelevantMemories(
      playerId, characterId,
      timelineText ? [{ role: 'assistant', text: timelineText }] : [],
      '玩家又来找你了',
    );
  }

  // isFirstMeetingOverride 优先（调用方在创建relationship前已判断过），
  // 否则按rel是否存在判断
  const isFirstMeeting = isFirstMeetingOverride ?? !rel;

  const ctx: PromptContext = {
    characterData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: [],
    isTextMessage: false,
    isDeity,
    locationName,
    hubLocations: getHubLocationsText(),
    retrievedMemories,
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx);
  const activityHint = currentActivity
    ? `你此刻正在${currentActivity}。`
    : '你正待在自己的位置上做自己的事。';
  const isInvite = trigger === 'invite';
  const isDeityPick = trigger === 'deity_pick';

  // 三种背景：搭话(talk) / 邀请(invite) / 主神抽选(deity_pick)
  // deity_pick: NPC被主神随机抽中传送过来，自己可能都莫名其妙
  // 注意：greeting始终是NPC先开口——即使是玩家点"搭话"，也是NPC注意到玩家后主动搭话
  const meetingHint = isFirstMeeting
    ? isInvite
      ? `（玩家邀请你来${locationName}约会。${activityHint}你被叫到了这里，这是你们第一次面对面。按照你的性格反应——可能是好奇，可能是惊喜，可能是礼貌但不热络。说第一句话，同时用动作描写呈现你此刻的状态。）`
      : isDeityPick
        ? `（主神随机抽选把你送到了${locationName}，玩家也在。${activityHint}你突然被扔到这里，有些莫名其妙——这是你们第一次面对面，但你并没有主动要来。按照你的性格反应——可能是困惑，可能是好奇，可能是对主神的安排不以为然。自然地开口说第一句话，同时用动作描写呈现你此刻的状态。）`
        : encounterContext
          ? `（${encounterContext}。${activityHint}你注意到了这个不认识的人在附近——这是你们第一次面对面。按照你的性格反应，主动向对方搭话——可能是好奇地打招呼，可能是惊讶地多看一眼后开口，可能是礼貌但不热络地寒暄。自然地开口说第一句话，同时用动作描写呈现你此刻的状态。）`
          : `（${activityHint}你注意到一个不认识的人出现在${locationName}附近——这是你们第一次面对面。按照你的性格，主动向对方搭话——可能是好奇地打招呼，可能是惊讶地多看一眼后开口，可能是礼貌但不热络地寒暄。说第一句话，同时用动作描写呈现你此刻的状态。）`
    : isInvite
      ? `（玩家邀请你来${locationName}约会。${activityHint}你应约而来，认识这个人——参考记忆摘要中你们之间发生过的事。按照你的性格反应，自然地打招呼。不要生硬地复述记忆，而是像应邀赴约那样自然地回应。说第一句话，同时用动作描写呈现你此刻的状态。）`
      : isDeityPick
        ? `（主神随机抽选把你送到了${locationName}，玩家也在。${activityHint}你突然被扔到这里，并不是自己要来的——但你认识这个人，参考记忆摘要中你们之间发生过的事。按照你的性格反应——可能对被抽中来这里感到困惑或无奈，也可能觉得碰巧见到认识的人还不错。自然地打招呼，同时用动作描写呈现你此刻的状态。）`
        : encounterContext
          ? `（${encounterContext}。${activityHint}你认识这个人——参考记忆摘要中你们之间发生过的事，自然地打招呼。不要生硬地复述记忆摘要，而是像偶遇时那样自然地回应。按照你的性格反应，说第一句话，同时用动作描写呈现你此刻的状态。）`
          : `（玩家又来找你了。${activityHint}你认识这个人——你们之前已经见过面，参考记忆摘要中你们之间发生过的事，自然地打招呼。不要假装不认识，也不要生硬地复述记忆摘要，而是像老熟人重逢那样自然地回应。按照你的性格反应，说第一句话，同时用动作描写呈现你此刻的状态。）`;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: meetingHint },
  ];

  try {
    return await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });
  } catch {
    return null;
  }
}
