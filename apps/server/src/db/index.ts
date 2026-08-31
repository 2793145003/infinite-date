/**
 * node:sqlite 数据库连接
 * Node 22+ 内置，零原生依赖
 */
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';
import { SCENE_SCHEMA_SQL } from '../lib/scene-schema';
import { config } from '../config';

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// migration 版本管理：记录已执行的 migration，避免重复执行和静默跳过失败
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  id    TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL
)`);
function migration(id: string, fn: () => void): void {
  const done = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id);
  if (done) return;
  try {
    fn();
    db.prepare('INSERT INTO schema_migrations (id, run_at) VALUES (?, ?)').run(id, Date.now());
  } catch (err) {
    const isDuplicateColumn = err instanceof Error && err.message.includes('duplicate column');
    if (isDuplicateColumn) {
      // 列已存在——安全跳过，标记完成
      db.prepare('INSERT OR IGNORE INTO schema_migrations (id, run_at) VALUES (?, ?)').run(id, Date.now());
    } else {
      // 真实错误——不标记完成（下次启动重试），打错误日志
      console.error(`[migration ${id}] FAILED (will retry next startup):`, err instanceof Error ? err.message : err);
      throw err;
    }
  }
}

// 建表顺序：SCHEMA_SQL（schema.ts 的 41 张表）→ SCENE_SCHEMA_SQL（场景引擎表）
// 二者必须都在所有 migration 之前执行——否则 migration 的 ALTER TABLE 会因目标表
// 未建而抛 no such table（见 REVIEW_V4.md 🔴-1，全新库首启失败）
db.exec(SCHEMA_SQL);
db.exec(SCENE_SCHEMA_SQL);

// migration: locations 加 home_of 列（标记角色住所）
migration('locations_home_of', () => db.exec('ALTER TABLE locations ADD COLUMN home_of TEXT'));

// migration: locations 加 parent_id 列（嵌套地图：大地点包含小地点）
migration('locations_parent_id', () => {
  db.exec('ALTER TABLE locations ADD COLUMN parent_id TEXT REFERENCES locations(id) ON DELETE CASCADE');
  db.exec('CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id)');
});

// migration: location_npc_access 表已由 SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 创建
// （旧版曾在此处 DROP 重建，会导致每次重启丢失数据，已移除）

// migration: location_homes 表已由 SCHEMA_SQL 创建，把旧 home_of 数据迁移过去
{
  const migrateTs = Date.now();
  const oldHomes = db.prepare('SELECT id, home_of FROM locations WHERE home_of IS NOT NULL').all() as { id: string; home_of: string }[];
  const insertHome = db.prepare('INSERT OR IGNORE INTO location_homes (location_id, character_id, created_at) VALUES (?, ?, ?)');
  for (const h of oldHomes) {
    insertHome.run(h.id, h.home_of, migrateTs);
  }
}

// migration: 给旧 messages 表补 internal_notable 列（CREATE TABLE IF NOT EXISTS 不会改已有表结构）
migration('messages_internal_notable', () => db.exec('ALTER TABLE messages ADD COLUMN internal_notable BOOLEAN NOT NULL DEFAULT 0'));

// migration: chronicles 加消息范围列（用于滚动折叠，标记已总结的范围）
migration('chronicles_msg_range', () => {
  db.exec('ALTER TABLE chronicles ADD COLUMN msg_start INTEGER');
  db.exec('ALTER TABLE chronicles ADD COLUMN msg_end INTEGER');
});

// migration: chronicles 加 source/summary_type 列（区分来源和摘要类型）
migration('chronicles_source', () => {
  db.exec("ALTER TABLE chronicles ADD COLUMN source TEXT NOT NULL DEFAULT 'conversation'");
  db.exec("ALTER TABLE chronicles ADD COLUMN summary_type TEXT NOT NULL DEFAULT 'segment'");
});

// migration: relationships 加 created_at 列（记录初次相遇时间）
migration('relationships_created_at', () => db.exec('ALTER TABLE relationships ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0'));

// migration: relationships 加 next_message_eligible_at 列（NPC主动消息意愿积累）
migration('relationships_next_msg_at', () => db.exec('ALTER TABLE relationships ADD COLUMN next_message_eligible_at INTEGER NOT NULL DEFAULT 0'));

// migration: relationships 加 sms_urge / moment_urge 列（意愿累积机制，替代 next_message_eligible_at）
migration('relationships_urge', () => db.exec('ALTER TABLE relationships ADD COLUMN sms_urge REAL NOT NULL DEFAULT 0'));
migration('relationships_urge_moment', () => db.exec('ALTER TABLE relationships ADD COLUMN moment_urge REAL NOT NULL DEFAULT 0'));

// migration: relationships 加 last_schedule_slot 列（行程变更检测）
migration('relationships_last_slot', () => db.exec('ALTER TABLE relationships ADD COLUMN last_schedule_slot INTEGER NOT NULL DEFAULT 0'));

// migration: conversation_sessions 加 mission_id 列（Phase 4 任务系统）
migration('conv_sessions_mission_id', () => db.exec('ALTER TABLE conversation_sessions ADD COLUMN mission_id TEXT'));

// migration: conversation_sessions 加 current_location_id 列（约会中移动后的实时地点）
migration('conv_sessions_current_loc', () => db.exec('ALTER TABLE conversation_sessions ADD COLUMN current_location_id TEXT'));

// migration: missions 加 metadata 列（存储 item/obsession 等结构化数据）
migration('missions_metadata', () => db.exec("ALTER TABLE missions ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'"));

// migration: players 加 gender/appearance 列（玩家性别与外貌）
migration('players_gender_appearance', () => {
  db.exec("ALTER TABLE players ADD COLUMN gender TEXT NOT NULL DEFAULT 'female'");
  db.exec("ALTER TABLE players ADD COLUMN appearance TEXT NOT NULL DEFAULT ''");
});

// migration: players 加 home_bg 列（主页背景壁纸，存 HomeBg JSON；空 = 无自定义壁纸）
migration('players_home_bg', () => {
  db.exec("ALTER TABLE players ADD COLUMN home_bg TEXT NOT NULL DEFAULT ''");
});

// migration: players 加 avatar 列（玩家头像，存 image_blobs 文件名；空 = 用名字首字占位）
migration('players_avatar', () => {
  db.exec("ALTER TABLE players ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
});

// migration: messages 加 speaker 列（群聊场景标识NPC身份）
migration('messages_speaker', () => db.exec('ALTER TABLE messages ADD COLUMN speaker TEXT'));

// migration: conversation_sessions 加 is_group 列（群聊标记）
migration('conv_sessions_is_group', () => db.exec('ALTER TABLE conversation_sessions ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0'));

// migration: scenario_sessions 表结构变更（copy_id 可空）。仅执行一次：如果旧表存在且有 NOT NULL copy_id 列则重建。
migration('scenario_sessions_nullable_copy', () => {
  const cols = db.prepare('PRAGMA table_info(scenario_sessions)').all() as Array<{ name: string; notnull: number }>;
  const copyCol = cols.find(c => c.name === 'copy_id');
  if (copyCol && copyCol.notnull === 1) {
    db.exec('DROP TABLE scenario_sessions');
    db.exec(`CREATE TABLE IF NOT EXISTS scenario_sessions (
      id              TEXT PRIMARY KEY,
      scenario_id     TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      player_id       TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      character_id    TEXT NOT NULL,
      copy_id         TEXT,
      stats_state     TEXT NOT NULL DEFAULT '{}',
      goal_achieved   INTEGER NOT NULL DEFAULT 0,
      dream_text      TEXT,
      dream_custom    INTEGER NOT NULL DEFAULT 0,
      ended           INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );`);
  }
});

// scene_schedule_entries 表已由 SCENE_SCHEMA_SQL 在启动时创建（含索引），不再走 migration。
// （原 migration 在此处 CREATE TABLE，已上移统一建表，见 REVIEW_V4.md 🔴-1）

// migration: scene_sessions 加 circumstance 列（特殊开场情境，如 'caught'=被房主逮到）
migration('scene_sessions_circumstance', () => db.exec("ALTER TABLE scene_sessions ADD COLUMN circumstance TEXT"));
// migration: scene_sessions 加 current_location_id 列（约会内移动后的实时地点）
migration('scene_sessions_current_location_id', () => db.exec("ALTER TABLE scene_sessions ADD COLUMN current_location_id TEXT REFERENCES scene_locations(id) ON DELETE SET NULL"));
// migration: scene_messages 加 quote 列（引用回复的 JSON：quoteId/quoteText/quoteSenderName）
migration('scene_messages_quote', () => db.exec("ALTER TABLE scene_messages ADD COLUMN quote TEXT"));

// migration: conversation_sessions 加 scenario_session_id 列（剧本会话关联）
migration('conv_sessions_scenario_id', () => db.exec('ALTER TABLE conversation_sessions ADD COLUMN scenario_session_id TEXT'));

// migration: scenarios 加 npc_roles 列（多人剧本角色槽位，JSON数组，空=单人剧本）
migration('scenarios_npc_roles', () => db.exec("ALTER TABLE scenarios ADD COLUMN npc_roles TEXT NOT NULL DEFAULT '[]'"));

// migration: scenario_sessions 加 character_ids 列（多人剧本参与的NPC列表，JSON数组，空=单人）
migration('scenario_sessions_character_ids', () => db.exec("ALTER TABLE scenario_sessions ADD COLUMN character_ids TEXT NOT NULL DEFAULT '[]'"));

// ── 剧本系统 v2（scene 引擎版）──────────────────────────────
// migration: scenarios 加 ambient_config 列（气氛组配置，空=不配气氛组）
migration('scenarios_ambient_config', () => db.exec("ALTER TABLE scenarios ADD COLUMN ambient_config TEXT NOT NULL DEFAULT ''"));

// migration: scenarios 加 greetings 列（多人剧本分角色开场白，JSON数组，平行于 npc_roles）
migration('scenarios_greetings', () => db.exec("ALTER TABLE scenarios ADD COLUMN greetings TEXT NOT NULL DEFAULT '[]'"));

// migration: scene_sessions 加剧本字段（scene_type='scenario' 时使用）
migration('scene_sessions_scenario_fields', () => {
  db.exec("ALTER TABLE scene_sessions ADD COLUMN scenario_id TEXT REFERENCES scenarios(id) ON DELETE SET NULL");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN worldview TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN player_role TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN npc_roles TEXT NOT NULL DEFAULT '[]'");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN goal TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN opening_scene TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN dream_text TEXT");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN dream_custom INTEGER NOT NULL DEFAULT 0");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN ambient_config TEXT NOT NULL DEFAULT ''");
  db.exec("ALTER TABLE scene_sessions ADD COLUMN goal_achieved INTEGER NOT NULL DEFAULT 0");
});

// migration: scene_sessions 加 revealed_clues 列（破案玩法已揭示的线索 id，JSON 数组）
migration('scene_sessions_revealed_clues', () => db.exec("ALTER TABLE scene_sessions ADD COLUMN revealed_clues TEXT NOT NULL DEFAULT '[]'"));

// migration: turn_player_facts.scene_session_id 改为允许 NULL + 补 FK
// 背景：旧表（生产库）scene_session_id 是 NOT NULL 且无 FK，而 scene-schema.ts 的新建表 SQL 是
//   TEXT REFERENCES scene_sessions(id) ON DELETE CASCADE（允许 NULL）。手动添加的事实（POST /facts）
//   没有场景来源，scene_session_id 应为 NULL；空串/孤儿 UUID 会违反外键，这里一并转 NULL。
migration('turn_player_facts_scene_session_nullable', () => {
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN');
    db.exec('DROP TABLE IF EXISTS turn_player_facts_new;');
    db.exec(`
      CREATE TABLE turn_player_facts_new (
        id               TEXT PRIMARY KEY,
        player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        character_id     TEXT NOT NULL,
        scene_session_id TEXT REFERENCES scene_sessions(id) ON DELETE CASCADE,
        round_no         INTEGER NOT NULL,
        fact             TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO turn_player_facts_new (id, player_id, character_id, scene_session_id, round_no, fact, created_at)
      SELECT id, player_id, character_id,
        CASE WHEN scene_session_id IN (SELECT id FROM scene_sessions) THEN scene_session_id ELSE NULL END,
        round_no, fact, created_at
      FROM turn_player_facts;
    `);
    db.exec('DROP TABLE turn_player_facts;');
    db.exec('ALTER TABLE turn_player_facts_new RENAME TO turn_player_facts;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_turn_pf ON turn_player_facts (player_id, character_id, scene_session_id, round_no);');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
});

// migration: emails 加 character_id 列（男主来信关联发件角色）
migration('emails_character_id', () => db.exec('ALTER TABLE emails ADD COLUMN character_id TEXT'));

// migration: scene_locations 加 lot_count 列（位面住宅区切成 N 格展示，0=普通地点）
migration('scene_locations_lot_count', () => db.exec('ALTER TABLE scene_locations ADD COLUMN lot_count INTEGER NOT NULL DEFAULT 0'));

// ── NPC 任务（邀请任务）────────────────────────────────
// migration: missions 加 solo_complete_at 列（玩家拒绝后 NPC 独自完成的时刻，接受分支为 NULL）
migration('missions_solo_complete_at', () => db.exec('ALTER TABLE missions ADD COLUMN solo_complete_at INTEGER'));

// migration: relationships 加 last_task_invite_day 列（该 NPC 今天已发过任务邀请的北京日 key）
migration('relationships_last_task_invite', () => db.exec('ALTER TABLE relationships ADD COLUMN last_task_invite_day TEXT'));

// migration: moments 加 visibility / visible_to 列（朋友圈「给谁看」可见性）
migration('moments_visibility', () => {
  db.exec("ALTER TABLE moments ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
  db.exec("ALTER TABLE moments ADD COLUMN visible_to TEXT NOT NULL DEFAULT '[]'");
});

// migration: novel_characters 加 gender 列（角色性别，空=未指定）
migration('novel_characters_gender', () => db.exec("ALTER TABLE novel_characters ADD COLUMN gender TEXT NOT NULL DEFAULT ''"));

// migration: novel_characters 加 avatar 列（角色头像文件名，空=无）
migration('novel_characters_avatar', () => db.exec("ALTER TABLE novel_characters ADD COLUMN avatar TEXT NOT NULL DEFAULT ''"));

// migration: novel_turns 加 time 列（该段发生的时间「第N天·时段」，续写时单拎注入当前时间）
migration('novel_turns_time', () => db.exec("ALTER TABLE novel_turns ADD COLUMN time TEXT NOT NULL DEFAULT ''"));

// migration: novel_characters 加 emotional_anchor 列（情绪表达锚点，独立于人设，OOC 修复）
migration('novel_characters_emotional_anchor', () => db.exec("ALTER TABLE novel_characters ADD COLUMN emotional_anchor TEXT NOT NULL DEFAULT ''"));

// 写入默认设置
const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)',
);
insertSetting.run('hub_world_id', 'default-world');

// 初始化默认世界 + 地点
const ts = Date.now();
db.prepare(`INSERT OR IGNORE INTO worlds (id, name, summary, tone, rules, lore, world_type, created_at, updated_at) VALUES ('default-world', '主城', '轮回者的聚居地', '', '', '', 'hub', ?, ?)`).run(ts, ts);

const locations: [string, string, string][] = [
  ['plaza', '中央广场', '主城的心脏地带，人来人往'],
  ['cafe', '街角咖啡馆', '安静的角落，适合聊天'],
  ['park', '星河公园', '城市边缘的绿地'],
  ['market', '万象集市', '各种稀奇古怪的东西'],
];
const insertLoc = db.prepare(`INSERT OR IGNORE INTO locations (id, world_id, name, summary, creator_type, is_public, created_at) VALUES (?, 'default-world', ?, ?, 'system', 1, ?)`);
for (const [id, name, summary] of locations) {
  insertLoc.run(id, name, summary, ts);
}

// 为每个角色建家（夜间回家用）
// 策略：不覆盖已有地点
// 1. 已在 location_homes 有记录 → 跳过
// 2. 已有玩家创建的"X家"名称地点 → 加入 location_homes
// 3. 都没有 → 新建系统家地点 + 加入 location_homes
const allChars = db.prepare('SELECT id, character_data FROM characters').all() as { id: string; character_data: string }[];
for (const c of allChars) {
  // 1. 已有家记录？
  const hasHome = db.prepare('SELECT 1 FROM location_homes WHERE character_id = ?').get(c.id);
  if (hasHome) continue;

  const charData = JSON.parse(c.character_data);
  const charName = charData.name ?? '未知';
  const homeName = `${charName}家`;

  // 2. 已有同名玩家地点？加入 location_homes
  const existing = db.prepare(`SELECT id FROM locations WHERE name = ? AND creator_type = 'player'`).get(homeName) as { id: string } | undefined;
  if (existing) {
    db.prepare('INSERT OR IGNORE INTO location_homes (location_id, character_id, created_at) VALUES (?, ?, ?)').run(existing.id, c.id, ts);
    continue;
  }

  // 3. 新建家地点（player类型：不受夜间显示限制，与creation.ts finalize逻辑一致）
  const homeId = `home-${c.id}`;
  db.prepare(`
    INSERT OR IGNORE INTO locations (id, world_id, name, summary, creator_type, is_public, created_at)
    VALUES (?, 'default-world', ?, ?, 'player', 1, ?)
  `).run(homeId, homeName, `${charName}的住所`, ts);
  db.prepare('INSERT OR IGNORE INTO location_homes (location_id, character_id, created_at) VALUES (?, ?, ?)').run(homeId, c.id, ts);
}

export { db };
