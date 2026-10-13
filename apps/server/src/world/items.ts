// 物品生成。Phase 1 只做三种效果维度：延寿 / 灵力 / 突破辅助。

import type { Item, ItemType, Quality } from './types';
import { pick, randInt } from './rng';
import type { Rng } from './rng';

const QUALITIES: readonly Quality[] = ['下品', '中品', '上品', '极品'];

// 各类型物品名（前缀池）
const ITEM_NAMES: Record<ItemType, readonly string[]> = {
  丹药: ['凝气丹', '筑基丹', '续命丹', '养魂丹', '回春丹', '洗髓丹'],
  灵草: ['紫芝', '血参', '龙涎草', '月华莲', '冰魄花', '九叶灵藤'],
  法宝: ['青锋剑', '玄龟盾', '离火珠', '捆仙索', '镇魂幡', '碧水环'],
  秘籍: ['太乙剑诀', '五行遁术', '玄冥心经', '丹鼎秘录', '驭兽真解', '阵道初解'],
  材料: ['天外陨铁', '千年寒玉', '妖兽内丹', '地火之精', '玄黄石', '凤羽'],
  符箓: ['破障符', '护身符', '遁地符', '引雷符', '静心符', '聚灵符'],
};

function makeName(rng: Rng, type: ItemType, quality: Quality): string {
  const base = pick(rng, ITEM_NAMES[type]);
  const suffix = quality === '极品' ? '（极品）' : quality === '上品' ? '（上品）' : quality === '中品' ? '（中品）' : '';
  return suffix ? `${base}${suffix}` : base;
}

// 按品质与类型生成一个物品
export function generateItem(rng: Rng, id: number, type?: ItemType, quality?: Quality): Item {
  const t = type ?? pick(rng, Object.keys(ITEM_NAMES) as ItemType[]);
  const q = quality ?? pick(rng, QUALITIES);
  const item: Item = { id, name: makeName(rng, t, q), type: t, quality: q };

  // 按类型挂效果
  if (t === '丹药') {
    if (item.name.includes('续命') || item.name.includes('回春')) {
      item.lifespanBonus = 12 + randInt(rng, 24); // 延寿 12~35 月
    } else if (item.name.includes('筑基') || item.name.includes('洗髓')) {
      item.realmBreak = 0.15 + rng() * 0.2;       // 突破加成 15%~35%
    } else {
      item.qiBonus = 20 + randInt(rng, 60);       // 灵力 +20~79
    }
  } else if (t === '灵草' || t === '材料') {
    item.qiBonus = 5 + randInt(rng, 20);
  } else if (t === '法宝') {
    item.qiBonus = 15 + randInt(rng, 40);
  } else if (t === '秘籍') {
    item.realmBreak = 0.05 + rng() * 0.15;
  } else {
    // 符箓：随机给一种效果
    const roll = randInt(rng, 3);
    if (roll === 0) item.lifespanBonus = 6 + randInt(rng, 12);
    else if (roll === 1) item.qiBonus = 10 + randInt(rng, 30);
    else item.realmBreak = 0.05 + rng() * 0.1;
  }
  return item;
}
