// 制造系统单测 —— NPC 纯规则结算 / 玩家二消（无失败）。
// 原则验证：NPC 制造 = 材料 + 成功率 + 门派；玩家制造 = 二消分数定品质，必出成品。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMaterials, npcCraft, playerCraftResult, playerRecipes } from '../world/craft';
import { recipesForFaction } from '../world/recipes';
import { makeRng } from '../world/rng';
import type { Item, Npc, Player, Quality, Recipe } from '../world/types';
import type { Board } from '../world/match2';
import { WorldEngine } from '../world/world';

function makeNpc(backpack: Item[] = []): Npc {
  return {
    id: 0, name: '测试修士', gender: '男', wx: '金', origin: '散修', faction: '散修盟',
    alignment: '绝对中立', mbti: 'INTP', realm: 0, qi: 10, aptitude: 50, comprehension: 50,
    charm: 50, fortune: 50, lifespan: 100, loc: 0, alive: true, liveliness: 0,
    backpack, daolv: [], affinities: new Map(), affinityToPlayer: 0,
  };
}

function makePlayer(backpack: Item[] = [], fortune = 50): Player {
  return {
    name: '你', gender: '女', wx: '水', realm: 0, qi: 10, aptitude: 60, comprehension: 60,
    charm: 60, fortune, lifespan: 100, loc: 0, backpack, energy: 100, actionPoints: 3,
    affinities: new Map(),
  };
}

function herb(id: number): Item { return { id, name: `灵草${id}`, type: '灵草', quality: '下品' }; }
function mat(id: number): Item { return { id, name: `材料${id}`, type: '材料', quality: '下品' }; }
function board(score: number): Board { return { size: 6, cells: [], score, movesLeft: 0 }; }

function danRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 0, name: '测试丹方', outputType: '丹药', outputName: '测试丹',
    materials: [{ type: '灵草', count: 2 }], successRate: 1.0,
    effect: { kind: 'qi', base: 10 }, ...overrides,
  };
}

test('npcCraft 成功率 1.0 → 必成功，消耗材料，产出成品', () => {
  const npc = makeNpc([herb(1), herb(2)]);
  let id = 100;
  const res = npcCraft(makeRng(1), npc, danRecipe(), () => id++);
  assert.equal(res.success, true);
  assert.ok(res.item);
  assert.equal(res.item!.type, '丹药');
  assert.ok(['下品', '中品', '上品', '极品'].includes(res.item!.quality));
  assert.equal(npc.backpack.length, 1, '2 灵草消耗，1 成品');
  assert.equal(npc.backpack[0]!.id, 100);
});

test('npcCraft 成功率 0.0 → 必失败，材料尽毁', () => {
  const npc = makeNpc([herb(1), herb(2)]);
  const res = npcCraft(makeRng(1), npc, danRecipe({ successRate: 0.0 }), () => 100);
  assert.equal(res.success, false);
  assert.equal(npc.backpack.length, 0, '材料尽毁，无成品');
  assert.match(res.desc, /失败/);
});

test('npcCraft 材料不足 → 失败且材料不扣', () => {
  const npc = makeNpc([herb(1)]); // 只有 1 灵草，需要 2
  const res = npcCraft(makeRng(1), npc, danRecipe(), () => 100);
  assert.equal(res.success, false);
  assert.equal(npc.backpack.length, 1, '材料不足不扣减');
});

test('npcCraft 成功率统计：0.5 成功率约半成', () => {
  const rng = makeRng(42);
  let success = 0;
  let id = 1000;
  for (let i = 0; i < 200; i++) {
    const npc = makeNpc([herb(i * 2), herb(i * 2 + 1)]);
    const res = npcCraft(rng, npc, danRecipe({ successRate: 0.5 }), () => id++);
    if (res.success) success++;
  }
  assert.ok(success >= 60 && success <= 140, `成功率应约 50%，实际 ${success}/200`);
});

test('hasMaterials 按类型计数判定材料是否足够', () => {
  assert.equal(hasMaterials([herb(1), herb(2)], [{ type: '灵草', count: 2 }]), true);
  assert.equal(hasMaterials([herb(1), mat(2)], [{ type: '灵草', count: 2 }]), false);
  assert.equal(hasMaterials([herb(1), mat(2), mat(3)], [{ type: '灵草', count: 1 }, { type: '材料', count: 2 }]), true);
});

test('recipesForFaction：通用配方人人会，门派配方仅本门派', () => {
  const 散修 = recipesForFaction('散修盟');
  const 百草 = recipesForFaction('百草谷');
  assert.ok(散修.length > 0);
  assert.ok(百草.length >= 散修.length, '百草谷额外会本门配方');
  assert.ok(散修.every((r) => r.faction === undefined), '散修盟只配通用配方');
  assert.ok(百草.some((r) => r.faction === '百草谷'), '百草谷含本门专属配方');
});

test('playerRecipes：玩家会全部通用配方', () => {
  const rs = playerRecipes();
  assert.ok(rs.length > 0);
  assert.ok(rs.every((r) => r.faction === undefined));
});

test('playerCraftResult 无失败：0 分也出成品（下品）', () => {
  const player = makePlayer([herb(1), herb(2)]);
  let id = 100;
  const res = playerCraftResult(makeRng(1), player, danRecipe(), board(0), () => id++);
  assert.equal(res.success, true);
  assert.equal(res.quality, '下品');
  assert.ok(res.item);
  assert.equal(player.backpack.length, 1, '材料消耗，1 成品（无失败）');
});

test('playerCraftResult 高分数 → 极品', () => {
  const player = makePlayer([herb(1), herb(2)]);
  const res = playerCraftResult(makeRng(1), player, danRecipe(), board(400), () => 100);
  assert.equal(res.success, true);
  assert.equal(res.quality, '极品');
});

test('playerCraftResult 高气运 fortune≥80 → 品质上调一档', () => {
  const player = makePlayer([herb(1), herb(2)], 80);
  // score 220 → 中品，气运 80 → 上调一档为上品
  const res = playerCraftResult(makeRng(1), player, danRecipe(), board(220), () => 100);
  assert.equal(res.quality, '上品');
});

test('playerCraftResult 材料不足 → 失败且不消耗', () => {
  const player = makePlayer([herb(1)]);
  const res = playerCraftResult(makeRng(1), player, danRecipe(), board(100), () => 100);
  assert.equal(res.success, false);
  assert.equal(player.backpack.length, 1);
});

test('玩家制造品质映射与分数单调：分数越高品质不降', () => {
  const scores: Array<[number, Quality]> = [[10, '下品'], [220, '中品'], [320, '上品'], [400, '极品']];
  for (const [score, expect] of scores) {
    const player = makePlayer([herb(1), herb(2)]);
    const res = playerCraftResult(makeRng(1), player, danRecipe(), board(score), () => 100);
    assert.equal(res.quality, expect, `分数 ${score} 应出 ${expect}`);
  }
});

test('世界集成：NPC 制造写入「制造」事件（private）', () => {
  const e = new WorldEngine({ seed: 11, npcCount: 20, gridSize: 8 });
  // 给所有 NPC 塞足材料，保证制造能触发
  let id = 10000;
  for (const n of e.npcs) {
    for (let i = 0; i < 6; i++) n.backpack.push({ id: id++, name: `灵草${i}`, type: '灵草', quality: '下品' });
    for (let i = 0; i < 6; i++) n.backpack.push({ id: id++, name: `材料${i}`, type: '材料', quality: '下品' });
  }
  e.run(12);
  const crafts = e.world.events.filter((ev) => ev.type === '制造');
  assert.ok(crafts.length > 0, '12 个月内应有 NPC 制造事件');
  for (const ev of crafts) assert.equal(ev.visibility, 'private');
});
