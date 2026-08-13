/**
 * 数值结算函数注册表 (Scene Engine §3.3.7)
 *
 * 机制：导演定值 → 函数算值 → 旁白报结果。
 *   - 导演：自由定这个数（纯娱乐定位，可以"口胡"，导演直接给 delta）
 *   - 函数：忠实执行，把状态真的改了，并返回真实变化供旁白照述
 *   - 旁白：必须引用函数返回的真实结果（after/delta）来写，不得另编数字
 *
 * 关键点：函数不是"拦截/校验导演数字的闸门"，而是"执行导演定的数 + 给旁白权威结果"。
 * 因为数值系统是"写的玩的"，不加严格校验、不锁档位——真正要治的是"旁白报的数 vs 落库
 * 的数不一致"（5万 vs 20）。旁白永远报函数算出的真实值，故天然一致。
 *
 * 函数签名：fn(state, args) -> { newState, changes, narration_hint }
 *   - state     : 当前数值状态 { [name]: number }
 *   - args      : 导演传入的参数（如 { delta: -50000 }，导演自由定）
 *   - newState  : 更新后的数值状态（浅拷贝）
 *   - change    : { name, before, after, delta, reason } 供旁白照述真实数值
 *   - narration_hint: 给旁白的叙述提示（事件怎么戏剧化，不含数字——数字来自 change）
 */
export interface StatsChange {
  name: string;
  before: number;
  after: number;
  delta: number;
  reason: string;
}

export interface StatsFnResult {
  newState: Record<string, number>;
  changes: StatsChange[];
  /** 给旁白的叙述素材（事件由谁/怎么触发的戏剧化描述，不含数字——数字来自 changes） */
  narration_hint?: string;
}

export type StatsFn = (state: Record<string, number>, args: Record<string, unknown>) => StatsFnResult;

/**
 * 导演自由定值：args.delta 就是导演定的数值变化（可有正负，可"口胡"）。
 * 函数忠实执行（应用 delta），并返回真实 before/after/delta 供旁白照述。
 */
export const statsFns: Record<string, StatsFn> = {
  // 打赏/还债 → 减负债（直播还债的经典场景）
  applyDebtChange(state, args) {
    const delta = Number(args.delta ?? 0); // 导演自由定的值（可为负：还债；可为正：又欠了）
    const before = state.debt ?? 0;
    const after = Math.max(0, before + delta); // 负债不落负数
    return {
      newState: { ...state, debt: after },
      changes: [{ name: 'debt', before, after, delta: after - before, reason: String(args.reason ?? '观众打赏/债务变动') }],
      narration_hint: delta < 0 ? '直播间刷了礼物/打赏，债轻了一点' : '直播间又欠了一笔',
    };
  },

  // 礼物/收入 → 加现金（导演自由定加多少）
  applyCashChange(state, args) {
    const delta = Number(args.delta ?? 0);
    const before = state.cash ?? 0;
    const after = before + delta;
    return {
      newState: { ...state, cash: after },
      changes: [{ name: 'cash', before, after, delta: after - before, reason: String(args.reason ?? '收到礼物/收入') }],
      narration_hint: delta >= 0 ? '观众送了礼物，进账了' : '花了一笔钱',
    };
  },

  // 表现好 → 涨热度（幅度由导演依表现自由定）
  applyHeat(state, args) {
    const delta = Number(args.delta ?? 0);
    const before = state.heat ?? 0;
    const after = Math.max(0, before + delta);
    return {
      newState: { ...state, heat: after },
      changes: [{ name: 'heat', before, after, delta: after - before, reason: String(args.reason ?? '表现引发的热度变化') }],
      narration_hint: delta >= 0 ? '直播间的热度在涨' : '直播间的热度降了',
    };
  },
};

/** 校验导演要调用的函数是否存在（函数名是已注册的才算数） */
export function isValidStatsFn(fn: string): boolean {
  return fn in statsFns;
}

/** 建剧本时注册 stats_config 时，校验每个 item 的 fn 是否是已注册函数 */
export function resolveStatsConfig(config: Array<{ name: string; fn?: string; initial?: number }>): { name: string; fn: string }[] {
  return (config ?? [])
    .filter(c => c.fn && isValidStatsFn(c.fn))
    .map(c => ({ name: c.name, fn: c.fn as string }));
}
