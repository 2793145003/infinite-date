/**
 * LLM适配器 — OpenAI兼容接口 (vLLM)
 * 处理 reasoning_content (Gemma/GLM等推理模型)
 * 支持多模态：有imagePath的消息会以content数组形式发送（text+image_url）
 *
 * LLM配置优先级：数据库 app_settings.llm_config > 环境变量
 * 用户在设置页改了配置后立即生效，不需要重启
 */
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config';
import { db } from '../db';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 图片路径（相对于uploads目录），有图片时content作为图片描述文本 */
  imagePath?: string;
}

export interface ChatResult {
  content: string;
  finishReason?: string;
  /** 输出因 max_tokens 被截断（finish_reason === 'length'），即 content 是不完整的 */
  truncated?: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

interface EffectiveLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 读取生效的 LLM 配置。
 * 有 playerId → 优先该玩家的 per-player 配置（player_llm_configs），未填字段 fallback 到环境变量默认值。
 * 无 playerId（系统级调用，无归属玩家）→ 直接走环境变量默认值。
 * 注意：不再读全局 app_settings.llm_config（已废弃），默认值只来自环境变量/config。
 */
function getEffectiveLlmConfig(playerId?: string): EffectiveLlmConfig {
  let dbConfig: Record<string, string> = {};
  if (playerId) {
    const row = db.prepare('SELECT base_url, api_key, model FROM player_llm_configs WHERE player_id = ?').get(playerId) as
      { base_url: string; api_key: string; model: string } | undefined;
    if (row) {
      dbConfig = { baseUrl: row.base_url, apiKey: row.api_key, model: row.model };
    }
  }
  return {
    baseUrl: dbConfig.baseUrl || config.llmBaseUrl,
    apiKey: dbConfig.apiKey || config.llmApiKey,
    model: dbConfig.model || config.llmModel,
  };
}

/** MIME类型映射 */
function getMime(ext: string): string {
  switch (ext) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    default: return 'image/jpeg';
  }
}

/**
 * 将ChatMessage[]转换为OpenAI兼容API的消息格式
 * 有imagePath的消息 → content数组 [{type:'text'}, {type:'image_url'}]
 * 普通消息 → content字符串
 */
function buildApiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map(msg => {
    if (msg.imagePath) {
      // 从 image_blobs 表读（2026-08-07 图片迁库后统一从 DB 取，不再读磁盘 uploads）
      const safeName = String(msg.imagePath).split('/').pop() ?? '';
      try {
        const blob = db.prepare('SELECT data, mimetype FROM image_blobs WHERE id = ?').get(safeName) as { data: Uint8Array; mimetype: string } | undefined;
        if (!blob) throw new Error('image not found');
        const b64 = Buffer.from(blob.data).toString('base64');
        const mime = blob.mimetype || getMime(String(msg.imagePath).split('.').pop()?.toLowerCase() ?? '');
        return {
          role: msg.role,
          content: [
            { type: 'text', text: msg.content || '（玩家发了一张图片）' },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        };
      } catch {
        // 图片读取失败 → 降级为纯文本
        return { role: msg.role, content: msg.content || '（图片加载失败）' };
      }
    }
    return { role: msg.role, content: msg.content };
  });
}

/** vLLM max_model_len — 与 vLLM 启动参数一致（gemma-4-26b 实际 16384），可通过环境变量覆盖 */
const MAX_MODEL_LEN = Number(process.env.VLLM_MAX_MODEL_LEN) || 16384;

/**
 * 精确计算 prompt token 数——调用 vLLM 的 /tokenize 端点。
 * 这会包含 chat template 开销，与 vLLM 实际计费/限流一致。
 * /tokenize 失败时回退到字符估算（chars / 1.5，中文真实比率）。
 */
async function countPromptTokens(llm: { baseUrl: string; model: string }, apiMessages: unknown[]): Promise<number> {
  // 有图片时每张图按 768 token 计（Gemma vision encoder 固定开销）
  let imageCount = 0;
  let fallbackChars = 0;
  for (const msg of apiMessages) {
    const m = msg as { content?: unknown };
    if (typeof m.content === 'string') {
      fallbackChars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === 'object' && part && 'type' in part) {
          if (part.type === 'text' && typeof part.text === 'string') fallbackChars += part.text.length;
          if (part.type === 'image_url') imageCount++;
        }
      }
    }
  }

  try {
    // vLLM /tokenize 支持 messages 参数（带 chat template）
    const res = await fetch(`${llm.baseUrl.replace(/\/+$/, '')}/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llm.model, messages: apiMessages }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { count: number };
      return data.count + imageCount * 768;
    }
  } catch {
    // 网络错误/超时→回退
  }
  // 回退：用字符数本身作为 token 估算（中文 1 字常 1~2 token，取「1 字 ≈ 1 token」是保守下限；
  // 旧的 chars/1.5 会把中文估低 2 倍以上，是「估算偏低 → 削减不够 → vLLM 400」的主要来源）
  return Math.ceil(fallbackChars) + imageCount * 768;
}

export async function chat(
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    /** JSON Schema 对象，通过 response_format 传给 vLLM 约束输出格式 */
    guidedJson?: Record<string, unknown>;
    /** 调用类型标识（actor/director/narration/explore/chat 等），用于 llm_call_log 回查 */
    callType?: string;
    /** 关联的业务会话 id，用于 llm_call_log 回查 */
    sessionId?: string;
    /** 归属玩家 id：用该玩家的 per-player LLM 配置；不传则用环境变量默认值（系统级调用） */
    playerId?: string;
  },
): Promise<ChatResult> {
  const llm = getEffectiveLlmConfig(opts?.playerId);

  const apiMessages = buildApiMessages(messages);

  // 动态削减 max_tokens：保证 prompt_tokens + max_tokens <= MAX_MODEL_LEN - 256(安全余量)
  // 余量从 32 提到 256：countPromptTokens 估算有误差（/tokenize 可能不含特殊 token、回退 chars 估算偏
  // 低），实测 prompt 15873 时估算偏低 33+，32 余量挡不住 → vLLM 报 400（15873 input + 512 output 超 16384）。
  const requestedMax = opts?.maxTokens ?? 1024;
  const estimatedPrompt = await countPromptTokens(llm, apiMessages);
  const budget = MAX_MODEL_LEN - 256 - estimatedPrompt;
  const maxTokens = budget < requestedMax
    ? Math.max(128, budget)   // 最少留 128 token 输出，实在不够就让它报错
    : requestedMax;

  const res = await fetch(`${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: llm.model,
      messages: apiMessages,
      temperature: opts?.temperature ?? 0.8,
      max_tokens: maxTokens,
      repetition_penalty: 1.1,
      stream: false,
      ...(opts?.guidedJson ? {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'reply',
            schema: opts.guidedJson,
          },
        },
      } : {}),
    }),
    signal: opts?.signal ?? AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  const data = await res.json() as {
    choices?: Array<{
      message?: { content?: string | null; reasoning_content?: string };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';

  // LLM 调用日志：24 小时滑动窗口，完整记录请求与响应，供排查生成结果问题
  try {
    const now = Date.now();
    db.prepare('DELETE FROM llm_call_log WHERE created_at < ?').run(now - 86_400_000); // 保留最近 24 小时
    db.prepare(`INSERT INTO llm_call_log
      (created_at, call_type, session_id, model, messages_json, raw_response, parsed_json, tokens_in, tokens_out, finish_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        now,
        opts?.callType ?? null,
        opts?.sessionId ?? null,
        llm.model,
        JSON.stringify(messages),
        content,
        // guidedJson 输出时尝试存解析后的 JSON，方便直接看 texts 等结构化结果
        content && opts?.guidedJson ? (() => { const parsed = tryParseJsonReply(content); return parsed ? JSON.stringify(parsed) : null; })() : null,
        data.usage?.prompt_tokens ?? null,
        data.usage?.completion_tokens ?? null,
        choice?.finish_reason ?? null,
      );
  } catch (err) {
    // 日志写入失败绝不阻断主流程
    console.warn('[llm_call_log] write failed:', err instanceof Error ? err.message : err);
  }

  return {
    content,
    finishReason: choice?.finish_reason,
    truncated: choice?.finish_reason === 'length',
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * 尝试解析LLM输出的JSON。parse失败时返回null，调用方做fallback。
 */
export function tryParseJsonReply(content: string): Record<string, unknown> | null {
  // 尝试直接parse
  try {
    return JSON.parse(content);
  } catch {
    // 尝试提取 ```json ... ``` 块
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match?.[1]) {
      try {
        return JSON.parse(match[1]);
      } catch {
        // fall through
      }
    }
    // 尝试找到第一个 { 到最后一个 }
    const first = content.indexOf('{');
    const last = content.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(content.slice(first, last + 1));
      } catch {
        // give up
      }
    }
    return null;
  }
}

/**
 * 带 JSON 约束的 LLM 调用 + 严格解析 + 失败重试。
 * 所有需要 LLM 输出 JSON 的调用点都应走这个（至少新版系统）。
 * 流程：调 chat（guidedJson 约束）→ 剥围栏后 JSON.parse → 交给 validate 逐字段校验类型 →
 *       任一不过就带「格式不对」提示重试（默认 maxRetries 次）→ 仍失败返回 null（调用方丢弃/降级，
 *       绝不把残缺 JSON / ```json / 字段名原文透传给用户）。
 */
export async function chatJson<T extends object>(
  messages: ChatMessage[],
  opts: {
    schema: Record<string, unknown>;
    temperature?: number;
    maxTokens?: number;
    maxRetries?: number;
    /** 对 parse 出的对象做逐字段校验 + 可选归一化。返回 null → 触发重试；返回对象 → 作为最终结果。 */
    normalize?: (obj: Record<string, unknown>) => T | null;
    /** 生成重试提示。可选，默认通用 JSON 格式要求。 */
    retryHint?: (reason: string) => string;
    /** 调用类型标识（actor/director/narration/explore 等），透传给 llm_call_log */
    callType?: string;
    /** 关联的业务会话 id，透传给 llm_call_log */
    sessionId?: string;
    /** 归属玩家 id，透传给 chat 用于 per-player LLM 配置 */
    playerId?: string;
  },
): Promise<T | null> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  let lastReason = '输出不是合法的 JSON';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const userMsg = messages[messages.length - 1];
    const msgs = attempt === 0
      ? messages
      : [
          ...messages.slice(0, -1),
          {
            role: 'user' as const,
            content: `${userMsg?.content ?? ''}\n\n（上一次输出格式不对：${lastReason}。请严格按 JSON 格式重新输出，只输出那一个合法 JSON，不要任何其它文字。）`,
          },
        ];
    const res = await chat(msgs, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      guidedJson: opts.schema,
      callType: opts.callType,
      sessionId: opts.sessionId,
      playerId: opts.playerId,
    });
    if (res.truncated) {
      lastReason = '输出被截断（finish_reason=length），JSON 不完整';
      continue;
    }
    const obj = tryParseJsonReply(res.content);
    if (obj) {
      if (opts.normalize) {
        const norm = opts.normalize(obj);
        if (norm) return norm;
      } else {
        return obj as T;
      }
    }
    lastReason = opts.retryHint ? opts.retryHint(lastReason) : 'JSON 字段类型或结构不符';
  }
  return null;
}
