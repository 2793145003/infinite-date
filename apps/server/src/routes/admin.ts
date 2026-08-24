/**
 * 管理员路由
 * 公共NPC的增删改查（管理员专属）
 */
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { db } from '../db';
import { requireAuth, requireAdmin } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { grantPlayerPermission, getPlayerBalance } from '../lib/permission';
import { chat } from '../llm/adapter';
import { getBackgroundSubmissions, getNpcs, upsertNpc, updateNpc, removeNpc, ensureSceneMap } from '../lib/scene-map';
import { getPublicAvatar } from '../lib/character';

const HUB_WORLD_ID = 'default-world';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // 列出所有公共NPC
  app.get('/admin/characters', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = db.prepare('SELECT id, character_data, creator_player_id, created_at, updated_at FROM characters ORDER BY created_at DESC').all() as {
      id: string; character_data: string; creator_player_id: string | null; created_at: number; updated_at: number;
    }[];
    const npcs = rows.map(r => {
      const data = jsonParse<Record<string, unknown>>(r.character_data, {});
      return {
        id: r.id,
        name: (data.name as string) ?? '未知',
        avatar: getPublicAvatar(r.id),
        creator: r.creator_player_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        characterData: r.character_data,
      };
    });
    return reply.send({ characters: npcs });
  });

  // 更新公共NPC角色卡
  app.patch('/admin/characters/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { characterData } = req.body as { characterData?: string };

    if (!characterData) {
      return reply.code(400).send({ error: '需要characterData' });
    }

    // 验证JSON
    try {
      JSON.parse(characterData);
    } catch {
      return reply.code(400).send({ error: '角色卡JSON格式无效' });
    }

    const existing = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(id) as { character_data: string } | undefined;
    if (!existing) {
      return reply.code(404).send({ error: '角色不存在' });
    }

    const ts = now();
    db.prepare('UPDATE characters SET character_data = ?, updated_at = ? WHERE id = ?').run(characterData, ts, id);

    // 记录编辑日志
    db.prepare(`
      INSERT INTO character_edit_log (id, character_id, editor_type, editor_id, field, old_value, new_value, status, created_at)
      VALUES (?, ?, 'admin', ?, 'character_data', ?, ?, 'applied', ?)
    `).run(genId(), id, String(req.headers['x-player-id'] ?? ''), existing.character_data, characterData, ts);

    return reply.send({ ok: true });
  });

  // 列出某公共角色的所有玩家override副本
  app.get('/admin/characters/:id/overrides', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const rows = db.prepare(`
      SELECT cpd.id, cpd.player_id, cpd.character_data, cpd.updated_at, p.name as player_name
      FROM character_player_data cpd
      LEFT JOIN players p ON p.id = cpd.player_id
      WHERE cpd.source_character_id = ?
      ORDER BY cpd.updated_at DESC
    `).all(id) as {
      id: string; player_id: string; character_data: string; updated_at: number; player_name: string;
    }[];
    const overrides = rows.map(r => ({
      id: r.id,
      playerId: r.player_id,
      playerName: r.player_name || '(未命名)',
      characterData: r.character_data,
      updatedAt: r.updated_at,
    }));
    return reply.send({ overrides });
  });

  // 重新生成背景里程碑（基于角色卡现有内容）
  app.post('/admin/characters/:id/regenerate-milestones', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };

    const row = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(id) as { character_data: string } | undefined;
    if (!row) return reply.code(404).send({ error: '角色不存在' });

    const char = jsonParse<Record<string, any>>(row.character_data, {});

    const personalityParts = [
      char.personality?.surface,
      char.personality?.core,
      char.personality?.extreme,
    ].filter(Boolean).join('；');

    const backgroundParts = [
      char.background?.origin ? `出身：${char.background.origin}` : '',
      char.background?.shaping ? `经历：${char.background.shaping}` : '',
      char.background?.current ? `现状：${char.background.current}` : '',
    ].filter(Boolean).join('\n');

    const messages = [
      {
        role: 'system' as const,
        content: `你是一个角色背景故事生成器。根据角色的性格、背景、喜好等信息，生成2-4个人生关键转折点（里程碑）。

要求：
- 里程碑必须与角色的background（出身/经历/现状）严格一致，不要编造与背景矛盾的事件
- 每条含 label（事件简称，2-6字）、time_description（发生在什么时候，如"幼年""大学时期"）、summary（2-3句事件概述）、dramatic_potential（"high"|"medium"|"low"）
- summary 要具体，写清楚事件经过和对角色的影响
- 输出JSON数组，不要加任何解释文字

示例输出：
[
  {"label":"父亲牺牲","time_description":"12岁","summary":"父亲在一次行动中牺牲，从此与母亲相依为命。这件事让他过早地学会了承担责任。","dramatic_potential":"high"},
  {"label":"创业受挫","time_description":"大学毕业后","summary":"第一次创业失败，赔光了积蓄。但这段经历让他学会了风险控制和逆境求生。","dramatic_potential":"medium"}
]`,
      },
      {
        role: 'user' as const,
        content: `角色名：${char.name ?? '未知'}
年龄：${char.age ?? '未知'}
性格：${personalityParts || '未指定'}
背景：
${backgroundParts || '未指定'}
喜好：${Array.isArray(char.likes) ? char.likes.map((l: any) => typeof l === 'string' ? l : l?.item).filter(Boolean).join('、') : '未指定'}
擅长：${char.skills ?? '未指定'}
不擅长：${char.ineptitudes ?? '未指定'}

请生成这个角色的背景里程碑：`,
      },
    ];

    try {
      const result = await chat(messages, { temperature: 0.9, maxTokens: 1024 });
      let text = result.content.trim();
      // 防御：去掉可能的 markdown 代码块包裹
      text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        return reply.code(500).send({ error: '生成结果格式错误（非数组）' });
      }
      // 规范化
      const milestones = parsed.map((item: any) => {
        if (typeof item === 'string') {
          return { label: item, time_description: '', summary: '', diff: {}, dramatic_potential: 'medium' as const };
        }
        const dp = item?.dramatic_potential;
        return {
          label: String(item?.label ?? ''),
          time_description: String(item?.time_description ?? ''),
          summary: String(item?.summary ?? ''),
          diff: {},
          dramatic_potential: dp === 'high' || dp === 'low' ? dp : 'medium' as const,
        };
      });
      return reply.send({ milestones });
    } catch {
      return reply.code(500).send({ error: '生成失败，请重试' });
    }
  });

  // 删除公共NPC
  app.delete('/admin/characters/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };

    const existing = db.prepare('SELECT id FROM characters WHERE id = ?').get(id);
    if (!existing) {
      return reply.code(404).send({ error: '角色不存在' });
    }

    // ── 事务包裹：跨 12+ 表删除，任一失败必须整体回滚 ──
    db.exec('BEGIN');
    try {
      // 清理关联数据
      db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM conversation_sessions WHERE character_id = ?)').run(id);
      db.prepare('DELETE FROM conversation_sessions WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM relationships WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM chronicles WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM friendships WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM character_edit_log WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM character_likes WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM character_comments WHERE character_id = ?').run(id);
      // 新场景引擎表：按角色的关系/行程/记忆折叠清理（不动玩家的 scene_sessions 约会记录——历史回忆保留）
      db.prepare('DELETE FROM scene_relationships WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM scene_schedule_entries WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM turn_memory_fold WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM turn_player_facts WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM memory_embeddings WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM scene_homes WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM characters WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      app.log.error({ err }, '删除角色失败，已回滚');
      return reply.code(500).send({ error: '删除失败，数据已回滚' });
    }

    return reply.send({ ok: true });
  });

  // 手动发放权限给玩家
  app.post('/admin/grant-permission', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { playerId, amount, reason } = req.body as { playerId?: string; amount?: number; reason?: string };

    if (!playerId) {
      return reply.code(400).send({ error: '需要playerId' });
    }
    if (!amount || amount <= 0) {
      return reply.code(400).send({ error: '数量必须大于0' });
    }

    const player = db.prepare('SELECT id FROM players WHERE id = ?').get(playerId);
    if (!player) {
      return reply.code(404).send({ error: '玩家不存在' });
    }

    const newBalance = grantPlayerPermission(playerId, amount, reason || '管理员手动发放');
    return reply.send({ ok: true, playerId, balanceAfter: newBalance });
  });

  // 查看玩家权限余额
  app.get('/admin/permissions/:playerId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { playerId } = req.params as { playerId: string };
    const balance = getPlayerBalance(playerId);
    const txs = db.prepare('SELECT id, delta, reason, balance_after, created_at FROM permission_transactions WHERE player_id = ? ORDER BY created_at DESC LIMIT 20').all(playerId) as Array<{
      id: string; delta: number; reason: string; balance_after: number; created_at: number;
    }>;
    return reply.send({ playerId, balance, transactions: txs });
  });

  // ─── 邀请码管理 ──────────────────────────────────────────────

  // 列出所有邀请码（含玩家信息 + 最后登录时间）
  app.get('/admin/invite-codes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = db.prepare(`
      SELECT ic.code, ic.player_id, ic.created_at, ic.revoked_at,
             p.name AS player_name, p.is_admin,
             pp.balance AS permission_balance,
             (SELECT MAX(s.created_at) FROM sessions s WHERE s.player_id = ic.player_id) AS last_login_at
      FROM invite_codes ic
      LEFT JOIN players p ON p.id = ic.player_id
      LEFT JOIN player_permissions pp ON pp.player_id = ic.player_id
      ORDER BY ic.created_at DESC
    `).all() as Array<{
      code: string; player_id: string; created_at: number; revoked_at: number | null;
      player_name: string; is_admin: number; permission_balance: number | null;
      last_login_at: number | null;
    }>;
    const codes = rows.map(r => ({
      code: r.code,
      playerId: r.player_id,
      playerName: r.player_name,
      isAdmin: !!r.is_admin,
      permissionBalance: r.permission_balance ?? 0,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
      active: r.revoked_at === null,
      lastLoginAt: r.last_login_at ?? null,
    }));
    return reply.send({ codes });
  });

  // 创建新邀请码（名字由玩家首次登录时自己输入）
  app.post('/admin/invite-codes', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { permissionAmount } = req.body as { permissionAmount?: number };

    const playerId = crypto.randomUUID();
    const inviteCode = 'ID-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const ts = now();
    db.prepare(
      `INSERT INTO players (id, name, pronouns, persona_notes, tutorial_step, rating_score, is_admin, created_at, updated_at)
       VALUES (?, '', '', '', 0, 0, 0, ?, ?)`,
    ).run(playerId, ts, ts);
    db.prepare(
      'INSERT INTO invite_codes (code, player_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)',
    ).run(inviteCode, playerId, ts);
    db.prepare(
      'INSERT INTO player_permissions (player_id, balance, total_earned, total_spent, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(playerId, ts);

    // 可选：创建时发放初始权限
    if (permissionAmount && permissionAmount > 0) {
      grantPlayerPermission(playerId, permissionAmount, '管理员创建账号初始发放');
    }

    return reply.send({
      ok: true,
      code: inviteCode,
      playerId,
      permissionBalance: permissionAmount ?? 0,
    });
  });

  // 吊销邀请码
  app.post('/admin/invite-codes/:code/revoke', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { code } = req.params as { code: string };
    const existing = db.prepare('SELECT code, revoked_at FROM invite_codes WHERE code = ?').get(code) as
      | { code: string; revoked_at: number | null }
      | undefined;
    if (!existing) {
      return reply.code(404).send({ error: '邀请码不存在' });
    }
    if (existing.revoked_at !== null) {
      return reply.code(400).send({ error: '邀请码已被吊销' });
    }
    // 不能吊销自己的邀请码
    const adminId = requireAuth(req, reply);
    const myCode = db.prepare('SELECT code FROM invite_codes WHERE player_id = ?').get(adminId) as { code: string } | undefined;
    if (myCode?.code === code) {
      return reply.code(400).send({ error: '不能吊销自己的邀请码' });
    }
    db.prepare('UPDATE invite_codes SET revoked_at = ? WHERE code = ?').run(now(), code);
    // 同时清除该玩家的活跃session，立即生效
    db.prepare('DELETE FROM sessions WHERE player_id = (SELECT player_id FROM invite_codes WHERE code = ?)').run(code);
    return reply.send({ ok: true });
  });

  // 删除已吊销的邀请码（连同玩家数据一并清理）
  app.delete('/admin/invite-codes/:code', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { code } = req.params as { code: string };
    const row = db.prepare('SELECT code, player_id, revoked_at FROM invite_codes WHERE code = ?').get(code) as
      | { code: string; player_id: string; revoked_at: number | null }
      | undefined;
    if (!row) {
      return reply.code(404).send({ error: '邀请码不存在' });
    }
    if (row.revoked_at === null) {
      return reply.code(400).send({ error: '只能删除已吊销的邀请码' });
    }
    // 不能删除自己的邀请码
    const adminId = requireAuth(req, reply);
    if (row.player_id === adminId) {
      return reply.code(400).send({ error: '不能删除自己的邀请码' });
    }

    const playerId = row.player_id;
    // ── 事务包裹：跨 25+ 表删除，任一失败必须整体回滚 ──
    db.exec('BEGIN');
    try {
      // 清理玩家所有关联数据
      db.prepare('DELETE FROM sessions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM messages WHERE session_id IN (SELECT id FROM conversation_sessions WHERE player_id = ?)').run(playerId);
      db.prepare('DELETE FROM conversation_sessions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM explore_messages WHERE explore_session_id IN (SELECT id FROM explore_sessions WHERE player_id = ?)').run(playerId);
      db.prepare('DELETE FROM explore_sessions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM text_messages WHERE thread_id IN (SELECT id FROM message_threads WHERE player_id = ?)').run(playerId);
      db.prepare('DELETE FROM message_threads WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM emails WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM relationships WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM chronicles WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM friendships WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM player_permissions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM permission_transactions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM missions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM character_player_data WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM creator_sessions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM character_likes WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM character_comments WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM player_facts WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM memory_embeddings WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM moments WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM moment_interactions WHERE author_type = ? AND author_id = ?').run('player', playerId);
      db.prepare('DELETE FROM suggestions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM suggestion_interactions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM description_changes WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM character_instances WHERE player_id = ?').run(playerId);
      // 新场景引擎表（此前遗漏）
      db.prepare('DELETE FROM scene_messages WHERE scene_session_id IN (SELECT id FROM scene_sessions WHERE player_id = ?)').run(playerId);
      db.prepare('DELETE FROM scene_sessions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM scene_relationships WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM scene_schedule_entries WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM turn_memory_fold WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM turn_player_facts WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM character_permissions WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM scenario_sessions WHERE player_id = ?').run(playerId);
      db.prepare(`DELETE FROM image_blobs WHERE id LIKE ? ESCAPE '\\'`).run(`${playerId}\\_%`);
      // 删玩家创建的地点
      db.prepare('DELETE FROM locations WHERE creator_type = \'player\' AND creator_id = ?').run(playerId);
      // 解绑公共NPC
      db.prepare('UPDATE characters SET creator_player_id = NULL WHERE creator_player_id = ?').run(playerId);
      // 最后删账号和邀请码
      db.prepare('DELETE FROM invite_codes WHERE player_id = ?').run(playerId);
      db.prepare('DELETE FROM players WHERE id = ?').run(playerId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      app.log.error({ err }, '删除账号失败，已回滚');
      return reply.code(500).send({ error: '删除失败，数据已回滚' });
    }

    return reply.send({ ok: true });
  });

  // ─── 地点管理 ──────────────────────────────────────────────────

  // 列出所有地点（含系统+玩家创建），附分配的NPC及其活动列表、父子层级
  app.get('/admin/locations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const locs = db.prepare(`
      SELECT id, name, summary, creator_type, creator_id, is_public, parent_id, created_at
      FROM locations
      WHERE character_instance_id IS NULL
      ORDER BY creator_type ASC, created_at ASC
    `).all() as {
      id: string; name: string; summary: string;
      creator_type: string; creator_id: string | null; is_public: number; parent_id: string | null; created_at: number;
    }[];

    // 预查子地点数
    const childCounts = new Map<string, number>();
    for (const l of locs) {
      if (l.parent_id) {
        childCounts.set(l.parent_id, (childCounts.get(l.parent_id) ?? 0) + 1);
      }
    }

    // 预查所有家归属（一次查全，避免N+1）
    const allHomes = db.prepare(`
      SELECT h.location_id, h.character_id, c.character_data
      FROM location_homes h
      LEFT JOIN characters c ON c.id = h.character_id
    `).all() as { location_id: string; character_id: string; character_data: string | null }[];
    const homesByLoc = new Map<string, { characterId: string; name: string }[]>();
    for (const h of allHomes) {
      const name = h.character_data ? (jsonParse<Record<string, any>>(h.character_data, {})).name ?? '未知' : '未知';
      if (!homesByLoc.has(h.location_id)) homesByLoc.set(h.location_id, []);
      homesByLoc.get(h.location_id)!.push({ characterId: h.character_id, name });
    }

    const result = locs.map(l => {
      const homeResidents = homesByLoc.get(l.id) ?? [];
      const rows = db.prepare(`
        SELECT a.id AS access_id, a.character_id, a.activity, c.character_data
        FROM location_npc_access a
        JOIN characters c ON a.character_id = c.id
        WHERE a.location_id = ?
        ORDER BY a.created_at ASC
      `).all(l.id) as { access_id: string; character_id: string; activity: string; character_data: string }[];

      // 按 character_id 分组
      const npcMap = new Map<string, { characterId: string; name: string; activities: { id: string; text: string }[] }>();
      for (const r of rows) {
        const data = jsonParse<Record<string, any>>(r.character_data, {});
        if (!npcMap.has(r.character_id)) {
          npcMap.set(r.character_id, { characterId: r.character_id, name: data.name ?? '未知', activities: [] });
        }
        npcMap.get(r.character_id)!.activities.push({ id: r.access_id, text: r.activity });
      }

      return {
        id: l.id,
        name: l.name,
        summary: l.summary,
        creatorType: l.creator_type,
        creatorId: l.creator_id,
        isPublic: !!l.is_public,
        homeResidents,
        parentId: l.parent_id ?? null,
        childrenCount: childCounts.get(l.id) ?? 0,
        createdAt: l.created_at,
        npcs: [...npcMap.values()],
      };
    });

    return reply.send({ locations: result });
  });

  // 给地点添加NPC活动（每次添加一条活动；NPC首条活动=分配NPC）
  app.post('/admin/locations/:id/npc', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { characterId, activity } = req.body as { characterId?: string; activity?: string };

    if (!characterId) return reply.code(400).send({ error: '需要characterId' });

    const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId);
    if (!char) return reply.code(404).send({ error: 'NPC不存在' });

    const accessId = genId();
    db.prepare(`
      INSERT INTO location_npc_access (id, location_id, character_id, activity, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(accessId, id, characterId, activity?.trim() || '', now());

    return reply.send({ ok: true, accessId });
  });

  // 根据角色性格+地点描述自动生成一条活动描述
  app.post('/admin/locations/:id/generate-activity', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { characterId } = req.body as { characterId?: string };

    if (!characterId) return reply.code(400).send({ error: '需要characterId' });

    const loc = db.prepare('SELECT name, summary FROM locations WHERE id = ?').get(id) as { name: string; summary: string } | undefined;
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    const charRow = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
    if (!charRow) return reply.code(404).send({ error: 'NPC不存在' });
    const charData = jsonParse<Record<string, any>>(charRow.character_data, {});

    const personalityParts = [
      charData.personality?.surface,
      charData.personality?.core,
    ].filter(Boolean).join('；');
    const likes = Array.isArray(charData.likes)
      ? charData.likes.map((l: any) => typeof l === 'string' ? l : l?.item).filter(Boolean).join('、')
      : '';
    const skills = charData.skills ?? '';

    const messages = [
      {
        role: 'system' as const,
        content: '你是一个活动描述生成器。根据角色性格和地点信息，生成一句简短的活动描述（10-20字），描述这个角色在这个地点会做什么。只输出活动描述本身，不要加引号、不要加角色名、不要加地点名、不要加任何解释。',
      },
      {
        role: 'user' as const,
        content: `角色名：${charData.name ?? '未知'}
性格：${personalityParts || '未指定'}
喜好：${likes || '未指定'}
擅长：${skills || '未指定'}
地点名：${loc.name}
地点描述：${loc.summary || '无'}

请生成这个角色在这个地点的活动描述。示例风格："坐在角落看书"、"整理药瓶"、"擦拭武器"。直接输出描述：`,
      },
    ];

    try {
      const result = await chat(messages, { temperature: 0.9, maxTokens: 64 });
      let activity = result.content.trim().replace(/^["'""「『]|["'""」』]$/g, '').trim();
      // 防御：LLM偶尔输出JSON格式（如 {activity: "..."} 或 {"messages": ["..."]}）
      if (activity.startsWith('{')) {
        try {
          const obj = JSON.parse(activity);
          activity = String(obj.activity ?? obj.description ?? obj.text ?? obj.messages?.[0] ?? '').trim();
        } catch { /* 非合法JSON，保留原文 */ }
      }
      return reply.send({ activity });
    } catch {
      return reply.code(500).send({ error: '生成失败，请手填' });
    }
  });

  // 删除单条活动（如果是NPC的最后一条，等于取消NPC分配）
  app.delete('/admin/locations/:id/activity/:accessId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, accessId } = req.params as { id: string; accessId: string };
    db.prepare('DELETE FROM location_npc_access WHERE id = ? AND location_id = ?').run(accessId, id);
    return reply.send({ ok: true });
  });

  // 取消地点的NPC分配（删除该NPC在此地点的所有活动）
  app.delete('/admin/locations/:id/npc/:characterId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, characterId } = req.params as { id: string; characterId: string };
    db.prepare('DELETE FROM location_npc_access WHERE location_id = ? AND character_id = ?').run(id, characterId);
    return reply.send({ ok: true });
  });

  // 设置/取消地点为某角色的家（多对多：一个地点可以是多个角色的家）
  // body: { characterId: string | null }  null=取消该角色的家标记
  app.put('/admin/locations/:id/home', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { characterId } = req.body as { characterId?: string | null };

    const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    if (characterId) {
      const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId);
      if (!char) return reply.code(404).send({ error: 'NPC不存在' });
      // 先清除该角色原来的家标记（一个角色只能有一个家），再添加新家
      db.prepare('DELETE FROM location_homes WHERE character_id = ?').run(characterId);
      db.prepare('INSERT OR IGNORE INTO location_homes (location_id, character_id, created_at) VALUES (?, ?, ?)').run(id, characterId, Date.now());
    } else {
      // null = 取消该地点所有人的家标记
      db.prepare('DELETE FROM location_homes WHERE location_id = ?').run(id);
    }

    return reply.send({ ok: true });
  });

  // 移除地点上某角色的家标记（多对多：只删一条，不影响其他角色）
  app.delete('/admin/locations/:id/home/:characterId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, characterId } = req.params as { id: string; characterId: string };
    db.prepare('DELETE FROM location_homes WHERE location_id = ? AND character_id = ?').run(id, characterId);
    return reply.send({ ok: true });
  });

  // 管理员删除地点
  // 规则：不能删四个核心系统地点；不能删当前是某人家的地点
  app.delete('/admin/locations/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const loc = db.prepare('SELECT id, creator_type FROM locations WHERE id = ?').get(id) as
      { id: string; creator_type: string } | undefined;

    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    const CORE_LOCATIONS = ['plaza', 'cafe', 'park', 'market'];
    if (CORE_LOCATIONS.includes(id)) {
      return reply.code(403).send({ error: '核心系统地点不可删除' });
    }
    const homeCount = db.prepare('SELECT COUNT(*) AS cnt FROM location_homes WHERE location_id = ?').get(id) as { cnt: number };
    if (homeCount.cnt > 0) {
      return reply.code(403).send({ error: '该地点仍是某NPC的家，请先取消家标记' });
    }

    // 清理关联数据再删
    db.prepare('DELETE FROM location_npc_access WHERE location_id = ?').run(id);
    db.prepare('DELETE FROM locations WHERE id = ?').run(id);
    return reply.send({ ok: true });
  });

  // 移动地点到新父级（文件树式管理）
  // body: { parentId: string | null }  null=移到顶层
  app.put('/admin/locations/:id/parent', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { parentId } = req.body as { parentId?: string | null };

    const loc = db.prepare('SELECT id FROM locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    if (parentId !== null && parentId !== undefined) {
      if (parentId === id) return reply.code(400).send({ error: '不能把自己设为自己的父级' });
      // 检查目标父级存在
      const parent = db.prepare('SELECT id FROM locations WHERE id = ?').get(parentId);
      if (!parent) return reply.code(404).send({ error: '目标父地点不存在' });
      // 检查循环：parentId 不能是 id 的子孙
      let cur: string | null = parentId;
      while (cur) {
        if (cur === id) return reply.code(400).send({ error: '不能移动到自己的子地点下（循环）' });
        const row = db.prepare('SELECT parent_id FROM locations WHERE id = ?').get(cur) as { parent_id: string | null } | undefined;
        cur = row?.parent_id ?? null;
      }
    }

    const target = parentId ?? null;
    db.prepare('UPDATE locations SET parent_id = ? WHERE id = ?').run(target, id);
    return reply.send({ ok: true });
  });

  // 管理员创建地点（可选择父级）
  app.post('/admin/locations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { name, summary, isPublic, parentId } = req.body as { name?: string; summary?: string; isPublic?: boolean; parentId?: string | null };
    if (!name?.trim()) return reply.code(400).send({ error: '需要name' });

    if (parentId) {
      const parent = db.prepare('SELECT id FROM locations WHERE id = ?').get(parentId);
      if (!parent) return reply.code(404).send({ error: '父地点不存在' });
    }

    const id = genId();
    db.prepare(`INSERT INTO locations (id, world_id, name, summary, creator_type, creator_id, is_public, parent_id, created_at)
      VALUES (?, ?, ?, ?, 'system', NULL, ?, ?, ?)`)
      .run(id, HUB_WORLD_ID, name.trim(), summary?.trim() || '', isPublic !== false ? 1 : 0, parentId ?? null, now());
    return reply.send({ ok: true, id });
  });

  // ─── 场景地点活动池管理（新地图 scene_locations 的地图活动池）─────────

  // 列出所有 scene 地点及其活动池（+背景图文件名）
  app.get('/admin/scene-locations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = db.prepare(
      `SELECT id, name, summary, is_public, parent_id, activities, background_image, background_submitted FROM scene_locations ORDER BY name`
    ).all() as { id: string; name: string; summary: string; is_public: number; parent_id: string | null; activities: string; background_image: string | null; background_submitted: string }[];
    return reply.send({
      locations: rows.map(r => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        isPublic: !!r.is_public,
        parentId: r.parent_id,
        activities: (jsonParse<string[]>(r.activities, []) as string[] | false) || [],
        background: (r.background_image as string | null)?.trim() ?? '',
        submissions: getBackgroundSubmissions(r.id),
      })),
    });
  });

  // 设置某 scene 地点的公共版背景图（存 uploads/ 下文件名；空串 = 清除）
  app.put('/admin/scene-locations/:id/background', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { background } = req.body as { background?: string };
    if (typeof background !== 'string') return reply.code(400).send({ error: '需要background字符串' });
    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });
    const file = background.trim();
    db.prepare('UPDATE scene_locations SET background_image = ?, updated_at = ? WHERE id = ?')
      .run(file || null, now(), id);
    return reply.send({ ok: true, background: file });
  });

  // 设置某 scene 地点的活动池
  app.put('/admin/scene-locations/:id/activities', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { activities } = req.body as { activities?: unknown };
    if (!Array.isArray(activities)) return reply.code(400).send({ error: '需要activities数组' });
    const clean = (activities as unknown[]).filter(a => typeof a === 'string' && a.trim()).map(a => (a as string).trim());
    if (clean.length > 30) return reply.code(400).send({ error: '活动池最多30条' });
    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });
    db.prepare('UPDATE scene_locations SET activities = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(clean), now(), id);
    return reply.send({ ok: true, activities: clean });
  });

  // LLM为某 scene 地点一键生成一组活动（5条）
  app.post('/admin/scene-locations/:id/generate-activities', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const loc = db.prepare('SELECT name, summary FROM scene_locations WHERE id = ?').get(id) as { name: string; summary: string } | undefined;
    if (!loc) return reply.code(404).send({ error: '地点不存在' });
    const r = await chat([{
      role: 'system' as const,
      content: '你是地图活动生成器。根据地点信息生成5条简短的活动描述（每条5-15字，覆盖不同的人在做的事），用于NPC在该地点随机行动。只输出JSON数组字符串，如 ["在角落看书","和店主闲聊","临窗发呆"]，不要任何解释、引号包裹、或 markdown。',
    }, {
      role: 'user' as const,
      content: `地点名：${loc.name}\n地点描述：${loc.summary || '无'}\n\n输出活动JSON数组：`,
    }]);
    const text = r?.content ?? '';
    const arr = text.match(/\[[\s\S]*?\]/);
    const parsed = arr ? JSON.parse(arr[0]) : [];
    const clean = Array.isArray(parsed) ? (parsed as unknown[])
      .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
      .map(a => a.trim()).slice(0, 5) : [];
    if (clean.length === 0) return reply.code(502).send({ error: '生成失败，请手填' });
    db.prepare('UPDATE scene_locations SET activities = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(clean), now(), id);
    return reply.send({ ok: true, activities: clean });
  });

  // ─── 新地图(scene_locations)地点管理（管理端「地点」页签）────────────────
  // 完整树：列出所有 scene 地点（含层级、家、路人、活动池、背景），一次返回

  app.get('/admin/scene-map/locations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    ensureSceneMap();
    const rows = db.prepare(`
      SELECT id, name, summary, creator_type, creator_id, is_public, parent_id, home_of, npcs, activities, background_image, created_at
      FROM scene_locations
      WHERE id NOT LIKE 'temp-%'
      ORDER BY created_at ASC
    `).all() as {
      id: string; name: string; summary: string; creator_type: string; creator_id: string | null;
      is_public: number; parent_id: string | null; home_of: string | null;
      npcs: string; activities: string; background_image: string | null; created_at: number;
    }[];

    // 家归属：scene_homes 一次查全
    const allHomes = db.prepare(`
      SELECT h.location_id, h.character_id, c.character_data
      FROM scene_homes h
      LEFT JOIN characters c ON c.id = h.character_id
    `).all() as { location_id: string; character_id: string; character_data: string | null }[];
    const homesByLoc = new Map<string, { characterId: string; name: string }[]>();
    for (const h of allHomes) {
      const name = h.character_data ? (jsonParse<Record<string, any>>(h.character_data, {})).name ?? '未知' : '未知';
      if (!homesByLoc.has(h.location_id)) homesByLoc.set(h.location_id, []);
      homesByLoc.get(h.location_id)!.push({ characterId: h.character_id, name });
    }

    const childCounts = new Map<string, number>();
    for (const r of rows) if (r.parent_id) childCounts.set(r.parent_id, (childCounts.get(r.parent_id) ?? 0) + 1);

    return reply.send({
      locations: rows.map(r => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        creatorType: r.creator_type,
        creatorId: r.creator_id,
        isPublic: !!r.is_public,
        parentId: r.parent_id,
        home_of: r.home_of,
        homeResidents: homesByLoc.get(r.id) ?? [],
        childrenCount: childCounts.get(r.id) ?? 0,
        createdAt: r.created_at,
        npcs: getNpcs(r.id),
        activities: (jsonParse<string[]>(r.activities, []) as string[] | false) || [],
        background: (r.background_image as string | null)?.trim() ?? '',
        submissions: getBackgroundSubmissions(r.id),
      })),
    });
  });

  // 创建地点（管理端可选择父级 / 公开私有）
  app.post('/admin/scene-map/locations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    ensureSceneMap();
    const { name, summary, isPublic, parentId } = req.body as { name?: string; summary?: string; isPublic?: boolean; parentId?: string | null };
    if (!name?.trim()) return reply.code(400).send({ error: '需要name' });
    if (name.trim().length > 30) return reply.code(400).send({ error: '地点名称不能超过30字' });

    let validParentId: string | null = null;
    let parentIsPublic: number | null = null;
    if (parentId) {
      const parent = db.prepare('SELECT id, is_public FROM scene_locations WHERE id = ?').get(parentId) as { id: string; is_public: number } | undefined;
      if (!parent) return reply.code(404).send({ error: '父地点不存在' });
      validParentId = parentId;
      parentIsPublic = parent.is_public;
    }

    const id = genId();
    const ts = now();
    // 显式传 isPublic → 用显式值；未传 → 继承父级（父私有则私有，父公开/无父则公开）
    const isPub = isPublic !== undefined ? (isPublic ? 1 : 0) : (parentIsPublic ?? 1);
    db.prepare(`INSERT INTO scene_locations (id, world_id, name, summary, creator_type, creator_id, is_public, parent_id, npcs, activities, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'system', NULL, ?, ?, '[]', '[]', ?, ?)`)
      .run(id, HUB_WORLD_ID, name.trim(), summary?.trim() || '', isPub, validParentId, ts, ts);
    return reply.send({ ok: true, id });
  });

  // 编辑地点名称/描述（name 可选，summary 可选；只更新提供的字段）
  app.put('/admin/scene-map/locations/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    ensureSceneMap();
    const { id } = req.params as { id: string };
    const { name, summary } = req.body as { name?: string; summary?: string };

    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    const tName = name !== undefined ? name.trim() : undefined;
    const tSummary = summary !== undefined ? summary.trim() : undefined;

    if (tName !== undefined && !tName) return reply.code(400).send({ error: '地点名称不能为空' });
    if ((tName ?? '').length > 30) return reply.code(400).send({ error: '地点名称不能超过30字' });
    if ((tSummary ?? '').length > 500) return reply.code(400).send({ error: '地点描述不能超过500字' });

    if (tName === undefined && tSummary === undefined) {
      return reply.code(400).send({ error: '没有要更新的字段' });
    }

    const setCols: string[] = [];
    const vals: (string | number)[] = [];
    if (tName !== undefined) { setCols.push('name = ?'); vals.push(tName); }
    if (tSummary !== undefined) { setCols.push('summary = ?'); vals.push(tSummary); }
    setCols.push('updated_at = ?'); vals.push(now());
    vals.push(id);
    db.prepare(`UPDATE scene_locations SET ${setCols.join(', ')} WHERE id = ?`).run(...vals);

    return reply.send({ ok: true });
  });

  // 移动地点父级（防循环）
  app.put('/admin/scene-map/locations/:id/parent', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { parentId } = req.body as { parentId?: string | null };

    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    if (parentId !== null && parentId !== undefined) {
      if (parentId === id) return reply.code(400).send({ error: '不能把自己设为自己的父级' });
      const parent = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(parentId);
      if (!parent) return reply.code(404).send({ error: '目标父地点不存在' });
      let cur: string | null = parentId;
      while (cur) {
        if (cur === id) return reply.code(400).send({ error: '不能移动到自己的子地点下（循环）' });
        const row = db.prepare('SELECT parent_id FROM scene_locations WHERE id = ?').get(cur) as { parent_id: string | null } | undefined;
        cur = row?.parent_id ?? null;
      }
    }

    db.prepare('UPDATE scene_locations SET parent_id = ?, updated_at = ? WHERE id = ?').run(parentId ?? null, now(), id);
    return reply.send({ ok: true });
  });

  // 删除地点（连带清理场景引用与家归属）
  app.delete('/admin/scene-map/locations/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    // 禁止删除仍有子地点的节点（否则造成孤儿树）
    const childCount = db.prepare('SELECT COUNT(*) AS c FROM scene_locations WHERE parent_id = ? AND id NOT LIKE ?').get(id, 'temp-%') as { c: number };
    if (childCount.c > 0) return reply.code(403).send({ error: `该地点仍有 ${childCount.c} 个子地点，请先移走子地点` });

    // 若有任何地点的 home 在此，提示先取消家标记
    const homeCount = db.prepare('SELECT COUNT(*) AS c FROM scene_homes WHERE location_id = ?').get(id) as { c: number };
    if (homeCount.c > 0) return reply.code(403).send({ error: '该地点仍是某NPC的家，请先取消家标记' });

    db.prepare('DELETE FROM scene_homes WHERE location_id = ?').run(id);
    db.prepare('DELETE FROM scene_locations WHERE id = ?').run(id);
    return reply.send({ ok: true });
  });

  // 设置/取消某地点为某角色的家（一个角色一个家）
  app.put('/admin/scene-map/locations/:id/home', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const { characterId } = req.body as { characterId?: string | null };
    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    if (characterId) {
      const char = db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId);
      if (!char) return reply.code(404).send({ error: 'NPC不存在' });
      // 角色只能有一个家：先清旧家，再加新家
      db.prepare('DELETE FROM scene_homes WHERE character_id = ?').run(characterId);
      db.prepare('INSERT OR IGNORE INTO scene_homes (location_id, character_id, created_at) VALUES (?, ?, ?)').run(id, characterId, now());
      // home_of 列仅作冗余标记
      db.prepare('UPDATE scene_locations SET home_of = ?, updated_at = ? WHERE id = ?').run(characterId, now(), id);
    } else {
      db.prepare('DELETE FROM scene_homes WHERE location_id = ?').run(id);
      db.prepare('UPDATE scene_locations SET home_of = NULL, updated_at = ? WHERE id = ?').run(now(), id);
    }
    return reply.send({ ok: true });
  });

  // 移除地点上某角色的家标记（多对多：只删一条）
  app.delete('/admin/scene-map/locations/:id/home/:characterId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, characterId } = req.params as { id: string; characterId: string };
    db.prepare('DELETE FROM scene_homes WHERE location_id = ? AND character_id = ?').run(id, characterId);
    // 若该角色的家不再指向这里，清掉 home_of 冗余标记
    const still = db.prepare('SELECT 1 FROM scene_homes WHERE character_id = ? AND location_id = ?').get(characterId, id);
    if (!still) {
      const h = db.prepare('SELECT home_of FROM scene_locations WHERE id = ?').get(id) as { home_of: string | null } | undefined;
      if (h?.home_of === characterId) db.prepare('UPDATE scene_locations SET home_of = NULL, updated_at = ? WHERE id = ?').run(now(), id);
    }
    return reply.send({ ok: true });
  });

  // 删除某地点的单个路人（按 id）
  app.delete('/admin/scene-map/locations/:id/npc/:npcId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, npcId } = req.params as { id: string; npcId: string };
    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });
    const npcs = removeNpc(id, npcId);
    return reply.send({ ok: true, npcs });
  });

  // 编辑某地点的单个路人（按 id，保留原 id）
  app.put('/admin/scene-map/locations/:id/npc/:npcId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, npcId } = req.params as { id: string; npcId: string };
    const { role, name, persona } = req.body as { role?: string; name?: string; persona?: string };

    const loc = db.prepare('SELECT id FROM scene_locations WHERE id = ?').get(id);
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    const tRole = role !== undefined ? role.trim() : undefined;
    const tName = name !== undefined ? name.trim() : undefined;
    const tPersona = persona !== undefined ? persona.trim() : undefined;

    if ((tRole !== undefined && !tRole) || (tName !== undefined && !tName)) {
      return reply.code(400).send({ error: '路人角色与名字不能为空' });
    }
    if ((tRole ?? '').length > 20 || (tName ?? '').length > 20) {
      return reply.code(400).send({ error: '身份/名字不能超过20字' });
    }
    if ((tPersona ?? '').length > 200) {
      return reply.code(400).send({ error: '设定不能超过200字' });
    }

    const before = getNpcs(id);
    if (!before.some(n => n.id === npcId)) return reply.code(404).send({ error: '路人不存在' });

    const npcs = updateNpc(id, npcId, { role: tRole, name: tName, persona: tPersona });
    return reply.send({ ok: true, npcs });
  });
}
