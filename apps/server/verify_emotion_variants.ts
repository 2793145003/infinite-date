/**
 * 心绪 schema 变体快测 —— 定位「加了 emotions 后模型灌空白跑满 token」的根因
 *
 * 已确认现象：只在 schema 里加 emotions（嵌套 object，required），模型会写完原有字段后
 * 不输出 emotions，改用空白填满到 max_tokens（finish_reason=length，JSON 未闭合）。
 * 假设：约束了结构但没给语义——prompt 从未说明要评情绪。
 *
 * 变体（一次只动一个变量）：
 *   v1_schema_only   schema 加 emotions，prompt 不变            （已知失败）
 *   v2_schema_note   schema 加 emotions + prompt 输出说明        ← 主假设
 *   v3_flat_note     emotions 打平成 8 个顶层字段 + prompt 说明
 *   v4_flat_only     打平但不给 prompt 说明
 *   v5_note_only     prompt 说明 + 原 schema（看模型是否自发多输出，被 schema 截掉）
 *
 * 用法：cd apps/server && npx tsx verify_emotion_variants.ts --n=1 [--variants=v2_schema_note,v3_flat_note]
 */
import path from 'node:path';
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
const N = Number(argVal('n', '1'));

const EMOTIONS = [
  { key: 'joy', cn: '愉悦' },
  { key: 'desire', cn: '欲望' },
  { key: 'panic', cn: '慌乱' },
  { key: 'loss', cn: '失落' },
  { key: 'grievance', cn: '委屈' },
  { key: 'anger', cn: '愤怒' },
  { key: 'possessiveness', cn: '占有欲' },
  { key: 'tenderness', cn: '怜爱' },
] as const;

/** 输出说明（正式上线时应落进模板文件，实验先用 situationalNote 追加） */
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

const VARIANT_SCHEMAS: Record<string, Record<string, unknown>> = {
  v1_schema_only: {
    type: 'object',
    properties: { ...REPLY_SCHEMA.properties, emotions: EMOTION_NESTED },
    required: [...REPLY_SCHEMA.required, 'emotions'],
  },
  v2_schema_note: {
    type: 'object',
    properties: { ...REPLY_SCHEMA.properties, emotions: EMOTION_NESTED },
    required: [...REPLY_SCHEMA.required, 'emotions'],
  },
  v3_flat_note: {
    type: 'object',
    properties: {
      ...REPLY_SCHEMA.properties,
      ...Object.fromEntries(EMOTIONS.map((e) => [`emotion_${e.key}`, { type: 'integer' }])),
    },
    required: [...REPLY_SCHEMA.required, ...EMOTIONS.map((e) => `emotion_${e.key}`)],
  },
  v4_flat_only: {
    type: 'object',
    properties: {
      ...REPLY_SCHEMA.properties,
      ...Object.fromEntries(EMOTIONS.map((e) => [`emotion_${e.key}`, { type: 'integer' }])),
    },
    required: [...REPLY_SCHEMA.required, ...EMOTIONS.map((e) => `emotion_${e.key}`)],
  },
  v5_note_only: REPLY_SCHEMA,
  /** 生产候选：emotions 可选（不进 required）——给说明时应有输出，不给说明时应等同基线 */
  o1_optional_note: {
    type: 'object',
    properties: { ...REPLY_SCHEMA.properties, emotions: EMOTION_NESTED },
    required: [...REPLY_SCHEMA.required],
  },
  o2_optional_nonote: {
    type: 'object',
    properties: { ...REPLY_SCHEMA.properties, emotions: EMOTION_NESTED },
    required: [...REPLY_SCHEMA.required],
  },
  /** 生产候选：打平且可选 */
  o3_flat_optional_note: {
    type: 'object',
    properties: {
      ...REPLY_SCHEMA.properties,
      ...Object.fromEntries(EMOTIONS.map((e) => [`emotion_${e.key}`, { type: 'integer' }])),
    },
    required: [...REPLY_SCHEMA.required],
  },
  /** 备选：emotions 收成「一个字符串」，模型按 `key:值` 自填，解析侧兜底 */
  v6_string_note: {
    type: 'object',
    properties: { ...REPLY_SCHEMA.properties, emotions: { type: 'string' } },
    required: [...REPLY_SCHEMA.required, 'emotions'],
  },
};
const NOTE_VARIANTS = new Set(['v2_schema_note', 'v3_flat_note', 'v5_note_only', 'v6_string_note', 'o1_optional_note', 'o3_flat_optional_note']);

async function callLLM(messages: ChatMessage[], schema: Record<string, unknown>, maxTokens = 1024) {
  const t0 = Date.now();
  const res = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      temperature: 0.85,
      max_tokens: maxTokens,
      repetition_penalty: 1.1,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`vLLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    usage?: { completion_tokens?: number };
  };
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    finish: data.choices?.[0]?.finish_reason,
    out: data.usage?.completion_tokens,
    ms: Date.now() - t0,
  };
}

function pick(n: number) {
  const threads = db
    .prepare(
      `SELECT t.id AS thread_id, t.character_id, t.player_id,
              (SELECT count(*) FROM text_messages m WHERE m.thread_id = t.id AND m.body != '') AS n
       FROM message_threads t WHERE t.character_id != 'DEITY' ORDER BY n DESC LIMIT 60`,
    )
    .all() as Array<{ thread_id: string; character_id: string; player_id: string }>;
  const out: Array<{ characterId: string; playerId: string; name: string; history: PromptContext['recentMessages']; input: string; reference: string }> = [];
  for (const t of threads) {
    if (out.length >= n) break;
    const rows = db
      .prepare(`SELECT id, sender, body FROM text_messages WHERE thread_id = ? AND body != '' ORDER BY created_at DESC, rowid DESC LIMIT 30`)
      .all(t.thread_id) as Array<{ id: string; sender: string; body: string }>;
    if (rows.length < 6) continue;
    let anchor = -1;
    for (let i = 0; i < rows.length - 1; i++) if (rows[i]!.sender === 'player' && rows[i + 1]!.sender === 'npc') { anchor = i; break; }
    if (anchor < 0) continue;
    const cd = loadCharacterData(t.player_id, t.character_id);
    if (!cd) continue;
    out.push({
      characterId: t.character_id,
      playerId: t.player_id,
      name: cd.name || t.character_id,
      input: rows[anchor]!.body,
      reference: rows[anchor + 1]!.body,
      history: rows.slice(anchor + 1, anchor + 9).reverse().map((r) => ({ role: (r.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant', text: r.body })),
    });
  }
  return out;
}

function analyse(raw: string) {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let obj: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(cleaned);
    if (v && typeof v === 'object' && !Array.isArray(v)) obj = v as Record<string, unknown>;
  } catch { /* 未闭合 */ }
  const blankTail = /[\s]{200,}$/.test(raw);
  const emo = (obj?.emotions ?? null) as Record<string, unknown> | null;
  const hasEmoKey = !!obj && Object.prototype.hasOwnProperty.call(obj, 'emotions');
  const flat: Record<string, number> = {};
  for (const e of EMOTIONS) if (typeof obj?.[`emotion_${e.key}`] === 'number') flat[e.cn] = obj![`emotion_${e.key}`] as number;
  const lines = Array.isArray(obj?.messages) ? (obj!.messages as unknown[]).map(String) : [];
  return { parsed: !!obj, closed: raw.trimEnd().endsWith('}'), blankTail, lines, nested: emo, hasEmoKey, flat, rawLen: raw.length };
}

async function main() {
  const want = argVal('variants', 'v2_schema_note,v3_flat_note,v6_string_note');
  const variants = want === 'all' ? Object.keys(VARIANT_SCHEMAS) : want.split(',').map((s) => s.trim()).filter(Boolean);
  const samples = pick(N);
  console.log(`样本：${samples.map((s) => s.name).join('、')}　变体：${variants.join(', ')}\n`);
  for (const s of samples) {
    const cd = loadCharacterData(s.playerId, s.characterId)!;
    console.log(`──────── ${s.name}　玩家输入：${s.input.slice(0, 60)}`);
    console.log(`        真实回复：${s.reference.slice(0, 60)}`);
    for (const v of variants) {
      const schema = VARIANT_SCHEMAS[v];
      if (!schema) { console.log(`  ${v}: 未定义，跳过`); continue; }
      const note = NOTE_VARIANTS.has(v) ? EMOTION_OUTPUT_NOTE : undefined;
      const ctx: PromptContext = {
        characterData: cd,
        playerDescription: '（离线实验：关系描述省略）',
        playerProfile: getPlayerProfile(s.playerId),
        chronicleSummary: '',
        recentMessages: s.history,
        isTextMessage: true,
        isDeity: false,
        locationName: '（短信中无法确定位置）',
        hubLocations: getHubLocationsText(),
        retrievedMemories: null,
        ...(note ? { situationalNote: note } : {}),
      };
      const msgs = buildMessages(buildSystemPrompt(ctx), ctx.recentMessages, s.input);
      const r = await callLLM(msgs, schema);
      const a = analyse(r.content);
      console.log(`  [${v}] ${r.ms}ms finish=${r.finish} out=${r.out} 闭合=${a.closed} 空白尾=${a.blankTail} 台词${a.lines.length}条`);
      console.log(`        含 emotions 键：${a.hasEmoKey ? '是' : '否'}`);
      if (a.nested) console.log(`        嵌套情绪：${EMOTIONS.map((e) => `${e.cn}${a.nested![e.key] ?? '-'}`).join(' ')}`);
      if (Object.keys(a.flat).length) console.log(`        打平情绪：${Object.entries(a.flat).map(([k, v]) => `${k}${v}`).join(' ')}`);
      console.log(`        台词：${a.lines.join(' / ').slice(0, 120)}`);
      if (!a.closed) console.log(`        原始尾部：${JSON.stringify(r.content.slice(-120))}`);
    }
    console.log('');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
