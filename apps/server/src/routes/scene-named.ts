/**
 * 点名版场景引擎路由（scene-named）
 *
 * 与 scene.ts 的输入输出契约保持一致（SSE 事件流：beat / done / error），
 * 区别：
 *  - 内部引擎 = 点名版逐拍点名（advanceScene engine:'named'），而非「导演一次排 beats」
 *  - 不推导演分镜事件（director 前端已隐藏）
 *  - 仍落同一张 scene_messages 表、复用同一套回退/结束/读取逻辑
 *
 * 测完切生产：只需前端把 /scene/* 换成 /scene-named/*。
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth, requireAdmin } from '../lib/auth';
import { genId, jsonParse } from '../lib/util';
import { advanceScene, getSceneEngine } from '../lib/scene-wiring';
import { rollbackScene } from '../lib/scene-rollback';
import { getCharacterName, getCharacterAvatar } from '../lib/character';
import { getLocationBackground } from '../lib/scene-map';
import { endSceneSession } from '../lib/scene-end';

export async function sceneNamedRoutes(app: FastifyInstance): Promise<void> {
  // 读当前引擎开关（可用于确认当前是 director 还是 named）
  app.get('/scene/engine', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return reply.send({ engine: getSceneEngine() });
  });

  // 切换引擎开关（可回退）：body {engine:'director'|'named'}
  // 设 'named' → 所有 /scene/* 推进内部走点名版（前端无感知）；设 'director' → 立即回退旧导演。
  app.put('/scene/engine', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { engine } = (req.body ?? {}) as { engine?: string };
    if (engine !== 'director' && engine !== 'named') {
      return reply.code(400).send({ error: "engine 必须是 'director' 或 'named'" });
    }
    const ts = Date.now();
    db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run('scene_engine', engine, engine);
    return reply.send({ ok: true, engine });
  });

  // 推进一轮（玩家发言）—— 点名版
  app.post('/scene-named/:sessionId/advance', async (req, reply) => {
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
      try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
    };

    try {
      const result = await advanceScene(playerId, sessionId, body.message, {
        quote: body.quote,
        engine: 'named',
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: {
              kind: b.kind,
              speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
              content: b.content,
              characterId: b.characterId,
              internal: b.internal,
              internalNotable: b.internalNotable,
            },
          });
        },
      });
      send({
        type: 'done',
        sessionId: result.sessionId,
        round: result.roundNo,
        stats: result.statsState,
        statsChanges: result.statsChangesOverall,
        locationId: result.locationId,
        locationName: result.locationName,
        locationBackground: result.locationBackground ?? '',
      });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '推进失败' });
      raw.end();
    }
  });

  // 继续（无玩家输入的推进）—— 点名版
  app.post('/scene-named/:sessionId/continue', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    const send = (data: unknown) => {
      try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ }
    };

    try {
      const result = await advanceScene(playerId, sessionId, undefined, {
        engine: 'named',
        onBeat: (b) => {
          send({
            type: 'beat',
            beat: {
              kind: b.kind,
              speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
              content: b.content,
              characterId: b.characterId,
              internal: b.internal,
              internalNotable: b.internalNotable,
            },
          });
        },
      });
      send({
        type: 'done',
        sessionId: result.sessionId,
        round: result.roundNo,
        stats: result.statsState,
        statsChanges: result.statsChangesOverall,
        locationId: result.locationId,
        locationName: result.locationName,
        locationBackground: result.locationBackground ?? '',
      });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '推进失败' });
      raw.end();
    }
  });

  // 重试：回退到该轮开始前状态（保留玩家发言），重新生成 —— 点名版
  app.post('/scene-named/:sessionId/retry', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    let hijacked = false;
    try {
      const hasPlayer = !!db.prepare(
        "SELECT 1 FROM scene_messages WHERE scene_session_id = ? AND role = 'player' LIMIT 1"
      ).get(sessionId);
      let targetRound: number;
      if (!hasPlayer) {
        targetRound = 0;
      } else {
        const last = db.prepare(
          "SELECT id, round_no FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
        ).get(sessionId) as any;
        if (!last) return reply.code(400).send({ error: '没有可重试的内容' });
        targetRound = last.round_no;
        if (targetRound < 1) return reply.code(400).send({ error: '没有可重试的内容' });
      }
      const res = rollbackScene(playerId, sessionId, targetRound, true);
      if (!res.ok) return reply.code(400).send({ error: res.error ?? '重试失败' });

      const raw = reply.raw;
      raw.setHeader('Content-Type', 'text/event-stream');
      raw.setHeader('Cache-Control', 'no-cache');
      raw.setHeader('Connection', 'keep-alive');
      reply.hijack();
      hijacked = true;
      const send = (data: unknown) => { try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 断连 */ } };

      // 重试语义：重新生成"回应玩家上一条发言"——须参与"必须有男主回应"兜底。
      // 仅当保留玩家发言（targetRound>0，非整场重新开场）时置 true；整场重开是全新开场，不触发。
      const isRetainPlayerRetry = targetRound > 0;
      const result = await advanceScene(playerId, sessionId, undefined, {
        engine: 'named',
        regenerate: isRetainPlayerRetry,
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

  // 撤回：回退到上一轮（与现有一致，纯回退不涉及引擎）
  app.post('/scene-named/:sessionId/undo', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const lastPlayer = db.prepare(
      "SELECT id, round_no FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
    ).get(sessionId) as any;
    if (!lastPlayer) return reply.code(400).send({ error: '没有可撤回的消息' });
    let target = lastPlayer.round_no;
    if (target < 1) target = 1;
    const res = rollbackScene(playerId, sessionId, target);
    if (!res.ok) return reply.code(400).send({ error: res.error ?? '撤回失败' });
    return reply.send({ ok: true, round: target - 1 });
  });

  // 结束约会（与现有一致）
  app.post('/scene-named/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '场景会话不存在' });
    if (session.ended) return reply.send({ ok: true, ended: true });
    db.prepare('UPDATE scene_sessions SET ended = 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);

    // 约会结束收尾：补折记忆 + foldDateSummary + resetEligibleTimer + 朋友圈 + 短信greeting
    endSceneSession(sessionId, playerId).catch(err => {
      console.error('[scene-named] endSceneSession failed:', err instanceof Error ? err.message : err);
    });

    return reply.send({ ok: true, ended: true });
  });

  // 读场景时间线（与现有一致，复用同表）
  app.get('/scene-named/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '场景会话不存在' });
    const messages = db.prepare(
      'SELECT id, round_no, role, character_id, character_name, text, quote, internal, internal_notable FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no ASC, created_at ASC'
    ).all(sessionId) as any[];

    const effLocId = session.current_location_id || session.root_location_id;
    const loc = effLocId ? db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(effLocId) as { name: string } | undefined : undefined;
    const locationName = loc?.name || '某个地方';
    const locationBackground = getLocationBackground(effLocId);

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
