/**
 * 设置路由 — LLM配置 + 系统信息
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { config } from '../config';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // 获取LLM配置（API Key脱敏）
  app.get('/settings', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('llm_config') as { value: string } | undefined;
    let llmConfig: Record<string, string> = {};
    if (row?.value) {
      try { llmConfig = JSON.parse(row.value); } catch { /* ignore */ }
    }

    return reply.send({
      baseUrl: llmConfig.baseUrl ?? config.llmBaseUrl,
      model: llmConfig.model ?? config.llmModel,
      apiKeySet: !!(llmConfig.apiKey && llmConfig.apiKey.length > 0),
    });
  });

  // 更新LLM配置
  app.patch('/settings', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { baseUrl, apiKey, model } = req.body as { baseUrl?: string; apiKey?: string; model?: string };

    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('llm_config') as { value: string } | undefined;
    let current: Record<string, string> = {};
    if (row?.value) {
      try { current = JSON.parse(row.value); } catch { /* ignore */ }
    }

    if (baseUrl !== undefined) current.baseUrl = baseUrl;
    if (model !== undefined) current.model = model;
    // apiKey留空=不修改
    if (apiKey !== undefined && apiKey.length > 0) current.apiKey = apiKey;

    db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).run('llm_config', JSON.stringify(current), JSON.stringify(current));

    return reply.send({ ok: true, apiKeySet: !!current.apiKey });
  });
}
