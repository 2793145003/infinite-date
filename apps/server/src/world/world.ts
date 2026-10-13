// 世界演化引擎 —— 月度 tick 驱动：移动 → 相遇 → 掷事件 → 结算 → 写履历 → 大事件流
// 程序只记事实（谁/何时/何地/何事/数值变化），文学性交给 LLM 层（Phase 4）。
// Phase 2：走格子地图（map.ts）+ 玩家介入（事件生成与结算分离，介入插中间）+ 相遇升格。

import type { EventLog, EventType, InterveneAction, Npc, PendingEvent, Player, Realm, World, WorldSave } from './types';
import { EVENT_VISIBILITY, REALM_LIFESPAN, REALMS, REBIRTH_REALM } from './types';
import { kinship } from './wuxing';
import { chance, makeRngState, pickWeighted, randInt } from './rng';
import type { Rng, RngState } from './rng';
import { generateNpcs } from './npc';
import { generateItem } from './items';
import { WorldMap } from './map';
import { applyIntervention } from './intervene';
import { hasMaterials, npcCraft } from './craft';
import { recipesForFaction } from './recipes';

export interface WorldOptions {
  seed: number;
  npcCount: number;
  gridSize?: number;   // 兼容 Phase 1：全局边长（regions/cells 未给时 = 单区域平铺）
  regions?: number;    // 大方格边长 R（默认 1；嵌套地图传 3）
  cells?: number;      // 每区域小方格边长 C（默认取 gridSize 或 8）
}

interface DirectedEvent {
  subject: Npc;
  object: Npc;
  type: EventType;
  weight: number;
}

// 有向事件决策（模块级纯函数）：s 主动对 o 做什么，返回候选事件及权重。
function directedEvents(rng: Rng, s: Npc, o: Npc): DirectedEvent[] {
  const rel = kinship(s.wx, o.wx);
  const aff = s.affinities.get(o.id) ?? 0;
  const realmDiff = o.realm - s.realm; // o 比 s 高几级（负 = o 更低）
  const evilS = s.alignment.includes('邪恶');
  const evilO = o.alignment.includes('邪恶');
  const list: DirectedEvent[] = [];
  const add = (type: EventType, weight: number) => {
    if (weight > 0) list.push({ subject: s, object: o, type, weight });
  };

  // 争执：只在相克/有旧怨/邪恶时才起摩擦，萍水相逢不争执
  let quarrel = 0;
  if (rel === '官鬼' || rel === '妻财') quarrel += 6;
  if (aff < 0) quarrel += Math.min(10, Math.floor(-aff / 12));
  if (evilS || evilO) quarrel += 3;
  add('争执', quarrel);

  // 夺宝：s 眼里 o 是「妻财」（我克他，掌控其物），且 s 境界压得住 o
  if (rel === '妻财' && realmDiff <= 0 && o.backpack.length > 0) add('夺宝', 6);
  if (evilS && realmDiff <= 0 && o.backpack.length > 0) add('夺宝', 4);

  // 生死斗：深仇大恨才动手，修仙世界的「陨落」应稀有而沉重
  let death = 0;
  if (aff <= -60) death += 12;
  if (aff <= -90) death += 25;
  if ((rel === '官鬼' || rel === '妻财') && Math.abs(realmDiff) <= 1 && (evilS || evilO) && aff <= -30) death += 10;
  add('生死斗', death);

  // 提携：s 眼里 o 是「子孙」（我生他，我是指点/付出方），且 s 境界更高
  if (rel === '子孙' && realmDiff < 0) add('提携', 16);

  // 赠宝：长辈赠晚辈（子孙）/ 追求示好（妻财），手里有东西且无深仇大恨即送
  if ((rel === '子孙' || rel === '妻财') && aff > -20 && s.backpack.length > 0) add('赠宝', 10);

  // 结缘：妻财位（我克他=我追求）才是配偶位，六爻原意，异性且好感足够且尚未结缘
  if (rel === '妻财' && s.gender !== o.gender && aff > 15 && !s.daolv.includes(o.id)) add('结缘', 14);

  // 切磋：比和 + 境界接近
  if (rel === '兄弟' && Math.abs(realmDiff) <= 1) add('切磋', 14);

  // 竞争机缘：比和 + 同境界
  if (rel === '兄弟' && realmDiff === 0) add('竞争机缘', 8);

  return list;
}

export class WorldEngine {
  readonly world: World;
  private rng: Rng;
  private rngState: RngState;

  constructor(opts: WorldOptions, restored?: WorldSave) {
    const rngState = makeRngState(opts.seed);
    this.rngState = rngState;
    this.rng = rngState.rng;

    // 存档恢复：从落库的世界快照重建，rng 也从快照状态继续（确定性延续）
    if (restored) {
      rngState.setState(restored.rngState);
      this.world = this.buildWorldFromSave(restored);
      return;
    }

    const regions = opts.regions ?? 1;
    // gridSize 语义平滑过渡：Phase 1 是「格子数」（10 格挤 30 人），Phase 2 是「边长」。
    // 用 sqrt 映射让旧测试的 NPC 密度接近 Phase 1（30 人/10 格 → 4×4=16 格）。
    const cells = opts.cells ?? (opts.gridSize ? Math.max(2, Math.ceil(Math.sqrt(opts.gridSize))) : 8);
    const map = new WorldMap(this.rng, regions, cells);
    const world: World = {
      tick: 0,
      npcs: new Map(),
      events: [],
      map,
      nextNpcId: 0,
      nextItemId: 0,
      nextEventId: 0,
    };
    this.world = world;
    const nextItemId = () => world.nextItemId++;
    for (const n of generateNpcs(this.rng, opts.npcCount, map, nextItemId)) {
      world.npcs.set(n.id, n);
    }
    world.nextNpcId = opts.npcCount;
  }

  /** 世界状态快照（JSON-safe，可落库）。恢复用 `new WorldEngine({seed}, save)`。 */
  serialize(): WorldSave {
    const npcs = [...this.world.npcs.values()].map((n) => ({
      ...n,
      affinities: Object.fromEntries(n.affinities),
    }));
    const player = this.world.player
      ? { ...this.world.player, affinities: Object.fromEntries(this.world.player.affinities) }
      : undefined;
    return {
      tick: this.world.tick,
      nextNpcId: this.world.nextNpcId,
      nextItemId: this.world.nextItemId,
      nextEventId: this.world.nextEventId,
      rngState: this.rngState.getState(),
      map: this.world.map.serialize(),
      npcs,
      events: this.world.events,
      player,
    };
  }

  private buildWorldFromSave(data: WorldSave): World {
    const map = WorldMap.restore(data.map);
    const world: World = {
      tick: data.tick,
      npcs: new Map(),
      events: data.events,
      map,
      nextNpcId: data.nextNpcId,
      nextItemId: data.nextItemId,
      nextEventId: data.nextEventId,
    };
    for (const sn of data.npcs) {
      const n: Npc = {
        ...sn,
        affinities: new Map(Object.entries(sn.affinities).map(([k, v]) => [Number(k), v])),
      };
      world.npcs.set(n.id, n);
    }
    if (data.player) {
      world.player = {
        ...data.player,
        affinities: new Map(Object.entries(data.player.affinities).map(([k, v]) => [Number(k), v])),
      };
    }
    return world;
  }

  get npcs(): Npc[] {
    return [...this.world.npcs.values()];
  }

  aliveNpcs(): Npc[] {
    return this.npcs.filter((n) => n.alive);
  }

  locName(loc: number): string {
    return this.world.map.name(loc);
  }

  /** 推进一个月，返回本月新增事件。onIntervene：结算前回调，玩家可介入。 */
  tick(onIntervene?: (pending: PendingEvent[], engine: WorldEngine) => void): EventLog[] {
    this.world.tick++;
    const before = this.world.events.length;
    this.acquireItems();
    this.npcCraftTicks();
    this.moveNpcs();
    const pending = this.detectEncounters();
    if (onIntervene && pending.length > 0) onIntervene(pending, this);
    for (const p of pending) this.resolvePending(p);
    this.resolvePersonal();
    return this.world.events.slice(before);
  }

  /** 推进 N 个月 */
  run(months: number, onIntervene?: (pending: PendingEvent[], engine: WorldEngine) => void): EventLog[] {
    const all: EventLog[] = [];
    for (let i = 0; i < months; i++) all.push(...this.tick(onIntervene));
    return all;
  }

  /** 大事件流（世界传闻）：所有 public 事件，按时间正序 */
  publicEvents(): EventLog[] {
    return this.world.events.filter((e) => e.visibility === 'public');
  }

  /** 某 NPC 的完整履历（含 private），点开看 */
  npcHistory(npcId: number): EventLog[] {
    return this.world.events.filter((e) => e.npcIds.includes(npcId));
  }

  /** 挂载玩家（走格子 + 介入的主体） */
  attachPlayer(player: Player): void {
    this.world.player = player;
  }

  /** Phase 4：玩家与 NPC 对话后写回。事实记履历（「交谈」事件），好感双向更新。 */
  recordChat(npcId: number, fact: string, affinityDelta: number): EventLog | null {
    const npc = this.world.npcs.get(npcId);
    if (!npc || !npc.alive) return null;
    const player = this.world.player;
    const delta = Math.max(-5, Math.min(5, Math.round(affinityDelta)));
    if (player) {
      npc.affinityToPlayer = Math.max(-100, Math.min(100, npc.affinityToPlayer + delta));
      const cur = player.affinities.get(npcId) ?? 0;
      player.affinities.set(npcId, Math.max(-100, Math.min(100, cur + delta)));
    }
    const ev: EventLog = {
      id: this.world.nextEventId++,
      tick: this.world.tick,
      type: '交谈',
      desc: fact,
      visibility: EVENT_VISIBILITY['交谈'],
      loc: npc.loc,
      npcIds: [npcId],
      playerIntervened: true,
    };
    this.world.events.push(ev);
    return ev;
  }

  /** 玩家移动到 loc，触发与同格 NPC 的相遇升格；返回本次新「活过来」的 NPC */
  playerMove(loc: number): Npc[] {
    const player = this.world.player;
    if (!player) return [];
    player.loc = loc;
    const met: Npc[] = [];
    for (const n of this.aliveNpcs()) {
      if (n.loc === loc && n.liveliness === 0) {
        n.liveliness = 1;
        met.push(n);
        this.pushEvent('相遇', loc, [n.id], `你与${n.name}相遇，对方从茫茫人海中浮现`);
      }
    }
    return met;
  }

  /** 介入一个待结算事件（在 tick 的 onIntervene 回调里调用） */
  intervene(p: PendingEvent, action: Exclude<InterveneAction, '旁观'>, target?: number): void {
    p.intervention = action;
    p.interveneTarget = target ?? (action === '帮A' ? p.subjectId : p.objectId);
  }

  // ---------- 内部 ----------

  private acquireItems(): void {
    // 修炼途中采药/拾宝：物品必须能再生产，赠宝/夺宝才流动得起来
    for (const n of this.aliveNpcs()) {
      if (chance(this.rng, 0.05)) {
        n.backpack.push(generateItem(this.rng, this.world.nextItemId++));
      }
    }
  }

  /** NPC 制造：每月一定概率尝试（通用/本门派配方 + 材料够才炼） */
  private npcCraftTicks(): void {
    for (const n of this.aliveNpcs()) {
      if (!chance(this.rng, 0.10)) continue;
      const doable = recipesForFaction(n.faction).filter((r) => hasMaterials(n.backpack, r.materials));
      if (doable.length === 0) continue;
      const recipe = doable[Math.floor(this.rng() * doable.length)]!;
      const result = npcCraft(this.rng, n, recipe, () => this.world.nextItemId++);
      if (result.success) {
        this.pushEvent('制造', n.loc, [n.id], result.desc, result.item?.id);
      } else if (!result.desc.includes('材料不足')) {
        this.pushEvent('制造', n.loc, [n.id], result.desc);
      }
    }
  }

  private moveNpcs(): void {
    for (const n of this.aliveNpcs()) {
      if (chance(this.rng, 0.7)) n.loc = this.world.map.step(this.rng, n.loc);
    }
  }

  private detectEncounters(): PendingEvent[] {
    const byLoc = new Map<number, Npc[]>();
    for (const n of this.aliveNpcs()) {
      const arr = byLoc.get(n.loc) ?? [];
      arr.push(n);
      byLoc.set(n.loc, arr);
    }
    const pending: PendingEvent[] = [];
    for (const group of byLoc.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const p = this.detectPair(group[i]!, group[j]!);
          if (p) pending.push(p);
        }
      }
    }
    return pending;
  }

  private detectPair(a: Npc, b: Npc): PendingEvent | null {
    if (!a.alive || !b.alive) return null;
    // 相遇不必然发生事件：多数时间各自安好，有交集/旧怨/相克才更易生事
    const rel = kinship(a.wx, b.wx);
    let p = 0.20;
    if (rel === '官鬼' || rel === '妻财') p = 0.35;      // 相克易起冲突
    else if (rel === '父母' || rel === '子孙') p = 0.28; // 相生易结缘
    const aff = a.affinities.get(b.id) ?? 0;
    p += Math.abs(aff) / 400;                            // 有旧情/旧怨更易再交集
    if (!chance(this.rng, p)) return null;
    const candidates = [...directedEvents(this.rng, a, b), ...directedEvents(this.rng, b, a)];
    if (candidates.length === 0) return null;
    const idx = pickWeighted(this.rng, candidates.map((c) => c.weight));
    const ev = candidates[idx]!;
    return { subjectId: ev.subject.id, objectId: ev.object.id, type: ev.type, loc: a.loc };
  }

  private resolvePersonal(): void {
    for (const n of this.aliveNpcs()) this.resolveBreakthrough(n);
    for (const n of this.aliveNpcs()) this.resolveLifespan(n);
  }

  private resolveBreakthrough(n: Npc): void {
    if (n.realm >= 4) return; // 化神已是巅峰
    // 灵力积累
    n.qi += Math.max(1, Math.round(n.comprehension / 10));

    // 突破辅助丹药自动消耗
    let bonus = 0;
    const itemIdx = n.backpack.findIndex((it) => it.realmBreak !== undefined);
    if (itemIdx >= 0) {
      bonus = n.backpack[itemIdx]!.realmBreak ?? 0;
      n.backpack.splice(itemIdx, 1);
    }

    const base = 0.04 * (n.aptitude / 50) * Math.pow(0.5, n.realm) * (1 + bonus);
    if (!chance(this.rng, base)) return;

    const nextRealm = (n.realm + 1) as Realm;
    if (nextRealm < REBIRTH_REALM) {
      // 普通突破（练气→筑基），private
      n.realm = nextRealm;
      n.lifespan = Math.round(REALM_LIFESPAN[nextRealm]! * (0.6 + this.rng() * 0.3));
      n.qi = 0;
      this.pushEvent('突破', n.loc, [n.id], `${n.name}突破至${REALMS[nextRealm]}`);
    } else {
      // 渡劫（突破到金丹及以上），public，有失败率
      const success = chance(this.rng, 0.5 + n.fortune / 200);
      if (success) {
        n.realm = nextRealm;
        n.lifespan = Math.round(REALM_LIFESPAN[nextRealm]! * (0.6 + this.rng() * 0.3));
        n.qi = 0;
        this.pushEvent('渡劫', n.loc, [n.id], `${n.name}渡劫成功，晋升${REALMS[nextRealm]}！`);
      } else if (chance(this.rng, 0.5)) {
        this.pushEvent('渡劫', n.loc, [n.id], `${n.name}渡劫失败，身死道消`);
        this.die(n);
      } else {
        n.lifespan = Math.max(1, Math.floor(n.lifespan / 2));
        this.pushEvent('渡劫', n.loc, [n.id], `${n.name}渡劫失败，重伤垂死，寿元折半`);
      }
    }
  }

  private resolveLifespan(n: Npc): void {
    n.lifespan -= 1;
    if (n.lifespan > 0) return;
    // 寿元耗尽，自动服用续命之物
    const itemIdx = n.backpack.findIndex((it) => it.lifespanBonus !== undefined);
    if (itemIdx >= 0) {
      n.lifespan += n.backpack[itemIdx]!.lifespanBonus ?? 0;
      n.backpack.splice(itemIdx, 1);
      return;
    }
    this.pushEvent('陨落', n.loc, [n.id], `${n.name}寿元耗尽，坐化`);
    this.die(n);
  }

  private die(n: Npc): void {
    n.alive = false;
  }

  private pushEvent(type: EventType, loc: number, npcIds: number[], desc: string, itemId?: number): EventLog {
    const ev: EventLog = {
      id: this.world.nextEventId++,
      tick: this.world.tick,
      type,
      desc,
      visibility: EVENT_VISIBILITY[type],
      loc,
      npcIds,
      itemId,
      playerIntervened: false,
    };
    this.world.events.push(ev);
    return ev;
  }

  private resolvePending(p: PendingEvent): void {
    const s = this.world.npcs.get(p.subjectId);
    const o = this.world.npcs.get(p.objectId);
    if (!s || !o || !s.alive || !o.alive) return;
    if (p.intervention) {
      this.resolveIntervention(p, s, o);
    } else {
      this.resolveEvent(s, o, p.type);
    }
  }

  private resolveIntervention(p: PendingEvent, s: Npc, o: Npc): void {
    const player = this.world.player;
    if (!player) return;
    const target = p.interveneTarget ?? p.subjectId;
    const result = applyIntervention(p, p.intervention!, target, this.world.npcs, player, this.locName(p.loc));
    if (!result.desc) {
      // 和谐类事件（防御性兜底）：走原结算
      this.resolveEvent(s, o, p.type);
      return;
    }
    if (result.playerQi) player.qi += result.playerQi;
    if (result.playerComprehension) player.comprehension += result.playerComprehension;
    this.pushIntervened(p, result.desc);
  }

  private pushIntervened(p: PendingEvent, desc: string): EventLog {
    const ev: EventLog = {
      id: this.world.nextEventId++,
      tick: this.world.tick,
      type: p.type,
      desc,
      visibility: EVENT_VISIBILITY[p.type],
      loc: p.loc,
      npcIds: [p.subjectId, p.objectId],
      playerIntervened: true,
      outcome: p.intervention,
    };
    this.world.events.push(ev);
    return ev;
  }

  private addAff(a: Npc, b: Npc, delta: number): void {
    const cur = a.affinities.get(b.id) ?? 0;
    a.affinities.set(b.id, Math.max(-100, Math.min(100, cur + delta)));
  }

  private resolveEvent(s: Npc, o: Npc, type: EventType): void {
    const t = this.world.tick;
    const loc = s.loc;
    const locName = this.locName(loc);

    switch (type) {
      case '争执': {
        const dmg = -5 - randInt(this.rng, 8);
        this.addAff(s, o, dmg);
        this.addAff(o, s, dmg);
        this.pushEvent('争执', loc, [s.id, o.id], `${s.name}在${locName}与${o.name}发生争执，关系恶化`);
        break;
      }
      case '夺宝': {
        if (o.backpack.length === 0) break;
        const idx = randInt(this.rng, o.backpack.length);
        const item = o.backpack.splice(idx, 1)[0]!;
        s.backpack.push(item);
        this.addAff(o, s, -40);
        this.pushEvent('夺宝', loc, [s.id, o.id], `${s.name}在${locName}夺走${o.name}的「${item.name}」`, item.id);
        break;
      }
      case '生死斗': {
        const sPower = s.realm * 100 + s.qi + this.rng() * 50;
        const oPower = o.realm * 100 + o.qi + this.rng() * 50;
        const sWins = sPower >= oPower;
        const loser = sWins ? o : s;
        const winner = sWins ? s : o;
        if (chance(this.rng, 0.3)) {
          this.pushEvent('生死斗', loc, [s.id, o.id], `${s.name}与${o.name}在${locName}生死相斗，${loser.name}不敌身死`);
          this.die(loser);
        } else {
          loser.lifespan = Math.max(1, Math.floor(loser.lifespan * 0.6));
          this.pushEvent('生死斗', loc, [s.id, o.id], `${s.name}与${o.name}在${locName}生死相斗，${loser.name}重伤遁走`);
        }
        this.addAff(winner, loser, -60);
        this.addAff(loser, winner, -60);
        break;
      }
      case '提携': {
        o.qi += 20 + randInt(this.rng, 30);
        this.addAff(s, o, 10);
        this.addAff(o, s, 15);
        this.pushEvent('提携', loc, [s.id, o.id], `${s.name}在${locName}指点${o.name}修炼，${o.name}修为精进`);
        break;
      }
      case '赠宝': {
        if (s.backpack.length === 0) break;
        const idx = randInt(this.rng, s.backpack.length);
        const item = s.backpack.splice(idx, 1)[0]!;
        o.backpack.push(item);
        this.addAff(s, o, 20);
        this.addAff(o, s, 15);
        this.pushEvent('赠宝', loc, [s.id, o.id], `${s.name}在${locName}将「${item.name}」赠予${o.name}`, item.id);
        break;
      }
      case '结缘': {
        if (!s.daolv.includes(o.id)) s.daolv.push(o.id);
        if (!o.daolv.includes(s.id)) o.daolv.push(s.id);
        this.addAff(s, o, 30);
        this.addAff(o, s, 30);
        this.pushEvent('结缘', loc, [s.id, o.id], `${s.name}与${o.name}在${locName}结为道侣`);
        break;
      }
      case '切磋': {
        const gain = 10 + randInt(this.rng, 15);
        s.qi += gain;
        o.qi += gain;
        this.addAff(s, o, 5);
        this.addAff(o, s, 5);
        this.pushEvent('切磋', loc, [s.id, o.id], `${s.name}与${o.name}在${locName}切磋，各有进益`);
        break;
      }
      case '竞争机缘': {
        const sFort = s.fortune + this.rng() * 20;
        const oFort = o.fortune + this.rng() * 20;
        if (sFort >= oFort) {
          s.qi += 30;
          this.addAff(o, s, -10);
          this.pushEvent('竞争机缘', loc, [s.id, o.id], `${s.name}与${o.name}在${locName}争夺机缘，${s.name}得手`);
        } else {
          o.qi += 30;
          this.addAff(s, o, -10);
          this.pushEvent('竞争机缘', loc, [s.id, o.id], `${s.name}与${o.name}在${locName}争夺机缘，${o.name}得手`);
        }
        break;
      }
      default:
        break;
    }
  }
}
