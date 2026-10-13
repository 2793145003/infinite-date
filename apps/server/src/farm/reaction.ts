/**
 * 被偷之后：**只让他知道「收成变少了」，永远不告诉他是玩家偷的**（星落定）。
 *
 * 这个模块负责：
 *  1. 性格分档（从真实人设推，纯规则、可测）
 *  2. 构造给模型的「事实」文本（事实里没有「玩家」两个字，也不指控）
 *  3. 按行程概率决定发不发朋友圈（沿用产品既有的意愿机制：行程变更时摇骰）
 *  4. 禁词表 + 兜底文案（模型挂了也不出戏）
 */
import type { Rng } from './rng';
import type { PersonaLite } from './crops';

export type Temperament = '粗心型' | '多疑型' | '腹黑型' | '直球型';

const TEMPERAMENT_RULES: ReadonlyArray<{ t: Temperament; words: readonly string[] }> = [
  { t: '多疑型', words: ['多疑', '警惕', '占有', '控制', '谨慎', '审视', '敏感', '不放'] },
  { t: '腹黑型', words: ['腹黑', '城府', '算计', '谋', '布局', '不动声色', '隐忍', '克制'] },
  { t: '直球型', words: ['直白', '直球', '坦率', '直率', '急躁', '爽快', '直来直去'] },
];

/** 性格分档（无匹配 → 粗心型：最温和的一档，默认不伤人） */
export function temperamentOf(data: PersonaLite): Temperament {
  const hay = [data.personality, data.drive, data.quirks, data.likes]
    .map((v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)))
    .join(' ');
  for (const rule of TEMPERAMENT_RULES) {
    for (const w of rule.words) if (hay.includes(w)) return rule.t;
  }
  return '粗心型';
}

/** 给模型的写作要求（每种性格一句） */
export const TEMPERAMENT_BRIEF: Record<Temperament, string> = {
  粗心型: '你有点马虎，容易先怀疑自己记错了（「可能是我数错了」），不太会想到有人来拿。',
  多疑型: '你记得很清楚。你倾向于陈述事实、不下结论（「我数过。就是少了。」）。',
  腹黑型: '你心里有猜测但不点破，可以半真半假地提到别人、或者轻描淡写地暗示。',
  直球型: '你会问，但问得很含糊（「你今天……有没有路过我那儿？」），不会直接指控。',
};

export interface TheftFacts {
  characterName: string;
  cropName: string;
  /** 少了几个 */
  lost: number;
  /** 昨天还有几个（可缺） */
  before?: number;
  /** 这是最近第几次少了 */
  times: number;
  temperament: Temperament;
}

/**
 * 事实文本 —— 写朋友圈的 contextHint。
 * 关键：**只说「少了」，不说「谁」**；并显式禁止说出玩家/游戏这类词。
 */
export function stolenHint(f: TheftFacts): string {
  return [
    `${f.characterName}今早去院子，发现${f.cropName}少了 ${f.lost} 个${f.before != null ? `（昨天还有 ${f.before} 个）` : ''}。`,
    f.times > 1 ? `这已经是最近第 ${f.times} 次少了。` : '这是第一次少。',
    '你不知道是谁拿的，也不确定是不是人（可能是野猫、也可能是哪个顺手的人）。',
    TEMPERAMENT_BRIEF[f.temperament],
    '写一条朋友圈：只说自己的收成变少了，可以怀疑、可以提到别人，但不要直接指控任何人，也不要提到「玩家」「游戏」这类词。不要长篇大论，不要说教、不要讲道理、不要训人。',
  ].join('');
}

/**
 * 发不发朋友圈：按行程概率。
 * 沿用产品既有机制——他行程变更时累积「发朋友圈意愿」（0~100），这里摇骰决定这次发不发。
 */
export function shouldPostOnScheduleChange(momentUrge: number, rng: Rng): boolean {
  if (momentUrge <= 0) return false;
  return rng() * 100 < momentUrge;
}

/** 模型没出话时的兜底（也得像人话，且不指控） */
export function fallbackLine(t: Temperament, cropName: string): string {
  switch (t) {
    case '多疑型': return `我数过。${cropName}就是少了。`;
    case '腹黑型': return `${cropName}少了几颗。最近院子里总有人路过。`;
    case '直球型': return `${cropName}又少了。……你今天有没有路过我那儿？`;
    default: return `奇怪，我种的${cropName}好像越来越少了……`;
  }
}

/** 禁词：出现任何一个都算跑偏，直接重生成或兜底 */
export const FORBIDDEN_WORDS: readonly string[] = ['玩家', '游戏', '系统', '数值', '好感度', '农场', 'AI', '剧本', 'NPC'];

export function hasForbidden(text: string): boolean {
  return FORBIDDEN_WORDS.some((w) => text.includes(w));
}
