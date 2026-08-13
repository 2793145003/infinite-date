/**
 * 迁移脚本：批量 embed 现有 scene_messages (player + npc only, no narration)
 * 存入 memory_embeddings (source_type='scene_message')
 *
 * 用法: node --experimental-strip-types src/scripts/migrate-scene-message-embeddings.mjs
 * 或:   npx tsx src/scripts/migrate-scene-message-embeddings.mjs
 *
 * 幂等：INSERT OR REPLACE，重跑不会重复
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.IDATE_DB || new URL('../../data/infinite-date.sqlite', import.meta.url).pathname;
const EMBED_URL = process.env.EMBEDDING_URL || 'http://127.0.0.1:8001';

async function embedBatch(texts) {
  const res = await fetch(`${EMBED_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status}`);
  const data = await res.json();
  return data.embeddings;
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

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
  `).all();

  console.log(`Found ${messages.length} player+npc messages to index`);

  // 2. 过滤已存在的（幂等）
  const existingIds = new Set(
    db.prepare(`SELECT source_id FROM memory_embeddings WHERE source_type='scene_message'`)
      .all().map(r => r.source_id)
  );
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

  const storeMany = db.transaction((items) => {
    for (const it of items) {
      insertEmbedding.run(
        `scene_message_${it.msgId}`,
        it.playerId,
        it.msgId,
        it.characterId,
        it.content,
        it.embeddingBuf,
        it.createdAt,
      );
    }
  });

  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    const texts = batch.map(m => `${m.character_name}：${m.text}`);
    const embeddings = await embedBatch(texts);

    const items = batch.map((m, i) => ({
      msgId: m.id,
      playerId: m.player_id,
      characterId: m.character_id,
      content: texts[i],
      embeddingBuf: Buffer.from(new Float32Array(embeddings[i]).buffer),
      createdAt: m.created_at,
    }));

    storeMany(items);
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
