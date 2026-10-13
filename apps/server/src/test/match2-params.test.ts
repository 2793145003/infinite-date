/**
 * 二消引擎参数化后的回归（引擎从 world/ 搬到 lib/，块定义变成数据）。
 *
 * 两层保证：
 *  1. 修仙盘面（world/match2.ts 兼容层）行为与搬家前一致 —— 衍生世界的分数/品质不能被我改动
 *  2. 通用引擎能承载另一套盘面（料理），块定义改了也仍然守规矩（无自然连、有合法步、可复现）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_TILES, ELEMENTS, scoreToQuality, newBoard as newBoardWx, trySwap as trySwapWx, autoPlay as autoPlayWx, findMatches as findMatchesWx, hasValidMove as hasValidMoveWx } from '../world/match2';
import { autoPlay, calibrateTiers, findMatches, greedyPlay, hasValidMove, newBoard, qualityFromScore, subsetSet, trySwap } from '../lib/match2';
import type { TileSet } from '../lib/match2';
import { makeRng } from '../farm/rng';
import { KITCHEN_BOARD, KITCHEN_QUALITY_TIERS, KITCHEN_SET } from '../farm/kitchen';

describe('修仙盘面兼容层（搬家不改行为）', () => {
  it('品质阈值仍是 200/280/380', () => {
    assert.equal(scoreToQuality(0), '下品');
    assert.equal(scoreToQuality(199), '下品');
    assert.equal(scoreToQuality(200), '中品');
    assert.equal(scoreToQuality(279), '中品');
    assert.equal(scoreToQuality(280), '上品');
    assert.equal(scoreToQuality(379), '上品');
    assert.equal(scoreToQuality(380), '极品');
  });

  it('五行盘面照旧：无自然连、有合法步、可自动游玩', () => {
    const rng = makeRng(42);
    const board = newBoardWx(rng, 7, ALL_TILES, 12);
    assert.equal(findMatchesWx(board.cells).size, 0);
    assert.equal(hasValidMoveWx(board.cells), true);
    autoPlayWx(board, rng, ALL_TILES);
    assert.ok(board.score > 0);
    assert.equal(board.movesLeft, 0);
  });

  it('同一 seed 复现同一局（确定性没丢）', () => {
    const run = (seed: number) => {
      const rng = makeRng(seed);
      const b = newBoardWx(rng, 7, ALL_TILES, 12);
      autoPlayWx(b, rng, ALL_TILES);
      return b.score;
    };
    assert.equal(run(7), run(7));
  });

  it('旧调用形状（只传块数组）仍然可用', () => {
    const rng = makeRng(3);
    const board = newBoardWx(rng, 6, ELEMENTS, 5);
    const out = trySwapWx(board, 0, 0, 1, 0, rng, ELEMENTS);
    assert.equal(typeof out.valid, 'boolean');
  });
});

describe('通用引擎换一套盘面（料理）', () => {
  it('料理盘面：无自然连、有合法步', () => {
    const rng = makeRng(11);
    const board = newBoard(rng, KITCHEN_BOARD.size, KITCHEN_SET, KITCHEN_BOARD.moves);
    assert.equal(findMatches(board.cells).size, 0);
    assert.ok(hasValidMove(board.cells));
  });

  it('随机合法交换能玩完 12 步并出分（无失败）', () => {
    const rng = makeRng(2026);
    const board = newBoard(rng, KITCHEN_BOARD.size, KITCHEN_SET, KITCHEN_BOARD.moves);
    autoPlay(board, rng, KITCHEN_SET);
    assert.equal(board.movesLeft, 0);
    assert.ok(board.score > 0);
  });

  it('贪心玩法可复现，且分数落在校准区间内（40 局样本 168~506）', () => {
    const scores: number[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      const rng = makeRng(seed);
      const board = newBoard(rng, KITCHEN_BOARD.size, KITCHEN_SET, KITCHEN_BOARD.moves);
      greedyPlay(board, rng, KITCHEN_SET);
      scores.push(board.score);
    }
    for (const s of scores) assert.ok(s >= 120 && s <= 700, `分数越界：${s}`);
    const again = makeRng(1);
    const board = newBoard(again, KITCHEN_BOARD.size, KITCHEN_SET, KITCHEN_BOARD.moves);
    greedyPlay(board, again, KITCHEN_SET);
    assert.equal(board.score, scores[0]);
  });

  it('料理阈值（250/320/430）与衍生世界那套不同 —— 不能照搬', () => {
    assert.notDeepEqual(KITCHEN_QUALITY_TIERS.map((t) => t.min), [0, 200, 280, 380]);
    assert.equal(qualityFromScore(249, KITCHEN_QUALITY_TIERS), '下品');
    assert.equal(qualityFromScore(250, KITCHEN_QUALITY_TIERS), '中品');
    assert.equal(qualityFromScore(320, KITCHEN_QUALITY_TIERS), '上品');
    assert.equal(qualityFromScore(430, KITCHEN_QUALITY_TIERS), '极品');
  });

  it('自定义小盘面也能跑（引擎真的与块定义解耦）', () => {
    const small: TileSet = {
      types: ['米', '菜', '酱'],
      score: { 米: 1, 菜: 1, 酱: 5 },
      weights: { 米: 1, 菜: 1, 酱: 0.4 },
    };
    const rng = makeRng(9);
    const board = newBoard(rng, 6, small, 5);
    assert.equal(findMatches(board.cells).size, 0);
    const sub = subsetSet(small, ['米', '菜']);
    assert.deepEqual(sub.types, ['米', '菜']);
    assert.equal(sub.score['酱'], 5, '派生只换 types，分值/权重沿用原表');
  });

  it('calibrateTiers 按分位给阈值', () => {
    const scores = Array.from({ length: 100 }, (_, i) => i * 10);
    const tiers = calibrateTiers(scores, ['下品', '中品', '上品', '极品']);
    assert.equal(tiers[0]!.quality, '下品');
    assert.equal(tiers[1]!.min, 250);
    assert.equal(tiers[2]!.min, 500);
    assert.equal(tiers[3]!.min, 850);
  });
});
