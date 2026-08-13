/**
 * 场景地图 — 新地图 app 的地点表（替代旧 locations）
 *
 * 设计（见 MIGRATION_DESIGN.md）：
 * - 全量复制旧 `locations` 数据作为基线（公共 + 私有地点都复制，私有地点作者也有添加路人的需求）
 * - 每条带 `npcs` 字段（初始空数组），玩家在新地图 app 添加的路人存进新表对应记录
 * - 新表自足：将来确认完全替代后，旧 `locations` 才删除，新表是唯一事实源
 * - 旧表在任何情况下都不改写；本模块只读旧表、只写新表
 *
 * 旧表删除时机：新地图 app 完全替代、验收通过后才删（不是现在）。
 */
import { db } from '../db';
import { jsonParse, now } from './util';
import { SCENE_SCHEMA_SQL } from './scene-schema';

let scened = false;

/**
 * 幂等建表 + 首次全量复制旧 locations。
 * 惰性调用；改动旧 schema 之前先确保场景表已就绪。
 */
export function ensureSceneMap(): void {
  if (scened) return;
  scened = true;

  db.exec(SCENE_SCHEMA_SQL);

  // 迁移：为旧库的 scene_locations 补 activities 列
  const actCol = db.prepare("PRAGMA table_info(scene_locations)").all() as { name: string }[];
  if (!actCol.some(c => c.name === 'activities')) {
    db.exec("ALTER TABLE scene_locations ADD COLUMN activities TEXT NOT NULL DEFAULT '[]'");
  }
  // 迁移：为旧库的 scene_locations 补 background_image 列（地点背景图，管理员维护公共版）
  //   存 uploads/ 下的文件名，经 imageUrl() 访问；NULL/空 = 无背景
  if (!actCol.some(c => c.name === 'background_image')) {
    db.exec('ALTER TABLE scene_locations ADD COLUMN background_image TEXT');
  }
  // 迁移：为旧库的 scene_locations 补 background_submitted 列（公共地点的玩家背景提交池）
  //   JSON 数组 [{"uploaderId","image","at"}]；管理员未挑中公共版时，first-wins 取最早提交
  if (!actCol.some(c => c.name === 'background_submitted')) {
    db.exec("ALTER TABLE scene_locations ADD COLUMN background_submitted TEXT NOT NULL DEFAULT '[]'");
  }

  // 首启时复制旧 location_homes → scene_homes（若未复制过）
  const homeCnt = db.prepare('SELECT COUNT(*) as c FROM scene_homes').get() as { c: number };
  if (homeCnt.c === 0) {
    const oldHomes = db.prepare('SELECT location_id, character_id FROM location_homes').all() as { location_id: string; character_id: string }[];
    const insHome = db.prepare('INSERT OR IGNORE INTO scene_homes (location_id, character_id, created_at) VALUES (?, ?, ?)');
    for (const h of oldHomes) {
      insHome.run(h.location_id, h.character_id, Date.now());
    }
  }

  // 复制 scene_locations 数据
  const cnt = db.prepare('SELECT COUNT(*) as c FROM scene_locations').get() as { c: number };
  if (cnt.c === 0) {
    interface LocationRow {
      id: string; world_id: string; name: string; summary: string;
      creator_type: string | null; creator_id: string | null; character_instance_id: string | null;
      is_public: number; created_at: number; home_of: string | null; parent_id: string | null;
      updated_at: number | null;
    }
    const rows = db.prepare('SELECT * FROM locations').all() as unknown as LocationRow[];
    const ins = db.prepare(`
      INSERT OR IGNORE INTO scene_locations
        (id, world_id, name, summary, creator_type, creator_id, character_instance_id,
         is_public, created_at, home_of, parent_id, npcs, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)
    `);
    for (const r of rows) {
      ins.run(
        r.id, r.world_id, r.name, r.summary, r.creator_type ?? 'system', r.creator_id ?? null,
        r.character_instance_id ?? null, r.is_public ?? 1, r.created_at, r.home_of ?? null,
        r.parent_id ?? null, r.updated_at ?? r.created_at,
      );
    }
  }
}

/** 场景路人：某地点的在场 NPC（公共工具人，属地点属性）。自带 id，可被场景引用归属发言 */
export interface SceneNpc {
  id: string;       // 路人唯一 id（新建时自动生成；供 scene_messages.character_id 引用归属）
  role: string;
  name: string;
  persona: string;
}

/** 读取某地点的路人列表 */
export function getNpcs(locationId: string): SceneNpc[] {
  ensureSceneMap();
  const row = db.prepare('SELECT npcs FROM scene_locations WHERE id = ?').get(locationId) as { npcs: string } | undefined;
  if (!row) return [];
  try {
    const list = JSON.parse(row.npcs);
    // 兼容旧数据：无 id 的路人补一个
    return list.map((n: any) => n.id ? n : { ...n, id: crypto.randomUUID() });
  } catch { return []; }
}

/** 更新某地点的单个路人（按 id 定位，保留原 id）。只应用显式提供的字段（undefined 跳过）。返回更新后的列表。 */
export function updateNpc(locationId: string, npcId: string, patch: Partial<Omit<SceneNpc, 'id'>>): SceneNpc[] {
  ensureSceneMap();
  const list = getNpcs(locationId);
  const i = list.findIndex(n => n.id === npcId);
  if (i < 0) return list;
  const existing = list[i];
  if (!existing) return list;
  const merged: SceneNpc = { ...existing, id: npcId, role: existing.role, name: existing.name, persona: existing.persona };
  if (patch.role !== undefined) merged.role = patch.role;
  if (patch.name !== undefined) merged.name = patch.name;
  if (patch.persona !== undefined) merged.persona = patch.persona;
  list[i] = merged;
  db.prepare('UPDATE scene_locations SET npcs = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(list), Date.now(), locationId);
  return list;
}

/** 删除某地点的单个路人（按 id）。返回删除后的列表。 */
export function removeNpc(locationId: string, npcId: string): SceneNpc[] {
  ensureSceneMap();
  const list = getNpcs(locationId).filter(n => n.id !== npcId);
  db.prepare('UPDATE scene_locations SET npcs = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(list), Date.now(), locationId);
  return list;
}

/** 添加/替换某地点的路人（按 role 去重，同 role 覆盖；新建自动生成 id） */
export function upsertNpc(locationId: string, npc: SceneNpc): void {
  ensureSceneMap();
  const list = getNpcs(locationId);
  const i = list.findIndex(n => n.role === npc.role);
  if (i >= 0) { const existing = list[i]; list[i] = { ...npc, id: existing!.id }; }   // 覆盖保留原 id
  else list.push({ ...npc, id: npc.id || crypto.randomUUID() });
  db.prepare('UPDATE scene_locations SET npcs = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(list), Date.now(), locationId);
}

/**
 * 读取某地点的背景图文件名（uploads/ 下，经 imageUrl() 访问）。
 * 规则：COALESCE(管理员挑中的公共版 background_image, 玩家最早提交的那张)。
 *   - 管理员挑中过（background_image 非空）→ 用它
 *   - 否则取 background_submitted 里最早提交（at 最小）的那张（first-wins）
 * 无背景 → 返回空字符串（前端回退到默认样式）。
 */
export function getLocationBackground(locationId: string | null | undefined): string {
  if (!locationId) return '';
  ensureSceneMap();
  const row = db.prepare('SELECT background_image, background_submitted FROM scene_locations WHERE id = ?').get(locationId) as
    { background_image: string | null; background_submitted: string } | undefined;
  if (!row) return '';
  if (row.background_image?.trim()) return row.background_image.trim();
  const subs = jsonParse<{ image: string; at: number }[]>(row.background_submitted, []);
  if (subs.length === 0) return '';
  const earliest = subs.reduce((a, b) => (a.at <= b.at ? a : b));
  return earliest.image?.trim() ?? '';
}

/** 取某地点的玩家背景提交池（有序，最早在前）。 */
export function getBackgroundSubmissions(locationId: string): { uploaderId: string; image: string; at: number }[] {
  ensureSceneMap();
  const row = db.prepare('SELECT background_submitted FROM scene_locations WHERE id = ?').get(locationId) as
    { background_submitted: string } | undefined;
  if (!row) return [];
  const subs = jsonParse<{ uploaderId: string; image: string; at: number }[]>(row.background_submitted, []);
  return subs.sort((a, b) => a.at - b.at);
}

/**
 * 往某地点的背景提交池加一条。已传过同一张图则忽略（幂等）；否则追加。
 * 返回操作后的提交池（最早在前）。
 */
export function addBackgroundSubmission(locationId: string, uploaderId: string, image: string): { uploaderId: string; image: string; at: number }[] {
  ensureSceneMap();
  const imagePath = image.trim();
  if (!imagePath) return getBackgroundSubmissions(locationId);
  const subs = getBackgroundSubmissions(locationId);
  if (subs.some((s) => s.uploaderId === uploaderId && s.image === imagePath)) {
    return subs; // 幂等：同一人同图不重复
  }
  subs.push({ uploaderId, image: imagePath, at: Date.now() });
  const sorted = subs.sort((a, b) => a.at - b.at);
  db.prepare('UPDATE scene_locations SET background_submitted = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(sorted), now(), locationId);
  return sorted;
}

