// 玩家 —— 女修手札式修士主角。完整数值 + 背包 + 精力/行动点。
// 玩家不是 NPC（不参与 NPC 演化），是独立实体，通过走格子、介入改写世界。

import type { Player, Realm } from './types';
import { REALM_LIFESPAN } from './types';
import { pick, randInt } from './rng';
import type { Rng } from './rng';

export interface PlayerOptions {
  name?: string;
  gender?: '男' | '女';
  loc: number;          // 初始格子
  realm?: Realm;        // 默认练气 0
}

export function createPlayer(rng: Rng, opts: PlayerOptions): Player {
  const realm = opts.realm ?? 0;
  return {
    name: opts.name ?? '无名修士',
    gender: opts.gender ?? '女', // 女修手札式，默认女修
    wx: pick(rng, ['金', '木', '水', '火', '土']),
    realm,
    qi: realm * 100 + randInt(rng, 100),
    aptitude: 50 + randInt(rng, 40),
    comprehension: 50 + randInt(rng, 40),
    charm: 50 + randInt(rng, 40),
    fortune: 50 + randInt(rng, 40),
    lifespan: Math.round(REALM_LIFESPAN[realm]! * 0.8),
    loc: opts.loc,
    backpack: [],
    energy: 100,
    actionPoints: 3,
    affinities: new Map(),
  };
}
