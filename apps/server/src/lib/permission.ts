/**
 * 权限系统
 * 玩家权限：创建NPC、创建地点、撤回、独白窥探等
 * NPC权限：创建所属世界地点等（Phase 4任务系统启用）
 *
 * 设计原则（DESIGN.md）：
 * - 不设魔法数字阈值——等实测负载后用数据决定
 * - MVP阶段先手动发放，跑通流程后再做自动调节
 * - 权限是限制玩家能创建的内容总量，防止单人无限创建压垮GPU
 */
import { db } from '../db';
import { genId, now } from './util';

type WalletType = 'player' | 'character';

interface WalletRow {
  balance: number;
  total_earned: number;
  total_spent: number;
  updated_at: number;
}

/**
 * 获取玩家权限余额
 */
export function getPlayerBalance(playerId: string): number {
  const row = db.prepare('SELECT balance FROM player_permissions WHERE player_id = ?').get(playerId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

/**
 * 获取NPC实例权限余额
 */
export function getCharacterBalance(playerId: string, characterId: string, instanceId: string): number {
  const row = db.prepare('SELECT balance FROM character_permissions WHERE player_id = ? AND character_id = ? AND character_instance_id = ?').get(playerId, characterId, instanceId) as { balance: number } | undefined;
  return row?.balance ?? 0;
}

/**
 * 确保玩家权限钱包存在（不存在则创建0余额）
 */
export function ensurePlayerWallet(playerId: string): void {
  const ts = now();
  db.prepare(`INSERT OR IGNORE INTO player_permissions (player_id, balance, total_earned, total_spent, updated_at) VALUES (?, 0, 0, 0, ?)`).run(playerId, ts);
}

/**
 * 消耗权限。余额不足返回false。
 * 同时写入 permission_transactions 交易记录。
 * 并发安全：用单条原子 UPDATE ... WHERE balance >= ? 扣费，changes=0（余额不足或并发已扣）即失败。
 */
export function spendPlayerPermission(playerId: string, amount: number, reason: string, sourceId?: string): { ok: boolean; balanceAfter: number } {
  ensurePlayerWallet(playerId);
  const ts = now();
  // 原子扣费：余额不足或并发已被其它请求扣走 → changes=0
  const res = db.prepare(
    'UPDATE player_permissions SET balance = balance - ?, total_spent = total_spent + ?, updated_at = ? WHERE player_id = ? AND balance >= ?'
  ).run(amount, amount, ts, playerId, amount);
  if (res.changes === 0) {
    const balance = getPlayerBalance(playerId);
    return { ok: false, balanceAfter: balance };
  }
  const newBalance = getPlayerBalance(playerId);
  db.prepare(`INSERT INTO permission_transactions (id, player_id, wallet_type, delta, reason, source_id, balance_after, created_at) VALUES (?, ?, 'player', ?, ?, ?, ?, ?)`).run(genId(), playerId, -amount, reason, sourceId ?? null, newBalance, ts);
  return { ok: true, balanceAfter: newBalance };
}

/**
 * 发放权限（管理员手动 or 任务奖励）
 * 并发安全：原子 UPDATE balance = balance + 再读回。
 */
export function grantPlayerPermission(playerId: string, amount: number, reason: string, sourceId?: string): number {
  ensurePlayerWallet(playerId);
  const ts = now();
  db.prepare(
    'UPDATE player_permissions SET balance = balance + ?, total_earned = total_earned + ?, updated_at = ? WHERE player_id = ?'
  ).run(amount, amount, ts, playerId);
  const newBalance = getPlayerBalance(playerId);
  db.prepare(`INSERT INTO permission_transactions (id, player_id, wallet_type, delta, reason, source_id, balance_after, created_at) VALUES (?, ?, 'player', ?, ?, ?, ?, ?)`).run(genId(), playerId, amount, reason, sourceId ?? null, newBalance, ts);
  return newBalance;
}

/** 给 NPC 实例发放权限（任务奖励）。先 INSERT OR IGNORE 钱包再 UPDATE。 */
export function grantCharacterPermission(
  playerId: string,
  characterId: string,
  instanceId: string,
  amount: number,
  reason: string,
  sourceId?: string,
): void {
  const ts = now();
  db.prepare(`
    INSERT OR IGNORE INTO character_permissions (player_id, character_id, character_instance_id, balance, total_earned, total_spent, updated_at)
    VALUES (?, ?, ?, 0, 0, 0, ?)
  `).run(playerId, characterId, instanceId, ts);

  const row = db.prepare('SELECT balance, total_earned FROM character_permissions WHERE player_id = ? AND character_id = ? AND character_instance_id = ?').get(playerId, characterId, instanceId) as { balance: number; total_earned: number };
  const newBalance = row.balance + amount;
  db.prepare('UPDATE character_permissions SET balance = ?, total_earned = ?, updated_at = ? WHERE player_id = ? AND character_id = ? AND character_instance_id = ?')
    .run(newBalance, row.total_earned + amount, ts, playerId, characterId, instanceId);

  db.prepare(`
    INSERT INTO permission_transactions (id, player_id, character_id, character_instance_id, wallet_type, delta, reason, source_id, balance_after, created_at)
    VALUES (?, ?, ?, ?, 'character', ?, ?, ?, ?, ?)
  `).run(genId(), playerId, characterId, instanceId, amount, reason, sourceId ?? null, newBalance, ts);
}
