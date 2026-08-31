/**
 * AI 生图路由 — 通用生图端点。
 * 手动验证整条链路（gemma 扩写 → Krea 2 出图 → 存库）；
 * 头像 roll / 朋友圈配图 / 聊天照片复用 lib/ai-image 的 generateImage，各自加触发点。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../lib/auth';
import { generateImage } from '../lib/ai-image';

export async function aiImageRoutes(app: FastifyInstance): Promise<void> {
  app.post('/ai-image/generate', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { prompt, width, height, scene, appearance, gender } = req.body as { prompt?: string; width?: number; height?: number; scene?: boolean; appearance?: string; gender?: string };
    if (!prompt?.trim()) {
      return reply.code(400).send({ error: 'prompt 不能为空' });
    }

    const result = await generateImage(playerId, prompt.trim(), { width, height, scene, appearance, gender });
    if (!result.ok) {
      return reply.code(502).send({ error: result.error });
    }
    return reply.send({ imagePath: result.filename });
  });
}
