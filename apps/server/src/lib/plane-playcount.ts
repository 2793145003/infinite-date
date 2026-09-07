/**
 * plane-playcount —— 位面「委托次数」（play_count）计数逻辑，抽成纯函数便于离线单测。
 *
 * 规则（星落定的）：玩家真正说过话才算一次委托，进房 / 开场白自动推进不计；
 * 每个会话只计一次（同一会话内第二条消息不重复计）。
 *
 * 不 import '../db'，只接收 db 实例 —— 单测可用 :memory: 库跑，不碰生产库。
 */
import type { DatabaseSync } from 'node:sqlite';

export function bumpPlanePlayCountIfFirstTalk(
  db: DatabaseSync,
  sessionId: string,
  planeCharacterId: string,
  message: string | undefined,
): void {
  // 本条非空才算「说过话」；空消息（开场白自动推进）不计
  const isRealTalk = (message ?? '').trim().length > 0;
  if (!isRealTalk) return;

  // 该会话已有过玩家消息则已计过，跳过（每会话只计一次）
  const alreadyCounted = (db.prepare(
    "SELECT COUNT(*) as c FROM scene_messages WHERE scene_session_id = ? AND role = 'player'",
  ).get(sessionId) as { c: number }).c;
  if (alreadyCounted > 0) return;

  db.prepare('UPDATE plane_characters SET play_count = play_count + 1 WHERE id = ?').run(planeCharacterId);
}
