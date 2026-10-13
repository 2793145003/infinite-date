/**
 * QQ 桥接（PoC）专用表
 *
 * 设计约束（星落的要求：生产改动必须先离线验证）：
 *  1. 全部是**新增表**，不写进服务端 db/schema.ts，主服务完全不感知；
 *  2. 只在桥进程启动时创建（CREATE TABLE IF NOT EXISTS，幂等），
 *     所以主服务单独跑时数据库里不会多出这些表；
 *  3. 出站靠**只读轮询** text_messages，不在 saveNpcReply / proactive 里加钩子
 *     —— 桥挂了、跑错了都不会影响线上写入路径。
 */
import type { DatabaseSync } from 'node:sqlite';

export const QQ_BRIDGE_SCHEMA_SQL = `
-- ═══ 绑定：(玩家, 角色) 一对一 —— 一个角色最多绑一个 QQ 机器人 ═══
-- 一个机器人也只能绑一个角色：UNIQUE(app_id) 保证不会出现「一个 bot 当两个男主」，
-- 这从库层面堵死了串线的可能。
CREATE TABLE IF NOT EXISTS qq_bot_bindings (
  id                TEXT PRIMARY KEY,
  player_id         TEXT NOT NULL,
  character_id      TEXT NOT NULL,
  app_id            TEXT NOT NULL,                    -- QQ 机器人 AppID
  app_secret_enc    TEXT NOT NULL,                    -- AppSecret（加密存储，禁止落日志）
  user_openid       TEXT,                             -- 玩家在这个机器人下的 openid（入站首条消息时回填）
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | active | invalid
  proactive_enabled INTEGER NOT NULL DEFAULT 0,       -- 玩家是否在机器人资料卡开了「主动消息」开关
  access_token      TEXT,                             -- 缓存的 AppAccessToken
  access_token_exp  INTEGER NOT NULL DEFAULT 0,       -- 过期时间戳（ms）
  last_inbound_msg_id TEXT,                           -- 玩家最近一条消息的 msg_id
  last_inbound_at   INTEGER NOT NULL DEFAULT 0,       -- 用于判断能否走「被动消息」（5 分钟窗口）
  since_ts          INTEGER NOT NULL DEFAULT 0,       -- 只外发这个时刻之后的消息（绑定时定为"此刻"）
  welcomed_at       INTEGER,                          -- 接入后那条「他主动开口」的发过没有（防重复）
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(player_id, character_id),
  UNIQUE(app_id)
);
CREATE INDEX IF NOT EXISTS idx_qq_bindings_player ON qq_bot_bindings(player_id);

-- ═══ 出站队列 ═══
-- 主键直接用 text_messages.id：一条短信最多外发一次，幂等由库保证而不是靠代码判断。
CREATE TABLE IF NOT EXISTS qq_outbox (
  msg_id      TEXT PRIMARY KEY,                     -- text_messages.id
  binding_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                        -- text | image
  content     TEXT NOT NULL DEFAULT '',              -- 文本正文 / 图片 assetId
  status      TEXT NOT NULL DEFAULT 'queued',        -- queued | sent | failed | skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  qq_msg_id   TEXT,
  passive_msg_id  TEXT,                             -- 这条是按哪个入站 msg_id 被动回复的
  passive_msg_seq INTEGER,                          -- 第几次回复（同一个 msg_id+seq 重复发会被服务端去重）
  last_try_at     INTEGER,                          -- 最后一次尝试发送的时刻（判断 sending 是否卡死）
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_qq_outbox_status ON qq_outbox(status, created_at);

-- ═══ 入站去重 ═══
-- 官方明确：同一个 msg_id 可能重复推送，必须结合 msg_seq 去重。
-- （和之前朋友圈重复事故是同一类坑，这里是库层兜底。）
CREATE TABLE IF NOT EXISTS qq_inbound_seen (
  key         TEXT PRIMARY KEY,                     -- f"{app_id}:{qq_msg_id}:{msg_seq}"
  created_at  INTEGER NOT NULL
);
`;

/**
 * 由桥进程（以及主服务的绑定路由）建表，幂等。
 *
 * CREATE TABLE IF NOT EXISTS 对**已存在**的表不会补列，所以新增列必须单独 ALTER。
 * （踩过的坑：库里已经有绑定之后再加列，不 ALTER 就是「表存在、列没有」的静默半残状态。）
 */
export function ensureQqBridgeSchema(db: DatabaseSync): void {
  db.exec(QQ_BRIDGE_SCHEMA_SQL);

  const cols = db.prepare('PRAGMA table_info(qq_bot_bindings)').all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'since_ts')) {
    db.exec('ALTER TABLE qq_bot_bindings ADD COLUMN since_ts INTEGER NOT NULL DEFAULT 0');
    // 已有绑定：把起点定在**绑定时刻**，否则一绑上就把这个角色的全部历史短信倒进 QQ。
    db.exec('UPDATE qq_bot_bindings SET since_ts = created_at WHERE since_ts = 0');
  }
  if (!cols.some(c => c.name === 'welcomed_at')) {
    db.exec('ALTER TABLE qq_bot_bindings ADD COLUMN welcomed_at INTEGER');
  }

  // outbox 也要补列：被动回复的 msg_seq 必须持久化。
  // 只放内存里的话，进程一重启计数器归零、又发出 seq=1，
  // 而这个 seq 在 60 分钟窗口内已经用过 —— 服务端会直接判重（实测踩到过）。
  const outboxCols = db.prepare('PRAGMA table_info(qq_outbox)').all() as Array<{ name: string }>;
  if (!outboxCols.some(c => c.name === 'passive_msg_id')) {
    db.exec('ALTER TABLE qq_outbox ADD COLUMN passive_msg_id TEXT');
    db.exec('ALTER TABLE qq_outbox ADD COLUMN passive_msg_seq INTEGER');
  }
  if (!outboxCols.some(c => c.name === 'last_try_at')) {
    db.exec('ALTER TABLE qq_outbox ADD COLUMN last_try_at INTEGER');
  }
}
