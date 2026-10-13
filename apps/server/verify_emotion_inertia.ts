/**
 * 心绪连续性（惯性）实验 —— 五轮折线图有没有意义，取决于这个
 *
 * 问题：每轮独立抽取情绪时，模型只看当前情境，可能给出「上一轮愤怒90、下一轮无缘无故愉悦80」
 *   的跳变序列，折线图就成了一坨噪声。
 *
 * 设计：对真实线程的连续 5 轮玩家消息做滚动模拟。
 *   对照组（独立）：每轮不携带上一轮心绪 —— 现有方案
 *   实验组（惯性）：把上一轮抽出的 8 维心绪注入本轮 user 消息（location 用已验证有效的 i3_user 位置），
 *                   并说明「没有新事件就不会凭空消失」
 *   判据：相邻两轮情绪向量的 L1 距离（越小越平滑）；以及最强维度是否连贯。
 *
 * 用法：cd apps/server && npx tsx verify_emotion_inertia.ts --chars=苏烬,穆昭 --rounds=5
 */
import path from 'node:path';
import fs from 'node:fs';
import { db } from './src/db';
import { config } from './src/config';
import { loadCharacterData } from './src/lib/character';
import {
  buildSystemPrompt, buildMessages, REPLY_SCHEMA, getHubLocationsText, getPlayerProfile,
  type PromptContext,
} from './src/prompt/builder';
import type { ChatMessage } from './src/llm/adapter';

const argv = process.argv.slice(2);
const argVal = (k: string, d: string) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const CHARS = argVal('chars', '苏烬,穆昭').split(',').map((s) => s.trim());
const ROUNDS = Number(argVal('rounds', '5'));

const EMOTIONS = [
  { key: 'joy', cn: '愉悦' }, { key: 'desire', cn: '欲望' }, { key: 'panic', cn: '慌乱' },
  { key: 'loss', cn: '失落' }, { key: 'grievance', cn: '委屈' }, { key: 'anger', cn: '愤怒' },
  { key: 'possessiveness', cn: '占有欲' }, { key: 'tenderness', cn: '怜爱' },
] as const;
const KEYS = EMOTIONS.map((e) => e.key);

const EMOTION_OUTPUT_NOTE = [
  '【输出格式补充】除了上面要求的字段，你还要输出一个 emotions 字段，记录你「此刻的心绪」：',
  EMOTIONS.map((e) => `${e.key}=${e.cn}`).join('，'),
  '8 个维度各给一个 0-100 的整数（0=完全没有，100=极其强烈）。',
  '不要把这些词、分数或「心绪」二字写进台词里。',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    ...REPLY_SCHEMA.properties,
    emotions: {
      type: 'object',
      properties: Object.fromEntries(EMOTIONS.map((e) => [e.key, { type: 'integer' }])),
      required: KEYS,
      additionalProperties: false,
    },
  },
  required: [...REPLY_SCHEMA.required, 'emotions'],
};

/** 惯性注入：把上一轮心绪作为「延续中的状态」交给模型 */
function inertiaNote(prev: Record<string, number>): string {
  const entries = EMOTIONS.map((e) => ({ cn: e.cn, v: prev[e.key] ?? 0 }));
  const top = [...entries].sort((a, b) => b.v - a.v)[0]!;
  return [
    `（你此刻的心绪，延续自上一刻：${entries.map((e) => `${e.cn}${e.v}`).join('、')}。）`,
    `你正被「${top.cn}」（${top.v}）占据着，这是上一刻延续下来的状态。如果玩家这句话没有真正安抚你、也没有出现新的事件，这种心绪不会凭空消失——你可以减弱，但要有理由；语气必须跟着它走，不能回到若无其事的样子。`,
  ].join('\n');
}

async function callLLM(messages: ChatMessage[]) {
  const res = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel, messages, temperature: 0.85, max_tokens: 1024,
      repetition_penalty: 1.1, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: SCHEMA } },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const raw = data.choices?.[0]?.message?.content ?? '';
  let obj: Record<string, unknown> | null = null;
  try { obj = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch { /* 未闭合 */ }
  const lines = Array.isArray(obj?.messages) ? (obj!.messages as unknown[]).map(String) : [];
  const emo = (obj?.emotions ?? {}) as Record<string, number>;
  return { lines, text: lines.join(' '), emo };
}

function pickChar(name: string) {
  const threads = db.prepare(`SELECT t.id AS thread_id, t.character_id, t.player_id FROM message_threads t WHERE t.character_id != 'DEITY'`).all() as Array<{ thread_id: string; character_id: string; player_id: string }>;
  for (const t of threads) {
    const cd = loadCharacterData(t.player_id, t.character_id);
    if (!cd || cd.name !== name) continue;
    const rows = db.prepare(`SELECT sender, body FROM text_messages WHERE thread_id = ? AND body != '' ORDER BY created_at DESC, rowid DESC LIMIT 40`).all(t.thread_id) as Array<{ sender: string; body: string }>;
    if (rows.length < 12) continue;
    // 倒序 rows → 顺序化，取最后 ROUNDS 组「玩家→NPC」作为滚动输入
    const seq = rows.slice().reverse();
    const pairs: Array<{ player: string; npc: string }> = [];
    for (let i = 0; i < seq.length - 1 && pairs.length < ROUNDS; i++) {
      if (seq[i]!.sender === 'player' && seq[i + 1]!.sender === 'npc') pairs.push({ player: seq[i]!.body, npc: seq[i + 1]!.body });
    }
    if (pairs.length < ROUNDS) continue;
    const firstIdx = seq.findIndex((r) => r.body === pairs[0]!.player);
    const history = seq.slice(Math.max(0, firstIdx - 8), firstIdx).map((r) => ({ role: (r.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant', text: r.body }));
    return { cd, playerId: t.player_id, history, pairs };
  }
  return null;
}

const l1 = (a: Record<string, number>, b: Record<string, number>) =>
  KEYS.reduce((s, k) => s + Math.abs((a[k] ?? 0) - (b[k] ?? 0)), 0);

const DECAY = 0.75;
/** 自然回落：上一轮的心绪不会原样延续，没有新刺激就衰减 */
function decayed(e: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KEYS) out[k] = Math.round((e[k] ?? 0) * DECAY);
  return out;
}

async function runSeq(c: NonNullable<ReturnType<typeof pickChar>>, mode: 'independent' | 'inertia' | 'decay') {
  const history = [...c.history];
  const emos: Array<Record<string, number>> = [];
  const turns: Array<{ player: string; reply: string; emo: Record<string, number> }> = [];
  for (const p of c.pairs) {
    const ctx: PromptContext = {
      characterData: c.cd, playerDescription: '（离线实验）',
      playerProfile: getPlayerProfile(c.playerId), chronicleSummary: '',
      recentMessages: [...history], isTextMessage: true, isDeity: false,
      locationName: '（短信中无法确定位置）', hubLocations: getHubLocationsText(),
      retrievedMemories: null, situationalNote: EMOTION_OUTPUT_NOTE,
    };
    const msgs = buildMessages(buildSystemPrompt(ctx), ctx.recentMessages, p.player);
    if (mode !== 'independent' && emos.length > 0) {
      const prev = mode === 'decay' ? decayed(emos[emos.length - 1]!) : emos[emos.length - 1]!;
      const last = msgs[msgs.length - 1]!;
      msgs[msgs.length - 1] = { ...last, content: `${inertiaNote(prev)}\n${last.content}` };
    }
    const r = await callLLM(msgs);
    emos.push(r.emo);
    turns.push({ player: p.player, reply: r.lines.join(' / '), emo: r.emo });
    history.push({ role: 'player', text: p.player }, { role: 'assistant', text: r.lines.join('\n') });
  }
  const jumps: number[] = [];
  for (let i = 1; i < emos.length; i++) jumps.push(l1(emos[i - 1]!, emos[i]!));
  return { turns, emos, jumps, avgJump: jumps.reduce((s, v) => s + v, 0) / (jumps.length || 1) };
}

async function main() {
  const report: Record<string, unknown> = {};
  for (const name of CHARS) {
    const c = pickChar(name);
    if (!c) { console.log(`跳过 ${name}`); continue; }
    console.log(`\n${'='.repeat(74)}\n角色 ${name}　滚动 ${ROUNDS} 轮真实玩家消息`);
    const out: Record<string, unknown> = {};
    for (const mode of ['independent', 'inertia', 'decay'] as const) {
      const r = await runSeq(c, mode);
      out[mode] = r;
      const sat = r.emos.flatMap((e) => KEYS.map((k) => e[k] ?? 0)).filter((v) => v >= 85).length;
      const total = r.emos.length * KEYS.length;
      const label = mode === 'independent' ? '对照组：每轮独立抽取' : mode === 'inertia' ? '实验组A：携带上一轮心绪（无衰减）' : '实验组B：携带上一轮心绪（每轮衰减 25%）';
      console.log(`\n【${label}】相邻轮平均变化 ${r.avgJump.toFixed(0)}（0=完全不变，200=全维反向）　高位(≥85)占比 ${(sat / total * 100).toFixed(0)}%`);
      r.turns.forEach((t, i) => {
        const top = EMOTIONS.map((e) => ({ cn: e.cn, v: t.emo[e.key] ?? 0 })).sort((a, b) => b.v - a.v)[0]!;
        console.log(`  第${i + 1}轮 玩家「${t.player.slice(0, 16)}」→ 最强 ${top.cn}${top.v}　跳变 ${i ? r.jumps[i - 1]!.toFixed(0) : '—'}`);
        console.log(`         ${t.reply.slice(0, 70)}`);
      });
    }
    const g = (m: string) => out[m] as { avgJump: number; emos: Array<Record<string, number>> };
    const satOf = (m: string) => { const r = g(m); const s = r.emos.flatMap((e) => KEYS.map((k) => e[k] ?? 0)).filter((v) => v >= 85).length; return s / (r.emos.length * KEYS.length) * 100; };
    console.log(`\n  ⚖ ${name} 相邻轮跳变：独立 ${g('independent').avgJump.toFixed(0)}　惯性 ${g('inertia').avgJump.toFixed(0)}　惯性+衰减 ${g('decay').avgJump.toFixed(0)}`);
    console.log(`  ⚖ ${name} 高位饱和：独立 ${satOf('independent').toFixed(0)}%　惯性 ${satOf('inertia').toFixed(0)}%　惯性+衰减 ${satOf('decay').toFixed(0)}%`);
    (report as Record<string, unknown>)[name] = out;
  }
  fs.writeFileSync(path.resolve('data/emotion-inertia-result.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log('\n结果已写入 data/emotion-inertia-result.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
