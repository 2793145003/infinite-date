/**
 * 共享菜园 · 内容质量离线验证（第二轮）—— 可复跑
 *
 * 用法：cd apps/server && npx tsx verify_farm_llm.ts [每情形采样数，默认 3]
 *
 * 验什么（第一轮实测发现四个问题，这里逐条验"对策管不管用"）：
 *  1. 菜名模板塌缩 → 现在程序侧喂了形态约束 + 随机意象词 + 禁词/禁重名，看还塌不塌
 *  2. 形态单一（全是饭）→ 看菜名是否落在"加成块决定的形态"里
 *  3. 下品没有翻车感 → 看下品是否还吹得容光焕发（人工抽查 + 词表）
 *  4. 男主回应起手句重复 → A/B：不给起手禁令 vs 给了禁令，比重复率
 *
 * 只读线上库拿真实男主的人设；不写任何表、不调生产接口。
 * 原始结果落 apps/server/scripts/ab-farm-cook-out/verify-<ts>.json（该目录按仓库惯例不进库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeRng } from './src/farm/rng';
import { KITCHEN_TILES, buildDishPrompt, cookBoard, dishBrief, formOf, FORM_NOUNS, bannedNameWords } from './src/farm/kitchen';
import { DISH_SCHEMA } from './src/farm/kitchen';
import { FORBIDDEN_WORDS, fallbackLine, hasForbidden, stolenHint, temperamentOf, type Temperament } from './src/farm/reaction';
import type { PersonaLite } from './src/farm/crops';

const LLM_BASE = process.env.LLM_BASE_URL || 'http://127.0.0.1:8000/v1';
const MODEL = process.env.LLM_MODEL || 'gemma-4-26b';
const N = Number(process.argv[2] || 3);

interface Call {
  ok: boolean;
  parsed: Record<string, unknown> | null;
  raw: string;
  finish: string;
  ms: number;
}

async function chat(system: string, user: string, schema: unknown, temperature = 0.95): Promise<Call> {
  const t0 = Date.now();
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature,
      max_tokens: 800,
      repetition_penalty: 1.1,
      stream: false,
      response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, parsed: null, raw: `${res.status}`, finish: 'http_error', ms };
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  const raw = data.choices?.[0]?.message?.content ?? '';
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { parsed = null; }
  return { ok: !!parsed, parsed, raw, finish: data.choices?.[0]?.finish_reason ?? '?', ms };
}

/** 只读线上库：拿真实男主（character_data） */
function loadPersonas(): Array<{ name: string; data: PersonaLite }> {
  const db = new DatabaseSync(path.join(process.cwd(), 'data/infinite-date.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT character_data FROM character_player_data').all() as Array<{ character_data: string }>;
    const out: Array<{ name: string; data: PersonaLite }> = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const j = JSON.parse(r.character_data) as Record<string, unknown>;
      const name = typeof j.name === 'string' ? j.name : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, data: j as PersonaLite });
    }
    return out;
  } finally {
    db.close();
  }
}

function personaText(p: { name: string; data: PersonaLite }): string {
  const d = p.data as Record<string, unknown>;
  const s = (k: string) => {
    const v = d[k];
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  };
  return [`姓名：${p.name}`, `性格：${s('personality')}`, `说话风格：${s('speechStyle')}`, `喜欢：${s('likes')}`, `不喜欢：${s('dislikes')}`, `不擅长：${s('ineptitudes')}`, `内驱力：${s('drive')}`].join('\n');
}

const out: Record<string, unknown> = { model: MODEL, dishes: [], reactionsA: [], reactionsB: [] };

// ── A. 编菜：五局真实盘面，各采样 N 次（吃四招对策） ──
console.log('=== A. 编菜（真实二消盘面 + 形态/意象词/禁词约束）===');
const recentNames: string[] = [];
const rows: Array<Record<string, unknown>> = [];
for (const seed of [11, 42, 77, 123, 2026]) {
  const rng = makeRng(seed);
  const cooked = cookBoard(rng);
  const form = formOf(cooked.tally);
  for (let i = 0; i < N; i++) {
    // 每次采样都带上「已经用过的菜名」——同一盘面连做三次才不会撞名
    const brief = dishBrief(cooked.tally, cooked.board.score, rng, recentNames);
    const prompt = buildDishPrompt(brief);
    const r = await chat('你在为一个恋爱养成游戏写「料理生成」。只按要求的 JSON 输出，不要解释。', prompt, DISH_SCHEMA);
    const p = r.parsed as { dish?: string; ingredients?: string[]; desc?: string; taste?: string; reason?: string } | null;
    const dish = (p?.dish ?? '').trim();
    if (dish) recentNames.push(dish);
    const formHit = FORM_NOUNS[form].some((w) => dish.includes(w));
    const imageryHit = brief.imagery.some((w) => dish.includes(w));
    const bannedWords = bannedNameWords(cooked.tally);
    const hitBanned = [...bannedWords, ...FORBIDDEN_WORDS].filter((w) => dish.includes(w));
    const latin = /[a-zA-Z]{2,}/.test(dish);
    rows.push({ seed, score: cooked.board.score, quality: brief.quality, form, imagery: brief.imagery, dish, formHit, imageryHit, hitBanned, latin, ingredients: p?.ingredients ?? [], ok: r.ok, finish: r.finish });
    console.log(`  [${brief.quality}/${form}] ${dish.padEnd(14, '　')} 形态${formHit ? '✓' : '✗'} 意象${imageryHit ? '✓' : '✗'}${hitBanned.length ? ` 禁词:${hitBanned.join(',')}` : ''}${latin ? ' 含英文' : ''} ← ${(p?.ingredients ?? []).join('/')}`);
  }
}
out.dishes = rows;

const n = rows.length;
const okRows = rows.filter((r) => r.ok);
const sum = (f: (r: Record<string, unknown>) => boolean) => rows.filter(f).length;
const dishNames = rows.map((r) => String(r.dish)).filter(Boolean);
const riceDishes = dishNames.filter((d) => /饭|粥|盖/.test(d)).length;
const riceMentions = dishNames.filter((d) => d.includes('云顶米')).length;
const forms = [...new Set(rows.map((r) => String(r.form)))];
console.log(`\n  汇总：JSON ${okRows.length}/${n}｜形态命中 ${sum((r) => r.formHit === true)}/${n}｜意象词命中 ${sum((r) => r.imageryHit === true)}/${n}`);
console.log(`  禁词命中 ${sum((r) => (r.hitBanned as string[]).length > 0)}/${n}｜含英文 ${sum((r) => r.latin === true)}/${n}｜菜名唯一 ${new Set(dishNames).size}/${dishNames.length}`);
console.log(`  菜名里带饭/粥/盖的：${riceDishes}/${dishNames.length}（第一轮是 14/15 全是饭）；仅仅是提到作物名「云顶米」的：${riceMentions}｜本批出现过的形态：${forms.join('、')}`);
console.log(`  菜名样本：${dishNames.slice(0, 10).join(' / ')}`);

// ── B. 男主回应：起手句禁令 A/B ──
const personas = loadPersonas();
const picks = ['沈星回', '冷惊尘', '方知衡'].map((nm) => personas.find((p) => p.name === nm)).filter(Boolean) as Array<{ name: string; data: PersonaLite }>;
console.log(`\n=== B. 被偷之后的朋友圈文案（真实人设：${picks.map((p) => p.name).join('、')}）===`);

const FACT = { cropName: '番茄', lost: 2, before: 5, times: 2 };
for (const variant of ['A', 'B'] as const) {
  const openings: string[] = [];
  const rowsB: Array<Record<string, unknown>> = [];
  for (const p of picks) {
    const t: Temperament = temperamentOf(p.data);
    for (let i = 0; i < N; i++) {
      const hint = stolenHint({ characterName: p.name, cropName: FACT.cropName, lost: FACT.lost, before: FACT.before, times: FACT.times, temperament: t });
      const ban = variant === 'B' && openings.length ? `\n不要用这些起手（你已经用过）：${openings.join(' / ')}。` : '';
      const user = `${personaText(p)}\n\n${hint}${ban}\n\n输出 JSON：text（朋友圈正文）。`;
      const r = await chat('你要以给定角色的身份说话，保持人设。只输出 JSON。', user, { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false });
      const text = String((r.parsed as { text?: string } | null)?.text ?? '').trim();
      const opening = text.slice(0, 5);
      const dupOpening = openings.includes(opening);
      openings.push(opening);
      const accuse = /你(偷|拿|摘|是不是)/.test(text);
      const forbidden = FORBIDDEN_WORDS.filter((w) => text.includes(w));
      rowsB.push({ variant, name: p.name, temperament: t, text, opening, dupOpening, accuse, forbidden, ok: r.ok });
      console.log(`  [${variant}|${p.name}/${t}] ${text}${dupOpening ? ' ⚠起手重复' : ''}${accuse ? ' ⚠疑似点名玩家' : ''}${forbidden.length ? ` ⚠禁词:${forbidden.join(',')}` : ''}`);
    }
  }
  out[variant === 'A' ? 'reactionsA' : 'reactionsB'] = rowsB;
  const dup = rowsB.filter((r) => r.dupOpening).length;
  console.log(`  → ${variant === 'B' ? '带起手禁令' : '无禁令'}：起手重复 ${dup}/${rowsB.length}、疑似点名玩家 ${rowsB.filter((r) => r.accuse).length}、禁词 ${rowsB.filter((r) => (r.forbidden as string[]).length > 0).length}`);
}

console.log(`\n  兜底文案（模型挂了也不出戏）：${picks.map((p) => fallbackLine(temperamentOf(p.data), FACT.cropName)).join(' ｜ ')}`);
console.log(`  事实文本样例（不含"玩家"）：${stolenHint({ characterName: picks[0]?.name ?? 'X', cropName: '番茄', lost: 2, before: 5, times: 2, temperament: '多疑型' }).slice(0, 60)}…`);
console.log(`  禁词表：${FORBIDDEN_WORDS.join('、')}｜有禁词即判失败：${rows.filter((r) => (r.hitBanned as string[]).length > 0).length > 0}`);
console.log(`  盘面块（schema 钉死）：${KITCHEN_TILES.join('、')}`);

const dir = path.join(process.cwd(), 'scripts/ab-farm-cook-out');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `verify-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\n原始结果 → ${file}`);
