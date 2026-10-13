/**
 * 造一个「演示库」：从生产库（只读 ATTACH）把桥需要的几张表拷到一个临时库，
 * 这样 mock 端到端演练可以真实地写 outbox / 造绑定，而**完全不碰生产库**。
 *
 * 只拷需要的：message_threads / text_messages / sessions / characters / character_player_data
 * （image_blobs 是 5G 的大头，mock 模式不读二进制，跳过）
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2] || './data/infinite-date.sqlite';
const OUT = process.argv[3] || '/tmp/qqb/demo.sqlite';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });

const db = new DatabaseSync(OUT);
db.exec('PRAGMA foreign_keys = OFF;'); // 只拷部分表，外键引用的表可能没拷全，关掉约束
db.exec(`ATTACH DATABASE '${path.resolve(SRC)}' AS src`);

const TABLES = ['players', 'message_threads', 'text_messages', 'sessions', 'characters', 'character_player_data'];
for (const t of TABLES) {
  const ddl = db.prepare("SELECT sql FROM src.sqlite_master WHERE type = 'table' AND name = ?").get(t) as { sql: string } | undefined;
  if (!ddl) {
    console.log(`跳过（源库里没有）: ${t}`);
    continue;
  }
  db.exec(ddl.sql);
  db.exec(`INSERT INTO ${t} SELECT * FROM src.${t}`);
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  console.log(`拷了 ${t}: ${n} 行`);
}

// 挑一个短信量最多的 (player, character) 做演示对象
const pair = db
  .prepare(
    `SELECT mt.player_id AS playerId, mt.character_id AS characterId, COUNT(*) AS n
       FROM text_messages tm JOIN message_threads mt ON mt.id = tm.thread_id
      WHERE tm.sender = 'npc'
      GROUP BY mt.player_id, mt.character_id
      ORDER BY n DESC LIMIT 5`,
  )
  .all() as Array<{ playerId: string; characterId: string; n: number }>;

console.log('\n候选 (player, character)：');
for (const p of pair) console.log(`  --player ${p.playerId} --character ${p.characterId}   (${p.n} 条 NPC 消息)`);
console.log(`\n演示库: ${OUT}`);
