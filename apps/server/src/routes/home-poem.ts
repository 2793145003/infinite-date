/**
 * 首页每日寄语路由
 *
 * GET /api/home-poem?characterId=xxx
 * 按 (player × character × 北京时区 date_key) 幂等：当天已生成直接复用，未生成现场写一句并落库。
 * 生成失败返回 { poem: null }，前端兜底默认句。
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now } from '../lib/util';
import { generateHomePoem, homePoemDateKey } from '../lib/home-poem';

export async function homePoemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/home-poem', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.query as { characterId?: string };
    if (!characterId) return reply.code(400).send({ error: '缺少 characterId' });

    const dateKey = homePoemDateKey();

    // 当天已生成 → 直接复用
    const cached = db.prepare(
      'SELECT poem, created_at FROM home_poems WHERE player_id=? AND character_id=? AND date_key=?'
    ).get(playerId, characterId, dateKey) as { poem: string; created_at: number } | undefined;
    if (cached) {
      return reply.send({ poem: cached.poem, generatedAt: cached.created_at });
    }

    // 未命中 → 现场生成，成功后落库（失败返回 null，前端兜底）
    const poem = await generateHomePoem(playerId, characterId);
    if (poem) {
      const ts = now();
      // 并发兜底：两请求同时未命中、都生成后，第二个 INSERT 撞唯一键时 DO NOTHING，
      // 再回读到第一个请求已落库的寄语——避免撞 idx_home_poems_unique 抛 500。
      db.prepare(
        'INSERT INTO home_poems (id, player_id, character_id, date_key, poem, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(player_id, character_id, date_key) DO NOTHING'
      ).run(genId(), playerId, characterId, dateKey, poem, ts);
      const row = db.prepare(
        'SELECT poem, created_at FROM home_poems WHERE player_id=? AND character_id=? AND date_key=?'
      ).get(playerId, characterId, dateKey) as { poem: string; created_at: number };
      return reply.send({ poem: row.poem, generatedAt: row.created_at });
    }

    return reply.send({ poem: null, generatedAt: null });
  });
}
