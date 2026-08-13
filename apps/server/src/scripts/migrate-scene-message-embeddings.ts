/**
 * 迁移脚本：批量 embed 现有 scene_messages (player + npc only, no narration)
 * 存入 memory_embeddings (source_type='scene_message')
 *
 * 用法: npx tsx src/scripts/migrate-scene-message-embeddings.ts
 *
 * 幂等：INSERT OR REPLACE，重跑不会重复
 */
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.IDATE_DB || new URL('../../data/infinite-date.sqlite', import.meta.url).pathname;
const EMBED_URL = process.env.EMBEDDING_URL || 'http://127.0.0.1:8001';

async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${EMBED_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status}`);
  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings;
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 30000;');

  // 1. 取所有 player + npc 消息（排除 narration）
  const messages = db.prepare(`
    SELECT sm.id, sm.scene_session_id, sm.role, sm.character_id, sm.character_name, sm.text, sm.created_at,
           ss.player_id
    FROM scene_messages sm
    JOIN scene_sessions ss ON sm.scene_session_id = ss.id
    WHERE sm.role IN ('player', 'npc')
      AND sm.character_id IS NOT NULL
      AND sm.text IS NOT NULL
      AND sm.text != ''
    ORDER BY sm.created_at ASC
  `).all() as any[];
  console.log(`Found ${messages.length} player+npc messages to index`);

  // 2. 过滤已存在的（幂等）
  const existing = db.prepare(`SELECT source_id FROM memory_embeddings WHERE source_type='scene_message'`).all() as any[];
  const existingIds = new Set<string>(existing.map(r => r.source_id));
  const todo = messages.filter(m => !existingIds.has(m.id));
  console.log(`Already indexed: ${existingIds.size}, remaining: ${todo.length}`);

  if (!todo.length) {
    console.log('Nothing to do.');
    db.close();
    return;
  }

  // 3. 批量 embed + store
  const BATCH = 32;
  let done = 0;
  const insertEmbedding = db.prepare(`
    INSERT OR REPLACE INTO memory_embeddings (id, player_id, source_type, source_id, character_id, content_text, embedding, created_at)
    VALUES (?, ?, 'scene_message', ?, ?, ?, ?, ?)
  `);

  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    const texts = batch.map(m => `${m.character_name}：${m.text}`);
    const embeddings = await embedBatch(texts);

    for (let i = 0; i < batch.length; i++) {
      const m = batch[i];
      const emb = embeddings[i];
      if (!emb) continue;
      const embBuf = new Float32Array(emb);
      const buf = Buffer.from(embBuf.buffer);
      insertEmbedding.run(
        `scene_message_${m.id}`,
        m.player_id ?? '',
        m.id ?? '',
        m.character_id ?? '',
        texts[i] ?? '',
        buf,
        m.created_at ?? 0,
      );
    }

    done += batch.length;
    if (done % 256 === 0 || done === todo.length) {
      console.log(`  indexed ${done}/${todo.length}`);
    }
  }

  console.log(`Done. Indexed ${done} messages.`);
  db.close();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
