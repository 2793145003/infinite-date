/** 
 * 玩家路由
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth, issueToken } from '../lib/auth';
import { now } from '../lib/util';
import { getCurrentSchedule, getUpcomingSchedule } from '../lib/schedule';
import { updatePresence, checkProactive, clearPresence } from '../lib/presence';
import { loadCharacterData } from '../lib/character';
import { initTutorialData } from './tutorial';

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  // 获取玩家信息 + 权限
  app.get('/player', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const player = db.prepare('SELECT id, name, pronouns, gender, appearance, tutorial_step, rating_score FROM players WHERE id = ?').get(playerId) as {
      id: string; name: string; pronouns: string; gender: string; appearance: string; tutorial_step: number; rating_score: number;
    };

    const perm = db.prepare('SELECT balance FROM player_permissions WHERE player_id = ?').get(playerId) as { balance: number } | undefined;

    return reply.send({
      player,
      permissions: perm?.balance ?? 0,
    });
  });

  // 更新玩家信息（名字、代词）
  app.patch('/player', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { name, pronouns, gender, appearance } = req.body as { name?: string; pronouns?: string; gender?: string; appearance?: string };
    const updates: string[] = [];
    const params: (string | number)[] = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (pronouns !== undefined) { updates.push('pronouns = ?'); params.push(pronouns); }
    if (gender !== undefined) { updates.push('gender = ?'); params.push(gender); }
    if (appearance !== undefined) { updates.push('appearance = ?'); params.push(appearance); }

    if (updates.length === 0) {
      return reply.code(400).send({ error: '没有要更新的字段' });
    }

    updates.push('updated_at = ?');
    params.push(now());
    params.push(playerId);

    db.prepare(`UPDATE players SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // 新玩家设名字时初始化教程（发欢迎邮件+主神短信线程）
    if (name !== undefined) {
      const player = db.prepare('SELECT name, tutorial_step FROM players WHERE id = ?').get(playerId) as { name: string; tutorial_step: number };
      if (player.tutorial_step < 4) {
        initTutorialData(playerId, player.name);
      }
    }

    return reply.send({ ok: true });
  });

  // 删除存档 — 清空游戏数据，保留邀请码和账号
  app.delete('/player', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // ── 事务包裹：跨 25+ 表删除，任一失败必须整体回滚 ──
    db.exec('BEGIN');
    try {
      // 1. 先删有FK依赖的子表
      // text_messages → message_threads（text_messages 无 player_id 列，通过 thread 关联）
      db.prepare(`DELETE FROM text_messages WHERE thread_id IN (SELECT id FROM message_threads WHERE player_id = ?)`).run(playerId);
      // messages → conversation_sessions（messages 无 player_id 列，通过 session 关联）
      db.prepare(`DELETE FROM messages WHERE session_id IN (SELECT id FROM conversation_sessions WHERE player_id = ?)`).run(playerId);

      // 2. 删有 player_id 列的表（player_permissions 单独处理）
      const tables = [
        'memory_embeddings',
        'player_facts',
        'description_changes',
        'character_likes',
        'character_comments',
        'friendships',
        'creator_sessions',
        'character_player_data',
        'missions',
        'permission_transactions',
        'character_permissions',
        'chronicles',
        'emails',
        'message_threads',
        'conversation_sessions',
        'relationships',
        'character_instances',
        // 以下表此前漏删，导致删档后朋友圈等数据残留
        'moments',                 // moment_interactions 通过 FK CASCADE 自动清理
        'suggestions',             // suggestion_interactions 通过 FK CASCADE 自动清理
        'suggestion_interactions', // 同时有 player_id，双保险
        'explore_sessions',        // explore_messages 通过 FK CASCADE 自动清理
        'scenario_sessions',       // 剧本会话
        // 以下：新场景引擎表此前漏删 —— 玩家删档时应清理场景约会痕迹
        'scene_sessions',          // scene_messages / scene_round_snapshots / scene_start_snapshot 经 FK 级联
        'scene_relationships',     // character_id 无 FK，必须显式删
        'scene_schedule_entries',  // player_id 无 FK，必须显式删
        'turn_memory_fold',        // player_id 有 CASCADE，但删档不删 players 行，仍须显式删
        'turn_player_facts',       // 同上
      ];
      for (const t of tables) {
        db.prepare(`DELETE FROM ${t} WHERE player_id = ?`).run(playerId);
      }
      // image_blobs 无 player_id 列，id 格式为 {playerId}_{ts}_{rand}.ext
      db.prepare(`DELETE FROM image_blobs WHERE id LIKE ? ESCAPE '\\'`).run(`${playerId}\\_%`);

      // 3. 删 locations（creator_id = playerId 的玩家创建地点）
      db.prepare(`DELETE FROM locations WHERE creator_type = 'player' AND creator_id = ?`).run(playerId);

      // 4. 公共NPC与创建者解绑 — 删档只清 creator_player_id，不删角色
      db.prepare(`UPDATE characters SET creator_player_id = NULL WHERE creator_player_id = ?`).run(playerId);

      // 5. 显式删除并重建 player_permissions（不依赖 tables 数组顺序）
      db.prepare('DELETE FROM player_permissions WHERE player_id = ?').run(playerId);

      // 6. 重置玩家数据：名字清空，教程回到0，权限归零
      db.prepare("UPDATE players SET name = '', tutorial_step = 0, rating_score = 0, pronouns = '', persona_notes = '', gender = 'female', appearance = '', updated_at = ? WHERE id = ?").run(now(), playerId);
      // 重新初始化权限
      db.prepare('INSERT INTO player_permissions (player_id, balance, total_earned, total_spent, updated_at) VALUES (?, 0, 0, 0, ?)').run(playerId, now());

      // 7. 删除session，让前端回到登录页
      db.prepare('DELETE FROM sessions WHERE player_id = ?').run(playerId);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      app.log.error({ err }, '删档失败，已回滚');
      return reply.code(500).send({ error: '删档失败，数据已回滚' });
    }

    return reply.send({ ok: true });
  });

  // 地图：获取各地点的角色列表（按行程系统分配）
  app.get('/map/npcs', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 读取所有可见地点（家地点在夜间才显示）
    const now = Date.now();
    const hour = new Date(now).getHours();
    const isNight = hour >= 23 || hour < 6;
    const locs = db.prepare(`
      SELECT id, name, creator_type FROM locations
      WHERE world_id = 'default-world'
        AND character_instance_id IS NULL
        AND (creator_type = 'system' OR is_public = 1 OR creator_id = ?)
      ORDER BY creator_type ASC, created_at ASC
    `).all(playerId) as { id: string; name: string; creator_type: string }[];

    // 批量查家地点
    const homeLocIds = new Set<string>(
      (db.prepare('SELECT DISTINCT location_id FROM location_homes').all() as { location_id: string }[])
        .map(r => r.location_id)
    );

    const visibleLocs = locs.filter(l => {
      // 系统家地点只在夜间显示
      if (homeLocIds.has(l.id) && l.creator_type === 'system') return isNight;
      return true;
    });

    // 读取所有公共角色
    const rows = db.prepare(`
      SELECT id AS character_id, character_data FROM characters
    `).all() as { character_id: string; character_data: string }[];

    // 读取玩家好友列表（用于行程可见性）
    const friends = new Set(
      (db.prepare('SELECT character_id FROM friendships WHERE player_id = ? AND status = ?').all(playerId, 'active') as { character_id: string }[])
        .map(f => f.character_id)
    );

    // 读取玩家偶遇过的角色（有relationship记录=交谈过）
    const met = new Set(
      (db.prepare('SELECT character_id FROM relationships WHERE player_id = ?').all(playerId) as { character_id: string }[])
        .map(r => r.character_id)
    );

    // 读取进行中的约会（约会中的NPC位置 = 约会实时地点）
    const activeSession = db.prepare('SELECT character_id, location_id, current_location_id FROM conversation_sessions WHERE player_id = ? AND ended = 0').get(playerId) as {
      character_id: string; location_id: string | null; current_location_id: string | null;
    } | undefined;

    // 用行程系统分配NPC到地点
    const locationsMap: Record<string, Array<{
      characterId: string; name: string; avatar: string;
      visibility: 'friend' | 'stranger' | 'unknown';
      activity: string;
    }>> = {};
    for (const loc of visibleLocs) {
      locationsMap[loc.id] = [];
    }

    // 建立子→祖先链缓存：给定一个 locationId，返回它自己和所有祖先的 id
    const ancestorCache = new Map<string, string[]>();
    const getAncestorChain = (locId: string): string[] => {
      if (ancestorCache.has(locId)) return ancestorCache.get(locId)!;
      const chain: string[] = [locId];
      let cur = locId;
      while (true) {
        const row = db.prepare('SELECT parent_id FROM locations WHERE id = ?').get(cur) as { parent_id: string | null } | undefined;
        if (!row?.parent_id) break;
        chain.push(row.parent_id);
        cur = row.parent_id;
      }
      ancestorCache.set(locId, chain);
      return chain;
    };

    for (const r of rows) {
      // fork 优先：玩家编辑过的角色用 fork 数据
      const forkData = db.prepare('SELECT character_data FROM character_player_data WHERE player_id = ? AND source_character_id = ?').get(playerId, r.character_id) as { character_data: string } | undefined;
      const charData = forkData ? JSON.parse(forkData.character_data) : JSON.parse(r.character_data);

      // 约会中的NPC：位置 = 约会实时地点，活动 = "和你约会"
      let locationId: string;
      let activity: string;
      const activeLocId = activeSession?.current_location_id || activeSession?.location_id;
      if (activeSession && activeSession.character_id === r.character_id && activeLocId) {
        locationId = activeLocId;
        activity = '正在和你约会';
      } else {
        const schedule = getCurrentSchedule(playerId, r.character_id, charData, now);
        if (!schedule) continue;  // NPC不在主城
        locationId = schedule.locationId;
        activity = schedule.activity;
      }

      const isFriend = friends.has(r.character_id);
      const hasMet = met.has(r.character_id);

      const npcEntry = {
        characterId: r.character_id,
        name: charData.name ?? '未知',
        avatar: (charData.name ?? '?')[0],
        visibility: isFriend ? 'friend' as const : hasMet ? 'stranger' as const : 'unknown' as const,
        activity: isFriend ? activity : '',  // 只有好友看得到活动
      };

      // 挂到 NPC 实际所在地点 + 所有祖先地点（让外层地图也能看到里面的人）
      const chain = getAncestorChain(locationId);
      for (const ancestorId of chain) {
        if (locationsMap[ancestorId]) {
          locationsMap[ancestorId]!.push(npcEntry);
        }
      }
    }

    return reply.send({ locations: locationsMap });
  });

  // NPC行程详情（好友可见完整行程）
  app.get('/npcs/:characterId/schedule', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.params as { characterId: string };

    // 必须是好友才能看完整行程
    const isFriend = !!db.prepare('SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, characterId, 'active');
    if (!isFriend) {
      return reply.code(403).send({ error: '只有好友才能查看行程' });
    }

    const charData = loadCharacterData(playerId, characterId);
    if (!charData) {
      return reply.code(404).send({ error: '角色不存在' });
    }

    const now = Date.now();
    const upcoming = getUpcomingSchedule(playerId, characterId, charData, now, 6);

    return reply.send({
      characterId,
      characterName: charData.name ?? '未知',
      current: upcoming[0] ?? null,
      upcoming: upcoming.slice(1),
    });
  });

  // ─── 在线状态 + NPC主动消息 ──────────────────────────────

  // 心跳：前端每15s调用一次
  app.post('/presence', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { view, sessionId, threadId, characterId, idleMs } = req.body as {
      view: string;
      sessionId?: string;
      threadId?: string;
      characterId?: string;
      idleMs?: number;
    };

    updatePresence(playerId, {
      view,
      sessionId,
      threadId,
      characterId,
      idleMs: idleMs ?? 0,
    });

    // 检查是否触发NPC主动消息
    const proactive = await checkProactive(playerId);
    if (proactive && proactive.length > 0) {
      return reply.send({
        proactive: true,
        messages: proactive,
      });
    }

    return reply.send({ proactive: false });
  });

  // 离开页面时清除状态
  app.delete('/presence', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    clearPresence(playerId);
    return reply.send({ ok: true });
  });
}
