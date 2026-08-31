// 端到端验证：真实角色数据 → gemma 扩写(带 gender 锚定) → Krea 2 出图 → 存 image_blobs
// 临时测试脚本，跑完可删
import { db } from '../src/db';
import { loadCharacterData, getCharacterName } from '../src/lib/character';
import { generateImage } from '../src/lib/ai-image';

async function main() {
  const rel = db.prepare('SELECT player_id, character_id FROM relationships LIMIT 1').get() as { player_id: string; character_id: string } | undefined;
  if (!rel) { console.error('无关系数据'); process.exit(1); }
  const { player_id: playerId, character_id: characterId } = rel;
  const charData = loadCharacterData(playerId, characterId);
  if (!charData) { console.error('loadCharacterData 返回空'); process.exit(1); }

  console.log('角色:', getCharacterName(characterId));
  console.log('gender:', charData.gender || '(空)');
  console.log('appearance:', charData.appearance?.slice(0, 100) || '(空)');
  console.log('---');

  // 场景1：无人纯景（带 appearance+gender，验证不被带偏）
  console.log('场景1 无人纯景...');
  const r1 = await generateImage(playerId, '雨后的街道，积水倒映着霓虹灯光', {
    scene: true, appearance: charData.appearance, gender: charData.gender, width: 512, height: 512,
  });
  console.log('  ->', r1.ok ? `OK ${r1.filename}` : `FAIL: ${r1.error}`);

  // 场景2：有人自拍（带 appearance+gender，验证出人 + 性别锚定）
  console.log('场景2 有人自拍...');
  const r2 = await generateImage(playerId, '我站在樱花树下，风吹起头发', {
    scene: true, appearance: charData.appearance, gender: charData.gender, width: 512, height: 512,
  });
  console.log('  ->', r2.ok ? `OK ${r2.filename}` : `FAIL: ${r2.error}`);
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
