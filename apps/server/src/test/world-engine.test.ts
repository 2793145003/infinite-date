import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldEngine } from '../world/world';
import { ke } from '../world/wuxing';
import { EVENT_VISIBILITY } from '../world/types';

describe('世界演化引擎', () => {
  it('同 seed 完全可复现', () => {
    const a = new WorldEngine({ seed: 7, npcCount: 20, gridSize: 10 });
    const b = new WorldEngine({ seed: 7, npcCount: 20, gridSize: 10 });
    a.run(12);
    b.run(12);
    const descA = a.world.events.map((e) => e.desc).join('\n');
    const descB = b.world.events.map((e) => e.desc).join('\n');
    assert.equal(descA, descB);
  });

  it('事件引用真实 NPC', () => {
    const e = new WorldEngine({ seed: 1, npcCount: 20, gridSize: 10 });
    e.run(24);
    assert.ok(e.world.events.length > 0, '24 个月内应有事件');
    for (const ev of e.world.events) {
      for (const id of ev.npcIds) {
        assert.ok(e.world.npcs.has(id), `事件引用了不存在的 NPC ${id}`);
      }
    }
  });

  it('事件可见性与类型一致', () => {
    const e = new WorldEngine({ seed: 2, npcCount: 20, gridSize: 10 });
    e.run(24);
    for (const ev of e.world.events) {
      assert.equal(ev.visibility, EVENT_VISIBILITY[ev.type]);
    }
  });

  it('结缘仅发生在异性之间', () => {
    const e = new WorldEngine({ seed: 3, npcCount: 30, gridSize: 10 });
    e.run(60);
    const 结缘 = e.world.events.filter((ev) => ev.type === '结缘');
    for (const ev of 结缘) {
      assert.equal(ev.npcIds.length, 2);
      const a = e.world.npcs.get(ev.npcIds[0]!)!;
      const b = e.world.npcs.get(ev.npcIds[1]!)!;
      assert.notEqual(a.gender, b.gender, `结缘双方性别应不同：${a.name} vs ${b.name}`);
    }
  });

  it('结缘双方必为相克（妻财位）关系', () => {
    const e = new WorldEngine({ seed: 99, npcCount: 30, gridSize: 10 });
    e.run(80);
    const 结缘 = e.world.events.filter((ev) => ev.type === '结缘');
    assert.ok(结缘.length > 0, '该 seed 应有结缘事件');
    for (const ev of 结缘) {
      const a = e.world.npcs.get(ev.npcIds[0]!)!;
      const b = e.world.npcs.get(ev.npcIds[1]!)!;
      assert.ok(ke(a.wx) === b.wx || ke(b.wx) === a.wx, `结缘双方应相克：${a.name}(${a.wx}) vs ${b.name}(${b.wx})`);
    }
  });

  it('道侣关系不重复', () => {
    const e = new WorldEngine({ seed: 2026, npcCount: 16, gridSize: 8 });
    e.run(60);
    for (const n of e.npcs) {
      const uniq = new Set(n.daolv);
      assert.equal(uniq.size, n.daolv.length, `${n.name} 的道侣列表有重复`);
    }
  });

  it('长周期出现死亡与陨落事件', () => {
    const e = new WorldEngine({ seed: 42, npcCount: 30, gridSize: 10 });
    e.run(300);
    const dead = e.world.npcs.size - e.aliveNpcs().length;
    assert.ok(dead > 0, '300 个月内应有死亡');
    assert.ok(e.world.events.some((ev) => ev.type === '陨落'), '应有陨落事件');
  });

  it('长周期有人突破到金丹及以上', () => {
    const e = new WorldEngine({ seed: 5, npcCount: 50, gridSize: 12 });
    e.run(100);
    const realms = e.aliveNpcs().map((n) => n.realm);
    assert.ok(realms.some((r) => r >= 2), '应有金丹及以上修士（渡劫成功）');
  });

  it('大事件流只含 public 事件', () => {
    const e = new WorldEngine({ seed: 6, npcCount: 20, gridSize: 10 });
    e.run(24);
    const pub = e.publicEvents();
    for (const ev of pub) assert.equal(ev.visibility, 'public');
  });
});
