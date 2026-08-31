/**
 * 认证路由
 * 邀请码 → session token
 */
import type { FastifyInstance } from 'fastify';
import { validateInviteCode, issueToken } from '../lib/auth';
import { db } from '../db';
import { checkScheduleChange } from '../lib/proactive';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // 邀请码登录
  app.post('/auth/login', async (req, reply) => {
    const { code } = req.body as { code?: string };
    if (!code) {
      return reply.code(400).send({ error: '请输入邀请码' });
    }

    const playerId = validateInviteCode(code.trim());
    if (!playerId) {
      return reply.code(401).send({ error: '邀请码无效或已吊销' });
    }

    const player = db.prepare('SELECT id, name, pronouns, gender, appearance, avatar, tutorial_step, is_admin FROM players WHERE id = ?').get(playerId) as {
      id: string; name: string; pronouns: string; gender: string; appearance: string; avatar: string; tutorial_step: number; is_admin: number;
    } | undefined;

    if (!player) {
      return reply.code(404).send({ error: '玩家不存在' });
    }

    const token = issueToken(playerId);

    // 设 httpOnly cookie —— <img> 标签无法带 Authorization header，
    // 改用 cookie 认证图片请求，避免 token 暴露在 URL query string 中
    reply.setCookie('auth', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60, // 7天，与 token TTL 一致
    });

    // 上线时检查行程变更意愿累积（不再有离线积压补发）
    // 异步执行，不阻塞登录响应
    checkScheduleChange(playerId).catch(() => {});

    return reply.send({
      token,
      player: {
        id: player.id,
        name: player.name,
        pronouns: player.pronouns,
        gender: player.gender,
        appearance: player.appearance,
        avatar: player.avatar,
        tutorial_step: player.tutorial_step,
        is_admin: !!player.is_admin,
      },
    });
  });

  // 验证token有效性
  app.get('/auth/me', async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: '未认证' });
    }
    const token = auth.slice(7);
    // token验证逻辑在auth.ts里，但这里简单复用
    const { getPlayerIdFromRequest } = await import('../lib/auth');
    const playerId = getPlayerIdFromRequest(req);
    if (!playerId) {
      return reply.code(401).send({ error: 'token无效' });
    }

    const player = db.prepare('SELECT id, name, pronouns, gender, appearance, avatar, tutorial_step, rating_score, is_admin FROM players WHERE id = ?').get(playerId) as {
      id: string; name: string; pronouns: string; gender: string; appearance: string; avatar: string; tutorial_step: number; rating_score: number; is_admin: number;
    } | undefined;

    if (!player) {
      return reply.code(404).send({ error: '玩家不存在' });
    }

    // 权限余额
    const perm = db.prepare('SELECT balance FROM player_permissions WHERE player_id = ?').get(playerId) as { balance: number } | undefined;

    return reply.send({
      player: {
        id: player.id,
        name: player.name,
        pronouns: player.pronouns,
        gender: player.gender,
        appearance: player.appearance,
        avatar: player.avatar,
        tutorial_step: player.tutorial_step,
        rating_score: player.rating_score,
        is_admin: !!player.is_admin,
      },
      permissions: perm?.balance ?? 0,
    });
  });
}
