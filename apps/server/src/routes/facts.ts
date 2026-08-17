/**
 * Player Facts 路由 — 查看 / 编辑 / 删除
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now } from '../lib/util';
import { embed, storeEmbedding } from '../lib/embedding';

// SAFE_JOIN：把 character_id 映射为角色名
const CHAR_NAME_SQL = `COALESCE(c.character_data->>'$.name', '未知角色')`;

export async function factsRoutes(app: FastifyInstance): Promise<void> {
  // 获取玩家的所有 facts —— v2 主表 turn_player_facts（场景新记忆）
  app.get('/facts', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const facts = db.prepare(`
      SELECT t.id, t.character_id, t.fact, t.round_no,
             'scene' AS source, t.created_at, t.created_at AS updated_at,
             ${CHAR_NAME_SQL} AS character_name
      FROM turn_player_facts t
      LEFT JOIN characters c ON t.character_id = c.id
      WHERE t.player_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM scene_sessions s
          WHERE s.id = t.scene_session_id AND s.scene_type = 'scenario'
        )
      ORDER BY t.character_id, t.created_at DESC
    `).all(playerId) as Array<{
      id: string; character_id: string; fact: string; round_no: number;
      source: string; created_at: number; updated_at: number; character_name: string;
    }>;

    return reply.send({ facts });
  });

  // 旧 player_facts —— 只读折叠页签（不动旧表，旧表零改写红线）
  app.get('/facts/legacy', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const facts = db.prepare(`
      SELECT pf.id, pf.character_id, pf.fact, pf.source, pf.created_at, pf.updated_at,
             ${CHAR_NAME_SQL} AS character_name
      FROM player_facts pf
      LEFT JOIN characters c ON pf.character_id = c.id
      WHERE pf.player_id = ?
      ORDER BY pf.character_id, pf.updated_at DESC
    `).all(playerId) as Array<{
      id: string; character_id: string; fact: string; source: string;
      created_at: number; updated_at: number; character_name: string;
    }>;

    return reply.send({ facts });
  });

  // 编辑 fact 内容（turn_player_facts）
  app.patch('/facts/:id', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { id } = req.params as { id: string };
    const { fact } = req.body as { fact?: string };

    if (!fact || !fact.trim()) {
      return reply.code(400).send({ error: '内容不能为空' });
    }

    const existing = db.prepare('SELECT character_id FROM turn_player_facts WHERE id = ? AND player_id = ?').get(id, playerId) as { character_id: string } | undefined;
    if (!existing) {
      return reply.code(404).send({ error: '事实不存在' });
    }

    db.prepare('UPDATE turn_player_facts SET fact = ? WHERE id = ?').run(fact.trim(), id);

    // 更新对应的 embedding
    db.prepare('DELETE FROM memory_embeddings WHERE source_type = ? AND source_id = ?').run('turn_player_fact', id);
    const newVec = await embed(fact.trim());
    if (newVec) {
      storeEmbedding(playerId, existing.character_id, 'turn_player_fact', id, fact.trim(), newVec);
    }

    return reply.send({ ok: true });
  });

  // 删除 fact（turn_player_facts）
  app.delete('/facts/:id', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { id } = req.params as { id: string };

    const existing = db.prepare('SELECT 1 FROM turn_player_facts WHERE id = ? AND player_id = ?').get(id, playerId);
    if (!existing) {
      return reply.code(404).send({ error: '事实不存在' });
    }

    db.prepare('DELETE FROM turn_player_facts WHERE id = ?').run(id);
    db.prepare('DELETE FROM memory_embeddings WHERE source_type = ? AND source_id = ?').run('turn_player_fact', id);

    return reply.send({ ok: true });
  });

  // 手动添加 fact（turn_player_facts）
  app.post('/facts', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { fact, characterId } = req.body as { fact?: string; characterId?: string };

    if (!fact || !fact.trim()) {
      return reply.code(400).send({ error: '内容不能为空' });
    }

    const id = genId();
    const ts = now();
    const cid = characterId || 'manual';

    db.prepare(`
      INSERT INTO turn_player_facts (id, player_id, character_id, scene_session_id, round_no, fact, created_at)
      VALUES (?, ?, ?, NULL, 0, ?, ?)
    `).run(id, playerId, cid, fact.trim(), ts);

    // 向量化
    const vec = await embed(fact.trim());
    if (vec) {
      storeEmbedding(playerId, cid, 'turn_player_fact', id, fact.trim(), vec);
    }

    return reply.send({ ok: true, id });
  });
}
