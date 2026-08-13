/**
 * 记忆接线：把 turn-memory 三层记忆 + 跨场时间线 + 语义检索组装成
 * runSceneTurnNamed 里每个 actor 的上下文（chronicle_summary + retrieved_memories）。
 *
 * 职责边界：runSceneTurnNamed 是纯函数（不碰 DB）。本模块在调用前，从 DB 读记忆、
 * 组装成 actor 可读的字符串，喂给 runSceneTurnNamed。落库/折叠仍在轮末由调用方统一做。
 */
import type { SceneTurnInput } from './run-scene-turn';
import { assembleRoleMemory, retrieveTurnMemory } from './turn-memory';
import type { TurnLine } from './turn-memory';
import { getUnifiedTimeline } from './memory';

export interface ActorContextInput {
  sceneSessionId: string;
  playerId: string;
  characterId: string;        // 检索归属用
  playerName: string;
  /** 最近 N 轮原文（热窗，逐字）— 调用方从本轮产物里收集 */
  hotWindowRounds: TurnLine[][];
  /** 玩家本轮新发的消息——作为语义检索的首选 query（玩家说了什么是触发回忆的自然线索） */
  playerMessage?: string;
  /** 当前场景上下文（地点+活动），拼进检索 query 防止"失忆" */
  sceneContext?: string;
}

/**
 * 为单个 actor 组装记忆上下文。
 * 返回 { chronicle_summary, retrieved_memories } 两个字段，直接塞进 actor 对象。
 *
 * chronicle_summary = 当前场次三层记忆 + 跨场近期时间线（短信/约会/朋友圈混排）
 */
export async function buildActorMemories(
  input: ActorContextInput,
): Promise<{ chronicle_summary: string; retrieved_memories: string }> {
  // 1) 三层记忆（热窗 + 中期 + 长期总览）—— 当前场次
  const three = assembleRoleMemory({
    sceneSessionId: input.sceneSessionId,
    playerId: input.playerId,
    characterId: input.characterId,
    hotWindowRounds: input.hotWindowRounds,
    playerName: input.playerName,
  });

  // 2) 跨场近期时间线（短信 + 旧约会 + 场景约会 + 朋友圈，按时间排，注明来源）
  const crossTimeline = getUnifiedTimeline(input.playerId, input.characterId, 8);

  const chronicle_summary = [
    three.mid ? `【事件经过】\n${three.mid}` : '',
    three.overview ? `【长期总览】\n${three.overview}` : '',
    crossTimeline ? `【跨场时间线】\n${crossTimeline}` : '',
  ].filter(Boolean).join('\n\n') || '（尚无历史记忆）';

  // 3) 三路语义检索：玩家本轮消息 + 场景上下文拼成检索词。
  //    搜索分三路（约会摘要 / 玩家事实 / 对话原文），各 top-5，带时间。
  //    turn_overview 不进搜索（历史版本在 scene_round_snapshots 供撤回用）。
  const parts: string[] = [];
  const queryParts: string[] = [];
  if (input.sceneContext) queryParts.push(input.sceneContext);
  const playerMsg = input.playerMessage?.trim();
  if (playerMsg) queryParts.push(playerMsg);
  const searchQuery = queryParts.length
    ? queryParts.join(' ')
    : three.hot.trim().split('\n').slice(-2).join(' ');
  if (searchQuery) {
    const hit = await retrieveTurnMemory(input.playerId, input.characterId, searchQuery);
    if (hit) parts.push(hit);
  }

  const retrieved_memories = parts.length ? parts.join('\n\n') : '';

  return { chronicle_summary, retrieved_memories };
}

/**
 * 为每个 actor 批量组装记忆上下文，返回可直接 merge 进 input.actors 的对象。
 */
export async function buildAllActorMemories(
  input: {
    sceneSessionId: string;
    playerId: string;
    playerName: string;
    playerMessage?: string;
    sceneContext?: string;
    actors: Record<string, { character_id: string; hotWindowRounds: TurnLine[][] }>;
  },
): Promise<Record<string, { chronicle_summary: string; retrieved_memories: string }>> {
  const entries = Object.entries(input.actors);
  const results = await Promise.all(
    entries.map(([key, a]) => buildActorMemories({
      sceneSessionId: input.sceneSessionId,
      playerId: input.playerId,
      characterId: a.character_id,
      playerName: input.playerName,
      playerMessage: input.playerMessage,
      sceneContext: input.sceneContext,
      hotWindowRounds: a.hotWindowRounds,
    }).then(memories => [key, memories] as const))
  );
  const out: Record<string, { chronicle_summary: string; retrieved_memories: string }> = {};
  for (const [key, memories] of results) out[key] = memories;
  return out;
}

// re-export 类型方便调用方
export type { TurnLine };
export type { SceneTurnInput };
