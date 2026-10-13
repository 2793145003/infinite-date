import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorldEngine } from '../world/world';
import { createPlayer } from '../world/player';
import { makeRng } from '../world/rng';
import { applyIntervention, isIntervenable } from '../world/intervene';
import type { PendingEvent } from '../world/types';

describe('玩家与介入', () => {
  it('createPlayer 生成合法玩家', () => {
    const player = createPlayer(makeRng(1), { name: '星落', loc: 5 });
    assert.equal(player.name, '星落');
    assert.ok(player.aptitude >= 50 && player.aptitude < 90);
    assert.ok(player.comprehension >= 50 && player.comprehension < 90);
    assert.equal(player.loc, 5);
    assert.equal(player.energy, 100);
    assert.ok(player.actionPoints > 0);
  });

  it('玩家移动到 NPC 所在格 → 相遇升格 + 记事件', () => {
    const e = new WorldEngine({ seed: 1, npcCount: 16, regions: 3, cells: 3 });
    const player = createPlayer(makeRng(2), { name: '星落', loc: 0 });
    e.attachPlayer(player);
    const npc = e.aliveNpcs()[0]!;
    const met = e.playerMove(npc.loc);
    assert.ok(met.some((n) => n.id === npc.id), '走到 NPC 格应升格该 NPC');
    assert.equal(npc.liveliness, 1);
    assert.ok(e.world.events.some((ev) => ev.type === '相遇' && ev.npcIds.includes(npc.id)));
  });

  it('玩家走到空无一人的格子 → 无升格', () => {
    const e = new WorldEngine({ seed: 3, npcCount: 4, regions: 3, cells: 3 });
    const player = createPlayer(makeRng(4), { name: '星落', loc: 0 });
    e.attachPlayer(player);
    const occupied = new Set(e.aliveNpcs().map((n) => n.loc));
    const empty = Array.from({ length: 81 }, (_, i) => i).find((i) => !occupied.has(i))!;
    assert.equal(e.playerMove(empty).length, 0);
  });

  it('介入争执劝架：双方关系修复，玩家好感上升', () => {
    const e = new WorldEngine({ seed: 1, npcCount: 16, regions: 3, cells: 3 });
    const player = createPlayer(makeRng(2), { name: '星落', loc: 0 });
    e.attachPlayer(player);
    const [a, b] = e.aliveNpcs();
    const before = a!.affinities.get(b!.id) ?? 0;
    const p: PendingEvent = { subjectId: a!.id, objectId: b!.id, type: '争执', loc: a!.loc };
    const res = applyIntervention(p, '劝架', a!.id, e.world.npcs, player, e.locName(a!.loc));
    assert.ok(res.desc.length > 0);
    assert.ok((a!.affinities.get(b!.id) ?? 0) > before, '劝架应修复双方关系');
    assert.ok(a!.affinityToPlayer > 0 && b!.affinityToPlayer > 0, '双方都应对玩家有好感');
  });

  it('介入帮一方：被帮方好感上升，另一方记恨', () => {
    const e = new WorldEngine({ seed: 1, npcCount: 16, regions: 3, cells: 3 });
    const player = createPlayer(makeRng(2), { name: '星落', loc: 0 });
    e.attachPlayer(player);
    const [a, b] = e.aliveNpcs();
    const p: PendingEvent = { subjectId: a!.id, objectId: b!.id, type: '争执', loc: a!.loc };
    applyIntervention(p, '帮A', a!.id, e.world.npcs, player, e.locName(a!.loc));
    assert.ok(a!.affinityToPlayer > 0, '被帮方应对玩家有好感');
    assert.ok(b!.affinityToPlayer < 0, '另一方应记恨玩家');
  });

  it('介入生死斗劝架：双方都不死、不折寿', () => {
    const e = new WorldEngine({ seed: 1, npcCount: 16, regions: 3, cells: 3 });
    const player = createPlayer(makeRng(2), { name: '星落', loc: 0 });
    e.attachPlayer(player);
    const [a, b] = e.aliveNpcs();
    const lifeB = b!.lifespan;
    const p: PendingEvent = { subjectId: a!.id, objectId: b!.id, type: '生死斗', loc: a!.loc };
    applyIntervention(p, '劝架', a!.id, e.world.npcs, player, e.locName(a!.loc));
    assert.equal(b!.lifespan, lifeB, '劝架不应折寿');
    assert.equal(a!.alive && b!.alive, true);
  });

  it('完整流程：onIntervene 介入产生 playerIntervened 事件', () => {
    const e = new WorldEngine({ seed: 7, npcCount: 30, regions: 2, cells: 2 });
    const player = createPlayer(makeRng(8), { name: '星落', loc: 0 });
    e.attachPlayer(player);
    let intervened = 0;
    e.run(40, (pending, eng) => {
      for (const p of pending) {
        if (!isIntervenable(p.type)) continue;
        eng.world.player!.loc = p.loc;
        eng.intervene(p, '劝架');
        intervened++;
      }
    });
    assert.ok(intervened > 0, '密集地图 40 个月应有可介入冲突');
    const intervEvents = e.world.events.filter((ev) => ev.playerIntervened);
    assert.ok(intervEvents.length > 0, '应有 playerIntervened 事件');
    for (const ev of intervEvents) {
      assert.equal(ev.playerIntervened, true);
      assert.ok(ev.outcome, '介入事件应有 outcome 标记');
    }
  });

  it('介入只对冲突类事件生效', () => {
    for (const t of ['争执', '生死斗', '夺宝', '竞争机缘'] as const) assert.ok(isIntervenable(t));
    for (const t of ['结缘', '赠宝', '提携', '切磋'] as const) assert.ok(!isIntervenable(t));
  });
});
