/**
 * 玩家剧本系统路由
 *
 * 流程：
 * 1. 作者创建剧本（字段逐个写或roll）→ 发布
 * 2. 玩家浏览剧本列表，选自己的NPC进入
 * 3. 复制NPC副本，副本获得剧本身份+能力
 * 4. 进入剧本情境，互动推进（含数值系统）
 * 5. 结束后用副本约会总结生成梦的内容（可手写可roll），存回原NPC记忆
 * 6. 副本用完即弃
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { getPlayerProfile, formatCharacterCard, formatPersonalityOnly } from '../prompt/builder';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import { loadCharacterData, getCharacterName } from '../lib/character';
import { parseNpcRoles } from '../lib/scene-wiring';
import { foldChronicle, retrieveRelevantMemories, getUnifiedTimeline, maybeFoldSmsIncremental, maybeFoldGroupIncremental } from '../lib/memory';
import { clearUrgeAfterDate } from '../lib/proactive';
import { getActiveLiveSlot } from '../lib/session-mutex';
import { buildSystemPrompt, generateReply, getHubLocationsText, formatRelationshipDuration, type PromptContext, buildGroupSystemPrompt, buildGroupMessages, generateGroupReply, type GroupCharContext, type GroupLlmReply } from '../prompt/builder';
import { undoLastPlayerMessage, findLastPlayerForRetry, saveNpcReply, updatePlayerDescription, maybeRetrieveSearchResults, resolveQuote, formatQuotePrefix } from '../lib/conversation-helpers';

interface ScenarioRow {
  id: string;
  author_id: string;
  title: string;
  description: string;
  worldview: string;
  player_role: string;
  npc_role: string;
  npc_roles: string;
  opening_scene: string;
  greeting: string;
  goal: string;
  stats_config: string;
  status: string;
  play_count: number;
  created_at: number;
  updated_at: number;
}

interface StatsConfigItem {
  name: string;
  initial: number;
  rules: string;
  target: number | null;
}

// ─── 剧本字段定义 ──────────────────────────────────────────

const SCENARIO_FIELDS = [
  'title', 'description', 'worldview', 'player_role',
  'npc_role', 'opening_scene', 'greeting', 'goal',
] as const;

type ScenarioField = typeof SCENARIO_FIELDS[number];

// 每个字段roll时的输出schema
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

// npc_roles roll时的输出schema
const NPC_ROLES_SCHEMA = {
  type: 'object',
  properties: {
    npc_roles: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['npc_roles'],
};

export async function scenarioRoutes(app: FastifyInstance): Promise<void> {

  // ⛔ 已下线：旧剧本系统已被场景剧本（scene-scenario）替代。
  // 保留 GET 路由用于查看历史数据，所有写操作（POST/PATCH/DELETE）返回 403。

  // ─── 创建剧本 ───────────────────────────────────────────
  // ⛔ 已下线
  app.post('/scenarios', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 获取剧本列表 ───────────────────────────────────────
  // published=true → 已发布剧本列表；published=false → 我的草稿+已发布
  app.get('/scenarios', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { published, mine } = req.query as { published?: string; mine?: string };

    let rows: ScenarioRow[];
    if (mine === '1') {
      rows = db.prepare(`
        SELECT * FROM scenarios WHERE author_id = ? ORDER BY updated_at DESC
      `).all(playerId) as unknown as ScenarioRow[];
    } else {
      rows = db.prepare(`
        SELECT * FROM scenarios WHERE status = 'published' ORDER BY play_count DESC, created_at DESC
      `).all() as unknown as ScenarioRow[];
    }

    const result = rows.map(r => formatScenario(r));
    return reply.send({ scenarios: result });
  });

  // ─── 获取剧本详情 ───────────────────────────────────────
  app.get('/scenarios/:scenarioId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioId } = req.params as { scenarioId: string };
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId) as unknown as ScenarioRow | undefined;

    if (!row) {
      return reply.code(404).send({ error: '剧本不存在' });
    }

    // 草稿只有作者能看
    if (row.status !== 'published' && row.author_id !== playerId) {
      return reply.code(403).send({ error: '剧本未发布' });
    }

    return reply.send({ scenario: formatScenario(row) });
  });

  // ─── 更新剧本字段 ───────────────────────────────────────
  app.patch('/scenarios/:scenarioId', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── Roll单个字段 ───────────────────────────────────────
  app.post('/scenarios/:scenarioId/roll', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── Roll npc_roles（多人剧本角色槽位） ──────────────────
  app.post('/scenarios/:scenarioId/roll-roles', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── Roll数值系统 ───────────────────────────────────────
  app.post('/scenarios/:scenarioId/roll-stats', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 删除剧本 ───────────────────────────────────────────
  app.delete('/scenarios/:scenarioId', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 进入剧本 ───────────────────────────────────────────
  // 单人剧本：选1个NPC进入；多人剧本：选N个NPC分配到角色槽位
  app.post('/scenarios/:scenarioId/enter', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 剧本发消息 ─────────────────────────────────────────
  app.post('/scenarios/:scenarioSessionId/send', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 获取剧本会话消息 ───────────────────────────────────
  app.get('/scenarios/:scenarioSessionId/messages', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioSessionId } = req.params as { scenarioSessionId: string };

    const ss = db.prepare(`
      SELECT ss.*, cs.id as conv_session_id
      FROM scenario_sessions ss
      JOIN conversation_sessions cs ON cs.scenario_session_id = ss.id
      WHERE ss.id = ? AND ss.player_id = ?
    `).get(scenarioSessionId, playerId) as unknown as (ScenarioSessionRow & { conv_session_id: string }) | undefined;

    if (!ss) {
      return reply.code(404).send({ error: '剧本会话不存在' });
    }

    const messages = db.prepare(`
      SELECT id, role, text, speaker, metadata, internal, internal_notable, internal_viewed, created_at
      FROM messages WHERE session_id = ? ORDER BY created_at ASC
    `).all(ss.conv_session_id) as Array<{
      id: string; role: string; text: string; speaker: string | null; metadata: string; internal: string; internal_notable: number; internal_viewed: number; created_at: number;
    }>;

    const scenario = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(ss.scenario_id) as unknown as ScenarioRow;
    const statsConfig = jsonParse<StatsConfigItem[]>(scenario.stats_config, []);
    const statsState = jsonParse<Record<string, number>>(ss.stats_state, {});
    const charIds = jsonParse<string[]>(ss.character_ids, []);
    const isMulti = charIds.length >= 2;

    // 多人剧本返回 participants
    let participants: { characterId: string; name: string }[] | undefined;
    if (isMulti) {
      const partRows = db.prepare('SELECT sp.character_id FROM session_participants sp WHERE sp.session_id = ? ORDER BY sp.join_order').all(ss.conv_session_id) as Array<{ character_id: string }>;
      participants = partRows.map(p => ({ characterId: p.character_id, name: getCharacterName(p.character_id) }));

      // speaker存的是character_id，翻译成角色名再返回
      const speakerNameMap = new Map<string, string>();
      for (const p of participants) {
        speakerNameMap.set(p.characterId, p.name);
      }
      for (const m of messages) {
        if (m.speaker) {
          m.speaker = speakerNameMap.get(m.speaker) ?? m.speaker;
        }
      }
    }

    return reply.send({
      messages,
      scenario: formatScenario(scenario),
      statsState,
      statsConfig,
      goalAchieved: ss.goal_achieved === 1,
      ended: ss.ended === 1,
      dreamText: ss.dream_text,
      isGroup: isMulti,
      characterId: ss.character_id,
      characterName: getCharacterName(ss.character_id),
      participants,
    });
  });

  // ─── 获取进行中的剧本 ───────────────────────────────────
  app.get('/scenarios/active', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const ss = db.prepare(`
      SELECT ss.*, s.title as scenario_title, s.worldview, s.opening_scene, s.goal, s.stats_config
      FROM scenario_sessions ss
      JOIN scenarios s ON ss.scenario_id = s.id
      WHERE ss.player_id = ? AND ss.ended = 0
    `).get(playerId) as unknown as (ScenarioSessionRow & { scenario_title: string; worldview: string; opening_scene: string; goal: string; stats_config: string }) | undefined;

    if (!ss) {
      return reply.send({ session: null });
    }

    const statsConfig = jsonParse<StatsConfigItem[]>(ss.stats_config, []);
    const statsState = jsonParse<Record<string, number>>(ss.stats_state, {});
    const charIds = jsonParse<string[]>(ss.character_ids, []);
    const isMulti = charIds.length >= 2;

    let participants: { characterId: string; name: string }[] | undefined;
    if (isMulti) {
      const convSession = db.prepare('SELECT id FROM conversation_sessions WHERE scenario_session_id = ?').get(ss.id) as { id: string } | undefined;
      if (convSession) {
        const partRows = db.prepare('SELECT sp.character_id FROM session_participants sp WHERE sp.session_id = ? ORDER BY sp.join_order').all(convSession.id) as Array<{ character_id: string }>;
        participants = partRows.map(p => ({ characterId: p.character_id, name: getCharacterName(p.character_id) }));
      }
    }

    return reply.send({
      session: {
        scenarioSessionId: ss.id,
        scenarioId: ss.scenario_id,
        scenarioTitle: ss.scenario_title,
        characterId: ss.character_id,
        characterName: getCharacterName(ss.character_id),
        isGroup: isMulti,
        participants,
        statsState,
        statsConfig,
        goalAchieved: ss.goal_achieved === 1,
        createdAt: ss.created_at,
      },
    });
  });

  // ─── 结束剧本 ───────────────────────────────────────────
  app.post('/scenarios/:scenarioSessionId/end', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 撤回玩家最后一条消息 ───────────────────────────────
  app.delete('/scenarios/:scenarioSessionId/undo', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 重试：删除NPC最后回复，用同样玩家消息重新生成 ───────
  app.post('/scenarios/:scenarioSessionId/retry', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 继续：NPC主动接话（玩家不打字） ─────────────────────
  app.post('/scenarios/:scenarioSessionId/nudge', async (_req, reply) => {
    return reply.code(403).send({ error: '旧剧本已归档，请到「场景剧本」中体验' });
  });

  // ─── 获取梦的内容（梦在结束时自动生成） ───────────────────
  app.get('/scenarios/:scenarioSessionId/dream', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { scenarioSessionId } = req.params as { scenarioSessionId: string };

    const ss = db.prepare('SELECT dream_text FROM scenario_sessions WHERE id = ? AND player_id = ?').get(scenarioSessionId, playerId) as { dream_text: string | null } | undefined;
    if (!ss) return reply.code(404).send({ error: '剧本会话不存在' });

    return reply.send({ dreamText: ss.dream_text });
  });
}

// ─── 辅助函数 ─────────────────────────────────────────────

/**
 * 自动生成梦 + 存chronicle + 向量化 + NPC发梦短信
 * 在剧本结束时异步调用
 */
async function generateAndStoreDream(
  app: FastifyInstance,
  scenarioSessionId: string,
  playerId: string,
  characterId: string,
  scenarioId: string,
  convSessionId: string,
): Promise<void> {
  // 如果已有梦，跳过
  const existing = db.prepare('SELECT dream_text FROM scenario_sessions WHERE id = ?').get(scenarioSessionId) as { dream_text: string | null } | undefined;
  if (existing?.dream_text) return;

  const scenario = db.prepare('SELECT title, worldview FROM scenarios WHERE id = ?').get(scenarioId) as { title: string; worldview: string } | undefined;
  if (!scenario) return;

  // 获取对话总结
  const chronicles = db.prepare('SELECT summary FROM chronicles WHERE session_id = ? ORDER BY msg_start ASC').all(convSessionId) as Array<{ summary: string }>;
  let sessionSummary: string;
  if (chronicles.length > 0) {
    sessionSummary = chronicles.map((c, i) => `片段${i + 1}：${c.summary}`).join('\n');
  } else {
    const msgs = db.prepare('SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 30').all(convSessionId) as Array<{ role: string; text: string }>;
    const charName = getCharacterName(characterId);
    sessionSummary = msgs.map(m => `${m.role === 'player' ? '玩家' : charName}：${m.text}`).join('\n');
  }

  const charData = loadCharacterData(playerId, characterId);
  const personality = charData ? formatPersonalityOnly(charData) : '';
  const charName = charData?.name ?? getCharacterName(characterId);

  const dreamPrompt = loadPrompt('scenario.dream');
  const filledPrompt = renderPrompt(dreamPrompt, {
    scenario_title: scenario.title,
    worldview: scenario.worldview,
    session_summary: sessionSummary,
    character_name: charName,
    personality,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: filledPrompt },
    { role: 'user', content: '请生成梦的内容。' },
  ];

  const result = await chat(messages, {
    temperature: 0.85,
    maxTokens: 512,
    playerId,
    guidedJson: {
      type: 'object',
      properties: { dream: { type: 'string' } },
      required: ['dream'],
    },
  });
  const parsed = tryParseJsonReply(result.content);
  if (!parsed || typeof parsed.dream !== 'string') {
    app.log.error('梦生成失败：LLM返回格式错误');
    return;
  }
  const dreamText = parsed.dream as string;

  // 存梦
  db.prepare('UPDATE scenario_sessions SET dream_text = ?, dream_custom = 0, updated_at = ? WHERE id = ?').run(dreamText, now(), scenarioSessionId);

  // 存入chronicle记忆
  const dreamChronicleId = genId();
  db.prepare(`INSERT INTO chronicles (id, player_id, character_id, session_id, summary, key_memories, created_at, source, summary_type) VALUES (?, ?, ?, ?, ?, '[]', ?, 'dream', 'dream')`).run(dreamChronicleId, playerId, characterId, convSessionId, `[梦] ${dreamText}`, now());

  // 向量化
  try {
    const { embed, storeEmbedding } = await import('../lib/embedding');
    const dreamVec = await embed(dreamText);
    if (dreamVec) {
      storeEmbedding(playerId, characterId, 'dream', dreamChronicleId, dreamText, dreamVec);
    }
  } catch { /* 不影响流程 */ }

  // NPC主动发一条梦短信（如果已加好友）
  try {
    const thread = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { id: string } | undefined;
    if (thread && charData) {
      const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;
      const ctx: PromptContext = {
        characterData: charData,
        playerDescription: rel?.player_description ?? '刚认识的陌生人',
        playerProfile: getPlayerProfile(playerId),
        chronicleSummary: getUnifiedTimeline(playerId, characterId),
        recentMessages: [],
        isTextMessage: true,
        isDeity: false,
        locationName: '',
        hubLocations: getHubLocationsText(),
        retrievedMemories: null,
        relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
      };
      const systemPrompt = buildSystemPrompt(ctx);
      const dreamSmsPrompt = `（你刚从一场漫长的梦中醒来。梦里${dreamText}

你模糊地记得和对方一起经历了一些事——像是一场共同冒险的残影。你想告诉对方这件事。
用你自己的方式提起这个梦——可能是"我刚做了个奇怪的梦"，可能是直接说梦里的片段，也可能是感慨一句。
不要复述全部梦内容，挑最有感觉的片段说就好。简短，符合你发短信的习惯。）`;

      const dreamMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: dreamSmsPrompt },
      ];
      const reply_data = await generateReply(dreamMessages, { temperature: 0.9, maxTokens: 768, playerId });

      for (let i = 0; i < reply_data.messages.length; i++) {
        const msg = reply_data.messages[i]!;
        const msgId = genId();
        const msgTs = now();
        const internal = i === 0 ? reply_data.internal : '';
        const internalNotable = i === 0 && reply_data.internal_notable ? 1 : 0;
        db.prepare(`INSERT INTO text_messages (id, thread_id, sender, body, status, internal, internal_notable, internal_viewed, created_at, delivered_at, metadata) VALUES (?, ?, 'npc', ?, 'delivered', ?, ?, 0, ?, ?, '{"proactive":true,"dream":true}')`).run(msgId, thread.id, msg, internal, internalNotable, msgTs, msgTs);
      }
      db.prepare('UPDATE message_threads SET last_message_at = ?, unread_count = unread_count + ?, updated_at = ? WHERE id = ?').run(now(), reply_data.messages.length, now(), thread.id);
      maybeFoldSmsIncremental(thread.id, playerId, characterId, true).catch((err: unknown) => { app.log.error({ err }, 'foldChronicle失败'); });
    }
  } catch (err) {
    app.log.error({ err }, '梦短信发送失败');
  }
}

interface ScenarioSessionRow {
  id: string;
  scenario_id: string;
  player_id: string;
  character_id: string;
  character_ids: string;
  copy_id: string;
  stats_state: string;
  goal_achieved: number;
  dream_text: string | null;
  dream_custom: number;
  ended: number;
  created_at: number;
  updated_at: number;
}

function formatScenario(row: ScenarioRow) {
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
    goal: row.goal,
    statsConfig: jsonParse<StatsConfigItem[]>(row.stats_config, []),
    status: row.status,
    playCount: row.play_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 构建剧本对话的system prompt
 */
function buildScenarioSystemPrompt(
  scenario: ScenarioRow,
  charData: Parameters<typeof formatCharacterCard>[0],
  ctx: {
    playerDescription: string;
    playerProfile: string;
    chronicleSummary: string;
    retrievedMemories: string;
    relationshipDuration: string;
    isGreeting: boolean;
  },
): string {
  const tpl = ''; // 旧模板已删除，此函数为死代码（仅被403路由调用）
  const characterCard = formatCharacterCard(charData);

  const worldviewBlock = scenario.worldview ? `世界观：${scenario.worldview}` : '';
  const playerRoleBlock = scenario.player_role ? `玩家身份：${scenario.player_role}` : '';
  const npcRoleBlock = scenario.npc_role ? `你的身份：${scenario.npc_role}` : '';
  const openingSceneBlock = scenario.opening_scene ? `开局情境：${scenario.opening_scene}` : '';
  const goalBlock = scenario.goal ? `目标：${scenario.goal}` : '';

  const statsConfig = jsonParse<StatsConfigItem[]>(scenario.stats_config, []);
  const statsBlock = statsConfig.length > 0
    ? `数值系统：\n${statsConfig.map(s => `· ${s.name}（目标：${s.target ?? '无'}）：${s.rules}`).join('\n')}`
    : '';

  const greetingInstruction = ctx.isGreeting
    ? '请按照你的性格，对眼前的情境做出反应，对玩家说第一句话。'
    : '';

  return renderPrompt(tpl, {
    character_name: charData.name,
    scenario_title: scenario.title,
    worldview_block: worldviewBlock,
    player_role_block: playerRoleBlock,
    npc_role_block: npcRoleBlock,
    opening_scene_block: openingSceneBlock,
    goal_block: goalBlock,
    stats_block: statsBlock,
    character_card: characterCard,
    player_profile: ctx.playerProfile,
    player_description: ctx.playerDescription,
    greeting_instruction: greetingInstruction,
  });
}

/**
 * 生成剧本开场白
 */
async function generateScenarioGreeting(
  sessionId: string,
  playerId: string,
  characterId: string,
  scenario: ScenarioRow,
): Promise<{ messages: string[]; internal: string; internal_notable: boolean }> {
  const charData = loadCharacterData(playerId, characterId);
  if (!charData) {
    return { messages: ['……'], internal: '', internal_notable: false };
  }

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;

  const systemPrompt = buildScenarioSystemPrompt(scenario, charData, {
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    retrievedMemories: '',
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : '',
    isGreeting: true,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `（你和玩家刚刚进入「${scenario.title}」的情境。按照你的性格反应。）` },
  ];

  try {
    const reply = await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });
    return {
      messages: reply.messages,
      internal: reply.internal,
      internal_notable: reply.internal_notable,
    };
  } catch {
    // 如果有作者写的开场白，用那个
    if (scenario.greeting) {
      return { messages: [scenario.greeting], internal: '', internal_notable: false };
    }
    return { messages: ['……'], internal: '', internal_notable: false };
  }
}

/**
 * 数值判定 — 根据本轮对话判定数值增减
 */
async function judgeStats(
  scenario: ScenarioRow,
  statsConfig: StatsConfigItem[],
  statsBefore: Record<string, number>,
  playerMessage: string,
  npcReply: string,
  playerId?: string,
): Promise<{ stats: Record<string, number>; changes: Array<{ name: string; delta: number; reason: string }>; goal_achieved: boolean; goal_reason: string } | null> {
  const statsRules = statsConfig.map(s => `· ${s.name}（当前${statsBefore[s.name] ?? s.initial}，目标${s.target ?? '无'}）：${s.rules}`).join('\n');

  const judgePrompt = loadPrompt('scenario.stats-judge');
  const filledPrompt = renderPrompt(judgePrompt, {
    stats_rules: statsRules,
    stats_before: JSON.stringify(statsBefore, null, 2),
    player_message: playerMessage,
    npc_reply: npcReply,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: filledPrompt },
    { role: 'user', content: '请判定。' },
  ];

  const result = await chat(messages, {
    temperature: 0.3,
    maxTokens: 512,
    playerId,
    guidedJson: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              delta: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['name', 'delta', 'reason'],
          },
        },
        goal_achieved: { type: 'boolean' },
        goal_reason: { type: 'string' },
      },
      required: ['changes', 'goal_achieved', 'goal_reason'],
    },
  });

  const parsed = tryParseJsonReply(result.content);
  if (!parsed) return null;

  return {
    stats: statsBefore,
    changes: Array.isArray(parsed.changes) ? (parsed.changes as Array<{ name: string; delta: number; reason: string }>) : [],
    goal_achieved: Boolean(parsed.goal_achieved),
    goal_reason: String(parsed.goal_reason ?? ''),
  };
}

/**
 * 构建多人剧本 system prompt — 剧本设定 + 群聊格式
 */
function buildScenarioGroupSystemPrompt(
  scenario: ScenarioRow,
  ctxs: GroupCharContext[],
  npcRoles: Array<{ identity?: string; description: string }>,
  opts: { playerProfile: string; isGreeting: boolean },
): string {
  const tpl = ''; // 旧模板已删除，此函数为死代码（仅被403路由调用）

  const worldviewBlock = scenario.worldview ? `世界观：${scenario.worldview}` : '';
  const playerRoleBlock = scenario.player_role ? `玩家身份：${scenario.player_role}` : '';
  const npcRolesBlock = npcRoles.length > 0
    ? `角色身份分配：\n${npcRoles.map((role, i) => {
        const name = ctxs[i]?.characterData.name ?? `角色${i + 1}`;
        const idLabel = role.identity?.trim() || '';
        return `· ${name}${idLabel ? `（${idLabel}）` : ''}：${role.description}`;
      }).join('\n')}`
    : '';
  const openingSceneBlock = scenario.opening_scene ? `开局情境：${scenario.opening_scene}` : '';
  const goalBlock = scenario.goal ? `目标：${scenario.goal}` : '';

  const statsConfig = jsonParse<StatsConfigItem[]>(scenario.stats_config, []);
  const statsBlock = statsConfig.length > 0
    ? `数值系统：\n${statsConfig.map(s => `· ${s.name}（目标：${s.target ?? '无'}）：${s.rules}`).join('\n')}`
    : '';

  const greetingInstruction = opts.isGreeting
    ? '你们刚刚进入这个剧本的情境。请按照各自的性格和剧本身份，对眼前的情境做出反应，自然地开始对话。'
    : '';

  // 填充模板变量——2人 hardcoded（和群聊一致）
  const a = ctxs[0]!;
  const b = ctxs[1]!;
  return renderPrompt(tpl, {
    scenario_title: scenario.title,
    worldview_block: worldviewBlock,
    player_role_block: playerRoleBlock,
    npc_roles_block: npcRolesBlock,
    opening_scene_block: openingSceneBlock,
    goal_block: goalBlock,
    stats_block: statsBlock,
    char_a_name: a.characterData.name,
    char_a_card: formatCharacterCard(a.characterData),
    char_a_role: npcRoles[0] ? `${npcRoles[0].identity ?? ''} ${npcRoles[0].description}`.trim() : '',
    char_a_player_description: a.playerDescription,
    char_a_chronicle: a.chronicleSummary,
    char_a_memories: a.retrievedMemories ?? '',
    char_a_relationship_duration: a.relationshipDuration,
    char_b_name: b.characterData.name,
    char_b_card: formatCharacterCard(b.characterData),
    char_b_role: npcRoles[1] ? `${npcRoles[1].identity ?? ''} ${npcRoles[1].description}`.trim() : '',
    char_b_player_description: b.playerDescription,
    char_b_chronicle: b.chronicleSummary,
    char_b_memories: b.retrievedMemories ?? '',
    char_b_relationship_duration: b.relationshipDuration,
    player_profile: opts.playerProfile,
    greeting_instruction: greetingInstruction,
  });
}

/**
 * 生成多人剧本开场白
 */
async function generateScenarioGroupGreeting(
  sessionId: string,
  playerId: string,
  characterIds: string[],
  scenario: ScenarioRow,
  npcRoles: Array<{ identity?: string; description: string }>,
): Promise<GroupLlmReply | null> {
  const charDatas = characterIds.map(cid => loadCharacterData(playerId, cid));
  if (charDatas.some(d => !d)) return null;

  const charNames = charDatas.map(d => d!.name);

  const [memA, memB] = await Promise.all([
    retrieveRelevantMemories(playerId, characterIds[0]!, [], '玩家邀请你们一起进入剧本世界'),
    retrieveRelevantMemories(playerId, characterIds[1]!, [], '玩家邀请你们一起进入剧本世界'),
  ]);

  const relA = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterIds[0]!) as { player_description: string; created_at: number } | undefined;
  const relB = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterIds[1]!) as { player_description: string; created_at: number } | undefined;

  const ctxA: GroupCharContext = {
    characterData: charDatas[0]!,
    playerDescription: relA?.player_description ?? '刚认识的陌生人',
    chronicleSummary: getUnifiedTimeline(playerId, characterIds[0]!),
    retrievedMemories: memA,
    relationshipDuration: relA?.created_at ? formatRelationshipDuration(relA.created_at) : '',
  };
  const ctxB: GroupCharContext = {
    characterData: charDatas[1]!,
    playerDescription: relB?.player_description ?? '刚认识的陌生人',
    chronicleSummary: getUnifiedTimeline(playerId, characterIds[1]!),
    retrievedMemories: memB,
    relationshipDuration: relB?.created_at ? formatRelationshipDuration(relB.created_at) : '',
  };

  const systemPrompt = buildScenarioGroupSystemPrompt(scenario, [ctxA, ctxB], npcRoles, {
    playerProfile: getPlayerProfile(playerId),
    isGreeting: true,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '（你们和玩家刚刚进入「' + scenario.title + '」的情境。按照各自的性格和剧本身份反应。）' },
  ];

  try {
    return await generateGroupReply(messages, charNames, { temperature: 0.85, maxTokens: 1024, playerId });
  } catch {
    return null;
  }
}
