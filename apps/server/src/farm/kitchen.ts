/**
 * 料理盘面 + 编菜规则（「共享菜园」的二消料理）。
 *
 * 复用 world/match2.ts 原始引擎的**同一套块数与权重**，只把名字换成料理语境
 * （引擎已参数化搬到 src/lib/match2.ts）。换皮不动权重 → 连锁手感与修仙盘面一致，
 * 不需要重新校准连锁分布（那条实测结论见 lib/match2.ts 头部注释）。
 *
 * 本文件同时负责**治菜名塌缩**（第一轮离线实测发现：15 个菜名里 14 个是「星X烩饭」）：
 *   1. 形态（做法）由加成块决定，当硬约束喂给模型
 *   2. 程序侧随机抽 2~3 个意象词，要求至少用上 1 个
 *   3. 主食词受限：云顶米不是主力时禁止「饭/粥/米」
 *   4. 禁止与最近若干次用过的菜名重复
 */

import type { Board, QualityTier, TileSet } from '../lib/match2';
import { findMatches, greedySwap, newBoard, trySwap } from '../lib/match2';
import type { Rng } from './rng';

/** 基础食材（对位修仙五行的金木水火土） */
export const KITCHEN_BASE: readonly string[] = ['星光果', '云顶米', '晨露菜', '烈火椒', '岩纹肉'];
/** 加成块：老火高汤 = 灵石(3分) / 猛火 = 丹炉(2分·清行列) / 秘制酱 = 仙晶(8分·稀有) */
export const KITCHEN_BONUS: readonly string[] = ['老火高汤', '猛火', '秘制酱'];
export const KITCHEN_TILES: readonly string[] = [...KITCHEN_BASE, ...KITCHEN_BONUS];

export const KITCHEN_SET: TileSet = {
  types: KITCHEN_TILES,
  score: { 星光果: 1, 云顶米: 1, 晨露菜: 1, 烈火椒: 1, 岩纹肉: 1, 老火高汤: 3, 猛火: 2, 秘制酱: 8 },
  weights: { 星光果: 1, 云顶米: 1, 晨露菜: 1, 烈火椒: 1, 岩纹肉: 1, 老火高汤: 0.6, 猛火: 0.4, 秘制酱: 0.25 },
  clearLine: '猛火',
};

/** 标准料理盘面：7×7、12 步（火候 12 步）。品质阈值就是按这个盘面校准的，别单独改。 */
export const KITCHEN_BOARD = { size: 7, moves: 12 } as const;

/**
 * 品质阈值（**已按料理盘面重校准**，不再是衍生世界那套 200/280/380 —— 那套照搬过来
 * 玩家几乎做不出极品）。
 *
 * 校准方法：同一套权重下，用「贪心玩家」（lib/match2.greedyPlay，每步挑消得最多的）
 * 跑 40 局 7×7 / 12 步，取分位：p25 252 / p50 314 / p85 428，max 506，均值 323；
 * 随机合法交换（真人下限参考）跑出来是 138~308。
 * → 下品 <250、中品 ≥250、上品 ≥320、极品 ≥430（贪心打法约 15% 能到极品）。
 * 真人数据攒出来后用 lib/match2.calibrateTiers() 重跑一遍即可（阈值放这里，不散在代码里）。
 */
export const KITCHEN_QUALITY_TIERS: readonly QualityTier[] = [
  { min: 0, quality: '下品' },
  { min: 250, quality: '中品' },
  { min: 320, quality: '上品' },
  { min: 430, quality: '极品' },
];

/** 做法形态（由加成块决定——这是治「什么都做饭」的第一招） */
export type DishForm = '家常' | '炖汤' | '爆炒' | '凉拌酱汁';

/** 成品形态词池（菜名里必须含有所属池子的一个字） */
export const FORM_NOUNS: Record<DishForm, readonly string[]> = {
  家常: ['煎', '蒸', '卷', '小炒', '饼', '盅'],
  炖汤: ['汤', '羹', '煲', '炖', '煨', '粥'],
  爆炒: ['炒', '爆', '炝', '炙', '干煸'],
  凉拌酱汁: ['拌', '渍', '冻', '酱', '冷盘', '沙拉'],
};

/** 意象词池：程序侧随机给词，逼它别每次都「星辉/晨曦」 */
export const IMAGERY_POOLS: Record<DishForm, readonly string[]> = {
  家常: ['灶边', '粗陶碗', '黄昏', '油亮', '窗台', '旧铁锅', '刚出锅'],
  炖汤: ['小火', '白雾', '砂锅', '整夜', '暖手', '壶底', '慢'],
  爆炒: ['噼啪', '爆香', '跳锅', '瞬间', '猛火边', '焦边', '腾起'],
  凉拌酱汁: ['冰过', '透亮', '酸口', '一勺', '凉丝丝', '琥珀', '腌渍'],
};

/** 品质 → 文案要求（治「下品也编得容光焕发」） */
export const QUALITY_BRIEF: Record<string, string> = {
  下品: '火候有点糙：卖相将就、调料不均匀。**不许用华丽词**，实在、朴素，别吹。',
  中品: '家常但干净，有一个小亮点（比如火候刚好、或者配色舒服）。',
  上品: '调味有层次、摆盘讲究，看得出是用心做的。',
  极品: '有仪式感：食材搭配精妙、香气有记忆点，端上桌会让人愣一下。',
};

/** 各块消除数 → 做法形态：谁在加成块里消得最多，就按谁的路子做 */
export function formOf(tally: Record<string, number>): DishForm {
  const up = tally['老火高汤'] ?? 0;
  const fire = tally['猛火'] ?? 0;
  const sauce = tally['秘制酱'] ?? 0;
  const max = Math.max(up, fire, sauce);
  if (max <= 0) return '家常';
  if (max === up) return '炖汤';
  if (max === fire) return '爆炒';
  return '凉拌酱汁';
}

/** 基础食材按消除数排序 */
export function rankedBase(tally: Record<string, number>): string[] {
  return [...KITCHEN_BASE].sort((a, b) => (tally[b] ?? 0) - (tally[a] ?? 0));
}

export function rankedBonus(tally: Record<string, number>): string[] {
  return [...KITCHEN_BONUS].filter((t) => (tally[t] ?? 0) > 0).sort((a, b) => (tally[b] ?? 0) - (tally[a] ?? 0));
}

/** 菜名里禁止出现的词：云顶米不是主力时不许做饭；也不要这种塌缩词 */
export function bannedNameWords(tally: Record<string, number>): string[] {
  const words = ['星辉', '星芒', '晨曦', '流光', '烩'];
  const rice = tally['云顶米'] ?? 0;
  const tops = rankedBase(tally).slice(0, 2);
  if (!tops.includes('云顶米') || rice < 4) words.push('饭', '粥', '米', '盖饭');
  return words;
}

/** 随机意象词（同一个 rand 可以复跑；每次做菜换一批 → 名字不塌缩） */
export function pickImagery(rng: () => number, form: DishForm, n = 3): string[] {
  const pool = [...IMAGERY_POOLS[form]];
  const out: string[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
  }
  return out;
}

export interface DishBrief {
  score: number;
  form: DishForm;
  quality: string;
  imagery: string[];
  topBase: string[];
  topBonus: string[];
  /** 词表禁词（如云顶米非主力时的「饭」） */
  bannedWords: string[];
  /** 最近用过的菜名（防重复） */
  bannedNames: string[];
}

export function dishBrief(tally: Record<string, number>, score: number, rng: () => number, recentNames: readonly string[] = []): DishBrief {
  let quality = KITCHEN_QUALITY_TIERS[0]!.quality;
  for (const t of KITCHEN_QUALITY_TIERS) if (score >= t.min) quality = t.quality;
  return {
    score,
    form: formOf(tally),
    quality,
    imagery: pickImagery(rng, formOf(tally), 3),
    topBase: rankedBase(tally).slice(0, 2),
    topBonus: rankedBonus(tally).slice(0, 2),
    bannedWords: bannedNameWords(tally),
    bannedNames: [...recentNames].slice(-5),
  };
}

/** 编菜的 prompt（四招都写在这里，模型没有发挥「每次都做饭」的余地） */
export function buildDishPrompt(b: DishBrief): string {
  const names = FORM_NOUNS[b.form].join('、');
  const banned = [...new Set([...b.bannedWords, ...b.bannedNames])];
  return [
    `这一局消掉的食材：${b.topBase.join('、')}${b.topBonus.length ? `；加成块：${b.topBonus.join('、')}` : ''}。`,
    `总分 ${b.score} → 品质「${b.quality}」。${QUALITY_BRIEF[b.quality] ?? ''}`,
    `这一局的做法是「${b.form}」（由加成块决定，不许改成别的做法）：菜名里必须包含 ${names} 里的一个字（写成「xx${FORM_NOUNS[b.form][0]}」这种形式最省事）。`,
    `菜名里至少要用上这几个意象词中的一个：${b.imagery.join('、')}。`,
    banned.length
      ? `菜名不能与这些已经用过的名字相同或高度相似：${banned.join('、')} —— 必须换一个说法，重复就算不合格。`
      : '',
    '主要食材只能从「消掉的食材」里选，消得最多的当主角；不要出现英文、不要用书名号。',
    '不要提到「玩家」「游戏」「系统」这类词。',
    '输出 JSON：dish（菜名）、ingredients（主要食材数组）、desc（一句卖相/香气）、taste（一句口味）、reason（引用上面的消除数字说明为什么这么编）。',
  ].filter(Boolean).join('\n');
}

/**
 * 玩一局料理盘面（贪心 = 近似真人），同时统计**每种块消掉了几个**——
 * 这份 tally 就是编菜的事实来源（消得多的当主角、加成块决定做法）。
 */
export interface CookedBoard {
  board: Board;
  tally: Record<string, number>;
}

export function cookBoard(rng: Rng): CookedBoard {
  const board = newBoard(rng, KITCHEN_BOARD.size, KITCHEN_SET, KITCHEN_BOARD.moves);
  const tally: Record<string, number> = {};
  while (board.movesLeft > 0) {
    const mv = greedySwap(board, rng, KITCHEN_SET);
    if (!mv) break;
    const [x1, y1, x2, y2] = mv;
    // 先摆好、读首个匹配、再摆回去，交给真引擎结算（连锁部分不计入 tally，连锁数另有 chains）
    const tmp = board.cells[y1]![x1]!;
    board.cells[y1]![x1] = board.cells[y2]![x2]!;
    board.cells[y2]![x2] = tmp;
    for (const key of findMatches(board.cells)) {
      const [mx, my] = key.split(',').map(Number);
      const t = board.cells[my!]![mx!];
      if (t) tally[t] = (tally[t] ?? 0) + 1;
    }
    const restore = board.cells[y1]![x1]!;
    board.cells[y1]![x1] = board.cells[y2]![x2]!;
    board.cells[y2]![x2] = restore;
    trySwap(board, x1, y1, x2, y2, rng, KITCHEN_SET);
  }
  return { board, tally };
}

/** 编菜用的 guided JSON schema（食材钉死在盘面 8 种块上，杜绝"编出不存在的食材"） */
export const DISH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    dish: { type: 'string' },
    ingredients: { type: 'array', items: { type: 'string', enum: KITCHEN_TILES }, minItems: 2, maxItems: 4 },
    desc: { type: 'string' },
    taste: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['dish', 'ingredients', 'desc', 'taste', 'reason'],
  additionalProperties: false,
};
