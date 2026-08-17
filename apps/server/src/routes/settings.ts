/**
 * 设置路由 — 每玩家 LLM 配置 + 系统信息
 * 每个玩家只改自己的 LLM 配置（player_llm_configs 表），未配置的字段回落到环境变量默认值。
 * 不再读写全局共享的 app_settings.llm_config（已废弃）。
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { config } from '../config';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // 获取当前玩家的LLM配置（API Key脱敏，未配置字段回落默认值）
  app.get('/settings', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const row = db.prepare('SELECT base_url, api_key, model FROM player_llm_configs WHERE player_id = ?').get(playerId) as
      { base_url: string; api_key: string; model: string } | undefined;

    return reply.send({
      baseUrl: row?.base_url || config.llmBaseUrl,
      model: row?.model || config.llmModel,
      apiKeySet: !!(row?.api_key && row.api_key.length > 0),
    });
  });

  // 更新当前玩家的LLM配置（只影响自己，不影响其他玩家）
  app.patch('/settings', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { baseUrl, apiKey, model } = req.body as { baseUrl?: string; apiKey?: string; model?: string };

    const row = db.prepare('SELECT base_url, api_key, model FROM player_llm_configs WHERE player_id = ?').get(playerId) as
      { base_url: string; api_key: string; model: string } | undefined;
    const current = {
      baseUrl: row?.base_url ?? '',
      apiKey: row?.api_key ?? '',
      model: row?.model ?? '',
    };

    if (baseUrl !== undefined) current.baseUrl = baseUrl;
    if (model !== undefined) current.model = model;
    // apiKey留空=不修改
    if (apiKey !== undefined && apiKey.length > 0) current.apiKey = apiKey;

    db.prepare(
      `INSERT INTO player_llm_configs (player_id, base_url, api_key, model, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         base_url = excluded.base_url, api_key = excluded.api_key, model = excluded.model, updated_at = excluded.updated_at`,
    ).run(playerId, current.baseUrl, current.apiKey, current.model, Date.now());

    return reply.send({ ok: true, apiKeySet: !!current.apiKey });
  });
}
