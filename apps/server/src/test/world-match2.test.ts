// 二消小游戏规则单测 —— match-2：交换相邻 → ≥2 连消除 → 掉落补充 → 连锁。
// 盘面块：五行（金木水火土）+ 加成块（灵石/仙晶/丹炉）；无失败：分数只决定品质。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TILES, autoPlay, findMatches, findValidSwap, hasValidMove, newBoard, scoreToQuality, trySwap } from '../world/match2';
import type { TileType } from '../world/match2';
import { makeRng } from '../world/rng';

const TYPES = ALL_TILES;

test('newBoard 生成无自然连、有合法步的盘面', () => {
  const board = newBoard(makeRng(42), 6, TYPES, 20);
  assert.equal(board.size, 6);
  assert.equal(board.cells.length, 6);
  assert.equal(board.cells[0]!.length, 6);
  assert.equal(findMatches(board.cells).size, 0, '初始盘面不应有自然 ≥2 连');
  assert.equal(hasValidMove(board.cells), true, '初始盘面应至少有一处可消');
});

test('findMatches 识别水平/垂直 ≥2 连', () => {
  const cells: (TileType | null)[][] = [
    ['金', '金', '木'],
    ['木', '木', '木'],
    ['金', '木', '金'],
  ];
  const m = findMatches(cells);
  // (0,0)(1,0) 水平金；(0,1)(1,1)(2,1) 水平木；(1,1)(1,2) 垂直木；(2,0)(2,1) 垂直木
  assert.equal(m.size, 7);
  assert.ok(m.has('0,0') && m.has('1,0'));
  assert.ok(m.has('0,1') && m.has('2,1'));
  assert.ok(m.has('1,2'));
  assert.ok(m.has('2,0'));
});

test('trySwap 相邻交换形成消除 → valid=true 且 movesLeft 减一', () => {
  const rng = makeRng(7);
  const board = newBoard(rng, 6, TYPES, 20);
  const mv = findValidSwap(board, rng);
  assert.ok(mv, '应有合法交换');
  const [x1, y1, x2, y2] = mv!;
  const before = board.movesLeft;
  const out = trySwap(board, x1, y1, x2, y2, rng, TYPES);
  assert.equal(out.valid, true);
  assert.ok(out.gained >= 2, `消除块数应 ≥2，实际 ${out.gained}`);
  assert.ok(out.chains >= 1, `连锁层数应 ≥1，实际 ${out.chains}`);
  assert.equal(board.movesLeft, before - 1);
  assert.ok(board.score > 0);
});

test('trySwap 交换后不形成消除 → valid=false 且盘面恢复、不扣步数', () => {
  const cells: (TileType | null)[][] = [
    ['水', '金'],
    ['木', '土'],
  ];
  const board = { size: 2, cells, score: 0, movesLeft: 10 };
  const out = trySwap(board, 0, 0, 1, 0, makeRng(1), TYPES);
  assert.equal(out.valid, false);
  assert.equal(cells[0]![0], '水');
  assert.equal(cells[0]![1], '金');
  assert.equal(cells[1]![0], '木');
  assert.equal(cells[1]![1], '土');
  assert.equal(board.movesLeft, 10, '无效交换不扣步数');
});

test('trySwap 交换不相邻的格子 → valid=false', () => {
  const cells: (TileType | null)[][] = [
    ['金', '木'],
    ['木', '金'],
  ];
  const board = { size: 2, cells, score: 0, movesLeft: 10 };
  const out = trySwap(board, 0, 0, 1, 1, makeRng(1), TYPES); // 对角线，曼哈顿距离 2
  assert.equal(out.valid, false);
});

test('scoreToQuality 分数 → 品质阈值', () => {
  assert.equal(scoreToQuality(0), '下品');
  assert.equal(scoreToQuality(199), '下品');
  assert.equal(scoreToQuality(200), '中品');
  assert.equal(scoreToQuality(279), '中品');
  assert.equal(scoreToQuality(280), '上品');
  assert.equal(scoreToQuality(379), '上品');
  assert.equal(scoreToQuality(380), '极品');
});

test('连锁：一局内总连锁层数大于步数（掉落重组触发连锁）', () => {
  const rng = makeRng(42);
  const board = newBoard(rng, 6, TYPES, 20);
  let totalChains = 0;
  let steps = 0;
  while (board.movesLeft > 0) {
    const mv = findValidSwap(board, rng);
    if (!mv) break;
    const out = trySwap(board, mv[0], mv[1], mv[2], mv[3], rng, TYPES);
    totalChains += out.chains;
    steps++;
  }
  assert.ok(steps > 0, '至少走一步');
  assert.ok(totalChains > steps, `应发生连锁：总连锁层 ${totalChains} > 步数 ${steps}`);
});

test('autoPlay 玩完一局不抛异常，分数累计、步数耗尽或死局', () => {
  const rng = makeRng(42);
  const board = newBoard(rng, 6, TYPES, 20);
  autoPlay(board, rng, TYPES);
  assert.equal(typeof board.score, 'number');
  assert.ok(board.score >= 0);
  assert.ok(board.movesLeft >= 0 && board.movesLeft <= 20);
});
