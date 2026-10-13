/**
 * 心绪影响会话 —— 量化验证（只读库 + 真实模型 + embedding 量化）
 *
 * 实验C 情绪反应正确性：同一角色同一历史，只把玩家那句输入换成 5 种不同性质的话
 *   （甜蜜/冷淡/挑衅/告别/道歉），看模型给出的 8 维心绪方向是否合理、是否有区分度。
 *   → 回答「能不能正确输出情绪」（比日常样本更能压出负向维度）
 *
 * 实验D 注入影响力：同一历史同一输入，注入 3 种心绪 × 每种重复 3 次，
 *   用 embedding 量化「组间距离 vs 组内距离」。
 *   → 组间显著大于组内 = 注入真的改变了发言；否则注入是被角色卡盖过的噪声。
 *
 * 用法：cd apps/server && npx tsx verify_emotion_impact.ts [--chars=穆昭,苏烬]
 */
import path from 'node:path';
import fs from 'node:fs';
import { db } from './src/db';
import { config } from './src/config';
import { loadCharacterData } from './src/lib/character';
import {
  buildSystemPrompt,
  buildMessages,
  REPLY_SCHEMA,
  getHubLocationsText,
  getPlayerProfile,
  type PromptContext,
} from './src/prompt/builder';
import type { ChatMessage } from './src/llm/adapter';

const argv = process.argv.slice(2);
const argVal = (k: string, d: string) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WANT_CHARS = argVal('chars', '穆昭,苏烬').split(',').map((s) => s.trim());

const EMOTIONS = [
  { key: 'joy', cn: '愉悦' }, { key: 'desire', cn: '欲望' }, { key: 'panic', cn: '慌乱' },
  { key: 'loss', cn: '失落' }, { key: 'grievance', cn: '委屈' }, { key: 'anger', cn: '愤怒' },
  { key: 'possessiveness', cn: '占有欲' }, { key: 'tenderness', cn: '怜爱' },
] as const;

const EMOTION_OUTPUT_NOTE = [
  '【输出格式补充】除了上面要求的字段，你还要输出一个 emotions 字段，记录你「此刻的心绪」：',
  EMOTIONS.map((e) => `${e.key}=${e.cn}`).join('，'),
  '8 个维度各给一个 0-100 的整数（0=完全没有，100=极其强烈）。',
  '这是你此刻真实的心理状态，用于内部记录；不要把这些词、分数或「心绪」二字写进台词里。',
].join('\n');

const EMOTION_NESTED = {
  type: 'object',
  properties: Object.fromEntries(EMOTIONS.map((e) => [e.key, { type: 'integer' }])),
  required: EMOTIONS.map((e) => e.key),
  additionalProperties: false,
};
const SCHEMA_WITH_EMOTION = {
  type: 'object',
  properties: { ...REPLY_SCHEMA.properties, emotions: EMOTION_NESTED },
  required: [...REPLY_SCHEMA.required, 'emotions'],
};

/** 注入措辞（比第一轮更强硬，明确要求改变语气） */
function emotionNote(values: Record<string, number>): string {
  const entries = EMOTIONS.map((e) => ({ cn: e.cn, v: values[e.key] ?? 0 })).sort((a, b) => b.v - a.v);
  const top = entries.filter((e) => e.v > 0).slice(0, 2);
  return [
    '【此刻心绪 — 必须体现在这一句回话里】你此刻的心理状态（0=没有，100=极强）：' +
      entries.map((e) => `${e.cn}${e.v}`).join('、') + '。',
    top.length
      ? `其中「${top[0]!.cn}」最强（${top[0]!.v}）${top[1] ? `，「${top[1]!.cn}」次之（${top[1]!.v}）` : ''}。这就是你此刻真实的心情，它必须显著地改变你这句话的语气、用词和态度——${top[0]!.cn}到这种程度，你的措辞不可能还是平常的样子。`
      : '',
    '但不要直接说出这些词、分数或「心绪」二字，让它只体现在语气里。',
  ].filter(Boolean).join('\n');
}

async function callLLM(messages: ChatMessage[], schema: Record<string, unknown>, temperature = 0.85) {
  const t0 = Date.now();
  const res = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel, messages, temperature, max_tokens: 1024,
      repetition_penalty: 1.1, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`vLLM ${res.status}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    usage?: { completion_tokens?: number };
  };
  const raw = data.choices?.[0]?.message?.content ?? '';
  let obj: Record<string, unknown> | null = null;
  try { obj = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch { /* 未闭合 */ }
  const messages_ = Array.isArray(obj?.messages) ? (obj!.messages as unknown[]).map(String) : [];
  const emo = (obj?.emotions ?? {}) as Record<string, number>;
  return { text: messages_.join(' '), lines: messages_, emo, finish: data.choices?.[0]?.finish_reason, out: data.usage?.completion_tokens, ms: Date.now() - t0 };
}

async function embedMany(texts: string[]): Promise<number[][]> {
  const res = await fetch('http://127.0.0.1:8001/embed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  const j = (await res.json()) as { embeddings: number[][] };
  return j.embeddings;
}
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

function pickChar(name: string) {
  const threads = db
    .prepare(`SELECT t.id AS thread_id, t.character_id, t.player_id FROM message_threads t WHERE t.character_id != 'DEITY'`)
    .all() as Array<{ thread_id: string; character_id: string; player_id: string }>;
  for (const t of threads) {
    const cd = loadCharacterData(t.player_id, t.character_id);
    if (!cd || cd.name !== name) continue;
    const rows = db
      .prepare(`SELECT sender, body FROM text_messages WHERE thread_id = ? AND body != '' ORDER BY created_at DESC, rowid DESC LIMIT 30`)
      .all(t.thread_id) as Array<{ sender: string; body: string }>;
    if (rows.length < 6) continue;
    let anchor = -1;
    for (let i = 0; i < rows.length - 1; i++) if (rows[i]!.sender === 'player' && rows[i + 1]!.sender === 'npc') { anchor = i; break; }
    if (anchor < 0) continue;
    return {
      cd, playerId: t.player_id,
      history: rows.slice(anchor + 1, anchor + 9).reverse().map((r) => ({ role: (r.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant', text: r.body })),
      realInput: rows[anchor]!.body,
      reference: rows[anchor + 1]!.body,
    };
  }
  return null;
}

const PROBES = [
  { label: '甜蜜', text: '今天好想你呀，一直在等你消息' },
  { label: '冷淡', text: '哦。' },
  { label: '挑衅', text: '你这人怎么这么讨厌，说话又难听' },
  { label: '告别', text: '我们这样下去好像没什么意思，要不算了吧' },
  { label: '道歉', text: '对不起，刚才是我不对，不该那样说你' },
];

const INJECTIONS = [
  { label: '愤怒90', values: { joy: 5, desire: 10, panic: 10, loss: 40, grievance: 70, anger: 90, possessiveness: 60, tenderness: 0 } },
  { label: '怜爱90', values: { joy: 60, desire: 20, panic: 5, loss: 10, grievance: 0, anger: 0, possessiveness: 20, tenderness: 90 } },
  { label: '慌乱85', values: { joy: 20, desire: 30, panic: 85, loss: 20, grievance: 15, anger: 5, possessiveness: 25, tenderness: 20 } },
];

async function main() {
  const report: Record<string, unknown> = { model: config.llmModel, chars: [] };
  for (const name of WANT_CHARS) {
    const c = pickChar(name);
    if (!c) { console.log(`跳过 ${name}（没找到可用线程）`); continue; }
    console.log(`\n${'='.repeat(72)}\n角色 ${name}　真实上一轮：玩家「${c.realInput.slice(0, 30)}」→ NPC「${c.reference.slice(0, 40)}」`);

    const mk = (input: string, note?: string) => {
      const ctx: PromptContext = {
        characterData: c.cd, playerDescription: '（离线实验：关系描述省略）',
        playerProfile: getPlayerProfile(c.playerId), chronicleSummary: '',
        recentMessages: c.history, isTextMessage: true, isDeity: false,
        locationName: '（短信中无法确定位置）', hubLocations: getHubLocationsText(),
        retrievedMemories: null,
        situationalNote: note ? note + '\n\n' + EMOTION_OUTPUT_NOTE : EMOTION_OUTPUT_NOTE,
      };
      return buildMessages(buildSystemPrompt(ctx), ctx.recentMessages, input);
    };

    // ── 实验C：情绪反应正确性
    console.log('\n【实验C】同一历史，只换玩家那句话 → 看心绪方向');
    const probeRes: Record<string, unknown> = {};
    for (const p of PROBES) {
      const r = await callLLM(mk(p.text), SCHEMA_WITH_EMOTION);
      probeRes[p.label] = { input: p.text, emotion: r.emo, lines: r.lines };
      console.log(`  ${p.label.padEnd(3)}「${p.text.slice(0, 18)}」`);
      console.log(`     情绪 ${EMOTIONS.map((e) => `${e.cn}${r.emo[e.key] ?? '-'}`).join(' ')}`);
      console.log(`     回话 ${r.lines.join(' / ').slice(0, 78)}`);
    }

    // ── 实验D：注入影响力量化
    console.log('\n【实验D】同历史同输入，注入 3 种心绪 × 3 次重复 → 组间 vs 组内');
    const fixedInput = c.realInput;
    const groups: Record<string, string[]> = {};
    for (const inj of INJECTIONS) {
      groups[inj.label] = [];
      for (let k = 0; k < 3; k++) {
        const r = await callLLM(mk(fixedInput, emotionNote(inj.values)), SCHEMA_WITH_EMOTION);
        groups[inj.label]!.push(r.text || '（空）');
        console.log(`  [${inj.label} #${k + 1}] ${r.lines.join(' / ').slice(0, 72)}`);
      }
    }
    // 量化
    const labels = Object.keys(groups);
    const flat: string[] = [];
    const idx: Record<string, number[]> = {};
    for (const l of labels) { idx[l] = []; for (const t of groups[l]!) { idx[l]!.push(flat.length); flat.push(t); } }
    const vecs = await embedMany(flat);
    const within: number[] = [], between: number[] = [];
    for (const l of labels) {
      const ix = idx[l]!;
      for (let i = 0; i < ix.length; i++) for (let j = i + 1; j < ix.length; j++) within.push(cos(vecs[ix[i]!]!, vecs[ix[j]!]!));
    }
    for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) {
      for (const i of idx[labels[a]!]!) for (const j of idx[labels[b]!]!) between.push(cos(vecs[i]!, vecs[j]!));
    }
    const avg = (x: number[]) => x.reduce((s, v) => s + v, 0) / (x.length || 1);
    console.log(`\n  ⚖ 组内相似度 ${avg(within).toFixed(3)}（n=${within.length}）　组间相似度 ${avg(between).toFixed(3)}（n=${between.length}）`);
    console.log(`  → 组间${avg(between) < avg(within) ? '低于' : '高于'}组内，差 ${(avg(within) - avg(between)).toFixed(3)}　${avg(within) - avg(between) > 0.05 ? '✅ 注入有可测影响' : '⚠️ 注入影响微弱（被语气随机性淹没）'}`);

    (report.chars as unknown[]).push({ name, probes: probeRes, groups, within: avg(within), between: avg(between) });
  }
  fs.writeFileSync(path.resolve('data/emotion-impact-result.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log('\n结果已写入 data/emotion-impact-result.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
