/**
 * 场景会话 — 新场景引擎的会话表（scene_sessions / scene_messages / scene_relationships）
 *
 * 设计（见 MIGRATION_DESIGN.md §4）：
 * - scene_sessions：场景会话头（一场 scene 的头，含归组 scene_type、起始地点、参与角色、轮号、stats 状态）
 * - scene_messages：场景消息明细（逐拍，含 role: player/npc/narration/director_note）
 * - scene_relationships：新关系表（承接旧 relationships 的写侧，纯自由文本）
 *
 * 与 scene-map.ts 一致：不动旧 schema.ts。建表 SQL 已统一收拢到 scene-schema.ts，
 * ensureSceneSession 只做幂等空转（见 REVIEW_V4.md 🔴-1）。
 */
import { db } from '../db';
import { SCENE_SCHEMA_SQL } from './scene-schema';

let sceneSessionReady = false;

/**
 * 幂等建表（新场景引擎三张核心表）。
 * 惰性调用。
 */
export function ensureSceneSession(): void {
  if (sceneSessionReady) return;
  sceneSessionReady = true;

  db.exec(SCENE_SCHEMA_SQL);
}
