// 走格子地图 —— 大方格套小方格。
// region = 大区域（门派/秘境/坊市/禁地），cell = 区域内的小地点（洞府/丹房/演武场...）。
// 物理上是一张连续的 size×size 全局网格（小格），region 只是「命名分组」：
// 走到区域边界外一格 = 跨入相邻区域，天然支持「离开本门派去别处」。
// loc 为扁平坐标 0..size²-1：loc = gy*size + gx。

import type { Rng } from './rng';

export interface Pos {
  gx: number;
  gy: number;
}

// 地图存档（JSON-safe）：区域/小格命名是构造时由 rng 掷出的，必须落库才能精确恢复
export interface MapSave {
  regions: number;
  cells: number;
  regionNames: string[];
  cellNames: string[];
}

const REGION_POOL = [
  '青云门', '落霞秘境', '坊市', '万毒教', '天剑门', '百草谷',
  '散修盟', '血煞宗', '无涯海', '葬剑谷', '合欢宗', '太华派',
  '灵虚洞天', '幽冥渊', '丹霞山', '天机阁',
] as const;

const CELL_POOL = [
  '洞府', '丹房', '剑冢', '灵田', '集市', '藏经阁', '演武场',
  '后山', '药园', '矿脉', '灵泉', '秘境', '大殿', '山门', '禁地', '峰顶',
] as const;

export class WorldMap {
  readonly regions: number; // 大方格边长 R
  readonly cells: number;   // 每区域小方格边长 C
  readonly size: number;    // 全局边长 = R*C（总格子 = size²）
  private regionNames: string[];
  private cellNames: string[];

  constructor(rng: Rng, regions: number, cells: number, names?: MapSave) {
    this.regions = regions;
    this.cells = cells;
    this.size = regions * cells;
    if (names) {
      // 存档恢复：沿用落库时的区域/小格命名，不再重掷随机
      this.regionNames = names.regionNames;
      this.cellNames = names.cellNames;
      return;
    }
    const rs = [...REGION_POOL].sort(() => rng() - 0.5);
    this.regionNames = Array.from({ length: regions * regions }, (_, i) => rs[i % rs.length]!);
    const cs = [...CELL_POOL].sort(() => rng() - 0.5);
    this.cellNames = Array.from({ length: cells * cells }, (_, i) => cs[i % cs.length]!);
  }

  serialize(): MapSave {
    return {
      regions: this.regions,
      cells: this.cells,
      regionNames: [...this.regionNames],
      cellNames: [...this.cellNames],
    };
  }

  static restore(data: MapSave): WorldMap {
    return new WorldMap(() => 0, data.regions, data.cells, data);
  }

  totalCells(): number {
    return this.size * this.size;
  }

  pos(loc: number): Pos {
    return { gx: loc % this.size, gy: Math.floor(loc / this.size) };
  }

  flat(p: Pos): number {
    return p.gy * this.size + p.gx;
  }

  regionOf(loc: number): number {
    const p = this.pos(loc);
    return Math.floor(p.gy / this.cells) * this.regions + Math.floor(p.gx / this.cells);
  }

  regionName(loc: number): string {
    return this.regionNames[this.regionOf(loc)] ?? '无名之地';
  }

  /** 位置 → 「区域·小格」名，如「青云门·丹房」 */
  name(loc: number): string {
    const p = this.pos(loc);
    const cx = p.gx % this.cells;
    const cy = p.gy % this.cells;
    const cell = this.cellNames[cy * this.cells + cx] ?? '野地';
    return `${this.regionName(loc)}·${cell}`;
  }

  /** 四邻（曼哈顿邻接），含跨区域 */
  neighbors(loc: number): number[] {
    const p = this.pos(loc);
    const out: number[] = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    for (const [dx, dy] of dirs) {
      const gx = p.gx + dx;
      const gy = p.gy + dy;
      if (gx >= 0 && gx < this.size && gy >= 0 && gy < this.size) {
        out.push(this.flat({ gx, gy }));
      }
    }
    return out;
  }

  /** 随机走一步到相邻小格（跨区域 = 越过区域边界） */
  step(rng: Rng, loc: number): number {
    const ns = this.neighbors(loc);
    return ns[Math.floor(rng() * ns.length)] ?? loc;
  }

  randomLoc(rng: Rng): number {
    return Math.floor(rng() * this.totalCells());
  }
}
