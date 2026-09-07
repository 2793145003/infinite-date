/**
 * 验证：buildCharacterCard 是否正确注入【内驱力】；Grok/厉承渊 不应有。
 */
import { db } from './src/db';
import { buildCharacterCard } from './src/lib/character-card';

const rows = db.prepare('SELECT id, character_data FROM characters').all() as Array<{ id: string; character_data: string }>;
let withD = 0, withoutD = 0;
for (const row of rows) {
  const name = (JSON.parse(row.character_data) as any).name || '(无)';
  const card = buildCharacterCard('', row.id);
  const has = card.includes('【内驱力】');
  if (has) withD++; else withoutD++;
  if (has) {
    const i = card.indexOf('【内驱力】');
    console.log(`【${name}】✓ 有内驱力 → ${card.slice(i, i + 42)}…`);
  } else {
    console.log(`【${name}】— 无内驱力（应跳过）`);
  }
}
console.log(`\n汇总：注入 ${withD} / 跳过 ${withoutD}`);
