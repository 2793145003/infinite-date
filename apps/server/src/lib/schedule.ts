/**
 * NPC行程系统（DESIGN.md 2.3）
 *
 * 核心设计：
 * - deterministic hash 生成基础行程，不调LLM
 * - hash seed = player_id + character_id + 时间槽
 * - 模板池按性格分类（不按角色写死）
 * - 分钟级duration，不同NPC切换时间天然错开
 * - 真实时间驱动（读系统时钟）
 * - npc_schedules表仅存LLM调整后的行程，基础行程随用随算
 *
 * 行程可见性（DESIGN.md 2.3）：
 * - 好友：完整行程（名字+位置+活动+场景提示）
 * - 非好友：灰色名字+位置
 * - 从没见过：问号
 */
import { db } from '../db';
import { ensureSceneMap } from './scene-map';
import { ensureSceneSession } from './scene-session';

const HUB_WORLD_ID = 'default-world';

// ─── 类型 ────────────────────────────────────────────────

export interface ScheduleEntry {
  locationId: string;
  locationName: string;
  activity: string;
  startTime: number;  // Unix ms
  duration: number;   // 分钟
}

export interface NpcLocationInfo {
  characterId: string;
  name: string;
  avatar: string;
  locationId: string;
  activity: string;
  /** 好友=亮色+完整行程, 非好友=灰色+位置, 没见过=问号 */
  visibility: 'friend' | 'stranger' | 'unknown';
}

// ─── 性格分类 ────────────────────────────────────────────

export type PersonalityType = 'introvert' | 'extrovert' | 'combat' | 'default';

/**
 * 从角色数据提取性格倾向
 * 不做精确NLP——简单关键词匹配就够，行程本来就是模糊的
 */
export function classifyPersonality(charData: Record<string, any>): PersonalityType {
  const text = [
    charData.personality?.surface ?? '',
    charData.personality?.core ?? '',
    charData.skills ?? '',
    charData.likes?.flatMap((l: any) => typeof l === 'string' ? [l] : [l?.item ?? ''])?.join(' ') ?? '',
  ].join(' ');

  const combatKeywords = ['战斗', '训练', '力量', '武器', '剑', '枪', '格斗', '战术', '守护', '保护', '巡逻'];
  const introvertKeywords = ['安静', '独处', '僻静', '阅读', '看书', '睡眠', '睡觉', '思考', '沉默', '孤独', '冷'];
  const extrovertKeywords = ['热闹', '人群', '社交', '聊天', '集市', '逛街', '表演', '开朗', '活泼', '热情'];

  const combatScore = combatKeywords.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);
  const introvertScore = introvertKeywords.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);
  const extrovertScore = extrovertKeywords.reduce((s, k) => s + (text.includes(k) ? 1 : 0), 0);

  const max = Math.max(combatScore, introvertScore, extrovertScore);
  if (max === 0) return 'default';
  if (combatScore === max) return 'combat';
  if (introvertScore === max) return 'introvert';
  return 'extrovert';
}

// ─── 作息参数（每人各自不同的睡眠窗口）────────────────────
// 用 playerId+characterId hash 确定性派生，每个 NPC 的入睡/起床时间固定不变。
// 这样不同人睡眠时段不同：有人早睡早起，有人熬夜赖床。
interface SleepWindow {
  sleepStartHour: number; // 入睡（北京时间小时，0-23）
  sleepEndHour: number;   // 起床（北京时间小时，0-23）
}
function getSleepWindow(playerId: string, characterId: string, isNightOwl: boolean): SleepWindow {
  const s = hashStr(`${playerId}:${characterId}:sleep`);
  const wakeHash = hashStr(`${playerId}:${characterId}:wake`);
  if (isNightOwl) {
    // 夜猫子：早上睡到中午（基础 06:00 睡 → 13:00 起，各加扰动）
    const startPerturb = Math.floor(s * 3);        // 0..2h
    const endPerturb = Math.floor(wakeHash * 2);    // 0..1h
    return { sleepStartHour: 6 + startPerturb, sleepEndHour: 13 + endPerturb };
  }
  // 普通人：入睡 21:00–01:00，起床 05:00–10:00
  const sleepStartHour = 21 + Math.floor(s * 5) % 5; // 21,22,23,0,1
  const sleepEndHour = 5 + Math.floor(wakeHash * 6) % 6; // 5,6,7,8,9,10
  return { sleepStartHour, sleepEndHour };
}

/**
 * 判定某角色是否为夜猫子。
 * 优先读人设里的 sleepType 字段（'night_owl' = 夜猫子，'normal' = 正常人），
 * 这是 LLM 创建角色时按人设推测、管理界面可手动改的权威来源。
 * 旧角色没有该字段时回退到原来的 hash 随机判定（combat 15%/其他 5%）。
 */
function isNightOwl(playerId: string, characterId: string, ptype: PersonalityType, charData?: Record<string, any>): boolean {
  if (charData) {
    if (charData.sleepType === 'night_owl') return true;
    if (charData.sleepType === 'normal') return false;
  }
  const nightSeed = `${playerId}:${characterId}:night`;
  const nightHash = hashStr(nightSeed);
  const nightOwlChance = ptype === 'combat' ? 0.15 : 0.05;
  // 只有少数人是夜猫子：hash 击中低概率区间才算。之前用 >= 导致 85-95% 都是夜猫子（反了）。
  return nightHash < nightOwlChance;
}

/**
 * 返回时刻 t 落在角色睡眠窗口时的 [入睡绝对时刻, 起床绝对时刻)；
 * 不在睡眠窗口则返回 null。
 * 入睡可能是深夜(21-23点)也可能是后半夜(0-1点)，都处理跨午夜。
 * 夜猫子的睡眠窗口在白天（早上睡到中午）。
 */
function sleepWindowFor(playerId: string, characterId: string, ptype: PersonalityType, charData: Record<string, any>, t: number): { start: number; end: number } | null {
  const owl = isNightOwl(playerId, characterId, ptype, charData);
  const sw = getSleepWindow(playerId, characterId, owl);
  const startHour = sw.sleepStartHour;
  for (const offset of [-1, 0]) {
    // 参考日 = t 所在的北京时间自然日 + offset 天
    const dayStart = Math.floor((t + 8 * 3600 * 1000) / 86400000) * 86400000 - 8 * 3600 * 1000;
    const R = dayStart + offset * 86400000;
    // 普通人 startHour 在 21-1（>=12 是当晚深夜，<12 是后半夜=前置24h）；夜猫子 startHour 在 6-8（清晨=当天）
    const start = startHour >= 12 ? R + startHour * 3600000 : R + (24 + startHour) * 3600000;
    const end = R + 24 * 3600000 + sw.sleepEndHour * 3600000;
    if (t >= start && t < end) return { start, end };
  }
  return null;
}

// ─── 在线状态（短信可达性）────────────────────────────────

export type NpcOnlineState = 'online' | 'sleep' | 'mission';

/** 醒窗口：睡觉中被短信吵醒后"上线"的时长，超过则继续睡（15 分钟） */
const AWAKE_WINDOW_MS = 15 * 60 * 1000;

/**
 * NPC 在线状态——只描述"短信能不能即时到"，跟"人在哪/行程"是两个维度。
 * - online：正常（含睡眠窗口内被吵醒后的半醒窗口）
 * - sleep：当前在睡眠窗口、且距最近一条 NPC 回复已超过醒窗口 → 会被吵醒
 * - mission：任务中收不到（待 NPC 任务做完补判定，先占位）
 */
export function getNpcOnlineState(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
): NpcOnlineState {
  // mission 态：NPC 任务进行中（active 一起做 / solo 独自做且未到期）→ 在任务世界，短信收不到
  const inMission = db.prepare(`
    SELECT 1 FROM missions
    WHERE player_id = ? AND quest_type = 'npc' AND assignee_id = ?
      AND (status = 'active' OR (status = 'solo' AND solo_complete_at > ?))
    LIMIT 1
  `).get(playerId, characterId, now);
  if (inMission) return 'mission';

  const ptype = classifyPersonality(charData);
  const win = sleepWindowFor(playerId, characterId, ptype, charData, now);
  if (!win) return 'online';

  // 睡眠窗口内：距最近一条 NPC 回复 < 醒窗口 → 半醒（online），否则仍在睡（sleep）
  const lastReply = db.prepare(`
    SELECT tm.created_at
    FROM text_messages tm
    JOIN message_threads mt ON mt.id = tm.thread_id
    WHERE mt.player_id = ? AND mt.character_id = ? AND tm.sender = 'npc'
    ORDER BY tm.created_at DESC
    LIMIT 1
  `).get(playerId, characterId) as { created_at: number } | undefined;

  if (lastReply && now - lastReply.created_at < AWAKE_WINDOW_MS) return 'online';
  return 'sleep';
}

// ─── 北京日历日（行程落库的 day_key）────────────────────────
// 北京时间 0 点作为一天起点；day_key 形如 "2026-08-05"。
function bjDayStartMs(ms: number): number {
  return Math.floor((ms + 8 * 3600 * 1000) / 86400000) * 86400000 - 8 * 3600 * 1000;
}
export function bjDayKey(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 确定性生成某角色从 fromMs 到 uptoMs 的完整行程段（含睡眠窗口、动态池）。
 * 与旧 getSceneSchedule/getSceneUpcomingSchedule 同一套生成逻辑（hash/模板/性格），
 * 只是从北京 0 点锚定推进，返回 [fromMs, uptoMs) 的所有段（相邻同地点同活动已合并）。
 */
function walkSceneTimeline(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  fromMs: number,
  uptoMs: number,
): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const ptype = classifyPersonality(charData);
  const epochSeed = hashStr(`${playerId}:${characterId}:epoch`);
  const epochOffsetMs = Math.floor(epochSeed * 3600 * 1000);

  // 从 fromMs 所在北京日的 0 点开始推进（保证整天连续）
  let cursor = bjDayStartMs(fromMs);
  let segmentIndex = 0;
  const MAX_SEGMENTS = 400;

  // ── 每个角色只查一次的静态数据：家 + 公开地点池 ──
  const home = db.prepare(
    'SELECT s.id, s.name FROM scene_locations s JOIN scene_homes h ON h.location_id = s.id WHERE h.character_id = ?'
  ).get(characterId) as { id: string; name: string } | undefined;

  const customRows = db.prepare(`
    SELECT l.id AS location_id, l.name, l.activities,
           (SELECT 1 FROM scene_homes h WHERE h.location_id = l.id AND h.character_id = ?) AS is_my_home
    FROM scene_locations l
    WHERE l.world_id = ?
      AND l.is_public = 1
      AND l.character_instance_id IS NULL
      AND (l.owner_character_id IS NULL OR l.owner_character_id = ?)
    ORDER BY l.id
  `).all(characterId, HUB_WORLD_ID, characterId) as { location_id: string; name: string; is_my_home: number; activities: string }[];

  // 地点活动池：优先该地点的可编辑 activities（JSON）。
  // 系统4点(plaza/cafe/park/market)若未设池则走性格模板 TEMPLATE_POOL；设了池则用池随机抽。
  const SYS_IDS = new Set(['plaza', 'cafe', 'park', 'market']);
  const locMap = new Map<string, { name: string; activities: string[] }>();
  for (const r of customRows) {
    if (locMap.has(r.location_id)) continue;
    let acts: string[];
    try { acts = JSON.parse(r.activities || '[]'); } catch { acts = []; }
    if (!Array.isArray(acts) || acts.length === 0) {
      if (SYS_IDS.has(r.location_id)) continue; // 系统点无池 → 用性格模板
      acts = [r.is_my_home ? '待在家里' : defaultActivityForLocation(r.name)];
    }
    locMap.set(r.location_id, { name: r.name, activities: acts });
  }
  const customPool: ScheduleTemplate[] = [];
  for (const [locId, info] of locMap) {
    customPool.push({ locationId: locId, activity: info.activities[0]!, duration: 30 });
  }
  const dayPool = [...TEMPLATE_POOL[ptype], ...customPool];
  // 夜间只用专门的 NIGHT_POOL（已按夜间氛围精挑），不用地点自定义活动池——
  // 地点自定义活动（如中央广场的"在喷泉边看人潮""观察往行的行人"）是白天式活动，
  // 混进夜间会与"深夜无人/人潮散去"的旁白冲突（如夜猫子穆昭凌晨2点在广场"看人潮"）。
  const nightPool = [...NIGHT_POOL];

  // ── 所有地点名：一次查全，循环内零 DB ──
  const locNames = new Map<string, string>();
  for (const r of db.prepare('SELECT id, name FROM scene_locations').all() as { id: string; name: string }[]) {
    locNames.set(r.id, r.name);
  }
  const locName = (id: string): string | undefined => locMap.get(id)?.name ?? locNames.get(id);

  while (cursor < uptoMs && segmentIndex < MAX_SEGMENTS) {
    // ── 睡眠窗口：cursor 落在该角色睡眠时段（普通人夜里、夜猫子白天）→ 睡一整段 ──
    const win = sleepWindowFor(playerId, characterId, ptype, charData, cursor);
    if (win) {
      if (!home) { cursor = win.end; continue; } // 没家 → 这段消失
      const last = entries[entries.length - 1];
      if (last && last.locationId === home.id && last.activity === '已经睡了') {
        last.duration = Math.round((win.end - last.startTime) / 60000);
      } else {
        // 睡眠段起点 = 睡眠窗口起点，但若 cursor 已越过起点（前一段活动越过入睡点），
        // 则从 cursor 起睡，避免与前一活动段重叠。
        const sleepStart = Math.max(win.start, cursor);
        if (sleepStart >= win.end) { cursor = win.end; continue; } // 已过入睡点且越过起床点 → 直接跳
        entries.push({
          locationId: home.id,
          locationName: home.name,
          activity: '已经睡了',
          startTime: sleepStart,
          duration: Math.round((win.end - sleepStart) / 60000),
        });
      }
      cursor = win.end;
      continue;
    }

    const hour = new Date(cursor).getHours(); // config.ts TZ=Asia/Shanghai，北京时间
    const isNight = hour >= 23 || hour < 6;
    const pool = isNight ? nightPool : dayPool;

    const segSeed = `${playerId}:${characterId}:${segmentIndex}`;
    const segHash = hashStr(segSeed);
    const templateIndex = Math.floor(segHash * pool.length);
    const template = pool[Math.min(templateIndex, pool.length - 1)];
    if (!template) break;

    const durHash = hashStr(`${segSeed}:duration`);
    const duration = Math.max(10, Math.round(template.duration * (0.5 + durHash)));
    const segEnd = cursor + duration * 60 * 1000;

    const locN = locName(template.locationId);
    if (!locN) { cursor = segEnd; segmentIndex++; continue; }

    const customActs = locMap.get(template.locationId)?.activities ?? [];
    const actHash = hashStr(`${segSeed}:${template.locationId}:activity`);
    // 白天：用地点自定义活动池覆盖模板活动（如中央广场"看人潮"）；夜间：不要覆盖，
    // 直接用 NIGHT_POOL 的夜间活动（否则会把白天的"看人潮/观察行人"带进深夜，与深夜无人旁白冲突）。
    const activity = !isNight && customActs.length > 0
      ? (customActs[Math.floor(actHash * customActs.length)] ?? template.activity)
      : template.activity;

    const last = entries[entries.length - 1];
    if (last && last.locationId === template.locationId && last.activity === activity) {
      last.duration = Math.round((segEnd - last.startTime) / 60000);
    } else {
      entries.push({
        locationId: template.locationId,
        locationName: locN,
        activity,
        startTime: cursor,
        duration,
      });
    }
    cursor = segEnd;
    segmentIndex++;
  }

  // 只返回 [fromMs, uptoMs) 内的段
  return entries.filter(e => e.startTime + e.duration * 60000 > fromMs && e.startTime < uptoMs);
}

/**
 * 确保某角色某北京日（day_key）当天的完整行程已落库。
 * 用 walkSceneTimeline 生成当天 0:00→次日 0:00 的段，INSERT OR IGNORE（不覆盖已有记录，
 * 已存在的=可能被 LLM 改过，保留）。返回不暴露细节。
 */

/**
 * 无自定义活动池地点的默认活动词——按地点名关键词分类，
 * 避免「主卫·闲逛」「床边·闲逛」这类室内/专属地点配「闲逛」的违和。
 * 匹配不到（开放空间/区域）才落回「闲逛」。
 */
function defaultActivityForLocation(name: string): string {
  const n = name;
  if (/温泉/.test(n)) return '泡温泉放松';
  if (/影院|电影院/.test(n)) return '看电影';
  if (/酒吧/.test(n)) return '喝酒';
  if (/车/.test(n)) return '乘车赶路';
  if (/茶|餐厅|餐饮|咖啡|渔村/.test(n)) return '用餐喝茶';
  if (/卫|浴|床|卧|衣帽|衣柜|镜|露台|沙发|起居|客厅|书房|厨房|餐桌|大理石|休息|阅读|生活|屋/.test(n)) return '在家休息';
  if (/办公室|工作室|研究所|集团|总部|驻馆|异能局|治安|公证/.test(n)) return '埋头工作';
  if (/家|宅|别墅/.test(n) && !/区$/.test(n)) return '待在家里';
  return '闲逛';
}

function ensureSceneDay(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  dayKey: string,
): void {
  // 已有该天的行：若它们无重叠则为"干净"数据（保留，加快路径+不覆盖LLM编辑）；若重叠则为脏数据 → 清掉非LLM编辑行重新生成。
  const existing = db.prepare(
    'SELECT start_time, duration FROM scene_schedule_entries WHERE player_id = ? AND character_id = ? AND day_key = ? ORDER BY start_time'
  ).all(playerId, characterId, dayKey) as { start_time: number; duration: number }[];
  if (existing.length > 0 && !hasOverlap(existing)) return;

  // 清掉该 (player,char,day) 的旧生成行（保留 LLM 编辑过 is_llm_edited=1 的行）。
  // 不同版本/活动池变化会让段起点偏移，若不清旧行会发生重叠脏行堆积，
  // 导致行程显示错乱（如人在家睡觉却显示在广场）。
  db.prepare(
    'DELETE FROM scene_schedule_entries WHERE player_id = ? AND character_id = ? AND day_key = ? AND is_llm_edited = 0'
  ).run(playerId, characterId, dayKey);

  const parts = dayKey.split('-');
  const dayStart = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) - 8 * 3600 * 1000; // 北京 0 点 = UTC 前一天 16 点
  const dayEnd = dayStart + 86400000;
  const segs = walkSceneTimeline(playerId, characterId, charData, dayStart, dayEnd);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO scene_schedule_entries
       (id, player_id, character_id, day_key, location_id, location_name, activity, start_time, duration, is_llm_edited, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  );
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const s of segs) {
      insert.run(
        `${playerId}:${characterId}:${s.startTime}`, playerId, characterId, dayKey,
        s.locationId, s.locationName, s.activity, s.startTime, s.duration, now,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 判断一组段是否重叠（按 start_time 升序，相邻两段首尾是否冲突）
function hasOverlap(rows: { start_time: number; duration: number }[]): boolean {
  const sorted = [...rows].sort((a, b) => a.start_time - b.start_time);
  for (let i = 1; i < sorted.length; i++) {
    const cur: { start_time: number; duration: number } | undefined = sorted[i];
    const prev: { start_time: number; duration: number } | undefined = sorted[i - 1];
    if (cur && prev && cur.start_time < prev.start_time + prev.duration * 60000) return true;
  }
  return false;
}


// ─── 行程模板池 ──────────────────────────────────────────

interface ScheduleTemplate {
  locationId: string;
  activity: string;
  duration: number; // 分钟
}

// 系统地点固定4个：plaza, cafe, park, market
// 模板按性格分类，每个性格有偏好地点+活动
const TEMPLATE_POOL: Record<PersonalityType, ScheduleTemplate[]> = {
  introvert: [
    { locationId: 'cafe', activity: '坐在角落看书', duration: 45 },
    { locationId: 'cafe', activity: '安静地喝咖啡', duration: 30 },
    { locationId: 'park', activity: '在僻静的长椅上发呆', duration: 40 },
    { locationId: 'park', activity: '沿着小路散步', duration: 25 },
    { locationId: 'plaza', activity: '在边缘的台阶上坐着', duration: 20 },
  ],
  extrovert: [
    { locationId: 'plaza', activity: '在广场中央和人聊天', duration: 35 },
    { locationId: 'market', activity: '逛集市看新鲜玩意', duration: 40 },
    { locationId: 'plaza', activity: '在喷泉边散步', duration: 25 },
    { locationId: 'market', activity: '和摊贩讨价还价', duration: 30 },
    { locationId: 'cafe', activity: '和朋友拼桌聊天', duration: 35 },
  ],
  combat: [
    { locationId: 'park', activity: '在空地上训练', duration: 50 },
    { locationId: 'plaza', activity: '巡逻周围', duration: 30 },
    { locationId: 'park', activity: '做体能锻炼', duration: 40 },
    { locationId: 'market', activity: '检查装备补给', duration: 25 },
    { locationId: 'plaza', activity: '在广场边角活动筋骨', duration: 20 },
  ],
  default: [
    { locationId: 'plaza', activity: '在广场散步', duration: 30 },
    { locationId: 'cafe', activity: '喝杯东西', duration: 25 },
    { locationId: 'park', activity: '随便逛逛', duration: 30 },
    { locationId: 'market', activity: '看看有什么新货', duration: 25 },
    { locationId: 'plaza', activity: '坐在台阶上休息', duration: 20 },
  ],
};

// 夜间活动池（23:00-06:00，少数夜猫子使用）
const NIGHT_POOL: ScheduleTemplate[] = [
  { locationId: 'plaza', activity: '在空旷的广场上发呆', duration: 30 },
  { locationId: 'park', activity: '在夜色中的小路独行', duration: 40 },
  { locationId: 'cafe', activity: '在打烊的咖啡馆窗边坐着', duration: 35 },
  { locationId: 'park', activity: '靠在树下闭目养神', duration: 25 },
  { locationId: 'plaza', activity: '在喷泉边坐着看天', duration: 30 },
];

// ─── Hash函数 ────────────────────────────────────────────

/**
 * 确定性hash，不依赖crypto（行程不需要密码学安全性）
 * FNV-1a + murmur3 finalizer，输出0~1的浮点数
 * 
 * 纯FNV-1a对连续整数（slotIndex+0, +1, +2...）雪崩效应不足——
 * 相邻输入只差一个字符，输出会聚在一起。finalizer做雪崩混合，
 * 让相邻输入的输出彻底打散。
 */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // murmur3 finalizer — 雪崩混合
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  // 转为0~1的小数
  return (h >>> 0) / 4294967296;
}

/**
 * 时间槽：把时间切成 duration 槽，每个NPC在每个槽有一个确定位置
 * 槽宽 = 60分钟（1小时），NPC的duration不等于槽宽 → 切换时间天然错开
 */
const SLOT_WIDTH_MIN = 60;

function getCurrentSlotStart(now: number): number {
  const slotMs = SLOT_WIDTH_MIN * 60 * 1000;
  return Math.floor(now / slotMs) * slotMs;
}

// ─── 核心行程生成 ─────────────────────────────────────────

/**
 * 计算NPC在当前时间的基础行程（deterministic，不查npc_schedules表）
 *
 * 每个NPC有自己独立的时间轴——以 epoch 起点按 duration 连续推进，
 * 不同NPC的切换时间天然错开，不会整点集体换地方。
 *
 * @param playerId 玩家ID（行程是per-player的）
 * @param characterId NPC ID
 * @param charData 角色数据
 * @param now 当前时间戳(ms)
 * @returns 行程条目，或null（NPC可能在某些时段不在主城）
 */
export function getBaseSchedule(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
): ScheduleEntry | null {
  const ptype = classifyPersonality(charData);
  const hour = new Date(now).getHours();
  const isNight = hour >= 23 || hour < 6;
  // 夜间用夜间活动池，白天用性格模板池
  const systemPool = isNight ? NIGHT_POOL : TEMPLATE_POOL[ptype];

  // NPC独立时间轴：用 hash(playerId:characterId) 算出起点偏移
  // 不同NPC起点不同 → 切换时间天然错开
  const epochSeed = hashStr(`${playerId}:${characterId}:epoch`);
  const epochOffsetMs = Math.floor(epochSeed * 3600 * 1000); // 0~1小时偏移

  // 夜间逻辑不受时间轴影响——夜间直接回家
  const nightSeed = `${playerId}:${characterId}:night`;
  const nightHash = hashStr(nightSeed);

  // ── 昼夜逻辑 ──────────────────────────────────────
  // 深夜（23:00-06:00 UTC+8）：NPC回家或当夜猫子
  if (isNight) {
    // 夜猫子概率：性格偏combat的15%还在外面活动，其他5%
    const nightOwlChance = ptype === 'combat' ? 0.15 : 0.05;
    if (nightHash < nightOwlChance) {
      // 少数夜猫子继续走下面的逻辑（夜间活动池）
    } else {
      // 大部分NPC回家
      const home = db.prepare('SELECT l.id, l.name FROM locations l JOIN location_homes h ON h.location_id = l.id WHERE h.character_id = ?').get(characterId) as { id: string; name: string } | undefined;
      if (home) {
        // 查家的活动描述
        const homeActivities = db.prepare('SELECT activity FROM location_npc_access WHERE location_id = ?').all(home.id) as { activity: string }[];
        const actHash = hashStr(`${nightSeed}:${home.id}:activity`);
        const activity = homeActivities.length > 0
          ? (homeActivities[Math.floor(actHash * homeActivities.length)]!.activity || '已经睡了')
          : '已经睡了';
        return {
          locationId: home.id,
          locationName: home.name,
          activity,
          startTime: Math.floor(now / 3600000) * 3600000, // 整点对齐（夜间不频繁切换）
          duration: 60,
        };
      }
      return null; // 没有家 → 消失
    }
  }

  // NPC只要不在任务中就一定在主城某个地点

  // 动态扩展池：所有公开地点（系统地点 + 玩家创建的公开地点）
  // 排除4个核心系统地点（它们已在模板池里）
  // 家地点只对owner进入行程池——别人不会去你家
  // 如果该NPC在某地点有管理员配置的活动描述，优先使用；否则用默认活动
  const customRows = db.prepare(`
    SELECT l.id AS location_id, l.name,
           (SELECT 1 FROM location_homes h WHERE h.location_id = l.id AND h.character_id = ?) AS is_my_home,
           a.activity
    FROM locations l
    LEFT JOIN location_npc_access a ON a.location_id = l.id AND a.character_id = ?
    WHERE l.world_id = ?
      AND l.is_public = 1
      AND l.id NOT IN ('plaza', 'cafe', 'park', 'market')
      AND l.character_instance_id IS NULL
      AND (NOT EXISTS (SELECT 1 FROM location_homes h WHERE h.location_id = l.id) OR is_my_home = 1)
    ORDER BY l.id, a.created_at
  `).all(characterId, characterId, HUB_WORLD_ID) as { location_id: string; name: string; is_my_home: number; activity: string | null }[];

  // 按 location_id 分组
  const locMap = new Map<string, { name: string; activities: string[] }>();
  for (const r of customRows) {
    if (!locMap.has(r.location_id)) {
      locMap.set(r.location_id, { name: r.name, activities: [] });
    }
    if (r.activity) {
      locMap.get(r.location_id)!.activities.push(r.activity);
    }
  }

  const customPool: ScheduleTemplate[] = [];
  for (const [locId, info] of locMap) {
    customPool.push({ locationId: locId, activity: info.activities.length > 0 ? info.activities[0]! : '闲逛', duration: 30 });
  }

  const pool = [...systemPool, ...customPool];

  // ── 独立时间轴推进 ──────────────────────────────────
  // 从 epochOffset 开始，按 template[i].duration 逐段推进，
  // 找到当前时间落在哪一段。
  // 每段的模板由 hash(seed:segmentIndex) 决定——deterministic且不可预测
  let segmentStart = Math.floor((now - epochOffsetMs) / 86400000) * 86400000 + epochOffsetMs; // 今天0点+偏移
  // 如果segmentStart在未来（偏移还没到），从昨天开始
  if (segmentStart > now) segmentStart -= 86400000;

  let segmentIndex = 0;
  let cursor = segmentStart;
  const MAX_SEGMENTS = 200; // 安全上限，避免无限循环

  while (cursor <= now && segmentIndex < MAX_SEGMENTS) {
    const segSeed = `${playerId}:${characterId}:${segmentIndex}`;
    const segHash = hashStr(segSeed);
    const templateIndex = Math.floor(segHash * pool.length);
    const template = pool[Math.min(templateIndex, pool.length - 1)];
    if (!template) return null;

    // duration 加个体扰动：±50%，让同一活动不同NPC/不同时段停留时长不同
    const durHash = hashStr(`${segSeed}:duration`);
    const duration = Math.max(10, Math.round(template.duration * (0.5 + durHash)));

    const segEnd = cursor + duration * 60 * 1000;

    if (now < segEnd) {
      // 当前时间落在这段
      const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(template.locationId) as { name: string } | undefined;
      if (!loc) return null;

      // 活动：如果有自定义活动，用hash选一条
      const customActs = locMap.get(template.locationId)?.activities ?? [];
      const actHash = hashStr(`${segSeed}:${template.locationId}:activity`);
      const activity = customActs.length > 0
        ? (customActs[Math.floor(actHash * customActs.length)] ?? template.activity)
        : template.activity;

      return {
        locationId: template.locationId,
        locationName: loc.name,
        activity,
        startTime: cursor,
        duration,
      };
    }

    cursor = segEnd;
    segmentIndex++;
  }

  return null;
}

// getOverriddenSchedule 已删除——npc_schedules 表已退役，不再使用

/**
 * 获取NPC当前行程（优先LLM覆盖，否则基础行程）
 *
 * 【统一数据源】委托到新 scene 行程系统（scene_schedule_entries），
 * 与地图 /scene/map/npcs、场景约会引擎同一套数据。旧 getBaseSchedule /
 * getOverriddenSchedule（基于 locations/location_homes）不再被消费方使用，
 * 避免"短信说在A、地图说在B"的两套行程割裂。
 */
export function getCurrentSchedule(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
): ScheduleEntry | null {
  ensureSceneMap();
  return getSceneSchedule(playerId, characterId, charData, now);
}

/**
 * 获取NPC当前所在位置名称（用于短信/prompt的位置上下文）
 *
 * 数据源优先级：
 * 1. 进行中的约会地点（NPC正在和玩家在一起）
 * 2. 行程系统（getCurrentSchedule — 与地图同一数据源）
 * 3. 空（NPC不在主城）
 *
 * 不再用过期约会地点——那会导致短信说"在公园"但地图上NPC已消失
 */
export function getNpcCurrentLocationName(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
): string {
  // 1. 进行中的场景约会（新引擎）：位置 = 场景实时地点
  ensureSceneSession();
  const activeScene = db.prepare(`SELECT s.current_location_id, s.root_location_id
    FROM scene_sessions s, json_each(s.character_ids) j
    WHERE s.player_id = ? AND j.value = ? AND s.ended = 0
    ORDER BY s.updated_at DESC LIMIT 1`).get(playerId, characterId) as { current_location_id: string | null; root_location_id: string | null } | undefined;
  const activeSceneLoc = activeScene?.current_location_id || activeScene?.root_location_id;
  if (activeSceneLoc) {
    return sceneLocationName(activeSceneLoc, characterId);
  }

  // 2. 旧约会（conversation_sessions，若仍在被使用）
  const activeSess = db.prepare('SELECT location_id, current_location_id FROM conversation_sessions WHERE player_id = ? AND character_id = ? AND ended = 0').get(playerId, characterId) as { location_id: string | null; current_location_id: string | null } | undefined;
  const activeLocId = activeSess?.current_location_id || activeSess?.location_id;
  if (activeLocId) {
    const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(activeLocId) as { name: string } | undefined;
    if (!loc) return '';
    const isHome = db.prepare('SELECT 1 FROM scene_homes WHERE location_id = ? AND character_id = ?').get(activeLocId, characterId);
    if (isHome) return '家';
    return sceneFastPath(activeLocId);
  }

  // 3. 行程系统（与地图同一数据源：新 scene 表）
  const schedule = getCurrentSchedule(playerId, characterId, charData, now);
  if (!schedule) return '';
  // 在自己家 → 说"在家"
  const isHomeSchedule = db.prepare('SELECT 1 FROM scene_homes WHERE location_id = ? AND character_id = ?').get(schedule.locationId, characterId);
  if (isHomeSchedule) return '家';
  return sceneFastPath(schedule.locationId);
}

/** 场景地点路径（拼接父链，读 scene_locations，兼容只在 scene 表存在的新地点） */
function sceneFastPath(locationId: string): string {
  const parts: string[] = [];
  let curId: string | null = locationId;
  let depth = 0;
  while (curId && depth < 20) {
    const row = db.prepare('SELECT name, parent_id FROM scene_locations WHERE id = ?').get(curId) as
      { name: string; parent_id: string | null } | undefined;
    if (!row) break;
    parts.unshift(row.name);
    curId = row.parent_id;
    depth++;
  }
  return parts.join(' › ');
}

/** 场景地点名（含自己家→"家"） */
function sceneLocationName(locationId: string, characterId: string): string {
  const isHome = db.prepare('SELECT 1 FROM scene_homes WHERE location_id = ? AND character_id = ?').get(locationId, characterId);
  if (isHome) return '家';
  const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(locationId) as { name: string } | undefined;
  return loc?.name || '';
}

/**
 * 检查NPC是否可以发出约会邀请（从短信中）
 *
 * 条件：
 * 1. NPC在主城（行程系统返回非null——能找到他）
 * 2. 没有进行中的约会（ended=0的session）
 * 3. 没有进行中的任务（mission session）
 *
 * 邀请地点=NPC当前所在位置（家、广场、咖啡厅……都行）
 */
export function getNpcInviteLocationId(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
): string | null {
  // 有进行中的约会（旧 conversation 或新 scene 约会）→ 不可邀请
  const activeSession = db.prepare('SELECT 1 FROM conversation_sessions WHERE player_id = ? AND ended = 0').get(playerId);
  if (activeSession) return null;
  const activeScene = db.prepare("SELECT 1 FROM scene_sessions WHERE player_id = ? AND ended = 0 AND scene_type = 'date'").get(playerId);
  if (activeScene) return null;

  // 有进行中的任务 → 不可邀请
  const activeMission = db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(playerId);
  if (activeMission) return null;

  // 获取NPC当前行程——在主城就能邀请，不管在哪个地点
  const schedule = getCurrentSchedule(playerId, characterId, charData, now);
  if (!schedule) return null;

  return schedule.locationId;
}

// ─── 批量查询 ────────────────────────────────────────────

/**
 * 批量获取多个NPC在当前时间的位置
 * 返回每个NPC的locationId和activity（如果不在主城则不返回）
 */
export function getNpcLocations(
  playerId: string,
  characters: { characterId: string; charData: Record<string, any> }[],
  now: number,
): Map<string, ScheduleEntry> {
  const result = new Map<string, ScheduleEntry>();
  for (const { characterId, charData } of characters) {
    const schedule = getCurrentSchedule(playerId, characterId, charData, now);
    if (schedule) {
      result.set(characterId, schedule);
    }
  }
  return result;
}

/**
 * 获取NPC未来N小时的行程（好友可见）
 * 用于好友行程详情页
 */
export function getUpcomingSchedule(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
  hours: number = 6,
): ScheduleEntry[] {
  ensureSceneMap();
  return getSceneUpcomingSchedule(playerId, characterId, charData, now, hours);
}

/**
 * 【新地图专用】基于 scene_locations / scene_homes 生成角色当前位置。
 *
 * 与 getBaseSchedule 相同的确定性生成逻辑（同模板池/性格/hash），
 * 但所有地点查询改为读新表 scene_locations / scene_homes —— 新地图彻底隔离，
 * 不依赖旧 locations/location_homes/location_npc_access。
 * 新地图新增的地点也会进入此行程池（旧行程池永远看不到它们 → 无人问津）。
 * 旧 getCurrentSchedule / 旧地图完全不受影响。
 */
export function getSceneSchedule(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
): ScheduleEntry | null {
  // 确保 now 所在北京日已落库，然后读库返回 now 落在的那一段。
  const dayKey = bjDayKey(now);
  const tomorrow = bjDayKey(now + 86400000);
  ensureSceneDay(playerId, characterId, charData, dayKey);
  ensureSceneDay(playerId, characterId, charData, tomorrow); // 保证跨日连续

  const row = db.prepare(`
    SELECT location_id, location_name, activity, start_time, duration
    FROM scene_schedule_entries
    WHERE player_id = ? AND character_id = ?
      AND start_time <= ? AND (start_time + duration * 60000) > ?
    ORDER BY start_time DESC LIMIT 1
  `).get(playerId, characterId, now, now) as {
    location_id: string; location_name: string; activity: string; start_time: number; duration: number;
  } | undefined;

  if (!row) return null;
  return {
    locationId: row.location_id,
    locationName: row.location_name,
    activity: row.activity,
    startTime: row.start_time,
    duration: row.duration,
  };
}

/**
 * 【新地图专用】读库返回角色 [now, now+hours) 的连续行程段。
 * 每天先 ensureSceneDay 落库（不覆盖已存在记录），再整体读库切片，得到连续、非整点、
 * 睡觉只占1条的行程。LLM 改过的库记录（is_llm_edited）会被优先读出。
 */
export function getSceneUpcomingSchedule(
  playerId: string,
  characterId: string,
  charData: Record<string, any>,
  now: number,
  hours: number = 4,
): ScheduleEntry[] {
  const horizon = now + hours * 3600 * 1000;

  // 确保视野覆盖到的所有北京日已落库
  const day0 = bjDayKey(now);
  const day1 = bjDayKey(horizon);
  ensureSceneDay(playerId, characterId, charData, day0);
  if (day1 !== day0) ensureSceneDay(playerId, characterId, charData, day1);

  const rows = db.prepare(`
    SELECT location_id, location_name, activity, start_time, duration
    FROM scene_schedule_entries
    WHERE player_id = ? AND character_id = ?
      AND start_time < ? AND (start_time + duration * 60000) > ?
    ORDER BY start_time
  `).all(playerId, characterId, horizon, now) as {
    location_id: string; location_name: string; activity: string; start_time: number; duration: number;
  }[];

  // 截取 [now, horizon) 视野，并让当前段起点截断到 now
  const out: ScheduleEntry[] = [];
  for (const r of rows) {
    const start = Math.max(r.start_time, now);
    const end = Math.min(r.start_time + r.duration * 60000, horizon);
    if (end <= start) continue;
    out.push({
      locationId: r.location_id,
      locationName: r.location_name,
      activity: r.activity,
      startTime: start,
      duration: Math.round((end - start) / 60000),
    });
  }
  return out;
}

/**
 * 约会内换地点时，把角色当前时段的行程对齐到新地点（写 is_llm_edited=1，不被自动重生成覆盖）。
 *
 * 删掉与 [now, now+duration) 重叠的旧生成行，再插入一条新地点的 LLM 编辑行。
 * 这样后端行程接口 getSceneSchedule / getSceneUpcomingSchedule 与地图都能看到角色落在新地点，
 * 且与新场景约会 current_location_id 保持一致。
 */
export function overrideSceneScheduleToLocation(
  playerId: string,
  characterId: string,
  locationId: string,
  locationName: string,
  activity = '和你约会',
  durationMin = 120,
): void {
  const now = Date.now();
  const dayKey = bjDayKey(now);

  // 删除与 [now, now+duration) 重叠的旧生成行（保留其他 LLM 编辑行）
  db.prepare(`
    DELETE FROM scene_schedule_entries
    WHERE player_id = ? AND character_id = ? AND day_key = ?
      AND is_llm_edited = 0
      AND start_time < ? AND (start_time + duration * 60000) > ?
  `).run(playerId, characterId, dayKey, now + durationMin * 60000, now);

  const id = `${playerId}:${characterId}:llm:${now}`;
  db.prepare(`
    INSERT OR REPLACE INTO scene_schedule_entries
      (id, player_id, character_id, day_key, location_id, location_name, activity, start_time, duration, is_llm_edited, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, playerId, characterId, dayKey, locationId, locationName, activity, now, durationMin, now);
}
