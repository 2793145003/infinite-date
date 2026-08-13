/**
 * Embedding 客户端 — 调用 bge-base-zh-v1.5 HTTP 服务
 * 
 * embedding_server.py 跑在 8001 端口，独立进程不走 vLLM。
 * 向量 normalized embeddings → dot product = cosine similarity。
 */
import { db } from '../db';

// EMBEDDING_URL 支持两种形态：
//  1. 旧形态（v2 默认）：'http://127.0.0.1:8001' → 调 /health + /embed（自定义路径，bge 服务）
//  2. OpenAI 兼容形态：'https://host/v1/embeddings' → 走 OpenAI /v1/embeddings（如 Qwen3-Embedding-8B）
const EMBEDDING_URL = process.env.EMBEDDING_URL || 'http://127.0.0.1:8001';

/** 是否为 OpenAI 兼容端点（URL 含 /v1/embeddings 或以 /embeddings 结尾） */
const IS_OPENAI = /\/v1\/embeddings(\?|$)/.test(EMBEDDING_URL) || /\/embeddings$/.test(EMBEDDING_URL);

// 每个 OpenAI 端点一个 URL 片段。用环境变量隔离模型名，避免硬编码。
const OPENAI_MODEL = process.env.EMBEDDING_MODEL || 'Qwen3-Embedding-8B';

let healthChecked = false;

async function ensureHealthy(): Promise<void> {
  if (healthChecked) return;
  if (IS_OPENAI) {
    // OpenAI 兼容端点：用一次真实请求探测，不单独 health
    healthChecked = true;
    return;
  }
  try {
    const res = await fetch(`${EMBEDDING_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`health check failed: ${res.status}`);
    healthChecked = true;
  } catch (err) {
    throw new Error(`Embedding服务不可用 (${EMBEDDING_URL}): ${err}. 请确认 embedding_server.py 正在运行`);
  }
}

/**
 * 获取文本的 embedding 向量
 */
export async function embed(text: string): Promise<Float32Array | null> {
  return embedBatch([text]).then(v => v?.[0] ?? null);
}

/**
 * 批量获取 embedding
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  try {
    await ensureHealthy();

    if (IS_OPENAI) {
      // OpenAI 兼容模式：/v1/embeddings，请求体 {model, input}
      const res = await fetch(EMBEDDING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OPENAI_MODEL, input: texts }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      return (data.data || []).map(d => new Float32Array(d.embedding));
    }

    // 旧形态：自定义 /embed 路径（bge 服务）
    const res = await fetch(`${EMBEDDING_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { embeddings: number[][]; dim: number };
    return data.embeddings.map(v => new Float32Array(v));
  } catch {
    return null;  // embedding 不可用时降级：不检索记忆，对话继续
  }
}

/**
 * 余弦相似度（向量已 normalized，等价于 dot product）
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

// ─── DB 存取 ─────────────────────────────────────────────

/**
 * 向 memory_embeddings 表写入 embedding
 */
export function storeEmbedding(
  playerId: string,
  characterId: string,
  sourceType: string,
  sourceId: string,
  contentText: string,
  embedding: Float32Array,
): void {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.prepare(`
    INSERT OR REPLACE INTO memory_embeddings (id, player_id, source_type, source_id, character_id, content_text, embedding, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${sourceType}_${sourceId}`,
    playerId, sourceType, sourceId, characterId,
    contentText, buf, Date.now(),
  );
}

/**
 * 从 BLOB 读取 embedding
 */
export function blobToFloat32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

// ─── 检索 ─────────────────────────────────────────────

export interface MemoryHit {
  sourceType: string;
  sourceId: string;
  contentText: string;
  score: number;
}

/**
 * 检索某玩家×角色的相关记忆
 * 
 * 流程（对应 OPEN_QUESTIONS #4）：
 * 1. 用 query embedding 搜 memory_embeddings
 * 2. 过滤阈值 < SIM_THRESHOLD
 * 3. 小簇（命中少）→ 返回原文
 * 4. 大簇（命中多）→ 改搜 chronicle summary embeddings，返回概括
 */
const SIM_THRESHOLD = 0.35;  // bge-base-zh问句vs叙事句相似度天然偏低，0.45太严导致跨session记忆0命中
const LARGE_CLUSTER_THRESHOLD = 4;  // 命中 ≥4 条算大簇

export async function retrieveMemories(
  playerId: string,
  characterId: string,
  queryText: string,
): Promise<string | null> {
  // 旧单路检索已废弃，委托给三路搜索再拼回字符串
  const multi = await retrieveMemoriesMultiChannel(playerId, characterId, queryText);
  if (!multi) return null;
  return multi;
}

export interface MultiChannelResult {
  summaries: MemoryHit[];
  facts: MemoryHit[];
  dialogues: MemoryHit[];
}

export interface MemoryHitWithTime extends MemoryHit {
  createdAt: number;
}

const TOP_K = 5;

/**
 * 三路分开搜索（约会摘要 / 玩家事实 / 对话原文），排除 turn_overview。
 * 每路各返回 top-5，带相对时间。
 */
export async function retrieveMemoriesMultiChannel(
  playerId: string,
  characterId: string,
  queryText: string,
): Promise<string | null> {
  const queryVec = await embed(queryText);
  if (!queryVec) return null;

  const all = db.prepare(`
    SELECT me.source_type, me.source_id, me.content_text, me.embedding, me.created_at
    FROM memory_embeddings me
    WHERE me.player_id = ? AND me.character_id = ?
      AND me.source_type != 'turn_overview'
      AND me.source_type != 'dream_scenario'
      AND NOT (
        me.source_type = 'turn_player_fact'
        AND EXISTS (
          SELECT 1 FROM turn_player_facts tpf
          JOIN scene_sessions ss ON tpf.scene_session_id = ss.id
          WHERE tpf.id = me.source_id AND ss.scene_type = 'scenario'
        )
      )
  `).all(playerId, characterId) as Array<{
    source_type: string; source_id: string; content_text: string; embedding: Uint8Array; created_at: number;
  }>;

  if (all.length === 0) return null;

  const scored = all.map(r => ({
    sourceType: r.source_type,
    sourceId: r.source_id,
    contentText: r.content_text,
    createdAt: r.created_at,
    score: cosineSim(queryVec, blobToFloat32(r.embedding)),
  })).filter(h => h.score >= SIM_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const summaries = scored.filter(h => ['turn_date_summary', 'chronicle'].includes(h.sourceType)).slice(0, TOP_K);
  const facts = scored.filter(h => ['fact', 'turn_player_fact'].includes(h.sourceType)).slice(0, TOP_K);
  const dialogues = scored.filter(h => h.sourceType === 'scene_message').slice(0, TOP_K);

  const sections: string[] = [];

  if (summaries.length) {
    const lines = summaries.map(h => `[${formatRelativeTime(h.createdAt)}] ${h.contentText}`);
    sections.push(`【约会摘要】\n${lines.join('\n')}`);
  }
  if (facts.length) {
    const lines = facts.map(h => `· ${h.contentText}（${formatRelativeTime(h.createdAt)}）`);
    sections.push(`【关于${playerId ? '' : ''}玩家的事实】\n${lines.join('\n')}`);
  }
  if (dialogues.length) {
    const lines = dialogues.map(h => `[${formatRelativeTime(h.createdAt)}] ${h.contentText}`);
    sections.push(`【对话原文】\n${lines.join('\n')}`);
  }

  if (!sections.length) return null;
  return `【相关记忆·以下是你真实经历过的往事，被问到时要根据这些内容回答，不要编造未提及的细节】\n${sections.join('\n\n')}`;
}

/**
 * 相对时间格式化（中文）
 */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  if (days < 7) return `${days}天前`;
  if (days < 30) return `${Math.floor(days / 7)}周前`;
  return `${Math.floor(days / 30)}个月前`;
}
