/**
 * 场景引擎路由（新场景引擎试用入口）
 *
 * 先用后端 API 验证场景引擎 + 新表全链路（MIGRATION_DESIGN.md Phase 2/3）：
 *  - POST /scene/start       开一场约会
 *  - POST /scene/:id/advance 推进一轮（真 LLM：导演编排 + 逐拍演员/旁白 + 落库）
 *  - GET  /scene/:id         读当前场景时间线
 *  - POST /scene/:id/end     结束场景（可选，写收尾摘要）
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { ensureSceneSession } from '../lib/scene-session';
import { ensureSceneMap, getNpcs, upsertNpc, getLocationBackground, addBackgroundSubmission, getBackgroundSubmissions } from '../lib/scene-map';
import { advanceScene, judgeMissionGoal } from '../lib/scene-wiring';
import { rollbackScene } from '../lib/scene-rollback';
import { getCharacterName, getCharacterAvatar, loadCharacterData, safeAvatar } from '../lib/character';
import { getSceneSchedule, getSceneUpcomingSchedule } from '../lib/schedule';
import { initUrge } from '../lib/proactive';
import { endSceneSession } from '../lib/scene-end';
import { getActiveLiveSlot } from '../lib/session-mutex';
import { DEITY_ID } from '@idate/shared';

const HUB_WORLD_ID = 'default-world';

/** 构造某地点的路径（拼接父链） */
function sceneLocationPath(locationId: string, cache = new Map<string, string>()): string {
  if (cache.has(locationId)) return cache.get(locationId)!;
  const row = db.prepare('SELECT name, parent_id FROM scene_locations WHERE id = ?').get(locationId) as any;
  if (!row) return '';
  const parent = row.parent_id && row.parent_id !== locationId ? sceneLocationPath(row.parent_id, cache) : '';
  const path = parent ? `${parent} › ${row.name}` : row.name;
  cache.set(locationId, path);
  return path;
}

/** 计算某地点是否有子地点 */
function sceneHasChildren(locationId: string): boolean {
  const r = db.prepare('SELECT COUNT(*) as c FROM scene_locations WHERE parent_id = ? AND id NOT LIKE ?').get(locationId, 'temp-%') as { c: number };
  return (r?.c ?? 0) > 0;
}

/** mission 场景推进后补 goal 判定（约会场景不判「任务完成」）；返回是否达成及原因。 */
async function judgeMissionGoalIfNeeded(
  sessionId: string,
  playerId: string,
  playerMessage: string,
  output: Array<{ kind: string; speaker?: string; content?: string }>,
): Promise<{ goalAchieved: boolean; goalReason: string }> {
  const sessType = db.prepare('SELECT scene_type FROM scene_sessions WHERE id = ?').get(sessionId) as { scene_type: string } | undefined;
  if (sessType?.scene_type !== 'mission') return { goalAchieved: false, goalReason: '' };
  const npcReply = output
    .filter((o) => o.kind === 'character')
    .map((o) => `${o.speaker ?? ''}：${o.content ?? ''}`)
    .join('\n');
  return judgeMissionGoal(sessionId, playerMessage, npcReply, playerId);
}

export async function sceneRoutes(app: FastifyInstance): Promise<void> {
  ensureSceneSession();
  ensureSceneMap();

  // ─── 场景地图：谁在哪个地点（新地图专用，基于 scene_locations + scene_homes）─────
  // 返回每个地点的"确切在场"角色（不含父链传播）——前端无需减法。
  // 父节点的在场由子地点卡片呈现：角色只会出现在他确切所在的地点。
  app.get('/scene/map/npcs', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 所有可见 scene 地点（先建空 map）
    const now = Date.now();
    const visibleLocs = db.prepare(`
      SELECT id FROM scene_locations WHERE world_id = ?
        AND (is_public = 1 OR creator_id = ?)
        AND id NOT LIKE 'temp-%'
    `).all(HUB_WORLD_ID, playerId) as { id: string }[];
    const locationsMap: Record<string, Array<{ characterId: string; name: string; avatarType: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown'; activity: string }>> = {};
    for (const l of visibleLocs) locationsMap[l.id] = [];

    // 好友/认识集合（可见性）
    const friends = new Set((db.prepare('SELECT character_id FROM friendships WHERE player_id = ? AND status = ?').all(playerId, 'active') as { character_id: string }[]).map(f => f.character_id));
    const met = new Set((db.prepare('SELECT character_id FROM relationships WHERE player_id = ?').all(playerId) as { character_id: string }[]).map(r => r.character_id));

    // 每个角色：用 scene 行程生成确切位置
    const chars = db.prepare('SELECT id, character_data FROM characters').all() as { id: string; character_data: string }[];
    for (const c of chars) {
      let charData: Record<string, any>;
      try { const fork = db.prepare('SELECT character_data FROM character_player_data WHERE player_id = ? AND source_character_id = ?').get(playerId, c.id) as { character_data: string } | undefined; charData = JSON.parse(fork?.character_data ?? c.character_data); } catch { continue; }

      const schedule = getSceneSchedule(playerId, c.id, charData, now);
      if (!schedule) continue; // 不在主城
      if (!locationsMap[schedule.locationId]) continue; // 私有地点不可见

      const name = charData.name ?? '未知';
      const avatarFile = (charData.avatar as string) || '';
      // 头像文件缺失检测：经统一 safeAvatar 出口，文件缺失 → 空串，降级为首字头像，避免 <img> 指向破图
      const safeAv = avatarFile ? safeAvatar(avatarFile) : '';
      const avatarInvalid = safeAv === '';
      locationsMap[schedule.locationId]!.push({
        characterId: c.id,
        name,
        avatarType: avatarFile && !avatarInvalid ? 'image' : 'initial',
        avatar: avatarFile && !avatarInvalid ? avatarFile : (name ?? '?')[0],
        visibility: friends.has(c.id) ? 'friend' : met.has(c.id) ? 'stranger' : 'unknown',
        // 面对面能看到对方正在做什么（陌生人也能看，如"正在读书"）；
        // 但这只是当前一小段行为，不构成完整行程——行程 getSceneUpcomingSchedule 仍仅好友可用。
        activity: schedule.activity,
      });
    }

    return reply.send({ locations: locationsMap });
  });

  // ─── 场景行程：点头像看角色现在在哪/接下来去哪（新场景体系）─────────
  app.get('/scene/npcs/:characterId/schedule', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.params as { characterId: string };

    // 好友才能看完整行程（与旧地图一致）
    const isFriend = !!db.prepare('SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, characterId, 'active');
    if (!isFriend) {
      return reply.code(403).send({ error: '只有好友才能查看行程' });
    }

    const charData = loadCharacterData(playerId, characterId);
    if (!charData) {
      return reply.code(404).send({ error: '角色不存在' });
    }

    const now = Date.now();
    const upcoming = getSceneUpcomingSchedule(playerId, characterId, charData, now, 4);

    return reply.send({
      characterId,
      characterName: charData.name ?? '未知',
      current: upcoming[0] ?? null,
      upcoming: upcoming.slice(1),
    });
  });

  // ─── 场景地点 CRUD（新地图 app 用，写 scene_locations 表）──────────────

  // 列出地点（按世界；可带 parentId 过滤子地点）
  app.get('/scene/locations', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { parentId } = req.query as { parentId?: string };
    const rows = db.prepare(
      `SELECT id, name, summary, creator_type, creator_id, is_public, parent_id, home_of, npcs, background_image, created_at
       FROM scene_locations
       WHERE world_id = ?
         AND (is_public = 1 OR creator_id = ?)
         AND id NOT LIKE 'temp-%'
         AND (? IS NULL OR parent_id = ?)
       ORDER BY created_at`
    ).all(HUB_WORLD_ID, playerId, parentId ?? null, parentId ?? null) as any[];
    return reply.send({
      locations: rows.map(r => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        creatorType: r.creator_type,
        creatorId: r.creator_id,
        isPublic: !!r.is_public,
        parentId: r.parent_id,
        path: sceneLocationPath(r.id),
        hasChildren: sceneHasChildren(r.id),
        npcs: getNpcs(r.id),
        isHome: !!r.home_of,
        background: (r.background_image as string | null)?.trim() ?? '',
      })),
    });
  });

  // 建子地点（写 scene_locations）
  app.post('/scene/locations', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { name, summary, parentId, isPublic } = req.body as { name?: string; summary?: string; parentId?: string | null; isPublic?: boolean };
    if (!name?.trim()) return reply.code(400).send({ error: '地点名称不能为空' });
    if (name.trim().length > 30) return reply.code(400).send({ error: '地点名称不能超过30字' });
    if (summary && summary.length > 200) return reply.code(400).send({ error: '地点描述不能超过200字' });

    let validParentId: string | null = null;
    if (parentId) {
      const parent = db.prepare('SELECT id, is_public, creator_id FROM scene_locations WHERE id = ?').get(parentId) as
        { id: string; is_public: number; creator_id: string | null } | undefined;
      if (!parent) return reply.code(400).send({ error: '父地点不存在' });
      if (!parent.is_public && parent.creator_id !== playerId) {
        return reply.code(403).send({ error: '无法在别人的私有地点下创建' });
      }
      validParentId = parent.id;
    }

    const isPub = isPublic !== false ? 1 : 0;
    const locId = genId();
    const ts = now();
    db.prepare(
      `INSERT INTO scene_locations (id, world_id, name, summary, creator_type, creator_id, is_public, parent_id, npcs, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'player', ?, ?, ?, '[]', ?, ?)`
    ).run(locId, HUB_WORLD_ID, name.trim(), summary?.trim() ?? '', playerId, isPub, validParentId, ts, ts);

    return reply.send({
      location: {
        id: locId, name: name.trim(), summary: summary?.trim() ?? '', creatorType: 'player',
        isPublic: isPub === 1, parentId: validParentId, path: sceneLocationPath(locId), hasChildren: false,
        npcs: [], isHome: false,
      },
    });
  });

  // 玩家提交 / 设置某地点的背景图（存 uploads/ 下文件名；空串 = 清除自己那格）
  //   - 私有地点（is_public=0）：只能创建者设 → 直接写公共版 background_image
  //   - 公共地点：任何登录用户可提交 → 写入 background_submitted 池；管理员未挑中时 first-wins 取最早
  app.post('/scene/locations/:id/background', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { id } = req.params as { id: string };
    const { background } = req.body as { background?: string };
    if (typeof background !== 'string') return reply.code(400).send({ error: '需要background字符串' });
    const loc = db.prepare('SELECT id, is_public, creator_id, background_image FROM scene_locations WHERE id = ?').get(id) as
      { id: string; is_public: number; creator_id: string | null; background_image: string | null } | undefined;
    if (!loc) return reply.code(404).send({ error: '地点不存在' });
    const file = background.trim();

    if (!loc.is_public) {
      // 私有地点：只有创建者能设背景
      if (loc.creator_id !== playerId) return reply.code(403).send({ error: '只能设置自己创建的私有地点背景' });
      db.prepare('UPDATE scene_locations SET background_image = ?, updated_at = ? WHERE id = ?')
        .run(file || null, now(), id);
      return reply.send({ ok: true, mode: 'private', background: file });
    }

    // 公共地点：写入提交池（first-wins 由读取侧决定）
    if (file) {
      addBackgroundSubmission(id, playerId, file);
    }
    const subs = getBackgroundSubmissions(id);
    return reply.send({ ok: true, mode: 'public', background: getLocationBackground(id), submissions: subs.map(s => ({ uploaderId: s.uploaderId, image: s.image })) });
  });

  // 添加/替换某地点的路人（按 role 去重覆盖）
  app.post('/scene/locations/:id/npcs', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { id } = req.params as { id: string };
    const { role, name, persona } = req.body as { role?: string; name?: string; persona?: string };
    if (!role?.trim() || !name?.trim()) {
      return reply.code(400).send({ error: '路人角色与名字不能为空' });
    }

    const loc = db.prepare('SELECT id, is_public, creator_id FROM scene_locations WHERE id = ?').get(id) as
      { id: string; is_public: number; creator_id: string | null } | undefined;
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    if (!loc.is_public) {
      // 私有地点：只有创建者能编辑路人
      if (loc.creator_id !== playerId) return reply.code(403).send({ error: '只能编辑自己创建的私有地点路人' });
    }

    upsertNpc(id, { id: '', role: role.trim(), name: name.trim(), persona: persona?.trim() ?? '' });
    return reply.send({ npcs: getNpcs(id) });
  });

  // 获取进行中的场景约会（主页待办用）
  app.get('/scene/active', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const row = db.prepare(`
      SELECT id, scene_type, root_location_id, current_location_id, character_ids, round_no, updated_at
      FROM scene_sessions
      WHERE player_id = ? AND ended = 0 AND scene_type = 'date'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(playerId) as
      | { id: string; scene_type: string; root_location_id: string | null; current_location_id: string | null; character_ids: string; round_no: number; updated_at: number }
      | undefined;

    if (!row || row.round_no <= 0) {
      // 无进行中场景，或已开场但没有任何进度（round 0 = 还没开场）→ 视为无待办
      return reply.send({ session: null });
    }

    const charIds = jsonParse<string[]>(row.character_ids, []);
    const isGroup = charIds.length > 1;
    const names = charIds.map((cid) => getCharacterName(cid)).filter(Boolean);
    const characterName = names.join(' ＆ ') || '角色';
    const participantIds = isGroup ? charIds : charIds.slice(0, 1);

    // 当前地点名（current 兜底 root）— 与 /scene/:sessionId 一致，避免桌面小组件与约会内实际地点不一致
    const effLocId = row.current_location_id || row.root_location_id;
    let locationName = '';
    if (effLocId) {
      const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(effLocId) as { name: string } | undefined;
      locationName = loc?.name ?? '';
    }

    return reply.send({
      session: {
        id: row.id,
        characterId: participantIds[0] ?? '',
        characterName,
        avatar: participantIds[0] ? getCharacterAvatar(playerId, participantIds[0]) : '',
        isGroup,
        participants: charIds.map((cid) => ({ characterId: cid, name: getCharacterName(cid), avatar: getCharacterAvatar(playerId, cid) })),
        locationId: effLocId,
        locationName,
        createdAt: row.updated_at,
      },
    });
  });

  // 开一场约会
  app.post('/scene/start', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const body = (req.body ?? {}) as { locationId?: string; characterIds?: string[]; circumstance?: string };
    const locationId = body.locationId || 'cafe';
    const characterIds = body.characterIds?.length ? body.characterIds : null;
    const circumstance = typeof body.circumstance === 'string' && body.circumstance ? body.circumstance : null;

    // 校验地点存在 + 可见性（公开地点或玩家自己创建的私有地点）
    const loc = db.prepare(
      'SELECT id, name FROM scene_locations WHERE id = ? AND (is_public = 1 OR creator_id = ?)'
    ).get(locationId, playerId) as any;
    if (!loc) {
      return reply.code(404).send({ error: '地点不存在' });
    }

    // 校验角色存在（缺省取一个系统角色，保证能跑）
    let chars: string[] | null = characterIds;
    if (!chars?.length) {
      const anyChar = db.prepare('SELECT id FROM characters ORDER BY created_at LIMIT 1').get() as any;
      chars = anyChar ? [anyChar.id] : null;
    }
    if (!chars?.length) {
      return reply.code(400).send({ error: '无可用的角色，请先创建角色' });
    }
    for (const cid of chars) {
      const exists = db.prepare('SELECT id FROM characters WHERE id = ?').get(cid)
        || db.prepare('SELECT id FROM character_player_data WHERE id = ? AND player_id = ?').get(cid, playerId);
      if (!exists) return reply.code(400).send({ error: `角色 ${cid} 不存在或无权使用` });
    }

    // 过滤掉无效角色（白名单字符）
    chars = chars.filter((c) => /^[a-zA-Z0-9_-]+$/.test(c));

    // 严格同参无缝复用：同地点 + 同角色集(顺序无关) 的进行中场景约会 → 直接续上，
    // 不新建 session、不弹错、不留孤儿。实现"连点两下同一按钮无缝衔接"。
    const normChars = [...chars!].sort();
    const normKey = JSON.stringify(normChars);
    const sameLocActive = db.prepare(
      `SELECT id, character_ids, round_no FROM scene_sessions
       WHERE player_id = ? AND ended = 0 AND root_location_id = ?`
    ).all(playerId, locationId) as Array<{ id: string; character_ids: string; round_no: number }>;
    const same = sameLocActive.find((s) => {
      try {
        const arr = JSON.parse(s.character_ids);
        return Array.isArray(arr) && JSON.stringify([...arr].sort()) === normKey;
      } catch { return false; }
    });
    if (same) {
      return reply.code(200).send({
        sessionId: same.id,
        location: loc.name,
        characters: chars!.map((cid) => getCharacterName(cid)),
        round: same.round_no,
      });
    }

    // 全局现场互斥（原子：检查 + 插入同一事务）：不同现场才弹窗让玩家选「继续原现场」或「结束它进入新的」。
    db.exec('BEGIN');
    try {
      const live = getActiveLiveSlot(playerId);
      if (live) {
        db.exec('ROLLBACK');
        return reply.code(409).send({ error: '已有进行中的现场', live });
      }

      const id = genId();
      const ts = now();
      db.prepare(
        `INSERT INTO scene_sessions (id, player_id, scene_type, root_location_id, current_location_id, character_ids, round_no, stats_state, ended, circumstance, created_at, updated_at)
         VALUES (?, ?, 'date', ?, ?, ?, 0, '{}', 0, ?, ?, ?)`
      ).run(id, playerId, locationId, locationId, JSON.stringify(chars), circumstance, ts, ts);

      db.exec('COMMIT');
      return reply.code(201).send({
        sessionId: id,
        location: loc.name,
        characters: chars!.map((cid) => getCharacterName(cid)),
        round: 0,
      });
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* 事务可能已不在 */ }
      app.log.error({ err }, '开启约会失败');
      return reply.code(500).send({ error: '开启约会失败，请重试' });
    }
  });

  // 推进一轮（可带引用 quote）—— SSE 流式：每生成完一拍就推给前端
  app.post('/scene/:sessionId/advance', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const body = (req.body ?? {}) as { message?: string; quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string } };

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    const send = (data: unknown) => {
      try {
        raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* 连接已断 */ }
    };

    try {
      const result = await advanceScene(playerId, sessionId, body.message, {
        quote: body.quote,
        onDirector: (beats) => {
          send({
            type: 'director',
            beats: beats.map((b) => ({
              kind: b.kind,
              speaker: b.speaker,
              intent: b.intent ?? '',
              type: b.type,
              to: b.to,
            })),
          });
        },
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: {
              kind: b.kind,
              speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
              content: b.content,
              characterId: b.characterId, // 稳定 id：改名后前端不靠名字反查
              internal: b.internal,
              internalNotable: b.internalNotable,
            },
          });
        },
      });
      // mission 场景补 goal 判定（约会场景不判「任务完成」）
      const missionGoal = await judgeMissionGoalIfNeeded(sessionId, playerId, body.message ?? '', result.output);
      send({
        type: 'done',
        sessionId: result.sessionId,
        round: result.roundNo,
        stats: result.statsState,
        statsChanges: result.statsChangesOverall,
        locationId: result.locationId,
        locationName: result.locationName,
        locationBackground: result.locationBackground ?? '',
        goalAchieved: missionGoal.goalAchieved,
        goalReason: missionGoal.goalReason,
      });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '推进失败' });
      raw.end();
    }
  });

  // 继续（无玩家输入的推进，让 NPC/剧情继续）—— 复用 advance，message 为空
  app.post('/scene/:sessionId/continue', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    const send = (data: unknown) => {
      try {
        raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* 连接已断 */ }
    };

    try {
      const result = await advanceScene(playerId, sessionId, undefined, {
        onDirector: (beats) => {
          send({
            type: 'director',
            beats: beats.map((b) => ({
              kind: b.kind,
              speaker: b.speaker,
              intent: b.intent ?? '',
              type: b.type,
              to: b.to,
            })),
          });
        },
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: {
              kind: b.kind,
              speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
              content: b.content,
              characterId: b.characterId, // 稳定 id：改名后前端不靠名字反查
              internal: b.internal,
              internalNotable: b.internalNotable,
            },
          });
        },
      });
      // mission 场景补 goal 判定（约会场景不判「任务完成」）
      const missionGoal = await judgeMissionGoalIfNeeded(sessionId, playerId, '', result.output);
      send({
        type: 'done',
        sessionId: result.sessionId,
        round: result.roundNo,
        stats: result.statsState,
        statsChanges: result.statsChangesOverall,
        locationId: result.locationId,
        locationName: result.locationName,
        locationBackground: result.locationBackground ?? '',
        goalAchieved: missionGoal.goalAchieved,
        goalReason: missionGoal.goalReason,
      });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '推进失败' });
      raw.end();
    }
  });

  // 重试：把最后一轮"回复"重新生成一遍。
  // 语义 = 回退到该轮开始前的状态（记忆/事实/关系描述/统计一并回退），
  // 但保留该轮玩家的发言作为上下文，然后立即重新 advance 生成一批新的回复返回给前端。
  app.post('/scene/:sessionId/retry', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    let hijacked = false;
    try {
      // 重试目标轮的判定：
      //   - 若玩家尚无任何发言（本场从头到尾都没有 player 消息，通常是撤回后回到开场状态），
      //     重试语义 = 整场重新开场：回到开场前，重新生成全新的 greeting（方案 A）。
      //   - 否则重试本轮：保留本轮玩家发言，只重生成 NPC/旁白回复。
      const hasPlayer = !!db.prepare(
        "SELECT 1 FROM scene_messages WHERE scene_session_id = ? AND role = 'player' LIMIT 1"
      ).get(sessionId);
      let targetRound: number;
      if (!hasPlayer) {
        targetRound = 0; // 整场重新开场
      } else {
        // 找最后一个非玩家消息（NPC 或旁白）所在的 round
        const last = db.prepare(
          "SELECT id, round_no FROM scene_messages WHERE scene_session_id = ? AND role != 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
        ).get(sessionId) as any;
        if (!last) return reply.code(400).send({ error: '没有可重试的内容' });
        targetRound = last.round_no;
        if (targetRound < 1) return reply.code(400).send({ error: '没有可重试的内容' });
      }

      // 用 rollbackScene 回退到该轮开始前的状态（删本场该轮起的追加型记忆+向量，
      // 并恢复该轮快照的累积值：stats / 关系描述 / 长期总览）。
      // keepPlayerMessage=true：重试保留本轮玩家发言，只重生成 NPC/旁白回复（不从开头重新开场）。
      // targetRound=0 时走整场删除分支，keepPlayerMessage 无效（全部清空）。
      const res = rollbackScene(playerId, sessionId, targetRound, true);
      if (!res.ok) return reply.code(400).send({ error: res.error ?? '重试失败' });

      // SSE 流式：rollback 后重新生成，每拍完成即推
      const raw = reply.raw;
      raw.setHeader('Content-Type', 'text/event-stream');
      raw.setHeader('Cache-Control', 'no-cache');
      raw.setHeader('Connection', 'keep-alive');
      reply.hijack();
      hijacked = true;
      const send = (data: unknown) => { try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 断连 */ } };

      // rollbackScene 已把 round_no 修正为现存最大轮；重新生成（无玩家输入推进）
      // regenerate:true —— 重试语义是重新生成"回应玩家上一条发言"，须参与"必须有男主回应"兜底。
      // 仅当保留玩家发言（targetRound>0，非整场重新开场）时才置 true；整场重开(targetRound=0)是全新开场，不触发。
      const isRetainPlayerRetry = targetRound > 0;
      const result = await advanceScene(playerId, sessionId, undefined, {
        regenerate: isRetainPlayerRetry,
        onDirector: (beats) => {
          send({
            type: 'director',
            beats: beats.map((b) => ({
              kind: b.kind,
              speaker: b.speaker,
              intent: b.intent ?? '',
              type: b.type,
              to: b.to,
            })),
          });
        },
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: { kind: b.kind, speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'), content: b.content, characterId: b.characterId, internal: b.internal, internalNotable: b.internalNotable },
          });
        },
      });
      send({ type: 'done', ok: true, sessionId, round: result.roundNo });
      raw.end();
    } catch (e: any) {
      if (hijacked) {
        try { reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: e?.message ?? '重试失败' })}\n\n`); reply.raw.end(); } catch { /* 忽略 */ }
      } else {
        return reply.code(500).send({ error: e?.message ?? '重试失败' });
      }
    }
  });

  // 撤回：把状态回退到上一轮（玩家最后一次发言所在轮被撤掉，记忆/事实/关系描述/统计一并回退）
  app.post('/scene/:sessionId/undo', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    // 找玩家最后一条所在轮作为回退目标
    const lastPlayer = db.prepare(
      "SELECT id, round_no FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
    ).get(sessionId) as any;
    if (!lastPlayer) return reply.code(400).send({ error: '没有可撤回的消息' });
    // 回退目标 = 该轮开始前的状态（即 targetRound = lastPlayer.round_no）
    let target = lastPlayer.round_no;
    if (target < 1) target = 1;
    const res = rollbackScene(playerId, sessionId, target);
    if (!res.ok) return reply.code(400).send({ error: res.error ?? '撤回失败' });
    return reply.send({ ok: true, round: target - 1 });
  });

  // 结束约会
  app.post('/scene/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const cur = db.prepare('SELECT ended FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!cur) return reply.code(404).send({ error: '场景不存在' });
    db.prepare('UPDATE scene_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(Date.now(), sessionId);

    // 约会结束收尾：补折记忆 + foldDateSummary + resetEligibleTimer + 朋友圈 + 短信greeting
    endSceneSession(sessionId, playerId).catch(err => {
      console.error('[scene] endSceneSession failed:', err instanceof Error ? err.message : err);
    });

    return reply.send({ ok: true, ended: true });
  });

  // 加好友 — 场景约会里面对面认识后建立好友关系 + 建短信线程
  app.post('/scene/character/:characterId/add-friend', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.params as { characterId: string };

    // 该角色须参与当前玩家的某场进行中场景约会（面对面认识才有权限加）
    const session = db.prepare(`
      SELECT id FROM scene_sessions
      WHERE player_id = ? AND ended = 0 AND json_extract(character_ids, '$') IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get(playerId) as { id: string } | undefined;
    if (!session) return reply.code(400).send({ error: '没有进行中的场景约会' });

    // 校验角色确实在参与者里
    const sess = db.prepare('SELECT character_ids FROM scene_sessions WHERE id = ?').get(session.id) as { character_ids: string } | undefined;
    const charIds = sess ? jsonParse<string[]>(sess.character_ids, []) : [];
    if (!charIds.includes(characterId)) {
      return reply.code(403).send({ error: '该角色不在当前约会中' });
    }

    // DEITY（主神）不能加好友
    if (characterId === DEITY_ID) return reply.code(400).send({ error: '主神不需要加好友' });

    const ts = now();
    // 已好友则直接返回
    const existingFriend = db.prepare('SELECT 1 FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?').get(playerId, characterId, 'active');
    if (existingFriend) return reply.send({ ok: true, alreadyFriend: true });

    db.prepare('INSERT OR REPLACE INTO friendships (player_id, character_id, status, created_at) VALUES (?, ?, ?, ?)')
      .run(playerId, characterId, 'active', ts);

    // 初始化主动消息意愿
    initUrge(playerId, characterId);

    // 建短信线程（已有则忽略）
    const existingThread = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { id: string } | undefined;
    let threadId = existingThread?.id;
    if (!threadId) {
      threadId = genId();
      db.prepare('INSERT INTO message_threads (id, player_id, character_id, last_message_at, unread_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, ?, ?)')
        .run(threadId, playerId, characterId, ts, ts);
    }

    return reply.send({ ok: true, alreadyFriend: false, threadId });
  });

  // 读当前场景时间线
  app.get('/scene/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare(
      'SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?'
    ).get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '场景不存在' });

    const messages = db.prepare(
      'SELECT id, round_no, role, character_id, character_name, text, quote, internal, internal_notable, created_at FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no, created_at'
    ).all(sessionId);

    // 当前地点名（current 兜底 root）
    const effLocId = session.current_location_id || session.root_location_id;
    const loc = effLocId ? db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(effLocId) as { name: string } | undefined : undefined;
    const locationName = loc?.name || '某个地方';
    const locationBackground = getLocationBackground(effLocId);

    // 参与角色 + 好友状态
    const charIds = jsonParse<string[]>(session.character_ids, []);
    const friends = new Set((db.prepare('SELECT character_id FROM friendships WHERE player_id = ? AND status = ?').all(playerId, 'active') as { character_id: string }[]).map(f => f.character_id));
    const participants = charIds.map((cid) => ({
      characterId: cid,
      name: getCharacterName(cid),
      avatar: getCharacterAvatar(playerId, cid) || '',
      isFriend: friends.has(cid),
    }));

    return reply.send({
      sessionId: session.id,
      location: effLocId,
      locationName,
      locationBackground,
      sceneType: session.scene_type,
      round: session.round_no,
      ended: !!session.ended,
      participants,
      messages,
    });
  });
}
