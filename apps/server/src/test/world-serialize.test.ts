import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldEngine } from '../world/world';
import { createPlayer } from '../world/player';
import { makeRng } from '../world/rng';

// Phase 5 序列化：世界状态落库 JSON 后能精确重建，且「恢复后继续演化」与「从未中断」随机序列一致。
describe('世界状态序列化', () => {
  function makeEngine(seed = 42): WorldEngine {
    const e = new WorldEngine({ seed, npcCount: 16, regions: 3, cells: 3 });
    e.attachPlayer(createPlayer(makeRng(seed + 1_000_000), { name: '星落', loc: e.world.map.randomLoc(makeRng(seed + 2_000_000)) }));
    return e;
  }

  it('序列化往返：世界状态逐字段一致', () => {
    const a = makeEngine(42);
    a.run(12);
    const save = a.serialize();
    const b = new WorldEngine({ seed: 42, npcCount: 16, regions: 3, cells: 3 }, save);

    assert.equal(b.world.tick, a.world.tick);
    assert.equal(b.world.nextNpcId, a.world.nextNpcId);
    assert.equal(b.world.nextItemId, a.world.nextItemId);
    assert.equal(b.world.nextEventId, a.world.nextEventId);
    assert.equal(save.rngState, a.serialize().rngState);

    // NPC 全量一致
    assert.equal(b.world.npcs.size, a.world.npcs.size);
    for (const [id, n] of a.world.npcs) {
      const m = b.world.npcs.get(id)!;
      assert.equal(m.name, n.name);
      assert.equal(m.loc, n.loc);
      assert.equal(m.realm, n.realm);
      assert.equal(m.alive, n.alive);
      assert.equal(m.liveliness, n.liveliness);
      assert.equal(m.affinityToPlayer, n.affinityToPlayer);
      assert.deepEqual([...m.affinities], [...n.affinities]);
      assert.deepEqual(m.backpack, n.backpack);
      assert.deepEqual(m.characterData, n.characterData);
    }

    // 履历一致
    assert.equal(b.world.events.length, a.world.events.length);
    for (let i = 0; i < a.world.events.length; i++) {
      assert.equal(b.world.events[i]!.desc, a.world.events[i]!.desc);
      assert.equal(b.world.events[i]!.tick, a.world.events[i]!.tick);
      assert.deepEqual(b.world.events[i]!.npcIds, a.world.events[i]!.npcIds);
    }

    // 玩家一致
    const pa = a.world.player!;
    const pb = b.world.player!;
    assert.equal(pb.name, pa.name);
    assert.equal(pb.loc, pa.loc);
    assert.equal(pb.realm, pa.realm);
    assert.deepEqual(pb.backpack, pa.backpack);
    assert.deepEqual([...pb.affinities], [...pa.affinities]);

    // 地图命名一致（恢复后不能再随机重掷）
    for (let loc = 0; loc < a.world.map.totalCells(); loc++) {
      assert.equal(b.world.map.name(loc), a.world.map.name(loc));
    }
  });

  it('恢复后继续演化与从未中断的随机序列完全一致', () => {
    const a = makeEngine(7);
    a.run(6);
    const save = a.serialize();
    const b = new WorldEngine({ seed: 7, npcCount: 16, regions: 3, cells: 3 }, save);

    const eventsA = a.run(6).map((e) => `${e.tick}:${e.type}:${e.desc}`);
    const eventsB = b.run(6).map((e) => `${e.tick}:${e.type}:${e.desc}`);
    assert.deepEqual(eventsA, eventsB, '恢复后的随机序列应与原引擎续演一致');
  });

  it('恢复后仍可交互：移动升格 + 对话写回', () => {
    const a = makeEngine(9);
    a.run(3);
    const save = a.serialize();
    const b = new WorldEngine({ seed: 9, npcCount: 16, regions: 3, cells: 3 }, save);

    const npc = b.aliveNpcs()[0]!;
    const met = b.playerMove(npc.loc);
    assert.ok(met.some((n) => n.id === npc.id));

    const ev = b.recordChat(npc.id, '你与对方相谈甚欢', 2);
    assert.ok(ev);
    assert.equal(ev.type, '交谈');
    assert.ok(b.world.npcs.get(npc.id)!.affinityToPlayer > 0);
  });
});
