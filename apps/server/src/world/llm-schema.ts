// LLM 交互层：guidedJson schema + normalize 校验
// 复用 llm/adapter 的 chatJson（guidedJson 约束 + 重试 + normalize 校验）。
// 命名字段 object schema —— 数组 schema 无法约束 LLM 稳定输出（Phase 3 教训），
// 这里每个字段都是单个 string/number，用 required + additionalProperties:false 固定骨架。

import type { CharacterCard, ChatReply } from './types';

// 人设卡 guidedJson schema
export const CARD_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    personality: {
      type: 'string',
      description: '一句话概括 + 一段展开：融合九宫格阵营、MBTI 与该 NPC 履历中体现的行为，概括性格。',
    },
    speechStyle: {
      type: 'string',
      description: '说话风格：口癖、句式、用词习惯、自称，用于后续对话时保持一致。',
    },
    backstory: {
      type: 'string',
      description: '读给定履历，把事实串成自然语言生平叙事（女修手札式）。只依据履历与基础属性，不编造履历外的事实。',
    },
    attitudeToPlayer: {
      type: 'string',
      description: '对玩家的态度：基于当前好感值与相遇/交往历史，一句客观描述（如「初识，客套疏离」）。',
    },
  },
  required: ['personality', 'speechStyle', 'backstory', 'attitudeToPlayer'],
  additionalProperties: false,
};

// 对话回复 guidedJson schema
export const CHAT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reply: {
      type: 'string',
      description: 'NPC 的第一人称台词，符合人设卡的说话风格，不逐字复述玩家原话。',
    },
    innerThought: {
      type: 'string',
      description: 'NPC 此刻的内心活动（可一句，也可空串表示无特别想法）。',
    },
    affinityDelta: {
      type: 'integer',
      description: '这次对话对「该 NPC 对玩家的好感」的净变化：-5..5 整数（正=升，负=降，0=不变）。',
    },
    fact: {
      type: 'string',
      description: '一句事实描述（谁、说了/做了什么、结果），客观无文学修饰，用于写回履历。',
    },
  },
  required: ['reply', 'innerThought', 'affinityDelta', 'fact'],
  additionalProperties: false,
};

function nonEmpty(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// 校验 + 归一化人设卡；字段缺失/空白返回 null → 触发 chatJson 重试
export function normalizeCard(obj: Record<string, unknown>): CharacterCard | null {
  const personality = nonEmpty(obj.personality);
  const speechStyle = nonEmpty(obj.speechStyle);
  const backstory = nonEmpty(obj.backstory);
  const attitudeToPlayer = nonEmpty(obj.attitudeToPlayer);
  if (!personality || !speechStyle || !backstory || !attitudeToPlayer) return null;
  return { personality, speechStyle, backstory, attitudeToPlayer };
}

// 校验 + 归一化对话回复。reply/fact 必须非空；affinityDelta 非法时回退 0（次要字段，不值得为它重试整轮）。
export function normalizeChat(obj: Record<string, unknown>): ChatReply | null {
  const reply = nonEmpty(obj.reply);
  if (!reply) return null;
  const fact = nonEmpty(obj.fact);
  if (!fact) return null;
  const innerThought = typeof obj.innerThought === 'string' ? obj.innerThought.trim() : '';
  const rawDelta = typeof obj.affinityDelta === 'number' ? obj.affinityDelta : NaN;
  const affinityDelta = Number.isFinite(rawDelta)
    ? Math.round(Math.max(-5, Math.min(5, rawDelta)))
    : 0;
  return { reply, innerThought, affinityDelta, fact };
}
