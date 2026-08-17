/**
 * 朋友圈路由
 *
 * 酒馆模式：每个玩家只看到自己 + 自己好友NPC的朋友圈
 * NPC帖子是per-player的，与schedule一致
 *
 * 核心功能：
 * 1. 玩家发帖 → 好友NPC异步生成评论（模拟"刷到了随手评论"）
 * 2. NPC发帖 → 由系统事件触发（约会结束/任务完成/行程/随机）
 * 3. 互动：点赞 + 评论（玩家和NPC都能）
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now } from '../lib/util';
import { buildSystemPrompt, getPlayerProfile, formatRelationshipDuration, getHubLocationsText, REPLY_SCHEMA, type PromptContext } from '../prompt/builder';
import { retrieveRelevantMemories, getUnifiedTimeline } from '../lib/memory';
import { loadCharacterData, getCharacterName, getCharacterAvatar } from '../lib/character';
import type { CharacterData } from '@idate/shared';
import type { ChatMessage } from '../llm/adapter';
import { chat, tryParseJsonReply } from '../llm/adapter';
import { getCurrentSchedule } from '../lib/schedule';
import { embed, storeEmbedding } from '../lib/embedding';
import { resetMomentUrge } from '../lib/proactive';

export async function momentRoutes(app: FastifyInstance): Promise<void> {

  // ─── 获取朋友圈feed ────────────────────────────────────
  app.get('/moments', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const limit = 50;
    const moments = db.prepare(`
      SELECT id, author_type, author_id, content, image_path, mood, location_name, trigger_type, created_at
      FROM moments
      WHERE player_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(playerId, limit) as Array<{
      id: string; author_type: string; author_id: string; content: string; image_path: string | null;
      mood: string; location_name: string; trigger_type: string; created_at: number;
    }>;

    // 批量获取互动
    const result = moments.map(m => {
      const interactions = db.prepare(`
        SELECT id, author_type, author_id, interaction_type, body, created_at
        FROM moment_interactions
        WHERE moment_id = ?
        ORDER BY created_at ASC
      `).all(m.id) as Array<{
        id: string; author_type: string; author_id: string;
        interaction_type: string; body: string; created_at: number;
      }>;

      // 解析作者名
      let authorName = '我';
      let authorAvatar = '';
      if (m.author_type === 'character') {
        authorName = getCharacterName(m.author_id);
        authorAvatar = getCharacterAvatar(playerId, m.author_id) ?? '';
      } else {
        const player = db.prepare('SELECT name FROM players WHERE id = ?').get(m.author_id) as { name: string } | undefined;
        authorName = player?.name ?? '我';
      }

      const likes = interactions.filter(i => i.interaction_type === 'like');
      const comments = interactions.filter(i => i.interaction_type === 'comment');

      // 解析互动者名
      const resolveName = (authorType: string, authorId: string): string => {
        if (authorType === 'character') return getCharacterName(authorId);
        const p = db.prepare('SELECT name FROM players WHERE id = ?').get(authorId) as { name: string } | undefined;
        return p?.name ?? '未知';
      };

      return {
        id: m.id,
        authorType: m.author_type,
        authorId: m.author_id,
        authorName,
        authorAvatar,
        content: m.content,
        imagePath: m.image_path,
        mood: m.mood,
        locationName: m.location_name,
        triggerType: m.trigger_type,
        createdAt: m.created_at,
        likes: likes.map(l => ({ id: l.id, authorType: l.author_type, authorId: l.author_id, authorName: resolveName(l.author_type, l.author_id) })),
        comments: comments.map(c => ({ id: c.id, authorType: c.author_type, authorId: c.author_id, authorName: resolveName(c.author_type, c.author_id), body: c.body, createdAt: c.created_at })),
      };
    });

    return reply.send({ moments: result, serverTime: now() });
  });

  // ─── 未读朋友圈数 ────────────────────────────────────────
  // 返回 since 时间戳之后 NPC 发的新帖 + NPC 新评论/点赞数
  app.get('/moments/unread-count', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const since = Number((req.query as { since?: string }).since ?? 0);

    // NPC 新帖
    const newPosts = db.prepare(`
      SELECT COUNT(*) as c FROM moments
      WHERE player_id = ? AND author_type = 'character' AND created_at > ?
    `).get(playerId, since) as { c: number };

    // NPC 新互动（评论/点赞）在玩家帖子或NPC帖子下
    const newInteractions = db.prepare(`
      SELECT COUNT(*) as c FROM moment_interactions mi
      JOIN moments m ON m.id = mi.moment_id
      WHERE m.player_id = ? AND mi.author_type = 'character' AND mi.created_at > ?
    `).get(playerId, since) as { c: number };

    return reply.send({ count: newPosts.c + newInteractions.c });
  });

  // ─── 玩家发帖 ──────────────────────────────────────────
  app.post('/moments', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { content, imagePath } = req.body as { content?: string; imagePath?: string };
    if (!content?.trim() && !imagePath) {
      return reply.code(400).send({ error: '内容不能为空' });
    }

    const momentId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO moments (id, player_id, author_type, author_id, content, image_path, mood, location_name, trigger_type, created_at)
      VALUES (?, ?, 'player', ?, ?, ?, '', '', 'player', ?)
    `).run(momentId, playerId, playerId, content?.trim() ?? '', imagePath ?? null, ts);

    // 异步触发好友NPC评论（不阻塞响应）
    triggerNpcComments(playerId, momentId, content?.trim() ?? '', imagePath).catch(() => {});

    return reply.send({ ok: true, momentId });
  });

  // ─── 玩家评论 ──────────────────────────────────────────
  app.post('/moments/:momentId/comment', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { momentId } = req.params as { momentId: string };
    const { text } = req.body as { text?: string };
    if (!text?.trim()) {
      return reply.code(400).send({ error: '评论不能为空' });
    }

    // 验证帖子存在于玩家的feed中
    const moment = db.prepare('SELECT author_type, author_id FROM moments WHERE id = ? AND player_id = ?').get(momentId, playerId) as
      { author_type: string; author_id: string } | undefined;
    if (!moment) {
      return reply.code(404).send({ error: '帖子不存在' });
    }

    const interactionId = genId();
    db.prepare(`
      INSERT INTO moment_interactions (id, moment_id, author_type, author_id, interaction_type, body, created_at)
      VALUES (?, ?, 'player', ?, 'comment', ?, ?)
    `).run(interactionId, momentId, playerId, text.trim(), now());

    // 如果评论的是NPC的帖子，异步触发NPC回复评论 + 清零该NPC的朋友圈意愿
    if (moment.author_type === 'character') {
      resetMomentUrge(playerId, moment.author_id);
      triggerNpcReplyToComment(playerId, momentId, moment.author_id, text.trim()).catch(() => {});
    }

    return reply.send({ ok: true, interactionId });
  });

  // ─── 点赞 / 取消点赞 ──────────────────────────────────
  app.post('/moments/:momentId/like', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { momentId } = req.params as { momentId: string };
    const moment = db.prepare('SELECT author_type, author_id FROM moments WHERE id = ? AND player_id = ?').get(momentId, playerId) as
      { author_type: string; author_id: string } | undefined;
    if (!moment) {
      return reply.code(404).send({ error: '帖子不存在' });
    }

    // 检查是否已点赞
    const existing = db.prepare(`
      SELECT id FROM moment_interactions
      WHERE moment_id = ? AND author_id = ? AND author_type = 'player' AND interaction_type = 'like'
    `).get(momentId, playerId) as { id: string } | undefined;

    if (existing) {
      // 取消点赞
      db.prepare('DELETE FROM moment_interactions WHERE id = ?').run(existing.id);
      return reply.send({ ok: true, liked: false });
    }

    // 点赞NPC帖子 → 清零该NPC的朋友圈意愿
    if (moment.author_type === 'character') {
      resetMomentUrge(playerId, moment.author_id);
    }

    const interactionId = genId();
    db.prepare(`
      INSERT INTO moment_interactions (id, moment_id, author_type, author_id, interaction_type, body, created_at)
      VALUES (?, ?, 'player', ?, 'like', '', ?)
    `).run(interactionId, momentId, playerId, now());

    return reply.send({ ok: true, liked: true });
  });

  // ─── 删除自己的帖子 ────────────────────────────────────
  app.delete('/moments/:momentId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { momentId } = req.params as { momentId: string };
    const moment = db.prepare('SELECT author_type, author_id FROM moments WHERE id = ? AND player_id = ?').get(momentId, playerId) as
      { author_type: string; author_id: string } | undefined;
    if (!moment) {
      return reply.code(404).send({ error: '帖子不存在' });
    }
    // 只有玩家能删自己的帖子
    if (moment.author_type !== 'player' || moment.author_id !== playerId) {
      return reply.code(403).send({ error: '只能删除自己的帖子' });
    }

    db.prepare('DELETE FROM moments WHERE id = ?').run(momentId);
    return reply.send({ ok: true });
  });
}

// ════════════════════════════════════════════════════════════
// NPC发帖 + NPC评论 — 供其他模块调用的导出函数
// ════════════════════════════════════════════════════════════

/**
 * NPC发朋友圈帖子
 *
 * @param playerId 玩家ID（酒馆模式：帖子出现在该玩家的feed中）
 * @param characterId NPC ID
 * @param triggerType 触发原因：date_end / mission_end / schedule / random
 * @param contextHint 上下文提示（如"刚和玩家在咖啡馆约会结束"），帮助LLM生成有内容的朋友圈
 */
export async function generateNpcMoment(
  playerId: string,
  characterId: string,
  triggerType: string,
  contextHint: string,
): Promise<string | null> {
  const characterData = loadCharacterData(playerId, characterId);
  if (!characterData) return null;

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as
    { player_description: string; created_at: number } | undefined;

  const ctx: PromptContext = {
    characterData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: [],
    isTextMessage: true,
    isDeity: false,
    hubLocations: getHubLocationsText(),
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = `（你正在发一条朋友圈。${contextHint}

写一条符合你性格的朋友圈动态——就像你真的打开了朋友圈随手发了一条。
可以是一时感慨、生活分享、吐槽、晒一下什么、或者只是一句没头没尾的话。
不要长篇大论，朋友圈就是几句话的东西。
不要@任何人，不要用 hashtag。
把朋友圈正文放在 messages 数组里，internal 留空即可。）`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    let content = '';
    for (let attempt = 0; attempt < 2 && !content; attempt++) {
      const result = await chat(messages, { temperature: attempt === 0 ? 0.9 : 1.0, maxTokens: 512, guidedJson: REPLY_SCHEMA, playerId });
      const parsed = tryParseJsonReply(result.content);
      if (parsed?.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
        content = String(parsed.messages[0]).trim();
      } else if (typeof parsed?.internal === 'string' && parsed.internal.trim()) {
        // LLM把内容放到了internal字段，fallback提取
        content = parsed.internal.trim();
      }
    }
    if (!content) return null;

    // 获取NPC当前位置（行程系统，与地图同一数据源）
    let locationName = '';
    const schedule = getCurrentSchedule(playerId, characterId, characterData as any, now());
    if (schedule) {
      // 自己家 → 说"家"，否则用行程地点名
      const isHome = db.prepare('SELECT 1 FROM scene_homes WHERE location_id = ? AND character_id = ?').get(schedule.locationId, characterId);
      locationName = isHome ? '家' : schedule.locationName;
    }

    const momentId = genId();
    db.prepare(`
      INSERT INTO moments (id, player_id, author_type, author_id, content, mood, location_name, trigger_type, created_at)
      VALUES (?, ?, 'character', ?, ?, '', ?, ?, ?)
    `).run(momentId, playerId, characterId, content, locationName, triggerType, now());

    // 存入记忆——朋友圈内容可被语义检索
    const memText = `${getCharacterName(characterId)}发了朋友圈：${content}${locationName ? `（在${locationName}）` : ''}`;
    const memVec = await embed(memText);
    if (memVec) {
      storeEmbedding(playerId, characterId, 'moment', momentId, memText, memVec);
    }

    return momentId;
  } catch {
    return null;
  }
}

/**
 * 玩家发帖后，异步触发好友NPC评论
 *
 * 逻辑：
 * - 获取玩家的所有好友NPC
 * - 每个NPC有一定概率"刷到"并评论（不是每个都评）
 * - 评论由各自characterData驱动，走LLM生成
 * - 评论有延迟感（不需要立刻全部出现，可以分批）
 */
async function triggerNpcComments(playerId: string, momentId: string, momentContent: string, momentImagePath?: string): Promise<void> {
  // 获取好友列表
  const friends = db.prepare(`
    SELECT character_id FROM friendships
    WHERE player_id = ? AND status = 'active'
  `).all(playerId) as Array<{ character_id: string }>;

  if (friends.length === 0) return;

  // 每个好友有概率评论（50%），模拟"刷到了但不一定评论"
  // 至少1个NPC评论（如果只有一个好友则100%评论）
  const commentingFriends = friends.filter(() => friends.length === 1 || Math.random() < 0.5);
  if (commentingFriends.length === 0 && friends.length > 0) {
    // 确保至少一个评论
    commentingFriends.push(friends[0]!);
  }

  for (const friend of commentingFriends) {
    try {
      const comment = await generateNpcComment(playerId, friend.character_id, momentContent, 'player', playerId, momentId, momentImagePath);
      if (comment) {
        const commentId = genId();
        db.prepare(`
          INSERT INTO moment_interactions (id, moment_id, author_type, author_id, interaction_type, body, created_at)
          VALUES (?, ?, 'character', ?, 'comment', ?, ?)
        `).run(commentId, momentId, friend.character_id, comment, now());

        // 存入记忆——NPC评论可被语义检索
        const memText = `${getCharacterName(friend.character_id)}评论了玩家的朋友圈（"${momentContent.slice(0,30)}"）：${comment}`;
        const memVec = await embed(memText);
        if (memVec) {
          storeEmbedding(playerId, friend.character_id, 'moment', commentId, memText, memVec);
        }
      }
    } catch {
      // 单个NPC评论失败不影响其他
    }
  }
}

/**
 * NPC评论帖子
 *
 * @param playerId 玩家ID
 * @param characterId NPC ID
 * @param postContent 帖子内容
 * @param postAuthorType 帖子作者类型（'player'或'character'）
 * @param postAuthorId 帖子作者ID
 * @param momentId 帖子ID（可选，用于获取已有评论作为上下文）
 */
async function generateNpcComment(
  playerId: string,
  characterId: string,
  postContent: string,
  postAuthorType: string,
  postAuthorId: string,
  momentId?: string,
  postImagePath?: string,
): Promise<string | null> {
  const characterData = loadCharacterData(playerId, characterId);
  if (!characterData) return null;

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as
    { player_description: string; created_at: number } | undefined;

  // 获取已有评论作为上下文（避免NPC重复说同样的话）
  let existingComments = '';
  if (momentId) {
    const comments = db.prepare(`
      SELECT author_id, author_type, body FROM moment_interactions
      WHERE moment_id = ? AND interaction_type = 'comment'
      ORDER BY created_at ASC
    `).all(momentId) as Array<{ author_id: string; author_type: string; body: string }>;
    if (comments.length > 0) {
      existingComments = comments.map(c => {
        const name = c.author_type === 'character' ? getCharacterName(c.author_id) : '玩家';
        return `${name}：${c.body}`;
      }).join('\n');
    }
  }

  const ctx: PromptContext = {
    characterData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: [],
    isTextMessage: true,
    isDeity: false,
    hubLocations: getHubLocationsText(),
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx);
  const postAuthor = postAuthorType === 'player' ? '玩家' : getCharacterName(postAuthorId);
  const userPrompt = `（你在刷朋友圈，看到了${postAuthor}发的一条动态：

"${postContent}"

${existingComments ? `已有评论：\n${existingComments}\n` : ''}
${postImagePath ? '（这条动态附带了一张图片，请结合图片内容评论）' : ''}
你随手评论了一句。符合你的性格和发短信的习惯——简短、随意。
如果你和发帖人关系好，语气可以亲昵一点；如果不太熟，客气一些。
不要重复别人已经说过的话。把评论内容放在 messages 数组里，internal 留空即可。）`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt, imagePath: postImagePath },
  ];

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await chat(messages, { temperature: attempt === 0 ? 0.85 : 0.95, maxTokens: 512, guidedJson: REPLY_SCHEMA, playerId });
      const parsed = tryParseJsonReply(result.content);
      if (parsed?.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) {
        return String(parsed.messages[0]).trim() || null;
      }
      if (typeof parsed?.internal === 'string' && parsed.internal.trim()) {
        return parsed.internal.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * NPC回复玩家对自己帖子的评论
 */
async function triggerNpcReplyToComment(
  playerId: string,
  momentId: string,
  characterId: string,
  playerComment: string,
): Promise<void> {
  const comment = await generateNpcComment(
    playerId,
    characterId,
    playerComment,
    'player',
    playerId,
    momentId,
  );
  if (comment) {
    const commentId = genId();
    db.prepare(`
      INSERT INTO moment_interactions (id, moment_id, author_type, author_id, interaction_type, body, created_at)
      VALUES (?, ?, 'character', ?, 'comment', ?, ?)
    `).run(commentId, momentId, characterId, comment, now());

    // 存入记忆——NPC回复评论可被语义检索
    const memText = `${getCharacterName(characterId)}在朋友圈回复了玩家：${comment}`;
    const memVec = await embed(memText);
    if (memVec) {
      storeEmbedding(playerId, characterId, 'moment', commentId, memText, memVec);
    }
  }
}


/**
 * NPC给自己的帖子点赞（随机触发，给朋友圈增加生气感）
 */
export async function maybeNpcLikeMoment(playerId: string, momentId: string, characterId: string): Promise<void> {
  // 30%概率点赞
  if (Math.random() > 0.3) return;

  // 检查是否已点赞
  const existing = db.prepare(`
    SELECT id FROM moment_interactions
    WHERE moment_id = ? AND author_id = ? AND author_type = 'character' AND interaction_type = 'like'
  `).get(momentId, characterId) as { id: string } | undefined;
  if (existing) return;

  db.prepare(`
    INSERT INTO moment_interactions (id, moment_id, author_type, author_id, interaction_type, body, created_at)
    VALUES (?, ?, 'character', ?, 'like', '', ?)
  `).run(genId(), momentId, characterId, now());
}
