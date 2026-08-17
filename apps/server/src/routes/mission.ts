/**
 * 任务路由
 * Phase 4: 世界任务闭环
 *
 * 流程：
 * 1. 系统起卦（玩家ID+时辰+任务序号）→ 生成原创世界任务（卦象驱动 worldgen）
 * 2. 玩家在待办页看到任务，选择接受+选好友NPC同行
 * 3. 接受后建独立任务地图（世界NPC为路人）+ scene_session（scene_type='mission'）
 * 4. 任务推进 → 数值判定（困境浓度→目标态）→ 结束 → 评级发奖
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { getActiveLiveSlot } from '../lib/session-mutex';
import { genId, now, jsonParse } from '../lib/util';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import { sendEmail } from './email';
import { grantPlayerPermission, ensurePlayerWallet } from '../lib/permission';
import { getCosts } from '../lib/permission-config';
import { castHexagram, renderHexagramLayer, renderNajiaLayer } from '../lib/hexagram-prompt';
import { rollTheme, renderThemeGuide, rollGoal, renderGoalGuide } from '../lib/world-theme';
import { rollWorldCards, renderWorldCards } from '../lib/name-pool';
import { ensureSceneSession } from '../lib/scene-session';
import { ensureSceneMap, type SceneNpc } from '../lib/scene-map';
import { endSceneSession } from '../lib/scene-end';

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
  world_tension: string;
  target_state: string;
  hidden_thread: string;
  briefing: string;
  descend_identity: { player: string; male_lead: string };
  landmarks: { name: string; feature: string }[];
  world_npcs: { role: string; name: string; persona: string; place?: string; knows?: number[] }[];
  clues?: { id: number; content: string }[];
  environmental_clues?: string[];
  mission_hook: string;
  twist_seed: string;
  goal_path?: string;
  mission_goal: string;
}

interface StatsConfigItem {
  name: string;
  initial: number;
  rules: string;
  target?: number | null;
}

interface BuiltMission {
  missionId: string;
  world: {
    id: string;
    name: string;
    summary: string;
    tone: string;
    briefing: string;
    worldTension: string;
    targetState: string;
    hexagram: string;
  };
}

/**
 * 生成一个世界任务（起卦 → LLM 生成世界 → 写库）。
 * 供 generate（同步，待办页摇卦后生成）和 prepare（异步，首页成卦瞬间预生成）复用。
 * @param existingMissionId 传了则 UPDATE 该占位任务（preparing → available），否则 INSERT 新任务。
 */
async function buildWorldMission(playerId: string, cast?: number[], existingMissionId?: string): Promise<BuiltMission> {
  // 起卦：seed = 玩家ID + 时辰 + quest_type + 该玩家任务序号（确定性）
  const seq = (db.prepare(
    `SELECT COUNT(*) as c FROM missions WHERE player_id = ? AND quest_type = 'world'`
  ).get(playerId) as { c: number }).c;
  const div = castHexagram(playerId, 'world', seq, cast ? { cast } : undefined);

  // 基调 + 玩法 + 命名卡：和卦象同 seed 机制，确定性 roll（同玩家连续生成轮换不重复）
  const theme = rollTheme(playerId, seq);
  const goal = rollGoal(playerId, seq);
  const cards = rollWorldCards(playerId, seq, theme);

  // LLM 生成世界（注入卦象层 + 纳甲层 + 基调 + 玩法 + 命名卡 + 玩家性别 + 同行者性别约束）
  const playerGender = (db.prepare('SELECT gender FROM players WHERE id = ?').get(playerId) as { gender: string } | undefined)?.gender || '';
  const playerGenderText = playerGender === 'male' ? '男' : playerGender === 'female' ? '女' : '未设定';
  // 同行者性别约束：查玩家好友性别分布，保证生成的身份性别玩家有对应性别的好友可选
  const friendGenders = db.prepare(`
    SELECT COALESCE(
      (SELECT json_extract(character_data, '$.gender') FROM characters WHERE id = f.character_id),
      (SELECT json_extract(character_data, '$.gender') FROM character_player_data WHERE id = f.character_id)
    ) as gender
    FROM friendships f
    WHERE f.player_id = ? AND f.status = 'active'
  `).all(playerId) as Array<{ gender: string | null }>;
  const hasMaleFriend = friendGenders.some(g => !g.gender || g.gender === 'male');
  const hasFemaleFriend = friendGenders.some(g => g.gender === 'female');
  const companionGenderHint = friendGenders.length === 0
    ? '玩家还没有好友同行，同行者性别用中性表述'
    : hasMaleFriend && hasFemaleFriend
      ? '玩家好友里有男有女，同行者可以是男性也可以是女性'
      : hasFemaleFriend
        ? '玩家只有女性好友，同行者必须是女性'
        : '玩家只有男性好友，同行者必须是男性';
  const worldPrompt = renderPrompt(loadPrompt('mission.worldgen'), {
    hexagram_layer: renderHexagramLayer(div),
    najia_layer: renderNajiaLayer(div),
    theme_guide: renderThemeGuide(theme),
    world_cards: renderWorldCards(cards),
    goal_guide: renderGoalGuide(goal),
    player_gender: playerGenderText,
    companion_gender_hint: companionGenderHint,
  });
  const genMessages: ChatMessage[] = [
    { role: 'system', content: worldPrompt },
    { role: 'user', content: '生成一个世界任务的设定。' },
  ];

  let worldData: WorldGenResult;
  try {
    const result = await chat(genMessages, {
      temperature: 0.9,
      maxTokens: 2048,
      playerId,
      guidedJson: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          tone: { type: 'string' },
          rules: { type: 'string' },
          lore: { type: 'string' },
          world_tension: { type: 'string' },
          target_state: { type: 'string' },
          hidden_thread: { type: 'string' },
          briefing: { type: 'string' },
          descend_identity: {
            type: 'object',
            properties: {
              player: { type: 'string' },
              male_lead: { type: 'string' },
            },
            required: ['player', 'male_lead'],
          },
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
          world_npcs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                name: { type: 'string' },
                persona: { type: 'string' },
                knows: { type: 'array', items: { type: 'integer' } },
              },
              required: ['role', 'name', 'persona'],
            },
          },
          mission_hook: { type: 'string' },
          twist_seed: { type: 'string' },
          clues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                content: { type: 'string' },
              },
              required: ['id', 'content'],
            },
          },
          environmental_clues: { type: 'array', items: { type: 'string' } },
          goal_path: { type: 'string' },
          mission_goal: { type: 'string' },
        },
        required: ['name', 'summary', 'tone', 'rules', 'lore', 'world_tension', 'target_state', 'hidden_thread', 'briefing', 'descend_identity', 'landmarks', 'world_npcs', 'mission_hook', 'twist_seed', 'mission_goal'],
      },
    });
    const parsed = tryParseJsonReply(result.content);
    if (!parsed) throw new Error('世界生成解析失败');
    worldData = parsed as unknown as WorldGenResult;
  } catch (err) {
    // 让调用方处理（generate 返回 502；prepare 标记 failed）
    throw err;
  }

  // 写入 worlds 表
  const worldId = genId();
  const ts = now();
  db.prepare(`
    INSERT INTO worlds (id, name, summary, tone, rules, lore, world_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'mission', ?, ?)
  `).run(worldId, worldData.name, worldData.summary, worldData.tone, worldData.rules, worldData.lore, ts, ts);

  // 写入 missions 表
  const missionId = existingMissionId ?? genId();
  // 进度由代码定：只有破案玩法有数值进度，且 = 已揭示线索数（target = 线索条数）；其他玩法无数值进度。
  const cluesArr = worldData.clues ?? [];
  const progress = goal === '破案' && cluesArr.length > 0
    ? { name: '已揭示线索', initial: 0, target: cluesArr.length }
    : null;
  const missionMetadata = JSON.stringify({
    world_tension: worldData.world_tension ?? '',
    target_state: worldData.target_state ?? '',
    hidden_thread: worldData.hidden_thread ?? '',
    briefing: worldData.briefing ?? '',
    descend_identity: worldData.descend_identity ?? null,
    landmarks: worldData.landmarks ?? [],
    world_npcs: worldData.world_npcs ?? [],
    mission_hook: worldData.mission_hook ?? '',
    twist_seed: worldData.twist_seed ?? '',
    clues: cluesArr,
    environmental_clues: worldData.environmental_clues ?? [],
    goal_path: worldData.goal_path ?? '',
    mission_goal: worldData.mission_goal ?? '',
    progress,
    theme,
    goal,
    // 卦象档案（起卦结果，供复盘/调试 + 首页卦象卡渲染）
    hexagram: {
      seed: div.seed,
      shichen: div.shichen,
      dayGanZhi: div.dayGanZhi,
      ben: div.ben.guaXiang,
      bian: div.bian.guaXiang,
      hu: div.hu.guaXiang,
      dong: div.dong,
      lines: div.lines,
    },
  });
  if (existingMissionId) {
    db.prepare(`
      UPDATE missions
      SET world_id = ?, title = ?, description = ?, status = 'available', reward = ?, metadata = ?, created_at = ?
      WHERE id = ? AND player_id = ?
    `).run(worldId, `世界任务：${worldData.name}`, worldData.briefing ?? '', getCosts().mission_base_reward, missionMetadata, ts, existingMissionId, playerId);
  } else {
    db.prepare(`
      INSERT INTO missions (id, player_id, quest_type, assignee_type, assignee_id, character_id, world_id, title, description, status, reward, metadata, created_at)
      VALUES (?, ?, 'world', 'player', ?, NULL, ?, ?, ?, 'available', ?, ?, ?)
    `).run(missionId, playerId, playerId, worldId, `世界任务：${worldData.name}`, worldData.briefing ?? '', getCosts().mission_base_reward, missionMetadata, ts);
  }

  return {
    missionId,
    world: {
      id: worldId,
      name: worldData.name,
      summary: worldData.summary,
      tone: worldData.tone,
      briefing: worldData.briefing,
      worldTension: worldData.world_tension,
      targetState: worldData.target_state,
      hexagram: div.ben.guaXiang,
    },
  };
}

export async function missionRoutes(app: FastifyInstance): Promise<void> {
  ensureSceneSession();
  ensureSceneMap();

  // ─── 玩家摇卦起卦（纯查表，不 LLM，返回卦象档案供成卦展示）──────
  app.post('/missions/divine', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { cast } = (req.body ?? {}) as { cast?: number[] };
    if (!cast || !Array.isArray(cast) || cast.length !== 6 || cast.some((v) => !Number.isInteger(v) || v < 0 || v > 3)) {
      return reply.code(400).send({ error: '摇卦数据非法：需要 6 爻、每爻 0-3 个"背"' });
    }

    const seq = (db.prepare(
      `SELECT COUNT(*) as c FROM missions WHERE player_id = ? AND quest_type = 'world'`
    ).get(playerId) as { c: number }).c;
    const div = castHexagram(playerId, 'world', seq, { cast });

    return reply.send({
      guaXiang: div.ben.guaXiang, // 卦象名，如"地天泰"
      name: div.ben.name,          // 卦名，如"泰"
      lines: div.lines,            // 六爻阴阳 [0阴1阳，初→上]
      dong: div.dong,              // 动爻位 [1-6]
      shichen: div.shichen,
      dayGanZhi: div.dayGanZhi,
    });
  });

  // ─── 生成世界任务 ───────────────────────────────────
  // 系统生成原创世界 + 执念物品，创建mission记录
  // 触发方式：玩家点击"寻找任务"或系统随机触发（当前MVP: 手动触发）
  app.post('/missions/generate', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 玩家摇出的 6 爻背数（可选；缺失则用确定性 hash fallback）
    const { cast } = (req.body ?? {}) as { cast?: number[] };
    if (cast != null && (!Array.isArray(cast) || cast.length !== 6 || cast.some((v) => !Number.isInteger(v) || v < 0 || v > 3))) {
      return reply.code(400).send({ error: '摇卦数据非法：需要 6 爻、每爻 0-3 个"背"' });
    }

    // 检查是否已有available/active的任务（同时只持有一个世界任务）
    const existing = db.prepare(`
      SELECT id FROM missions
      WHERE player_id = ? AND quest_type = 'world' AND status IN ('available', 'active')
    `).get(playerId) as { id: string } | undefined;

    if (existing) {
      return reply.code(409).send({ error: '已有进行中或待接受的世界任务', missionId: existing.id });
    }

    const built = await buildWorldMission(playerId, cast);
    return reply.send(built);
  });

  // ─── 预生成任务（成卦瞬间异步触发，后台 LLM，不阻塞）──────
  app.post('/missions/prepare', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 玩家摇出的 6 爻背数
    const { cast } = (req.body ?? {}) as { cast?: number[] };
    if (cast == null || !Array.isArray(cast) || cast.length !== 6 || cast.some((v) => !Number.isInteger(v) || v < 0 || v > 3)) {
      return reply.code(400).send({ error: '摇卦数据非法：需要 6 爻、每爻 0-3 个"背"' });
    }

    // 检查是否已有世界任务（available/active/preparing 都算占用）
    const existing = db.prepare(`
      SELECT id, status FROM missions
      WHERE player_id = ? AND quest_type = 'world' AND status IN ('available', 'active', 'preparing')
    `).get(playerId) as { id: string; status: string } | undefined;

    if (existing) {
      return reply.code(409).send({ error: '已有进行中或待接受的世界任务', missionId: existing.id });
    }

    // 起卦取卦名（供前端立即显示卦象）
    const seq = (db.prepare(
      `SELECT COUNT(*) as c FROM missions WHERE player_id = ? AND quest_type = 'world'`
    ).get(playerId) as { c: number }).c;
    const div = castHexagram(playerId, 'world', seq, { cast });

    // 清理旧占位，插入 preparing 占位任务（metadata 存卦象，供前端"生成中"阶段显示）
    db.prepare(`DELETE FROM missions WHERE player_id = ? AND quest_type = 'world' AND status IN ('preparing', 'failed')`).run(playerId);
    const missionId = genId();
    const ts = now();
    const prepMetadata = JSON.stringify({
      hexagram: {
        ben: div.ben.guaXiang,
        bian: div.bian.guaXiang,
        hu: div.hu.guaXiang,
        dong: div.dong,
        lines: div.lines,
      },
    });
    db.prepare(`
      INSERT INTO missions (id, player_id, quest_type, assignee_type, assignee_id, character_id, world_id, title, description, status, reward, metadata, created_at)
      VALUES (?, ?, 'world', 'player', ?, NULL, NULL, ?, '', 'preparing', 0, ?, ?)
    `).run(missionId, playerId, playerId, '任务生成中…', prepMetadata, ts);

    // 后台异步生成（不 await；失败标记 failed，前端检测后点重试）
    void buildWorldMission(playerId, cast, missionId)
      .then(() => {
        app.log.info({ playerId, missionId }, '预生成世界任务成功');
      })
      .catch((err) => {
        app.log.error({ err, playerId, missionId }, '预生成世界任务失败');
        db.prepare(`UPDATE missions SET status = 'failed', description = '生成失败，点此重试' WHERE id = ? AND status = 'preparing'`).run(missionId);
      });

    return reply.send({
      preparing: true,
      missionId,
      guaXiang: div.ben.guaXiang,
      name: div.ben.name,
      lines: div.lines,
      dong: div.dong,
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

    // 进行中任务的场景会话 id（供前端「继续任务」跳转）
    const activeSceneIds = new Map<string, string>();
    const activeScenes = db.prepare(
      "SELECT root_location_id, id FROM scene_sessions WHERE player_id = ? AND scene_type = 'mission' AND ended = 0"
    ).all(playerId) as Array<{ root_location_id: string | null; id: string }>;
    for (const s of activeScenes) {
      if (s.root_location_id && s.root_location_id.startsWith('temp-')) activeSceneIds.set(s.root_location_id.slice(5), s.id);
    }

    const result = missions.map(m => {
      const meta = jsonParse<{
        briefing?: string;
        descend_identity?: { player?: string; male_lead?: string };
        landmarks?: { name: string; feature: string }[];
        world_npcs?: { role: string; name: string; persona: string }[];
        world_tension?: string;
        target_state?: string;
        hidden_thread?: string;
        mission_hook?: string;
        twist_seed?: string;
        mission_goal?: string;
        progress?: { name: string; initial: number; target: number } | null;
        theme?: string;
        goal?: string;
        hexagram?: { ben?: string; bian?: string; hu?: string; dong?: number[]; lines?: number[] };
      }>(m.metadata, {});
      return {
        id: m.id,
        questType: m.quest_type,
        status: m.status,
        title: m.title,
        description: m.description,
        reward: m.reward,
        worldName: m.world_name,
        briefing: meta.briefing,
        descendIdentity: meta.descend_identity ? {
          player: meta.descend_identity.player ?? '',
          maleLead: meta.descend_identity.male_lead ?? '',
        } : null,
        landmarks: meta.landmarks ?? [],
        worldNpcs: meta.world_npcs ?? [],
        worldTension: meta.world_tension ?? '',
        targetState: meta.target_state ?? '',
        hiddenThread: meta.hidden_thread ?? '',
        missionHook: meta.mission_hook ?? '',
        twistSeed: meta.twist_seed ?? '',
        missionGoal: meta.mission_goal ?? '',
        progress: meta.progress ?? null,
        theme: meta.theme ?? '',
        goal: meta.goal ?? '',
        hexagram: meta.hexagram ?? null,
        characterId: m.character_id,
        sessionId: activeSceneIds.get(m.id) ?? null,
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

    const meta = jsonParse<{
      briefing?: string;
      descend_identity?: { player?: string; male_lead?: string };
      landmarks?: { name: string; feature: string }[];
      world_npcs?: { role: string; name: string; persona: string; place?: string; knows?: number[] }[];
      clues?: { id: number; content: string }[];
      environmental_clues?: string[];
      world_tension?: string;
      target_state?: string;
      hidden_thread?: string;
      mission_hook?: string;
      twist_seed?: string;
      mission_goal?: string;
      progress?: { name: string; initial: number; target: number } | null;
    }>(mission.metadata, {});

    // 更新任务状态
    const ts = now();
    db.prepare(`
      UPDATE missions SET status = 'active', character_id = ?, started_at = ? WHERE id = ?
    `).run(companionId, ts, missionId);

    // 建任务地图（temp- 前缀，任务结束删除；独立 world_id，主城查询不可见）
    const mapId = `temp-${missionId}`;
    const mapWorldId = `mission-${missionId}`;
    const worldNpcs: SceneNpc[] = (meta.world_npcs ?? []).map((n) => {
      const clues = (n.knows ?? [])
        .map((cid) => (meta.clues ?? []).find((c) => c.id === cid)?.content)
        .filter((s): s is string => !!s);
      return {
        id: genId(),
        role: n.role,
        name: n.name,
        persona: n.persona,
        place: n.place?.trim() || undefined,
        clues,
      };
    });
    const mapSummary = [
      world.summary,
      world.tone ? `氛围：${world.tone}` : '',
      world.lore ? `背景：${world.lore}` : '',
      meta.world_tension ? `困境：${meta.world_tension}` : '',
      ...(meta.landmarks ?? []).map((l) => `【地标】${l.name}：${l.feature}`),
    ].filter(Boolean).join('\n');
    db.prepare(`
      INSERT INTO scene_locations (id, world_id, name, summary, creator_type, creator_id, is_public, created_at, npcs, updated_at)
      VALUES (?, ?, ?, ?, 'system', ?, 0, ?, ?, ?)
    `).run(mapId, mapWorldId, world.name, mapSummary, playerId, ts, JSON.stringify(worldNpcs), ts);

    // 建子地点：地标 + NPC 常在地点，作为任务地图的真实可前往地点。
    // 之前 landmarks 只写进 summary 文本、NPC 常在地点压根没建，男主「去找 X」时 move 匹配不到，
    // 只能兜底瞎建（还挂到默认世界），导致「一直在路上、到不了目的地」。
    // NPC 仍全挂在根地点（世界角色始终可出场，不随地点走）；子地点只提供 move 目标与空间层次。
    const insertChildLoc = db.prepare(`
      INSERT INTO scene_locations (id, world_id, name, summary, parent_id, creator_type, creator_id, is_public, created_at, npcs, updated_at)
      VALUES (?, ?, ?, ?, ?, 'system', ?, 0, ?, '[]', ?)
    `);
    for (const lm of meta.landmarks ?? []) {
      if (!lm.name?.trim()) continue;
      insertChildLoc.run(genId(), mapWorldId, lm.name.trim(), lm.feature ?? '', mapId, playerId, ts, ts);
    }
    for (const npc of worldNpcs) {
      if (!npc.place) continue;
      const exists = db.prepare('SELECT id FROM scene_locations WHERE parent_id = ? AND name = ? COLLATE NOCASE').get(mapId, npc.place);
      if (exists) continue;
      insertChildLoc.run(genId(), mapWorldId, npc.place, '', mapId, playerId, ts, ts);
    }

    // 建 scene_session（scene_type='mission'，指向任务地图，同伴为参与者，世界NPC为地图路人）
    const sessionId = genId();
    // 进度：progress 可选，留空则无数值进度（纯玩法驱动，任务完成以玩法为准）
    const progressSrc = meta.progress ?? null;
    const statsConfig: StatsConfigItem[] = progressSrc?.name
      ? [{
          name: progressSrc.name,
          initial: progressSrc.initial,
          target: progressSrc.target,
          rules: `本场景进度 = 已揭示的线索数（共 ${progressSrc.target ?? 0} 条）。判定器只输出本轮揭示的线索编号（revealed_clues），进度由代码按累计线索数计算，天然封顶。`,
        }]
      : [];
    const statsState: Record<string, number> = {};
    for (const s of statsConfig) statsState[s.name] = s.initial;
    // 世界观只放「共享背景」（世界设定/困境/目标态），不放真相（hidden_thread）和环境线索——
    // 否则会经 scene_tone 注入所有 actor，人人皆知真相，破坏剧本杀式的信息差。
    const worldviewText = [
      world.summary,
      meta.world_tension ? `世界困境：${meta.world_tension}` : '',
      meta.target_state ? `目标态：${meta.target_state}` : '',
    ].filter(Boolean).join('\n');
    const goalText = meta.mission_goal
      ? `任务目标（玩法）：${meta.mission_goal}。目标态：${meta.target_state || '让困境得到缓解'}。`
      : (meta.target_state
        ? `帮助这个世界（或世界里的人）从困境走向目标态。困境：${meta.world_tension || world.summary}。目标态：${meta.target_state}。`
        : `理解并帮助这个世界走出困境。`);
    // 降临身份落库进 scene_session：玩家身份写 player_role，男主身份写 npc_roles（NPC 对话据此知道他俩是谁，不再是无名外人）
    // descend_identity 在 worldgen 阶段视角是"对玩家说"（player 用"你"指玩家、male_lead 用"他"指男主），
    // 注入演员 prompt 时演员的"你"=自己，代词会造成人称冲突。这里统一改写成名字指代（玩家昵称/男主名），消除歧义。
    const playerNickname = (db.prepare('SELECT name FROM players WHERE id = ?').get(playerId) as { name: string } | undefined)?.name || '玩家';
    const companionName = (db.prepare("SELECT json_extract(character_data, '$.name') AS n FROM characters WHERE id = ?").get(companionId) as any)?.n || '';
    const playerRole = meta.descend_identity?.player?.trim()
      ? meta.descend_identity.player.trim().replace(/你/g, playerNickname)
      : '来到这个世界的旅人';
    const npcRoles = meta.descend_identity?.male_lead?.trim()
      ? JSON.stringify([{ identity: '男主', description: meta.descend_identity.male_lead.trim().replace(/他|她/g, companionName || '这位同伴') }])
      : '[]';
    db.prepare(`
      INSERT INTO scene_sessions
      (id, player_id, scene_type, root_location_id, current_location_id, character_ids,
       round_no, stats_state, stats_config, ended, circumstance,
       worldview, player_role, npc_roles, goal, opening_scene, ambient_config,
       created_at, updated_at)
      VALUES (?, ?, 'mission', ?, ?, ?, 0, ?, ?, 0, '',
       ?, ?, ?, ?, ?, '', ?, ?)
    `).run(
      sessionId, playerId, mapId, mapId, JSON.stringify([companionId]),
      JSON.stringify(statsState), JSON.stringify(statsConfig),
      worldviewText, playerRole, npcRoles, goalText, meta.mission_hook ?? '', ts, ts,
    );

    // 开局场景作为首轮旁白（round 0），玩家一进入就能看到开场画面
    if (meta.mission_hook) {
      db.prepare(`
        INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at) VALUES (?, ?, 0, 'narration', NULL, '旁白', ?, '{}', NULL, '', 0, ?)
      `).run(genId(), sessionId, meta.mission_hook, ts);
    }

    // 确保relationship存在
    const existingRel = db.prepare('SELECT id FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, companionId);
    if (!existingRel) {
      db.prepare(`
        INSERT INTO relationships (id, player_id, character_id, player_description, updated_at, created_at)
        VALUES (?, ?, ?, '刚认识的陌生人', ?, ?)
      `).run(genId(), playerId, companionId, ts, ts);
    }

    return reply.send({
      sessionId,
      sceneType: 'mission',
      locationId: mapId,
      worldName: world.name,
      worldSummary: world.summary,
      statsState,
      statsConfig,
      worldview: worldviewText,
      goal: goalText,
      openingScene: meta.mission_hook ?? '',
      worldNpcs: worldNpcs.map((n) => ({ role: n.role, name: n.name, persona: n.persona })),
      round: 0,
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

  // ─── 结束任务场景：结算 + 评级 + 删地图 ───────────────
  app.post('/missions/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.body as { sessionId?: string };
    if (!sessionId) {
      return reply.code(400).send({ error: '缺少 sessionId' });
    }

    // 从 scene_session 反推 mission（任务地图 id = temp-<missionId>）
    const scene = db.prepare('SELECT root_location_id FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as { root_location_id: string } | undefined;
    if (!scene) {
      return reply.code(404).send({ error: '任务场景不存在' });
    }
    const mapId = scene.root_location_id;
    const missionId = mapId.startsWith('temp-') ? mapId.slice(5) : '';
    if (!missionId) {
      return reply.code(500).send({ error: '任务关联缺失' });
    }

    const mission = db.prepare('SELECT id, world_id FROM missions WHERE id = ? AND player_id = ?').get(missionId, playerId) as { id: string; world_id: string } | undefined;
    if (!mission) {
      return reply.code(404).send({ error: '任务不存在' });
    }

    // 1) 结束场景会话
    try { await endSceneSession(sessionId, playerId); } catch { /* 结束失败不阻塞评级 */ }

    // 2) 评级 + 发奖
    await evaluateWorldMission(missionId, playerId, sessionId, mission.world_id);

    // 3) 删除任务地图（temp- 一次性地图）
    try {
      db.prepare('DELETE FROM scene_locations WHERE id = ?').run(mapId);
    } catch { /* 地图删除失败不阻塞 */ }

    return reply.send({ ok: true, missionId });
  });
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

  const meta = jsonParse<{
    world_tension?: string; target_state?: string;
    stats?: { name: string; initial: number; target: number; rules: string } | null;
  }>(mission.metadata, {});

  // 读场景会话的最终数值 + 目标达成标记
  const scene = db.prepare('SELECT stats_state, stats_config, goal_achieved FROM scene_sessions WHERE id = ?').get(sessionId) as
    { stats_state: string; stats_config: string; goal_achieved: number } | undefined;
  const statsState = jsonParse<Record<string, number>>(scene?.stats_state ?? '{}', {});
  const statsConfig = jsonParse<StatsConfigItem[]>(scene?.stats_config ?? '[]', []);
  const goalAchieved = scene?.goal_achieved === 1;

  // 获取对话记录（scene_messages，截断：头5条+尾20条，防止超出模型上下文窗口）
  const allMessages = db.prepare(`
    SELECT role, character_name, text FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no ASC, created_at ASC
  `).all(sessionId) as Array<{ role: string; character_name: string | null; text: string }>;

  const formatMsg = (m: { role: string; character_name: string | null; text: string }) => {
    const speaker = m.role === 'player' ? '玩家' : m.role === 'narration' ? '旁白' : (m.character_name ?? 'NPC');
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

  // 数值达成摘要（困境浓度 vs 目标态）
  const statSummary = statsConfig.map((s) => {
    const cur = statsState[s.name] ?? s.initial;
    const tgt = s.target ?? s.initial;
    return `${s.name}：当前 ${cur} / 目标 ≤ ${tgt}（初始 ${s.initial}）`;
  }).join('；');

  // 调用评级LLM（数值达成是主要判据，LLM 只评合作质量）
  const evalPrompt = loadPrompt('mission.evaluator');
  const filledPrompt = renderPrompt(evalPrompt, {
    world_name: world.name,
    world_tension: meta.world_tension ?? '',
    target_state: meta.target_state ?? '',
    stat_summary: statSummary,
    goal_achieved: goalAchieved ? '是' : '否',
    conversation: conversationText,
  });

  const evalMessages: ChatMessage[] = [
    { role: 'system', content: filledPrompt },
    { role: 'user', content: '请评估。' },
  ];

  let evaluation: { goal_achieved: boolean; cooperation_quality: string; summary: string };
  try {
    const result = await chat(evalMessages, {
      temperature: 0.3,
      maxTokens: 512,
      playerId,
      guidedJson: {
        type: 'object',
        properties: {
          goal_achieved: { type: 'boolean' },
          cooperation_quality: { type: 'string', enum: ['poor', 'decent', 'excellent'] },
          summary: { type: 'string' },
        },
        required: ['goal_achieved', 'cooperation_quality', 'summary'],
      },
    });
    const parsed = tryParseJsonReply(result.content);
    if (!parsed) throw new Error('评级解析失败');
    evaluation = parsed as unknown as typeof evaluation;
  } catch (err) {
    console.error('世界任务评级失败，使用数值达成判定:', err);
    evaluation = {
      goal_achieved: goalAchieved,
      cooperation_quality: goalAchieved ? 'decent' : 'poor',
      summary: goalAchieved ? '任务完成（评级器异常，使用数值达成判定）。' : '任务未完成（评级器异常，使用数值达成判定）。',
    };
  }

  // 计算评级得分和权限：数值达成（goal_achieved）是主要判据，LLM 只评合作质量
  const costs = getCosts();
  const achieved = evaluation.goal_achieved;
  let ratingScore = 0;
  let totalReward = 0;

  if (achieved) {
    ratingScore = 2; // 数值达成 = 基础完成
    totalReward = costs.mission_base_reward;

    const coopBonus = costs.mission_coop_bonus[evaluation.cooperation_quality as keyof typeof costs.mission_coop_bonus] ?? 0;
    if (evaluation.cooperation_quality === 'excellent') {
      ratingScore = 3;
    }
    totalReward += coopBonus;
  } else {
    // 任务未达成目标态
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
  `).run(JSON.stringify({ ...evaluation, stats_state: statsState, stats_config: statsConfig }), ratingScore, ts, missionId);

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
  const resultText = achieved
    ? `任务完成！\n\n评级：${'★'.repeat(ratingScore)}${'☆'.repeat(3 - ratingScore)}\n${evaluation.summary}\n\n权限奖励：+${totalReward}`
    : `任务未完成。\n\n${evaluation.summary}\n\n世界困境未走向目标态，无权限奖励。`;
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
