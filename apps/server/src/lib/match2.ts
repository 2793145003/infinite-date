// 二消小游戏引擎（通用版）—— 纯逻辑，前端可直接复用。
//
// 原本写死在 world/match2.ts 的修仙五行盘面；这里把「块定义」参数化成数据（TileSet），
// 于是同一套引擎可以服务两个玩法：
//   - 修仙衍生世界：金木水火土 + 灵石/仙晶/丹炉（world/match2.ts 里的 WUXING_SET，行为不变）
//   - 「共享菜园」料理：星光果/云顶米/晨露菜/烈火椒/岩纹肉 + 老火高汤/猛火/秘制酱（farm/kitchen.ts）
//
// 规则（两个玩法共用，不改）：交换相邻两格，形成 ≥2 个相同类型水平/垂直相连即消除，
// 掉落补充，连锁消除。**无失败**：步数用完 / 任意分数都出成品，分数只决定品质。
//
// 盘面块数与权重是实测调出来的（world/match2.ts 原注释）：
//   纯 5 种基础块时连锁会爆炸（单步最高 70 层）；5 基础 + 3 加成 = 8 种才压成
//   「偶尔大爆发」（单步最高 ~19 层、p50 仅 7 层、分数 max ~555）。
//   → **换皮不要改块数与权重**，否则连锁分布要重新校准。

/** 随机源（与 world/rng.ts 的 Rng 同形，结构化兼容：() => [0,1)） */
export type Rng = () => number;

/** 盘面块（字符串标识，具体含义由各自的 TileSet 决定） */
export type Tile = string;

export interface TileSet {
  /** 参与生成的块（顺序 = 权重表的查找顺序） */
  types: readonly Tile[];
  /** 每块分值（缺省 1） */
  score: Record<string, number>;
  /** 每块生成权重（缺省 1，越小越稀有） */
  weights: Record<string, number>;
  /** 消除时清掉同行同列的块（修仙=丹炉 / 料理=猛火） */
  clearLine?: Tile;
}

export interface Board {
  size: number;
  cells: (Tile | null)[][];  // cells[y][x]，null = 空（掉落中）
  score: number;
  movesLeft: number;
}

export interface SwapOutcome {
  valid: boolean;   // 交换是否形成消除
  gained: number;   // 本次消除总块数（含连锁）
  score: number;    // 本次得分（含连锁，含加成块加分）
  chains: number;   // 连锁层数
}

export interface QualityTier {
  /** 达到该分数即入此档（从低到高排列） */
  min: number;
  quality: string;
}

/** 派生一份「只在 types 子集上玩」的 TileSet（分值/权重沿用原表） */
export function subsetSet(set: TileSet, types: readonly Tile[]): TileSet {
  return { ...set, types };
}

/** 按权重从 types 里随机取一块 */
function weightedPick(rng: Rng, set: TileSet, types: readonly Tile[]): Tile {
  let total = 0;
  for (const t of types) total += set.weights[t] ?? 1;
  let r = rng() * total;
  for (const t of types) {
    r -= set.weights[t] ?? 1;
    if (r < 0) return t;
  }
  return types[types.length - 1]!;
}

/** 找所有 ≥2 连（水平/垂直相邻同类型，含加成块） */
export function findMatches(cells: (Tile | null)[][]): Set<string> {
  const size = cells.length;
  const matched = new Set<string>();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = cells[y]![x];
      const b = cells[y]![x + 1];
      if (a && a === b) { matched.add(`${x},${y}`); matched.add(`${x + 1},${y}`); }
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size; x++) {
      const a = cells[y]![x];
      const b = cells[y + 1]![x];
      if (a && a === b) { matched.add(`${x},${y}`); matched.add(`${x},${y + 1}`); }
    }
  }
  return matched;
}

function swapCells(cells: (Tile | null)[][], x1: number, y1: number, x2: number, y2: number): void {
  const tmp = cells[y1]![x1]!;
  cells[y1]![x1] = cells[y2]![x2]!;
  cells[y2]![x2] = tmp;
}

/** 是否存在一步交换能消（防死局） */
export function hasValidMove(cells: (Tile | null)[][]): boolean {
  const size = cells.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const x2 = x + dx;
        const y2 = y + dy;
        if (x2 >= size || y2 >= size) continue;
        swapCells(cells, x, y, x2, y2);
        const ok = findMatches(cells).size > 0;
        swapCells(cells, x, y, x2, y2);
        if (ok) return true;
      }
    }
  }
  return false;
}

/** 生成初始盘面：无自然 ≥2 连，且至少有一处可消 */
export function newBoard(rng: Rng, size: number, set: TileSet, movesLeft: number): Board {
  const types = set.types;
  let cells: (Tile | null)[][];
  do {
    cells = [];
    for (let y = 0; y < size; y++) {
      const row: (Tile | null)[] = [];
      for (let x = 0; x < size; x++) {
        let t = weightedPick(rng, set, types);
        const left = x > 0 ? row[x - 1] : null;
        const up = y > 0 ? cells[y - 1]![x] : null;
        let guard = 0;
        while ((t === left || t === up) && guard++ < 16) {
          t = weightedPick(rng, set, types);
        }
        row.push(t);
      }
      cells.push(row);
    }
  } while (!hasValidMove(cells));
  return { size, cells, score: 0, movesLeft };
}

/** 顶部补充：避开四邻（左/上/右/下），尽量不引入新连 */
function refill(rng: Rng, cells: (Tile | null)[][], set: TileSet): void {
  const types = set.types;
  const size = cells.length;
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (cells[y]![x] === null) {
        const left = x > 0 ? cells[y]![x - 1] : null;
        const up = y > 0 ? cells[y - 1]![x] : null;
        const right = x + 1 < size ? cells[y]![x + 1] : null;
        const down = y + 1 < size ? cells[y + 1]![x] : null;
        const safe = types.filter((t) => t !== left && t !== up && t !== right && t !== down);
        if (safe.length > 0) {
          cells[y]![x] = weightedPick(rng, set, safe);
        } else {
          const c2 = types.filter((t) => t !== left && t !== up);
          cells[y]![x] = weightedPick(rng, set, c2.length > 0 ? c2 : types);
        }
      }
    }
  }
}

/** 连锁结算：消除 →（clearLine 块清行列）→ 掉落 → 补充，循环直到无连 */
function resolveCascade(rng: Rng, cells: (Tile | null)[][], set: TileSet): { gained: number; score: number; chains: number } {
  const size = cells.length;
  const clearLine = set.clearLine;
  let gained = 0;
  let score = 0;
  let chains = 0;
  for (;;) {
    const matches = findMatches(cells);
    if (matches.size === 0) break;
    chains++;
    // 清行列效果：消除时把同行同列一起炸掉（快照遍历，扩展的行列不递归触发）
    if (clearLine) {
      for (const key of [...matches]) {
        const [x, y] = key.split(',').map(Number);
        if (cells[y!]![x!] === clearLine) {
          for (let i = 0; i < size; i++) { matches.add(`${i},${y}`); matches.add(`${x},${i}`); }
        }
      }
    }
    // 消除 + 累分
    for (const key of matches) {
      const [x, y] = key.split(',').map(Number);
      const t = cells[y!]![x!];
      if (t == null) continue;  // 清行列扩展可能与既有匹配重叠，防御性跳过
      score += set.score[t] ?? 1;
      cells[y!]![x!] = null;
    }
    gained += matches.size;
    // 重力掉落
    for (let x = 0; x < size; x++) {
      let write = size - 1;
      for (let y = size - 1; y >= 0; y--) {
        if (cells[y]![x] !== null) {
          if (write !== y) { cells[write]![x] = cells[y]![x]!; cells[y]![x] = null; }
          write--;
        }
      }
    }
    refill(rng, cells, set);
  }
  return { gained, score, chains };
}

/** 交换相邻两格；若不形成消除则换回（valid=false） */
export function trySwap(board: Board, x1: number, y1: number, x2: number, y2: number, rng: Rng, set: TileSet): SwapOutcome {
  if (Math.abs(x1 - x2) + Math.abs(y1 - y2) !== 1) return { valid: false, gained: 0, score: 0, chains: 0 };
  const cells = board.cells;
  swapCells(cells, x1, y1, x2, y2);
  if (findMatches(cells).size === 0) {
    swapCells(cells, x1, y1, x2, y2);
    return { valid: false, gained: 0, score: 0, chains: 0 };
  }
  const { gained, score, chains } = resolveCascade(rng, cells, set);
  board.score += score;
  board.movesLeft--;
  return { valid: true, gained, score, chains };
}

/** 找一个合法交换 */
export function findValidSwap(board: Board, rng: Rng): [number, number, number, number] | null {
  const size = board.size;
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = Math.floor(rng() * size);
    const y = Math.floor(rng() * size);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const [dx, dy] = dirs[Math.floor(rng() * dirs.length)]!;
    const x2 = x + dx;
    const y2 = y + dy;
    if (x2 < 0 || y2 < 0 || x2 >= size || y2 >= size) continue;
    swapCells(board.cells, x, y, x2, y2);
    const ok = findMatches(board.cells).size > 0;
    swapCells(board.cells, x, y, x2, y2);
    if (ok) return [x, y, x2, y2];
  }
  return null;
}

/** 尽量挑「消得多」的一步（离线校准/演示用的近似玩家；真人比随机交换强得多） */
export function greedySwap(board: Board, rng: Rng, set: TileSet): [number, number, number, number] | null {
  const size = board.size;
  let best: [number, number, number, number] | null = null;
  let bestScore = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        const x2 = x + dx;
        const y2 = y + dy;
        if (x2 >= size || y2 >= size) continue;
        swapCells(board.cells, x, y, x2, y2);
        let gain = 0;
        for (const key of findMatches(board.cells)) {
          const [mx, my] = key.split(',').map(Number);
          const t = board.cells[my!]![mx!];
          if (t) gain += set.score[t] ?? 1;
        }
        swapCells(board.cells, x, y, x2, y2);
        if (gain > bestScore) { bestScore = gain; best = [x, y, x2, y2]; }
      }
    }
  }
  if (best) return best;
  return findValidSwap(board, rng);
}

/** 自动玩一局（随机合法交换；演示/兜底用） */
export function autoPlay(board: Board, rng: Rng, set: TileSet): Board {
  while (board.movesLeft > 0) {
    const mv = findValidSwap(board, rng);
    if (!mv) break;
    trySwap(board, mv[0], mv[1], mv[2], mv[3], rng, set);
  }
  return board;
}

/** 自动玩一局（贪心：每步挑消得最多的；用于离线校准阈值） */
export function greedyPlay(board: Board, rng: Rng, set: TileSet): Board {
  while (board.movesLeft > 0) {
    const mv = greedySwap(board, rng, set);
    if (!mv) break;
    trySwap(board, mv[0], mv[1], mv[2], mv[3], rng, set);
  }
  return board;
}

/** 分数 → 品质（无失败：任意分数都出成品；阈值必须按各自盘面跑样本校准） */
export function qualityFromScore(score: number, tiers: readonly QualityTier[]): string {
  let out = tiers[0]?.quality ?? '下品';
  for (const t of tiers) {
    if (score >= t.min) out = t.quality;
  }
  return out;
}

/** 分档阈值取「贪心玩法的分数分位」——跑一局样本集拿分位 */
export function calibrateTiers(scores: readonly number[], names: readonly [string, string, string, string]): QualityTier[] {
  const s = [...scores].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] ?? 0;
  return [
    { min: 0, quality: names[0] },
    { min: at(0.25), quality: names[1] },
    { min: at(0.5), quality: names[2] },
    { min: at(0.85), quality: names[3] },
  ];
}
