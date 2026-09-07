/**
 * 验证 extractDrive：正常角色（顾砚）应生成 drive；NSFW 角色（Grok）应返回 null（SKIP）。
 */
import { db } from './src/db';
import { extractDrive } from './src/lib/drive';

async function main() {
  const rows = db.prepare(
    "SELECT id, character_data FROM characters WHERE json_extract(character_data, '$.name') IN ('顾砚', 'Grok')"
  ).all() as Array<{ id: string; character_data: string }>;

  for (const r of rows) {
    const d = JSON.parse(r.character_data);
    delete d.drive; // 模拟新角色（无 drive）
    const drive = await extractDrive(d);
    if (drive) {
      console.log(`【${d.name}】✅ 生成 drive：${drive.slice(0, 60)}…`);
    } else {
      console.log(`【${d.name}】⏭️ 跳过（SKIP/null）`);
    }
  }
}

main().then(() => console.log('done')).catch((e) => { console.error(e); process.exit(1); });
