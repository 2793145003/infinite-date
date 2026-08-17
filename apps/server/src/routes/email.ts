/**
 * 邮件路由
 * 系统通知 / 任务邮件 / 男主来信
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now } from '../lib/util';
import { loadCharacterData } from '../lib/character';

export async function emailRoutes(app: FastifyInstance): Promise<void> {
  // 获取邮件列表
  app.get('/emails', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const emails = db.prepare(`
      SELECT id, sender_type, character_id, subject, body, is_read, created_at
      FROM emails WHERE player_id = ? ORDER BY created_at DESC
    `).all(playerId) as Array<{
      id: string; sender_type: string; character_id: string | null;
      subject: string; body: string; is_read: number; created_at: number;
    }>;

    const enriched = emails.map((e) => {
      let senderName = '系统';
      if (e.sender_type === 'deity') senderName = '主神';
      else if (e.sender_type === 'npc' && e.character_id) {
        senderName = loadCharacterData(playerId, e.character_id)?.name ?? '角色';
      }
      return { ...e, sender_name: senderName };
    });

    return reply.send({ emails: enriched });
  });

  // 标记邮件已读
  app.post('/emails/:emailId/read', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { emailId } = req.params as { emailId: string };
    db.prepare('UPDATE emails SET is_read = 1 WHERE id = ? AND player_id = ?').run(emailId, playerId);

    return reply.send({ ok: true });
  });

  // 获取未读邮件数
  app.get('/emails/unread-count', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const row = db.prepare('SELECT COUNT(*) as count FROM emails WHERE player_id = ? AND is_read = 0').get(playerId) as { count: number };
    return reply.send({ count: row.count });
  });
}

/** 系统发邮件（内部调用）。characterId 可选：男主来信时标识发件角色 */
export function sendEmail(playerId: string, senderType: string, subject: string, body: string, characterId?: string): string {
  const id = genId();
  db.prepare(`
    INSERT INTO emails (id, player_id, sender_type, character_id, subject, body, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, playerId, senderType, characterId ?? null, subject, body, now());
  return id;
}
