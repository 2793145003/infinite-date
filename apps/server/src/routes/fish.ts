/**
 * 摸鱼模式 — 伪装成AI助手的聊天路由
 * 直接转发到vLLM，system prompt设为通用助手
 */
import type { FastifyInstance } from 'fastify';
import { chat } from '../llm/adapter';
import { requireAuth } from '../lib/auth';

const FISH_SYSTEM_PROMPT = '你是一个通用AI助手。回答用户的问题时简洁、准确、有帮助。使用中文回复。';

export async function fishRoutes(app: FastifyInstance) {
  app.post('/fish/chat', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { messages } = req.body as {
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return reply.code(400).send({ error: '消息不能为空' });
    }

    // 限制历史长度，防止token爆炸
    const recentMessages = messages.slice(-20);

    const llmMessages = [
      { role: 'system' as const, content: FISH_SYSTEM_PROMPT },
      ...recentMessages.map(m => ({ role: m.role, content: m.content })),
    ];

    try {
      const result = await chat(llmMessages, {
        temperature: 0.7,
        maxTokens: 1024,
        playerId,
      });

      return { reply: result.content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'LLM调用失败';
      req.log.error({ err }, '摸鱼模式LLM调用失败');
      return reply.code(502).send({ error: msg });
    }
  });
}
