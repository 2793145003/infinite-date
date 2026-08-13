/**
 * 存量图片迁移：把 data/uploads/ 目录下现存文件读入 image_blobs 表。
 * 独立 node 进程运行（不停服）。不删除磁盘文件，保留 uploads 目录待排查。
 *
 * 用法：npx tsx src/scripts/migrate-images-to-db.ts
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const UPLOADS = '/output/infinite-date-v2/apps/server/data/uploads';
const DB_PATH = '/output/infinite-date-v2/apps/server/data/infinite-date.sqlite';

const MIME_BY_EXT: Record<string, string> = {
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

const db = new DatabaseSync(DB_PATH);
// 确保表存在（若 schema 尚未随新代码建表）
db.exec(`CREATE TABLE IF NOT EXISTS image_blobs (
  id TEXT PRIMARY KEY, data BLOB NOT NULL, mimetype TEXT NOT NULL,
  size INTEGER NOT NULL, created_at INTEGER NOT NULL
)`);

let inserted = 0, skipped = 0, missing = 0;
for (const fname of fs.readdirSync(UPLOADS)) {
  const full = path.join(UPLOADS, fname);
  const st = fs.statSync(full);
  if (!st.isFile()) { skipped++; continue; }
  const existing = db.prepare('SELECT 1 FROM image_blobs WHERE id = ?').get(fname);
  if (existing) { skipped++; continue; } // 已存在则跳过
  const data = fs.readFileSync(full);
  const ext = path.extname(fname).toLowerCase();
  const mimetype = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  db.prepare('INSERT INTO image_blobs (id, data, mimetype, size, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(fname, data, mimetype, data.length, st.mtimeMs);
  inserted++;
}
// 已引用但磁盘缺失的：里程碑检查（只报告，不改 DB）
const chars = db.prepare("SELECT character_data FROM characters").all() as { character_data: string }[];
const seen = new Set<string>();
for (const c of chars) {
  try {
    const d = JSON.parse(c.character_data);
    if (d.avatar) seen.add(d.avatar);
  } catch {}
}
for (const id of seen) {
  if (!db.prepare('SELECT 1 FROM image_blobs WHERE id = ?').get(id)) missing++;
}

console.log(`迁移完成: 新插入 ${inserted} 个, 跳过已存在 ${skipped} 个`);
console.log(`DB中已引用但迁移后仍缺失(无法找回): ${missing} 个`);
