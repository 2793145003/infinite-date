// 离线 runner —— 跑 N 个月，输出人类可读的「世界在动」叙事。
// 用法：
//   纯演化：npx tsx src/world/runner.ts --months 36 --seed 42 --npc 16 --grid 8
//   玩家模式：npx tsx src/world/runner.ts --player --months 24 --seed 42 --npc 16 --regions 3 --cells 3

import { WorldEngine } from './world';
import { createPlayer } from './player';
import { makeRng } from './rng';
import { isIntervenable } from './intervene';
import { REALMS } from './types';
import type { ItemType, Player } from './types';
import { generateItem } from './items';
import { ALL_TILES, autoPlay, newBoard } from './match2';
import { hasMaterials, playerCraftResult, playerRecipes } from './craft';
import { chance } from './rng';

function parseArgs(argv: string[]): Record<string, number> {
  const args: Record<string, number> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--') && i + 1 < argv.length) {
      const val = Number(argv[i + 1]);
      if (!Number.isNaN(val)) {
        args[a.slice(2)] = val;
        i++;
      }
    }
  }
  return args;
}

const line = '═'.repeat(56);

function nameOf(engine: WorldEngine, id: number): string {
  return engine.world.npcs.get(id)?.name ?? `#${id}`;
}

function manhattan(a: { gx: number; gy: number }, b: { gx: number; gy: number }): number {
  return Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy);
}

function main(): void {
  const args = parseArgs(process.argv);
  const isPlayer = process.argv.includes('--player');
  const seed = args.seed ?? 42;
  const npcCount = args.npc ?? 16;
  const months = args.months ?? 24;
  const gridSize = args.grid ?? 8;
  const regions = args.regions ?? 3;
  const cells = args.cells ?? 3;

  if (isPlayer) {
    runWithPlayer(seed, npcCount, months, regions, cells);
  } else {
    runPure(seed, npcCount, months, gridSize);
  }
}

function runPure(seed: number, npcCount: number, months: number, gridSize: number): void {
  const engine = new WorldEngine({ seed, npcCount, gridSize });
  engine.run(months);
  const world = engine.world;
  const alive = engine.aliveNpcs();

  console.log(line);
  console.log('  衍生世界 · 离线演化');
  console.log(`  seed=${seed} · ${npcCount} 位修士 · ${months} 个月 · ${gridSize} 格`);
  console.log(line);

  console.log('\n【世界传闻 · 大事件流】不认识的人也只看得见这些\n');
  const publicEvts = engine.publicEvents();
  if (publicEvts.length === 0) {
    console.log('  （本周期无大事件）');
  } else {
    for (const e of publicEvts) {
      console.log(`  ${String(e.tick).padStart(3)} 月  ${e.desc}`);
    }
  }

  console.log(`\n【最终世界 · ${months} 个月后】`);
  const realmCount = new Map<number, number>();
  for (const n of alive) realmCount.set(n.realm, (realmCount.get(n.realm) ?? 0) + 1);
  const dist = REALMS.map((r, i) => `${r} ${realmCount.get(i) ?? 0}`).join(' · ');
  console.log(`  存活 ${alive.length} / 陨落 ${npcCount - alive.length}`);
  console.log(`  境界分布：${dist}`);

  const pairs = new Set<string>();
  for (const n of alive) {
    for (const d of n.daolv) {
      const key = [n.id, d].sort((a, b) => a - b).join('-');
      pairs.add(key);
    }
  }
  if (pairs.size > 0) {
    const names = [...pairs].map((k) => {
      const [a, b] = k.split('-').map(Number);
      return `${world.npcs.get(a!)?.name}×${world.npcs.get(b!)?.name}`;
    });
    console.log(`  道侣：${names.join('、')}`);
  } else {
    console.log('  道侣：无');
  }

  console.log('\n【修士列传 · 点开履历看到的完整时间轴】\n');
  const eventCount = new Map<number, number>();
  for (const e of world.events) for (const id of e.npcIds) eventCount.set(id, (eventCount.get(id) ?? 0) + 1);
  const interesting = alive
    .filter((n) => (eventCount.get(n.id) ?? 0) > 0)
    .sort((a, b) => (eventCount.get(b.id) ?? 0) - (eventCount.get(a.id) ?? 0))
    .slice(0, 4);
  for (const n of interesting) {
    const meta = `${n.name}（${n.wx} · ${n.alignment} · ${n.mbti} · ${n.origin} · ${REALMS[n.realm]}）`;
    console.log(`  ${meta}`);
    for (const e of engine.npcHistory(n.id)) {
      const tag = e.visibility === 'public' ? '★' : ' ';
      console.log(`   ${tag} ${String(e.tick).padStart(3)} 月  ${e.desc}`);
    }
    console.log('');
  }

  console.log(line);
  console.log('  ★ = 公开大事件（世界传闻可见） · 无星 = 只有你认识他才看得到');
  console.log(line);
}

function runWithPlayer(seed: number, npcCount: number, months: number, regions: number, cells: number): void {
  const engine = new WorldEngine({ seed, npcCount, regions, cells });
  const map = engine.world.map;
  // 玩家独立 rng（不与世界 rng 争状态），同 seed 同世界同玩家
  const rng = makeRng(seed + 1_000_000);
  const player: Player = createPlayer(rng, { name: '星落', loc: map.randomLoc(rng) });
  engine.attachPlayer(player);

  const promoted: number[] = [];       // 升格的 NPC id
  const interventions: string[] = [];  // 介入记录
  const crafts: string[] = [];         // 玩家炼成的记录

  for (let m = 0; m < months; m++) {
    // 玩家探索顺手采药（灵草/材料，制造原料）
    if (chance(rng, 0.6)) {
      const t: ItemType = rng() < 0.5 ? '灵草' : '材料';
      player.backpack.push(generateItem(rng, engine.world.nextItemId++, t));
    }
    // 玩家走格子：优先走向相邻格里有「未升格 NPC」的（探索），否则随机
    for (let step = 0; step < player.actionPoints; step++) {
      const ns = map.neighbors(player.loc);
      const target = ns.find((loc) => {
        for (const n of engine.aliveNpcs()) {
          if (n.loc === loc && n.liveliness === 0) return true;
        }
        return false;
      });
      player.loc = target ?? ns[Math.floor(rng() * ns.length)] ?? player.loc;
      const met = engine.playerMove(player.loc);
      for (const n of met) if (!promoted.includes(n.id)) promoted.push(n.id);
    }
    // 介入本月的冲突事件：玩家「闻讯赶来」——看到冲突预兆，赶到现场帮/劝/旁观
    engine.tick((pending, eng) => {
      for (const p of pending) {
        if (!isIntervenable(p.type)) continue;
        const dist = manhattan(map.pos(player.loc), map.pos(p.loc));
        if (dist > player.actionPoints) continue; // 太远，赶不及
        player.loc = p.loc;
        eng.world.player!.loc = p.loc;
        eng.playerMove(p.loc); // 赶到现场，顺带升格现场 NPC
        const r = rng();
        if (r < 0.4) {
          eng.intervene(p, '帮A', p.subjectId);
          interventions.push(`第${String(eng.world.tick).padStart(3)} 月 帮 ${nameOf(eng, p.subjectId)}（${p.type}）`);
        } else if (r < 0.7) {
          eng.intervene(p, '劝架');
          interventions.push(`第${String(eng.world.tick).padStart(3)} 月 劝架（${p.type}）`);
        }
        // 其余：旁观
      }
    });
    // 玩家制造：每两月炼一炉（二消小游戏，无失败纯爽）
    if (m % 2 === 1) {
      const recipe = playerRecipes().find((r) => hasMaterials(player.backpack, r.materials));
      if (recipe) {
        const board = newBoard(rng, 6, ALL_TILES, 20);
        autoPlay(board, rng, ALL_TILES);
        const res = playerCraftResult(rng, player, recipe, board, () => engine.world.nextItemId++);
        if (res.success) crafts.push(`第${String(m + 1).padStart(3)} 月 炼成 ${res.item!.name}（${res.score} 分）`);
      }
    }
  }

  console.log(line);
  console.log('  衍生世界 · 玩家模式（走格子 + 介入 + 升格）');
  console.log(`  seed=${seed} · ${npcCount} 位修士 · ${months} 个月 · ${regions}×${cells} 大格套小格`);
  console.log(line);

  console.log(`\n【你】${player.name}（${player.wx} · ${REALMS[player.realm]} · 资质${player.aptitude} 悟性${player.comprehension} 魅力${player.charm} 气运${player.fortune}）`);
  console.log(`  落脚：${map.name(player.loc)} · 背包 ${player.backpack.length} 件`);

  console.log(`\n【你「活过来」的 NPC · ${promoted.length} 位】`);
  if (promoted.length === 0) {
    console.log('  （你足不出户，谁也没遇见）');
  } else {
    for (const id of promoted) {
      const n = engine.world.npcs.get(id);
      if (!n) continue;
      const myAff = player.affinities.get(id) ?? 0;
      console.log(`  ${n.name}（${n.wx} · ${n.alignment} · ${REALMS[n.realm]}） 你对TA ${myAff} / TA对你 ${n.affinityToPlayer}`);
    }
  }

  console.log(`\n【你介入的事 · ${interventions.length} 件】`);
  if (interventions.length === 0) {
    console.log('  （你冷眼旁观，没有插手任何冲突）');
  } else {
    for (const s of interventions) console.log(`  ${s}`);
  }

  const intervEvents = engine.world.events.filter((e) => e.playerIntervened);
  if (intervEvents.length > 0) {
    console.log('\n【介入的结局】');
    for (const e of intervEvents) {
      console.log(`  ${String(e.tick).padStart(3)} 月  ${e.desc}`);
    }
  }

  console.log(`\n【你炼成的 · ${crafts.length} 件】`);
  if (crafts.length === 0) {
    console.log('  （你还没凑够材料炼第一炉）');
  } else {
    for (const s of crafts) console.log(`  ${s}`);
  }
  console.log(`  背包 ${player.backpack.length} 件`);

  console.log('\n' + line);
}

main();
