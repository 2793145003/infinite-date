/**
 * Session互斥检查 — 跨路由共享
 *
 * explore/conversation/mission 三种session互斥，
 * 检查函数放这里避免循环依赖。
 */
import { db } from '../db';

/** 检查玩家是否有进行中的探索session */
export function hasActiveExploreSession(playerId: string): boolean {
  const row = db.prepare('SELECT 1 FROM explore_sessions WHERE player_id = ? AND ended = 0').get(playerId);
  return !!row;
}

/** 检查玩家是否有进行中的约会session */
export function hasActiveConversationSession(playerId: string): boolean {
  const row = db.prepare('SELECT 1 FROM conversation_sessions WHERE player_id = ? AND ended = 0').get(playerId);
  return !!row;
}

/** 检查玩家是否有进行中的任务 */
export function hasActiveMission(playerId: string): boolean {
  const row = db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(playerId);
  return !!row;
}

/**
 * 玩家的「现场」占用检测（全局互斥核心）。
 *
 * 设计哲学：人只有一个，同一时刻只能"在场"于一个玩法现场——新约会/群约/旧约会/群聊/剧本/旧探索/任务
 * 都是现场，互斥；短信/朋友圈/邮件是异步渠道，不参与。
 * 新探索（scene-explore）是纯内存一次性临时场景，不落库，**不算现场**，天然不在此列。
 *
 * 返回当前进行中的唯一现场（若有），供各入口在"进入新现场"前检查：
 * 有则弹窗让玩家选择「继续这个」还是「结束它进入新的」。
 */
export type LiveSlot =
  | { type: 'scene-date'; sessionId: string }            // 新地图约会/群约 scene_sessions
  | { type: 'conversation'; sessionId: string; isGroup: boolean } // 旧约会/群聊
  | { type: 'explore'; sessionId: string }               // 旧探索 explore_sessions
  | { type: 'scenario'; scenarioSessionId: string }      // 剧本 scenario_sessions
  | { type: 'mission'; missionId: string };              // 任务 missions(active)

/**
 * 查询玩家当前唯一进行中的现场。若同时存在多个（旧数据/异常），按优先级取第一个并注明。
 * 结构与 session-mutex 其它检查函数一致，放这里避免循环依赖。
 */
export function getActiveLiveSlot(playerId: string): LiveSlot | null {
  // 新地图约会（scene）
  const scene = db.prepare('SELECT id FROM scene_sessions WHERE player_id = ? AND ended = 0 ORDER BY updated_at DESC LIMIT 1').get(playerId) as { id: string } | undefined;
  if (scene) return { type: 'scene-date', sessionId: scene.id };

  // 旧约会/群聊（conversation）
  const conv = db.prepare('SELECT id, is_group FROM conversation_sessions WHERE player_id = ? AND ended = 0 AND scenario_session_id IS NULL ORDER BY updated_at DESC LIMIT 1').get(playerId) as { id: string; is_group: number } | undefined;
  if (conv) return { type: 'conversation', sessionId: conv.id, isGroup: !!conv.is_group };

  // 旧探索（explore）
  const explore = db.prepare('SELECT id FROM explore_sessions WHERE player_id = ? AND ended = 0 ORDER BY updated_at DESC LIMIT 1').get(playerId) as { id: string } | undefined;
  if (explore) return { type: 'explore', sessionId: explore.id };

  // 剧本（scenario）
  const scenario = db.prepare('SELECT id FROM scenario_sessions WHERE player_id = ? AND ended = 0 ORDER BY updated_at DESC LIMIT 1').get(playerId) as { id: string } | undefined;
  if (scenario) return { type: 'scenario', scenarioSessionId: scenario.id };

  // 任务（mission）——missions 表没有 updated_at 列，用 created_at 排序
  const mission = db.prepare("SELECT id FROM missions WHERE player_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(playerId) as { id: string } | undefined;
  if (mission) return { type: 'mission', missionId: mission.id };

  return null;
}

/** 结束玩家当前某个现场（供弹窗"结束它进入新的"用） */
export function endLiveSlot(liveSlot: LiveSlot): void {
  switch (liveSlot.type) {
    case 'scene-date':
      db.prepare('UPDATE scene_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(Date.now(), liveSlot.sessionId);
      break;
    case 'conversation':
      db.prepare('UPDATE conversation_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(Date.now(), liveSlot.sessionId);
      break;
    case 'explore':
      db.prepare('UPDATE explore_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(Date.now(), liveSlot.sessionId);
      break;
    case 'scenario':
      db.prepare('UPDATE scenario_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(Date.now(), liveSlot.scenarioSessionId);
      break;
    case 'mission':
      db.prepare("UPDATE missions SET status = 'ended' WHERE id = ?").run(liveSlot.missionId);
      break;
  }
}
