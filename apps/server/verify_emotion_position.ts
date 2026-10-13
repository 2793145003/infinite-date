/**
 * 心绪注入位置对比 —— 为什么「system 末尾追加」影响不到发言？
 *
 * 已确认：system prompt 末尾追加情绪文本（situationalNote），组间/组内相似度差仅 0.005~0.012，
 * 强人设角色（甜妹）即使注入「愤怒90」仍照原样撒娇 —— 注入被角色卡盖过。
 *
 * 本实验对同一历史、同一输入，比较四种注入位置的效力：
 *   i0_none  无注入（对照，测采样噪声基线）
 *   i1_tail  追加在 system prompt 末尾（现行 situationalNote 位置）
 *   i2_head  放在 system prompt 最前面（人设之前）
 *   i3_user  拼进当前 user 消息（模型对 user 指令遵循度通常最高）
 *
 * 判据：组间相似度（不同情绪的回复之间）应显著低于组内相似度（同情绪重复之间）；
 *       差 > 0.05 视为该位置有效。同时统计情绪词命中，佐证语气是否真的变了。
 *
 * 用法：cd apps/server && npx tsx verify_emotion_position.ts --char=苏烬 [--reps=3]
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
const CHAR = argVal('char', '苏烬');
const REPS = Number(argVal('reps', '3'));

const EMOTIONS = [
  { key: 'joy', cn: '愉悦' }, { key: 'desire', cn: '欲望' }, { key: 'panic', cn: '慌乱' },
  { key: 'loss', cn: '失落' }, { key: 'grievance', cn: '委屈' }, { key: 'anger', cn: '愤怒' },
  { key: 'possessiveness', cn: '占有欲' }, { key: 'tenderness', cn: '怜爱' },
] as const;

const EMOTION_OUTPUT_NOTE = [
  '【输出格式补充】除了上面要求的字段，你还要输出一个 emotions 字段，记录你「此刻的心绪」：',
  EMOTIONS.map((e) => `${e.key}=${e.cn}`).join('，'),
  '8 个维度各给一个 0-100 的整数（0=完全没有，100=极其强烈）。',
  '不要把这些词、分数或「心绪」二字写进台词里。',
].join('\n');

const SCHEMA_WITH_EMOTION = {
  type: 'object',
  properties: {
    ...REPLY_SCHEMA.properties,
    emotions: {
      type: 'object',
      properties: Object.fromEntries(EMOTIONS.map((e) => [e.key, { type: 'integer' }])),
      required: EMOTIONS.map((e) => e.key),
      additionalProperties: false,
    },
  },
  required: [...REPLY_SCHEMA.required, 'emotions'],
};

/** 刻意写得强硬、具体，避免模型把它当背景设定读过去 */
function note(label: string, values: Record<string, number>): string {
  const top = EMOTIONS.map((e) => ({ cn: e.cn, v: values[e.key] ?? 0 })).sort((a, b) => b.v - a.v)[0]!;
  return [
    `【你此刻的心绪：${top.cn} ${top.v}/100】这是硬性要求，优先于人设里平时的语气。`,
    `你现在被「${top.cn}」完全占据。${top.cn}到这个程度，你说话的语气、用词、长短、以及愿不愿意顺着对方，都必须明显改变——不允许还是平时那副样子。`,
    '如果你平时对玩家很温柔，此刻也要压不住地透出这种心绪；如果你平时话少，此刻也可能反常地多说两句。',
    '不要写出这些词本身或分数，只让语气变。',
  ].join('\n');
}

const CONDITIONS = [
  { label: '愤怒95', values: { joy: 0, desire: 5, panic: 10, loss: 30, grievance: 75, anger: 95, possessiveness: 55, tenderness: 0 } },
  { label: '怜爱95', values: { joy: 70, desire: 15, panic: 0, loss: 0, grievance: 0, anger: 0, possessiveness: 15, tenderness: 95 } },
];

const POSITIONS = ['i0_none', 'i1_tail', 'i2_head', 'i3_user'] as const;

async function callLLM(messages: ChatMessage[]) {
  const res = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel, messages, temperature: 0.85, max_tokens: 1024,
      repetition_penalty: 1.1, stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: SCHEMA_WITH_EMOTION } },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const raw = data.choices?.[0]?.message?.content ?? '';
  let obj: Record<string, unknown> | null = null;
  try { obj = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch { /* 未闭合 */ }
  const lines = Array.isArray(obj?.messages) ? (obj!.messages as unknown[]).map(String) : [];
  return { text: lines.join(' '), lines };
}

async function embedMany(texts: string[]): Promise<number[][]> {
  const res = await fetch('http://127.0.0.1:8001/embed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts }),
  });
  return ((await res.json()) as { embeddings: number[][] }).embeddings;
}
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
const avg = (x: number[]) => x.reduce((s, v) => s + v, 0) / (x.length || 1);

/** 情绪词命中：看语气是否真的变了（愤怒/疏远 vs 温柔/亲昵） */
const ANGRY_WORDS = ['别', '不是', '凭什么', '过分', '讨厌', '生气', '哼', '算了', '少', '烦', '？', '！'];
const SOFT_WORDS = ['呀', '呢', '嘛', '啦', '哦', '～', '亲亲', '抱', '喜欢', '乖乖', '嘿嘿', '✨', '🥰'];

function pickChar(name: string) {
  const threads = db.prepare(`SELECT t.id AS thread_id, t.character_id, t.player_id FROM message_threads t WHERE t.character_id != 'DEITY'`).all() as Array<{ thread_id: string; character_id: string; player_id: string }>;
  for (const t of threads) {
    const cd = loadCharacterData(t.player_id, t.character_id);
    if (!cd || cd.name !== name) continue;
    const rows = db.prepare(`SELECT sender, body FROM text_messages WHERE thread_id = ? AND body != '' ORDER BY created_at DESC, rowid DESC LIMIT 30`).all(t.thread_id) as Array<{ sender: string; body: string }>;
    if (rows.length < 6) continue;
    let anchor = -1;
    for (let i = 0; i < rows.length - 1; i++) if (rows[i]!.sender === 'player' && rows[i + 1]!.sender === 'npc') { anchor = i; break; }
    if (anchor < 0) continue;
    return {
      cd, playerId: t.player_id,
      history: rows.slice(anchor + 1, anchor + 9).reverse().map((r) => ({ role: (r.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant', text: r.body })),
      input: rows[anchor]!.body,
      reference: rows[anchor + 1]!.body,
    };
  }
  return null;
}

async function main() {
  const c = pickChar(CHAR);
  if (!c) { console.error(`没找到角色 ${CHAR}`); process.exit(1); }
  console.log(`角色 ${CHAR}　玩家输入「${c.input.slice(0, 40)}」　真实回复「${c.reference.slice(0, 50)}」`);
  console.log(`注入位置对比　每格 ${REPS} 次重复\n`);

  const mkBase = (): PromptContext => ({
    characterData: c.cd, playerDescription: '（离线实验）',
    playerProfile: getPlayerProfile(c.playerId), chronicleSummary: '',
    recentMessages: c.history, isTextMessage: true, isDeity: false,
    locationName: '（短信中无法确定位置）', hubLocations: getHubLocationsText(), retrievedMemories: null,
  });

  const build = (pos: string, cond: typeof CONDITIONS[number] | null): ChatMessage[] => {
    const ctx = mkBase();
    const emoNote = cond ? note(cond.label, cond.values) : null;
    ctx.situationalNote = EMOTION_OUTPUT_NOTE; // 输出说明始终需要（要拿到 emotions 字段）
    let system = buildSystemPrompt(ctx);
    if (pos === 'i1_tail' && emoNote) system = system + '\n\n' + emoNote;
    if (pos === 'i2_head' && emoNote) system = emoNote + '\n\n' + system;
    const msgs = buildMessages(system, ctx.recentMessages, c.input);
    if (pos === 'i3_user' && emoNote) msgs[msgs.length - 1] = { ...msgs[msgs.length - 1]!, content: `（${emoNote}）\n${c.input}` };
    return msgs;
  };

  const groups: Record<string, string[]> = {};
  for (const pos of POSITIONS) {
    const conds = pos === 'i0_none' ? [null] : CONDITIONS;
    for (const cond of conds) {
      const key = pos === 'i0_none' ? 'i0_none' : `${pos}|${cond!.label}`;
      groups[key] = [];
      for (let k = 0; k < REPS; k++) {
        const r = await callLLM(build(pos, cond));
        groups[key]!.push(r.text || '（空）');
        console.log(`  [${key} #${k + 1}] ${r.lines.join(' / ').slice(0, 76)}`);
      }
    }
    console.log('');
  }

  // 量化：对每个「注入位置」，比较其两个情绪组之间的组间距离 vs 各组内距离
  console.log('=== 量化（同一位置内：愤怒组 vs 怜爱组）===');
  const summary: Record<string, unknown> = {};
  for (const pos of POSITIONS) {
    if (pos === 'i0_none') continue;
    const keys = [`${pos}|愤怒95`, `${pos}|怜爱95`];
    const flat = [...groups[keys[0]!]!, ...groups[keys[1]!]!];
    const vecs = await embedMany(flat);
    const within: number[] = [], between: number[] = [];
    for (let gi = 0; gi < 2; gi++) for (let i = 0; i < REPS; i++) for (let j = i + 1; j < REPS; j++) within.push(cos(vecs[gi * REPS + i]!, vecs[gi * REPS + j]!));
    for (let i = 0; i < REPS; i++) for (let j = 0; j < REPS; j++) between.push(cos(vecs[i]!, vecs[REPS + j]!));
    const w = avg(within), b = avg(between), gap = w - b;
    summary[pos] = { within: w, between: b, gap };
    console.log(`  ${pos.padEnd(9)} 组内 ${w.toFixed(3)}　组间 ${b.toFixed(3)}　差 ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}　${gap > 0.05 ? '✅ 有效' : gap > 0.02 ? '🟡 微弱' : '❌ 无效'}`);
  }

  // 情绪词命中（语气是否真的变了）
  console.log('\n=== 语气词命中（愤怒词 / 柔和词）===');
  for (const [key, texts] of Object.entries(groups)) {
    const a = texts.filter((t) => ANGRY_WORDS.some((w) => t.includes(w))).length;
    const s = texts.filter((t) => SOFT_WORDS.some((w) => t.includes(w))).length;
    console.log(`  ${key.padEnd(14)} 愤怒词 ${a}/${texts.length}　柔和词 ${s}/${texts.length}`);
  }

  fs.writeFileSync(path.resolve('data/emotion-position-result.json'), JSON.stringify({ char: CHAR, groups, summary }, null, 2), 'utf-8');
  console.log('\n结果已写入 data/emotion-position-result.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
