/**
 * 场景引擎统一建表 SQL（scene_* + turn_memory_*）
 *
 * 背景（见 REVIEW_V4.md 🔴-1）：
 * 这些表原本散在 scene-session.ts / scene-map.ts / scene-rollback.ts / turn-memory.ts
 * 里「惰性建表」（第一次用到才建），但 db/index.ts 的 migration 在启动时就要
 * `ALTER TABLE scene_sessions / scene_messages`，表还没建就抛 `no such table`，
 * 导致全新库首次启动失败。
 *
 * 统一收拢到这里，由 db/index.ts 启动时（SCHEMA_SQL 之后、所有 migration 之前）执行一次：
 * - 新库：建表即含全部字段，migration 的 ALTER 全撞 `duplicate column`，被 migration
 *   框架的安全跳过逻辑自动标记完成；
 * - 旧库：`CREATE TABLE IF NOT EXISTS` 不动已有表，migration 正常补缺失列。
 *
 * 各 ensureX 函数（ensureSceneSession / ensureSceneMap / ensureRollbackTables /
 * ensureTable）不再各自建表，统一 `db.exec(SCENE_SCHEMA_SQL)` 幂等执行。
 *
 * 注意：本文件是纯 SQL 常量，不 import db（避免 db ↔ lib 循环依赖）。
 */

export const SCENE_SCHEMA_SQL = `
  -- 场景地点（地图节点）。全字段：含 activities / background_image / background_submitted
  CREATE TABLE IF NOT EXISTS scene_locations (
    id                    TEXT PRIMARY KEY,
    world_id              TEXT NOT NULL,
    name                  TEXT NOT NULL,
    summary               TEXT NOT NULL DEFAULT '',
    creator_type          TEXT NOT NULL DEFAULT 'system',
    creator_id            TEXT,
    character_instance_id TEXT,
    is_public             INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL,
    home_of               TEXT,
    parent_id             TEXT,
    npcs                  TEXT NOT NULL DEFAULT '[]',
    activities            TEXT NOT NULL DEFAULT '[]',
    background_image      TEXT,
    background_submitted  TEXT NOT NULL DEFAULT '[]',
    updated_at            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scene_locations_world ON scene_locations(world_id);
  CREATE INDEX IF NOT EXISTS idx_scene_locations_parent ON scene_locations(parent_id);

  -- 角色→家（替代旧 location_homes）
  CREATE TABLE IF NOT EXISTS scene_homes (
    location_id  TEXT NOT NULL,
    character_id TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (location_id, character_id)
  );
  CREATE INDEX IF NOT EXISTS idx_scene_homes_char ON scene_homes(character_id);

  -- 场景会话（一次实景约会）。全字段：含 circumstance / current_location_id / 剧本字段
  CREATE TABLE IF NOT EXISTS scene_sessions (
    id                  TEXT PRIMARY KEY,
    player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    scene_type          TEXT NOT NULL,
    root_location_id    TEXT REFERENCES scene_locations(id) ON DELETE SET NULL,
    character_ids       TEXT NOT NULL DEFAULT '[]',
    round_no            INTEGER NOT NULL DEFAULT 0,
    stats_state         TEXT NOT NULL DEFAULT '{}',
    stats_config        TEXT NOT NULL DEFAULT '[]',
    ended               INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    circumstance        TEXT,
    current_location_id TEXT REFERENCES scene_locations(id) ON DELETE SET NULL,
    scenario_id         TEXT REFERENCES scenarios(id) ON DELETE SET NULL,
    worldview           TEXT NOT NULL DEFAULT '',
    player_role         TEXT NOT NULL DEFAULT '',
    npc_roles           TEXT NOT NULL DEFAULT '[]',
    goal                TEXT NOT NULL DEFAULT '',
    opening_scene       TEXT NOT NULL DEFAULT '',
    dream_text          TEXT,
    dream_custom        INTEGER NOT NULL DEFAULT 0,
    ambient_config      TEXT NOT NULL DEFAULT '',
    goal_achieved       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_scene_sessions_player_ended ON scene_sessions(player_id, ended);
  CREATE INDEX IF NOT EXISTS idx_scene_sessions_player_type_ended ON scene_sessions(player_id, scene_type, ended);

  -- 场景回合消息
  CREATE TABLE IF NOT EXISTS scene_messages (
    id                TEXT PRIMARY KEY,
    scene_session_id  TEXT NOT NULL REFERENCES scene_sessions(id) ON DELETE CASCADE,
    round_no          INTEGER NOT NULL,
    role              TEXT NOT NULL,
    character_id      TEXT,
    character_name    TEXT NOT NULL,
    text              TEXT NOT NULL,
    stats_delta       TEXT NOT NULL DEFAULT '{}',
    quote             TEXT,
    internal          TEXT NOT NULL DEFAULT '',
    internal_notable  BOOLEAN NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scene_messages_session_round ON scene_messages(scene_session_id, round_no);
  CREATE INDEX IF NOT EXISTS idx_scene_messages_session_created ON scene_messages(scene_session_id, created_at);

  -- 场景内关系（NPC对玩家的感觉延续）。scene_session_id 加 FK：跨场延续，删 session 置 NULL
  CREATE TABLE IF NOT EXISTS scene_relationships (
    id                 TEXT PRIMARY KEY,
    player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    character_id       TEXT NOT NULL,
    scene_session_id   TEXT REFERENCES scene_sessions(id) ON DELETE SET NULL,
    player_description TEXT NOT NULL DEFAULT '刚认识的陌生人',
    current_activity   TEXT NOT NULL DEFAULT '',
    updated_at         INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scene_rel_player_char ON scene_relationships(player_id, character_id);
  CREATE INDEX IF NOT EXISTS idx_scene_rel_player_session ON scene_relationships(player_id, scene_session_id);

  -- NPC行程（与地图/短信/场景约会同一数据源）。无 FK（行程弱关联，删角色不级联删行程）
  CREATE TABLE IF NOT EXISTS scene_schedule_entries (
    id            TEXT PRIMARY KEY,
    player_id     TEXT NOT NULL,
    character_id  TEXT NOT NULL,
    day_key       TEXT NOT NULL,
    location_id   TEXT NOT NULL,
    location_name TEXT NOT NULL,
    activity      TEXT NOT NULL DEFAULT '',
    start_time    INTEGER NOT NULL,
    duration      INTEGER NOT NULL,
    is_llm_edited INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scene_sched ON scene_schedule_entries(player_id, character_id, day_key, start_time);

  -- 场基线快照（供整场删除恢复）
  CREATE TABLE IF NOT EXISTS scene_start_snapshot (
    scene_session_id TEXT PRIMARY KEY REFERENCES scene_sessions(id) ON DELETE CASCADE,
    player_id        TEXT NOT NULL,
    character_ids    TEXT NOT NULL DEFAULT '[]',
    stats_state      TEXT NOT NULL DEFAULT '{}',
    relationships    TEXT NOT NULL DEFAULT '[]',
    created_at       INTEGER NOT NULL
  );

  -- 轮滚动快照（供按轮撤回恢复）
  CREATE TABLE IF NOT EXISTS scene_round_snapshots (
    id               TEXT PRIMARY KEY,
    scene_session_id TEXT NOT NULL REFERENCES scene_sessions(id) ON DELETE CASCADE,
    round_no         INTEGER NOT NULL,
    stats_state      TEXT NOT NULL DEFAULT '{}',
    relationships    TEXT NOT NULL DEFAULT '[]',
    overviews        TEXT NOT NULL DEFAULT '[]',
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_round_snap_session_round ON scene_round_snapshots(scene_session_id, round_no);

  -- 场景内记忆折叠（回合级）。scene_session_id 加 FK：属 session 数据，删 session 级联删
  CREATE TABLE IF NOT EXISTS turn_memory_fold (
    id               TEXT PRIMARY KEY,
    player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    scene_session_id TEXT NOT NULL REFERENCES scene_sessions(id) ON DELETE CASCADE,
    character_id     TEXT NOT NULL,
    fold_type        TEXT NOT NULL,
    round_min        INTEGER,
    round_max        INTEGER,
    summary          TEXT NOT NULL DEFAULT '',
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turn_mem_fold
    ON turn_memory_fold (player_id, scene_session_id, character_id, fold_type, round_max);

  -- 场景内 PlayerFacts（NPC对玩家记忆）。scene_session_id 加 FK：删 session 级联删；手动添加的事实无场景来源，scene_session_id 允许 NULL
  CREATE TABLE IF NOT EXISTS turn_player_facts (
    id               TEXT PRIMARY KEY,
    player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    character_id     TEXT NOT NULL,
    scene_session_id TEXT REFERENCES scene_sessions(id) ON DELETE CASCADE,
    round_no         INTEGER NOT NULL,
    fact             TEXT NOT NULL,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turn_pf
    ON turn_player_facts (player_id, character_id, scene_session_id, round_no);
`;
