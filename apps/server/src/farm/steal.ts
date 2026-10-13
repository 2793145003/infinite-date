/**
 * 偷菜（纯函数）。
 *
 * 星落定的规矩：
 *  - 只有玩家偷男主的菜；**没有任何人会偷玩家的菜**（玩家侧没有失窃机制）。
 *  - 他在家 → 今天不好下手（软钉子，不做惩罚）。
 *  - 每茬只能偷一次、每个男主每天上限 1 次（防刷）。
 *  - 偷走的份量 ≈ 1/3，附赠种子的概率 25%。
 *  - 偷了就是「他的收成变少了」：进台账 + 进记忆，**不告诉他是在谁偷的**。
 */
import { chance, type Rng } from './rng';
import { SEED_FROM_STEAL, cropName } from './crops';

export type StealBlock = '他这块地还没熟' | '他在院子里，今天不好下手' | '这一茬已经偷过了' | '今天已经偷过他的了';

export interface StealInput {
  /** 这块地成熟后还有多少可摘 */
  ripeCount: number;
  /** 他现在在不在家（行程系统给） */
  atHome: boolean;
  /** 这一茬是否已经被偷过 */
  stolenThisCycle: boolean;
  /** 今天是否已经偷过这个男主 */
  stolenTodayByPlayer: boolean;
}

export function canSteal(input: StealInput): StealBlock | null {
  if (input.ripeCount <= 0) return '他这块地还没熟';
  if (input.atHome) return '他在院子里，今天不好下手';
  if (input.stolenThisCycle) return '这一茬已经偷过了';
  if (input.stolenTodayByPlayer) return '今天已经偷过他的了';
  return null;
}

export interface StealResult {
  ok: boolean;
  blockedBy?: StealBlock;
  /** 偷走几个 */
  taken: number;
  /** 顺手拿到的种子数 */
  seeds: number;
  cropName: string;
}

/** 一次偷菜 */
export function steal(cropKey: string, input: StealInput, rng: Rng): StealResult {
  const blocked = canSteal(input);
  if (blocked) return { ok: false, blockedBy: blocked, taken: 0, seeds: 0, cropName: cropName(cropKey) };
  return {
    ok: true,
    taken: Math.max(1, Math.floor(input.ripeCount / 3)),
    seeds: chance(rng, SEED_FROM_STEAL) ? 1 : 0,
    cropName: cropName(cropKey),
  };
}

export interface TheftRecord {
  at: number;
  cropName: string;
  taken: number;
}

export interface TheftLedger {
  /** 被偷过几次 */
  times: number;
  /** 一共少了多少个 */
  totalLost: number;
  /** 按作物统计 */
  byCrop: Record<string, number>;
}

/** 失窃台账（只有数字和作物名，没有任何「是谁」的信息——这是不指控玩家的前提） */
export function ledger(records: readonly TheftRecord[]): TheftLedger {
  const byCrop: Record<string, number> = {};
  let totalLost = 0;
  for (const r of records) {
    byCrop[r.cropName] = (byCrop[r.cropName] ?? 0) + r.taken;
    totalLost += r.taken;
  }
  return { times: records.length, totalLost, byCrop };
}
