/**
 * 极简确定性随机（农场模块自带）。
 *
 * 为什么不复用 world/rng.ts：农场要能**独立可测**、不依赖已冻结的衍生世界模块。
 * 15 行 mulberry32 自带一份比引一条跨模块依赖更干净（两边 Rng 都是 () => [0,1)，结构化兼容）。
 */
export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
