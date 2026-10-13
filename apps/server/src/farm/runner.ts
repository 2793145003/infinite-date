/**
 * 共享菜园 · 离线 runner
 *
 * 用法：cd apps/server && npx tsx src/farm/runner.ts [seed]
 *
 * 不连线上库、不调 LLM：纯规则把整条循环跑一遍并打印出来——
 *   玩家种地 → 成熟 → 收成（留种）→ 去三个男主的院子偷 → 失窃台账 →
 *   按性格的反应事实文本 → 临时上下文注入 → 料理（真实二消引擎，贪心 12 步）→ 编菜 prompt 预览
 *
 * 想看模型的真实文案质量，用 scripts/ab-farm-cook.ts（发明细）和 verify_farm_llm.ts（可复跑）。
 */
import { CROPS, STARTING_SEEDS, cropName, exclusiveCropFor, type PersonaLite } from './crops';
import { HOUR, harvest, plant, progress, ripeAt, ripenLine, stageOf, water } from './growth';
import { ledger, steal, type TheftRecord } from './steal';
import { fallbackLine, shouldPostOnScheduleChange, stolenHint, temperamentOf } from './reaction';
import { makeGiftNote, makeRipeNote, makeStolenNote, noteInjection } from './context';
import { buildDishPrompt, cookBoard, dishBrief, formOf, KITCHEN_QUALITY_TIERS } from './kitchen';
import { makeRng } from './rng';

const seed = Number(process.argv[2] ?? 2026);
const rng = makeRng(seed);
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 25, 8, 0, 0); // 种下的那一刻（UTC 8:00）

const line = '─'.repeat(64);
const h = (t: string) => console.log(`\n${line}\n${t}\n${line}`);

h(`共享菜园 · 离线跑一遍（seed ${seed}）`);

// ── 1. 玩家自己的院子 ────────────────────────────────
console.log('\n【1】玩家院子：种下三块地');
const myPlots = [
  { plot: plant('scallion', T0), label: '小葱（2h）' },
  { plot: plant('tomato', T0), label: '番茄（4h）' },
  { plot: water(plant('cloudrice', T0), T0), label: '云顶米（12h，浇过水 → 快 10%）' },
];
for (const m of myPlots) {
  console.log(`   ${m.label}：${ripenLine(m.plot, T0)}`);
}
for (const at of [1, 2, 3, 5]) {
  const now = T0 + at * HOUR;
  console.log(`   ${at}h 后：${myPlots.map((m) => `${cropName(m.plot.cropKey)}=${stageOf(m.plot, now)}(${Math.round(progress(m.plot, now) * 100)}%)`).join('  ')}`);
}
console.log('   （成熟后不理它：不枯死、不扣产——地里会一直等你）');

// ── 2. 收成 ─────────────────────────────────────────
h('【2】收成（留种 30%）');
const bag: Record<string, number> = {};
const seeds: Record<string, number> = {};
for (const m of myPlots) {
  const now = T0 + 12 * HOUR;
  const r = harvest(m.plot, now, rng);
  if (r.crops > 0) {
    bag[r.crop.name] = (bag[r.crop.name] ?? 0) + r.crops;
    if (r.seeds > 0) seeds[r.crop.name] = (seeds[r.crop.name] ?? 0) + r.seeds;
    console.log(`   收 ${r.crop.name} ×${r.crops}${r.seeds ? `（留种 ×${r.seeds}）` : ''}`);
  }
  console.log(`   ${r.crop.name} 的成熟时刻：+${Math.round((ripeAt(m.plot) - T0) / HOUR)}h`);
}
console.log(`   背包：${JSON.stringify(bag)}  种子：${JSON.stringify(seeds)}`);

// ── 3. 三个男主的院子（示例人设） + 偷菜 ──────────────
h('【3】男主的院子：专属作物 + 偷一次（只玩家偷男主，没人偷玩家）');
const personas: Array<{ name: string; data: PersonaLite & { atHome: boolean } }> = [
  { name: '示例·光系', data: { name: '示例·光系', skills: 'evol 是光元素掌控', drive: '守在你身侧', atHome: false } },
  { name: '示例·雪系', data: { name: '示例·雪系', personality: { core: '冷静克制，与人保持距离' }, drive: '雪夜里的等候', atHome: true } },
  { name: '示例·棋系', data: { name: '示例·棋系', personality: { core: '不动声色地布局' }, drive: '在博弈里找秩序', atHome: false } },
];

const records: TheftRecord[] = [];
const notes = [];
for (const p of personas) {
  const crop = exclusiveCropFor(p.data);
  const temperament = temperamentOf(p.data);
  const ripeCount = crop.yield;
  const res = steal(crop.key, { ripeCount, atHome: p.data.atHome, stolenThisCycle: false, stolenTodayByPlayer: false }, rng);
  if (!res.ok) {
    console.log(`   ${p.name}（${temperament}）：专属作物「${crop.name}」 → ${res.blockedBy}`);
    continue;
  }
  records.push({ at: T0 + DAY, cropName: res.cropName, taken: res.taken });
  notes.push(makeStolenNote(res.cropName, res.taken, records.length, T0 + DAY));
  console.log(`   ${p.name}（${temperament}）：专属作物「${crop.name}」，摘走 ${res.taken} 个${res.seeds ? `，顺手一颗种子` : ''}`);
}

const book = ledger(records);
console.log(`\n   失窃台账：被偷 ${book.times} 次，共少 ${book.totalLost} 个 → ${JSON.stringify(book.byCrop)}`);
console.log('   （台账只有数字和作物名，没有任何"是谁"——所以他不可能是被剧情告诉的）');

h('【4】按性格的反应（事实里没有"玩家"）');
for (const p of personas) {
  const t = temperamentOf(p.data);
  const hint = stolenHint({ characterName: p.name, cropName: '星光果', lost: 2, before: 5, times: 2, temperament: t });
  console.log(`\n   ${p.name}（${t}）`);
  console.log(`   事实文本 → ${hint.slice(0, 96)}…`);
  console.log(`   兜底文案 → ${fallbackLine(t, '星光果')}`);
}
let posted = 0;
for (let i = 0; i < 20; i++) if (shouldPostOnScheduleChange(40, rng)) posted++;
console.log(`\n   行程概率：意愿 40 时，20 次行程变更里发了 ${posted} 次朋友圈（不是秒发，是他自己挑时候）`);

h('【5】临时上下文（成熟写进上下文，说不说看角色自己）');
notes.push(makeRipeNote('星光果', T0 + DAY + HOUR), makeGiftNote('星光果慕斯', T0 + DAY + 2 * HOUR));
console.log(noteInjection(notes));
console.log('   ⚠ 注入位置：拼进「当前这条 user 消息」，不能追加在 system 末尾（实测有效性差 8 倍）');

h('【6】料理：真实二消引擎一局（贪心，7×7 / 12 步）');
const cooked = cookBoard(rng);
const tally = cooked.tally;
console.log(`   消除统计：${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ')}`);
console.log(`   分数 ${cooked.board.score} → 形态「${formOf(tally)}」（品质阈值 ${KITCHEN_QUALITY_TIERS.map((t) => `${t.quality}≥${t.min}`).join(' / ')}）`);
const brief = dishBrief(tally, cooked.board.score, rng, []);
console.log(`\n   ── 将喂给模型的编菜 prompt ──\n${buildDishPrompt(brief)}`);
