// LLM 交互层：prompt 组装
// 原则：程序记事实（履历=朴素事实时间轴），LLM 讲故事（人设卡 backstory / 对话台词）。
// 履历以纯文本注入 prompt，不加工；LLM 只负责文学性，不负责事实。

import type { ChatMessage } from '../llm/adapter';
import type { CharacterCard, EventLog, Npc } from './types';
import { REALMS } from './types';

// 履历 → 时间轴文本（女修手札式朴素事实，按 tick 升序）
export function formatHistory(log: EventLog[]): string {
  if (log.length === 0) return '（无履历：此人尚无事件记录）';
  return log
    .slice()
    .sort((a, b) => a.tick - b.tick)
    .map((e) => `第${e.tick}月·${e.type}：${e.desc}`)
    .join('\n');
}

// NPC 基础属性 → 文本块
export function formatNpcBase(npc: Npc): string {
  return [
    `姓名：${npc.name}`,
    `性别：${npc.gender}`,
    `五行：${npc.wx}`,
    `出身：${npc.origin}`,
    `门派/势力：${npc.faction}`,
    `阵营：${npc.alignment}`,
    `MBTI：${npc.mbti}`,
    `境界：${REALMS[npc.realm]}`,
    `资质${npc.aptitude} 悟性${npc.comprehension} 魅力${npc.charm} 气运${npc.fortune}`,
  ].join('\n');
}

// 人设卡 prompt：基础属性 + 履历 → 人设卡
export function buildCardMessages(npc: Npc, log: EventLog[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: '你是一名修仙世界的角色设定师。给定一位修士的基础属性与其生平履历，生成一张人设卡（性格、说话风格、背景故事、对玩家的态度）。背景故事只能依据给定履历与基础属性，不得编造履历外的事件。',
    },
    {
      role: 'user',
      content: [
        '【基础属性】',
        formatNpcBase(npc),
        '',
        '【生平履历】（时间轴，事实记录）',
        formatHistory(log),
        '',
        '请输出 JSON：personality / speechStyle / backstory / attitudeToPlayer 四个字段。',
      ].join('\n'),
    },
  ];
}

export interface ChatTurn {
  speaker: 'player' | 'npc';
  text: string;
}

// 对话 prompt：人设卡 + 基础属性 + 履历 + 对话历史 + 玩家发言 → 回复
export function buildChatMessages(
  npc: Npc,
  card: CharacterCard,
  log: EventLog[],
  history: ChatTurn[],
  playerMsg: string,
): ChatMessage[] {
  const cardText = [
    '【人设卡】',
    `性格：${card.personality}`,
    `说话风格：${card.speechStyle}`,
    `背景故事：${card.backstory}`,
    `对玩家的态度：${card.attitudeToPlayer}`,
  ].join('\n');

  const histText = history.length === 0
    ? '（尚无对话）'
    : history.map((h) => (h.speaker === 'player' ? `玩家：${h.text}` : `${npc.name}：${h.text}`)).join('\n');

  return [
    {
      role: 'system',
      content: `你正在扮演一位修仙世界的修士，名叫「${npc.name}」。严格按人设卡的性格与说话风格回应玩家，用第一人称。记住你与玩家之间发生过的事。你只输出符合 JSON schema 的结构化回复，台词写在 reply 字段。`,
    },
    {
      role: 'user',
      content: [
        cardText,
        '',
        '【基础属性】',
        formatNpcBase(npc),
        '',
        '【生平履历】',
        formatHistory(log),
        '',
        '【本轮对话历史】',
        histText,
        '',
        '【玩家刚刚说】',
        playerMsg,
        '',
        '请以该 NPC 的身份输出 JSON：reply / innerThought / affinityDelta / fact。',
      ].join('\n'),
    },
  ];
}
