/**
 * 角色编辑路由（普通用户版）
 *
 * - GET /characters/:characterId/edit — 获取角色数据用于编辑（fork 优先）
 * - POST /characters/:characterId/fork — 保存编辑后的角色卡为 fork
 *
 * fork 机制：
 * - 公共角色：编辑后写入 character_player_data（source_character_id 指向原角色），不修改原 characters 表
 * - 私有角色：直接更新 character_player_data 自身
 * - 不消耗权限（编辑不创建新角色，只改自己的副本）
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { loadCharacterData } from '../lib/character';
import type { CharacterData } from '@idate/shared';

export async function characterRoutes(app: FastifyInstance): Promise<void> {

  // 获取角色数据用于编辑
  app.get('/characters/:characterId/edit', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { characterId } = req.params as { characterId: string };

    const data = loadCharacterData(playerId, characterId);
    if (!data) {
      return reply.code(404).send({ error: '角色不存在' });
    }

    // 越权防护：私有角色（不在公共 characters 表）必须是当前玩家自己的，
    // 否则任何人凭 id 都能读取他人私密角色设定。
    const isPublicChar = !!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(characterId);
    if (!isPublicChar) {
      const owned = db.prepare(
        'SELECT 1 FROM character_player_data WHERE id = ? AND player_id = ?'
      ).get(characterId, playerId);
      if (!owned) {
        return reply.code(403).send({ error: '无权访问该角色' });
      }
    }

    // 标记是否已有 fork
    const hasFork = !!db.prepare(
      'SELECT 1 FROM character_player_data WHERE player_id = ? AND source_character_id = ?'
    ).get(playerId, characterId);

    // 有 fork 时额外返回公共原版，供前端对比
    let publicData: CharacterData | null = null;
    if (hasFork) {
      const pubChar = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
      if (pubChar) {
        publicData = jsonParse<CharacterData | null>(pubChar.character_data, null);
      }
    }

    return reply.send({
      characterData: data,
      hasFork,
      isPublic: !!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(characterId),
      publicData,
    });
  });

  // 保存编辑后的角色卡为 fork
  app.post('/characters/:characterId/fork', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { characterId } = req.params as { characterId: string };
    const { characterData } = req.body as { characterData?: CharacterData };

    if (!characterData) {
      return reply.code(400).send({ error: '缺少角色数据' });
    }

    if (!characterData.name?.trim()) {
      return reply.code(400).send({ error: '角色名不能为空' });
    }

    const ts = now();
    const json = JSON.stringify(characterData);

    // 检查是公共角色还是私有角色
    const pubChar = db.prepare('SELECT 1 FROM characters WHERE id = ?').get(characterId);

    if (pubChar) {
      // 公共角色：创建或更新 fork（character_player_data with source_character_id）
      const existing = db.prepare(
        'SELECT id FROM character_player_data WHERE player_id = ? AND source_character_id = ?'
      ).get(playerId, characterId) as { id: string } | undefined;

      if (existing) {
        db.prepare('UPDATE character_player_data SET character_data = ?, updated_at = ? WHERE id = ?')
          .run(json, ts, existing.id);
      } else {
        db.prepare(
          'INSERT INTO character_player_data (id, source_character_id, player_id, character_data, is_free_override, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
        ).run(genId(), characterId, playerId, json, ts, ts);
      }

      return reply.send({ ok: true, forked: true });
    } else {
      // 私有角色：直接更新自身（source_character_id IS NULL）
      const privChar = db.prepare(
        'SELECT id FROM character_player_data WHERE id = ? AND player_id = ?'
      ).get(characterId, playerId) as { id: string } | undefined;

      if (!privChar) {
        return reply.code(404).send({ error: '角色不存在或无权编辑' });
      }

      db.prepare('UPDATE character_player_data SET character_data = ?, updated_at = ? WHERE id = ?')
        .run(json, ts, privChar.id);

      return reply.send({ ok: true, forked: false });
    }
  });
}
