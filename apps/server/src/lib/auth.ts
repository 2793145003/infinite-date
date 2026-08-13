/**
 * 认证系统
 * 邀请码→player_id，session token持久化到DB，重启不丢
 */
import { db } from '../db/index';
import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7天

export function createPlayer(playerId: string, name: string, inviteCode: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO players (id, name, pronouns, persona_notes, tutorial_step, rating_score, created_at, updated_at)
     VALUES (?, ?, '', '', 0, 0, ?, ?)`,
  ).run(playerId, name, now, now);

  db.prepare(
    `INSERT INTO invite_codes (code, player_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)`,
  ).run(inviteCode, playerId, now);

  db.prepare(
    `INSERT INTO player_permissions (player_id, balance, total_earned, total_spent, updated_at)
     VALUES (?, 0, 0, 0, ?)`,
  ).run(playerId, now);
}

export function validateInviteCode(code: string): string | null {
  const row = db.prepare(
    `SELECT player_id FROM invite_codes WHERE code = ? AND revoked_at IS NULL`,
  ).get(code) as { player_id: string } | undefined;
  return row?.player_id ?? null;
}

export function issueToken(playerId: string): string {
  const token = crypto.randomUUID();
  const now = Date.now();
  // 清理同一玩家的旧token（只保留最新）
  db.prepare('DELETE FROM sessions WHERE player_id = ?').run(playerId);
  db.prepare(
    `INSERT INTO sessions (token, player_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(token, playerId, now, now + TOKEN_TTL);
  return token;
}

export function getPlayerIdFromRequest(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const row = db.prepare(
    `SELECT player_id FROM sessions WHERE token = ? AND expires_at > ?`,
  ).get(token, Date.now()) as { player_id: string } | undefined;
  return row?.player_id ?? null;
}

export function requireAuth(req: FastifyRequest, reply: FastifyReply): string | null {
  const playerId = getPlayerIdFromRequest(req);
  if (!playerId) {
    reply.code(401).send({ error: '未认证。请输入邀请码。' });
    return null;
  }
  return playerId;
}

/** 管理员校验：先 requireAuth，再查 is_admin。非管理员返回 403。 */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): string | null {
  const playerId = requireAuth(req, reply);
  if (!playerId) return null;
  const row = db.prepare('SELECT is_admin FROM players WHERE id = ?').get(playerId) as { is_admin: number } | undefined;
  if (!row?.is_admin) {
    reply.code(403).send({ error: '需要管理员权限' });
    return null;
  }
  return playerId;
}

// ─── 管理工具 ─────────────────────────────────────────────

export function adminCreatePlayer(name: string): { playerId: string; inviteCode: string } {
  const playerId = crypto.randomUUID();
  const inviteCode = 'ID-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  createPlayer(playerId, name, inviteCode);
  return { playerId, inviteCode };
}

export function cliCreatePlayer(name: string): void {
  const { playerId, inviteCode } = adminCreatePlayer(name);
  console.log(`✅ 玩家创建成功`);
  console.log(`   名字: ${name}`);
  console.log(`   Player ID: ${playerId}`);
  console.log(`   邀请码: ${inviteCode}`);
}

if (process.argv[1]?.endsWith('auth.ts') && process.argv[2]) {
  cliCreatePlayer(process.argv[2]);
}
