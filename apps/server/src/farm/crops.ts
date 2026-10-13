/**
 * 作物定义（纯数据，无 DB / 无 LLM 依赖）。
 *
 * 时长 = 现实时间（星落定：目的是让玩家隔一阵就想回来看看）；越长越稀有。
 * 不摘不会坏、不会枯死——这个模块里**刻意没有 decay / 枯死 / 害虫**任何逻辑。
 */

export interface Crop {
  key: string;
  name: string;
  /** 现实时间成熟时长（小时） */
  hours: number;
  /** 一次收获的产量 */
  yield: number;
  /** 奇幻向 */
  fantasy?: boolean;
  /** 专属作物：只有从他的院子偷到、或他送你才能拿到 */
  exclusive?: boolean;
  note?: string;
}

/** 生活向作物（定稿） */
export const CROPS: readonly Crop[] = [
  { key: 'scallion', name: '小葱', hours: 2, yield: 3, note: '起步作物，人人会种' },
  { key: 'dewgreen', name: '晨露菜', hours: 3, yield: 2 },
  { key: 'tomato', name: '番茄', hours: 4, yield: 3 },
  { key: 'cucumber', name: '黄瓜', hours: 5, yield: 3 },
  { key: 'firepepper', name: '烈火椒', hours: 6, yield: 2 },
  { key: 'strawberry', name: '草莓', hours: 8, yield: 4 },
  { key: 'cloudrice', name: '云顶米', hours: 12, yield: 5 },
  { key: 'pumpkin', name: '南瓜', hours: 12, yield: 2, note: '一颗就够做一锅' },
  { key: 'grape', name: '葡萄', hours: 16, yield: 6, note: '藤上多' },
  { key: 'ginseng', name: '山参', hours: 24, yield: 1, note: '稀有，适合送人' },
];

/** 专属作物池（奇幻向）：每个男主一种，规则见 exclusiveCropFor() */
export const EXCLUSIVE_CROPS: readonly Crop[] = [
  { key: 'starlight', name: '星光果', hours: 20, yield: 2, fantasy: true, exclusive: true, note: '夜里会自己发一点光' },
  { key: 'frostberry', name: '霜凌莓', hours: 18, yield: 3, fantasy: true, exclusive: true, note: '指尖一碰就凉' },
  { key: 'moonglow', name: '月光菇', hours: 22, yield: 2, fantasy: true, exclusive: true, note: '只在夜里长' },
  { key: 'thunderpepper', name: '雷鸣椒', hours: 24, yield: 2, fantasy: true, exclusive: true, note: '咬开在嘴里响一声' },
  { key: 'mistvine', name: '雾隐藤', hours: 26, yield: 3, fantasy: true, exclusive: true, note: '露水一散就藏起来' },
  { key: 'sunsetmelon', name: '火烧云果', hours: 28, yield: 1, fantasy: true, exclusive: true, note: '熟了会甜得发烫' },
];

export const ALL_CROPS: readonly Crop[] = [...CROPS, ...EXCLUSIVE_CROPS];

export function cropByKey(key: string): Crop | undefined {
  return ALL_CROPS.find((c) => c.key === key);
}

export function cropName(key: string): string {
  return cropByKey(key)?.name ?? key;
}

/** 初始赠送的种子（各 2 颗） */
export const STARTING_SEEDS: readonly string[] = ['scallion', 'dewgreen', 'tomato'];
export const STARTING_SEED_COUNT = 2;

/** 掉率（星落定） */
export const SEED_DROP_EXPLORE = 0.35;      // 探索地图命中物品掉落时，额外掉种子
export const SEED_KEEP_ON_HARVEST = 0.3;    // 收菜留种
export const SEED_FROM_STEAL = 0.25;        // 偷菜附赠

/** 判定专属作物用的人设切面（character_data 的子集，全部可选便于离线跑） */
export interface PersonaLite {
  name?: string;
  drive?: string;
  skills?: string;
  personality?: unknown;
  likes?: unknown;
  quirks?: unknown;
}

interface CropRule {
  crop: string;
  words: readonly string[];
}

/**
 * 关键词 → 专属作物（规则先行，确定性兜底）。
 * 为什么不用 LLM：这条规则**离线可测**——同一个男主跑一百遍结果一样。
 * 真需要更有想象力的映射时，再在懒生成那一步用 LLM 覆盖并落进 character_data（与既有做法一致）。
 */
const EXCLUSIVE_RULES: readonly CropRule[] = [
  { crop: 'starlight', words: ['光', '星', '亮', '黎明', '晨', '耀眼'] },
  { crop: 'frostberry', words: ['雪', '冰', '霜', '冷', '寒', '克制'] },
  { crop: 'moonglow', words: ['月', '夜', '暗', '梦', '眠', '睡'] },
  { crop: 'thunderpepper', words: ['雷', '怒', '暴', '战', '烈'] },
  { crop: 'mistvine', words: ['雾', '隐', '棋', '谋', '局', '静'] },
  { crop: 'sunsetmelon', words: ['火', '灼', '阳', '夏', '焰', '暖'] },
];

function haystackOf(data: PersonaLite): string {
  return [data.name, data.drive, data.skills, data.personality, data.likes, data.quirks]
    .map((v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)))
    .join(' ');
}

function hashOf(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** 这个男主的专属作物 */
export function exclusiveCropFor(data: PersonaLite): Crop {
  const hay = haystackOf(data);
  let best: { crop: string; score: number } | null = null;
  for (const rule of EXCLUSIVE_RULES) {
    let score = 0;
    for (const w of rule.words) if (hay.includes(w)) score++;
    if (score > 0 && (!best || score > best.score)) best = { crop: rule.crop, score };
  }
  const key = best?.crop ?? EXCLUSIVE_CROPS[hashOf(data.name ?? 'anon') % EXCLUSIVE_CROPS.length]!.key;
  return cropByKey(key)!;
}
