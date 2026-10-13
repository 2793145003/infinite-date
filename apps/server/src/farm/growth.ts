/**
 * 生长（纯函数，只依赖入参时间戳——离线/上线都算得对）。
 *
 * 三条规则（星落定）：
 *  1. 现实时间生长，每种作物时长不同。
 *  2. 不摘不会坏：**本模块没有枯死 / 减产逻辑**，成熟后停在那里等你。
 *  3. 浇水只是加速（10%，一次性），不是义务——不做「忘了浇水就惩罚」。
 */
import { chance, type Rng } from './rng';
import { cropByKey, cropName, SEED_KEEP_ON_HARVEST, type Crop } from './crops';

export type PlotStage = 'seed' | 'sprout' | 'growing' | 'ripe';

export interface Plot {
  cropKey: string;
  plantedAt: number;
  /** 浇过水的时间（一次性加速；null = 没浇） */
  wateredAt: number | null;
  /** 这一茬被偷的时间（null = 没被偷过） */
  stolenAt: number | null;
  /** 这块地累计收过几茬 */
  harvests: number;
}

/** 浇水加速比例（只加速，不浇水也不惩罚） */
export const WATER_SPEEDUP = 0.1;

export const HOUR = 3600 * 1000;

export function plant(cropKey: string, at: number): Plot {
  return { cropKey, plantedAt: at, wateredAt: null, stolenAt: null, harvests: 0 };
}

export function cropOf(plot: Plot): Crop {
  return cropByKey(plot.cropKey) ?? { key: plot.cropKey, name: plot.cropKey, hours: 1, yield: 1 };
}

/** 成熟时刻（含浇水加速） */
export function ripeAt(plot: Plot): number {
  const crop = cropOf(plot);
  const base = crop.hours * HOUR;
  return plot.plantedAt + Math.round(base * (plot.wateredAt ? 1 - WATER_SPEEDUP : 1));
}

/** 生长进度 0~1（成熟后恒为 1，不会掉） */
export function progress(plot: Plot, now: number): number {
  const end = ripeAt(plot);
  if (now >= end) return 1;
  if (end <= plot.plantedAt) return 0;
  return Math.max(0, Math.min(1, (now - plot.plantedAt) / (end - plot.plantedAt)));
}

export function stageOf(plot: Plot, now: number): PlotStage {
  const p = progress(plot, now);
  if (p >= 1) return 'ripe';
  if (p < 0.25) return 'seed';
  if (p < 0.6) return 'sprout';
  return 'growing';
}

export function isRipe(plot: Plot, now: number): boolean {
  return now >= ripeAt(plot);
}

/** 浇水：未浇过且未成熟才生效（纯函数，返回新对象） */
export function water(plot: Plot, now: number): Plot {
  if (plot.wateredAt !== null) return plot;
  if (isRipe(plot, now)) return plot;
  return { ...plot, wateredAt: now };
}

export interface HarvestResult {
  crop: Crop;
  /** 收到几个 */
  crops: number;
  /** 留种（30%） */
  seeds: number;
}

/** 收获（须在成熟后调用；调用方负责重置地块） */
export function harvest(plot: Plot, now: number, rng: Rng): HarvestResult {
  const crop = cropOf(plot);
  if (!isRipe(plot, now)) return { crop, crops: 0, seeds: 0 };
  return { crop, crops: crop.yield, seeds: chance(rng, SEED_KEEP_ON_HARVEST) ? 1 : 0 };
}

/** 展示用一句话（也是"熟了"写进临时上下文的素材） */
export function ripenLine(plot: Plot, now: number): string {
  const crop = cropOf(plot);
  const mins = Math.round((now - ripeAt(plot)) / 60000);
  if (mins < 0) return `${cropName(plot.cropKey)}还要 ${Math.round(-mins / 60)} 小时才熟`;
  if (mins < 60) return `${cropName(plot.cropKey)}刚熟（${mins} 分钟前）`;
  return `${cropName(plot.cropKey)}熟了 ${Math.round(mins / 60)} 小时了`;
}
