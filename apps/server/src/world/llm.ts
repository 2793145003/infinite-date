// LLM 交互层门面：懒加载人设卡 + 对话 + 写回。
// 依赖注入与 chatJson 同形的 generate 函数 + 写回 record 函数，
// 离线单测用 mock 注入，生产接线用 llm/adapter 的 chatJson + WorldEngine.recordChat。

import type { ChatMessage } from '../llm/adapter';
import type { CharacterCard, ChatReply, EventLog, Npc } from './types';
import { CARD_SCHEMA, CHAT_SCHEMA, normalizeCard, normalizeChat } from './llm-schema';
import { buildCardMessages, buildChatMessages, type ChatTurn } from './llm-prompt';

// 可注入的 LLM 调用：与 chatJson 同形（messages + schema + normalize → T | null）
export type LlmGenerate<T> = (
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  normalize: (obj: Record<string, unknown>) => T | null,
) => Promise<T | null>;

// 读履历生成人设卡（懒加载，调用方负责缓存到 npc.characterData）
export async function generateCharacterCard(
  npc: Npc,
  log: EventLog[],
  generate: LlmGenerate<CharacterCard>,
): Promise<CharacterCard | null> {
  return generate(buildCardMessages(npc, log), CARD_SCHEMA, normalizeCard);
}

export interface ChatOutcome {
  reply: ChatReply;
  event?: EventLog;  // 写回成功的履历事件（record 返回 null 时为 undefined）
}

// 一轮对话：组装 prompt → LLM 回复 → 写回履历 + 好感
export async function chatTurn(
  npc: Npc,
  card: CharacterCard,
  log: EventLog[],
  history: ChatTurn[],
  playerMsg: string,
  generate: LlmGenerate<ChatReply>,
  record: (npcId: number, fact: string, affinityDelta: number) => EventLog | null,
): Promise<ChatOutcome | null> {
  const reply = await generate(
    buildChatMessages(npc, card, log, history, playerMsg),
    CHAT_SCHEMA,
    normalizeChat,
  );
  if (!reply) return null;
  const event = record(npc.id, reply.fact, reply.affinityDelta);
  return { reply, event: event ?? undefined };
}
