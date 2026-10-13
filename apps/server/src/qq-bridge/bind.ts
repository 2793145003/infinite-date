/**
 * 绑定：扫码 / 手填 AppID、AppSecret 的**落库**部分
 *
 * 扫码那段流程（官方 SDK 的轮询循环）在 qr-session.ts —— 两者最终都走这里的 bindManual，
 * 保证「扫码绑的」和「手填绑的」在库里完全一致。
 *
 * 两个必须注意的点：
 *  1. appSecret 只在**服务端**流转，绝不回前端 —— 前端拿到的只有二维码图。
 *  2. 扫码页默认把接入方显示成「第三方机器人」；想显示「无限心动」，
 *     要发邮件给 qq_bot_api@tencent.com 申请商务合作（不申请也能用）。
 */
import type { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { encryptSecret } from './crypto';

export interface BindRequest {
  playerId: string;
  characterId: string;
}

/** 手填 AppID / AppSecret（扫码成功后也走这里）—— botOpenid 来自扫码结果，能直接开始推送 */
export function bindManual(
  db: DatabaseSync,
  req: BindRequest,
  cred: { appId: string; appSecret: string },
  botOpenidHint?: string,
): { ok: true; bindingId: string } | { ok: false; error: string } {
  const appId = cred.appId.trim();
  const appSecret = cred.appSecret.trim();
  if (!/^\d{6,}$/.test(appId)) return { ok: false, error: 'AppID 看起来不对（应为数字）' };
  if (appSecret.length < 16) return { ok: false, error: 'AppSecret 看起来不对（长度过短）' };

  // 一个机器人只能绑一个角色，一个角色也只能绑一个机器人
  const takenByOther = db.prepare('SELECT character_id FROM qq_bot_bindings WHERE app_id = ? AND NOT (player_id = ? AND character_id = ?)').get(appId, req.playerId, req.characterId) as
    | { character_id: string }
    | undefined;
  if (takenByOther) return { ok: false, error: `这个机器人已经绑给角色 ${takenByOther.character_id} 了` };

  const existing = db.prepare('SELECT id FROM qq_bot_bindings WHERE player_id = ? AND character_id = ?').get(req.playerId, req.characterId) as
    | { id: string }
    | undefined;

  const now = Date.now();
  const bindingId = existing?.id ?? crypto.randomUUID();
  const status = botOpenidHint ? 'active' : 'pending';

  if (existing) {
    // 重新绑定时重置起点：只从此刻开始推，不重放历史
    db.prepare(
      `UPDATE qq_bot_bindings
          SET app_id = ?, app_secret_enc = ?, status = ?, since_ts = ?, last_error = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(appId, encryptSecret(appSecret), status, now, now, bindingId);
  } else {
    db.prepare(
      `INSERT INTO qq_bot_bindings (id, player_id, character_id, app_id, app_secret_enc, user_openid, status, since_ts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(bindingId, req.playerId, req.characterId, appId, encryptSecret(appSecret), botOpenidHint ?? null, status, now, now, now);
  }
  return { ok: true, bindingId };
}

/** 解绑 */
export function unbind(db: DatabaseSync, playerId: string, characterId: string): void {
  db.prepare('DELETE FROM qq_bot_bindings WHERE player_id = ? AND character_id = ?').run(playerId, characterId);
}

/** 列出该玩家所有绑定（给前端卡片状态用；不含任何密钥）*/
export function listBindings(db: DatabaseSync, playerId: string): Array<{
  characterId: string;
  appId: string;
  status: string;
  proactiveEnabled: boolean;
  /** 是否被平台以「没开主动消息」为由拒过 —— 只有真被拒才提示，没被拒就别制造假待办 */
  proactiveBlocked: boolean;
  lastError: string | null;
}> {
  const rows = db
    .prepare(
      `SELECT character_id, app_id, status, proactive_enabled, user_openid, last_error
         FROM qq_bot_bindings WHERE player_id = ?`,
    )
    .all(playerId) as Array<Record<string, unknown>>;
  return rows.map(r => {
    const lastError = r.last_error ? String(r.last_error) : null;
    return {
      characterId: String(r.character_id),
      appId: String(r.app_id),
      status: String(r.status),
      proactiveEnabled: Number(r.proactive_enabled ?? 0) === 1,
      hasOpenid: Boolean(r.user_openid),
      // 实测：机器人创建者（管理员）默认就能收主动消息，18 条主动推送都成功送达。
      // 所以「proactive_enabled=0」本身不是问题，只有真的被平台拒过才需要提示。
      proactiveBlocked: Boolean(lastError && lastError.includes('主动消息')),
      lastError,
    };
  });
}
