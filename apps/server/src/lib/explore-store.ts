/**
 * 探索会话 — 纯内存临时存储
 *
 * 按星落决定（2026-08-06）：探索是「一次性临时场景」，离开探索页就结束，
 * 不落库、不恢复上次——home 键/意外离开也不会留下孤儿记录。
 *
 * 只有「探索产生的持久结果」才写库（在 scene-explore.ts 里处理：捡到物品 → player_facts），
 * 会话本身的全过程只活在内存 Map 里，session 结束或服务重启即消失（无所谓，因为是一次性的）。
 */
import { genId, now } from './util';

export type ExploreMsgRole = 'narration' | 'player' | 'item' | 'encounter' | 'caught';

export interface ExploreMessage {
  role: ExploreMsgRole;
  text: string;
  metadata: string;
  createdAt: number;
}

export interface ExploreSession {
  id: string;
  playerId: string;
  locationId: string;
  messages: ExploreMessage[];
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, ExploreSession>();

// 定期清理过期 session（玩家关页不调 /end 时 session 永留 Map）
const EXPLORE_TTL = 30 * 60 * 1000; // 30 分钟无更新则清除
setInterval(() => {
  const cutoff = Date.now() - EXPLORE_TTL;
  for (const [id, s] of sessions) {
    if (s.updatedAt < cutoff) sessions.delete(id);
  }
}, 5 * 60 * 1000).unref(); // 每 5 分钟扫一次

export function createExploreSession(playerId: string, locationId: string): ExploreSession {
  const s: ExploreSession = {
    id: genId(),
    playerId,
    locationId,
    messages: [],
    createdAt: now(),
    updatedAt: now(),
  };
  sessions.set(s.id, s);
  return s;
}

/** 取会话（校验归属：只能取自己的、还活着的） */
export function getExploreSession(sessionId: string, playerId: string): ExploreSession | undefined {
  const s = sessions.get(sessionId);
  if (s && s.playerId === playerId) return s;
  return undefined;
}

/** 追加一条探索消息 */
export function addExploreMessage(session: ExploreSession, role: ExploreMsgRole, text: string, metadata = '{}'): void {
  session.messages.push({ role, text, metadata, createdAt: now() });
  session.updatedAt = now();
}

/** 结束探索：直接从内存移除（一次性场景，不存在"标记 ended"之类的残留） */
export function endExploreSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/** 当前会话的历史（供 genNarration 续写参考） */
export function exploreHistory(session: ExploreSession): { role: string; text: string }[] {
  return session.messages.map(m => ({ role: m.role, text: m.text }));
}
