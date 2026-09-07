/**
 * 位面任务系统统一建表 SQL（plane_*）
 *
 * 位面崽（恋爱智能体）是独立数据模型，不复用主城 characters 角色卡。
 * 会话/消息复用场景引擎的 scene_sessions / scene_messages（scene_type='plane' + plane_character_id 列），
 * 故这里只建 plane_characters 一张主表，其余复用场景引擎表。
 *
 * 纯 SQL 常量，不 import db（避免 db ↔ lib 循环依赖），参照 scene-schema.ts。
 */

export const PLANE_SCHEMA_SQL = `
  -- 位面崽（恋爱智能体，UGC 公共池）
  CREATE TABLE IF NOT EXISTS plane_characters (
    id            TEXT PRIMARY KEY,
    creator_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    gender        TEXT NOT NULL DEFAULT '',
    summary       TEXT NOT NULL DEFAULT '',
    persona       TEXT NOT NULL DEFAULT '',
    greeting      TEXT NOT NULL DEFAULT '',
    avatar        TEXT NOT NULL DEFAULT '',
    appearance    TEXT NOT NULL DEFAULT '',
    goal          TEXT NOT NULL DEFAULT '',
    published     INTEGER NOT NULL DEFAULT 0,
    play_count    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_plane_chars_published ON plane_characters(published, created_at);
  CREATE INDEX IF NOT EXISTS idx_plane_chars_creator ON plane_characters(creator_id);
`;
