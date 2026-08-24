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
  // 迁移：为旧库的 scene_locations 补 owner_character_id 列（地点归属角色，NULL=公共）
  //   行程池据此排除「归属别人的领地」，见 docs/OWNER_CHARACTER_MIGRATION.md
  if (!actCol.some(c => c.name === 'owner_character_id')) {
    db.exec('ALTER TABLE scene_locations ADD COLUMN owner_character_id TEXT');
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

  // 数据迁移：回填 owner_character_id（只执行一次，判断 = 是否已有非 NULL owner 标记）
  const ownerMarked = db.prepare('SELECT COUNT(*) as c FROM scene_locations WHERE owner_character_id IS NOT NULL').get() as { c: number };
  if (ownerMarked.c === 0) {
    backfillOwnerCharacterId();
  }
}

/** 一次性回填地点归属角色（owner_character_id）。见 docs/OWNER_CHARACTER_MIGRATION.md */
function backfillOwnerCharacterId(): void {
  // 角色名 -> 角色 id
  const charIdByName = new Map<string, string>();
  for (const r of db.prepare('SELECT id, character_data FROM characters').all() as { id: string; character_data: string }[]) {
    try {
      const d = JSON.parse(r.character_data);
      if (d && typeof d.name === 'string' && d.name) charIdByName.set(d.name, r.id);
    } catch { /* ignore */ }
  }

  const setOwner = db.prepare('UPDATE scene_locations SET owner_character_id = ? WHERE id = ? AND owner_character_id IS NULL');

  // 1. 家本身 + 家的子树（递归标记，visited 防环）
  const homeOwner = new Map<string, string>();
  for (const r of db.prepare('SELECT location_id, character_id FROM scene_homes').all() as { location_id: string; character_id: string }[]) {
    homeOwner.set(r.location_id, r.character_id);
  }
  const childrenStmt = db.prepare('SELECT id FROM scene_locations WHERE parent_id = ?');
  const visited = new Set<string>();
  const walk = (locId: string, ownerId: string) => {
    if (visited.has(locId)) return;
    visited.add(locId);
    setOwner.run(ownerId, locId);
    for (const c of childrenStmt.all(locId) as { id: string }[]) {
      walk(c.id, ownerId);
    }
  };
  for (const [homeId, ownerId] of homeOwner) {
    walk(homeId, ownerId);
  }

  // 2. 角色专属场所：名字含角色全名
  const unnamed = db.prepare('SELECT id, name FROM scene_locations WHERE owner_character_id IS NULL').all() as { id: string; name: string }[];
  for (const r of unnamed) {
    for (const [cname, cid] of charIdByName) {
      if (r.name.includes(cname)) {
        setOwner.run(cid, r.id);
        break;
      }
    }
  }

  // 3. 手动清单：名字不含角色全名但明确归属
  const manual: Record<string, string> = {
    '云枢资本集团总部': '林溯',
    '厉氏集团': '厉承渊',
    '厉氏集团地下车库': '厉承渊',
    '顾氏集团总部': '顾珩',
    '异能局专属外勤驻馆（烬戍馆）': '苏烬',
  };
  for (const [name, cname] of Object.entries(manual)) {
    const cid = charIdByName.get(cname);
    if (!cid) continue;
    db.prepare('UPDATE scene_locations SET owner_character_id = ? WHERE name = ? AND owner_character_id IS NULL').run(cid, name);
  }
}

/** 场景路人：某地点的在场 NPC（公共工具人，属地点属性）。自带 id，可被场景引用归属发言 */
export interface SceneNpc {
  id: string;       // 路人唯一 id（新建时自动生成；供 scene_messages.character_id 引用归属）
  role: string;
  name: string;
  persona: string;
  /** 该 NPC 的常在地点（2-4字地名，如「观星台」；worldgen 生成，accept 时建成子地点，NPC 挂到该地点） */
  place?: string;
  /** 该 NPC 知道的线索内容（剧本杀式分发，worldgen 已把 knows 编号解析成具体内容） */
  clues?: string[];
}

/** 解析地点的 npcs JSON（兼容旧数据：无 id 的路人补一个）。批量场景直接复用，避免逐地点回查库。 */
export function parseSceneNpcs(npcsJson: string): SceneNpc[] {
  try {
    const list = JSON.parse(npcsJson);
    // 兼容旧数据：无 id 的路人补一个
    return list.map((n: any) => n.id ? n : { ...n, id: crypto.randomUUID() });
  } catch { return []; }
}

/** 读取某地点的路人列表 */
export function getNpcs(locationId: string): SceneNpc[] {
  ensureSceneMap();
  const row = db.prepare('SELECT npcs FROM scene_locations WHERE id = ?').get(locationId) as { npcs: string } | undefined;
  if (!row) return [];
  return parseSceneNpcs(row.npcs);
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

