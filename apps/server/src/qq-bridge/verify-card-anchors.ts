/**
 * 角色卡「时段锚点」校验 —— 保证示例里的时段词只剩当前时间这一个来源。
 *
 * 背景：speechStyle.examples 里的 context 若写死「深夜」，小模型会连**语域和意象**
 * 一起搬走（实测：方知衡卡里那条「深夜突然想念你时 → 刚刚抬头看到星空」，
 * 直接导致大白天写出「看到窗外的月亮」）。所以场景字段里不留时段，只让
 * 【当前场景】的当前时间做唯一时间信号。
 *
 * 保留不动的两类（人工判定，非锚点）：
 *   - backstory_milestones[].time_description：历史事件的时间，本来就该有
 *   - quirks / drive 里的作息描述：人设特质，不是消息场景
 *
 * 跑法：npx tsx src/qq-bridge/verify-card-anchors.ts
 */

import '../config';
import { db } from '../db';
import { loadCharacterData } from '../lib/character';

const TIME_WORDS = /(凌晨|清晨|早上|上午|中午|午后|下午|傍晚|晚上|夜里|夜晚|深夜|睡前|早点休息|早点睡|半夜)/;

/** 只看「会传染语域」的字段：对话/短信示例 */
const STYLE_FIELD = /examples|textingStyle/;

function walk(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === 'string') {
    if (TIME_WORDS.test(node)) out.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
    }
  }
}

let fail = 0;

// ① 按真实绑定逐对取卡 —— 走服务端同一个函数（fork 优先），验证运行时会拿到什么
console.log('=== ① 按 QQ 绑定逐对取卡（loadCharacterData，fork 优先）===');
const binds = db
  .prepare("SELECT player_id, character_id FROM qq_bot_bindings WHERE status = 'active'")
  .all() as Array<{ player_id: string; character_id: string }>;
if (binds.length === 0) console.log('  （当前没有 active 绑定）');
for (const b of binds) {
  const c = loadCharacterData(b.player_id, b.character_id);
  const ctxs = (c?.speechStyle?.examples ?? [])
    .map((e) => (e as { context?: string })?.context ?? '')
    .filter(Boolean);
  const hits = ctxs.filter((t) => TIME_WORDS.test(t));
  fail += hits.length;
  console.log(`  玩家 ${b.player_id.slice(0, 8)} × ${c?.name ?? '?'}  示例场景: ${JSON.stringify(ctxs)}`);
  if (hits.length) console.log(`     ⚠️ 仍含时段锚点: ${JSON.stringify(hits)}`);
}
console.log(fail === 0 ? '  ✅ 绑定角色的示例场景已无时段锚点' : `  ❌ 还剩 ${fail} 处`);

// ② 全库兜底复查（公共卡 + 所有 fork）
console.log('\n=== ② 全库复查（characters + character_player_data）===');
let styleHits = 0;
let otherHits = 0;
for (const table of ['characters', 'character_player_data']) {
  for (const row of db.prepare(`SELECT character_data FROM ${table}`).all() as Array<{ character_data: string }>) {
    let data: unknown;
    try {
      data = JSON.parse(row.character_data);
    } catch {
      continue;
    }
    const out: Array<[string, string]> = [];
    walk(data, '', out);
    const name = (data as { name?: string })?.name ?? '';
    for (const [p, v] of out) {
      if (STYLE_FIELD.test(p)) {
        styleHits++;
        console.log(`  ❌ [${table}] ${name} · ${p} → ${v.slice(0, 60)}`);
      } else {
        otherHits++;
        console.log(`  ·  [${table}] ${name} · ${p} → ${v.slice(0, 60)}   （人设/历史类，保留）`);
      }
    }
  }
}
console.log(`\n  示例类命中 ${styleHits} 处${styleHits === 0 ? ' ✅' : ' ❌'} ／ 人设历史类 ${otherHits} 处（有意保留）`);

const ok = fail === 0 && styleHits === 0;
console.log(ok ? '\n✅ 通过：示例里不再有写死的时段，时间只有【当前场景】一个来源' : '\n❌ 未通过');
process.exit(ok ? 0 : 1);
