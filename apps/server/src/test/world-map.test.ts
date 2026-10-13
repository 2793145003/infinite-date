import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldMap } from '../world/map';
import { makeRng } from '../world/rng';

describe('走格子地图', () => {
  it('大方格套小方格：3 区域 × 3 小格 = 9×9 全局格', () => {
    const map = new WorldMap(makeRng(1), 3, 3);
    assert.equal(map.regions, 3);
    assert.equal(map.cells, 3);
    assert.equal(map.size, 9);
    assert.equal(map.totalCells(), 81);
  });

  it('中心格有 4 个邻居，角落格有 2 个', () => {
    const map = new WorldMap(makeRng(1), 3, 3);
    assert.equal(map.neighbors(map.flat({ gx: 4, gy: 4 })).length, 4);
    assert.equal(map.neighbors(map.flat({ gx: 0, gy: 0 })).length, 2);
  });

  it('区域名 + 小格名组成地点', () => {
    const map = new WorldMap(makeRng(7), 3, 3);
    const name = map.name(0);
    assert.ok(name.includes('·'), `地点名应含分隔符：${name}`);
    const [region, cell] = name.split('·');
    assert.ok(region!.length > 0 && cell!.length > 0);
  });

  it('跨区域相邻：区域边界的两个小格是邻居，且分属不同区域', () => {
    const map = new WorldMap(makeRng(1), 3, 3);
    const a = map.flat({ gx: 2, gy: 0 }); // 区域 0 右边界
    const b = map.flat({ gx: 3, gy: 0 }); // 区域 1 左边界
    assert.ok(map.neighbors(a).includes(b));
    assert.ok(map.neighbors(b).includes(a));
    assert.notEqual(map.regionOf(a), map.regionOf(b));
  });

  it('step 返回合法邻居，randomLoc 在范围内', () => {
    const rng = makeRng(42);
    const map = new WorldMap(rng, 3, 3);
    for (let i = 0; i < 200; i++) {
      const loc = map.randomLoc(rng);
      assert.ok(loc >= 0 && loc < 81);
      assert.ok(map.neighbors(loc).includes(map.step(rng, loc)), 'step 应返回邻居');
    }
  });

  it('flat 与 pos 互逆', () => {
    const map = new WorldMap(makeRng(1), 3, 3);
    for (let loc = 0; loc < 81; loc++) {
      assert.equal(map.flat(map.pos(loc)), loc);
    }
  });
});
