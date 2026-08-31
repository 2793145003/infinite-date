// 实测：NPC 发朋友圈时，会不会输出 image_prompt（配图触发率）
import { db } from '../src/db';
import { loadCharacterData, getCharacterName } from '../src/lib/character';
import {
  buildSystemPrompt,
  getHubLocationsText,
  getPlayerProfile,
  formatRelationshipDuration,
  REPLY_SCHEMA,
} from '../src/prompt/builder';
import { getUnifiedTimeline } from '../src/lib/memory';
import { chat, tryParseJsonReply } from '../src/llm/adapter';

async function main() {
  const rel = db.prepare(
    `SELECT r.player_id, r.character_id, r.player_description, r.created_at, t.id AS thread_id
     FROM relationships r JOIN message_threads t
       ON t.player_id = r.player_id AND t.character_id = r.character_id
     LIMIT 1`
  ).get() as { player_id: string; character_id: string; player_description: string; created_at: number; thread_id: string } | undefined;

  if (!rel) { console.error('找不到关系/线程'); process.exit(1); }
  const { player_id: playerId, character_id: characterId } = rel;

  const characterData = loadCharacterData(playerId, characterId);
  if (!characterData) { console.error('loadCharacterData 返回空'); process.exit(1); }
  console.log('角色:', getCharacterName(characterId));

  const ctx = {
    characterData,
    playerDescription: rel.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: getUnifiedTimeline(playerId, characterId),
    recentMessages: [],
    isTextMessage: true,
    isDeity: false,
    hubLocations: getHubLocationsText(),
    relationshipDuration: rel.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx as any);
  const hints = [
    '你刚完成一段行程，想发条朋友圈',
    '你刚和玩家约会结束，想发条朋友圈',
    '你刚到云溪渔村，想发条朋友圈',
  ];

  for (let i = 0; i < hints.length; i++) {
    const userPrompt = `（你正在发一条朋友圈。${hints[i]}

写一条符合你性格的朋友圈动态——就像你真的打开了朋友圈随手发了一条。
可以是一时感慨、生活分享、吐槽、晒一下什么、或者只是一句没头没尾的话。
不要长篇大论，朋友圈就是几句话的东西。
不要@任何人，不要用 hashtag。
把朋友圈正文放在 messages 数组里，internal 留空即可。

如果你这条朋友圈想配一张图——比如你看到的景色、吃的东西、去的地方，或者你本人入镜的画面——可以在 image_prompt 里用中文描述这张图的内容。不想配图就把 image_prompt 留空。）`;

    const result = await chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.9, maxTokens: 512, guidedJson: REPLY_SCHEMA, playerId },
    );
    const parsed = tryParseJsonReply(result.content) as any;
    const content = (parsed?.messages && Array.isArray(parsed.messages) && parsed.messages.length > 0) ? String(parsed.messages[0]).trim() : '';
    const imagePrompt = parsed?.image_prompt ? String(parsed.image_prompt).trim() : '';

    console.log(`\n──────── 第 ${i + 1} 条 · ${hints[i]} ────────`);
    console.log('正文:', JSON.stringify(content));
    console.log('配图:', imagePrompt ? JSON.stringify(imagePrompt) : '（无）');
  }
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
