// 二消小游戏（布偶餐厅式）—— 修仙五行盘面。
//
// 引擎本身已**参数化**搬到 src/lib/match2.ts（TileSet 作为入参数据），于是同一套引擎能同时服务：
//   - 修仙衍生世界：本文件（金木水火土 + 灵石/仙晶/丹炉）
//   - 「共享菜园」料理：farm/kitchen.ts（星光果/云顶米/… + 老火高汤/猛火/秘制酱）
// 本文件 = **五行盘面的数据 + 兼容层**：对外签名与搬到 lib 之前完全一致，
// 调用点（routes/world.ts / world/runner.ts / world-craft / world-match2 测试）零改动。
//
// 盘面块数与权重是实测调出来的（勿改）：
//   纯五行 5 种连锁仍爆炸（单步最高 70 层）；五行 5 + 加成 3 = 8 种
//   把连锁压到「单步最高 ~19 层、p50 仅 7 层」的「偶尔大爆发」，分数 max ~555 可控。
//   关键不是禁用连锁，而是用更多块类型降低自然连概率（星落：金木水火土和各种加成）。

import {
  autoPlay as autoPlayGeneric,
  findMatches,
  hasValidMove,
  findValidSwap,
  newBoard as newBoardGeneric,
  qualityFromScore,
  subsetSet,
  trySwap as trySwapGeneric,
} from '../lib/match2';
import type { Board as GenericBoard, QualityTier, SwapOutcome, TileSet } from '../lib/match2';
import type { Rng } from './rng';
import type { Quality } from './types';

/** 盘面块类型：五行基础块 + 加成块（独立于物品 ItemType，纯小游戏层） */
export type TileType = '金' | '木' | '水' | '火' | '土' | '灵石' | '仙晶' | '丹炉';

export const ELEMENTS: readonly TileType[] = ['金', '木', '水', '火', '土'];
export const BONUS_TILES: readonly TileType[] = ['灵石', '仙晶', '丹炉'];
export const ALL_TILES: readonly TileType[] = [...ELEMENTS, ...BONUS_TILES];

/** 每块分值：五行 1，加成块更高（灵石 3 / 丹炉 2 / 仙晶 8 稀有高分） */
const TILE_SCORE: Record<TileType, number> = { 金: 1, 木: 1, 水: 1, 火: 1, 土: 1, 灵石: 3, 仙晶: 8, 丹炉: 2 };
/** 生成权重：五行各 1，加成块稀有 */
const TILE_WEIGHTS: Record<TileType, number> = { 金: 1, 木: 1, 水: 1, 火: 1, 土: 1, 灵石: 0.6, 仙晶: 0.25, 丹炉: 0.4 };

/** 修仙盘面（丹炉 = 消除时清同行同列） */
export const WUXING_SET: TileSet = {
  types: ALL_TILES,
  score: TILE_SCORE,
  weights: TILE_WEIGHTS,
  clearLine: '丹炉',
};

/** 旧阈值（衍生世界盘面校准）：<200 下品 / <280 中品 / <380 上品 / 其余极品 */
export const WUXING_QUALITY_TIERS: readonly QualityTier[] = [
  { min: 0, quality: '下品' },
  { min: 200, quality: '中品' },
  { min: 280, quality: '上品' },
  { min: 380, quality: '极品' },
];

export type Board = GenericBoard;
export type { SwapOutcome };

/** 生成初始盘面（只在给定 types 子集上玩，分值/权重沿用五行表） */
export function newBoard(rng: Rng, size: number, types: readonly TileType[], movesLeft: number): Board {
  return newBoardGeneric(rng, size, subsetSet(WUXING_SET, types), movesLeft);
}

/** 交换相邻两格；若不形成消除则换回（valid=false） */
export function trySwap(
  board: Board, x1: number, y1: number, x2: number, y2: number, rng: Rng, types: readonly TileType[],
): SwapOutcome {
  return trySwapGeneric(board, x1, y1, x2, y2, rng, subsetSet(WUXING_SET, types));
}

/** 自动玩一局（runner/离线演示用） */
export function autoPlay(board: Board, rng: Rng, types: readonly TileType[]): Board {
  return autoPlayGeneric(board, rng, subsetSet(WUXING_SET, types));
}

/** 分数 → 品质（无失败：任意分数都出成品；阈值跑样本后校准） */
export function scoreToQuality(score: number): Quality {
  return qualityFromScore(score, WUXING_QUALITY_TIERS) as Quality;
}

export { findMatches, hasValidMove, findValidSwap };
