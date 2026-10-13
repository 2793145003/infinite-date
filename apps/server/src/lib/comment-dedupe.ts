/**
 * 朋友圈评论「重复提交」抑制
 *
 * 背景：客户端 Enter 按键自动重复 / 连点 / 网络层重发，会把同一句评论重复 POST 上来。
 * 服务端若照单全收，就会出现「玩家刷屏 + NPC 每条都回一遍 + 每条回复都写一条记忆」的连锁放大。
 * 这里做服务端兜底：同一玩家在窗口内对同一条动态发**完全相同**的评论，视为重复提交，
 * 返回已有互动 id（不重复落库、不重复触发 NPC 回复）。
 *
 * 依赖注入 db / ts / windowMs，便于离线用真实历史数据跑样本验证。
 */
import type { DatabaseSync } from 'node:sqlite';

/** 判重时间窗：默认 60s（实测事故中 13 条重复集中在 8s 内） */
export const DUP_COMMENT_WINDOW_MS = 60_000;

/** 判重窗口内允许的宽容度：窗口内的第 2 条及以后完全同文评论算重复 */
export function findRecentDuplicateComment(
  db: DatabaseSync,
  playerId: string,
  momentId: string,
  text: string,
  ts: number,
  windowMs: number = DUP_COMMENT_WINDOW_MS,
): { id: string } | undefined {
  return db.prepare(`
    SELECT id FROM moment_interactions
    WHERE moment_id = ? AND author_id = ? AND author_type = 'player'
      AND interaction_type = 'comment' AND body = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(momentId, playerId, text, ts - windowMs) as { id: string } | undefined;
}
