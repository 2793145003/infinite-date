// 衍生世界 —— 核心类型与常量
// 修仙题材，五行生克驱动程序演化。本文件只放类型和常量，无逻辑。

import type { MapSave, WorldMap } from './map';

export type Wx = '金' | '木' | '水' | '火' | '土';

export type Kinship = '父母' | '子孙' | '官鬼' | '妻财' | '兄弟';

export type Alignment =
  | '守序善良' | '中立善良' | '混乱善良'
  | '守序中立' | '绝对中立' | '混乱中立'
  | '守序邪恶' | '中立邪恶' | '混乱邪恶';

export const ALIGNMENTS: readonly Alignment[] = [
  '守序善良', '中立善良', '混乱善良',
  '守序中立', '绝对中立', '混乱中立',
  '守序邪恶', '中立邪恶', '混乱邪恶',
];

// MBTI 十六型
export const MBTI_TYPES: readonly string[] = [
  'ISTJ', 'ISFJ', 'INFJ', 'INTJ',
  'ISTP', 'ISFP', 'INFP', 'INTP',
  'ESTP', 'ESFP', 'ENFP', 'ENTP',
  'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ',
];

// 境界（0..4），每一级对应寿元上限与突破难度
export const REALMS = ['练气', '筑基', '金丹', '元婴', '化神'] as const;
export type Realm = 0 | 1 | 2 | 3 | 4;

// 各境界寿元上限（月为基准粗略折算：1 寿元单位 = 1 月）
export const REALM_LIFESPAN: readonly number[] = [60, 120, 300, 800, 2000];

// 突破到金丹（realm>=2）即为「渡劫」，是公开大事件
export const REBIRTH_REALM = 2;

export interface Npc {
  id: number;
  name: string;
  gender: '男' | '女';
  wx: Wx;
  origin: string;       // 出身
  faction: string;      // 门派 / 势力
  alignment: Alignment;
  mbti: string;
  realm: Realm;         // 境界
  qi: number;           // 灵力（修为储备，用于突破积累）
  aptitude: number;     // 资质（根骨）1..100
  comprehension: number;// 悟性 1..100
  charm: number;        // 魅力 1..100
  fortune: number;      // 气运 1..100
  lifespan: number;     // 剩余寿元（月）
  loc: number;          // 格子坐标（扁平，0..size²-1）
  alive: boolean;
  liveliness: 0 | 1;    // 0=背景层，1=玩家遇到后活过来
  backpack: Item[];     // 背包
  daolv: number[];      // 道侣 id 列表
  affinities: Map<number, number>; // 好感度/恩怨值：npcId -> -100..100
  affinityToPlayer: number;        // 该 NPC 对玩家的好感 -100..100
  characterData?: CharacterCard;   // 人设卡（玩家遇到并选择才懒加载生成，Phase 4）
}

export interface Player {
  name: string;
  gender: '男' | '女';
  wx: Wx;
  realm: Realm;
  qi: number;
  aptitude: number;
  comprehension: number;
  charm: number;
  fortune: number;
  lifespan: number;
  loc: number;          // 格子坐标（扁平）
  backpack: Item[];
  energy: number;       // 精力 0..100，耗尽 → 休息 → 跳月
  actionPoints: number; // 每回合行动点（移动/介入消耗）
  affinities: Map<number, number>; // 玩家对 NPC 的好感
}

export type ItemType = '丹药' | '灵草' | '法宝' | '秘籍' | '材料' | '符箓';
export type Quality = '下品' | '中品' | '上品' | '极品';

export interface Item {
  id: number;
  name: string;
  type: ItemType;
  quality: Quality;
  // 效果：数值加成。Phase 1 只做三个维度
  lifespanBonus?: number;  // 延寿（月）
  qiBonus?: number;        // 灵力增益
  realmBreak?: number;     // 突破成功率加成（0..1）
}

// ---------- Phase 3：制造系统 ----------

export interface Material {
  type: ItemType;   // 材料类型
  count: number;    // 数量
}

export type EffectKind = 'qi' | 'lifespan' | 'break';

export interface Recipe {
  id: number;
  name: string;             // 配方名（「凝气丹方」）
  outputType: ItemType;     // 产出物品类型
  outputName: string;       // 产出物品名（「凝气丹」）
  materials: Material[];    // 材料清单
  faction?: string;         // 门派限制（undefined = 通用，人人会）
  successRate: number;      // NPC 制造成功率 0..1
  effect: { kind: EffectKind; base: number };  // 产出效果（品质乘数放大）
}

export interface CraftResult {
  success: boolean;
  desc: string;             // 事实描述
  item?: Item;              // 成品（成功时）
  quality?: Quality;        // 成品品质
  score?: number;           // 玩家二消分数（玩家制造时）
}

export type EventType =
  | '争执'       // 口角，好感下降（private）
  | '夺宝'       // 强抢物品（private）
  | '生死斗'     // 拼斗，可能重伤/死亡（public）
  | '提携'       // 高境界指点低境界（private）
  | '赠宝'       // 送物品（private）
  | '结缘'       // 结为道侣（public）
  | '切磋'       // 同境界比试（private）
  | '竞争机缘'   // 争资源（private）
  | '突破'       // 普通突破（练气→筑基，private）
  | '渡劫'       // 突破金丹及以上（public，含失败陨落）
  | '陨落'       // 寿终/斗法/渡劫失败而亡（public）
  | '相遇'       // 玩家与 NPC 相遇，NPC 从背景层升格（private）
  | '制造'       // 炼丹/炼器（private）
  | '交谈';      // 玩家与 NPC 对话（private，Phase 4 写回）

export interface EventLog {
  id: number;
  tick: number;          // 月
  type: EventType;
  desc: string;          // 事实描述（谁/何时/何地/何事）
  visibility: 'public' | 'private';
  loc: number;
  npcIds: number[];
  itemId?: number;
  playerIntervened: boolean;
  outcome?: string;      // 介入后的结局描述（玩家介入时写入）
}

// 玩家对「待结算事件」的介入动作
export type InterveneAction = '帮A' | '帮B' | '劝架' | '旁观';

// 待结算事件（检测相遇后、结算前，供玩家介入）
export interface PendingEvent {
  subjectId: number;  // 主动方
  objectId: number;   // 被动方
  type: EventType;
  loc: number;
  intervention?: Exclude<InterveneAction, '旁观'>; // 玩家选择的介入动作
  interveneTarget?: number;  // 帮A=subjectId / 帮B=objectId
}

// 世界状态
export interface World {
  tick: number;          // 当前月
  npcs: Map<number, Npc>;
  events: EventLog[];    // event_log 全量
  map: WorldMap;         // 走格子地图（大方格套小方格）
  nextNpcId: number;
  nextItemId: number;
  nextEventId: number;
  player?: Player;       // 玩家（Phase 2 引入，可介入世界）
}

// ---------- 序列化（web 交付：世界状态落库 JSON） ----------
// Map 不能进 JSON，affinities 转成 Record<string, number>（键是 npcId 字符串）。

export interface SerializedNpc extends Omit<Npc, 'affinities'> {
  affinities: Record<string, number>;
}

export interface SerializedPlayer extends Omit<Player, 'affinities'> {
  affinities: Record<string, number>;
}

export interface WorldSave {
  tick: number;
  nextNpcId: number;
  nextItemId: number;
  nextEventId: number;
  rngState: number;      // mulberry32 内部状态（uint32）
  map: MapSave;
  npcs: SerializedNpc[];
  events: EventLog[];
  player?: SerializedPlayer;
}

// 事件类型 -> 可见性
export const EVENT_VISIBILITY: Record<EventType, 'public' | 'private'> = {
  争执: 'private',
  夺宝: 'private',
  生死斗: 'public',
  提携: 'private',
  赠宝: 'private',
  结缘: 'public',
  切磋: 'private',
  竞争机缘: 'private',
  突破: 'private',
  渡劫: 'public',
  陨落: 'public',
  相遇: 'private',
  制造: 'private',
  交谈: 'private',
};

// ---------- Phase 4：LLM 交互层 ----------

// 人设卡（懒加载生成：玩家遇到并选择该 NPC 时，LLM 读「基础属性 + 已积累履历」生成）
export interface CharacterCard {
  personality: string;       // 性格（融合九宫格 + MBTI + 履历行为）
  speechStyle: string;       // 说话风格（口癖、句式、用词）
  backstory: string;         // 背景故事（读履历讲的自然语言生平，女修手札式）
  attitudeToPlayer: string;  // 对玩家的态度（基于好感 + 相遇/交往历史）
}

// 对话回复（LLM 输出；程序层把 fact/affinityDelta 写回履历，保证事实可追溯）
export interface ChatReply {
  reply: string;          // NPC 台词（第一人称）
  innerThought: string;   // 内心活动（可空串）
  affinityDelta: number;  // 好感变化 -5..5（程序层 clamp）
  fact: string;           // 一句事实（谁/何事/结果），写回履历 desc
}
