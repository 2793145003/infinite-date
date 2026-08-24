/**
 * 玩家个人空间路由
 *
 * - GET  /me/characters           — 列出所有相关角色（含fork/记忆状态）
 * - DELETE /me/characters/:id/fork — 重置角色fork（恢复原版）
 * - DELETE /me/memory/:characterId — 清除与某角色的记忆（facts + chronicles + embeddings）
 * - DELETE /me/memory              — 清除所有记忆
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { now, jsonParse } from '../lib/util';

export async function meRoutes(app: FastifyInstance): Promise<void> {

  // 列出所有与玩家有交互的角色（有relationship/fork/facts/chronicles之一）
  // 附带 fork 状态和记忆条数
  app.get('/me/characters', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 收集所有相关 character_id
    const relChars = db.prepare('SELECT DISTINCT character_id FROM relationships WHERE player_id = ?').all(playerId) as { character_id: string }[];
    const forkChars = db.prepare('SELECT DISTINCT source_character_id AS character_id FROM character_player_data WHERE player_id = ? AND source_character_id IS NOT NULL').all(playerId) as { character_id: string }[];
    const factChars = db.prepare('SELECT DISTINCT character_id FROM player_facts WHERE player_id = ? AND character_id != ?').all(playerId, 'manual') as { character_id: string }[];
    const chronChars = db.prepare('SELECT DISTINCT character_id FROM chronicles WHERE player_id = ? AND character_id != ? AND source != ?').all(playerId, 'manual', 'dream_scenario') as { character_id: string }[];
    const friendChars = db.prepare('SELECT DISTINCT character_id FROM friendships WHERE player_id = ? AND status = ?').all(playerId, 'active') as { character_id: string }[];

    const charIds = new Set<string>();
    for (const r of [...relChars, ...forkChars, ...factChars, ...chronChars, ...friendChars]) {
      // 过滤掉无效的 character_id（undefined/null/空字符串/manual）
      if (r.character_id && r.character_id !== 'manual' && r.character_id !== 'undefined') {
        charIds.add(r.character_id);
      }
    }
    const charIdList = Array.from(charIds);

    // 查所有公共角色（用于名字解析）
    const allPubChars = db.prepare('SELECT id, character_data FROM characters').all() as { id: string; character_data: string }[];
    const pubCharMap = new Map<string, string>();
    for (const c of allPubChars) {
      const data = jsonParse<Record<string, any>>(c.character_data, {});
      pubCharMap.set(c.id, data.name ?? '未知');
    }

    const result = [];
    for (const charId of charIdList) {
      // fork 信息
      const fork = db.prepare('SELECT id, updated_at FROM character_player_data WHERE player_id = ? AND source_character_id = ?').get(playerId, charId) as
        { id: string; updated_at: number } | undefined;

      // 记忆条数
      const factCount = (db.prepare('SELECT COUNT(*) AS cnt FROM player_facts WHERE player_id = ? AND character_id = ?').get(playerId, charId) as { cnt: number }).cnt;
      const chronCount = (db.prepare('SELECT COUNT(*) AS cnt FROM chronicles WHERE player_id = ? AND character_id = ? AND source != ?').get(playerId, charId, 'dream_scenario') as { cnt: number }).cnt;

      // 好友状态 + 相伴起始时间
      const friendship = db.prepare('SELECT created_at FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, charId, 'active') as { created_at: number } | undefined;
      const isFriend = !!friendship;

      // 名字：fork优先 → 公共角色 → fallback
      let name = pubCharMap.get(charId) ?? '未知角色';
      if (fork) {
        const forkData = db.prepare('SELECT character_data FROM character_player_data WHERE id = ?').get(fork.id) as { character_data: string };
        const d = jsonParse<Record<string, any>>(forkData.character_data, {});
        if (d.name) name = d.name;
      }

      result.push({
        characterId: charId,
        name,
        hasFork: !!fork,
        forkUpdatedAt: fork?.updated_at ?? null,
        factCount,
        chronicleCount: chronCount,
        isFriend,
        friendCreatedAt: friendship?.created_at ?? null,
      });
    }

    // 按名字排序
    result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    return reply.send({ characters: result });
  });

  // 重置角色fork — 删除玩家的 character_player_data 副本，恢复使用公共模板
  app.delete('/me/characters/:id/fork', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { id } = req.params as { id: string };

    // 确认是当前玩家的 fork
    const fork = db.prepare('SELECT id FROM character_player_data WHERE player_id = ? AND source_character_id = ?').get(playerId, id) as { id: string } | undefined;
    if (!fork) {
      return reply.code(404).send({ error: '没有找到你的角色副本' });
    }

    db.prepare('DELETE FROM character_player_data WHERE id = ?').run(fork.id);
    return reply.send({ ok: true });
  });

  // 删除好友 — 彻底抹除与该角色的一切痕迹：好友、短信、对话、记忆、关系、行程、fork
  app.delete('/me/friend/:characterId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.params as { characterId: string };

    // 确认是好友
    const friend = db.prepare('SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, characterId, 'active');
    if (!friend) {
      return reply.code(404).send({ error: '没有找到好友关系' });
    }

    // 删除好友关系 — 整个操作在事务中执行，要么全成功要么全回滚
    db.exec('BEGIN');
    try {
      // 删除好友关系
      db.prepare('DELETE FROM friendships WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

      // 删除与该好友的所有约会记录（新场景引擎）：
      //   - scene_sessions 删掉，scene_messages / scene_start_snapshot / scene_round_snapshots 经 ON DELETE CASCADE 连带清除
      //   - scene_schedule_entries 是玩家各角色的跨场行程，按该角色单独删
      //   character_ids 是 JSON 数组（如 ["char1","char2"]），用 json_each 精确匹配，避免 LIKE 子串误删
      db.prepare(
        `DELETE FROM scene_sessions WHERE player_id = ? AND id IN (
           SELECT s.id FROM scene_sessions s, json_each(s.character_ids) WHERE s.player_id = ? AND json_each.value = ?
         )`
      ).run(playerId, playerId, characterId);
      db.prepare('DELETE FROM scene_schedule_entries WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
      db.prepare('DELETE FROM scene_relationships WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

      // 删除短信线程和短信
      db.prepare('DELETE FROM text_messages WHERE thread_id IN (SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?)').run(playerId, characterId);
      db.prepare('DELETE FROM message_threads WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

      // 删除约会对话记录
      db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM conversation_sessions WHERE player_id = ? AND character_id = ?)').run(playerId, characterId);
      db.prepare('DELETE FROM conversation_sessions WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

      // 删除记忆：facts + chronicles + embeddings + description_changes
      const factIds = db.prepare('SELECT id FROM player_facts WHERE player_id = ? AND character_id = ?').all(playerId, characterId) as { id: string }[];
      if (factIds.length > 0) {
        const placeholders = factIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM memory_embeddings WHERE source_type = 'fact' AND source_id IN (${placeholders})`).run(...factIds.map(f => f.id));
      }
      db.prepare('DELETE FROM player_facts WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
      db.prepare('DELETE FROM chronicles WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
      db.prepare('DELETE FROM memory_embeddings WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
      db.prepare('DELETE FROM description_changes WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

      // 删除场景引擎记忆层（turn_* 表）——空间「记忆」页读这两张表，此前漏删导致删好友后记忆残留
      // turn_player_facts 有 FK 到 players（player_id），无 FK 到 character_id，须显式删
      db.prepare('DELETE FROM turn_memory_fold WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
      db.prepare('DELETE FROM turn_player_facts WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
      // 导演场记（__director__）按本场 session 归属；其会话已在上方随 scene_sessions 一起删掉，
      // 这里按 session 兜底清掉孤儿，避免留垃圾（不显示给玩家但保持整洁）
      db.prepare(
        "DELETE FROM turn_memory_fold WHERE player_id = ? AND character_id = '__director__' AND scene_session_id NOT IN (SELECT id FROM scene_sessions WHERE player_id = ?)"
      ).run(playerId, playerId);

      // 删除关系数值
      db.prepare('DELETE FROM relationships WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

      // 删除角色卡fork
      db.prepare('DELETE FROM character_player_data WHERE player_id = ? AND source_character_id = ?').run(playerId, characterId);

      // 删除朋友圈：NPC发的帖子 + NPC的评论/点赞 + moment_interactions经CASCADE清理
      db.prepare('DELETE FROM moment_interactions WHERE moment_id IN (SELECT id FROM moments WHERE player_id = ? AND author_id = ?)').run(playerId, characterId);
      db.prepare('DELETE FROM moments WHERE player_id = ? AND author_id = ?').run(playerId, characterId);
      // NPC对该玩家帖子的评论/点赞（限定当前玩家的 feed，避免越界删掉其他玩家朋友圈下该 NPC 的点赞/评论）
      db.prepare('DELETE FROM moment_interactions WHERE author_type = ? AND author_id = ? AND moment_id IN (SELECT id FROM moments WHERE player_id = ?)').run('character', characterId, playerId);

      // 删除角色卡评论和点赞
      db.prepare('DELETE FROM character_comments WHERE character_id = ? AND player_id = ?').run(characterId, playerId);
      db.prepare('DELETE FROM character_likes WHERE character_id = ? AND player_id = ?').run(characterId, playerId);

      // 删除NPC权限钱包和交易记录
      db.prepare('DELETE FROM character_permissions WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
      db.prepare('DELETE FROM permission_transactions WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return reply.send({ ok: true });
  });

  // 清除与某角色的记忆 — facts + chronicles + embeddings（不影响对话记录和短信）
  app.delete('/me/memory/:characterId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.params as { characterId: string };

    // 删除 facts
    const factIds = db.prepare('SELECT id FROM player_facts WHERE player_id = ? AND character_id = ?').all(playerId, characterId) as { id: string }[];
    if (factIds.length > 0) {
      const placeholders = factIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM memory_embeddings WHERE source_type = 'fact' AND source_id IN (${placeholders})`).run(...factIds.map(f => f.id));
    }
    db.prepare('DELETE FROM player_facts WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

    // 删除 chronicles
    db.prepare('DELETE FROM chronicles WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

    // 删除该角色的其他 embeddings（description_changes 等）
    db.prepare('DELETE FROM memory_embeddings WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

    // 删除 description_changes
    db.prepare('DELETE FROM description_changes WHERE player_id = ? AND character_id = ?').run(playerId, characterId);

    return reply.send({ ok: true });
  });

  // 清除所有记忆 — 所有角色的 facts + chronicles + embeddings
  app.delete('/me/memory', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 删除所有 facts 及其 embeddings
    db.prepare("DELETE FROM memory_embeddings WHERE player_id = ? AND source_type = 'fact'").run(playerId);
    db.prepare('DELETE FROM player_facts WHERE player_id = ?').run(playerId);

    // 删除所有 chronicles
    db.prepare('DELETE FROM chronicles WHERE player_id = ?').run(playerId);

    // 删除所有其他 embeddings
    db.prepare('DELETE FROM memory_embeddings WHERE player_id = ?').run(playerId);

    // 删除所有 description_changes
    db.prepare('DELETE FROM description_changes WHERE player_id = ?').run(playerId);

    return reply.send({ ok: true });
  });
}
