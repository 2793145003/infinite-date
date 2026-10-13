/**
 * 无限心动 — 共享类型定义
 * 后端前端共用一份
 */

// ─── 角色卡 ──────────────────────────────────────────────

export interface Personality {
  surface: string;   // 日常面具
  core: string;      // 性格底色
  extreme: string;   // 极端状态
}

export interface SpeechStyle {
  description: string;
  examples: { context: string; line: string }[];
}

export interface TextingStyle {
  description: string;
  examples: string[];
}

export interface Background {
  origin: string;
  shaping: string;
  current: string;
}

export interface EmotionalSignals {
  nervous: string;
  happy: string;
  angry: string;
  moved: string;
  defensive: string;
}

export interface BackstoryMilestone {
  label: string;
  time_description: string;
  summary: string;
  diff: Record<string, unknown>; // 和当前角色卡不同的字段
  dramatic_potential: 'high' | 'medium' | 'low';
}

export interface CharacterData {
  name: string;
  gender?: string; // 'male' | 'female'。角色性别（攻略对象不一定是男性）。旧数据缺失视为男性
  age: string;
  appearance: string;
  personality: Personality;
  speechStyle: SpeechStyle;
  textingStyle: TextingStyle;
  background: Background;
  emotional_signals: EmotionalSignals;
  likes: string[];
  dislikes: string[];
  boundaries: string;
  goals: string;
  quirks: string;
  backstory_milestones: BackstoryMilestone[];
  player_relation?: string; // 角色和玩家的预设关系，影响初始态度。空=无预设关系
  skills?: string; // 角色擅长的事，自由文本描述。NPC任务时系统据此生成配合特长的世界
  ineptitudes?: string; // 角色不擅长的事，自由文本描述
  drive?: string; // 内驱力：系统从人设素材提炼的「主动找话题/推进」方向。NSFW/病娇角色无此字段
  sleepType?: 'night_owl' | 'normal'; // 作息类型：夜猫子(白天睡) / 正常人(晚上睡)。LLM创建时推测、管理界面可改
  avatar?: string; // 角色头像（uploads/ 目录下的图片文件名，经 imageUrl() 访问）。空=未设，前端用首字占位
}

// ─── NPC形态 ─────────────────────────────────────────────

export type SourceType = 'public' | 'override' | 'private';

// ─── LLM结构化输出 ───────────────────────────────────────

/**
 * 八维心绪（0-100）—— 角色的心理状态快照。
 * 短信路径启用（见 server/src/lib/emotion.ts），约会聊天等共享 REPLY_SCHEMA 的路径不启用，
 * 故在 LlmStructuredReply 里是可选字段。
 */
export interface EmotionScores {
  joy: number; // 愉悦
  desire: number; // 欲望
  panic: number; // 慌乱
  loss: number; // 失落
  grievance: number; // 委屈
  anger: number; // 愤怒
  possessiveness: number; // 占有欲
  tenderness: number; // 怜爱
}

export interface LlmStructuredReply {
  messages: string[];
  internal: string;
  internal_notable: boolean;
  player_description: string;
  scene_concluded: boolean;
  current_location?: string; // 本轮结束时角色所在地点名称（移动了才填，没移动留空）
  need_search?: boolean; // NPC判断是否需要搜索记忆（短输入/nudge时）
  search_query?: string; // need_search=true时的检索query
  image_prompt?: string; // 可选：男主主动想配图的场景描述（中文，只描述景/物，绝不含人）。空/缺省=不配图
  emotions?: EmotionScores; // 可选：本轮八维心绪快照（仅启用心绪的路径会给出）
}

// ─── 常量 ────────────────────────────────────────────────

export const DEITY_ID = 'DEITY';

export const TUTORIAL_STEPS = {
  NOT_STARTED: 0,
  EMAIL_SENT: 1,
  EMAIL_READ: 2,
  CITY_ENTERED: 3,
  COMPLETED: 4,
} as const;

// ─── API类型 ─────────────────────────────────────────────

export interface AuthSession {
  playerId: string;
  token: string;
}

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
}
