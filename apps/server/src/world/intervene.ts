// 介入机制 —— 玩家对「待结算事件」的选择，改写结局。
// 介入发生在「事件生成」与「事件结算」之间，只改写玩家在场的格子。
// 设计原则：玩家亲手参与的事件给足体验（改数值 + 改关系），其余照规则结算。

import type { EventType, InterveneAction, Npc, PendingEvent, Player } from './types';

export interface InterveneResult {
  desc: string;               // 介入描述（写入事件 outcome）
  playerQi?: number;          // 玩家灵力变化
  playerComprehension?: number; // 玩家悟性变化
}

// 只有「冲突类」事件可介入；提携/赠宝/结缘/切磋是和谐类，玩家旁观即可
export function isIntervenable(type: EventType): boolean {
  return type === '争执' || type === '生死斗' || type === '夺宝' || type === '竞争机缘';
}

function clamp(v: number): number {
  return Math.max(-100, Math.min(100, v));
}

function addAff(a: Npc, b: Npc, delta: number): void {
  a.affinities.set(b.id, clamp((a.affinities.get(b.id) ?? 0) + delta));
}

function addPlayerAff(player: Player, npcId: number, delta: number): void {
  player.affinities.set(npcId, clamp((player.affinities.get(npcId) ?? 0) + delta));
}

function addNpcToPlayerAff(npc: Npc, delta: number): void {
  npc.affinityToPlayer = clamp(npc.affinityToPlayer + delta);
}

export function applyIntervention(
  p: PendingEvent,
  action: Exclude<InterveneAction, '旁观'>,
  target: number,
  npcs: Map<number, Npc>,
  player: Player,
  locName: string,
): InterveneResult {
  const s = npcs.get(p.subjectId)!;
  const o = npcs.get(p.objectId)!;
  const A = target === s.id ? s : o; // 被帮/被袒护的一方
  const B = target === s.id ? o : s; // 另一方

  switch (p.type) {
    case '争执': {
      if (action === '劝架') {
        addAff(s, o, 10);
        addAff(o, s, 10);
        addNpcToPlayerAff(s, 10);
        addNpcToPlayerAff(o, 10);
        addPlayerAff(player, s.id, 5);
        addPlayerAff(player, o.id, 5);
        return { desc: `你在${locName}劝解${s.name}与${o.name}，二人各自罢休，对你心生感激` };
      }
      addAff(A, B, -15);
      addAff(B, A, -8);
      addNpcToPlayerAff(A, 15);
      addNpcToPlayerAff(B, -10);
      addPlayerAff(player, A.id, 10);
      return { desc: `你在${locName}袒护${A.name}，${B.name}忿忿而去。${A.name}与你亲近，${B.name}记恨于你` };
    }
    case '生死斗': {
      if (action === '劝架') {
        addAff(s, o, 15);
        addAff(o, s, 15);
        addNpcToPlayerAff(s, 20);
        addNpcToPlayerAff(o, 20);
        addPlayerAff(player, s.id, 8);
        addPlayerAff(player, o.id, 8);
        return { desc: `你在${locName}挡在二人中间止住一场生死斗，${s.name}与${o.name}罢手，都欠你一条命` };
      }
      B.lifespan = Math.max(1, Math.floor(B.lifespan * 0.6));
      addNpcToPlayerAff(A, 20);
      addNpcToPlayerAff(B, -25);
      addPlayerAff(player, A.id, 10);
      return { desc: `你在${locName}助${A.name}一臂之力，${B.name}重伤败走，${A.name}承你的情` };
    }
    case '夺宝': {
      if (action === '帮B' || action === '劝架') {
        addAff(s, o, action === '劝架' ? -10 : -30);
        addNpcToPlayerAff(o, action === '劝架' ? 8 : 20);
        addNpcToPlayerAff(s, action === '劝架' ? 0 : -15);
        addPlayerAff(player, o.id, 10);
        return {
          desc: action === '劝架'
            ? `你在${locName}调停夺宝之争，宝物仍归${o.name}所有，二人皆念你的好`
            : `你在${locName}拦下${s.name}，${o.name}保住宝物，对你感激不尽`,
        };
      }
      // 帮 A：默许 A 得手（原结局），B 记恨玩家
      const item = o.backpack.pop();
      if (item) s.backpack.push(item);
      addAff(o, s, -40);
      addNpcToPlayerAff(o, -20);
      return { desc: `你在${locName}任${s.name}夺走${o.name}的${item ? `「${item.name}」` : '宝物'}，${o.name}对你冷眼相向` };
    }
    case '竞争机缘': {
      if (action === '劝架') {
        s.qi += 15;
        o.qi += 15;
        addNpcToPlayerAff(s, 8);
        addNpcToPlayerAff(o, 8);
        return { desc: `你在${locName}主持分机缘，${s.name}与${o.name}各得一份，皆念你的好` };
      }
      A.qi += 30;
      addNpcToPlayerAff(A, 10);
      return { desc: `你在${locName}助${A.name}争得机缘，${A.name}修为精进，记你一份人情` };
    }
    default:
      // 和谐类事件不提供介入，防御性兜底：空 desc 走原结算
      return { desc: '' };
  }
}
