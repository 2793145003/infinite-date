/**
 * 命名/角色卡库 + 切块 roll：世界生成时的生活化角色素材。
 *
 * 思路（跑团随机卡）：每个 NPC roll 一整张卡——名字 + 性别 + 年龄 + 职业 + 性格特征，
 *   LLM 照着这张卡演绎，多样性从名字扩散到整个人物。
 *
 * 三个已踩的坑（已修）：
 *   1. 独立 roll 导致性别错配（"三娘/男"）→ 名字分男女库，先 roll 性别再从对应库取名。
 *   2. 职业带性别词（"蚕娘/绣娘/媒婆"）→ 职业库去性别化，只留中性职业。
 *   3. 名字库"老X"占 50%，LLM 选核心对象（老人形象）必然收敛 → 压缩"老X"比例。
 */
import type { Theme } from './world-theme';
import { THEME_NAME_POOLS } from './theme-name-pools';
import { THEME_PLACE_POOLS, THEME_ROLE_POOLS } from './theme-world-pools';

function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

const GENDERS = ['男', '女'] as const;
const AGES = ['少年', '青年', '中年', '老年'] as const;

const TRAITS = [
  '沉默寡言', '急性子', '爱说大话', '怕事', '热心肠', '好酒', '瞎了一只眼', '瘸腿',
  '缺了一颗门牙', '白发苍苍', '驼背', '爱唱歌', '疑神疑鬼', '吝啬', '豪爽', '腼腆',
  '泼辣', '倔强', '胆小如鼠', '见义勇为', '爱占小便宜', '健忘', '爱唠叨', '手艺精巧',
  '力大如牛', '病恹恹', '眼神锐利', '总戴着头巾', '双手布满老茧', '说话结巴',
  '爱哭', '爱笑', '独来独往', '人缘极好', '记仇', '心软', '嘴硬', '贪吃',
  '失眠', '怕黑', '迷信', '虔诚', '爱养鸟', '会点医术', '当过兵', '识字不多',
  '嗓门大', '走路没声', '总揣着个小物件', '说话爱比划', '爱下棋', '烟不离手',
] as const;

export interface NpcCard {
  name: string;
  gender: string;
  age: string;
  role: string;
  traits: string[];
}

export interface WorldCards {
  npcs: NpcCard[];
  places: string[];
}

/** 切块取（seq 切块，越界回绕，保证不空） */
function block<T>(arr: readonly T[], seq: number, k: number): T[] {
  const start = (seq * k) % arr.length;
  const out: T[] = [];
  for (let i = 0; i < k; i++) out.push(arr[(start + i) % arr.length]!);
  return out;
}

/**
 * roll 一整组世界卡片：N 张 NPC 卡（名字+性别+年龄+职业+特征）+ 地名。
 * 性别先 roll，名字从对应性别库 + 中性库取，保证名字性别一致。
 * 每个维度独立洗牌（salt 区分）+ seq 切块，同 playerId 连续生成不重叠。
 */
export function rollWorldCards(
  playerId: string,
  seq: number,
  theme: Theme,
  opts?: { npcs?: number; places?: number },
): WorldCards {
  const N = opts?.npcs ?? 6, P = opts?.places ?? 6;

  const pool = THEME_NAME_POOLS[theme];
  const maleNames = shuffle(pool.male, seededRng(playerId + '|mnames'));
  const femaleNames = shuffle(pool.female, seededRng(playerId + '|fnames'));
  const roles = shuffle(THEME_ROLE_POOLS[theme], seededRng(playerId + '|roles'));
  const ages = shuffle(AGES, seededRng(playerId + '|ages'));
  const genders = shuffle(GENDERS, seededRng(playerId + '|gender'));
  const traits = shuffle(TRAITS, seededRng(playerId + '|traits'));

  const npcs: NpcCard[] = [];
  for (let i = 0; i < N; i++) {
    const idx = seq * N + i;
    const gender = genders[idx % 2]!;
    const namePool = gender === '男' ? maleNames : femaleNames;
    npcs.push({
      name: namePool[idx % namePool.length]!,
      gender,
      age: ages[idx % 4]!,
      role: roles[idx % roles.length]!,
      traits: [traits[(idx * 2) % traits.length]!, traits[(idx * 2 + 1) % traits.length]!],
    });
  }

  return {
    npcs,
    places: block(shuffle(THEME_PLACE_POOLS[theme], seededRng(playerId + '|places')), seq, P),
  };
}

/** 渲染成 prompt 段落：NPC 卡 + 地名 */
export function renderWorldCards(cards: WorldCards): string {
  const npcLines = cards.npcs
    .map((c) => `- ${c.name}（${c.gender}，${c.age}，${c.role}，${c.traits.join('、')}）`)
    .join('\n');
  return [
    `【NPC 随机卡】下面每张卡是一个 NPC 的底牌（名字/性别/年龄/职业/特征已定好）。你从里面选 3-5 张，赋上角色定位（role）并写一句话人设（persona），保留卡里的名字、性别、年龄、职业、特征，不要改：`,
    npcLines,
    `【地名】世界名和地标从下面候选里选，不要自造：${cards.places.join('、')}`,
  ].join('\n');
}
