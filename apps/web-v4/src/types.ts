export type GenderType = '未设定' | '男' | '女' | '自定义';

export interface WechatAccount {
  id: string;
  passwordVal: string;
}

export interface EmotionSignals {
  nervous?: string; // 紧张
  happy?: string; // 开心
  angry?: string; // 愤怒
  touched?: string; // 感动
  defensive?: string; // 防御
}

export interface CharacterBackground {
  origin?: string; // 出身
  experience?: string; // 经历
  current?: string; // 现状
}

export interface Character {
  id: string;
  name: string;
  nickname: string;
  gender: GenderType | string;
  age?: string;
  appearance?: string;
  identity: string; // 身份 / 职业
  tag: string;
  avatar: string;
  avatarUrl?: string;
  status: string; // 当前状态签名
  relationshipStatus: string;
  daysTogether: number;
  startDate: string;
  intimacyLevel: number;
  currentLocation: string;
  isDefault?: boolean;

  // 性格
  personalitySurface?: string; // 表层
  personalityCore?: string; // 内核
  personalityExtreme?: string; // 极端

  // 说话风格
  speechStyle?: string; // 概述

  // 短信风格
  messageStyle?: string; // 概述

  // 情绪信号
  emotionSignals?: EmotionSignals;

  // 背景
  background?: CharacterBackground;

  // 喜好 / 厌恶 / 底线 / 目标 / 怪癖
  likes?: string;
  dislikes?: string;
  boundaries?: string;
  goals?: string;
  quirks?: string;

  // 与玩家的关系
  relationshipWithPlayer?: string;

  // 「我的空间」状态（来自 /me/characters，由 mapCharacterDataToCharacter 填充）
  hasFork?: boolean;
  factCount?: number;
  chronicleCount?: number;

  // 擅长 / 不擅长
  strengths?: string;
  weaknesses?: string;

  // 提示词与账号
  personaPrompt: string;
  wechatAccount: WechatAccount;
}

export type MemoryCategory = 'memory' | 'date' | 'script' | 'anniversary';

export interface MemoryItem {
  id: string;
  characterId: string;
  type: 'dream' | 'message' | 'heart' | 'date' | 'milestone';
  timestamp: string;
  dateStr: string;
  content: string;
  title?: string;
  isPinned: boolean;
  isTodo: boolean;
  category: MemoryCategory;
  location?: string;
  tags?: string[];
  expanded?: boolean;
  characterName?: string;
  messageCount?: number;
  atmosphereText?: string;
  dialogueBubbles?: {
    speech: string;
    action?: string;
    thought?: string;
  }[];
}

export interface ScriptChoice {
  text: string;
  reaction: string;
  affinityGain: number;
}

export interface DateScenario {
  id: string;
  title: string;
  subtitle: string;
  location: string;
  coverImage: string;
  description: string;
  atmosphere: string;
  dialogues: {
    speaker: string;
    text: string;
    action?: string;
  }[];
  choices?: ScriptChoice[];
}

export interface ChatMessage {
  id: string;
  characterId: string;
  sender: 'user' | 'character' | 'system';
  content: string;
  timestamp: string;
  actionDesc?: string;
  isVoice?: boolean;
  voiceDuration?: number;
  quotedMsg?: {
    id: string;
    senderName: string;
    content: string;
  };
  timeDivider?: string;
}

export interface MomentComment {
  id: string;
  authorName: string;
  authorAvatar?: string;
  replyTo?: string;
  content: string;
  timestamp: string;
}

export interface MomentPost {
  id: string;
  authorId?: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  images?: string[];
  location?: string;
  timeStr: string;
  device?: string;
  likes: string[];
  comments: MomentComment[];
  visibility?: string;
}

export interface EmailItem {
  id: string;
  senderName: string;
  senderAvatar?: string;
  senderEmail?: string;
  recipientName?: string;
  subject: string;
  preview: string;
  body: string;
  dateStr: string;
  timestamp: number;
  isUnread: boolean;
  isStarred?: boolean;
  giftAttachment?: {
    name: string;
    icon: string;
    description: string;
  };
}

export interface StickyNoteItem {
  id: string;
  authorId?: string;
  authorName: string;
  authorAvatar?: string;
  badgeEmoji?: string;
  content: string;
  timeStr: string;
  themeColor?: string;
}

export interface UserProfile {
  name: string;
  avatar?: string;
  avatarUrl?: string;
  appearance: string;
  theme: string;
  backgroundPreset: string;
  customBackgroundUrl?: string;
  videoCallBackgroundUrl?: string;
  videoCallPreset?: string;
  workModeEnabled: boolean;
  workModeLabel?: string;
  dialogueTemp: number; // e.g. 42
}

export interface DatingNarrativeItem {
  id: string;
  type: 'environment' | 'character' | 'user';
  timestamp: number;
  text?: string;
  characterName?: string;
  characterAvatar?: string;
  actionLead?: string;
  spokenDialogue?: string;
  actionFollow?: string;
  innerVoice?: string;
  isInnerVoiceExpanded?: boolean;
  followUpDialogue?: string;
  followUpAction?: string;
  content?: string;
}

export type ActiveTab =
  | 'home'
  | 'chat'
  | 'dating-chat'
  | 'feedback'
  | 'diary'
  | 'archive'
  | 'settings'
  | 'edit-character'
  | 'creator'
  | 'moments'
  | 'mailbox'
  | 'map-dating'
  | 'task-world'
  | 'scenarios'
  | 'scenario-detail'
  | 'scenario-scene'
  | 'scenery-view'
  | 'location-select'
  | 'scenario-editor'
  | 'novels'
  | 'novel-editor'
  | 'novel-play'
  | 'admin';

/** 当前角色的「当前行程」——地图约会/短信约会/任务/剧本四态，空闲时 idle */
export type ActivityState =
  | { kind: 'idle' }
  | { kind: 'scene-date'; sessionId: string; characterName: string; locationName?: string; isGroup?: boolean }
  | { kind: 'dating'; sessionId: string; characterName: string; locationName?: string }
  | { kind: 'mission'; sessionId: string; title: string }
  | { kind: 'scenario'; sessionId: string; title: string };
