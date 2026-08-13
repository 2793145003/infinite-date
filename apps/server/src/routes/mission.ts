/**
 * 任务路由
 * Phase 4: 世界任务闭环
 *
 * 流程：
 * 1. 系统生成世界任务（LLM生成原创世界+执念物品）
 * 2. 玩家在待办页看到任务，选择接受+选好友NPC同行
 * 3. 接受后自动创建约会session（注入世界设定）
 * 4. 约会结束 → 评级器LLM判断三级评估 → 权限奖励
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { getActiveLiveSlot } from '../lib/session-mutex';
import { genId, now, jsonParse } from '../lib/util';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { getPlayerProfile, formatCharacterCard, generateReply } from '../prompt/builder';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import { sendEmail } from './email';
import { grantPlayerPermission, ensurePlayerWallet } from '../lib/permission';
import { getCosts } from '../lib/permission-config';
import { loadCharacterData } from '../lib/character';

interface MissionRow {
  id: string;
  player_id: string;
  quest_type: string;
  assignee_type: string;
  assignee_id: string;
  character_id: string | null;
  character_instance_id: string | null;
  world_id: string | null;
  title: string;
  description: string;
  status: string;
  reward: number;
  evaluation_result: string | null;
  rating_score: number | null;
  metadata: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface WorldGenResult {
  name: string;
  summary: string;
  tone: string;
  rules: string;
  lore: string;
  item: string;
  obsession: string;
  briefing: string;
  landmarks: { name: string; feature: string }[];
  minor_characters: { name: string; trait: string }[];
  world_tension: string;
  mission_hook: string;
  twist_seed: string;
}

export async function missionRoutes(app: FastifyInstance): Promise<void> {

  // ─── 生成世界任务 ───────────────────────────────────
  // 系统生成原创世界 + 执念物品，创建mission记录
  // 触发方式：玩家点击"寻找任务"或系统随机触发（当前MVP: 手动触发）
  app.post('/missions/generate', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 检查是否已有available/active的任务（同时只持有一个世界任务）
    const existing = db.prepare(`
      SELECT id FROM missions
      WHERE player_id = ? AND quest_type = 'world' AND status IN ('available', 'active')
    `).get(playerId) as { id: string } | undefined;

    if (existing) {
      return reply.code(409).send({ error: '已有进行中或待接受的世界任务', missionId: existing.id });
    }

    // LLM 生成世界
    const worldPrompt = loadPrompt('mission.worldgen');
    const genMessages: ChatMessage[] = [
      { role: 'system', content: worldPrompt },
      { role: 'user', content: '生成一个世界任务的设定。' },
    ];

    let worldData: WorldGenResult;
    try {
      const result = await chat(genMessages, {
        temperature: 0.9,
        maxTokens: 2048,
        guidedJson: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            summary: { type: 'string' },
            tone: { type: 'string' },
            rules: { type: 'string' },
            lore: { type: 'string' },
            item: { type: 'string' },
            obsession: { type: 'string' },
            briefing: { type: 'string' },
            landmarks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  feature: { type: 'string' },
                },
                required: ['name', 'feature'],
              },
            },
            minor_characters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  trait: { type: 'string' },
                },
                required: ['name', 'trait'],
              },
            },
            world_tension: { type: 'string' },
            mission_hook: { type: 'string' },
            twist_seed: { type: 'string' },
          },
          required: ['name', 'summary', 'tone', 'rules', 'lore', 'item', 'obsession', 'briefing', 'landmarks', 'minor_characters', 'world_tension', 'mission_hook', 'twist_seed'],
        },
      });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed) throw new Error('世界生成解析失败');
      worldData = parsed as unknown as WorldGenResult;
    } catch (err) {
      app.log.error({ err }, '世界任务生成失败');
      return reply.code(502).send({ error: '世界生成失败，请重试' });
    }

    // 写入 worlds 表
    const worldId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO worlds (id, name, summary, tone, rules, lore, world_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'mission', ?, ?)
    `).run(worldId, worldData.name, worldData.summary, worldData.tone, worldData.rules, worldData.lore, ts, ts);

    // 写入 missions 表
    const missionId = genId();
    const missionMetadata = JSON.stringify({
      item: worldData.item,
      obsession: worldData.obsession,
      briefing: worldData.briefing,
      landmarks: worldData.landmarks ?? [],
      minor_characters: worldData.minor_characters ?? [],
      world_tension: worldData.world_tension ?? '',
      mission_hook: worldData.mission_hook ?? '',
      twist_seed: worldData.twist_seed ?? '',
    });
    db.prepare(`
      INSERT INTO missions (id, player_id, quest_type, assignee_type, assignee_id, character_id, world_id, title, description, status, reward, metadata, created_at)
      VALUES (?, ?, 'world', 'player', ?, NULL, ?, ?, ?, 'available', ?, ?, ?)
    `).run(missionId, playerId, playerId, worldId, `回收：${worldData.item}`, worldData.briefing, getCosts().mission_base_reward, missionMetadata, ts);

    // 发邮件通知
    sendEmail(playerId, 'system', '新任务：世界任务', worldData.briefing);

    return reply.send({
      missionId,
      world: {
        id: worldId,
        name: worldData.name,
        summary: worldData.summary,
        tone: worldData.tone,
        briefing: worldData.briefing,
        item: worldData.item,
        obsession: worldData.obsession,
      },
    });
  });

  // ─── 获取任务列表 ───────────────────────────────────
  app.get('/missions', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const missions = db.prepare(`
      SELECT m.*, w.name as world_name
      FROM missions m
      LEFT JOIN worlds w ON m.world_id = w.id
      WHERE m.player_id = ?
      ORDER BY m.created_at DESC
    `).all(playerId) as unknown as Array<MissionRow & { world_name: string | null }>;

    const result = missions.map(m => {
      const meta = jsonParse<{
        item?: string; obsession?: string; briefing?: string;
        landmarks?: { name: string; feature: string }[];
        minor_characters?: { name: string; trait: string }[];
        world_tension?: string;
        mission_hook?: string;
        twist_seed?: string;
      }>(m.metadata, {});
      return {
        id: m.id,
        questType: m.quest_type,
        status: m.status,
        title: m.title,
        description: m.description,
        reward: m.reward,
        worldName: m.world_name,
        item: meta.item,
        obsession: meta.obsession,
        briefing: meta.briefing,
        landmarks: meta.landmarks ?? [],
        minorCharacters: meta.minor_characters ?? [],
        worldTension: meta.world_tension ?? '',
        missionHook: meta.mission_hook ?? '',
        twistSeed: meta.twist_seed ?? '',
        characterId: m.character_id,
        evaluationResult: m.evaluation_result ? jsonParse(m.evaluation_result, null) : null,
        ratingScore: m.rating_score,
        createdAt: m.created_at,
        startedAt: m.started_at,
        completedAt: m.completed_at,
      };
    });

    return reply.send({ missions: result });
  });

  // ─── 接受任务 + 选同伴 + 开始 ────────────────────────
  app.post('/missions/:missionId/accept', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { missionId } = req.params as { missionId: string };
    const { companionId } = req.body as { companionId?: string };

    const mission = db.prepare(`
      SELECT * FROM missions WHERE id = ? AND player_id = ? AND quest_type = 'world'
    `).get(missionId, playerId) as unknown as MissionRow | undefined;

    if (!mission) {
      return reply.code(404).send({ error: '任务不存在' });
    }
    if (mission.status !== 'available') {
      return reply.code(400).send({ error: '任务状态不允许接受' });
    }
    if (!companionId) {
      return reply.code(400).send({ error: '需要选择同行NPC' });
    }

    // 验证同伴是好友
    const isFriend = db.prepare(`
      SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = 'active'
    `).get(playerId, companionId);
    if (!isFriend) {
      return reply.code(400).send({ error: '只能选好友NPC同行' });
    }

    // 全局现场互斥：人只有一个，同一时间只能"在场"于一个玩法现场。
    const live = getActiveLiveSlot(playerId);
    if (live) {
      return reply.code(409).send({ error: '已有进行中的现场', live });
    }

    // 获取世界设定
    const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(mission.world_id) as {
      id: string; name: string; summary: string; tone: string; rules: string; lore: string;
    } | undefined;
    if (!world) {
      return reply.code(500).send({ error: '世界数据缺失' });
    }

    const meta = jsonParse<{ item: string; obsession: string; briefing: string;
      landmarks?: { name: string; feature: string }[];
      minor_characters?: { name: string; trait: string }[];
      world_tension?: string; mission_hook?: string; twist_seed?: string;
    }>(mission.metadata, { item: '', obsession: '', briefing: '' });

    // 更新任务状态
    const ts = now();
    db.prepare(`
      UPDATE missions SET status = 'active', character_id = ?, started_at = ? WHERE id = ?
    `).run(companionId, ts, missionId);

    // 创建约会session，绑定mission_id
    const sessionId = genId();
    db.prepare(`
      INSERT INTO conversation_sessions (id, player_id, character_id, location_id, mode, summary, ended, mission_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'mission', '', 0, ?, ?, ?)
    `).run(sessionId, playerId, companionId, missionId, ts, ts);

    // 确保relationship存在
    const existingRel = db.prepare('SELECT id FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, companionId);
    if (!existingRel) {
      db.prepare(`
        INSERT INTO relationships (id, player_id, character_id, player_description, updated_at, created_at)
        VALUES (?, ?, ?, '刚认识的陌生人', ?, ?)
      `).run(genId(), playerId, companionId, ts, ts);
    }

    // 生成NPC开场白 — NPC和玩家一起到达任务世界
    let greeting: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null = null;
    try {
      greeting = await generateMissionGreeting(sessionId, playerId, companionId, world, meta);
    } catch (err) {
      app.log.error({ err }, '任务greeting生成失败');
    }

    if (greeting) {
      // 先存环境旁白（role='narration'，时间戳最早）
      if (greeting.environment) {
        db.prepare(`
          INSERT INTO messages (id, session_id, role, text, metadata, internal, internal_notable, internal_viewed, created_at)
          VALUES (?, ?, 'narration', ?, '{}', '', 0, 0, ?)
        `).run(genId(), sessionId, greeting.environment, now());
      }
      for (let i = 0; i < greeting.messages.length; i++) {
        const msg = greeting.messages[i]!;
        const internal = i === 0 ? greeting.internal : '';
        const internalNotable = i === 0 && greeting.internal_notable ? 1 : 0;
        db.prepare(`
          INSERT INTO messages (id, session_id, role, text, metadata, internal, internal_notable, internal_viewed, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', ?, ?, 0, ?)
        `).run(genId(), sessionId, msg, internal, internalNotable, now());
      }
      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
    }

    return reply.send({
      sessionId,
      greeting: greeting ? {
        environment: greeting.environment,
        messages: greeting.messages,
        internal: greeting.internal,
        internal_notable: greeting.internal_notable,
      } : null,
    });
  });

  // ─── 拒绝任务 ───────────────────────────────────────
  app.post('/missions/:missionId/decline', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { missionId } = req.params as { missionId: string };
    const mission = db.prepare(`
      SELECT status FROM missions WHERE id = ? AND player_id = ?
    `).get(missionId, playerId) as { status: string } | undefined;

    if (!mission) {
      return reply.code(404).send({ error: '任务不存在' });
    }
    if (mission.status !== 'available') {
      return reply.code(400).send({ error: '任务状态不允许拒绝' });
    }

    db.prepare("UPDATE missions SET status = 'declined' WHERE id = ?").run(missionId);
    return reply.send({ ok: true });
  });

  // ─── 获取好友列表（选同伴用） ────────────────────────
  app.get('/missions/friends', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const friends = db.prepare(`
      SELECT f.character_id, 
             COALESCE(
               (SELECT json_extract(character_data, '$.name') FROM characters WHERE id = f.character_id),
               (SELECT json_extract(character_data, '$.name') FROM character_player_data WHERE id = f.character_id)
             ) as name
      FROM friendships f
      WHERE f.player_id = ? AND f.status = 'active'
      ORDER BY f.created_at
    `).all(playerId) as Array<{ character_id: string; name: string | null }>;

    return reply.send({
      friends: friends.map(f => ({ characterId: f.character_id, name: f.name ?? '未知' })),
    });
  });
}

// ─── 任务开场白 ─────────────────────────────────────────

export async function generateMissionGreeting(
  sessionId: string,
  playerId: string,
  characterId: string,
  world: { id: string; name: string; summary: string; tone: string; rules: string; lore: string },
  missionMeta: { item: string; obsession: string; briefing: string;
    landmarks?: { name: string; feature: string }[];
    minor_characters?: { name: string; trait: string }[];
    world_tension?: string; mission_hook?: string; twist_seed?: string;
  },
) {
  // 获取角色数据
  let characterName = '';
  const characterData = loadCharacterData(playerId, characterId);
  if (characterData) {
    characterName = characterData.name ?? '';
  }

  const rel = db.prepare('SELECT player_description FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string } | undefined;

  const worldContext = `【任务世界】
世界：${world.name}
环境：${world.summary}
氛围：${world.tone}
${world.rules ? `规则：${world.rules}\n` : ''}背景：${world.lore}
任务目标：回收"${missionMeta.item}"
执念背景：${missionMeta.obsession}
${missionMeta.world_tension ? `\n世界现状：${missionMeta.world_tension}` : ''}
${missionMeta.landmarks?.length ? `\n世界地标（可在对话中提及或前往）：\n${missionMeta.landmarks.map((l: { name: string; feature: string }) => `· ${l.name}：${l.feature}`).join('\n')}` : ''}
${missionMeta.minor_characters?.length ? `\n世界居民（探索时可能偶遇）：\n${missionMeta.minor_characters.map((c: { name: string; trait: string }) => `· ${c.name}：${c.trait}`).join('\n')}` : ''}
${missionMeta.twist_seed ? `\n转折伏笔（在合适时机自然引出，不要急于揭露）：${missionMeta.twist_seed}` : ''}
${missionMeta.mission_hook ? `\n开局场景：${missionMeta.mission_hook}` : ''}`;

  // 角色卡完整注入（与普通约会/群聊共用 character-card.txt 模板）
  const characterCard = characterData ? formatCharacterCard(characterData) : '';

  const systemPrompt = `你是${characterName}。你和玩家一起被系统派来执行世界任务，刚刚抵达${world.name}。

${worldContext}

${characterCard}

【玩家信息】
${getPlayerProfile(playerId)}

【你对玩家的印象】
${rel?.player_description ?? '刚认识的陌生人'}

你们刚刚到达这个世界的入口。玩家就在你身边。

首先，用旁白视角描写环境和周围情况——你们看到的景象、听到的声音、感受到的氛围。这段描写要沉浸感强，有画面感，2-4句话。

然后，按照你的性格，对眼前的景象做出反应，对玩家说第一句话。

【写作要求】
每条回复都要有身体语言——表情变化、肢体动作、与环境的互动、和玩家之间的物理距离感。用（括号）包裹动作描写，穿插在台词之间，不要全堆在开头或结尾。
动作描写省略主语，不写"我"——直接写动作本身（如"唇角微微抿出弧度"而非"我唇角微微抿出弧度"）。

【输出格式】
JSON：{"environment": "环境旁白描写", "messages": ["第一句话"], "internal": "内心独白", "internal_notable": false, "player_description": "印象", "item_obtained": null, "scene_concluded": false}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `（你和玩家刚刚穿越到${world.name}的入口。眼前是一片陌生的景象。你自然地开口——可能是感慨，可能是观察，可能是对玩家说点什么。按照你的性格反应。）` },
  ];

  try {
    const reply = await generateReply(messages, { temperature: 0.85, maxTokens: 1024 });
    return {
      environment: reply.environment ?? '',
      messages: reply.messages,
      internal: reply.internal,
      internal_notable: reply.internal_notable,
    };
  } catch {
    return { environment: '', messages: ['……'], internal: '', internal_notable: false };
  }
}

// ─── 世界任务评级（约会结束时调用） ─────────────────────

export async function evaluateWorldMission(
  missionId: string,
  playerId: string,
  sessionId: string,
  worldId: string,
): Promise<void> {
  const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as unknown as MissionRow | undefined;
  if (!mission) return;

  const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId) as {
    name: string; summary: string; tone: string; rules: string; lore: string;
  } | undefined;
  if (!world) return;

  const meta = jsonParse<{ item: string; obsession: string; briefing: string }>(mission.metadata, { item: '', obsession: '', briefing: '' });

  // 获取对话记录（截断：头5条+尾20条，防止超出模型上下文窗口）
  const allMessages = db.prepare(`
    SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId) as Array<{ role: string; text: string }>;

  const formatMsg = (m: { role: string; text: string }) => {
    const speaker = m.role === 'player' ? '玩家' : m.role === 'quest_npc' ? '执念持有者' : m.role === 'narration' ? '旁白' : 'NPC';
    return `${speaker}：${m.text}`;
  };

  let conversationText: string;
  if (allMessages.length <= 30) {
    conversationText = allMessages.map(formatMsg).join('\n');
  } else {
    const head = allMessages.slice(0, 5).map(formatMsg);
    const tail = allMessages.slice(-20).map(formatMsg);
    conversationText = [...head, `……（省略${allMessages.length - 25}条中间对话）……`, ...tail].join('\n');
  }

  // 调用评级LLM
  const evalPrompt = loadPrompt('mission.evaluator');
  const filledPrompt = renderPrompt(evalPrompt, {
    world_name: world.name,
    item: meta.item,
    obsession: meta.obsession,
    conversation: conversationText,
  });

  const evalMessages: ChatMessage[] = [
    { role: 'system', content: filledPrompt },
    { role: 'user', content: '请评估。' },
  ];

  let evaluation: { item_obtained: boolean; obsession_resolved: boolean; cooperation_quality: string; summary: string };
  try {
    const result = await chat(evalMessages, {
      temperature: 0.3,
      maxTokens: 512,
      guidedJson: {
        type: 'object',
        properties: {
          item_obtained: { type: 'boolean' },
          obsession_resolved: { type: 'boolean' },
          cooperation_quality: { type: 'string', enum: ['poor', 'decent', 'excellent'] },
          summary: { type: 'string' },
        },
        required: ['item_obtained', 'obsession_resolved', 'cooperation_quality', 'summary'],
      },
    });
    const parsed = tryParseJsonReply(result.content);
    if (!parsed) throw new Error('评级解析失败');
    evaluation = parsed as unknown as typeof evaluation;
  } catch (err) {
    console.error('世界任务评级失败，使用fallback评级:', err);
    // Fallback：根据mission状态推断结果
    // 如果任务已被标记为completed（item_obtained在对话中触发过），给基础评级
    const missionCurrent = db.prepare('SELECT status FROM missions WHERE id = ?').get(missionId) as { status: string } | undefined;
    if (missionCurrent?.status === 'completed') {
      evaluation = {
        item_obtained: true,
        obsession_resolved: false,
        cooperation_quality: 'decent',
        summary: '任务完成（评级器异常，使用默认评级）。',
      };
    } else {
      evaluation = {
        item_obtained: false,
        obsession_resolved: false,
        cooperation_quality: 'poor',
        summary: '任务未完成（评级器异常，使用默认评级）。',
      };
    }
  }

  // 计算评级得分和权限
  const costs = getCosts();
  let ratingScore = 0;
  let totalReward = 0;

  if (evaluation.item_obtained) {
    ratingScore = 1; // 基础
    totalReward = costs.mission_base_reward;

    if (evaluation.obsession_resolved) {
      ratingScore = 2;
      totalReward += costs.mission_obsession_bonus;
    }

    const coopBonus = costs.mission_coop_bonus[evaluation.cooperation_quality as keyof typeof costs.mission_coop_bonus] ?? 0;
    if (evaluation.cooperation_quality === 'excellent') {
      ratingScore = 3;
    }
    totalReward += coopBonus;
  } else {
    // 任务失败
    ratingScore = 0;
    totalReward = 0;
  }

  // 写入评级结果（原子抢占：evaluation_result 为空才写，changes=0 = 已被其它并发评级写过 → 不发奖）
  // 并发安全：两批 evaluate 同时跑，只有首位写入 evaluation_result 的那批会发奖，另一批 changes=0 静默跳过，杜绝重复发权限。
  const ts = now();
  const claim = db.prepare(`
    UPDATE missions 
    SET status = 'completed', evaluation_result = ?, rating_score = ?, completed_at = ?
    WHERE id = ? AND evaluation_result IS NULL
  `).run(JSON.stringify(evaluation), ratingScore, ts, missionId);

  // 发放权限（仅首位完成评级写入的调用发放；重复调用 changes=0 跳过）
  if (totalReward > 0 && claim.changes === 1) {
    ensurePlayerWallet(playerId);
    grantPlayerPermission(playerId, totalReward, 'mission_reward', missionId);

    // NPC同伴也获得权限
    if (mission.character_id) {
      try {
        const instance = db.prepare(`
          SELECT character_instance_id FROM character_instances 
          WHERE player_id = ? AND character_id = ? AND is_active = 1
        `).get(playerId, mission.character_id) as { character_instance_id: string } | undefined;

        if (instance) {
          grantCharacterPermission(playerId, mission.character_id, instance.character_instance_id, totalReward, 'mission_reward', missionId);
        }
      } catch { /* NPC权限失败不阻塞 */ }
    }
  }

  // 更新玩家rating_score（加权平均）
  const player = db.prepare('SELECT rating_score FROM players WHERE id = ?').get(playerId) as { rating_score: number } | undefined;
  if (player) {
    // 简单加权：新评分 = 旧评分 * 0.7 + 本次评分 * 0.3
    const newRating = player.rating_score * 0.7 + ratingScore * 0.3;
    db.prepare('UPDATE players SET rating_score = ?, updated_at = ? WHERE id = ?').run(newRating, ts, playerId);
  }

  // 发邮件通知结果
  const resultText = evaluation.item_obtained
    ? `任务完成！\n\n评级：${'★'.repeat(ratingScore)}${'☆'.repeat(3 - ratingScore)}\n${evaluation.summary}\n\n权限奖励：+${totalReward}`
    : `任务未完成。\n\n${evaluation.summary}\n\n物品未回收，无权限奖励。`;
  sendEmail(playerId, 'system', `任务结果：${mission.title}`, resultText);
}

/** NPC权限发放 */
function grantCharacterPermission(
  playerId: string,
  characterId: string,
  instanceId: string,
  amount: number,
  reason: string,
  sourceId?: string,
): void {
  const ts = now();
  // 确保NPC钱包存在
  db.prepare(`
    INSERT OR IGNORE INTO character_permissions (player_id, character_id, character_instance_id, balance, total_earned, total_spent, updated_at)
    VALUES (?, ?, ?, 0, 0, 0, ?)
  `).run(playerId, characterId, instanceId, ts);

  const row = db.prepare('SELECT balance, total_earned FROM character_permissions WHERE player_id = ? AND character_id = ? AND character_instance_id = ?').get(playerId, characterId, instanceId) as { balance: number; total_earned: number };
  const newBalance = row.balance + amount;
  db.prepare('UPDATE character_permissions SET balance = ?, total_earned = ?, updated_at = ? WHERE player_id = ? AND character_id = ? AND character_instance_id = ?')
    .run(newBalance, row.total_earned + amount, ts, playerId, characterId, instanceId);

  db.prepare(`
    INSERT INTO permission_transactions (id, player_id, character_id, character_instance_id, wallet_type, delta, reason, source_id, balance_after, created_at)
    VALUES (?, ?, ?, ?, 'character', ?, ?, ?, ?, ?)
  `).run(genId(), playerId, characterId, instanceId, amount, reason, sourceId ?? null, newBalance, ts);
}
