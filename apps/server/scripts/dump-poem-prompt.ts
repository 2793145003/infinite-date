// 临时：打印某个角色首页寄语实际喂给 gemma 的完整 prompt（不调用 chat，只 dump）
// 用法：cd apps/server && node --import tsx scripts/dump-poem-prompt.ts [playerId] [characterId]
import { db } from '../src/db';
import { loadCharacterData } from '../src/lib/character';
import { retrieveRelevantMemories, getUnifiedTimeline } from '../src/lib/memory';
import { formatCharacterCard, formatRelationshipDuration, formatCurrentTime } from '../src/prompt/builder';

async function main() {
  const playerId = process.argv[2] || 'test-player-001';
  const characterId = process.argv[3] || '7631e492-f69b-4d31-b21f-aab7e4f9d785'; // 沈星回
  const char = loadCharacterData(playerId, characterId);
  if (!char) { console.log('无角色卡'); return; }
  const charName = char.name || '(无名)';

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id=? AND character_id=?')
    .get(playerId, characterId) as { player_description: string; created_at: number } | undefined;
  const playerName = (db.prepare('SELECT name FROM players WHERE id=?').get(playerId) as { name: string } | undefined)?.name || '对方';

  const timeline = getUnifiedTimeline(playerId, characterId, 8);
  const retrieved = await retrieveRelevantMemories(playerId, characterId, [], '此刻最想对对方说的、最想写进一句诗里的话');

  const speechDesc = char.speechStyle?.description?.trim();
  const speechExamples = (char.speechStyle?.examples ?? [])
    .map((e: { context?: string; line?: string }) => (e.line ? `「${e.line}」` : ''))
    .filter(Boolean).slice(0, 3).join('、');

  const system = [
    `你是「${charName}」。你要完全进入这个角色。下面你要写下的，是你此刻内心最真实的一个念头。`,
    ``,
    `【你的角色设定】`,
    formatCharacterCard(char),
    ``,
    `【你和对方】`,
    `对方叫「${playerName}」。`,
    rel?.player_description ? `你对对方的认知：${rel.player_description}` : '',
    rel?.created_at ? `你们已经认识：${formatRelationshipDuration(rel.created_at)}` : '',
    ``,
    `【你们最近一起经历的事】`,
    timeline || '（还没有什么共同的经历）',
    retrieved ? `\n【你还记得的、关于你们之间的片段】\n${retrieved}` : '',
    ``,
    `【此刻】${formatCurrentTime()}`,
  ].filter(Boolean).join('\n');

  const user = [
    `现在，为对方写下一句寄语——是你此刻最想对对方说的一句话。可以带一点诗意，但首先是你的真心话。`,
    speechDesc ? `\n你平时说话是这样的：${speechDesc}${speechExamples ? `（比如 ${speechExamples}）` : ''}` : '',
    ``,
    `要求：`,
    `- 用你一贯的口吻，像你日常说话的语气和措辞，让这句话一听就是你说的。`,
    `- 只写一句，可以带一个逗号或分句；不要多句、不要标题、不要加引号。`,
    `- 可以轻轻呼应你们最近共同经历的事，点到为止，不要写成回忆流水账。`,
    `- 深情是克制而真实的，措辞是你自己的，不堆砌辞藻、也不套用任何现成的情话。`,
    `- 直接写下这句寄语本身，不要任何解释或引子。`,
  ].filter(Boolean).join('\n');

  console.log('========== SYSTEM ==========');
  console.log(system);
  console.log('\n========== USER ==========');
  console.log(user);
}

main().catch((err) => { console.error(err); process.exit(1); });
