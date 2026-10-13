// 制造结算 —— NPC 纯规则 / 玩家二消。
// 原则：玩家接触的给体验（二消小游戏），看不见过程的用规则（NPC 一键结算）。

import type { CraftResult, Item, Npc, Player, Quality, Recipe } from './types';
import { scoreToQuality } from './match2';
import type { Board } from './match2';
import { RECIPES } from './recipes';
import type { Rng } from './rng';

const QUALITY_MULT: Record<Quality, number> = { 下品: 0.6, 中品: 1.0, 上品: 1.4, 极品: 2.0 };
const QUALITY_SUFFIX: Record<Quality, string> = { 下品: '', 中品: '（中品）', 上品: '（上品）', 极品: '（极品）' };
const RANK: Quality[] = ['下品', '中品', '上品', '极品'];

/** 成品效果 = 配方基础值 × 品质乘数 */
function craftEffects(recipe: Recipe, quality: Quality): Partial<Item> {
  const m = QUALITY_MULT[quality];
  const base = recipe.effect.base;
  switch (recipe.effect.kind) {
    case 'qi': return { qiBonus: Math.round(base * m) };
    case 'lifespan': return { lifespanBonus: Math.round(base * m) };
    case 'break': return { realmBreak: Math.min(0.6, base * m) };
  }
}

function makeItem(id: number, recipe: Recipe, quality: Quality): Item {
  return {
    id,
    name: `${recipe.outputName}${QUALITY_SUFFIX[quality]}`,
    type: recipe.outputType,
    quality,
    ...craftEffects(recipe, quality),
  };
}

/** NPC 制造品质 roll：难配方（成功率低）更容易出高品质（稀罕） */
function rollNpcQuality(rng: Rng, successRate: number): Quality {
  const epic = 0.05 + (1 - successRate) * 0.1;
  const high = 0.2 + (1 - successRate) * 0.1;
  const r = rng();
  if (r < epic) return '极品';
  if (r < epic + high) return '上品';
  if (r < epic + high + 0.35) return '中品';
  return '下品';
}

export function hasMaterials(backpack: Item[], materials: Recipe['materials']): boolean {
  for (const mat of materials) {
    const cnt = backpack.filter((it) => it.type === mat.type).length;
    if (cnt < mat.count) return false;
  }
  return true;
}

/** 消耗材料：从背包按类型扣减；材料不足返回 false（不扣） */
function consumeMaterials(backpack: Item[], materials: Recipe['materials']): boolean {
  if (!hasMaterials(backpack, materials)) return false;
  for (const mat of materials) {
    let need = mat.count;
    for (let i = backpack.length - 1; i >= 0 && need > 0; i--) {
      if (backpack[i]!.type === mat.type) { backpack.splice(i, 1); need--; }
    }
  }
  return true;
}

/** NPC 制造（纯规则）：消耗材料 → 成功率 roll（金丹以上更稳）→ 成品/废料 */
export function npcCraft(rng: Rng, npc: Npc, recipe: Recipe, nextItemId: () => number): CraftResult {
  if (!consumeMaterials(npc.backpack, recipe.materials)) {
    return { success: false, desc: `${npc.name}想炼${recipe.outputName}，但材料不足` };
  }
  const realmBonus = npc.realm >= 2 ? 0.1 : 0;
  if (rng() >= recipe.successRate + realmBonus) {
    return { success: false, desc: `${npc.name}炼制${recipe.outputName}失败，材料尽毁` };
  }
  const quality = rollNpcQuality(rng, recipe.successRate);
  const item = makeItem(nextItemId(), recipe, quality);
  npc.backpack.push(item);
  return { success: true, item, quality, desc: `${npc.name}炼成「${item.name}」` };
}

/** 玩家会做的配方 = 通用配方（无门派限制） */
export function playerRecipes(): Recipe[] {
  return RECIPES.filter((r) => r.faction === undefined);
}

/** 玩家制造：二消已玩完（board 是结果盘面），分数 → 品质（气运加成），无失败必出成品 */
export function playerCraftResult(rng: Rng, player: Player, recipe: Recipe, board: Board, nextItemId: () => number): CraftResult {
  if (!consumeMaterials(player.backpack, recipe.materials)) {
    return { success: false, desc: '材料不足，无法炼制' };
  }
  let quality = scoreToQuality(board.score);
  // 气运加成：高气运（≥80）品质上调一档
  if (player.fortune >= 80 && RANK.indexOf(quality) < RANK.length - 1) {
    quality = RANK[RANK.indexOf(quality) + 1]!;
  }
  const item = makeItem(nextItemId(), recipe, quality);
  player.backpack.push(item);
  return { success: true, item, quality, score: board.score, desc: `你炼成「${item.name}」（二消 ${board.score} 分）` };
}
