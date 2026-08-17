/**
 * 无限心动 — 数据库Schema
 * 所有表 CREATE TABLE IF NOT EXISTS，启动时幂等执行。
 * 完整定义见 docs/DATA_MODEL.md
 */

export const SCHEMA_SQL = `
-- ═══ 基础表 ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_llm_configs (
  player_id  TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  base_url   TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT 'Player',
  pronouns      TEXT NOT NULL DEFAULT 'they/them',
  persona_notes TEXT NOT NULL DEFAULT '',
  gender        TEXT NOT NULL DEFAULT 'female',
  appearance    TEXT NOT NULL DEFAULT '',
  tutorial_step INTEGER NOT NULL DEFAULT 0,
  rating_score  REAL NOT NULL DEFAULT 0,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_player ON invite_codes(player_id);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);

CREATE TABLE IF NOT EXISTS worlds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  tone          TEXT NOT NULL DEFAULT '',
  rules         TEXT NOT NULL DEFAULT '',
  lore          TEXT NOT NULL DEFAULT '',
  world_type    TEXT NOT NULL DEFAULT 'mission',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id            TEXT PRIMARY KEY,
  world_id      TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  creator_type  TEXT NOT NULL DEFAULT 'system',
  creator_id    TEXT,
  character_instance_id TEXT REFERENCES character_instances(id) ON DELETE CASCADE,
  is_public     BOOLEAN NOT NULL DEFAULT TRUE,
  parent_id     TEXT REFERENCES locations(id) ON DELETE CASCADE,  -- 父地点（嵌套地图），NULL=顶层
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_world ON locations(world_id);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);

-- 角色住所关联（多对多：一个地点可以是多个角色的家，多个角色也可以住同一个地点）
CREATE TABLE IF NOT EXISTS location_homes (
  location_id  TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (location_id, character_id)
);

-- 玩家创建地点的NPC访问权限（管理员分配）
-- 系统地点不需要此表——它们对所有NPC可见
-- 玩家创建的地点必须在此表登记后，对应NPC才会在行程中出现该地点
-- 一个NPC在一个地点可以有多条活动描述，行程系统每次随机选一条
CREATE TABLE IF NOT EXISTS location_npc_access (
  id            TEXT PRIMARY KEY,
  location_id   TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  activity      TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loc_npc_access ON location_npc_access(location_id, character_id);

CREATE TABLE IF NOT EXISTS characters (
  id                TEXT PRIMARY KEY,
  character_data    TEXT NOT NULL DEFAULT '{}',
  creator_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_instances (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,
  source_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  character_data_id  TEXT NOT NULL,
  instance_no   INTEGER NOT NULL DEFAULT 1,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_unique
  ON character_instances(player_id, COALESCE(source_character_id, 'PRIVATE'), instance_no);
CREATE INDEX IF NOT EXISTS idx_instances ON character_instances(player_id, is_active);

CREATE TABLE IF NOT EXISTS relationships (
  id                    TEXT PRIMARY KEY,
  player_id             TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id          TEXT NOT NULL,
  character_instance_id TEXT,
  player_description   TEXT NOT NULL DEFAULT '刚认识的陌生人',
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_unique
  ON relationships(player_id, character_id, COALESCE(character_instance_id, 'DEFAULT'));

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id            TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  location_id   TEXT REFERENCES locations(id) ON DELETE SET NULL,  -- 约会起始地点
  current_location_id TEXT,  -- 约会中实时地点（移动后更新，NULL=与起始地点相同）
  mode          TEXT NOT NULL DEFAULT 'chat',
  summary       TEXT NOT NULL DEFAULT '',
  ended         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON conversation_sessions(player_id, character_id);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  text        TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  image_path  TEXT,
  internal   TEXT NOT NULL DEFAULT '',
  internal_notable BOOLEAN NOT NULL DEFAULT 0,
  internal_viewed BOOLEAN NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS message_threads (
  id                TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL,
  last_message_at   INTEGER,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(player_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_player ON message_threads(player_id);

CREATE TABLE IF NOT EXISTS text_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'delivered',
  attachment      TEXT,
  image_asset_id  TEXT,
  delivered_at    INTEGER,
  created_at      INTEGER NOT NULL,
  internal       TEXT NOT NULL DEFAULT '',
  internal_notable BOOLEAN NOT NULL DEFAULT 0,
  internal_viewed BOOLEAN NOT NULL DEFAULT 0,
  metadata       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_text_messages_thread ON text_messages(thread_id);

CREATE TABLE IF NOT EXISTS emails (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sender_type   TEXT NOT NULL DEFAULT 'system',
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  is_read       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_player ON emails(player_id, is_read);

CREATE TABLE IF NOT EXISTS chronicles (
  id                    TEXT PRIMARY KEY,
  player_id             TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id          TEXT NOT NULL,
  character_instance_id TEXT REFERENCES character_instances(id),
  session_id            TEXT,
  summary               TEXT NOT NULL DEFAULT '',
  key_memories          TEXT NOT NULL DEFAULT '[]',
  source                TEXT NOT NULL DEFAULT 'conversation',
  summary_type          TEXT NOT NULL DEFAULT 'segment',
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chronicles ON chronicles(player_id, character_id, character_instance_id, created_at);

-- ═══ 扩展表 ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS player_permissions (
  player_id    TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  balance      INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_permissions (
  player_id              TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id           TEXT NOT NULL,
  character_instance_id  TEXT NOT NULL REFERENCES character_instances(id),
  balance      INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, character_id, character_instance_id)
);

CREATE TABLE IF NOT EXISTS permission_transactions (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT,
  character_instance_id TEXT REFERENCES character_instances(id),
  wallet_type   TEXT NOT NULL,
  delta         INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  source_id     TEXT,
  balance_after INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perm_tx ON permission_transactions(player_id, created_at);

CREATE TABLE IF NOT EXISTS missions (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  quest_type   TEXT NOT NULL,
  assignee_type TEXT NOT NULL,
  assignee_id   TEXT NOT NULL,
  character_id TEXT,
  character_instance_id TEXT REFERENCES character_instances(id),
  world_id     TEXT REFERENCES worlds(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'available',
  reward       INTEGER NOT NULL DEFAULT 0,
  evaluation_result TEXT,
  rating_score INTEGER,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_missions ON missions(player_id, status);

CREATE TABLE IF NOT EXISTS character_player_data (
  id                TEXT PRIMARY KEY,
  source_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_data    TEXT NOT NULL DEFAULT '{}',
  is_free_override  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cpd_player ON character_player_data(player_id);
CREATE INDEX IF NOT EXISTS idx_cpd_source ON character_player_data(source_character_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpd_override_unique ON character_player_data(player_id, source_character_id) WHERE source_character_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS creator_sessions (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'active',
  draft_character TEXT NOT NULL DEFAULT '{}',
  draft_relationship TEXT NOT NULL DEFAULT '',
  messages     TEXT NOT NULL DEFAULT '[]',
  search_results TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friendships (
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  deleted_at   INTEGER,
  next_message_eligible_at INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, character_id)
);

-- npc_schedules 表已退役（场景引擎使用 scene_schedule_entries），建表语句已移除

CREATE TABLE IF NOT EXISTS character_comments (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_char_comments ON character_comments(character_id, created_at);

CREATE TABLE IF NOT EXISTS character_likes (
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (character_id, player_id)
);

CREATE TABLE IF NOT EXISTS character_edit_log (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  editor_type   TEXT NOT NULL,
  editor_id     TEXT,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  status        TEXT NOT NULL DEFAULT 'applied',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edit_log ON character_edit_log(character_id, created_at);

CREATE TABLE IF NOT EXISTS description_changes (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  old_description TEXT NOT NULL,
  new_description TEXT NOT NULL,
  character_instance_id TEXT REFERENCES character_instances(id),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desc_changes ON description_changes(player_id, character_id, created_at);

CREATE TABLE IF NOT EXISTS player_facts (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  character_instance_id TEXT REFERENCES character_instances(id),
  fact          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'conversation',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_facts ON player_facts(player_id, character_id);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  character_id  TEXT NOT NULL,
  content_text  TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_emb ON memory_embeddings(player_id, character_id, source_type);

-- ═══ 朋友圈 ════════════════════════════════════════════════

-- 朋友圈帖子
-- 酒馆模式：每个玩家只看到自己+自己好友NPC的朋友圈
-- NPC帖子是per-player的（同一个公共NPC对不同玩家生成不同内容），与schedule一致
-- trigger_type记录发帖触发原因：date_end(约会结束) / mission_end(任务完成) / schedule(行程中) / random(随机) / player(玩家手动发)
CREATE TABLE IF NOT EXISTS moments (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,  -- 帖子所属的玩家视图（酒馆模式：每个玩家有独立的朋友圈feed）
  author_type   TEXT NOT NULL,  -- 'player' | 'character'
  author_id     TEXT NOT NULL,  -- player_id 或 character_id（多态）
  content       TEXT NOT NULL DEFAULT '',  -- 帖子正文
  image_path    TEXT,  -- 图片文件名（在uploads目录中），NULL=无图
  mood          TEXT NOT NULL DEFAULT '',  -- NPC发帖时的心情标签（可选，如"开心""若有所思"）
  location_name TEXT NOT NULL DEFAULT '',  -- 发帖时的位置（可选）
  trigger_type  TEXT NOT NULL DEFAULT 'player',  -- 发帖触发原因
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_feed ON moments(player_id, created_at);

-- 朋友圈互动（点赞 + 评论统一存）
-- author_type='player'=玩家评论/点赞, 'character'=NPC评论/点赞
-- NPC评论是异步生成的——玩家发帖后，好友NPC按延迟逐个"刷到"并评论
CREATE TABLE IF NOT EXISTS moment_interactions (
  id            TEXT PRIMARY KEY,
  moment_id     TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  author_type   TEXT NOT NULL,  -- 'player' | 'character'
  author_id     TEXT NOT NULL,  -- player_id 或 character_id
  interaction_type TEXT NOT NULL,  -- 'like' | 'comment'
  body          TEXT NOT NULL DEFAULT '',  -- comment时填评论文本，like时为空
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moment_interactions ON moment_interactions(moment_id, interaction_type);
-- 防止重复点赞：同一作者对同一帖子只能like一次
CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_like_unique ON moment_interactions(moment_id, author_id, interaction_type) WHERE interaction_type = 'like';

-- ═══ 功能建议 & 更新日志 ════════════════════════════════════

-- 功能建议
-- 匿名提交：player_id 存储但前端不显示作者（管理员可见）
-- status: open(待处理) / planned(已计划) / done(已完成) / declined(不予采纳)
CREATE TABLE IF NOT EXISTS suggestions (
  id          TEXT PRIMARY KEY,
  player_id   TEXT REFERENCES players(id) ON DELETE SET NULL,  -- 提交者（匿名模式下前端不显示，管理员可见）
  is_anonymous INTEGER NOT NULL DEFAULT 1,  -- 默认匿名
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'general',  -- general/bug/feature/improvement
  status      TEXT NOT NULL DEFAULT 'open',     -- open/planned/done/declined
  admin_note  TEXT NOT NULL DEFAULT '',          -- 管理员备注（如已完成原因/拒绝理由）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, created_at);

-- 建议互动（点赞 + 评论，与朋友圈模式一致）
CREATE TABLE IF NOT EXISTS suggestion_interactions (
  id              TEXT PRIMARY KEY,
  suggestion_id   TEXT NOT NULL REFERENCES suggestions(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL,
  interaction_type TEXT NOT NULL,   -- 'like' | 'comment'
  body            TEXT NOT NULL DEFAULT '',  -- comment时填文本
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestion_interactions ON suggestion_interactions(suggestion_id, interaction_type);
-- 防重复点赞
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestion_like_unique
  ON suggestion_interactions(suggestion_id, player_id, interaction_type) WHERE interaction_type = 'like';

-- 更新日志
-- 只有管理员能创建/编辑/删除
CREATE TABLE IF NOT EXISTS changelog (
  id          TEXT PRIMARY KEY,
  version     TEXT NOT NULL DEFAULT '',  -- 版本号（如 "v1.2.0"）
  title       TEXT NOT NULL,             -- 标题
  body        TEXT NOT NULL DEFAULT '',  -- 正文（markdown）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changelog ON changelog(created_at);

-- ═══ 群聊约会 ═════════════════════════════════════════════

-- 群聊约会参与者（一个session可挂多个角色）
CREATE TABLE IF NOT EXISTS session_participants (
  session_id   TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  join_order   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_session_participants ON session_participants(session_id);

-- ═══ 地点探索 ═════════════════════════════════════════════

-- 探索session：玩家进入地点探索环境，不绑定NPC
-- 与conversation_sessions互斥（同时只能有一个活跃session）
CREATE TABLE IF NOT EXISTS explore_sessions (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  ended       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explore_sessions_player ON explore_sessions(player_id, ended);

-- 探索消息：只有player（玩家输入）和narration（世界旁白）两种角色
CREATE TABLE IF NOT EXISTS explore_messages (
  id                TEXT PRIMARY KEY,
  explore_session_id TEXT NOT NULL REFERENCES explore_sessions(id) ON DELETE CASCADE,
  role              TEXT NOT NULL,  -- 'player' | 'narration'
  text              TEXT NOT NULL,
  metadata          TEXT NOT NULL DEFAULT '{}',  -- 存found_item等事件标记
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explore_messages ON explore_messages(explore_session_id, created_at);

-- ═══ 玩家剧本系统 ═════════════════════════════════════════

-- 剧本表：玩家创建的情境框架
-- 作者只提供世界观+身份+开局情境+目标(可选)+数值系统(可选)+开场白(可选)
-- 其他玩家选自己的NPC进入，NPC做自己面对剧本设定的情境
CREATE TABLE IF NOT EXISTS scenarios (
  id            TEXT PRIMARY KEY,
  author_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,                    -- 剧本名（必填）
  description   TEXT NOT NULL DEFAULT '',          -- 简介（必填，给其他玩家看）
  worldview     TEXT NOT NULL DEFAULT '',          -- 世界观（可选）
  player_role   TEXT NOT NULL DEFAULT '',          -- 玩家身份（可选）
  npc_role      TEXT NOT NULL DEFAULT '',          -- NPC世界身份+能力（单人剧本用，可选）
  npc_roles     TEXT NOT NULL DEFAULT '[]',        -- 多人剧本角色槽位（JSON数组，空=单人剧本）
  opening_scene TEXT NOT NULL DEFAULT '',          -- 开局情境（可选）
  greeting      TEXT NOT NULL DEFAULT '',          -- 开场白（单人剧本用，可选）
  greetings     TEXT NOT NULL DEFAULT '[]',        -- 多人剧本分角色开场白（JSON数组，平行于 npc_roles）
  goal          TEXT NOT NULL DEFAULT '',          -- 目标（可选，文字描述）
  stats_config  TEXT NOT NULL DEFAULT '[]',        -- 数值系统（可选，JSON数组）
  status        TEXT NOT NULL DEFAULT 'draft',     -- draft/published
  play_count    INTEGER NOT NULL DEFAULT 0,        -- 被玩次数
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenarios_author ON scenarios(author_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_published ON scenarios(status, created_at);

-- 剧本会话：玩家进入剧本后的session
-- 复用conversation_sessions的消息表（messages），但用独立的session表管理剧本特有数据
-- scenario_copy_id指向NPC副本，结束后副本的总结生成"梦"存回原NPC记忆
CREATE TABLE IF NOT EXISTS scenario_sessions (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL,                   -- 玩家选的NPC（单人剧本用，多人剧本存第一个角色）
  character_ids   TEXT NOT NULL DEFAULT '[]',       -- 多人剧本参与的NPC列表（JSON数组，空=单人）
  copy_id         TEXT,                            -- NPC副本ID（已废弃，保留兼容）
  stats_state     TEXT NOT NULL DEFAULT '{}',       -- 数值当前状态（JSON）
  goal_achieved   INTEGER NOT NULL DEFAULT 0,       -- 目标是否达成
  dream_text      TEXT,                              -- 梦的内容（结束后填写）
  dream_custom    INTEGER NOT NULL DEFAULT 0,       -- 0=roll生成，1=玩家手写
  ended           INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenario_sessions_player ON scenario_sessions(player_id, ended);
CREATE INDEX IF NOT EXISTS idx_scenario_sessions_scenario ON scenario_sessions(scenario_id);

-- ═══ LLM 调用日志（1 小时滑动窗口，用于排查生成结果问题：气泡/分段/内容异常）═══
CREATE TABLE IF NOT EXISTS llm_call_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    INTEGER NOT NULL,              -- 毫秒时间戳
  call_type     TEXT,                           -- 可空：actor/director/narration/explore/chat 等（由调用方带，不带则 null）
  session_id    TEXT,                           -- 可空：关联的业务会话 id
  model         TEXT,
  messages_json TEXT NOT NULL,                  -- 完整请求 messages（JSON）
  raw_response  TEXT,                           -- 原始响应正文
  parsed_json   TEXT,                           -- 解析后的 JSON（如 texts 数组），可空
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  finish_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_call_log_created ON llm_call_log(created_at);

-- ═══ 图片二进制存储（2026-08-07：图片从裸文件系统迁入数据库，防止文件散失）═══
CREATE TABLE IF NOT EXISTS image_blobs (
  id         TEXT PRIMARY KEY,                -- 即原 uploads 文件名（如 {playerId}_{ts}_{rand}.png），与 avatar 字段引用无缝兼容
  data       BLOB NOT NULL,                   -- 图片二进制
  mimetype   TEXT NOT NULL,
  size       INTEGER NOT NULL,                -- 字节数
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_blobs_created ON image_blobs(created_at);
`;
