// 实测：玩家提问 → 男主回复是否配图（玩家问到了他再发）
import { db } from '../src/db';
import { loadCharacterData, getCharacterName } from '../src/lib/character';
import {
  buildSystemPrompt,
  buildMessages,
  generateReply,
  getHubLocationsText,
  getPlayerProfile,
  formatRelationshipDuration,
  smsMessageText,
} from '../src/prompt/builder';
import { retrieveRelevantMemories, getUnifiedTimeline } from '../src/lib/memory';
import { getNpcCurrentLocationName } from '../src/lib/schedule';

async function main() {
  const rel = db.prepare(
    `SELECT r.player_id, r.character_id, r.player_description, r.created_at, t.id AS thread_id
     FROM relationships r JOIN message_threads t
       ON t.player_id = r.player_id AND t.character_id = r.character_id
     LIMIT 1`
  ).get() as { player_id: string; character_id: string; player_description: string; created_at: number; thread_id: string } | undefined;

  if (!rel) { console.error('找不到关系/线程'); process.exit(1); }
  const { player_id: playerId, character_id: characterId, thread_id: threadId } = rel;

  const characterData = loadCharacterData(playerId, characterId);
  if (!characterData) { console.error('loadCharacterData 返回空'); process.exit(1); }
  console.log('角色:', getCharacterName(characterId));
  console.log('玩家:', playerId);

  const baseMsgs = db.prepare(
    'SELECT sender, body, image_asset_id, metadata FROM text_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 6'
  ).all(threadId) as Array<{ sender: string; body: string; image_asset_id: string | null; metadata: string | null }>;

  const history = baseMsgs.reverse().map((m) => ({
    role: (m.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
    text: smsMessageText(m),
  }));

  const retrievedMemories = await retrieveRelevantMemories(
    playerId, characterId,
    history.map((m) => ({ role: m.role as string, text: m.text })),
    '',
  );
  const smsLocation = getNpcCurrentLocationName(playerId, characterId, characterData as any, Date.now());

  const questions = [
    '你在做什么？',
    '你能看到月亮吗？',
    '你在哪？',
    '给我看看你现在周围的样子',
    '今天吃了什么？',
  ];

  for (const q of questions) {
    const ctx = {
      characterData,
      playerDescription: rel.player_description ?? '刚认识的陌生人',
      playerProfile: getPlayerProfile(playerId),
      chronicleSummary: getUnifiedTimeline(playerId, characterId),
      recentMessages: history.slice(-8),
      isTextMessage: true,
      isDeity: false,
      locationName: smsLocation || '（短信中无法确定位置）',
      hubLocations: getHubLocationsText(),
      retrievedMemories,
      relationshipDuration: rel.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
    };

    const systemPrompt = buildSystemPrompt(ctx as any);
    const messages = buildMessages(systemPrompt, ctx.recentMessages, q);

    const reply = await generateReply(messages, { temperature: 0.85, maxTokens: 1024, playerId });
    const img = (reply as any).image_prompt as string | undefined;

    console.log(`\n──────── 玩家问：「${q}」 ────────`);
    console.log('回复:', JSON.stringify(reply.messages));
    console.log('配图:', img ? JSON.stringify(img) : '（无）');
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
