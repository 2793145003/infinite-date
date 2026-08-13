/**
 * 图片上传路由
 * 接收multipart/form-data，存储到数据库 image_blobs 表，返回文件名（imagePath）
 * 图片以base64 data URL形式传给vLLM，不对外暴露文件URL
 * （2026-08-07：图片二进制从裸 uploads 目录迁入数据库，防止文件散失）
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId } from '../lib/util';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

/** 文件头魔数 → 真实 mimetype（防止伪造 mimetype 上传任意二进制） */
function detectMimetype(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
      && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'image/png';
  // GIF: 47 49 46 38 (GIF8)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  // 上传图片
  app.post('/upload/image', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const file = await (req as unknown as { file: () => Promise<{ mimetype: string; toBuffer: () => Promise<Buffer> } | null> }).file();
    if (!file) {
      return reply.code(400).send({ error: '没有文件' });
    }

    // 先校验声明的 mimetype（快速拒绝明显不合法的请求）
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return reply.code(400).send({ error: '不支持的图片格式（仅支持JPEG/PNG/GIF/WebP）' });
    }

    // 读取文件内容
    const buffer = await file.toBuffer();

    // 验证文件大小
    if (buffer.length > MAX_SIZE) {
      return reply.code(400).send({ error: '图片不能超过10MB' });
    }

    // 魔数校验——防止伪造 mimetype 上传任意二进制（如 .html/.svg 含 XSS）
    const realMimetype = detectMimetype(buffer);
    if (!realMimetype) {
      return reply.code(400).send({ error: '文件不是有效的图片' });
    }

    // 生成文件名：用魔数检测到的真实扩展名（不信任客户端 mimetype）
    const ext = realMimetype.split('/')[1];
    const filename = `${playerId}_${Date.now()}_${genId()}.${ext}`;
    const ts = Date.now();

    // 写入数据库 image_blobs 表（替代原写磁盘）
    db.prepare(
      'INSERT INTO image_blobs (id, data, mimetype, size, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(filename, buffer, realMimetype, buffer.length, ts);

    return reply.send({
      imagePath: filename,
      size: buffer.length,
    });
  });
}
