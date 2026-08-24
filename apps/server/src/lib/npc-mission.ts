/**
 * NPC 邀请任务生成（温馨向 worldgen）。
 * 与 buildWorldMission 对称，但：seed 用 NPC（不占玩家灵）、渲染温馨向模板、
 * quest_type='npc' / assignee_type='character'（承担者=邀请 NPC 本人）。
 */
import { db } from '../db';
import { genId, now } from './util';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import { castHexagram, renderHexagramLayer } from './hexagram-prompt';
import { rollTheme, renderThemeGuide, rollGoal } from './world-theme';
import { rollWorldCards, renderWorldCards } from './name-pool';
import { loadCharacterData } from './character';
import { formatNpcMissionProfile } from '../prompt/builder';
import { renderBaguaXiangLayer, cozyHexLayer, cozyGoalGuide } from './cozy-worldgen';

interface NpcWorldGenResult {
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

export interface BuiltNpcMission {
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

// guidedJson：与世界任务一致，但 world_npcs 带 place（温馨向模板明确要「常在的地点」）
const NPC_TASK_GUIDED_JSON = {
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
      properties: { player: { type: 'string' }, male_lead: { type: 'string' } },
      required: ['player', 'male_lead'],
    },
    landmarks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, feature: { type: 'string' } },
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
          place: { type: 'string' },
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
        properties: { id: { type: 'integer' }, content: { type: 'string' } },
        required: ['id', 'content'],
      },
    },
    environmental_clues: { type: 'array', items: { type: 'string' } },
    goal_path: { type: 'string' },
    mission_goal: { type: 'string' },
  },
  required: ['name', 'summary', 'tone', 'rules', 'lore', 'world_tension', 'target_state', 'hidden_thread', 'briefing', 'descend_identity', 'landmarks', 'world_npcs', 'mission_hook', 'twist_seed', 'mission_goal'],
};

/**
 * 生成一个 NPC 邀请任务（起卦 → 温馨向 LLM 生成世界 → 写库）。
 * @param npcCharacterId 发起邀请的 NPC（承担者 = 邀请 NPC 本人）
 */
export async function buildNpcMission(playerId: string, npcCharacterId: string): Promise<BuiltNpcMission> {
  const char = loadCharacterData(playerId, npcCharacterId);
  if (!char) throw new Error(`邀请 NPC 角色卡缺失：${npcCharacterId}`);
  const profile = formatNpcMissionProfile(char);

  // 起卦：seed = NPC character_id + 时辰 + 'npc' + 序号（NPC 摇卦，不占玩家灵）
  const seq = (db.prepare(
    `SELECT COUNT(*) as c FROM missions WHERE player_id = ? AND quest_type = 'npc'`
  ).get(playerId) as { c: number }).c;
  const div = castHexagram(npcCharacterId, 'npc', seq);

  // 基调 + 玩法 + 命名卡：用 playerId 种子确定性 roll（保证同一玩家任务不重复；起卦 seed 用 NPC，两者分开）
  const theme = rollTheme(playerId, seq);
  const goal = rollGoal(playerId, seq);
  const cards = rollWorldCards(playerId, seq, theme);

  // 玩家性别人设
  const player = db.prepare('SELECT gender, persona_notes FROM players WHERE id = ?').get(playerId) as
    | { gender?: string; persona_notes?: string }
    | undefined;
  const playerGenderText = player?.gender === 'male' ? '男' : player?.gender === 'female' ? '女' : '未设定';
  const playerPersona = player?.persona_notes?.trim() ? `，自设：${player.persona_notes.trim()}` : '';

  const worldPrompt = renderPrompt(loadPrompt('mission.worldgen-cozy'), {
    hexagram_layer: cozyHexLayer(renderHexagramLayer(div)),
    bagua_xiang_layer: renderBaguaXiangLayer(div),
    theme_guide: renderThemeGuide(theme),
    world_cards: renderWorldCards(cards),
    goal_guide: cozyGoalGuide(goal),
    companion_name: profile.name,
    companion_gender: profile.gender,
    companion_persona: profile.persona,
    companion_skills: profile.skills,
    companion_backstory: profile.backstory,
    player_gender: playerGenderText,
    player_persona: playerPersona,
  });
  const genMessages: ChatMessage[] = [
    { role: 'system', content: worldPrompt },
    { role: 'user', content: '生成一个温馨向 NPC 任务的设定。' },
  ];

  let worldData: NpcWorldGenResult;
  try {
    const result = await chat(genMessages, {
      temperature: 0.9,
      maxTokens: 2048,
      playerId,
      guidedJson: NPC_TASK_GUIDED_JSON,
    });
    const parsed = tryParseJsonReply(result.content);
    if (!parsed) throw new Error('温馨向世界生成解析失败');
    worldData = parsed as unknown as NpcWorldGenResult;
  } catch (err) {
    throw err;
  }

  // 写入 worlds 表
  const worldId = genId();
  const ts = now();
  db.prepare(`
    INSERT INTO worlds (id, name, summary, tone, rules, lore, world_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'mission', ?, ?)
  `).run(worldId, worldData.name, worldData.summary, worldData.tone, worldData.rules, worldData.lore, ts, ts);

  // 写入 missions 表（quest_type='npc'，承担者=邀请 NPC 本人，reward 暂 0——实际发放 §权限 按分支读配置）
  const missionId = genId();
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
    clues: worldData.clues ?? [],
    environmental_clues: worldData.environmental_clues ?? [],
    goal_path: worldData.goal_path ?? '',
    mission_goal: worldData.mission_goal ?? '',
    progress: null,
    theme,
    goal,
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
  db.prepare(`
    INSERT INTO missions (id, player_id, quest_type, assignee_type, assignee_id, character_id, world_id, title, description, status, reward, metadata, created_at)
    VALUES (?, ?, 'npc', 'character', ?, ?, ?, ?, ?, 'available', 0, ?, ?)
  `).run(missionId, playerId, npcCharacterId, npcCharacterId, worldId, `邀请任务：${worldData.name}`, worldData.briefing ?? '', missionMetadata, ts);

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
