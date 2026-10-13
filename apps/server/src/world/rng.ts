// 可复现伪随机数（mulberry32）—— 演化必须可复现，否则无法离线验证

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 带状态存取的 mulberry32：世界存档序列化时把内部状态（一个 uint32）落库，
// 恢复后从同一状态继续，保证「恢复后继续演化」与「从未中断」的随机序列完全一致。
export interface RngState {
  rng: Rng;
  getState: () => number;
  setState: (state: number) => void;
}

export function makeRngState(seed: number): RngState {
  let a = seed >>> 0;
  return {
    rng: () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    getState: () => a,
    setState: (state: number) => {
      a = state >>> 0;
    },
  };
}

// [0, n) 整数
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

// 从数组随机取一个元素（非空数组）
export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[randInt(rng, arr.length)]!;
}

// 按权重随机取索引（weights 非负，和需 > 0）
export function pickWeighted(rng: Rng, weights: number[]): number {
  let sum = 0;
  for (const w of weights) sum += w;
  let r = rng() * sum;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

// 以概率 p 命中
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
