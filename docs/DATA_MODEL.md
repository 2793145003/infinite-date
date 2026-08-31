# 数据模型 · DATA_MODEL.md

> 本文档包含无限心动完整的数据模型：基础表 + 扩展表。
> 所有表都是 `CREATE TABLE IF NOT EXISTS`，启动时幂等执行。
> 权威来源：`apps/server/src/db/schema.ts`（SCHEMA_SQL）+ `apps/server/src/db/index.ts`（migration）。
> 表的最终结构 = SCHEMA_SQL 建表 + index.ts migration 追加列，本文档记录合并后的完整结构。

---

## 一、基础表

> 以下表从头建表，按v2设计决策设计。
> 标 ⚡ 的字段/表是v2新增的设计。

### app_settings
```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 系统级配置：hub_world_id（主城世界ID）等。主神ID为硬编码常量'DEITY'，不需配置
```

### ⚡ player_llm_configs — per-player LLM 配置
```sql
CREATE TABLE IF NOT EXISTS player_llm_configs (
  player_id  TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  base_url   TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
-- 每个玩家可配置自己的 LLM endpoint。任一字段为空 → 回落到环境变量默认值（LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）
```

### players
```sql
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT 'Player',
  pronouns      TEXT NOT NULL DEFAULT 'they/them',
  persona_notes TEXT NOT NULL DEFAULT '',
  ⚡gender       TEXT NOT NULL DEFAULT 'female',      -- 玩家性别
  ⚡appearance   TEXT NOT NULL DEFAULT '',             -- 玩家外貌描述
  tutorial_step INTEGER NOT NULL DEFAULT 0,   -- 0=未开始, 1=邮件已发, 2=邮件已读, 3=主城已进, 4=完成
  rating_score  REAL NOT NULL DEFAULT 0,       -- 任务表现评级（系统层数值，不违反零数值关系模型）
  ⚡is_admin     INTEGER NOT NULL DEFAULT 0,    -- 管理员标记
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

### ⚡ invite_codes
```sql
CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER  -- NULL=有效，非NULL=已吊销
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_player ON invite_codes(player_id);
-- 邀请码=身份，不绑设备。码与player_id一对一映射。详见 DESIGN.md 4.0
```

### sessions — 登录会话
```sql
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);
-- 基于token的登录会话表，玩家登录后发放token，过期后失效
```

### worlds
```sql
CREATE TABLE IF NOT EXISTS worlds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  tone          TEXT NOT NULL DEFAULT '',
  rules         TEXT NOT NULL DEFAULT '',       -- 世界特殊规则文本
  lore          TEXT NOT NULL DEFAULT '',       -- 世界观/历史/文化等LLM应视为世界数据的文本
  ⚡world_type   TEXT NOT NULL DEFAULT 'mission', -- 'hub'=主城(固定) / 'mission'=任务世界(动态薄壳) / 'npc_home'=NPC所属世界
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
-- v2用独立locations表，不存JSON
```

### ⚡ locations
```sql
CREATE TABLE IF NOT EXISTS locations (
  id            TEXT PRIMARY KEY,
  world_id      TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,  -- 所属世界。主城地点→hub world，NPC所属世界地点→对应world
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  ⚡creator_type TEXT NOT NULL DEFAULT 'system',  -- 'player' | 'character' | 'system'
  ⚡creator_id   TEXT,                             -- player_id 或 character_id
  ⚡character_instance_id TEXT REFERENCES character_instances(id) ON DELETE CASCADE,  -- NPC创建的地点绑定到具体fork，仅该fork可见。玩家/系统地点为NULL。instance删除时地点一起删
  ⚡is_public    BOOLEAN NOT NULL DEFAULT TRUE,    -- 公开=所有人可见(公共资源，不归创建者)，私有=仅创建者可见。NPC地点不通过此字段控制——由character_instance_id决定可见性，玩家不可见
  ⚡parent_id    TEXT REFERENCES locations(id) ON DELETE CASCADE,  -- 父地点（嵌套地图）。NULL=顶层地点。删除父地点时所有子地点级联删除
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_world ON locations(world_id);
CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id);
-- 嵌套地图：地点可有 parent_id 形成树形结构（像文件夹），深度无限制
-- 顶层地点(parent_id IS NULL)显示在地图首页，进入大地点后显示子地点列表
-- 完整路径由 getLocationPath() 递归查询生成，如 "星河公园 › 湖边长椅"
-- 私有地点只有创建者能在其下创建子地点
-- 注：旧的 home_of 列已废弃，角色住所改用 location_homes 多对多关联表
```

### ⚡ location_homes — 角色住所关联
```sql
-- 角色住所关联（多对多：一个地点可以是多个角色的家，多个角色也可以住同一个地点）
CREATE TABLE IF NOT EXISTS location_homes (
  location_id  TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (location_id, character_id)
);
-- 替代旧版 locations.home_of 字段。家地点只在夜间(23:00-06:00)显示在地图上
```

```sql
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
```

### characters
```sql
CREATE TABLE IF NOT EXISTS characters (
  id                TEXT PRIMARY KEY,
  ⚡character_data   TEXT NOT NULL DEFAULT '{}',  -- JSON: 完整角色卡（见下方CharacterSchema）
  ⚡creator_player_id TEXT REFERENCES players(id) ON DELETE SET NULL, -- 记录创建者，玩家删除时置NULL。NPC不属于创建者
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- v2统一存character_data JSON，不用独立列
-- 这样override系统只需合并JSON而非逐列判断
-- CharacterSchema字段：name/age/appearance/personality(surface/core/extreme)/
--   speechStyle(description+examples)/textingStyle(description+examples)/
--   background(origin/shaping/current)/emotional_signals/likes/dislikes/
--   boundaries/goals/quirks/backstory_milestones（见DESIGN.md 2.2）
```

### ⚡ NPC副本
```sql
-- 消耗权限创建NPC的副本，继承人设但无记忆
-- 副本之间互相独立，玩家可以切换，同一时间只激活一个
-- 放在relationships之前：被relationships/chronicles/character_permissions/missions/description_changes/player_facts前向引用
CREATE TABLE IF NOT EXISTS character_instances (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,   -- 'public' | 'override' | 'private'
  source_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,  -- 公共NPC被删时置NULL
  ⚡character_data_id  TEXT NOT NULL,  -- 角色卡数据定位：公共NPC=characters.id，override/私有=character_player_data.id
  instance_no   INTEGER NOT NULL DEFAULT 1,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    INTEGER NOT NULL
  -- COALESCE修复NULL不生效问题：完全私有NPC的source_character_id为NULL时普通UNIQUE约束失效
  -- SQLite表级UNIQUE不支持表达式，用CREATE UNIQUE INDEX实现
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_unique
  ON character_instances(player_id, COALESCE(source_character_id, 'PRIVATE'), instance_no);
-- 公共NPC被删时的处理（应用层）：
--   source_type='public'的实例：删除（这些玩家本来就没有独立人设，公共NPC没了就是没了）
--   source_type='override'/'private'的实例：SET NULL降级为私有态，character_data_id指向character_player_data，数据完整
-- SET NULL是DB安全网，实际清理靠应用层（见OPEN_QUESTIONS.md #3）
CREATE INDEX IF NOT EXISTS idx_instances ON character_instances(player_id, is_active);
```

### relationships
```sql
CREATE TABLE IF NOT EXISTS relationships (
  id                    TEXT PRIMARY KEY,
  player_id             TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id          TEXT NOT NULL,  -- 多态：characters.id 或 character_player_data.id，不建FK
  ⚡character_instance_id TEXT,          -- 副本隔离。NULL=默认副本
  ⚡player_description   TEXT NOT NULL DEFAULT '刚认识的陌生人',  -- NPC对玩家的一句话定性
  ⚡created_at           INTEGER NOT NULL DEFAULT 0,    -- 初次相遇时间（migration追加）
  ⚡next_message_eligible_at INTEGER NOT NULL DEFAULT 0, -- ⛔旧列（已废弃，保留不删），被 sms_urge/moment_urge 替代
  ⚡last_schedule_slot   INTEGER NOT NULL DEFAULT 0,     -- 行程变更检测（位置指纹）
  ⚡sms_urge             REAL NOT NULL DEFAULT 0,        -- 短信意愿累积（0~100，migration追加）
  ⚡moment_urge          REAL NOT NULL DEFAULT 0,        -- 朋友圈意愿累积（0~100，migration追加）
  ⚡last_task_invite_day TEXT,                           -- NPC任务每日邀请上限（北京日 key，空=今天没发过）（migration追加）
  updated_at            INTEGER NOT NULL
);
-- COALESCE修复NULL不生效问题：副本隔离，NULL=默认副本
-- SQLite表级UNIQUE不支持表达式，用CREATE UNIQUE INDEX实现
CREATE UNIQUE INDEX IF NOT EXISTS idx_relationships_unique
  ON relationships(player_id, character_id, COALESCE(character_instance_id, 'DEFAULT'));
-- v2无数值列，态度由记忆+player_description驱动
-- 零数值系统：NPC态度由记忆+player_description驱动，LLM读文本判断
```

### conversation_sessions
```sql
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id            TEXT PRIMARY KEY,
  ⚡player_id   TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,  -- 修复隔离缺陷
  character_id  TEXT NOT NULL,  -- 多态：characters.id / character_player_data.id / 'DEITY'(主神教程)
  location_id   TEXT REFERENCES locations(id) ON DELETE SET NULL,  -- 约会起始地点。地点删除时置NULL（session保留）
  ⚡current_location_id TEXT,    -- 约会中实时地点（移动后更新，NULL=与起始地点相同）（migration追加）
  mode          TEXT NOT NULL DEFAULT 'chat',  -- 'chat'=普通约会 / 'tutorial'=教程 / 'group'=群聊约会
  summary       TEXT NOT NULL DEFAULT '',
  ended         INTEGER NOT NULL DEFAULT 0,
  ⚡is_group    INTEGER NOT NULL DEFAULT 0,     -- 0=单聊（现有逻辑） / 1=群聊（2个NPC+玩家）（migration追加）
  ⚡mission_id  TEXT,                           -- 关联的任务ID（任务系统）（migration追加）
  ⚡scenario_session_id TEXT,                   -- 关联的剧本会话ID（剧本系统）（migration追加）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON conversation_sessions(player_id, character_id);
-- character_id='DEITY'时后端跳过NPC prompt-builder，改用deity.system prompt
-- is_group=1时character_id存primary角色（characterIds[0]），session_participants存全部参与者
-- 群聊使用独立端点（/sessions/group, /sessions/:id/group-send），不修改单聊路由
```

### ⚡ session_participants（群聊约会参与者）
```sql
CREATE TABLE IF NOT EXISTS session_participants (
  session_id   TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  join_order   INTEGER NOT NULL DEFAULT 0,  -- 入场顺序，0=第一个邀请的
  PRIMARY KEY (session_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_session_participants ON session_participants(session_id);
-- 群聊session的参与者关联表。单聊session不需要此表记录。
-- 群聊最多2个NPC，join_order区分第一个和第二个邀请的角色
```

### messages
```sql
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,  -- 'player' | 'assistant'
  text        TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',  -- JSON: 消息元数据，如 {"proactive":true} 标记NPC闲置主动消息
  ⚡image_path TEXT,                             -- 玩家发送的图片路径（相对uploads目录）
  ⚡internal   TEXT NOT NULL DEFAULT '',         -- NPC内心独白，默认不展示
  ⚡internal_notable BOOLEAN NOT NULL DEFAULT 0, -- 内心独白是否值得注意（migration补列，SCHEMA_SQL已含）
  ⚡internal_viewed BOOLEAN NOT NULL DEFAULT 0,  -- 是否已花权限解锁独白窥探
  ⚡speaker    TEXT,                             -- 群聊NPC的character_id，单聊/玩家消息为NULL（migration追加）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
-- metadata: 在线闲置主动消息标记为 {"proactive":true}，用于连续追问计数（最多2条未回应）
-- speaker: 群聊场景标识是哪个NPC说的（character_id），单聊场景为NULL（向后兼容）
```

### message_threads
```sql
CREATE TABLE IF NOT EXISTS message_threads (
  id                TEXT PRIMARY KEY,
  ⚡player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,  -- 修复隔离缺陷
  character_id      TEXT NOT NULL,  -- 多态：characters.id / character_player_data.id / 'DEITY'(主神)
  last_message_at   INTEGER,
  unread_count      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(player_id, character_id)  -- 一个玩家对一个NPC只有一个线程
);
CREATE INDEX IF NOT EXISTS idx_threads_player ON message_threads(player_id);
-- v2用UNIQUE(player_id, character_id)
-- character_id不建FK：多态+主神'DEITY'特殊值
```

### text_messages
```sql
CREATE TABLE IF NOT EXISTS text_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL,  -- 'player' | 'npc'
  body            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'delivered',
  attachment      TEXT,
  image_asset_id  TEXT,              -- ⚡已接线：玩家发送的图片路径（相对uploads目录），LLM以多模态格式接收
  delivered_at    INTEGER,
  created_at      INTEGER NOT NULL,
  ⚡internal       TEXT NOT NULL DEFAULT '',         -- NPC内心独白
  ⚡internal_notable BOOLEAN NOT NULL DEFAULT 0,     -- 内心独白是否值得注意
  ⚡internal_viewed BOOLEAN NOT NULL DEFAULT 0,       -- 是否已花权限解锁独白窥探
  ⚡metadata       TEXT NOT NULL DEFAULT '{}'        -- JSON: 消息元数据，如 {"proactive":true} 标记NPC主动消息
);
CREATE INDEX IF NOT EXISTS idx_text_messages_thread ON text_messages(thread_id);
-- v2用真实时间，不用游戏内时间系统
-- metadata: 在线闲置主动消息标记为 {"proactive":true}，用于连续追问计数（最多2条未回应）
```

### ⚡ emails
```sql
CREATE TABLE IF NOT EXISTS emails (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sender_type   TEXT NOT NULL DEFAULT 'system',  -- 'system' | 'deity'
  subject       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  is_read       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_player ON emails(player_id, is_read);
-- v2从头建，简化字段
-- 教程欢迎邮件、任务通知、副本结算都走此表
```

### chronicles
```sql
CREATE TABLE IF NOT EXISTS chronicles (
  id                    TEXT PRIMARY KEY,
  player_id             TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id          TEXT NOT NULL,  -- 多态
  character_instance_id TEXT REFERENCES character_instances(id),
  session_id            TEXT,                         -- 产生此条记录的conversation_session
  summary               TEXT NOT NULL DEFAULT '',     -- 叙事摘要（LLM折叠生成）
  key_memories          TEXT NOT NULL DEFAULT '[]',   -- JSON: 关键记忆点数组
  ⚡source               TEXT NOT NULL DEFAULT 'conversation',  -- 来源：'conversation' | 'scenario' 等（migration追加）
  ⚡summary_type         TEXT,                          -- 摘要类型（migration追加）
  ⚡msg_start            INTEGER,                       -- 已总结范围下界（migration追加）
  ⚡msg_end              INTEGER,                       -- 已总结范围上界（migration追加）
  -- 注：零数值系统，不存affection_snapshot。折叠时只存summary+key_memories
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chronicles ON chronicles(player_id, character_id, character_instance_id, created_at);
-- v2新建：替代character_chronicles表，结构不同
```

---

## 二、扩展表（无限心动新增）

### 权限余额（玩家）
```sql
CREATE TABLE IF NOT EXISTS player_permissions (
  player_id    TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  balance      INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
```

### 权限余额（NPC）-- per-player + per-instance
```sql
-- NPC知道自己是NPC，和玩家在一起能快速积累权限，独自积累极慢
-- "一人赚钱一人花，不能花别人的钱，哪怕那是自己"
-- 公共NPC虽然characters表只有一条记录，但权限钱包是per-player独立的
-- 每个副本独立钱包：切换副本 = 切换钱包，副本A攒的权限副本B用不了
-- NPC初始权限为0：新创建/新加好友的NPC从0开始，需要和玩家一起完成任务积累
CREATE TABLE IF NOT EXISTS character_permissions (
  player_id              TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id           TEXT NOT NULL,  -- characters.id 或 character_player_data.id
  character_instance_id  TEXT NOT NULL REFERENCES character_instances(id),
  balance      INTEGER NOT NULL DEFAULT 0,
  total_earned INTEGER NOT NULL DEFAULT 0,
  total_spent  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, character_id, character_instance_id)
);
```

### 权限交易日志
```sql
-- 记录每一笔权限变动，便于排查"权限怎么少了"
-- wallet_type区分玩家钱包和NPC钱包，character_id+character_instance_id标识NPC钱包
CREATE TABLE IF NOT EXISTS permission_transactions (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT,                                -- NPC权限时填，玩家权限为NULL
  character_instance_id TEXT REFERENCES character_instances(id),
  wallet_type   TEXT NOT NULL,  -- 'player' | 'character'
  delta         INTEGER NOT NULL,  -- 正=获得，负=消耗
  reason        TEXT NOT NULL,  -- 'mission_reward' | 'create_npc' | 'create_location' | 'override' | 'instance' | 'undo' | 'internal_view' | 'admin_grant'
  source_id     TEXT,  -- mission id / creator_session id / message id 等
  balance_after INTEGER NOT NULL,  -- 交易后余额快照
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perm_tx ON permission_transactions(player_id, created_at);
```

### 任务系统
```sql
-- 三种任务：
--   角色任务(quest_type='character')：单人进入NPC过去的时间切片，遇到过去版本NPC。会梦到。填补意难平【未实现】
--   世界任务(quest_type='world')：摇卦起卦→卦象驱动生成原创世界（困境→目标态）→玩家选好友同行→通关评级【已实现，见 HEXAGRAM_MISSION_DESIGN.md】
--   NPC任务(quest_type='npc')：系统发给NPC，NPC邀请玩家。角色特长温馨向【未实现】
CREATE TABLE IF NOT EXISTS missions (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  quest_type   TEXT NOT NULL,  -- 'character' | 'world' | 'npc'（当前仅 'world' 有实现）
  assignee_type TEXT NOT NULL,  -- 'player' | 'character'
  assignee_id   TEXT NOT NULL,  -- player_id 或 character_id
  character_id TEXT,            -- 角色任务=NPC whose past / NPC任务=inviting NPC / 世界任务=companion NPC
  character_instance_id TEXT REFERENCES character_instances(id),
  world_id     TEXT REFERENCES worlds(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'available',  -- available/active/solo/completed/declined
  reward       INTEGER NOT NULL DEFAULT 0,  -- 由 permission_costs.json 配置（mission_base_reward 等）
  evaluation_result TEXT,  -- JSON: 世界任务评级结果 {goal_achieved: bool, cooperation_quality: str, summary: str, stats_state: {...}, stats_config: [...]}
  rating_score INTEGER,  -- 世界任务评级得分（1-3），用于更新玩家rating_score
  ⚡metadata   TEXT NOT NULL DEFAULT '{}',  -- JSON: 结构化数据（世界设定/地标/世界NPC/困境数值/卦象档案等）（migration追加）
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER,
  ⚡solo_complete_at INTEGER  -- NPC任务玩家拒绝后 NPC 独自完成的时刻；接受分支为 NULL（migration追加）
);
CREATE INDEX IF NOT EXISTS idx_missions ON missions(player_id, status);
```

### 任务邀请记录
~~已删除~~：世界任务NPC不拒绝（符合自利动机），NPC任务的邀请结果直接存missions.status。不需要独立的邀请记录表。

### NPC人设覆盖层与完全私有NPC
```sql
-- 三种形态的数据归属：
--   公共态：characters表，全局共享
--   override私有态：创建时fork完整角色卡到character_player_data.character_data（不是差异覆盖）
--     之后玩家自由修改自己的完整副本，不再回公共版合并
--     公共NPC后续被管理员修改OOC不影响已fork的override
--     公共NPC被删时source_character_id置NULL，override降级为完全私有态，数据保留
--   完全私有态：character_player_data独立存在，source_character_id = NULL
-- prompt-builder读取时：
--   source_character_id非空 → 只读character_player_data.character_data（已是fork的完整角色卡）
--   source_character_id为空 → 只读character_player_data.character_data（完全私有）
CREATE TABLE IF NOT EXISTS character_player_data (
  id                TEXT PRIMARY KEY,  -- 完全私有态用，作为虚拟character_id
  source_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,  -- 公共NPC被删时置NULL，override降级为完全私有态
  player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_data    TEXT NOT NULL DEFAULT '{}',   -- JSON: 角色卡字段（含backstory_milestones，见DESIGN.md 2.2）
  is_free_override  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cpd_player ON character_player_data(player_id);
CREATE INDEX IF NOT EXISTS idx_cpd_source ON character_player_data(source_character_id);
-- 同一玩家对同一公共NPC只能有一个override：partial unique约束
-- 完全私有NPC的source_character_id为NULL，不受约束，可有多个
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpd_override_unique ON character_player_data(player_id, source_character_id) WHERE source_character_id IS NOT NULL;
```

### 角色创建会话
```sql
-- 不复用messages表：角色创建对话不是"约会"，不进Chronicle，不更新player_description
-- 它是一次性的系统引导对话，结束后draft_character定稿写入characters/character_player_data
-- 对话历史存在creator_sessions.messages中，创建完成后可归档不删
CREATE TABLE IF NOT EXISTS creator_sessions (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'active',  -- active/completed/abandoned
  draft_character TEXT NOT NULL DEFAULT '{}',   -- JSON: 逐步构建的角色卡草稿（含backstory_milestones）
  draft_relationship TEXT NOT NULL DEFAULT '',  -- JSON: 初始关系设置 {player_description: "刚认识的陌生人"}
  messages     TEXT NOT NULL DEFAULT '[]',      -- JSON: 系统与玩家的对话历史
  search_results TEXT NOT NULL DEFAULT '[]',    -- JSON: AI搜索到的角色资料
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
```

### 好友关系
```sql
-- character_id不FK到characters表，因为完全私有NPC不在characters里
-- 用应用层校验：character_id可能是characters.id或character_player_data.id
-- 注意：好友关系是per-character的（不是per-instance），副本切换后好友继承
CREATE TABLE IF NOT EXISTS friendships (
  player_id    TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',  -- active/deleted
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (player_id, character_id)
);
-- next_message_eligible_at 已废弃（旧时间戳机制），被 relationships.sms_urge / moment_urge 意愿累积替代
-- 行程生成时：无active instance的NPC不进入行程计算（见DESIGN.md 2.3放逐系统）
-- 删好友=硬删除：DELETE整行 + 级联清理所有关联数据（短信/对话/记忆/关系/行程/fork/朋友圈互动）
-- 代码见 me.ts deleteFriend，事务内执行。与放逐不同：删好友是per-character操作，放逐是per-instance操作
-- status/deleted_at列保留兼容但当前代码不再使用soft-delete路径
-- 放逐=删除instance及其per-instance数据，不改friendships。无active instance后NPC自然从主城消失（放逐系统未实现，见OPEN_QUESTIONS.md #1）
```

### NPC行程
```sql
-- 同样不FK，character_id可能是公共或私有NPC
-- 注意：行程是per-player的（公共NPC的行程对每个玩家独立）
-- 基础行程（deterministic hash生成，hash seed含player_id）随用随算，不存本表
-- 只有LLM调整后的行程才持久化，因此每条记录都带player_id
-- ⚠️ 旧表（v2 起退役，0 行、无写入点，仅历史遗留）
CREATE TABLE IF NOT EXISTS npc_schedules (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  location_id   TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,  -- 地点删除时行程一起删
  activity      TEXT NOT NULL DEFAULT '',
  start_time    INTEGER NOT NULL,  -- Unix timestamp
  duration      INTEGER NOT NULL,  -- 分钟
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_npc_schedule ON npc_schedules(player_id, character_id, start_time);
```

### NPC行程（v2 新表，与地图/短信/场景约会同一数据源）
```sql
-- 新地图生成的基础行程也落库（不只是 LLM 调整），与旧表 npc_schedules 分离
CREATE TABLE IF NOT EXISTS scene_schedule_entries (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL,          -- 无 FK，删档须显式清
  character_id  TEXT NOT NULL,
  day_key       TEXT NOT NULL,          -- 北京日期 "2026-08-05"
  location_id   TEXT,
  location_name TEXT NOT NULL DEFAULT '',
  activity      TEXT NOT NULL DEFAULT '',
  start_time    INTEGER NOT NULL,
  duration      INTEGER NOT NULL,        -- 分钟
  is_llm_edited INTEGER NOT NULL DEFAULT 0,  -- LLM 调整段不覆盖
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scene_sched ON scene_schedule_entries(player_id, character_id, day_key, start_time);
-- 生成：ensureSceneDay 按北京 0 点整日生成，INSERT OR IGNORE；LLM 调整段 is_llm_edited=1 不覆盖
```

### 公共NPC人设页：评论
```sql
CREATE TABLE IF NOT EXISTS character_comments (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_char_comments ON character_comments(character_id, created_at);
```

### 公共NPC人设页：点赞
```sql
CREATE TABLE IF NOT EXISTS character_likes (
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (character_id, player_id)
);
```

### 公共NPC人设修改历史
```sql
CREATE TABLE IF NOT EXISTS character_edit_log (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  editor_type   TEXT NOT NULL,  -- 'admin' | 'player_suggestion'
  editor_id     TEXT,
  field         TEXT NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  status        TEXT NOT NULL DEFAULT 'applied',  -- applied/pending/rejected
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edit_log ON character_edit_log(character_id, created_at);
```

### 玩家描述变更记录
```sql
-- 每次player_description变更时记录，支持撤回回滚
-- 撤回消息时：删除该消息之后的description_changes，回滚到撤回前的描述
-- 角色任务中：source_type='dream'，character_id存当前NPC的ID（镜像NPC无独立ID），
--   character_instance_id存NULL（任务世界不创建instance）。
--   镜像期间的player_description变更不写本表（只存在于任务session临时空间），
--   做梦后由LLM生成唯一一条player_description更新写入本表
CREATE TABLE IF NOT EXISTS description_changes (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  source_type   TEXT NOT NULL,   -- 'sms' | 'conversation' | 'dream'
  source_id     TEXT NOT NULL,   -- message id 或 mission id
  old_description TEXT NOT NULL,
  new_description TEXT NOT NULL,
  character_instance_id TEXT REFERENCES character_instances(id),  -- NULL=角色任务梦境变更
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_desc_changes ON description_changes(player_id, character_id, created_at);
```

### PlayerFacts — NPC对玩家的记忆
```sql
-- NPC记住玩家在约会/短信中说过的话、透露的信息
-- prompt-builder读取后注入NPC system prompt，让NPC"记住"玩家
-- 不是全量对话历史，是LLM提取的关键事实（"她喜欢肉桂卷""她提到过有个妹妹"）
CREATE TABLE IF NOT EXISTS player_facts (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL,
  character_instance_id TEXT REFERENCES character_instances(id),
  fact          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'conversation',  -- 'conversation' | 'sms' | 'creator'
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_facts ON player_facts(player_id, character_id);
```

### 向量索引 — 记忆检索用
```sql
-- 记忆检索架构的embedding存储（见OPEN_QUESTIONS.md #4）
-- 每条 player_fact / chronicle / scene_message / turn_player_fact 入库时算 embedding 存表
-- 检索时按语义相似度命中，768维（bge-base-zh-v1.5）
-- 三路分开搜：约会摘要(chronicle+turn_date_summary) / 玩家事实(fact+turn_player_fact) / 对话原文(scene_message)
-- turn_overview 不进搜索（历史版本在 scene_round_snapshots.overviews 供撤回用）
-- 向量存为BLOB，应用层计算余弦相似度
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,   -- 'fact' | 'chronicle' | 'turn_player_fact' | 'turn_overview' | 'turn_date_summary' | 'turn_segment' | 'scene_message' | 'moment'
  source_id     TEXT NOT NULL,   -- 对应表的记录ID
  character_id  TEXT NOT NULL,
  content_text  TEXT NOT NULL,   -- 被向量化的原文（便于检索后直接注入prompt）
  embedding     BLOB NOT NULL,   -- 768维float向量，序列化为BLOB
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_emb ON memory_embeddings(player_id, character_id, source_type);
```

### 朋友圈
```sql
-- 酒馆模式：每个玩家只看到自己+自己好友NPC的朋友圈
-- NPC帖子是 per-player 的，与 schedule/presence 一致
-- trigger_type记录发帖触发原因：date_end(约会结束) / mission_end(任务完成) / schedule(行程中) / random(随机) / player(玩家手动发)
CREATE TABLE IF NOT EXISTS moments (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,  -- 帖子所属的玩家视图（酒馆模式：每个玩家有独立的朋友圈feed）
  author_type   TEXT NOT NULL,   -- 'player' | 'character'
  author_id     TEXT NOT NULL,   -- player_id 或 character_id（多态，不建FK）
  content       TEXT NOT NULL DEFAULT '',
  ⚡image_path  TEXT,                             -- 帖子附图路径（相对uploads目录），NPC评论时以多模态格式看到图片
  mood          TEXT NOT NULL DEFAULT '',        -- NPC发帖时LLM输出的心情标记
  location_name TEXT NOT NULL DEFAULT '',        -- 发帖时的位置名称（NPC行程上下文）
  trigger_type  TEXT NOT NULL DEFAULT 'player',  -- 'player' | 'date_end' | 'mission_end' | 'schedule' | 'random'
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_feed ON moments(player_id, created_at);

-- 朋友圈互动（点赞 + 评论统一存储）
CREATE TABLE IF NOT EXISTS moment_interactions (
  id              TEXT PRIMARY KEY,
  moment_id       TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  author_type     TEXT NOT NULL,   -- 'player' | 'character'
  author_id       TEXT NOT NULL,   -- player_id 或 character_id（多态，不建FK）
  interaction_type TEXT NOT NULL,  -- 'like' | 'comment'
  body            TEXT NOT NULL DEFAULT '',  -- 评论文本（like为空）
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moment_interactions ON moment_interactions(moment_id, interaction_type);
-- 防止重复点赞：同一作者对同一帖子只能like一次
CREATE UNIQUE INDEX IF NOT EXISTS idx_moment_like_unique ON moment_interactions(moment_id, author_id, interaction_type) WHERE interaction_type = 'like';
-- 点赞是 toggle：玩家重复点赞 = 取消（DELETE已有like记录）
-- NPC评论/点赞异步生成，走各自的 characterData + prompt-builder
```

---

## 三、功能建议 & 更新日志

### 功能建议
```sql
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
```

### 建议互动（点赞 + 评论，与朋友圈模式一致）
```sql
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
```

### 更新日志
```sql
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
```

---

## 四、地点探索

### 探索session
```sql
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
```

### 探索消息
```sql
-- 只有player（玩家输入）和narration（世界旁白）两种角色
CREATE TABLE IF NOT EXISTS explore_messages (
  id                TEXT PRIMARY KEY,
  explore_session_id TEXT NOT NULL REFERENCES explore_sessions(id) ON DELETE CASCADE,
  role              TEXT NOT NULL,  -- 'player' | 'narration'
  text              TEXT NOT NULL,
  metadata          TEXT NOT NULL DEFAULT '{}',  -- 存found_item等事件标记
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explore_messages ON explore_messages(explore_session_id, created_at);
```

---

## 五、玩家剧本系统

### scenarios — 剧本
```sql
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
  npc_role      TEXT NOT NULL DEFAULT '',          -- NPC世界身份+能力（单人剧本用，可选，空=没特殊身份）
  ⚡npc_roles    TEXT NOT NULL DEFAULT '[]',        -- 多人剧本角色槽位（JSON数组，空=单人剧本）（migration追加）
  opening_scene TEXT NOT NULL DEFAULT '',          -- 开局情境（可选）
  greeting      TEXT NOT NULL DEFAULT '',          -- 开场白（可选，NPC的第一句话）
  goal          TEXT NOT NULL DEFAULT '',          -- 目标（可选，文字描述）
  stats_config  TEXT NOT NULL DEFAULT '[]',        -- 数值系统（可选，JSON数组）
  status        TEXT NOT NULL DEFAULT 'draft',     -- draft/published
  play_count    INTEGER NOT NULL DEFAULT 0,        -- 被玩次数
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenarios_author ON scenarios(author_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_published ON scenarios(status, created_at);
```

### scenario_sessions — 剧本会话
```sql
-- 剧本会话：玩家进入剧本后的session
-- 复用conversation_sessions的消息表（messages），但用独立的session表管理剧本特有数据
-- copy_id指向NPC副本（已废弃，保留兼容），结束后副本的总结生成"梦"存回原NPC记忆
CREATE TABLE IF NOT EXISTS scenario_sessions (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id    TEXT NOT NULL,                   -- 玩家选的NPC（单人剧本用，多人剧本存第一个角色）
  ⚡character_ids TEXT NOT NULL DEFAULT '[]',       -- 多人剧本参与的NPC列表（JSON数组，空=单人）（migration追加）
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
```

---

## 五·五、场景约会引擎（scene engine，v2 核心）

> 场景约会（地图上的实景约会/出行/探索）用独立的 `scene_*` 表族，与老的单聊/群聊约会（`conversation_sessions` + `messages`）并存。核心思想：**地点（scene_locations）挂载路人、住所、可活动**，约会以「场景会话（scene_sessions）→ 多轮（scene_messages）」组织，并带**导演/演员双角色 prompt 体系**（见 PROMPTS.md）。
> 这些表大多为运行时/迁移动态创建（不全在 schema.ts），DDL 以实际库为准。

### scene_locations — 场景地点（地图节点）
```sql
CREATE TABLE scene_locations (
  id                    TEXT PRIMARY KEY,
  world_id              TEXT NOT NULL,
  name                  TEXT NOT NULL,
  summary               TEXT NOT NULL DEFAULT '',
  creator_type          TEXT NOT NULL DEFAULT 'system',  -- 'system' | 'player'
  creator_id            TEXT,                             -- 玩家创建者（私有地点归属）
  character_instance_id TEXT,                             -- 绑定NPC副本（住所等）
  is_public             INTEGER NOT NULL DEFAULT 1,       -- 1公共(人人可编辑/可逛) 0私有(仅creator可编辑)
  created_at            INTEGER NOT NULL,
  home_of               TEXT,                             -- 废弃遗留
  parent_id             TEXT,                             -- 父地点(嵌套层级,子地点挂在父下)
  npcs                  TEXT NOT NULL DEFAULT '[]',       -- 路人JSON数组 [{"role":"服务生","name":"小周","persona":"..."}]
  updated_at            INTEGER NOT NULL,
  activities            TEXT NOT NULL DEFAULT '[]',       -- 可活动列表
  background_image      TEXT,                             -- 背景图(cover适配,不裁剪)
  background_submitted  TEXT NOT NULL DEFAULT '[]'        -- 玩家提交的背景图候选
);
-- 归属规则：公共地点(is_public=1)人人可编辑路人/背景；私有地点(is_public=0)仅 creator_id 可编辑
```

### scene_sessions — 场景会话（一次实景约会）
```sql
CREATE TABLE scene_sessions (
  id                  TEXT PRIMARY KEY,
  player_id           TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  scene_type          TEXT NOT NULL,          -- 'date' | 'scenario'
  root_location_id    TEXT REFERENCES scene_locations(id) ON DELETE SET NULL,
  character_ids       TEXT NOT NULL DEFAULT '[]',
  round_no            INTEGER NOT NULL DEFAULT 0,
  stats_state         TEXT NOT NULL DEFAULT '{}',
  stats_config        TEXT NOT NULL DEFAULT '[]',
  ended               INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  circumstance        TEXT,                   -- 开场情境(greeting分节选择)
  current_location_id TEXT REFERENCES scene_locations(id) ON DELETE SET NULL,
  -- 以下 10 列为剧本字段（scene_type='scenario' 时使用）
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
```

> **开启约会的幂等语义（「连点两下同一按钮」）**：`POST /scene/start` 对**同地点 + 同角色集（顺序无关）**的进行中（`ended=0`）约会**无缝复用**——直接返回既有 `sessionId`（200），不新建、不报错、不留孤儿。只有**确实不同**的现场才 409 弹窗让玩家选「继续原现场」或「结束进入新的」。检查 + 插入在同一事务内（原子），并由 Node 单线程 + 单 db 连接 + 同步 SQL 天然串行化。

### scene_messages — 场景回合消息
```sql
CREATE TABLE scene_messages (
  id                TEXT PRIMARY KEY,
  scene_session_id  TEXT NOT NULL REFERENCES scene_sessions(id) ON DELETE CASCADE,
  round_no          INTEGER NOT NULL,
  role              TEXT NOT NULL,
  character_id      TEXT,
  character_name    TEXT NOT NULL,
  text              TEXT NOT NULL,
  stats_delta       TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  quote             TEXT,                       -- 引用的上一条消息(归因锚)
  internal          TEXT NOT NULL DEFAULT '',   -- 导演内心独白
  internal_notable  BOOLEAN NOT NULL DEFAULT 0
);
```

### scene_homes — 角色住所关联（子地点挂住所）
```sql
CREATE TABLE scene_homes (
  location_id  TEXT NOT NULL,
  character_id TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (location_id, character_id)
);
```

### scene_relationships — 场景内关系（NPC对玩家的感觉延续）
```sql
CREATE TABLE scene_relationships (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL,
  scene_session_id  TEXT REFERENCES scene_sessions(id) ON DELETE SET NULL,   -- 跨场延续：删 session 置 NULL，关系不删
  player_description TEXT NOT NULL DEFAULT '刚认识的陌生人',
  current_activity  TEXT NOT NULL DEFAULT '',           -- 角色当前活动/目的（如"在咖啡馆闲聊"），防止场景停滞。演员每拍可更新。
  updated_at        INTEGER NOT NULL
);
```

### scene_round_snapshots — 回合开始前快照（回滚用）
```sql
CREATE TABLE scene_round_snapshots (
  id               TEXT PRIMARY KEY,
  scene_session_id TEXT NOT NULL REFERENCES scene_sessions(id) ON DELETE CASCADE,
  round_no         INTEGER NOT NULL,           -- 这一轮【开始前】的状态
  stats_state      TEXT NOT NULL DEFAULT '{}',
  relationships    TEXT NOT NULL DEFAULT '[]', -- [{characterId, playerDescription, currentActivity}] 本场参与角色
  overviews        TEXT NOT NULL DEFAULT '[]', -- [{characterId, foldId, summary}] 长期总览原文
  created_at       INTEGER NOT NULL
);
```

### scene_schedule_entries — NPC行程（v2，与地图/短信/场景约会同一数据源）
> 已在第三节「NPC行程（v2 新表）」L500 记录，此处仅列关键点：`is_llm_edited` 标记 LLM/玩家编辑，重生成不得覆盖。

### scene_start_snapshot — 场景开始快照
```sql
CREATE TABLE scene_start_snapshot (
  scene_session_id TEXT PRIMARY KEY REFERENCES scene_sessions(id) ON DELETE CASCADE,
  player_id        TEXT NOT NULL,
  character_ids    TEXT NOT NULL DEFAULT '[]',
  stats_state      TEXT NOT NULL DEFAULT '{}',
  relationships    TEXT NOT NULL DEFAULT '[]',  -- [{characterId, playerDescription, currentActivity}]
  created_at       INTEGER NOT NULL
);
```

### scene_explore_sessions — 场景探索会话（一次性、纯内存体验）
```sql
CREATE TABLE scene_explore_sessions (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  location_id       TEXT,
  ended             INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
-- 探索=一次性纯内存(explore-store)，离开即结束；约会才跨页延续
```

### scene_explore_messages — 探索消息
```sql
CREATE TABLE scene_explore_messages (
  id                   TEXT PRIMARY KEY,
  explore_session_id   TEXT NOT NULL REFERENCES scene_explore_sessions(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL,   -- 'narration' | 'player' | 'item' | 'encounter'
  text                 TEXT NOT NULL,
  metadata             TEXT NOT NULL DEFAULT '{}',
  created_at           INTEGER NOT NULL
);
```

### turn_memory_fold — 场景内记忆折叠（回合级）
```sql
CREATE TABLE turn_memory_fold (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  scene_session_id  TEXT NOT NULL REFERENCES scene_sessions(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL,     -- 归属角色（或 '__director__' 导演场记）
  fold_type         TEXT NOT NULL,     -- 'segment' 单轮摘要 / 'overview' 长期总览 / 'date_summary' 约会摘要
  round_min         INTEGER,
  round_max         INTEGER,
  summary           TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);
```

> **回滚守卫（与回滚的一致性）**：记忆折叠（`turn_memory_fold` / `turn_player_facts`）在回合 COMMIT 后**异步**（fire-and-forget）执行。若期间该轮已被 `rollbackScene` 撤回（删除 `scene_messages round_no>=target`），折叠前会检查该轮 `scene_messages` 是否仍存在——被回退则跳过写入，避免把已回退轮的**幽灵记忆**折回已删位置。

### turn_player_facts — 场景内 PlayerFacts（NPC对玩家记忆）
> `scene_session_id` 允许 NULL：手动添加的事实（POST /facts）无场景来源，存 NULL；有场景来源的存真实 session id，删 session 时级联删。
```sql
CREATE TABLE turn_player_facts (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL,
  scene_session_id  TEXT REFERENCES scene_sessions(id) ON DELETE CASCADE,
  round_no          INTEGER NOT NULL,
  fact              TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
```

### llm_call_log — LLM 调用日志（全留痕，调试/AB测试数据源）
> 记录每次 LLM 生产调用，供调试、归因、AB 测试取样（用户记忆：AB 测试须用真实样本，llm_call_log 是权威来源）。
```sql
CREATE TABLE llm_call_log (
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
```

---

### image_blobs — 图片二进制存储（2026-08-07：图片从裸文件系统迁入数据库，防止文件散失）
> 原图片写磁盘 `data/uploads/` 目录，改存数据库，杜绝文件散失/迁移丢失。`id` 即原 uploads 文件名（`{playerId}_{ts}_{rand}.{ext}`），与 `character_data.avatar` 字段引用值无缝兼容。
```sql
CREATE TABLE image_blobs (
  id         TEXT PRIMARY KEY,   -- 即原 uploads 文件名（如 {playerId}_{ts}_{rand}.png），与 avatar 字段引用无缝兼容
  data       BLOB NOT NULL,      -- 图片二进制
  mimetype   TEXT NOT NULL,
  size       INTEGER NOT NULL,   -- 字节数
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_image_blobs_created ON image_blobs(created_at);
```
- **写入**：`routes/upload.ts` 上传时 `INSERT` 进表（不再写磁盘）；返回 `imagePath=filename` 供 `character_data.avatar` 引用。
- **读取**：`routes/image.ts` 从表读 `data`+`mimetype` 返回（`<img>` 用 token query 认证）。
- **兜底**：`lib/character.ts` 的 `safeAvatar(filename)` 全局统一出口——文件在表中不存在（缺失/被删）→ 返回空串，前端回退首字头像，避免 `<img>` 指向破图。`getCharacterAvatar` / `getPublicAvatar` 都经它。
- **存量迁移**：`src/scripts/migrate-images-to-db.ts`（独立 node 进程、不停服）把 uploads 目录现存文件读入表；统计"被引用但磁盘也缺失（无法找回）"的数量。不删磁盘文件。
- **路径穿越**：`image.ts` 只取 `basename` 再查表，天然无穿越风险。

---

## 五·六、互动小说共写引擎（novel，2026-08-27）

> 完全隔离于约会体系：小说角色不进 `characters`/`character_instances`/`friendships`/`relationships`，不参与行程/主动消息/朋友圈。主角=玩家本人（名字读 `players.name`，第三人称代词跟 `players.gender`），不单独存字段。

### novels — 小说（对齐剧本 scenarios 的创建/归属模型）

```sql
CREATE TABLE novels (
  id                  TEXT PRIMARY KEY,
  author_id           TEXT REFERENCES players(id) ON DELETE SET NULL,  -- 创建者，玩家删号置 NULL，小说保留
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT '',          -- 一句话简介（列表页）
  world_setting       TEXT NOT NULL DEFAULT '',          -- 世界观/背景设定
  protagonist_setting TEXT NOT NULL DEFAULT '',          -- 玩家身份/处境
  opening             TEXT NOT NULL DEFAULT '',          -- 开场文本
  cover_url           TEXT,                              -- 封面图（可选）
  status              TEXT NOT NULL DEFAULT 'draft',     -- draft/published
  play_count          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_novels_author ON novels(author_id);
CREATE INDEX idx_novels_status ON novels(status, created_at);
```

### novel_characters — 小说角色（简单人设，不是完整角色卡）

```sql
CREATE TABLE novel_characters (
  id              TEXT PRIMARY KEY,
  novel_id        TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  gender          TEXT NOT NULL DEFAULT '',            -- 'female'/'male'/''（空=LLM自由发挥）
  persona         TEXT NOT NULL DEFAULT '',            -- 简单人设：性格/说话风格/关系/底线/秘密
  emotional_anchor TEXT NOT NULL DEFAULT '',           -- 情绪表达锚点：负面情绪下的身体语言（独立于人设，OOC 修复）
  appearance      TEXT NOT NULL DEFAULT '',            -- 外貌描述（供配图 + LLM 描写外貌）
  avatar          TEXT NOT NULL DEFAULT '',            -- 头像（image_blobs 文件名）
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_novel_chars ON novel_characters(novel_id);
```

### novel_sessions — 故事线（多周目：一局一条，同小说最多一条 active）

```sql
CREATE TABLE novel_sessions (
  id             TEXT PRIMARY KEY,
  player_id      TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  novel_id       TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'active',   -- active/ended
  excluded_chars TEXT NOT NULL DEFAULT '[]',       -- JSON 数组：被点暗（不参与剧情）的角色 id
  story_overview TEXT NOT NULL DEFAULT '',         -- 故事总览（三折叠长期层，增量更新）
  overview_upto  INTEGER NOT NULL DEFAULT 0,       -- 总览已折进到第几段，防重复折叠
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_novel_sessions ON novel_sessions(player_id, novel_id);
```

### novel_turns — 段落（接力写正文）

```sql
CREATE TABLE novel_turns (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES novel_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,                       -- 'player' 玩家原文 / 'assistant' AI 续写
  text       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',            -- 段摘要（三折叠中期层；空=未折叠，只保留悬念/线索）
  time       TEXT NOT NULL DEFAULT '',            -- 该段发生时间（「第N天·时段」，防时段漂移）
  display    INTEGER NOT NULL DEFAULT 1,          -- 是否显示（润色开的玩家草稿=0）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_novel_turns ON novel_turns(session_id, created_at);
```

- 正文 = 按时间序拼接所有 `display=1` 的段落。
- 润色是独立功能：polish 接口只返回润色结果、不落库；玩家采纳后随续写一起落库。

---

## 六、已知问题与设计决策

### 多态FK
以下表的 `character_id` 是多态：可能是 `characters.id` 或 `character_player_data.id`，不建FK，靠应用层校验：
`friendships`、`npc_schedules`、`description_changes`、`message_threads`、`relationships`、`chronicles`、`player_facts`、`character_permissions`、`permission_transactions`、`missions`、`memory_embeddings`、`moments`、`moment_interactions`

其中 `message_threads` 和 `conversation_sessions` 的 `character_id` 还可能是 `'DEITY'`（主神）。主神不进好友/行程/权限/任务/记忆，其余表永远不会出现 `'DEITY'`。

`character_instances` 的 `source_character_id` 是真FK到 `characters(id)`，`character_data_id` 是多态（`characters.id` 或 `character_player_data.id`），两者都不含 `'DEITY'`。

**风险**：级联删除不工作，删角色会留孤儿数据。

**缓解**：应用层删除角色时手动清理所有关联表记录。不完全靠数据库约束。详见 OPEN_QUESTIONS.md #3。

### FK 级联策略汇总

以下表对 `players(id)` 的外键引用策略：

| 表 | 级联策略 | 说明 |
|----|----------|------|
| invite_codes | ON DELETE CASCADE | 玩家删除时邀请码一起删 |
| sessions | ON DELETE CASCADE | 玩家删除时登录会话一起删 |
| character_instances | ON DELETE CASCADE | 玩家删除时所有NPC副本一起删 |
| relationships | ON DELETE CASCADE | 玩家删除时关系记录一起删 |
| conversation_sessions | ON DELETE CASCADE | 玩家删除时会话一起删 |
| message_threads | ON DELETE CASCADE | 玩家删除时短信线程一起删 |
| emails | ON DELETE CASCADE | 玩家删除时邮件一起删 |
| chronicles | ON DELETE CASCADE | 玩家删除时编年史一起删 |
| player_permissions | ON DELETE CASCADE | 玩家删除时权限余额一起删 |
| character_permissions | ON DELETE CASCADE | 玩家删除时NPC权限钱包一起删 |
| permission_transactions | ON DELETE CASCADE | 玩家删除时权限交易日志一起删 |
| missions | ON DELETE CASCADE | 玩家删除时任务一起删 |
| character_player_data | ON DELETE CASCADE | 玩家删除时私有NPC数据一起删 |
| creator_sessions | ON DELETE CASCADE | 玩家删除时角色创建会话一起删 |
| friendships | ON DELETE CASCADE | 玩家删除时好友关系一起删 |
| npc_schedules | ON DELETE CASCADE | 玩家删除时NPC行程一起删 |
| character_comments | ON DELETE CASCADE | 玩家删除时评论一起删 |
| character_likes | ON DELETE CASCADE | 玩家删除时点赞一起删 |
| description_changes | ON DELETE CASCADE | 玩家删除时描述变更记录一起删 |
| player_facts | ON DELETE CASCADE | 玩家删除时NPC对玩家的记忆一起删 |
| memory_embeddings | ON DELETE CASCADE | 玩家删除时向量索引一起删 |
| moments | ON DELETE CASCADE | 玩家删除时朋友圈帖子一起删 |
| explore_sessions | ON DELETE CASCADE | 玩家删除时探索会话一起删 |
| scenarios | ON DELETE CASCADE（author_id） | 作者删除时剧本一起删 |
| scenario_sessions | ON DELETE CASCADE | 玩家删除时剧本会话一起删 |
| suggestions | ON DELETE SET NULL（player_id） | 玩家删除时建议保留，提交者置NULL |
| characters | ON DELETE SET NULL（creator_player_id） | 玩家删除时创建的NPC保留，创建者置NULL |

其他重要级联：
- `worlds(id)` → `locations` ON DELETE CASCADE
- `locations(id)` → `location_homes` / `location_npc_access` / `npc_schedules` / `explore_sessions` ON DELETE CASCADE
- `locations(id)` → `conversation_sessions.location_id` ON DELETE SET NULL（会话保留）
- `locations(id)` 自引用 `parent_id` ON DELETE CASCADE（子地点级联删除）
- `character_instances(id)` → `locations.character_instance_id` ON DELETE CASCADE
- `characters(id)` → `character_instances.source_character_id` / `character_player_data.source_character_id` ON DELETE SET NULL
- `characters(id)` → `location_npc_access` / `character_comments` / `character_likes` / `character_edit_log` ON DELETE CASCADE
- `conversation_sessions(id)` → `messages` / `session_participants` ON DELETE CASCADE
- `message_threads(id)` → `text_messages` ON DELETE CASCADE
- `moments(id)` → `moment_interactions` ON DELETE CASCADE
- `scenarios(id)` → `scenario_sessions` ON DELETE CASCADE
- `suggestions(id)` → `suggestion_interactions` ON DELETE CASCADE
- `explore_sessions(id)` → `explore_messages` ON DELETE CASCADE

### 关系状态
`relationships` 表存 `player_description` 字段（NPC对玩家的一句话定性）。没有好感度数值、没有emotion数值。NPC态度由记忆+player_description驱动，LLM读文本判断。`description_changes` 表记录每次描述变更，支持撤回回滚。

### npc_schedules 的 player_id
行程是 per-player 的——酒馆系统下每个玩家有独立的世界视图，公共NPC对不同玩家可以显示不同位置。基础行程（deterministic hash生成，hash seed含player_id）不需要存表，只有LLM调整后的行程才持久化到 npc_schedules，因此每条记录都带 player_id。

### 无active instance的NPC行程过滤
行程生成时检查NPC是否有active instance——无active instance的NPC（被放逐且没有其他副本）不进入行程计算。这是应用层逻辑，不靠数据库约束。

### 主神数据表示
主神在 `message_threads` 和 `conversation_sessions` 中 `character_id` 存固定值 `'DEITY'`，不建 `characters` 表记录。后端识别此值跳过NPC prompt-builder，改用 `deity.system` prompt。0号NPC，工具人定位——"是什么"不重要，为玩法服务。

---

## Migration 记录

数据库变更按时间顺序记录，供恢复和同步用。代码中的 migration 在 `apps/server/src/db/index.ts` 启动时自动执行（ALTER TABLE ... ADD COLUMN + CREATE INDEX IF NOT EXISTS）。
migration 版本管理通过 `schema_migrations` 表实现，每条 migration 有唯一 id，执行成功后记录，不会重复执行。

> 注：`SCHEMA_SQL`（旧系统 41 张表）与 `SCENE_SCHEMA_SQL`（场景引擎 10 张表）是新库建表的权威定义，两者都在所有 migration 之前执行。对已有库，`CREATE TABLE IF NOT EXISTS` 不会修改表结构，因此后续新增列通过 migration 的 `ALTER TABLE` 追加。下表记录了所有 migration 追加的列和结构变更。

### locations 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表：id, world_id, name, summary, creator_type, creator_id, character_instance_id, is_public, parent_id, created_at | schema.ts |
| 2026-07 | 加 `home_of TEXT` 列（标记角色住所） | db/index.ts migration |
| 2026-08-02 | 加 `parent_id` 列已纳入 SCHEMA_SQL（新库直接建） | schema.ts |
| 2026-08 | `home_of` 废弃，数据迁移至 `location_homes` 多对多关联表 | db/index.ts migration |

### conversation_sessions 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表 | schema.ts |
| 2026-07 | 加 `mission_id TEXT` 列（任务系统） | db/index.ts migration |
| 2026-07 | 加 `current_location_id TEXT` 列（约会中移动后的实时地点） | db/index.ts migration |
| 2026-08-03 | 加 `is_group INTEGER NOT NULL DEFAULT 0` 列（群聊约会标记）+ `mode` 值增加 `'group'` | db/index.ts migration |
| 2026-08 | 加 `scenario_session_id TEXT` 列（剧本会话关联） | db/index.ts migration |

### session_participants 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 2026-08-03 | 建表（群聊约会参与者关联） | schema.ts |

### messages 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表：含 internal, internal_notable, internal_viewed, image_path | schema.ts |
| 2026-08-03 | 加 `speaker TEXT` 列（群聊NPC标识） | db/index.ts migration |

### chronicles 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表：含 source, summary_type | schema.ts |
| 2026-07 | 加 `msg_start INTEGER` / `msg_end INTEGER` 列（已总结范围标记，滚动折叠用） | db/index.ts migration |
| 2026-08 | 加 `source TEXT NOT NULL DEFAULT 'conversation'` / `summary_type TEXT` 列（区分来源和摘要类型） | db/index.ts migration |

### relationships 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表 | schema.ts |
| 2026-07 | 加 `created_at INTEGER NOT NULL DEFAULT 0` 列（初次相遇时间） | db/index.ts migration |
| 2026-07 | 加 `next_message_eligible_at INTEGER NOT NULL DEFAULT 0` 列（NPC主动消息意愿积累，**已废弃**） | db/index.ts migration |
| 2026-07 | 加 `last_schedule_slot INTEGER NOT NULL DEFAULT 0` 列（行程变更检测） | db/index.ts migration |
| 2026-08 | 加 `sms_urge REAL NOT NULL DEFAULT 0` 列（短信意愿累积，替代 next_message_eligible_at） | db/index.ts migration `relationships_urge` |
| 2026-08 | 加 `moment_urge REAL NOT NULL DEFAULT 0` 列（朋友圈意愿累积） | db/index.ts migration `relationships_urge_moment` |
| 2026-08 | 加 `last_task_invite_day TEXT` 列（NPC任务每日邀请上限，北京日 key） | db/index.ts migration `relationships_last_task_invite` |

### players 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表：含 gender, appearance, is_admin | schema.ts |
| 2026-07 | 加 `gender TEXT NOT NULL DEFAULT 'female'` / `appearance TEXT NOT NULL DEFAULT ''` 列 | db/index.ts migration |

### missions 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表 | schema.ts |
| 2026-08 | 加 `metadata TEXT NOT NULL DEFAULT '{}'` 列（存储 item/obsession 等结构化数据） | db/index.ts migration |
| 2026-08 | 加 `solo_complete_at INTEGER` 列（NPC任务玩家拒绝后独自完成时刻） | db/index.ts migration `missions_solo_complete_at` |

### text_messages 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表：含 internal, internal_notable, internal_viewed, metadata | schema.ts |

### location_npc_access 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表（PK=id，一个NPC在一个地点可有多条活动描述） | schema.ts |

### location_homes 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 2026-08 | 建表（替代 locations.home_of，多对多关联） | schema.ts + db/index.ts 数据迁移 |

### scenario_sessions 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表 | schema.ts |
| 2026-08 | `copy_id` 改为可空（NOT NULL → NULL），重建表 | db/index.ts migration |
| 2026-08 | 加 `character_ids TEXT NOT NULL DEFAULT '[]'` 列（多人剧本NPC列表） | db/index.ts migration `scenario_sessions_character_ids` |

### scenarios 表

| 时间 | 变更 | 代码位置 |
|------|------|----------|
| 初始 | 建表 | schema.ts |
| 2026-08 | 加 `npc_roles TEXT NOT NULL DEFAULT '[]'` 列（多人剧本角色槽位） | db/index.ts migration `scenarios_npc_roles` |
| 2026-08 | 加 `ambient_config TEXT NOT NULL DEFAULT ''` 列（气氛组配置，空=不配） | db/index.ts migration `scenarios_ambient_config` |
| 2026-08 | 加 `greetings TEXT NOT NULL DEFAULT '[]'` 列（多人剧本分角色开场白） | db/index.ts migration `scenarios_greetings` |

### scene 引擎表（scene_sessions / scene_messages / scene_relationships / scene_locations / scene_homes / scene_schedule_entries / scene_start_snapshot / scene_round_snapshots / turn_memory_fold / turn_player_facts）

> 这 10 张表原本散在 scene-session.ts / scene-map.ts / scene-rollback.ts / turn-memory.ts 里「惰性建表」（第一次用到才建）。2026-08-13 统一收拢到 `lib/scene-schema.ts` → `SCENE_SCHEMA_SQL`，由 db/index.ts 启动时（SCHEMA_SQL 之后、所有 migration 之前）执行一次（见 REVIEW_V4.md 🔴-1）。

| 表 | 时间 | 变更 | 代码位置 |
|------|------|------|----------|
| scene_sessions | 2026-08-13 | 建表（含全字段，见上方 DDL） | lib/scene-schema.ts SCENE_SCHEMA_SQL |
| | 2026-08 | 加 `circumstance` 列（开场情境） | db/index.ts migration `scene_sessions_circumstance` |
| | 2026-08 | 加 `current_location_id` 列（约会内实时地点） | db/index.ts migration `scene_sessions_current_location_id` |
| | 2026-08 | 加 10 个剧本字段 | db/index.ts migration `scene_sessions_scenario_fields` |
| scene_messages | 2026-08-13 | 建表 | lib/scene-schema.ts |
| | 2026-08 | 加 `quote` 列（引用回复 JSON） | db/index.ts migration `scene_messages_quote` |
| scene_relationships | 2026-08-13 | 建表 + `scene_session_id` 加 FK（ON DELETE SET NULL，保跨场延续） | lib/scene-schema.ts |
| scene_locations | 2026-08-13 | 建表（含 activities/background_image/background_submitted 全字段） | lib/scene-schema.ts |
| scene_homes | 2026-08-13 | 建表（角色→家） | lib/scene-schema.ts |
| scene_schedule_entries | 2026-08-13 | 建表（含索引，从 migration 上移统一建表） | lib/scene-schema.ts |
| scene_start_snapshot | 2026-08-13 | 建表（场基线快照） | lib/scene-schema.ts |
| scene_round_snapshots | 2026-08-13 | 建表（轮滚动快照） | lib/scene-schema.ts |
| turn_memory_fold | 2026-08-13 | 建表 + `scene_session_id` 加 FK（ON DELETE CASCADE，session 数据跟随删） | lib/scene-schema.ts |
| turn_player_facts | 2026-08-13 | 建表 + `scene_session_id` 加 FK（ON DELETE CASCADE） | lib/scene-schema.ts |
| turn_player_facts | 2026-08-16 | `scene_session_id` 改允许 NULL（手动添加事实无场景来源）+ 补 FK，孤儿/空串转 NULL | db/index.ts migration `turn_player_facts_scene_session_nullable` |

---

## 数据库备份

- **生产库**：`apps/server/data/infinite-date.sqlite`（启动时自动建，默认路径）
- **备份库**：`data/infinite-date.sqlite.bak`（手动拷贝，每次大改后更新）
- **旧库（废弃）**：`data/infinite-date.sqlite`（早期开发用的，只有3个角色，不要连）
- WAL 模式：备份前先 `PRAGMA wal_checkpoint(TRUNCATE)` 确保 WAL 写入主库
