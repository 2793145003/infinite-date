/** 验证 formatCharacterCard 注入 drive：有 drive 的角色应含【内驱力】，无 drive 的不应出现。 */
import { db } from './src/db';
import { formatCharacterCard } from './src/prompt/builder';

const rows = db.prepare(
  "SELECT id, character_data FROM characters WHERE json_extract(character_data, '$.name') IN ('顾砚', 'Grok')"
).all() as Array<{ id: string; character_data: string }>;

for (const r of rows) {
  const d = JSON.parse(r.character_data);
  const card = formatCharacterCard(d);
  const hasDrive = card.includes('【内驱力】');
  const start = card.indexOf('【与玩家的关系】');
  const end = card.indexOf('【特长与短板】');
  const seg = card.slice(start, end > start ? end : undefined);
  console.log(`\n===== ${d.name} | character_data.drive字段: ${d.drive ? '有' : '无'} | 注入【内驱力】: ${hasDrive ? 'YES' : 'NO'} =====`);
  console.log(seg);
}
