/**
 * 回忆录路由
 *
 * 浏览历史约会、短信、剧本记录，支持搜索和导出Markdown
 *
 * - GET  /archive/dates           — 已结束约会列表（含搜索）
 * - GET  /archive/dates/:id       — 约会详情（消息+元信息）
 * - GET  /archive/sms             — 短信列表（含搜索）
 * - GET  /archive/sms/:threadId   — 短信详情（消息）
 * - GET  /archive/scenarios       — 剧本游玩历史列表
 * - GET  /archive/scenarios/:id   — 剧本会话详情（消息+梦）
 * - POST /archive/export          — 导出Markdown（支持单条/批量）
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { getCharacterName } from '../lib/character';
import { jsonParse } from '../lib/util';
import { parseNpcRoles } from '../lib/scene-wiring';

/** 转义 LIKE 通配符（% 和 _），防止搜索词意外匹配过多 */
function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, c => '\\' + c);
}

export async function archiveRoutes(app: FastifyInstance): Promise<void> {

  // ─── 场景约会列表缓存（按 player 粒度）─────────────────────
  // node:sqlite 同步读写抢锁时，反复进回忆页查 date_summary 会和折叠写入撞锁。
  // 用版本号（scene_sessions.updated_at + turn_memory_fold.created_at）做脏检查，
  // 没变就跳过 N+1 查询直接返回缓存。
  const sceneDateCache = new Map<string, { version: string; data: any[] }>();

  // ─── 日期格式化 ───────────────────────────────────────────
  function fmtDate(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ─── 已结束约会列表 ───────────────────────────────────────
  app.get('/archive/dates', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { q } = req.query as { q?: string };
    const search = q?.trim() || '';

    let rows;
    if (search) {
      // 搜索：角色名、地点名、消息内容
      rows = db.prepare(`
        SELECT DISTINCT cs.id, cs.character_id, cs.location_id, cs.is_group,
               cs.scenario_session_id, cs.created_at, cs.updated_at, cs.summary
        FROM conversation_sessions cs
        LEFT JOIN messages m ON m.session_id = cs.id
        LEFT JOIN locations l ON l.id = cs.location_id
        WHERE cs.player_id = ? AND cs.ended = 1 AND cs.scenario_session_id IS NULL
          AND (
            m.text LIKE '%' || ? || '%' ESCAPE '\\' OR
            l.name LIKE '%' || ? || '%' ESCAPE '\\'
          )
        ORDER BY cs.created_at DESC
      `).all(playerId, escapeLike(search), escapeLike(search)) as Array<{
        id: string; character_id: string; location_id: string | null;
        is_group: number; scenario_session_id: string | null;
        created_at: number; updated_at: number; summary: string;
      }>;
      // 角色名匹配在JS里做（SQL的character_id是UUID不是名字）
      rows = rows.filter(r => {
        if (r.character_id === 'narrator' || r.character_id === 'system') return true;
        const name = getCharacterName(r.character_id);
        return name.includes(search);
      });
    } else {
      rows = db.prepare(`
        SELECT id, character_id, location_id, is_group, scenario_session_id,
               created_at, updated_at, summary
        FROM conversation_sessions
        WHERE player_id = ? AND ended = 1 AND scenario_session_id IS NULL
        ORDER BY created_at DESC
      `).all(playerId) as Array<{
        id: string; character_id: string; location_id: string | null;
        is_group: number; scenario_session_id: string | null;
        created_at: number; updated_at: number; summary: string;
      }>;
    }

    const result = rows.map(r => {
      // 角色名（群聊取所有参与者）
      let characterName = getCharacterName(r.character_id);
      let isGroup = r.is_group === 1;
      if (isGroup) {
        const participants = db.prepare(`
          SELECT character_id FROM session_participants
          WHERE session_id = ? ORDER BY join_order
        `).all(r.id) as { character_id: string }[];
        characterName = participants.map(p => getCharacterName(p.character_id)).join('、');
      }

      // 地点名
      let locationName = '';
      if (r.location_id) {
        const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(r.location_id) as { name: string } | undefined;
        locationName = loc?.name ?? '';
      }

      // 消息数
      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(r.id) as { cnt: number };

      return {
        id: r.id,
        characterId: r.character_id,
        characterName,
        isGroup,
        locationId: r.location_id,
        locationName,
        summary: r.summary || '',
        messageCount: msgCount.cnt,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    return reply.send({ dates: result });
  });

  // ─── 场景约会列表（新地图）──────────────────────────────────
  app.get('/archive/scene-dates', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { q } = req.query as { q?: string };
    const search = q?.trim() || '';

    // 无搜索时走缓存：版本号 = MAX(scene_sessions.updated_at) + MAX(turn_memory_fold.created_at)
    if (!search) {
      const verRow = db.prepare(`
        SELECT
          COALESCE((SELECT MAX(updated_at) FROM scene_sessions WHERE player_id = ? AND ended = 1 AND scene_type = 'date'), 0) AS ss_max,
          COALESCE((SELECT MAX(created_at) FROM turn_memory_fold WHERE player_id = ? AND fold_type = 'date_summary'), 0) AS tmf_max
      `).get(playerId, playerId) as { ss_max: number; tmf_max: number };
      const version = `${verRow.ss_max}-${verRow.tmf_max}`;
      const cached = sceneDateCache.get(playerId);
      if (cached && cached.version === version) {
        return reply.send({ dates: cached.data });
      }
      // 版本变了或首次，跑完 N+1 后更新缓存（见函数末尾）
    }

    let rows;
    if (search) {
      // 搜索：角色名、地点名、消息内容、摘要
      rows = db.prepare(`
        SELECT DISTINCT ss.id, ss.scene_type, ss.root_location_id, ss.character_ids,
               ss.created_at, ss.updated_at
        FROM scene_sessions ss
        LEFT JOIN scene_messages sm ON sm.scene_session_id = ss.id
        LEFT JOIN scene_locations sl ON sl.id = ss.root_location_id
        WHERE ss.player_id = ? AND ss.ended = 1 AND ss.scene_type = 'date'
          AND (
            sm.text LIKE '%' || ? || '%' ESCAPE '\\' OR
            sl.name LIKE '%' || ? || '%' ESCAPE '\\'
          )
        ORDER BY ss.created_at DESC
      `).all(playerId, escapeLike(search), escapeLike(search)) as Array<{
        id: string; scene_type: string; root_location_id: string | null; character_ids: string;
        created_at: number; updated_at: number;
      }>;
      // 角色名匹配在JS里做（character_id是UUID）
      rows = rows.filter(r => {
        const chars = jsonParse<any[]>(r.character_ids, []);
        return chars.some((c: any) => {
          const cid = typeof c === 'string' ? c : (c?.characterId ?? c?.id);
          if (!cid) return false;
          return getCharacterName(cid).includes(search);
        });
      });
    } else {
      rows = db.prepare(`
        SELECT id, scene_type, root_location_id, character_ids,
               created_at, updated_at
        FROM scene_sessions
        WHERE player_id = ? AND ended = 1 AND scene_type = 'date'
        ORDER BY created_at DESC
      `).all(playerId) as Array<{
        id: string; scene_type: string; root_location_id: string | null; character_ids: string;
        created_at: number; updated_at: number;
      }>;
    }

    const result = rows.map(r => {
      const chars = jsonParse<any[]>(r.character_ids, []);
      const charIds = chars.map((c: any) => typeof c === 'string' ? c : (c?.characterId ?? c?.id)).filter(Boolean);
      const characterNames = charIds.map((id: string) => getCharacterName(id)).filter(Boolean);
      const characterName = characterNames.length ? characterNames.join('、') : '未知角色';

      let locationName = '';
      if (r.root_location_id) {
        const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(r.root_location_id) as { name: string } | undefined;
        locationName = loc?.name ?? '';
      }

      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM scene_messages WHERE scene_session_id = ?').get(r.id) as { cnt: number };

      // 取场景整体摘要（若有 date_summary）
      const summaryRow = db.prepare(`
        SELECT summary FROM turn_memory_fold
        WHERE player_id = ? AND scene_session_id = ? AND fold_type = 'date_summary'
        ORDER BY created_at DESC LIMIT 1
      `).get(playerId, r.id) as { summary: string } | undefined;

      return {
        id: r.id,
        characterId: charIds[0] ?? '',
        characterName,
        isGroup: charIds.length > 1,
        locationId: r.root_location_id,
        locationName,
        summary: summaryRow?.summary ?? '',
        messageCount: msgCount.cnt,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    // 无搜索时更新缓存
    if (!search) {
      const verRow = db.prepare(`
        SELECT
          COALESCE((SELECT MAX(updated_at) FROM scene_sessions WHERE player_id = ? AND ended = 1 AND scene_type = 'date'), 0) AS ss_max,
          COALESCE((SELECT MAX(created_at) FROM turn_memory_fold WHERE player_id = ? AND fold_type = 'date_summary'), 0) AS tmf_max
      `).get(playerId, playerId) as { ss_max: number; tmf_max: number };
      sceneDateCache.set(playerId, { version: `${verRow.ss_max}-${verRow.tmf_max}`, data: result });
    }

    return reply.send({ dates: result });
  });

  // ─── 场景约会详情 ─────────────────────────────────────────
  app.get('/archive/scene-dates/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare(`
      SELECT id, scene_type, root_location_id, character_ids, round_no, created_at, updated_at
      FROM scene_sessions
      WHERE id = ? AND player_id = ? AND ended = 1 AND scene_type = 'date'
    `).get(sessionId, playerId) as {
      id: string; scene_type: string; root_location_id: string | null; character_ids: string;
      round_no: number; created_at: number; updated_at: number;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: '场景记录不存在' });
    }

    const messages = db.prepare(`
      SELECT id, role, character_id, character_name, text, internal, internal_notable, created_at
      FROM scene_messages WHERE scene_session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as Array<{
      id: string; role: string; character_id: string | null; character_name: string;
      text: string; internal: string; internal_notable: number; created_at: number;
    }>;

    const chars = jsonParse<any[]>(session.character_ids, []);
    const charIds = chars.map((c: any) => typeof c === 'string' ? c : (c?.characterId ?? c?.id)).filter(Boolean);
    const characterNames = charIds.map((id: string) => getCharacterName(id)).filter(Boolean);
    const characterName = characterNames.length ? characterNames.join('、') : '未知角色';
    const participants = charIds.map((id: string) => ({ characterId: id, name: getCharacterName(id) }));

    let locationName = '';
    if (session.root_location_id) {
      const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(session.root_location_id) as { name: string } | undefined;
      locationName = loc?.name ?? '';
    }

    // 场景整体摘要
    const summaryRow = db.prepare(`
      SELECT summary FROM turn_memory_fold
      WHERE player_id = ? AND scene_session_id = ? AND fold_type = 'date_summary'
      ORDER BY created_at DESC LIMIT 1
    `).get(playerId, sessionId) as { summary: string } | undefined;

    return reply.send({
      session: {
        id: session.id,
        sceneType: session.scene_type,
        characterId: charIds[0] ?? '',
        characterName,
        isGroup: charIds.length > 1,
        participants,
        locationId: session.root_location_id,
        locationName,
        summary: summaryRow?.summary ?? '',
        roundNo: session.round_no,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
      messages,
    });
  });

  // ─── 场景剧本列表（scene_type='scenario'）──────────────────────
  app.get('/archive/scene-scenarios', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { q } = req.query as { q?: string };
    const search = q?.trim() || '';

    let rows = db.prepare(`
      SELECT ss.id, ss.scenario_id, ss.character_ids, ss.goal_achieved,
             ss.dream_text, ss.dream_custom, ss.created_at, ss.updated_at,
             sc.title as scenario_title, sc.description as scenario_description
      FROM scene_sessions ss
      JOIN scenarios sc ON sc.id = ss.scenario_id
      WHERE ss.player_id = ? AND ss.ended = 1 AND ss.scene_type = 'scenario'
      ORDER BY ss.created_at DESC
    `).all(playerId) as Array<{
      id: string; scenario_id: string; character_ids: string; goal_achieved: number;
      dream_text: string | null; dream_custom: number; created_at: number; updated_at: number;
      scenario_title: string; scenario_description: string;
    }>;

    let result = rows.map(r => {
      const chars = jsonParse<any[]>(r.character_ids, []);
      const charIds = chars.map((c: any) => typeof c === 'string' ? c : (c?.characterId ?? c?.id)).filter(Boolean);
      const characterNames = charIds.map((id: string) => getCharacterName(id)).filter(Boolean);
      const characterName = characterNames.length ? characterNames.join('、') : '未知角色';

      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM scene_messages WHERE scene_session_id = ?').get(r.id) as { cnt: number };

      return {
        id: r.id,
        scenarioId: r.scenario_id,
        scenarioTitle: r.scenario_title,
        scenarioDescription: r.scenario_description,
        characterId: charIds[0] ?? '',
        characterName,
        isGroup: charIds.length > 1,
        goalAchieved: r.goal_achieved === 1,
        dreamText: r.dream_text,
        messageCount: msgCount.cnt,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    if (search) {
      result = result.filter(r =>
        r.scenarioTitle.includes(search) ||
        r.characterName.includes(search) ||
        (r.dreamText ?? '').includes(search)
      );
    }

    return reply.send({ sessions: result });
  });

  // ─── 场景剧本详情 ─────────────────────────────────────────
  app.get('/archive/scene-scenarios/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare(`
      SELECT ss.id, ss.scenario_id, ss.character_ids, ss.round_no, ss.goal_achieved,
             ss.dream_text, ss.dream_custom, ss.created_at, ss.updated_at,
             ss.worldview, ss.player_role, ss.npc_roles, ss.goal, ss.opening_scene,
             ss.ended,
             ss.stats_config, ss.stats_state,
             sc.title as scenario_title, sc.description as scenario_description
      FROM scene_sessions ss
      JOIN scenarios sc ON sc.id = ss.scenario_id
      WHERE ss.id = ? AND ss.player_id = ? AND ss.ended = 1 AND ss.scene_type = 'scenario'
    `).get(sessionId, playerId) as {
      id: string; scenario_id: string; character_ids: string; round_no: number; goal_achieved: number;
      dream_text: string | null; dream_custom: number; created_at: number; updated_at: number;
      worldview: string; player_role: string; npc_roles: string; goal: string; opening_scene: string;
      ended: number;
      stats_config: string; stats_state: string;
      scenario_title: string; scenario_description: string;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: '场景剧本记录不存在' });
    }

    const messages = db.prepare(`
      SELECT id, role, character_id, character_name, text, internal, internal_notable, created_at
      FROM scene_messages WHERE scene_session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as Array<{
      id: string; role: string; character_id: string | null; character_name: string;
      text: string; internal: string; internal_notable: number; created_at: number;
    }>;

    const chars = jsonParse<any[]>(session.character_ids, []);
    const charIds = chars.map((c: any) => typeof c === 'string' ? c : (c?.characterId ?? c?.id)).filter(Boolean);
    const characterNames = charIds.map((id: string) => getCharacterName(id)).filter(Boolean);
    const characterName = characterNames.length ? characterNames.join('、') : '未知角色';

    return reply.send({
      session: {
        id: session.id,
        scenarioId: session.scenario_id,
        scenarioTitle: session.scenario_title,
        scenarioDescription: session.scenario_description,
        characterId: charIds[0] ?? '',
        characterName,
        isGroup: charIds.length > 1,
        worldview: session.worldview ?? '',
        playerRole: session.player_role ?? '',
        npcRoles: parseNpcRoles(session.npc_roles ?? '[]'),
        openingScene: session.opening_scene ?? '',
        goal: session.goal ?? '',
        statsConfig: jsonParse(session.stats_config ?? '[]', []),
        statsState: jsonParse(session.stats_state ?? '{}', {}),
        goalAchieved: session.goal_achieved === 1,
        dreamText: session.dream_text,
        dreamCustom: session.dream_custom === 1,
        ended: session.ended === 1,
        roundNo: session.round_no,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
      messages,
    });
  });

  // ─── 约会详情 ─────────────────────────────────────────────
  app.get('/archive/dates/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare(`
      SELECT id, character_id, location_id, mode, is_group, summary, created_at, updated_at
      FROM conversation_sessions
      WHERE id = ? AND player_id = ? AND ended = 1 AND scenario_session_id IS NULL
    `).get(sessionId, playerId) as {
      id: string; character_id: string; location_id: string | null;
      mode: string; is_group: number; summary: string;
      created_at: number; updated_at: number;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: '约会记录不存在' });
    }

    const messages = db.prepare(`
      SELECT id, role, text, speaker, internal, internal_notable, internal_viewed, created_at
      FROM messages WHERE session_id = ? ORDER BY created_at ASC
    `).all(sessionId) as Array<{
      id: string; role: string; text: string; speaker: string | null;
      internal: string; internal_notable: number; internal_viewed: number;
      created_at: number;
    }>;

    let characterName = getCharacterName(session.character_id);
    let participants: { characterId: string; name: string }[] = [];
    if (session.is_group) {
      const parts = db.prepare(`
        SELECT character_id FROM session_participants
        WHERE session_id = ? ORDER BY join_order
      `).all(sessionId) as { character_id: string }[];
      participants = parts.map(p => ({ characterId: p.character_id, name: getCharacterName(p.character_id) }));
      characterName = participants.map(p => p.name).join('、');
    }

    let locationName = '';
    if (session.location_id) {
      const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(session.location_id) as { name: string } | undefined;
      locationName = loc?.name ?? '';
    }

    return reply.send({
      session: {
        id: session.id,
        characterId: session.character_id,
        characterName,
        isGroup: session.is_group === 1,
        participants,
        locationId: session.location_id,
        locationName,
        mode: session.mode,
        summary: session.summary,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
      },
      messages,
    });
  });

  // ─── 短信列表 ─────────────────────────────────────────────
  app.get('/archive/sms', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { q } = req.query as { q?: string };
    const search = q?.trim() || '';

    const threads = db.prepare(`
      SELECT t.id, t.character_id, t.last_message_at, t.created_at
      FROM message_threads t
      WHERE t.player_id = ?
      ORDER BY t.last_message_at DESC
    `).all(playerId) as Array<{
      id: string; character_id: string; last_message_at: number | null; created_at: number;
    }>;

    const result = threads.map(t => {
      const characterName = getCharacterName(t.character_id);

      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM text_messages WHERE thread_id = ?').get(t.id) as { cnt: number };

      let matched = true;
      if (search) {
        // 先匹配角色名
        matched = characterName.includes(search);
        // 再匹配消息内容
        if (!matched) {
          const hit = db.prepare(`
            SELECT 1 FROM text_messages WHERE thread_id = ? AND body LIKE '%' || ? || '%' ESCAPE '\\' LIMIT 1
          `).get(t.id, escapeLike(search)) as { 1: number } | undefined;
          matched = !!hit;
        }
      }

      return {
        id: t.id,
        characterId: t.character_id,
        characterName,
        messageCount: msgCount.cnt,
        lastMessageAt: t.last_message_at,
        createdAt: t.created_at,
        _matched: matched,
      };
    }).filter(t => t._matched).map(({ _matched, ...rest }) => rest);

    return reply.send({ threads: result });
  });

  // ─── 短信详情 ─────────────────────────────────────────────
  app.get('/archive/sms/:threadId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { threadId } = req.params as { threadId: string };
    const thread = db.prepare('SELECT * FROM message_threads WHERE id = ? AND player_id = ?').get(threadId, playerId) as {
      id: string; character_id: string; player_id: string; created_at: number;
    } | undefined;

    if (!thread) {
      return reply.code(404).send({ error: '短信记录不存在' });
    }

    const messages = db.prepare(`
      SELECT id, sender, body, image_asset_id, internal, internal_notable, internal_viewed, created_at, delivered_at
      FROM text_messages WHERE thread_id = ? ORDER BY created_at ASC
    `).all(threadId) as Array<{
      id: string; sender: string; body: string; image_asset_id: string | null;
      internal: string; internal_notable: number; internal_viewed: number;
      created_at: number; delivered_at: number | null;
    }>;

    const characterName = getCharacterName(thread.character_id);

    return reply.send({
      thread: {
        id: thread.id,
        characterId: thread.character_id,
        characterName,
        createdAt: thread.created_at,
      },
      messages,
    });
  });

  // ─── 剧本游玩历史 ─────────────────────────────────────────
  app.get('/archive/scenarios', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { q } = req.query as { q?: string };
    const search = q?.trim() || '';

    const rows = db.prepare(`
      SELECT ss.id, ss.scenario_id, ss.character_id, ss.goal_achieved,
             ss.dream_text, ss.dream_custom, ss.ended, ss.created_at, ss.updated_at,
             s.title as scenario_title, s.description as scenario_description
      FROM scenario_sessions ss
      JOIN scenarios s ON s.id = ss.scenario_id
      WHERE ss.player_id = ?
      ORDER BY ss.created_at DESC
    `).all(playerId) as Array<{
      id: string; scenario_id: string; character_id: string; goal_achieved: number;
      dream_text: string | null; dream_custom: number; ended: number;
      created_at: number; updated_at: number;
      scenario_title: string; scenario_description: string;
    }>;

    let result = rows.map(r => {
      // 关联的conversation_session
      const cs = db.prepare('SELECT id FROM conversation_sessions WHERE scenario_session_id = ?').get(r.id) as { id: string } | undefined;
      const msgCount = cs ? (db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(cs.id) as { cnt: number }).cnt : 0;

      return {
        id: r.id,
        scenarioId: r.scenario_id,
        scenarioTitle: r.scenario_title,
        scenarioDescription: r.scenario_description,
        characterId: r.character_id,
        characterName: getCharacterName(r.character_id),
        goalAchieved: r.goal_achieved === 1,
        dreamText: r.dream_text,
        dreamCustom: r.dream_custom === 1,
        ended: r.ended === 1,
        messageCount: msgCount,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    if (search) {
      result = result.filter(r =>
        r.scenarioTitle.includes(search) ||
        r.characterName.includes(search) ||
        (r.dreamText ?? '').includes(search)
      );
    }

    return reply.send({ sessions: result });
  });

  // ─── 剧本会话详情 ─────────────────────────────────────────
  app.get('/archive/scenarios/:scenarioSessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { scenarioSessionId } = req.params as { scenarioSessionId: string };
    const ss = db.prepare(`
      SELECT ss.*, s.title as scenario_title, s.description as scenario_description,
             s.worldview, s.player_role, s.npc_role, s.opening_scene, s.greeting, s.goal, s.stats_config
      FROM scenario_sessions ss
      JOIN scenarios s ON s.id = ss.scenario_id
      WHERE ss.id = ? AND ss.player_id = ?
    `).get(scenarioSessionId, playerId) as {
      id: string; scenario_id: string; character_id: string; stats_state: string;
      goal_achieved: number; dream_text: string | null; dream_custom: number; ended: number;
      created_at: number; updated_at: number;
      scenario_title: string; scenario_description: string;
      worldview: string; player_role: string; npc_role: string;
      opening_scene: string; greeting: string; goal: string; stats_config: string;
    } | undefined;

    if (!ss) {
      return reply.code(404).send({ error: '剧本记录不存在' });
    }

    const cs = db.prepare('SELECT id FROM conversation_sessions WHERE scenario_session_id = ?').get(scenarioSessionId) as { id: string } | undefined;
    const messages = cs ? (db.prepare(`
      SELECT id, role, text, internal, internal_notable, internal_viewed, created_at
      FROM messages WHERE session_id = ? ORDER BY created_at ASC
    `).all(cs.id) as Array<{
      id: string; role: string; text: string; internal: string;
      internal_notable: number; internal_viewed: number; created_at: number;
    }>) : [];

    return reply.send({
      session: {
        id: ss.id,
        scenarioId: ss.scenario_id,
        scenarioTitle: ss.scenario_title,
        scenarioDescription: ss.scenario_description,
        worldview: ss.worldview,
        playerRole: ss.player_role,
        npcRole: ss.npc_role,
        openingScene: ss.opening_scene,
        greeting: ss.greeting,
        goal: ss.goal,
        statsConfig: jsonParse(ss.stats_config, []),
        statsState: jsonParse(ss.stats_state, {}),
        characterId: ss.character_id,
        characterName: getCharacterName(ss.character_id),
        goalAchieved: ss.goal_achieved === 1,
        dreamText: ss.dream_text,
        dreamCustom: ss.dream_custom === 1,
        ended: ss.ended === 1,
        createdAt: ss.created_at,
        updatedAt: ss.updated_at,
      },
      messages,
    });
  });

  // ─── 导出Markdown ─────────────────────────────────────────
  app.post('/archive/export', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { type, ids } = req.body as {
      type: 'date' | 'sms' | 'scenario' | 'scene' | 'scene-scenario';
      ids: string[];  // 要导出的记录ID列表，空=导出全部
    };

    let md = '';

    if (type === 'date') {
      let sessions;
      if (ids && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        sessions = db.prepare(`
          SELECT id, character_id, location_id, is_group, summary, created_at, updated_at
          FROM conversation_sessions
          WHERE player_id = ? AND ended = 1 AND scenario_session_id IS NULL AND id IN (${placeholders})
          ORDER BY created_at ASC
        `).all(playerId, ...ids) as Array<{
          id: string; character_id: string; location_id: string | null;
          is_group: number; summary: string; created_at: number; updated_at: number;
        }>;
      } else {
        sessions = db.prepare(`
          SELECT id, character_id, location_id, is_group, summary, created_at, updated_at
          FROM conversation_sessions
          WHERE player_id = ? AND ended = 1 AND scenario_session_id IS NULL
          ORDER BY created_at ASC
        `).all(playerId) as Array<{
          id: string; character_id: string; location_id: string | null;
          is_group: number; summary: string; created_at: number; updated_at: number;
        }>;
      }

      md = `# 约会回忆录\n\n共 ${sessions.length} 段约会\n\n---\n\n`;

      for (const s of sessions) {
        let charName = getCharacterName(s.character_id);
        if (s.is_group) {
          const parts = db.prepare('SELECT character_id FROM session_participants WHERE session_id = ? ORDER BY join_order').all(s.id) as { character_id: string }[];
          charName = parts.map(p => getCharacterName(p.character_id)).join('、');
        }
        let locName = '';
        if (s.location_id) {
          const loc = db.prepare('SELECT name FROM locations WHERE id = ?').get(s.location_id) as { name: string } | undefined;
          locName = loc?.name ?? '';
        }

        md += `## ${charName}${locName ? ` · ${locName}` : ''}\n`;
        md += `> ${fmtDate(s.created_at)}${s.updated_at !== s.created_at ? ` ~ ${fmtDate(s.updated_at)}` : ''}\n\n`;
        if (s.summary) md += `**摘要：** ${s.summary}\n\n`;

        const msgs = db.prepare(`
          SELECT role, text, speaker, internal, internal_viewed, created_at
          FROM messages WHERE session_id = ? ORDER BY created_at ASC
        `).all(s.id) as Array<{
          role: string; text: string; speaker: string | null;
          internal: string; internal_viewed: number; created_at: number;
        }>;

        for (const m of msgs) {
          const time = fmtDate(m.created_at);
          if (m.role === 'player') {
            md += `**我**（${time}）\n\n${m.text}\n\n`;
          } else {
            const speakerName = m.speaker ? getCharacterName(m.speaker) : charName;
            md += `**${speakerName}**（${time}）\n\n${m.text}\n\n`;
            // 只导出已查看的独白
            if (m.internal && m.internal_viewed === 1) {
              md += `> *（${m.internal}）*\n\n`;
            }
          }
        }

        md += `---\n\n`;
      }

    } else if (type === 'sms') {
      let threads;
      if (ids && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        threads = db.prepare(`
          SELECT id, character_id, created_at FROM message_threads
          WHERE player_id = ? AND id IN (${placeholders})
          ORDER BY last_message_at DESC
        `).all(playerId, ...ids) as Array<{ id: string; character_id: string; created_at: number }>;
      } else {
        threads = db.prepare(`
          SELECT id, character_id, created_at FROM message_threads
          WHERE player_id = ?
          ORDER BY last_message_at DESC
        `).all(playerId) as Array<{ id: string; character_id: string; created_at: number }>;
      }

      md = `# 短信回忆录\n\n共 ${threads.length} 个对话\n\n---\n\n`;

      for (const t of threads) {
        const charName = getCharacterName(t.character_id);
        md += `## 与${charName}的短信\n\n`;

        const msgs = db.prepare(`
          SELECT sender, body, internal, internal_viewed, created_at
          FROM text_messages WHERE thread_id = ? ORDER BY created_at ASC
        `).all(t.id) as Array<{
          sender: string; body: string; internal: string;
          internal_viewed: number; created_at: number;
        }>;

        for (const m of msgs) {
          const time = fmtDate(m.created_at);
          if (m.sender === 'player') {
            md += `**我**（${time}）\n\n${m.body}\n\n`;
          } else {
            md += `**${charName}**（${time}）\n\n${m.body}\n\n`;
            if (m.internal && m.internal_viewed === 1) {
              md += `> *（${m.internal}）*\n\n`;
            }
          }
        }

        md += `---\n\n`;
      }

    } else if (type === 'scenario') {
      let sessions;
      if (ids && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        sessions = db.prepare(`
          SELECT ss.id, ss.scenario_id, ss.character_id, ss.goal_achieved,
                 ss.dream_text, ss.dream_custom, ss.ended, ss.created_at, ss.updated_at,
                 s.title as scenario_title, s.worldview, s.player_role, s.npc_role,
                 s.opening_scene, s.greeting, s.goal
          FROM scenario_sessions ss
          JOIN scenarios s ON s.id = ss.scenario_id
          WHERE ss.player_id = ? AND ss.id IN (${placeholders})
          ORDER BY ss.created_at ASC
        `).all(playerId, ...ids) as Array<{
          id: string; scenario_id: string; character_id: string; goal_achieved: number;
          dream_text: string | null; dream_custom: number; ended: number;
          created_at: number; updated_at: number;
          scenario_title: string; worldview: string; player_role: string; npc_role: string;
          opening_scene: string; greeting: string; goal: string;
        }>;
      } else {
        sessions = db.prepare(`
          SELECT ss.id, ss.scenario_id, ss.character_id, ss.goal_achieved,
                 ss.dream_text, ss.dream_custom, ss.ended, ss.created_at, ss.updated_at,
                 s.title as scenario_title, s.worldview, s.player_role, s.npc_role,
                 s.opening_scene, s.greeting, s.goal
          FROM scenario_sessions ss
          JOIN scenarios s ON s.id = ss.scenario_id
          WHERE ss.player_id = ?
          ORDER BY ss.created_at ASC
        `).all(playerId) as Array<{
          id: string; scenario_id: string; character_id: string; goal_achieved: number;
          dream_text: string | null; dream_custom: number; ended: number;
          created_at: number; updated_at: number;
          scenario_title: string; worldview: string; player_role: string; npc_role: string;
          opening_scene: string; greeting: string; goal: string;
        }>;
      }

      md = `# 剧本回忆录\n\n共 ${sessions.length} 次剧本\n\n---\n\n`;

      for (const s of sessions) {
        const charName = getCharacterName(s.character_id);
        md += `## ${s.scenario_title}（${charName}）\n`;
        md += `> ${fmtDate(s.created_at)}${s.updated_at !== s.created_at ? ` ~ ${fmtDate(s.updated_at)}` : ''}\n\n`;
        if (s.worldview) md += `**世界观：** ${s.worldview}\n\n`;
        if (s.player_role) md += `**我的身份：** ${s.player_role}\n\n`;
        if (s.npc_role) md += `**${charName}的身份：** ${s.npc_role}\n\n`;
        if (s.opening_scene) md += `**开局情境：** ${s.opening_scene}\n\n`;
        if (s.goal) md += `**目标：** ${s.goal}\n\n`;
        if (s.goal_achieved) md += `✅ 目标达成\n\n`;

        // 对话
        const cs = db.prepare('SELECT id FROM conversation_sessions WHERE scenario_session_id = ?').get(s.id) as { id: string } | undefined;
        if (cs) {
          const msgs = db.prepare(`
            SELECT role, text, internal, internal_viewed, created_at
            FROM messages WHERE session_id = ? ORDER BY created_at ASC
          `).all(cs.id) as Array<{
            role: string; text: string; internal: string;
            internal_viewed: number; created_at: number;
          }>;

          md += `### 对话\n\n`;
          for (const m of msgs) {
            const time = fmtDate(m.created_at);
            if (m.role === 'player') {
              md += `**我**（${time}）\n\n${m.text}\n\n`;
            } else {
              md += `**${charName}**（${time}）\n\n${m.text}\n\n`;
              if (m.internal && m.internal_viewed === 1) {
                md += `> *（${m.internal}）*\n\n`;
              }
            }
          }
        }

        if (s.dream_text) {
          md += `### 梦\n\n${s.dream_text}\n\n`;
        }

        md += `---\n\n`;
      }
    } else if (type === 'scene') {
      // 场景约会（新地图）
      let sessions;
      if (ids && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        sessions = db.prepare(`
          SELECT id, scene_type, root_location_id, character_ids, created_at, updated_at
          FROM scene_sessions
          WHERE player_id = ? AND ended = 1 AND scene_type = 'date' AND id IN (${placeholders})
          ORDER BY created_at ASC
        `).all(playerId, ...ids) as Array<{
          id: string; scene_type: string; root_location_id: string | null; character_ids: string;
          created_at: number; updated_at: number;
        }>;
      } else {
        sessions = db.prepare(`
          SELECT id, scene_type, root_location_id, character_ids, created_at, updated_at
          FROM scene_sessions
          WHERE player_id = ? AND ended = 1 AND scene_type = 'date'
          ORDER BY created_at ASC
        `).all(playerId) as Array<{
          id: string; scene_type: string; root_location_id: string | null; character_ids: string;
          created_at: number; updated_at: number;
        }>;
      }

      md = `# 场景约会回忆录\n\n共 ${sessions.length} 场场景约会\n\n---\n\n`;

      for (const s of sessions) {
        const chars = jsonParse<any[]>(s.character_ids, []);
        const charIds = chars.map((c: any) => typeof c === 'string' ? c : (c?.characterId ?? c?.id)).filter(Boolean);
        const charName = charIds.map((id: string) => getCharacterName(id)).filter(Boolean).join('、') || '未知角色';
        let locName = '';
        if (s.root_location_id) {
          const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(s.root_location_id) as { name: string } | undefined;
          locName = loc?.name ?? '';
        }

        md += `## ${charName}${locName ? ` · ${locName}` : ''}\n`;
        md += `> ${fmtDate(s.created_at)}${s.updated_at !== s.created_at ? ` ~ ${fmtDate(s.updated_at)}` : ''}\n\n`;

        // 场景整体摘要
        const summaryRow = db.prepare(`
          SELECT summary FROM turn_memory_fold
          WHERE player_id = ? AND scene_session_id = ? AND fold_type = 'date_summary'
          ORDER BY created_at DESC LIMIT 1
        `).get(playerId, s.id) as { summary: string } | undefined;
        if (summaryRow?.summary) md += `**摘要：** ${summaryRow.summary}\n\n`;

        const msgs = db.prepare(`
          SELECT role, character_name, text, internal, internal_notable, created_at
          FROM scene_messages WHERE scene_session_id = ? ORDER BY created_at ASC
        `).all(s.id) as Array<{
          role: string; character_name: string; text: string; internal: string;
          internal_notable: number; created_at: number;
        }>;

        for (const m of msgs) {
          const time = fmtDate(m.created_at);
          if (m.role === 'player') {
            md += `**我**（${time}）\n\n${m.text}\n\n`;
          } else if (m.role === 'narrator' || m.role === 'narration') {
            md += `*（旁白 · ${time}）${m.text}*\n\n`;
          } else {
            md += `**${m.character_name}**（${time}）\n\n${m.text}\n\n`;
            if (m.internal) {
              md += `> *（${m.internal}）*\n\n`;
            }
          }
        }

        md += `---\n\n`;
      }
    } else if (type === 'scene-scenario') {
      // 场景剧本（scene_type='scenario'）
      let sessions;
      if (ids && ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        sessions = db.prepare(`
          SELECT ss.id, ss.scenario_id, ss.character_ids, ss.goal_achieved,
                 ss.dream_text, ss.created_at, ss.updated_at,
                 ss.worldview, ss.player_role, ss.npc_roles, ss.goal, ss.opening_scene,
                 sc.title as scenario_title
          FROM scene_sessions ss
          JOIN scenarios sc ON sc.id = ss.scenario_id
          WHERE ss.player_id = ? AND ss.ended = 1 AND ss.scene_type = 'scenario' AND ss.id IN (${placeholders})
          ORDER BY ss.created_at ASC
        `).all(playerId, ...ids) as Array<{
          id: string; scenario_id: string; character_ids: string; goal_achieved: number;
          dream_text: string | null; created_at: number; updated_at: number;
          worldview: string; player_role: string; npc_roles: string; goal: string; opening_scene: string;
          scenario_title: string;
        }>;
      } else {
        sessions = db.prepare(`
          SELECT ss.id, ss.scenario_id, ss.character_ids, ss.goal_achieved,
                 ss.dream_text, ss.created_at, ss.updated_at,
                 ss.worldview, ss.player_role, ss.npc_roles, ss.goal, ss.opening_scene,
                 sc.title as scenario_title
          FROM scene_sessions ss
          JOIN scenarios sc ON sc.id = ss.scenario_id
          WHERE ss.player_id = ? AND ss.ended = 1 AND ss.scene_type = 'scenario'
          ORDER BY ss.created_at ASC
        `).all(playerId) as Array<{
          id: string; scenario_id: string; character_ids: string; goal_achieved: number;
          dream_text: string | null; created_at: number; updated_at: number;
          worldview: string; player_role: string; npc_roles: string; goal: string; opening_scene: string;
          scenario_title: string;
        }>;
      }

      md = `# 场景剧本回忆录\n\n共 ${sessions.length} 次剧本\n\n---\n\n`;

      for (const s of sessions) {
        const chars = jsonParse<any[]>(s.character_ids, []);
        const charIds = chars.map((c: any) => typeof c === 'string' ? c : (c?.characterId ?? c?.id)).filter(Boolean);
        const charName = charIds.map((id: string) => getCharacterName(id)).filter(Boolean).join('、') || '未知角色';

        md += `## ${s.scenario_title}（${charName}）\n`;
        md += `> ${fmtDate(s.created_at)}${s.updated_at !== s.created_at ? ` ~ ${fmtDate(s.updated_at)}` : ''}\n\n`;
        if (s.worldview) md += `**世界观：** ${s.worldview}\n\n`;
        if (s.player_role) md += `**我的身份：** ${s.player_role}\n\n`;
        if (s.opening_scene) md += `**开局情境：** ${s.opening_scene}\n\n`;
        if (s.goal) md += `**目标：** ${s.goal}\n\n`;
        if (s.goal_achieved) md += `✅ 目标达成\n\n`;

        const msgs = db.prepare(`
          SELECT role, character_name, text, internal, internal_notable, created_at
          FROM scene_messages WHERE scene_session_id = ? ORDER BY created_at ASC
        `).all(s.id) as Array<{
          role: string; character_name: string; text: string; internal: string;
          internal_notable: number; created_at: number;
        }>;

        for (const m of msgs) {
          const time = fmtDate(m.created_at);
          if (m.role === 'player') {
            md += `**我**（${time}）\n\n${m.text}\n\n`;
          } else if (m.role === 'narrator' || m.role === 'narration') {
            md += `*（旁白 · ${time}）${m.text}*\n\n`;
          } else {
            md += `**${m.character_name}**（${time}）\n\n${m.text}\n\n`;
            if (m.internal) {
              md += `> *（${m.internal}）*\n\n`;
            }
          }
        }

        if (s.dream_text) {
          md += `### 梦\n\n${s.dream_text}\n\n`;
        }

        md += `---\n\n`;
      }
    }

    return reply.send({ markdown: md });
  });
}
