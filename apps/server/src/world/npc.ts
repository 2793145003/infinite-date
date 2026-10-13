// NPC 生成。四维度（出身/立场/阵营/MBTI）是种子，经历是推演结果。
// 初始境界呈金字塔分布（解决 spike「两年全元婴」的层次缺失）。

import type { Alignment, Npc, Realm, Wx } from './types';
import { ALIGNMENTS, MBTI_TYPES, REALM_LIFESPAN } from './types';
import { pick, randInt } from './rng';
import type { Rng } from './rng';
import { generateItem } from './items';
import type { WorldMap } from './map';

const SURNAMES = ['苏', '沈', '林', '萧', '温', '白', '虞', '顾', '陆', '叶', '秦', '柳', '江', '楚', '裴', '容', '傅', '谢', '宋', '周'] as const;
const GIVEN = ['弦', '檀', '瑶', '濯', '玄', '砚', '霁', '澜', '澈', '芜', '蘅', '珺', '珩', '羲', '绾', '灼', '汐', '琤', '渊', '鸾'] as const;

const ORIGINS = ['寒门散修', '世家子弟', '宗门内门', '外门弟子', '魔道散修', '隐世遗族'] as const;
type Origin = (typeof ORIGINS)[number];

const FACTIONS_BY_ORIGIN: Record<Origin, readonly string[]> = {
  寒门散修: ['散修盟', '无门无派'],
  世家子弟: ['太华派', '青云宗'],
  宗门内门: ['青云宗', '天剑门', '百草谷'],
  外门弟子: ['青云宗', '天剑门', '百草谷'],
  魔道散修: ['万毒教', '血煞宗', '合欢宗'],
  隐世遗族: ['无门无派', '隐世'],
};

// 三均匀平均 → 近似正态，集中在 mean 附近
function normalish(rng: Rng, mean: number, spread: number, min: number, max: number): number {
  const r = (rng() + rng() + rng()) / 3;
  const v = Math.round(mean + (r - 0.5) * 2 * spread);
  return Math.min(max, Math.max(min, v));
}

// 初始境界金字塔：练气 70% / 筑基 25% / 金丹 4% / 元婴 1%
function rollInitialRealm(rng: Rng): Realm {
  const r = rng();
  if (r < 0.70) return 0;
  if (r < 0.95) return 1;
  if (r < 0.99) return 2;
  return 3;
}

export function generateNpc(
  rng: Rng,
  id: number,
  name: string,
  loc: number,
  nextItemId: () => number,
): Npc {
  const wx: Wx = pick(rng, ['金', '木', '水', '火', '土']);
  const origin = pick(rng, ORIGINS);
  const faction = pick(rng, FACTIONS_BY_ORIGIN[origin]);
  const alignment: Alignment = pick(rng, ALIGNMENTS);
  const mbti = pick(rng, MBTI_TYPES);
  const realm: Realm = rollInitialRealm(rng);

  const aptitude = normalish(rng, 50, 25, 1, 100);
  const comprehension = normalish(rng, 50, 25, 1, 100);
  const charm = normalish(rng, 50, 25, 1, 100);
  const fortune = normalish(rng, 50, 25, 1, 100);

  // 寿元：已消耗一部分（年龄），境界越高上限越高
  const lifespanCap = REALM_LIFESPAN[realm]!;
  const lifespan = Math.max(1, Math.round(lifespanCap * (0.25 + rng() * 0.5)));

  // 初始背包 0~2 件
  const backpack = [];
  const n = randInt(rng, 3);
  for (let i = 0; i < n; i++) {
    backpack.push(generateItem(rng, nextItemId()));
  }

  return {
    id,
    name,
    gender: rng() < 0.5 ? '男' : '女',
    wx,
    origin,
    faction,
    alignment,
    mbti,
    realm,
    qi: realm * 100 + randInt(rng, 100),
    aptitude,
    comprehension,
    charm,
    fortune,
    lifespan,
    loc,
    alive: true,
    liveliness: 0,
    backpack,
    daolv: [],
    affinities: new Map(),
    affinityToPlayer: 0,
  };
}

// 生成一批不重名的 NPC
export function generateNpcs(
  rng: Rng,
  count: number,
  map: WorldMap,
  nextItemId: () => number,
): Npc[] {
  const used = new Set<string>();
  const npcs: Npc[] = [];
  for (let i = 0; i < count; i++) {
    let name = '';
    do {
      name = pick(rng, SURNAMES) + pick(rng, GIVEN);
    } while (used.has(name));
    used.add(name);
    npcs.push(generateNpc(rng, i, name, map.randomLoc(rng), nextItemId));
  }
  return npcs;
}
