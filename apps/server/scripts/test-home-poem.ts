// 临时脚本：验证首页每日情诗生成效果（只读，不落库）
// 用法：cd apps/server && node --import tsx scripts/test-home-poem.ts [playerId] [characterId...]
// 增强版：把角色 speechStyle（说话风格+台词范例）单独提到 prompt 显眼处，压过 gemma 的通用情话模板
import { db } from '../src/db';
import { loadCharacterData } from '../src/lib/character';
import { retrieveRelevantMemories, getUnifiedTimeline } from '../src/lib/memory';
import { formatCharacterCard, formatRelationshipDuration, formatCurrentTime } from '../src/prompt/builder';
import { chat } from '../src/llm/adapter';

async function generate(playerId: string, characterId: string) {
  const char = loadCharacterData(playerId, characterId);
  if (!char) { console.log(`\n[跳过] ${characterId} 无角色卡`); return; }
  const charName = char.name || '(无名)';

  const rel = db.prepare(
    'SELECT player_description, created_at FROM relationships WHERE player_id=? AND character_id=?'
  ).get(playerId, characterId) as { player_description: string; created_at: number } | undefined;

  const playerName = (db.prepare('SELECT name FROM players WHERE id=?').get(playerId) as { name: string } | undefined)?.name || '对方';

  // 关系现状：距离上一次说话过去多少天（动态算，不硬编码）
  const thread = db.prepare('SELECT id FROM message_threads WHERE player_id=? AND character_id=?').get(playerId, characterId) as { id: string } | undefined;
  const lastMsgTs = thread ? (db.prepare('SELECT MAX(created_at) AS ts FROM text_messages WHERE thread_id=?').get(thread.id) as { ts: number | null }).ts : null;
  const daysSilent = lastMsgTs ? Math.max(1, Math.round((Date.now() - lastMsgTs) / 86400000)) : null;

  const timeline = getUnifiedTimeline(playerId, characterId, 8);
  const retrieved = await retrieveRelevantMemories(
    playerId, characterId, [],
    '此刻最想对对方说的、最想写进一句诗里的话',
  );

  // 角色说话风格 + 台词范例（贴人的锚）
  const speechDesc = char.speechStyle?.description?.trim();
  const speechExamples = (char.speechStyle?.examples ?? [])
    .map((e: { context?: string; line?: string }) => (e.line ? `「${e.line}」` : ''))
    .filter(Boolean)
    .slice(0, 3)
    .join('、');

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
    daysSilent ? `【你们此刻的关系现状】\n距离你们上一次说话，已经过去了约 ${daysSilent} 天。` : '',
    ``,
    `【此刻】${formatCurrentTime()}`,
  ].filter(Boolean).join('\n');

  const user = [
    `现在，为她在主页留一句「今天的寄语」——她今天一进首页，第一眼就会看到这句话。`,
    daysSilent ? `\n先想一想你们现在的距离：你们已经约 ${daysSilent} 天没真正说上话了。所以这句话，不是热恋时随口的情话，而是隔了这些天、你重新对她开口时，此刻最想让她听到的那一句。` : '',
    speechDesc ? `\n你平时说话是这样的：${speechDesc}${speechExamples ? `（比如 ${speechExamples}）` : ''}` : '',
    ``,
    `要求：`,
    `- 用你一贯的口吻，像你日常说话的语气和措辞，让这句话一听就是你说的。`,
    `- 只写一句，可以带一个逗号或分句；不要多句、不要标题、不要加引号。`,
    `- 可以轻轻呼应你们之间特有的事，点到为止，不要写成回忆流水账。`,
    `- 这句话里要有你这些天的想念，也有克制的真实——不煽情、不套话、不是对谁都说得出口的。`,
    `- 直接写下这句寄语本身，不要任何解释或引子。`,
  ].filter(Boolean).join('\n');

  const res = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.9, maxTokens: 256, playerId },
  );

  console.log(`\n=== ${charName} → ${playerName} ===`);
  if (speechDesc) console.log(`[说话风格] ${speechDesc}`);
  console.log(res.content.trim());
}

async function main() {
  const playerId = process.argv[2] || 'test-player-001';
  const ids = process.argv.slice(3);
  const characters = ids.length ? ids : [
    'e9dfffc9-577b-457e-8622-a7faceca3805', // 穆昭
    '7631e492-f69b-4d31-b21f-aab7e4f9d785', // 沈星回
    'ae8e2fa3-f933-4257-97fc-97fc27dbe50f', // 顾珩
  ];
  console.log(`玩家: ${playerId}`);
  for (const cid of characters) {
    await generate(playerId, cid);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
