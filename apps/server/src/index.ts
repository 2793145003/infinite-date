/**
 * 无限心动 — 服务器入口
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import crypto from 'node:crypto';
import { config, ensureDirectories } from './config';
import { db } from './db';
import { authRoutes } from './routes/auth';
import { smsRoutes } from './routes/sms';
import { emailRoutes } from './routes/email';
import { conversationRoutes } from './routes/conversation';
import { tutorialRoutes } from './routes/tutorial';
import { playerRoutes } from './routes/player';
import { settingsRoutes } from './routes/settings';
import { creationRoutes } from './routes/creation';
import { characterRoutes } from './routes/character';
import { locationRoutes } from './routes/location';
import { adminRoutes } from './routes/admin';
import { factsRoutes } from './routes/facts';
import { missionRoutes } from './routes/mission';
import { meRoutes } from './routes/me';
import { momentRoutes } from './routes/moments';
import { uploadRoutes } from './routes/upload';
import { imageRoutes } from './routes/image';
import { fishRoutes } from './routes/fish';
import { feedbackRoutes } from './routes/feedback';
import { exploreRoutes } from './routes/explore';
import { scenarioRoutes } from './routes/scenario';
import { archiveRoutes } from './routes/archive';
import { sceneRoutes } from './routes/scene';
import { sceneNamedRoutes } from './routes/scene-named';
import { sceneExploreRoutes } from './routes/scene-explore';
import { sceneScenarioRoutes } from './routes/scene-scenario';

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss' },
    },
  },
});

async function start() {
  ensureDirectories();

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
  await app.register(cookie, {
    secret: process.env.COOKIE_SECRET || crypto.randomUUID(),
  });

  await app.register(
    async (api) => {
      await authRoutes(api);
      await playerRoutes(api);
      await smsRoutes(api);
      await emailRoutes(api);
      await conversationRoutes(api);
      await tutorialRoutes(api);
      await settingsRoutes(api);
      await creationRoutes(api);
      await characterRoutes(api);
      await locationRoutes(api);
      await adminRoutes(api);
      await factsRoutes(api);
      await missionRoutes(api);
      await meRoutes(api);
      await momentRoutes(api);
      await uploadRoutes(api);
      await imageRoutes(api);
      await fishRoutes(api);
      await feedbackRoutes(api);
      await exploreRoutes(api);
      await scenarioRoutes(api);
      await archiveRoutes(api);
      await sceneRoutes(api);
      await sceneNamedRoutes(api);
      await sceneExploreRoutes(api);
      await sceneScenarioRoutes(api);

      // 健康检查（前端连接监测用，无认证）
      api.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));
    },
    { prefix: '/api' },
  );

  // 健康检查
  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  app.setErrorHandler((err, req, reply) => {
    app.log.error({ err }, '请求处理错误');
    const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
    // 4xx 错误（客户端错误）可以返回具体信息；5xx 只返回通用提示，不泄露内部细节
    const message = statusCode >= 400 && statusCode < 500
      ? (err instanceof Error ? err.message : '请求错误')
      : '服务器内部错误';
    reply.code(statusCode).send({ error: message });
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`╔══════════════════════════════════════╗`);
    app.log.info(`║  无限心动 — 服务器已启动              ║`);
    app.log.info(`║  端口: ${config.port}                        ║`);
    app.log.info(`║  DB: ${config.dbPath}`);
    app.log.info(`╚══════════════════════════════════════╝`);
  } catch (err) {
    app.log.error({ err }, '服务器启动失败');
    process.exit(1);
  }
}

start();

// llm_call_log 只保留 24 小时——AB 测试/调试够用，避免 DB 无限膨胀
const LLM_LOG_TTL_MS = 24 * 60 * 60 * 1000;
function cleanLlmCallLog() {
  const cutoff = Date.now() - LLM_LOG_TTL_MS;
  const r = db.prepare('DELETE FROM llm_call_log WHERE created_at < ?').run(cutoff);
  if (r.changes > 0) console.log(`[llm_call_log] 清理 ${r.changes} 条 24h 前的记录`);
}
cleanLlmCallLog(); // 启动时清一次
setInterval(cleanLlmCallLog, 6 * 60 * 60 * 1000).unref(); // 每 6 小时清一次

// NPC 行程朋友圈触发器——后台独立运行，不依赖玩家心跳
import { startMomentScheduler } from './lib/moment-scheduler';
startMomentScheduler();

// 全局兜底：未捕获的 Promise rejection 和异常
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
