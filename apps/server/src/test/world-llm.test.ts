// Phase 4 LLM 交互层单测 —— 人设卡 / 对话 / 写回。
// 依赖注入：LLM 用 mock 生成器（不真调 vLLM），写回用捕获函数（不依赖真实演化）。
// 覆盖：schema + normalize 校验、prompt 组装、门面函数、WorldEngine.recordChat。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_SCHEMA, CHAT_SCHEMA, normalizeCard, normalizeChat } from '../world/llm-schema';
import { buildCardMessages, buildChatMessages, formatHistory, formatNpcBase } from '../world/llm-prompt';
import { chatTurn, generateCharacterCard } from '../world/llm';
import type { LlmGenerate } from '../world/llm';
import { WorldEngine } from '../world/world';
import { createPlayer } from '../world/player';
import { makeRng } from '../world/rng';
import type { CharacterCard, ChatReply, EventLog, Npc } from '../world/types';

function makeNpc(over: Partial<Npc> = {}): Npc {
  const base: Npc = {
    id: 1,
    name: '云隐',
    gender: '女',
    wx: '水',
    origin: '散修',
    faction: '青云宗',
    alignment: '中立善良',
    mbti: 'INFJ',
    realm: 1,
    qi: 50,
    aptitude: 70,
    comprehension: 80,
    charm: 85,
    fortune: 60,
    lifespan: 100,
    loc: 0,
    alive: true,
    liveliness: 1,
    backpack: [],
    daolv: [],
    affinities: new Map(),
    affinityToPlayer: 0,
    ...over,
  };
  return base;
}

const LOG: EventLog[] = [
  { id: 1, tick: 3, type: '赠宝', desc: '云隐赠你一枚凝气丹', visibility: 'private', loc: 0, npcIds: [1], playerIntervened: true },
  { id: 2, tick: 7, type: '渡劫', desc: '云隐渡劫成功，结成金丹', visibility: 'public', loc: 0, npcIds: [1], playerIntervened: false },
];

// ─── normalize 校验 ───

test('normalizeCard 合法输入返回人设卡', () => {
  const card = normalizeCard({ personality: ' 温柔 ', speechStyle: '轻声', backstory: '故事', attitudeToPlayer: '初识' });
  assert.ok(card);
  assert.equal(card!.personality, '温柔');
  assert.equal(card!.speechStyle, '轻声');
});

test('normalizeCard 缺失/空白字段返回 null', () => {
  assert.equal(normalizeCard({ personality: 'a', speechStyle: 'b', backstory: 'c' }), null);
  assert.equal(normalizeCard({ personality: '  ', speechStyle: 'b', backstory: 'c', attitudeToPlayer: 'd' }), null);
  assert.equal(normalizeCard({ personality: 1, speechStyle: 'b', backstory: 'c', attitudeToPlayer: 'd' }), null);
});

test('normalizeChat 合法输入 + affinityDelta clamp', () => {
  const r = normalizeChat({ reply: '你好', innerThought: '此人眼熟', affinityDelta: 9, fact: '云隐与你问候' });
  assert.ok(r);
  assert.equal(r!.reply, '你好');
  assert.equal(r!.affinityDelta, 5, '9 应 clamp 到 5');
  const r2 = normalizeChat({ reply: '嗯', innerThought: '', affinityDelta: -99, fact: 'x' });
  assert.equal(r2!.affinityDelta, -5, '-99 应 clamp 到 -5');
});

test('normalizeChat reply/fact 空返回 null，affinityDelta 非法回退 0', () => {
  assert.equal(normalizeChat({ reply: '', innerThought: '', affinityDelta: 0, fact: 'x' }), null);
  assert.equal(normalizeChat({ reply: 'a', innerThought: '', affinityDelta: 0, fact: ' ' }), null);
  const r = normalizeChat({ reply: 'a', innerThought: '', affinityDelta: 'oops', fact: 'x' });
  assert.equal(r!.affinityDelta, 0, '非法 affinityDelta 回退 0 而非重试');
});

test('schema 是命名字段 object，required 全覆盖 + additionalProperties:false', () => {
  assert.equal(CARD_SCHEMA.type, 'object');
  assert.deepEqual(CARD_SCHEMA.required, ['personality', 'speechStyle', 'backstory', 'attitudeToPlayer']);
  assert.equal(CARD_SCHEMA.additionalProperties, false);
  assert.equal(CHAT_SCHEMA.type, 'object');
  assert.deepEqual(CHAT_SCHEMA.required, ['reply', 'innerThought', 'affinityDelta', 'fact']);
  assert.equal(CHAT_SCHEMA.additionalProperties, false);
});

// ─── prompt 组装 ───

test('formatHistory 按 tick 升序、空履历兜底', () => {
  const text = formatHistory(LOG);
  assert.ok(text.indexOf('第3月·赠宝') < text.indexOf('第7月·渡劫'), '应按时间升序');
  assert.ok(text.includes('云隐赠你一枚凝气丹'));
  assert.equal(formatHistory([]), '（无履历：此人尚无事件记录）');
});

test('formatNpcBase 含姓名/五行/境界/门派', () => {
  const npc = makeNpc();
  const text = formatNpcBase(npc);
  assert.ok(text.includes('云隐'));
  assert.ok(text.includes('水'));
  assert.ok(text.includes('筑基'));
  assert.ok(text.includes('青云宗'));
});

test('buildCardMessages 注入基础属性 + 履历', () => {
  const npc = makeNpc();
  const msgs = buildCardMessages(npc, LOG);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, 'system');
  const user = msgs[1]!.content;
  assert.ok(user.includes('云隐'), '应含姓名');
  assert.ok(user.includes('云隐渡劫成功'), '应含履历事实');
  assert.ok(user.includes('personality'), '应提示输出字段');
});

test('buildChatMessages 注入人设卡 + 履历 + 历史 + 玩家发言', () => {
  const npc = makeNpc();
  const card: CharacterCard = { personality: '温吞', speechStyle: '爱用「唔」', backstory: '故事', attitudeToPlayer: '初识' };
  const msgs = buildChatMessages(npc, card, LOG, [{ speaker: 'player', text: '你好' }, { speaker: 'npc', text: '唔，何事' }], '再会');
  const sys = msgs[0]!.content;
  const user = msgs[1]!.content;
  assert.ok(sys.includes('云隐'));
  assert.ok(user.includes('温吞'));
  assert.ok(user.includes('唔，何事'), '应含对话历史');
  assert.ok(user.includes('再会'), '应含玩家最新发言');
});

// ─── 门面函数（mock LLM）───

test('generateCharacterCard 用 mock 生成器，传对 messages/schema', async () => {
  const npc = makeNpc();
  let seenMessages: unknown = null;
  let seenSchema: unknown = null;
  const mock: LlmGenerate<CharacterCard> = async (m, s) => {
    seenMessages = m;
    seenSchema = s;
    return { personality: '温吞', speechStyle: '轻声', backstory: '故事', attitudeToPlayer: '初识' };
  };
  const card = await generateCharacterCard(npc, LOG, mock);
  assert.ok(card);
  assert.equal(card!.personality, '温吞');
  assert.equal(seenSchema, CARD_SCHEMA);
  assert.ok((seenMessages as { content: string }[]).some((m) => m.content.includes('云隐')));
});

test('generateCharacterCard mock 返回 null → 透传 null', async () => {
  const mock: LlmGenerate<CharacterCard> = async () => null;
  assert.equal(await generateCharacterCard(makeNpc(), LOG, mock), null);
});

test('chatTurn 用 mock 生成器 + 捕获写回，好感 delta/fact 正确传递', async () => {
  const npc = makeNpc();
  const card: CharacterCard = { personality: 'p', speechStyle: 's', backstory: 'b', attitudeToPlayer: 'a' };
  const mock: LlmGenerate<ChatReply> = async () => ({
    reply: '你好', innerThought: '面善', affinityDelta: 3, fact: '云隐与你见礼',
  });
  const recorded: { npcId: number; fact: string; delta: number }[] = [];
  const fakeEvent: EventLog = { id: 99, tick: 1, type: '交谈', desc: '云隐与你见礼', visibility: 'private', loc: 0, npcIds: [1], playerIntervened: true };
  const record = (npcId: number, fact: string, delta: number) => {
    recorded.push({ npcId, fact, delta });
    return fakeEvent;
  };
  const out = await chatTurn(npc, card, LOG, [], '你好', mock, record);
  assert.ok(out);
  assert.equal(out!.reply.reply, '你好');
  assert.equal(out!.event, fakeEvent);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.npcId, 1);
  assert.equal(recorded[0]!.fact, '云隐与你见礼');
  assert.equal(recorded[0]!.delta, 3);
});

test('chatTurn LLM 返回 null → 不写回', async () => {
  const npc = makeNpc();
  const card: CharacterCard = { personality: 'p', speechStyle: 's', backstory: 'b', attitudeToPlayer: 'a' };
  let called = 0;
  const record = () => { called++; return null; };
  const mock: LlmGenerate<ChatReply> = async () => null;
  assert.equal(await chatTurn(npc, card, LOG, [], 'hi', mock, record), null);
  assert.equal(called, 0, 'LLM 失败不应触发写回');
});

// ─── WorldEngine.recordChat（程序记事实）───

test('recordChat 双向更新好感并写「交谈」事件', () => {
  const engine = new WorldEngine({ seed: 7, npcCount: 3 });
  const player = createPlayer(makeRng(1), { name: '测试', loc: 0 });
  engine.attachPlayer(player);
  const npc = engine.aliveNpcs()[0]!;
  const before = npc.affinityToPlayer;
  const ev = engine.recordChat(npc.id, '云隐与你论道，相谈甚欢', 4);
  assert.ok(ev);
  assert.equal(ev!.type, '交谈');
  assert.equal(ev!.visibility, 'private');
  assert.equal(ev!.npcIds[0], npc.id);
  assert.equal(ev!.playerIntervened, true);
  assert.equal(npc.affinityToPlayer, before + 4);
  assert.equal(player.affinities.get(npc.id), 4);
});

test('recordChat 好感 clamp 到 -100..100', () => {
  const engine = new WorldEngine({ seed: 7, npcCount: 1 });
  const player = createPlayer(makeRng(1), { name: '测试', loc: 0 });
  engine.attachPlayer(player);
  const npc = engine.aliveNpcs()[0]!;
  npc.affinityToPlayer = 99;
  engine.recordChat(npc.id, 'x', 5);
  assert.equal(npc.affinityToPlayer, 100);
  engine.recordChat(npc.id, 'x', -5);
  assert.equal(npc.affinityToPlayer, 95, '不应跌破下界逻辑，100-5=95 正常');
});

test('recordChat 已死 NPC 返回 null', () => {
  const engine = new WorldEngine({ seed: 7, npcCount: 1 });
  const npc = engine.aliveNpcs()[0]!;
  npc.alive = false;
  assert.equal(engine.recordChat(npc.id, 'x', 0), null);
});
