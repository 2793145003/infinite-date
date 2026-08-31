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

    // 认证：优先 Bearer header（fetch 请求用），其次 httpOnly cookie（<img>标签自动携带）
    // 已下掉 ?token= query 通道——避免 token 暴露在 URL query string 中（审查 P0）
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
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

    // 所有权校验：image_blobs 无 player_id 列，属主编码在 id 前缀 {playerId}_{ts}_{rand}.ext。
    // 非管理员仅能读自己的图片；管理员豁免（审核 NPC 头像需看任意玩家上传的图片）。
    // 共享图片豁免：头像（角色卡模板/玩家 fork）与场景背景图（管理员挑中/玩家提交池）
    // 在公共场景公开展示，对所有已登录用户可见，不属于隐私图。
    // 返回 404 而非 403，不泄露图片是否存在。
    const isAdmin = db.prepare('SELECT is_admin FROM players WHERE id = ?').get(session.player_id) as { is_admin: number } | undefined;
    const isOwner = safeName.startsWith(`${session.player_id}_`);
    if (!isAdmin?.is_admin && !isOwner && !isSharedImage(safeName)) {
      return reply.code(404).send({ error: '图片不存在' });
    }

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

/**
 * 判断某图片是否属于「共享图片」——被角色头像或场景背景图引用。
 * 这类图在公共场景公开展示（主城 NPC 头像、公共地点背景），不属于玩家隐私图，
 * 因此对所有已登录用户可见，豁免上传者所有权校验。
 */
function isSharedImage(filename: string): boolean {
  // 角色头像：角色卡模板
  if (db.prepare("SELECT 1 FROM characters WHERE json_extract(character_data, '$.avatar') = ? LIMIT 1").get(filename)) return true;
  // 角色头像：玩家 fork
  if (db.prepare("SELECT 1 FROM character_player_data WHERE json_extract(character_data, '$.avatar') = ? LIMIT 1").get(filename)) return true;
  // 场景背景图：管理员挑中的公共版
  if (db.prepare('SELECT 1 FROM scene_locations WHERE background_image = ? LIMIT 1').get(filename)) return true;
  // 场景背景图：玩家提交池
  if (db.prepare("SELECT 1 FROM scene_locations, json_each(scene_locations.background_submitted) WHERE json_extract(json_each.value, '$.image') = ? LIMIT 1").get(filename)) return true;
  // 互动小说男主头像：仅已发布（published）小说的角色头像对外公开（公共列表/详情展示）
  if (db.prepare("SELECT 1 FROM novel_characters c JOIN novels n ON n.id = c.novel_id WHERE c.avatar = ? AND n.status = 'published' LIMIT 1").get(filename)) return true;
  return false;
}

function PathExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
