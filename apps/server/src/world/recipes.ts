// 制造配方表 —— 固定配方，NPC/玩家制造共用。
// 门派限制：faction 为空 = 通用配方（人人会）；否则只有该门派的 NPC 会。

import type { Recipe } from './types';

export const RECIPES: Recipe[] = [
  { id: 0, name: '凝气丹方', outputType: '丹药', outputName: '凝气丹',
    materials: [{ type: '灵草', count: 2 }, { type: '材料', count: 1 }],
    successRate: 0.75, effect: { kind: 'qi', base: 30 } },
  { id: 1, name: '续命丹方', outputType: '丹药', outputName: '续命丹',
    materials: [{ type: '灵草', count: 2 }, { type: '材料', count: 2 }],
    successRate: 0.6, effect: { kind: 'lifespan', base: 18 } },
  { id: 2, name: '筑基丹方', outputType: '丹药', outputName: '筑基丹',
    materials: [{ type: '灵草', count: 3 }, { type: '材料', count: 2 }],
    successRate: 0.45, effect: { kind: 'break', base: 0.2 } },
  { id: 3, name: '青锋剑谱', outputType: '法宝', outputName: '青锋剑',
    materials: [{ type: '材料', count: 3 }],
    successRate: 0.65, effect: { kind: 'qi', base: 25 } },
  { id: 4, name: '玄龟盾谱', outputType: '法宝', outputName: '玄龟盾',
    materials: [{ type: '材料', count: 3 }],
    successRate: 0.55, effect: { kind: 'lifespan', base: 10 } },
  { id: 5, name: '护身符方', outputType: '符箓', outputName: '护身符',
    materials: [{ type: '灵草', count: 1 }, { type: '材料', count: 2 }],
    successRate: 0.8, effect: { kind: 'lifespan', base: 6 } },
  { id: 6, name: '太乙剑诀抄本', outputType: '秘籍', outputName: '太乙剑诀',
    materials: [{ type: '材料', count: 2 }],
    successRate: 0.4, effect: { kind: 'break', base: 0.1 } },
  // 门派专属配方（只有对应门派的 NPC 会）
  { id: 7, name: '百草灵液方', outputType: '丹药', outputName: '百草灵液',
    materials: [{ type: '灵草', count: 4 }], faction: '百草谷',
    successRate: 0.7, effect: { kind: 'qi', base: 45 } },
  { id: 8, name: '万毒蛊方', outputType: '丹药', outputName: '万毒蛊',
    materials: [{ type: '灵草', count: 2 }, { type: '材料', count: 2 }], faction: '万毒教',
    successRate: 0.5, effect: { kind: 'break', base: 0.25 } },
  { id: 9, name: '天剑诀抄本', outputType: '秘籍', outputName: '天剑诀',
    materials: [{ type: '材料', count: 3 }], faction: '天剑门',
    successRate: 0.45, effect: { kind: 'break', base: 0.15 } },
];

/** 某门派会做的配方 = 通用 + 本门派专属 */
export function recipesForFaction(faction: string): Recipe[] {
  return RECIPES.filter((r) => r.faction === undefined || r.faction === faction);
}
