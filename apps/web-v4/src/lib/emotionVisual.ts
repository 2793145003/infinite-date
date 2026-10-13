/**
 * 心绪的视觉映射 —— 花瓣图（EmotionModal）与头像光环（SmsScreen）共用。
 * 单一来源：改配色或阈值只需要动这个文件。
 */

/** 花瓣顺序（与后端 EMOTIONS 一致，最上方顺时针） */
export const EMOTION_ORDER = [
  { key: 'joy', cn: '愉悦' },
  { key: 'desire', cn: '欲望' },
  { key: 'panic', cn: '慌乱' },
  { key: 'loss', cn: '失落' },
  { key: 'grievance', cn: '委屈' },
  { key: 'anger', cn: '愤怒' },
  { key: 'possessiveness', cn: '占有欲' },
  { key: 'tenderness', cn: '怜爱' },
] as const;

/** 每种心绪一个颜色（深色底上都要够亮，不发灰） */
export const PETAL_COLORS: Record<string, string> = {
  joy: '#f6c453', // 愉悦 · 琥珀金
  desire: '#ef5f8b', // 欲望 · 玫红
  panic: '#f2844e', // 慌乱 · 珊瑚橙
  loss: '#6f9bd1', // 失落 · 雾蓝
  grievance: '#b18cf0', // 委屈 · 淡紫
  anger: '#ec5b53', // 愤怒 · 朱红
  possessiveness: '#a259d9', // 占有欲 · 紫罗兰
  tenderness: '#f7a8c4', // 怜爱 · 粉
};

/** 常规满格比例：100 分只画到 0.85R，给「爆表」留出空间 */
export const MAX_RATIO = 0.85;
/** 到这一分算爆表：花瓣冲出常规框、发光、带火花 */
export const BURST_FROM = 88;
/** 到这一分才在头像周围亮起心绪光环（够明显才给，日常寒暄不闪） */
export const GLOW_FROM = 70;

export type EmotionLike = Record<string, number>;

/** 最强的那一维 */
export function topOf(e?: EmotionLike | null): { key: string; cn: string; value: number } | null {
  if (!e) return null;
  let best: { key: string; cn: string; value: number } | null = null;
  for (const def of EMOTION_ORDER) {
    const v = Number(e[def.key] ?? 0);
    if (!best || v > best.value) best = { key: def.key, cn: def.cn, value: v };
  }
  return best;
}

/** 0-1 → 两位十六进制透明度 */
const hexAlpha = (a: number): string =>
  Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, '0');

/**
 * 头像光环：颜色＝最强心绪的颜色，强度越足环越厚、辉光越散。
 * 低于 GLOW_FROM 返回 undefined（不打扰日常）。
 */
export function glowStyle(e?: EmotionLike | null): { boxShadow: string } | undefined {
  const top = topOf(e);
  if (!top || top.value < GLOW_FROM) return undefined;
  const t = Math.min(1, (top.value - GLOW_FROM) / (100 - GLOW_FROM));
  const color = PETAL_COLORS[top.key] ?? '#e88aa6';
  const ring = (1.5 + t * 2).toFixed(1);
  const blur = (5 + t * 13).toFixed(1);
  const a1 = hexAlpha(0.5 + t * 0.45);
  const a2 = hexAlpha(0.3 + t * 0.5);
  return { boxShadow: `0 0 0 ${ring}px ${color}${a1}, 0 0 ${blur}px ${color}${a2}` };
}
