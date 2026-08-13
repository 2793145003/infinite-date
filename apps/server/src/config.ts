/**
 * 服务器配置
 */
import path from 'node:path';
import fs from 'node:fs';

// 统一时区为 Asia/Shanghai (UTC+8)
// 服务器本身跑在 UTC，这里在进程级别设定时区，
// 之后所有 new Date().getHours() / setHours() / toLocaleString() 都是北京时间
process.env.TZ = 'Asia/Shanghai';

const dataDir = process.env.IDATE_DATA_DIR || path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: path.join(dataDir, 'infinite-date.sqlite'),

  // vLLM endpoint (Gemma-4-26B-A4B-it)
  llmBaseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:8000/v1',
  llmApiKey: process.env.LLM_API_KEY || 'sk-placeholder',
  llmModel: process.env.LLM_MODEL || 'gemma-4-26b',

  // CORS
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:8080,http://localhost:5173').split(','),

  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  promptTemplatesDir: path.resolve(process.cwd(), 'src/prompt/templates'),
  configDir: path.resolve(process.cwd(), 'src/config'),
};

export function ensureDirectories() {
  if (!fs.existsSync(config.uploadsDir)) fs.mkdirSync(config.uploadsDir, { recursive: true });
}
