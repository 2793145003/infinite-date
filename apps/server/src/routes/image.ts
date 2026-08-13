/**
 * 图片文件服务路由
 * 返回图片文件
 * （2026-08-07：图片二进制从裸 uploads 目录迁入数据库 image_blobs 表，改从 DB 读取）
 * 认证：优先 Bearer header，其次 httpOnly cookie（<img>标签不带 header）
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export async function imageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/uploads/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string };

    // <img>标签不带Authorization header，支持 ?token=xxx query参数
    // 后续将切换到 httpOnly cookie 认证（需后端重启+前端一起上线）
    const query = req.query as { token?: string };
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else if (query.token) {
      token = query.token;
    } else {
      // cookie 认证（httpOnly cookie，<img> 标签自动携带）
      const cookieToken = (req as { cookies?: { auth?: string } }).cookies?.auth;
      if (cookieToken) token = cookieToken;
    }

    if (!token) {
      return reply.code(401).send({ error: '未认证' });
    }

    // 验证token
    const session = db.prepare(
      'SELECT player_id FROM sessions WHERE token = ? AND expires_at > ?',
    ).get(token, Date.now()) as { player_id: string } | undefined;

    if (!session) {
      return reply.code(401).send({ error: 'token无效' });
    }

    // 防止路径穿越：只取 basename
    const safeName = filename.split('/').pop() ?? filename;

    // 从数据库 image_blobs 读取（替代原读磁盘）
    const blob = db.prepare(
      'SELECT data, mimetype FROM image_blobs WHERE id = ?'
    ).get(safeName) as { data: Uint8Array; mimetype: string } | undefined;

    if (!blob) {
      return reply.code(404).send({ error: '图片不存在' });
    }

    const buffer = Buffer.from(blob.data);
    const mime = blob.mimetype || (MIME[PathExt(safeName)] ?? 'application/octet-stream');

    reply.header('Content-Type', mime);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(buffer);
  });
}

function PathExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
