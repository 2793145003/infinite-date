/**
 * 剧本场景引擎路由 — 用场景引擎跑剧本
 *
 * 复用 advanceScene / SSE / namer / actor / narration / rollback，
 * 加剧本特有逻辑：数值+气氛组判定、做梦、开场情境注入。
 *
 * 路由：
 *  POST   /scene-scenario                              创建剧本
 *  GET    /scene-scenario                              剧本列表（?mine=1 我的）
 *  GET    /scene-scenario/:scenarioId                  剧本详情
 *  PATCH  /scene-scenario/:scenarioId                  更新剧本字段
 *  DELETE /scene-scenario/:scenarioId                  删除剧本
 *  POST   /scene-scenario/:scenarioId/roll             Roll 单个字段
 *  POST   /scene-scenario/:scenarioId/roll-roles       Roll 多人角色槽位
 *  POST   /scene-scenario/:scenarioId/roll-stats       Roll 数值系统
 *  POST   /scene-scenario/:scenarioId/enter            进入剧本（创建 scene_session）
 *  POST   /scene-scenario/:sessionId/advance           推进一轮（SSE 流式）
 *  POST   /scene-scenario/:sessionId/continue          无玩家输入推进
 *  POST   /scene-scenario/:sessionId/retry             重试当前轮
 *  POST   /scene-scenario/:sessionId/undo              撤回上一轮
 *  POST   /scene-scenario/:sessionId/end               结束剧本（触发做梦）
 *  GET    /scene-scenario/:sessionId                    读当前剧本时间线
 *  GET    /scene-scenario/active                        查活跃剧本会话
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { advanceScene, judgeStatsAndAmbient, storeAmbientMessages, generateScenarioDream, getSceneEngine, buildNpcIdentities, parseNpcRoles } from '../lib/scene-wiring';
import { rollbackScene } from '../lib/scene-rollback';
import { getCharacterName, getCharacterAvatar, loadCharacterData } from '../lib/character';
import { getActiveLiveSlot } from '../lib/session-mutex';
import { buildCharacterCard } from '../lib/character-card';
import { chat, tryParseJsonReply, ChatMessage } from '../llm/adapter';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { getPlayerProfile, formatCharacterCard } from '../prompt/builder';
import { getUnifiedTimeline } from '../lib/memory';

interface StatsConfigItem {
  name: string;
  initial: number;
  rules: string;
  target?: number | null;
}

/**
 * 应用一轮的数值/进度变动，落库 + 推「数值变动」旁白拍。
 * 破案玩法（mission + 有进度）：进度 = 累计已揭示线索数，天然封顶，不信任 LLM delta。
 * 其他玩法：按 LLM delta，clamp 到 [0, target] 防超（治「进度 120 > 100」类问题）。
 */
function applyStatsChanges(
  sessionId: string,
  sceneType: string,
  statsConfig: StatsConfigItem[],
  statsBefore: Record<string, number>,
  revealedBefore: number[],
  judgeResult: { changes: Array<{ name: string; delta: number; reason: string }>; revealedClues?: number[] },
  roundNo: number,
  send: (data: unknown) => void,
): { newStatsState: Record<string, number>; statsChangesOverall: Array<{ name: string; before: number; after: number }> } {
  const newStatsState = { ...statsBefore };
  const statsChangesOverall: Array<{ name: string; before: number; after: number }> = [];

  const isClueProgress = sceneType === 'mission' && statsConfig.length > 0;
  if (isClueProgress) {
    // 破案：进度 = 累计已揭示线索数（target 已 = 线索总数，天然封顶）
    const revealedSet = new Set<number>(revealedBefore);
    for (const cid of (judgeResult.revealedClues ?? [])) revealedSet.add(cid);
    const revealedNow = [...revealedSet].sort((a, b) => a - b);
    const statName = statsConfig[0]!.name;
    const before = newStatsState[statName] ?? 0;
    newStatsState[statName] = revealedNow.length;
    db.prepare('UPDATE scene_sessions SET stats_state = ?, revealed_clues = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(newStatsState), JSON.stringify(revealedNow), Date.now(), sessionId);
    if (revealedNow.length !== before) {
      statsChangesOverall.push({ name: statName, before, after: revealedNow.length });
    }
  } else if (judgeResult.changes.length > 0) {
    for (const ch of judgeResult.changes) {
      const cfg = statsConfig.find(s => s.name === ch.name);
      const before = newStatsState[ch.name] ?? 0;
      let after = before + ch.delta;
      if (cfg?.target != null && cfg.target > 0) after = Math.max(0, Math.min(after, cfg.target));
      newStatsState[ch.name] = after;
      statsChangesOverall.push({ name: ch.name, before, after });
    }
    db.prepare('UPDATE scene_sessions SET stats_state = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(newStatsState), Date.now(), sessionId);

    // 数值变动旁白：脚本直接生成，不带原因，存库 + 推前端
    const changeText = judgeResult.changes
      .map(c => `${c.name}${c.delta > 0 ? '↑' : '↓'}${Math.abs(c.delta)}`)
      .join('  ');
    db.prepare(
      `INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at) VALUES (?, ?, ?, 'narration', NULL, '数值变动', ?, '{}', NULL, '', 0, ?)`
    ).run(genId(), sessionId, roundNo, changeText, Date.now());
    send({ type: 'beat', beat: { kind: 'narration', speaker: '数值变动', content: changeText } });
  }

  return { newStatsState, statsChangesOverall };
}

// ── 剧本字段定义（可 Roll 的字段）──────────────────────────────

const SCENARIO_FIELDS = [
  'title', 'description', 'worldview', 'player_role',
  'npc_role', 'opening_scene', 'greeting', 'goal',
] as const;

type ScenarioField = typeof SCENARIO_FIELDS[number];

const FIELD_SCHEMAS: Record<ScenarioField, Record<string, unknown>> = {
  title: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  description: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
  worldview: { type: 'object', properties: { worldview: { type: 'string' } }, required: ['worldview'] },
  player_role: { type: 'object', properties: { player_role: { type: 'string' } }, required: ['player_role'] },
  npc_role: { type: 'object', properties: { npc_role: { type: 'string' } }, required: ['npc_role'] },
  opening_scene: { type: 'object', properties: { opening_scene: { type: 'string' } }, required: ['opening_scene'] },
  greeting: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] },
  goal: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
};

const NPC_ROLES_SCHEMA = {
  type: 'object',
  properties: {
    npc_roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          identity: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['identity', 'description'],
      },
    },
  },
  required: ['npc_roles'],
};

// 允许 PATCH 更新的字段
const ALLOWED_PATCH_FIELDS = [
  'title', 'description', 'worldview', 'player_role',
  'npc_role', 'npc_roles', 'opening_scene', 'greeting', 'greetings',
  'goal', 'stats_config', 'status', 'ambient_config',
];

// ── formatScenario ────────────────────────────────────────────

function formatScenario(row: any) {
  return {
    id: row.id,
    authorId: row.author_id,
    title: row.title,
    description: row.description,
    worldview: row.worldview,
    playerRole: row.player_role,
    npcRole: row.npc_role,
    npcRoles: parseNpcRoles(row.npc_roles),
    openingScene: row.opening_scene,
    greeting: row.greeting,
    greetings: jsonParse<string[]>(row.greetings ?? '[]', []),
    goal: row.goal,
    statsConfig: jsonParse<StatsConfigItem[]>(row.stats_config, []),
    status: row.status,
    playCount: row.play_count,
    ambientConfig: row.ambient_config ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function sceneScenarioRoutes(app: FastifyInstance): Promise<void> {

  // ── 创建剧本 ──────────────────────────────────────────
  app.post('/scene-scenario', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { title, description } = req.body as { title?: string; description?: string };
    if (!title?.trim()) return reply.code(400).send({ error: '剧本名不能为空' });
    if (!description?.trim()) return reply.code(400).send({ error: '简介不能为空' });

    const scenarioId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO scenarios (id, author_id, title, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?)
    `).run(scenarioId, playerId, title!.trim(), description!.trim(), ts, ts);

    return reply.send({ scenarioId });
  });

  // ── 剧本列表 ──────────────────────────────────────────
  app.get('/scene-scenario', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { mine } = req.query as { mine?: string };
    let rows: any[];
    if (mine === '1') {
      rows = db.prepare('SELECT * FROM scenarios WHERE author_id = ? ORDER BY updated_at DESC').all(playerId);
    } else {
      rows = db.prepare("SELECT * FROM scenarios WHERE status = 'published' ORDER BY play_count DESC, created_at DESC").all();
    }
    return reply.send({ scenarios: rows.map(formatScenario) });
  });

  // ── 剧本详情 ──────────────────────────────────────────
  app.get('/scene-scenario/detail/:scenarioId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) as any;
    if (!row) return reply.code(404).send({ error: '剧本不存在' });
    if (row.status !== 'published' && row.author_id !== playerId) {
      return reply.code(403).send({ error: '剧本未发布' });
    }
    return reply.send({ scenario: formatScenario(row) });
  });

  // ── 更新剧本字段 ──────────────────────────────────────
  app.patch('/scene-scenario/detail/:scenarioId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const updates = req.body as Record<string, unknown>;

    const row = db.prepare('SELECT author_id FROM scenarios WHERE id = ?').get(scenarioId) as { author_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: '剧本不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能编辑自己的剧本' });

    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (ALLOWED_PATCH_FIELDS.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
    if (setClauses.length === 0) return reply.code(400).send({ error: '没有可更新的字段' });
    setClauses.push('updated_at = ?');
    values.push(now(), scenarioId);

    db.prepare(`UPDATE scenarios SET ${setClauses.join(', ')} WHERE id = ?`).run(...values as never[]);
    const updated = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) as any;
    return reply.send({ scenario: formatScenario(updated) });
  });

  // ── 删除剧本 ──────────────────────────────────────────
  app.delete('/scene-scenario/detail/:scenarioId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const row = db.prepare('SELECT author_id FROM scenarios WHERE id = ?').get(scenarioId) as { author_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: '剧本不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能删除自己的剧本' });

    db.prepare('DELETE FROM scenarios WHERE id = ?').run(scenarioId);
    return reply.send({ ok: true });
  });

  // ── Roll 单个字段 ─────────────────────────────────────
  app.post('/scene-scenario/detail/:scenarioId/roll', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const { field } = req.body as { field: ScenarioField };
    if (!SCENARIO_FIELDS.includes(field)) return reply.code(400).send({ error: '不支持的字段' });

    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) as any;
    if (!row) return reply.code(404).send({ error: '剧本不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能roll自己的剧本' });

    const rollPrompt = loadPrompt('scenario.roll');
    const filledPrompt = renderPrompt(rollPrompt, {
      title: row.title,
      description: row.description,
      worldview: row.worldview,
      player_role: row.player_role,
      npc_role: row.npc_role,
      opening_scene: row.opening_scene,
      greeting: row.greeting,
      goal: row.goal,
      target_field: field,
      output_schema: JSON.stringify(FIELD_SCHEMAS[field]),
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: `请生成「${field}」字段。` },
    ];

    try {
      const result = await chat(messages, { temperature: 0.9, maxTokens: 512, guidedJson: FIELD_SCHEMAS[field], playerId });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed || typeof parsed[field] !== 'string') return reply.code(502).send({ error: '生成失败，请重试' });

      const value = parsed[field] as string;
      db.prepare(`UPDATE scenarios SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, now(), scenarioId);
      return reply.send({ field, value });
    } catch (err) {
      app.log.error({ err }, '剧本roll失败');
      return reply.code(502).send({ error: '生成失败，请重试' });
    }
  });

  // ── Roll npc_roles（多人角色槽位）─────────────────────
  app.post('/scene-scenario/detail/:scenarioId/roll-roles', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) as any;
    if (!row) return reply.code(404).send({ error: '剧本不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能roll自己的剧本' });

    const rollPrompt = loadPrompt('scenario.roll');
    const filledPrompt = renderPrompt(rollPrompt, {
      title: row.title,
      description: row.description,
      worldview: row.worldview,
      player_role: row.player_role,
      npc_role: row.npc_role,
      opening_scene: row.opening_scene,
      greeting: row.greeting,
      goal: row.goal,
      target_field: 'npc_roles',
      output_schema: JSON.stringify(NPC_ROLES_SCHEMA),
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: '请生成「npc_roles」字段——为多人剧本生成2个角色槽位，每个包含 identity（2-6字简短身份标签，如"未婚夫""前任""青梅竹马"）和 description（完整身份+能力描述）。' },
    ];

    try {
      const result = await chat(messages, { temperature: 0.9, maxTokens: 768, guidedJson: NPC_ROLES_SCHEMA, playerId });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed || !Array.isArray(parsed.npc_roles)) return reply.code(502).send({ error: '生成失败，请重试' });

      const roles = parsed.npc_roles as Array<{ identity: string; description: string }>;
      if (roles.length < 2) return reply.code(502).send({ error: '至少需要2个角色槽位' });

      db.prepare('UPDATE scenarios SET npc_roles = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(roles), now(), scenarioId);
      return reply.send({ npcRoles: roles });
    } catch (err) {
      app.log.error({ err }, 'npc_roles roll失败');
      return reply.code(502).send({ error: '生成失败，请重试' });
    }
  });

  // ── Roll 数值系统 ─────────────────────────────────────
  app.post('/scene-scenario/detail/:scenarioId/roll-stats', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) as any;
    if (!row) return reply.code(404).send({ error: '剧本不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能roll自己的剧本' });

    const statsPrompt = loadPrompt('scenario.stats-roll');
    const filledPrompt = renderPrompt(statsPrompt, {
      title: row.title,
      worldview: row.worldview,
      player_role: row.player_role,
      npc_role: row.npc_role,
      goal: row.goal,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: '请生成数值系统。' },
    ];

    const statsSchema = {
      type: 'object',
      properties: {
        stats: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              initial: { type: 'integer' },
              rules: { type: 'string' },
              target: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            },
            required: ['name', 'initial', 'rules', 'target'],
          },
        },
      },
      required: ['stats'],
    };

    try {
      const result = await chat(messages, { temperature: 0.8, maxTokens: 768, guidedJson: statsSchema, playerId });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed || !Array.isArray(parsed.stats)) return reply.code(502).send({ error: '生成失败，请重试' });

      const statsConfig = parsed.stats as StatsConfigItem[];
      db.prepare('UPDATE scenarios SET stats_config = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(statsConfig), now(), scenarioId);
      return reply.send({ stats: statsConfig });
    } catch (err) {
      app.log.error({ err }, '数值系统roll失败');
      return reply.code(502).send({ error: '生成失败，请重试' });
    }
  });

  // ── 进入剧本 ──────────────────────────────────────────
  app.post('/scene-scenario/:scenarioId/enter', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const { characterId, characterIds } = req.body as { characterId?: string; characterIds?: string[] };

    const scenario = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) as any;
    if (!scenario) return reply.code(404).send({ error: '剧本不存在' });
    if (scenario.status !== 'published') return reply.code(403).send({ error: '剧本未发布' });

    const npcRoles = parseNpcRoles(scenario.npc_roles);

    // 参数校验：统一按 npc_roles 槽位数选 NPC
    // 旧剧本 npc_roles 为空但有 npc_role 的，parseNpcRoles 已兼容为 1 个槽位
    const slotCount = npcRoles.length || 1;
    let charIds: string[];
    if (slotCount >= 2) {
      if (!characterIds || characterIds.length !== slotCount) {
        return reply.code(400).send({ error: `需要选择${slotCount}个NPC` });
      }
      charIds = characterIds;
    } else {
      // 单人：优先用 characterId，也兼容旧前端传 characterIds[0]
      const cid = characterId ?? characterIds?.[0];
      if (!cid) return reply.code(400).send({ error: '需要选择NPC' });
      charIds = [cid];
    }

    // 全局现场互斥
    const live = getActiveLiveSlot(playerId);
    if (live) return reply.code(409).send({ error: '已有进行中的现场', live });

    // 验证好友
    for (const cid of charIds) {
      const isFriend = db.prepare(`SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = 'active'`).get(playerId, cid);
      if (!isFriend) return reply.code(400).send({ error: '只能选好友NPC' });
    }

    // 初始化数值
    const statsConfig = jsonParse<StatsConfigItem[]>(scenario.stats_config, []);
    const statsState: Record<string, number> = {};
    for (const s of statsConfig) statsState[s.name] = s.initial;

    // 确保 relationship 存在
    const ts = now();
    for (const cid of charIds) {
      const existingRel = db.prepare('SELECT id FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, cid);
      if (!existingRel) {
        db.prepare(`INSERT INTO relationships (id, player_id, character_id, player_description, updated_at, created_at) VALUES (?, ?, ?, '刚认识的陌生人', ?, ?)`)
          .run(genId(), playerId, cid, ts, ts);
      }
    }

    // 创建 scene_session（scene_type='scenario'）
    const sessionId = genId();
    db.prepare(
      `INSERT INTO scene_sessions
       (id, player_id, scene_type, root_location_id, current_location_id, character_ids,
        round_no, stats_state, stats_config, ended, circumstance,
        scenario_id, worldview, player_role, npc_roles, goal, opening_scene, ambient_config,
        dream_text, dream_custom,
        created_at, updated_at)
       VALUES (?, ?, 'scenario', NULL, NULL, ?, 0, ?, ?, 0, '', ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`
    ).run(
      sessionId, playerId, JSON.stringify(charIds),
      JSON.stringify(statsState), JSON.stringify(statsConfig),
      scenarioId,
      scenario.worldview || '',
      scenario.player_role || '',
      scenario.npc_roles || '[]',
      scenario.goal || '',
      scenario.opening_scene || '',
      scenario.ambient_config || '',
      ts, ts,
    );

    // 增加游玩次数
    db.prepare('UPDATE scenarios SET play_count = play_count + 1 WHERE id = ?').run(scenarioId);

    // 生成开场旁白（opening_scene 作为首轮 narration 消息）
    if (scenario.opening_scene) {
      db.prepare(
        `INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at) VALUES (?, ?, 0, 'narration', NULL, '旁白', ?, '{}', NULL, '', 0, ?)`
      ).run(genId(), sessionId, scenario.opening_scene, ts);
    }

    // 开场白：统一走 greetings[]，每个 NPC 各自的开场白
    {
      const greetings = jsonParse<string[]>(scenario.greetings ?? '[]', []);
      for (let i = 0; i < charIds.length && i < greetings.length; i++) {
        const g = greetings[i];
        const cid = charIds[i];
        if (g && g.trim() && cid) {
          const npcName = getCharacterName(cid);
          db.prepare(
            `INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at) VALUES (?, ?, 0, 'character', ?, ?, ?, '{}', NULL, '', 0, ?)`
          ).run(genId(), sessionId, cid, npcName, g, ts);
        }
      }
    }

    return reply.code(201).send({
      sessionId,
      scenarioId,
      title: scenario.title,
      characters: charIds.map((cid) => getCharacterName(cid)),
      statsState,
      statsConfig,
      worldview: scenario.worldview || '',
      playerRole: scenario.player_role || '',
      goal: scenario.goal || '',
      ambientConfig: scenario.ambient_config || '',
      openingScene: scenario.opening_scene || '',
      round: 0,
    });
  });

  // ── 推进一轮（SSE 流式）────────────────────────────────
  app.post('/scene-scenario/:sessionId/advance', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const body = (req.body ?? {}) as { message?: string; quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string } };

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    const send = (data: unknown) => {
      try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
    };

    try {
      // 1) advanceScene 跑引擎（SSE 逐拍推送）
      const result = await advanceScene(playerId, sessionId, body.message, {
        quote: body.quote,
        engine: 'named',
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: {
              kind: b.kind,
              speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
              content: b.content,
              characterId: b.characterId,
              internal: b.internal,
              internalNotable: b.internalNotable,
            },
          });
        },
      });

      // 2) 数值+气氛组判定（引擎完成后独立调用）
      const session = db.prepare('SELECT stats_config, stats_state, ambient_config, character_ids, npc_roles, scene_type, revealed_clues FROM scene_sessions WHERE id = ?').get(sessionId) as any;
      const statsConfig = jsonParse<StatsConfigItem[]>(session?.stats_config ?? '[]', []);
      const statsBefore = jsonParse<Record<string, number>>(session?.stats_state ?? '{}', {});
      const ambientConfig = session?.ambient_config ?? '';
      const revealedBefore = jsonParse<number[]>(session?.revealed_clues ?? '[]', []);
      const characterIds = jsonParse<string[]>(session?.character_ids ?? '[]', []);
      const npcIdentities = buildNpcIdentities(characterIds, session?.npc_roles ?? '[]');

      // 拼接本轮玩家消息 + NPC 回复给判定器
      const playerMsg = body.message ?? '';
      const npcReply = result.output
        .filter((o: any) => o.kind === 'character')
        .map((o: any) => `${o.speaker}：${o.content}`)
        .join('\n');

      const judgeResult = await judgeStatsAndAmbient(
        statsConfig, statsBefore, playerMsg, npcReply, ambientConfig, sessionId, npcIdentities, playerId,
      );

      // 3) 应用数值变动（破案=线索数，其他=delta+clamp）
      const { newStatsState, statsChangesOverall } = applyStatsChanges(
        sessionId, session?.scene_type ?? '', statsConfig, statsBefore, revealedBefore,
        judgeResult, result.roundNo, send,
      );

      // 4) 存气氛组消息（进 conversation_so_far，NPC 下轮可见）
      if (judgeResult.ambient.length > 0) {
        storeAmbientMessages(sessionId, result.roundNo, judgeResult.ambient);
        // 推气氛组 beat 给前端
        for (const text of judgeResult.ambient) {
          send({ type: 'beat', beat: { kind: 'narration', speaker: '气氛组', content: text } });
        }
      }

      // 5) 目标达成检查
      if (judgeResult.goalAchieved) {
        db.prepare('UPDATE scene_sessions SET goal_achieved = 1, updated_at = ? WHERE id = ?')
          .run(Date.now(), sessionId);
      }

      // 6) done 事件
      send({
        type: 'done',
        sessionId: result.sessionId,
        round: result.roundNo,
        stats: newStatsState,
        statsChanges: statsChangesOverall,
        statsChangeReasons: judgeResult.changes.map(c => ({ name: c.name, reason: c.reason })),
        ambient: judgeResult.ambient,
        goalAchieved: judgeResult.goalAchieved,
        goalReason: judgeResult.goalReason,
        locationName: result.locationName,
      });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '推进失败' });
      raw.end();
    }
  });

  // ── 继续（无玩家输入推进）──────────────────────────────
  app.post('/scene-scenario/:sessionId/continue', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    const send = (data: unknown) => {
      try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
    };

    try {
      const result = await advanceScene(playerId, sessionId, undefined, {
        engine: 'named',
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: {
              kind: b.kind,
              speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
              content: b.content,
              characterId: b.characterId,
              internal: b.internal,
              internalNotable: b.internalNotable,
            },
          });
        },
      });

      // 剧本 continue 不做数值判定（玩家没说话，没有交互行为可判）
      send({
        type: 'done',
        sessionId: result.sessionId,
        round: result.roundNo,
        stats: result.statsState,
        statsChanges: [],
        ambient: [],
        goalAchieved: false,
        goalReason: '',
        locationName: result.locationName,
      });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '推进失败' });
      raw.end();
    }
  });

  // ── 重试当前轮 ────────────────────────────────────────
  app.post('/scene-scenario/:sessionId/retry', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    // 对齐约会 retry 逻辑：
    // - 有玩家消息 → 回退到玩家最后一条所在轮（保留玩家消息，删 NPC 回复），重新生成
    // - 无玩家消息 → 回退到最后一轮（删最后一轮 NPC 回复），重新生成
    //   （不整场重开——整场重开会删掉开场白和 greeting，引擎从空历史自己编）
    const hasPlayer = !!db.prepare(
      "SELECT 1 FROM scene_messages WHERE scene_session_id = ? AND role = 'player' LIMIT 1"
    ).get(sessionId);

    let target: number;
    let isRetainPlayerRetry: boolean;
    if (hasPlayer) {
      const lastPlayer = db.prepare(
        "SELECT round_no FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
      ).get(sessionId) as { round_no: number } | undefined;
      if (!lastPlayer) return reply.code(400).send({ error: '没有可重试的消息' });
      target = lastPlayer.round_no;
      if (target < 1) target = 1;
      isRetainPlayerRetry = true;
    } else {
      // 无玩家消息：回退到最后一轮（保留 round 0 开场白+greeting，只删最后一轮 NPC 回复）
      const last = db.prepare(
        "SELECT round_no FROM scene_messages WHERE scene_session_id = ? AND role != 'player' AND round_no > 0 ORDER BY round_no DESC, created_at DESC LIMIT 1"
      ).get(sessionId) as { round_no: number } | undefined;
      if (!last) return reply.code(400).send({ error: '没有可重试的内容' });
      target = last.round_no;
      isRetainPlayerRetry = false;
    }

    const res = rollbackScene(playerId, sessionId, target, isRetainPlayerRetry);
    if (!res.ok) return reply.code(400).send({ error: res.error ?? '回退失败' });

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    const send = (data: unknown) => {
      try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
    };

    try {
      const result = await advanceScene(playerId, sessionId, undefined, {
        engine: 'named',
        regenerate: isRetainPlayerRetry,
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: {
              kind: b.kind,
              speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
              content: b.content,
              characterId: b.characterId,
              internal: b.internal,
              internalNotable: b.internalNotable,
            },
          });
        },
      });

      // 数值+气氛组判定（与 advance 路由一致）
      // 仅在有玩家消息时才做数值判定——无玩家消息的 retry 等同 continue，不应扣分
      const session = db.prepare('SELECT stats_config, stats_state, ambient_config, character_ids, npc_roles, scene_type, revealed_clues FROM scene_sessions WHERE id = ?').get(sessionId) as any;
      const statsConfig = jsonParse<StatsConfigItem[]>(session?.stats_config ?? '[]', []);
      const statsBefore = jsonParse<Record<string, number>>(session?.stats_state ?? '{}', {});
      const ambientConfig = session?.ambient_config ?? '';
      const revealedBefore = jsonParse<number[]>(session?.revealed_clues ?? '[]', []);
      const characterIds = jsonParse<string[]>(session?.character_ids ?? '[]', []);
      const npcIdentities = buildNpcIdentities(characterIds, session?.npc_roles ?? '[]');

      const playerMsgRow = db.prepare(
        "SELECT text FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
      ).get(sessionId) as { text: string } | undefined;
      const playerMsg = playerMsgRow?.text ?? '';

      let newStatsState = { ...statsBefore };
      const statsChangesOverall: { name: string; before: number; after: number }[] = [];
      let judgeResult: { changes: any[]; ambient: string[]; goalAchieved: boolean; goalReason: string; revealedClues: number[] } = { changes: [], ambient: [], goalAchieved: false, goalReason: '', revealedClues: [] };

      if (playerMsg && playerMsg.trim()) {
        const npcReply = result.output
          .filter((o: any) => o.kind === 'character')
          .map((o: any) => `${o.speaker}：${o.content}`)
          .join('\n');

        judgeResult = await judgeStatsAndAmbient(
          statsConfig, statsBefore, playerMsg, npcReply, ambientConfig, sessionId, npcIdentities, playerId,
        );

        const applied = applyStatsChanges(
          sessionId, session?.scene_type ?? '', statsConfig, statsBefore, revealedBefore,
          judgeResult, result.roundNo, send,
        );
        newStatsState = applied.newStatsState;
        statsChangesOverall.push(...applied.statsChangesOverall);

        if (judgeResult.ambient.length > 0) {
          storeAmbientMessages(sessionId, result.roundNo, judgeResult.ambient);
          for (const text of judgeResult.ambient) {
            send({ type: 'beat', beat: { kind: 'narration', speaker: '气氛组', content: text } });
          }
        }

        if (judgeResult.goalAchieved) {
          db.prepare('UPDATE scene_sessions SET goal_achieved = 1, updated_at = ? WHERE id = ?')
            .run(Date.now(), sessionId);
        }
      }

      send({
        type: 'done',
        sessionId: result.sessionId,
        round: result.roundNo,
        stats: newStatsState,
        statsChanges: statsChangesOverall,
        statsChangeReasons: judgeResult.changes.map(c => ({ name: c.name, reason: c.reason })),
        ambient: judgeResult.ambient,
        goalAchieved: judgeResult.goalAchieved,
        goalReason: judgeResult.goalReason,
        locationName: result.locationName,
      });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '重试失败' });
      raw.end();
    }
  });

  // ── 撤回上一轮 ────────────────────────────────────────
  app.post('/scene-scenario/:sessionId/undo', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const lastPlayer = db.prepare(
      "SELECT round_no FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
    ).get(sessionId) as { round_no: number } | undefined;
    if (!lastPlayer) return reply.code(400).send({ error: '没有可撤回的消息' });

    let target = lastPlayer.round_no;
    if (target < 1) target = 1;
    const res = rollbackScene(playerId, sessionId, target);
    if (!res.ok) return reply.code(400).send({ error: res.error ?? '撤回失败' });

    // 恢复 stats_state 到该轮前
    const session = db.prepare('SELECT stats_state FROM scene_sessions WHERE id = ?').get(sessionId) as any;
    return reply.send({ ok: true, round: target - 1, stats: jsonParse(session?.stats_state ?? '{}', {}) });
  });

  // ── 结束剧本（触发做梦）────────────────────────────────
  app.post('/scene-scenario/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const { dreamText } = req.body as { dreamText?: string };

    const session = db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '剧本不存在' });
    if (session.ended) return reply.code(400).send({ error: '剧本已结束' });

    const now = Date.now();
    db.prepare('UPDATE scene_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(now, sessionId);

    // 玩家手写梦 → 直接存
    if (dreamText) {
      db.prepare('UPDATE scene_sessions SET dream_text = ?, dream_custom = 1, updated_at = ? WHERE id = ?').run(dreamText, now, sessionId);
    } else {
      // 异步生成梦（每个 NPC 各做一个梦）
      const charIds = jsonParse<string[]>(session.character_ids, []);
      for (const cid of charIds) {
        generateScenarioDream(app, sessionId, playerId, cid).catch((err) => {
          app.log.error({ err }, '剧本做梦失败');
        });
      }
    }

    return reply.send({ ok: true, ended: true });
  });

  // ── 查活跃剧本会话 ────────────────────────────────────
  app.get('/scene-scenario/active', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const session = db.prepare(
      `SELECT s.id, s.scenario_id, s.round_no, s.stats_state, s.goal_achieved,
              sc.title, sc.worldview
       FROM scene_sessions s
       JOIN scenarios sc ON sc.id = s.scenario_id
       WHERE s.player_id = ? AND s.ended = 0 AND s.scene_type = 'scenario'
       ORDER BY s.updated_at DESC LIMIT 1`
    ).get(playerId) as any;

    if (!session) return reply.send({ active: false });

    const charIds = jsonParse<string[]>(
      (db.prepare('SELECT character_ids FROM scene_sessions WHERE id = ?').get(session.id) as any)?.character_ids ?? '[]',
      [],
    );

    return reply.send({
      active: true,
      sessionId: session.id,
      scenarioId: session.scenario_id,
      title: session.title,
      round: session.round_no,
      goalAchieved: !!session.goal_achieved,
      characters: charIds.map((cid) => getCharacterName(cid)),
    });
  });

  // ── 读剧本时间线 ──────────────────────────────────────
  app.get('/scene-scenario/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const session = db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '剧本不存在' });

    const messages = db.prepare(
      'SELECT id, round_no, role, character_id, character_name, text, quote, internal, internal_notable, created_at FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no, created_at'
    ).all(sessionId);

    const charIds = jsonParse<string[]>(session.character_ids, []);
    const friends = new Set((db.prepare('SELECT character_id FROM friendships WHERE player_id = ? AND status = ?').all(playerId, 'active') as { character_id: string }[]).map(f => f.character_id));
    const participants = charIds.map((cid: string) => ({
      characterId: cid,
      name: getCharacterName(cid),
      avatar: getCharacterAvatar(playerId, cid) || '',
      isFriend: friends.has(cid),
    }));

    const statsConfig = jsonParse<StatsConfigItem[]>(session.stats_config ?? '[]', []);
    const statsState = jsonParse<Record<string, number>>(session.stats_state ?? '{}', {});

    // 任务场景：反查任务名 + 任务信息（供顶栏显示 + 点击查看）
    // scene_session.root_location_id = `temp-${missionId}`
    let missionTitle: string | null = null;
    let missionInfo: {
      briefing?: string;
      worldTension?: string;
      targetState?: string;
      missionGoal?: string;
      worldName?: string;
      landmarks?: { name: string; feature: string }[];
      coreNpcs?: { role: string; name: string; persona: string }[];
    } | null = null;
    if (session.scene_type === 'mission' && typeof session.root_location_id === 'string' && session.root_location_id.startsWith('temp-')) {
      const missionId = session.root_location_id.slice('temp-'.length);
      const mission = db.prepare('SELECT title, metadata FROM missions WHERE id = ?').get(missionId) as { title: string; metadata: string } | undefined;
      if (mission) {
        missionTitle = mission.title;
        const meta = jsonParse<{
          briefing?: string;
          world_tension?: string;
          target_state?: string;
          mission_goal?: string;
          landmarks?: { name: string; feature: string }[];
          world_npcs?: { role: string; name: string; persona: string }[];
        }>(mission.metadata, {});
        missionInfo = {
          briefing: meta.briefing ?? '',
          worldTension: meta.world_tension ?? '',
          targetState: meta.target_state ?? '',
          missionGoal: meta.mission_goal ?? '',
          landmarks: meta.landmarks ?? [],
          coreNpcs: (meta.world_npcs ?? []).map((n) => ({ role: n.role, name: n.name, persona: n.persona })),
        };
        const worldName = (db.prepare('SELECT name FROM worlds WHERE id = (SELECT world_id FROM missions WHERE id = ?)').get(missionId) as { name: string } | undefined)?.name;
        if (worldName) missionInfo.worldName = worldName;
      }
    }

    // 同行者（男主）身份：session.npc_roles 是 JSON 数组 [{ identity, description }]
    const npcRoles = jsonParse<Array<{ identity?: string; description?: string }>>(session.npc_roles ?? '[]', []);
    const companionRole = npcRoles[0]?.description ?? '';

    return reply.send({
      sessionId: session.id,
      scenarioId: session.scenario_id,
      sceneType: session.scene_type,
      round: session.round_no,
      ended: !!session.ended,
      participants,
      messages,
      statsConfig,
      statsState,
      goalAchieved: !!session.goal_achieved,
      dreamText: session.dream_text ?? null,
      dreamCustom: !!session.dream_custom,
      worldview: session.worldview ?? '',
      playerRole: session.player_role ?? '',
      companionRole,
      goal: session.goal ?? '',
      ambientConfig: session.ambient_config ?? '',
      openingScene: session.opening_scene ?? '',
      missionTitle: missionTitle ?? '',
      missionInfo,
    });
  });
}
