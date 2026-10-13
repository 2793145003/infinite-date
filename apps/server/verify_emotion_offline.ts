/**
 * 心绪（emotion）离线实验 —— 只读线上库 + 真实模型 + 生产同源 prompt
 *
 * 目的（星落 2026-09-20 要求，先离线再谈上线）：
 *   阶段1 抽取可行性：REPLY_SCHEMA 加 8 维 emotions 后，
 *     ① 模型能否稳定输出（8 个 key 齐全、0-100、分辨率是否够）
 *     ② 是否伤台词（长度 / 截断 / JSON 碎片 / 复述）
 *     对照组：现行 REPLY_SCHEMA（不含 emotions）
 *   阶段2 影响会话：把情绪状态注入 system prompt 末尾（复用 situationalNote 挂点），
 *     同一段历史 + 同一句玩家输入，看注入不同心绪后 NPC 发言是否真的分化、方向是否对。
 *
 * 安全保证：
 *   - 全程只读业务表（SELECT），不写 text_messages/scene_messages 等任何业务数据；
 *   - 不走项目 llm/adapter（它会写 llm_call_log），直接 fetch vLLM，请求参数与 adapter 对齐
 *     （response_format.json_schema + repetition_penalty 1.1 + stream false）；
 *   - 结束时自检业务表行数未变，打印校验结论。
 *
 * 用法：cd apps/server && npx tsx verify_emotion_offline.ts --n=4 [--stage=1|2|all]
 */
import fs from 'node:fs';
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
  type ChatMessage,
} from './src/prompt/builder';

// ─── 参数 ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const argVal = (k: string, d: string) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const N_SAMPLES = Number(argVal('n', '4'));
const STAGE = argVal('stage', 'all');
const OUT_JSON = path.resolve('data/emotion-offline-result.json');

// ─── 8 维心绪定义 ────────────────────────────────────────────
/** 花瓣顺序（星落指定）：愉悦（最上）→ 欲望 慌乱 失落 委屈 愤怒 占有欲 怜爱 */
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
const EMOTION_KEYS = EMOTIONS.map((e) => e.key) as unknown as string[];
const CN_OF: Record<string, string> = Object.fromEntries(EMOTIONS.map((e) => [e.key, e.cn]));

/**
 * 情绪输出的语义说明 —— 实测结论：只加 schema 约束、不给这段说明，模型会写完原有字段后
 * 完全不输出 emotions，改用空白刷满 max_tokens（finish_reason=length、JSON 不闭合）。
 * 必须 schema + 说明同时给。上线时应落进模板文件。
 */
const EMOTION_OUTPUT_NOTE = [
  '【输出格式补充】除了上面要求的字段，你还要输出一个 emotions 字段，记录你「此刻的心绪」：',
  EMOTIONS.map((e) => `${e.key}=${e.cn}`).join('，'),
  '8 个维度各给一个 0-100 的整数（0=完全没有，100=极其强烈）。',
  '这是你此刻真实的心理状态，用于内部记录；不要把这些词、分数或「心绪」二字写进台词里。',
].join('\n');

/** 变体1：英文 key + 整数 0-100 */
const EMOTION_SCHEMA_EN = {
  type: 'object',
  properties: Object.fromEntries(
    EMOTIONS.map((e) => [e.key, { type: 'integer' }]),
  ),
  required: EMOTION_KEYS,
  additionalProperties: false,
};

/** 变体2：中文 key（星落界面就是中文维度名） */
const EMOTION_SCHEMA_CN = {
  type: 'object',
  properties: Object.fromEntries(
    EMOTIONS.map((e) => [e.cn, { type: 'integer' }]),
  ),
  required: EMOTIONS.map((e) => e.cn),
  additionalProperties: false,
};

function withEmotions(emotionSchema: Record<string, unknown>, required: string[]) {
  return {
    type: 'object',
    properties: {
      ...REPLY_SCHEMA.properties,
      emotions: emotionSchema,
    },
    required: [...REPLY_SCHEMA.required, ...required],
  };
}

// ─── 直连 vLLM（参数与 src/llm/adapter.ts 对齐） ──────────────
interface LlmOut {
  content: string;
  finishReason?: string;
  completionTokens?: number;
  promptTokens?: number;
  ms: number;
}

async function callLLM(
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<LlmOut> {
  const t0 = Date.now();
  const res = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      temperature: opts.temperature ?? 0.85,
      max_tokens: opts.maxTokens ?? 1024,
      repetition_penalty: 1.1,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`vLLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    finishReason: data.choices?.[0]?.finish_reason,
    completionTokens: data.usage?.completion_tokens,
    promptTokens: data.usage?.prompt_tokens,
    ms: Date.now() - t0,
  };
}

// ─── 从线上库抽真实样本（只读） ──────────────────────────────
interface Sample {
  threadId: string;
  characterId: string;
  characterName: string;
  playerId: string;
  history: { role: 'player' | 'assistant'; text: string }[];
  input: string;
  reference: string;
}

function pickSamples(n: number): Sample[] {
  const threads = db
    .prepare(
      `SELECT t.id AS thread_id, t.character_id, t.player_id,
              (SELECT count(*) FROM text_messages m WHERE m.thread_id = t.id AND m.body != '') AS n
       FROM message_threads t
       WHERE t.character_id != 'DEITY'
       ORDER BY n DESC LIMIT 60`,
    )
    .all() as Array<{ thread_id: string; character_id: string; player_id: string; n: number }>;

  const out: Sample[] = [];
  for (const t of threads) {
    if (out.length >= n) break;
    const rows = db
      .prepare(
        `SELECT id, sender, body FROM text_messages
         WHERE thread_id = ? AND body != '' AND (metadata IS NULL OR metadata NOT LIKE '%"pending":true%')
         ORDER BY created_at DESC, rowid DESC LIMIT 30`,
      )
      .all(t.thread_id) as Array<{ id: string; sender: string; body: string }>;
    if (rows.length < 6) continue;
    // rows 是倒序；找「最后一条其后跟着 npc 回复的玩家消息」
    let anchor = -1;
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i]!.sender === 'player' && rows[i + 1]!.sender === 'npc') {
        anchor = i;
        break;
      }
    }
    if (anchor < 0 || anchor + 1 >= rows.length) continue;
    const reference = rows[anchor + 1]!.body;
    const input = rows[anchor]!.body;
    const history = rows
      .slice(anchor + 1, anchor + 9)
      .reverse()
      .map((r) => ({ role: (r.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant', text: r.body }));
    const cRow = db
      .prepare('SELECT character_data FROM characters WHERE id = ?')
      .get(t.character_id) as { character_data: string } | undefined;
    let name = t.character_id;
    try {
      name = (JSON.parse(cRow?.character_data ?? '{}') as { name?: string }).name || name;
    } catch {
      /* 保持 id 兜底 */
    }
    out.push({
      threadId: t.thread_id,
      characterId: t.character_id,
      characterName: name ?? t.character_id,
      playerId: t.player_id,
      history,
      input,
      reference,
    });
  }
  return out;
}

function buildCtx(s: Sample, situationalNote?: string): PromptContext | null {
  const characterData = loadCharacterData(s.playerId, s.characterId);
  if (!characterData) return null;
  return {
    characterData,
    playerDescription: '（离线实验：关系描述省略）',
    playerProfile: getPlayerProfile(s.playerId),
    chronicleSummary: '',
    recentMessages: s.history,
    isTextMessage: true,
    isDeity: false,
    locationName: '（短信中无法确定位置）',
    hubLocations: getHubLocationsText(),
    retrievedMemories: null,
    ...(situationalNote ? { situationalNote } : {}),
  };
}

// ─── 解析与度量 ──────────────────────────────────────────────
function tryParse(s: string): Record<string, unknown> | null {
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const v = JSON.parse(cleaned);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface EmotionRead {
  ok: boolean;
  missing: string[];
  nonInt: string[];
  outOfRange: string[];
  values: Record<string, number>;
  maxKey?: string;
  maxVal?: number;
  spread?: number;
}

function readEmotions(obj: Record<string, unknown> | null, keys: string[]): EmotionRead {
  const res: EmotionRead = { ok: false, missing: [], nonInt: [], outOfRange: [], values: {} };
  const raw = obj?.emotions as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') {
    res.missing = keys.slice();
    return res;
  }
  const nums: number[] = [];
  for (const k of keys) {
    if (!(k in raw)) {
      res.missing.push(k);
      continue;
    }
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      res.nonInt.push(k);
      continue;
    }
    const iv = Math.round(v);
    if (iv < 0 || iv > 100) res.outOfRange.push(k);
    res.values[k] = iv;
    nums.push(iv);
  }
  if (nums.length) {
    res.maxVal = Math.max(...nums);
    res.spread = Math.max(...nums) - Math.min(...nums);
  }
  res.ok = res.missing.length === 0 && res.nonInt.length === 0 && res.outOfRange.length === 0;
  return res;
}

/** 台词质量粗测：条数、总字数、是否疑似 JSON 碎片 */
function linesOf(obj: Record<string, unknown> | null, raw: string): string[] {
  if (!obj) return [];
  const m = obj.messages;
  if (!Array.isArray(m)) return [];
  return m.map((x) => String(x ?? '')).filter((x) => x.trim());
}
/** 疑似 JSON 碎片（沿用生产 llm-reply-salvage 的判定思路） */
function looksLikeFragment(ls: string[]): boolean {
  return ls.some(
    (l) =>
      /^[\s\[\]{},"]*$/.test(l) ||
      /^(internal|internal_notable|player_description|messages|emotions)\b/.test(l.trim()) ||
      l.trim() === 'null' ||
      l.trim() === 'false',
  );
}

// ─── 注入文本 ────────────────────────────────────────────────
function emotionNote(values: Record<string, number>): string {
  const entries = EMOTIONS.map((e) => ({ cn: e.cn, v: values[e.key] ?? 0 })).sort((a, b) => b.v - a.v);
  const top = entries.filter((e) => e.v > 0).slice(0, 3);
  const desc = entries.map((e) => `${e.cn} ${e.v}`).join('、');
  return [
    '【此刻心绪】你现在的心理状态（0=没有，100=极强）：' + desc + '。',
    top.length
      ? `其中「${top[0]!.cn}」最强（${top[0]!.v}）。此刻你被这种心绪支配着——让它真实地改变你这一句回话的语气、用词、停顿、以及你主动推进还是退缩，${top[1] ? `其次是「${top[1]!.cn}」带来的${top[1]!.v >= 50 ? '明显' : '一丝'}影响。` : ''}`
      : '',
    '这些是你的真实心理感受，不是台词内容：绝不要在回复里说出这些词本身，也不要提到数字或"心绪"二字，只让它们渗透在你的语气里。',
  ]
    .filter(Boolean)
    .join('\n');
}

// ─── 主流程 ──────────────────────────────────────────────────
function countAll(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ['text_messages', 'scene_messages', 'message_threads', 'chronicles']) {
    try {
      out[t] = (db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number }).c;
    } catch {
      /* 表不存在则忽略 */
    }
  }
  return out;
}

async function main() {
  console.log('=== 心绪离线实验（只读库 + 真实模型）===');
  console.log(`模型 ${config.llmModel} @ ${config.llmBaseUrl}　样本数 ${N_SAMPLES}　阶段 ${STAGE}`);

  const before = countAll();
  const samples = pickSamples(N_SAMPLES);
  if (samples.length === 0) {
    console.error('没抽到可用样本');
    process.exit(1);
  }
  console.log(`抽到 ${samples.length} 个真实线程样本：${samples.map((s) => s.characterName).join('、')}`);

  const report: Record<string, unknown> = { model: config.llmModel, samples: [] as unknown[] };

  for (const s of samples) {
    if (!buildCtx(s)) {
      console.log(`- 跳过 ${s.characterName}（角色数据缺失）`);
      continue;
    }
    /** 同一份生产 prompt，仅按变体决定是否追加情绪输出说明（语义说明与 schema 必须成对给） */
    const msgsWith = (note?: string) => {
      const c = buildCtx(s, note)!;
      return buildMessages(buildSystemPrompt(c), c.recentMessages, s.input);
    };
    console.log(`\n──────── ${s.characterName} ────────`);
    console.log(`玩家输入：${s.input.slice(0, 80)}`);
    console.log(`真实回复：${s.reference.slice(0, 80)}`);

    const item: Record<string, unknown> = {
      character: s.characterName,
      characterId: s.characterId,
      threadId: s.threadId,
      input: s.input,
      reference: s.reference,
      runs: {},
    };

    // ── 对照组：现行 schema（无 emotions）
    if (STAGE === '1' || STAGE === 'all') {
      const base = await callLLM(msgsWith(), REPLY_SCHEMA);
      const bObj = tryParse(base.content);
      const bLines = linesOf(bObj, base.content);
      item.runs = {
        ...(item.runs as object),
        baseline: {
          ms: base.ms,
          finish: base.finishReason,
          outTokens: base.completionTokens,
          lines: bLines,
          parse_ok: !!bObj,
          fragment: looksLikeFragment(bLines),
          raw: base.content,
        },
      };
      console.log(`[对照] ${base.ms}ms finish=${base.finishReason} out=${base.completionTokens} 台词${bLines.length}条/${bLines.join('').length}字`);
      console.log(`      ${bLines.join(' / ').slice(0, 140)}`);

      // ── 变体A：英文 key emotions
      const a = await callLLM(msgsWith(EMOTION_OUTPUT_NOTE), withEmotions(EMOTION_SCHEMA_EN, ['emotions']));
      const aObj = tryParse(a.content);
      const aLines = linesOf(aObj, a.content);
      const aEmo = readEmotions(aObj, EMOTION_KEYS);
      (item.runs as Record<string, unknown>).emotion_en = {
        ms: a.ms,
        finish: a.finishReason,
        outTokens: a.completionTokens,
        lines: aLines,
        parse_ok: !!aObj,
        fragment: looksLikeFragment(aLines),
        emotions: aEmo,
        raw: a.content,
      };
      console.log(`[英键] ${a.ms}ms finish=${a.finishReason} out=${a.completionTokens} 台词${aLines.length}条/${aLines.join('').length}字`);
      console.log(`      情绪 ${aEmo.ok ? 'OK' : '异常 ' + JSON.stringify({ miss: aEmo.missing, nonInt: aEmo.nonInt, oob: aEmo.outOfRange })}`);
      console.log(`      ${EMOTION_KEYS.map((k) => `${CN_OF[k]}${aEmo.values[k] ?? '-'}`).join(' ')}　极差 ${aEmo.spread ?? '-'}`);
      console.log(`      ${aLines.join(' / ').slice(0, 140)}`);

      // ── 变体B：中文 key emotions
      const b = await callLLM(msgsWith(EMOTION_OUTPUT_NOTE), withEmotions(EMOTION_SCHEMA_CN, ['emotions']));
      const bObj2 = tryParse(b.content);
      const bLines2 = linesOf(bObj2, b.content);
      const bEmo = readEmotions(bObj2, EMOTIONS.map((e) => e.cn));
      (item.runs as Record<string, unknown>).emotion_cn = {
        ms: b.ms,
        finish: b.finishReason,
        outTokens: b.completionTokens,
        lines: bLines2,
        parse_ok: !!bObj2,
        fragment: looksLikeFragment(bLines2),
        emotions: bEmo,
        raw: b.content,
      };
      console.log(`[中键] ${b.ms}ms finish=${b.finishReason} out=${b.completionTokens} 台词${bLines2.length}条/${bLines2.join('').length}字`);
      console.log(`      情绪 ${bEmo.ok ? 'OK' : '异常 ' + JSON.stringify({ miss: bEmo.missing, nonInt: bEmo.nonInt, oob: bEmo.outOfRange })}`);
      console.log(`      极差 ${bEmo.spread ?? '-'}`);
      console.log(`      ${bLines2.join(' / ').slice(0, 140)}`);
    }

    // ── 阶段2：情绪注入对比（同历史同输入，注入 3 种极端心绪）
    if (STAGE === '2' || STAGE === 'all') {
      const scenarios: Array<{ label: string; values: Record<string, number> }> = [
        { label: '愤怒90', values: { joy: 5, desire: 10, panic: 10, loss: 40, grievance: 70, anger: 90, possessiveness: 60, tenderness: 0 } },
        { label: '怜爱90', values: { joy: 60, desire: 20, panic: 5, loss: 10, grievance: 0, anger: 0, possessiveness: 20, tenderness: 90 } },
        { label: '慌乱85', values: { joy: 20, desire: 30, panic: 85, loss: 20, grievance: 15, anger: 5, possessiveness: 25, tenderness: 20 } },
      ];
      const inject: Record<string, unknown> = {};
      for (const sc of scenarios) {
        const imsgs = msgsWith(emotionNote(sc.values) + '\n\n' + EMOTION_OUTPUT_NOTE);
        const r = await callLLM(imsgs, withEmotions(EMOTION_SCHEMA_EN, ['emotions']));
        const o = tryParse(r.content);
        const ls = linesOf(o, r.content);
        const emo = readEmotions(o, EMOTION_KEYS);
        inject[sc.label] = { injected: sc.values, ms: r.ms, finish: r.finishReason, lines: ls, emotions: emo.values, raw: r.content };
        console.log(`[注入${sc.label}] ${r.ms}ms finish=${r.finishReason}`);
        console.log(`      ${ls.join(' / ').slice(0, 160)}`);
      }
      (item.runs as Record<string, unknown>).injection = inject;
    }

    (report.samples as unknown[]).push(item);
  }

  const after = countAll();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  report.readonly_check = { before, after, changed };
  console.log('\n=== 只读自检 ===');
  console.log(changed.length === 0 ? `业务表行数未变 ✓　${JSON.stringify(after)}` : `⚠ 行数变化：${changed.join(',')}`);

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n完整结果已写入 ${OUT_JSON}`);
}

main().catch((e) => {
  console.error('实验失败：', e);
  process.exit(1);
});
