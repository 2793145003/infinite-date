/**
 * QQ 桥接：绑定相关接口
 *
 * 只做「绑定 / 解绑 / 查状态」三件事 —— **收发消息全在独立的桥进程里**
 * （src/qq-bridge/main.ts），主服务只提供 UI 需要的这几个接口。
 *
 * 为什么拆开：
 *  1. 长连接（每个 bot 一条 WebSocket）和轮询放在主服务里会拖累短信主链路；
 *  2. 桥进程可以单独重启、单独观察；
 *  3. 主服务这边只碰新增的 qq_* 表，短信写入路径一行都不动。
 *
 * 绑定的两种方式（星落的要求：只提供二维码 + ID/secret 输入框）：
 *  · 扫码：官方 SDK @tencent-connect/qqbot-connector 建绑定任务 → 我们把 URL 生成二维码
 *  · 手填：AppID + AppSecret
 * 两者最终都落到同一条 bindManual 路径。
 */
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { ensureQqBridgeSchema } from '../qq-bridge/schema';
import { bindManual, listBindings, unbind } from '../qq-bridge/bind';
import { ensureThread } from '../qq-bridge/bridge';
import { generateSmsWelcome } from './sms';
import {
  startQrBindSession,
  getQrBindSession,
  type QrBindSession,
} from '../qq-bridge/qr-session';

/**
 * 绑定成功之后让他主动开口说一句。
 *
 * 为什么放在这里而不是桥里：这条消息是**进库**的（和网页共用一条 thread），
 * 属于无限的业务动作，不是 QQ 通道的事。桥只管把库里新出现的 NPC 消息推出去。
 *
 * 三个防护：① 已经发过就不再发（welcomed_at）；② 失败只吞掉不打扰绑定流程；
 * ③ 线程最后一条已经是他的话，generateSmsWelcome 自己会拒绝（避免连发）。
 */
function maybeWelcome(playerId: string, characterId: string): void {
  try {
    const row = db
      .prepare('SELECT welcomed_at FROM qq_bot_bindings WHERE player_id = ? AND character_id = ?')
      .get(playerId, characterId) as { welcomed_at: number | null } | undefined;
    if (!row || row.welcomed_at) return;

    const ts = Date.now();
    db.prepare('UPDATE qq_bot_bindings SET welcomed_at = ?, updated_at = ? WHERE player_id = ? AND character_id = ?').run(
      ts,
      ts,
      playerId,
      characterId,
    );

    const threadId = ensureThread(db, playerId, characterId);
    generateSmsWelcome(playerId, characterId, threadId).catch(err =>
      console.error('[qq-bridge] 接入后的第一条生成失败:', err instanceof Error ? err.message : err),
    );
  } catch (err) {
    // 生成失败不该影响绑定本身
    console.error('[qq-bridge] maybeWelcome 异常:', err instanceof Error ? err.message : err);
  }
}

export async function qqBridgeRoutes(app: FastifyInstance): Promise<void> {
  // 新增表由这里兜底创建（桥进程没跑过时，前端也能正常显示"未绑定"）
  ensureQqBridgeSchema(db);

  // 没有加密密钥的话绑定一定会失败（AppSecret 无处可存），启动就说清楚，
  // 别等玩家扫完码才发现
  if (!process.env.IDATE_QQ_SECRET_KEY) {
    app.log.warn(
      '[qq-bridge] 缺少 IDATE_QQ_SECRET_KEY，QQ 绑定会失败。生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // 该玩家所有角色的绑定状态 —— 给角色卡片用
  app.get('/qq/bindings', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    return { bindings: listBindings(db, playerId) };
  });

  // 开一个扫码会话，返回可直接 <img src> 的二维码
  app.post('/qq/bind/qr/start', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const body = (req.body ?? {}) as { characterId?: string };
    const characterId = String(body.characterId ?? '').trim();
    if (!characterId) return reply.code(400).send({ error: '缺 characterId' });

    try {
      const s = await startQrBindSession({
        playerId,
        characterId,
        onBound: (cred) => {
          const r = bindManual(db, { playerId, characterId }, { appId: cred.appId, appSecret: cred.appSecret }, cred.userOpenid);
          if (!r.ok) throw new Error(r.error);
          maybeWelcome(playerId, characterId);
        },
      });
      const qrDataUrl = s.qrUrl ? await QRCode.toDataURL(s.qrUrl, { margin: 1, width: 260 }) : '';
      if (!qrDataUrl) {
        return reply.code(502).send({ error: s.error || '拿不到二维码，稍后重试或改用手填 AppID / AppSecret' });
      }
      return { sessionId: s.sessionId, qrDataUrl, state: s.state };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 轮询扫码结果（二维码会过期，SDK 会自己刷新，这里把最新那张图一起返回）
  app.get('/qq/bind/qr/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const s: QrBindSession | undefined = getQrBindSession(sessionId, playerId);
    if (!s) return reply.code(404).send({ error: '会话不存在或已结束' });

    const qrDataUrl = s.qrUrl ? await QRCode.toDataURL(s.qrUrl, { margin: 1, width: 260 }) : '';
    return { state: s.state, qrDataUrl, error: s.error };
  });

  // 手填 AppID / AppSecret
  app.post('/qq/bind/manual', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const body = (req.body ?? {}) as { characterId?: string; appId?: string; appSecret?: string };
    const characterId = String(body.characterId ?? '').trim();
    if (!characterId) return reply.code(400).send({ error: '缺 characterId' });

    const r = bindManual(db, { playerId, characterId }, {
      appId: String(body.appId ?? ''),
      appSecret: String(body.appSecret ?? ''),
    });
    if (!r.ok) return reply.code(400).send({ error: r.error });
    maybeWelcome(playerId, characterId);
    return { ok: true };
  });

  /**
   * 手动触发「他主动开口」那条 —— 给已经绑好的人补发一次，或者用来反复试措辞。
   * 已经有绑定时不会再走绑定流程，所以单独开一个口子。
   *
   * `?force=1` 无视 12 小时静默窗口（只给"重摇一句看措辞"用，正常流程别带）。
   */
  app.post('/qq/welcome/:characterId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.params as { characterId: string };
    const force = Boolean((req.query as { force?: string } | undefined)?.force);

    const bound = db.prepare('SELECT id FROM qq_bot_bindings WHERE player_id = ? AND character_id = ?').get(playerId, characterId);
    if (!bound) return reply.code(400).send({ error: '这个角色还没接入 QQ' });

    const threadId = ensureThread(db, playerId, characterId);
    // 和 generateSmsWelcome 里同一个判据：只有「他刚发过、还没被回」才拦
    const last = db.prepare('SELECT sender, created_at FROM text_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1').get(threadId) as
      | { sender: string; created_at: number }
      | undefined;
    if (!force && last?.sender === 'npc' && Date.now() - last.created_at < 12 * 60 * 60 * 1000) {
      return reply.code(409).send({ error: '他上一条还没回（12 小时内），先回他一句，或者加 ?force=1 重摇一句' });
    }

    const r = await generateSmsWelcome(playerId, characterId, threadId, { force });
    if (!r) return reply.code(502).send({ error: '生成失败，看服务端日志' });
    // 记一下，避免和绑定流程里的那条重复
    db.prepare('UPDATE qq_bot_bindings SET welcomed_at = ?, updated_at = ? WHERE player_id = ? AND character_id = ?').run(
      Date.now(), Date.now(), playerId, characterId,
    );
    return { npcMessages: r.npcMessages };
  });

  // 解绑
  app.delete('/qq/bind/:characterId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { characterId } = req.params as { characterId: string };
    unbind(db, playerId, characterId);
    return { ok: true };
  });

  // 前端拿这个值做「去创建机器人」的跳转
  app.get('/qq/create-bot-url', async () => ({
    url: 'https://q.qq.com/qqbot/openclaw/login.html',
    hint: '手机 QQ 扫码登录后点「创建机器人」即可（个人主体最多 5 个）',
  }));

  void crypto; // 保持 import 稳定，便于后续给会话加签名
}
