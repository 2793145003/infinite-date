// 五行生克 → 六亲。纯函数，O(1)，不存任何关系表。
// 这是整个演化的地基，必须可证（见 world-wuxing.test.ts）。

import type { Kinship, Wx } from './types';

// 相生：我生谁
const SHENG: Record<Wx, Wx> = { 金: '水', 水: '木', 木: '火', 火: '土', 土: '金' };
// 相克：我克谁
const KE: Record<Wx, Wx> = { 金: '木', 木: '土', 土: '水', 水: '火', 火: '金' };

export const ALL_WX: readonly Wx[] = ['金', '木', '水', '火', '土'];

// 我生谁
export function sheng(self: Wx): Wx {
  return SHENG[self];
}

// 我克谁
export function ke(self: Wx): Wx {
  return KE[self];
}

// 谁生我（生我的五行）
export function shengMe(self: Wx): Wx {
  return ALL_WX.find((w) => SHENG[w] === self)!;
}

// 谁克我（克我的五行）
export function keMe(self: Wx): Wx {
  return ALL_WX.find((w) => KE[w] === self)!;
}

// 六亲：从「我」的视角看「对方」
//   生我者=父母（靠山/长辈）
//   我生者=子孙（晚辈/我付出）
//   克我者=官鬼（压制/仇敌/上司）
//   我克者=妻财（掌控/猎物/配偶/财富）
//   同五行=兄弟（比和）
export function kinship(self: Wx, other: Wx): Kinship {
  if (self === other) return '兄弟';
  if (SHENG[other] === self) return '父母'; // 对方生我
  if (SHENG[self] === other) return '子孙'; // 我生对方
  if (KE[other] === self) return '官鬼';    // 对方克我
  return '妻财';                             // 我克对方
}

// 关系成对互补：B 克 A 时，A 眼里 B 是官鬼，B 眼里 A 是妻财。
// 该性质由 kinship 天然满足，这里提供一个「互补对」查询，用于叙事与事件走向。
export function isXiangSheng(a: Wx, b: Wx): boolean {
  return SHENG[a] === b || SHENG[b] === a;
}

export function isXiangKe(a: Wx, b: Wx): boolean {
  return KE[a] === b || KE[b] === a;
}
