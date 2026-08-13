/**
 * 场景约会结束时的收尾逻辑（scene-named 和 scene 共用）。
 *
 * 做五件事：
 *  1. 热窗里还没折的轮次补折成 segment（否则热窗原文会丢）
 *  2. foldDateSummary —— 把全部 segment + overview 整合成一条 date_summary
 *  3. clearUrgeAfterDate —— 清零短信/朋友圈意愿（约会结束已直发）
 *  4. 60% 概率 generateNpcMoment —— 朋友圈
 *  5. 新好友 + 空线程 → generateSmsGreeting —— NPC 主动发第一条短信
 *
 * 全部异步，调用方 fire-and-forget（不阻塞 end 响应）。
 *
 * 内部顺序：
 *  - 步骤 1 必须 await 完再跑步骤 2（foldDateSummary 要读 DB 里的 segment）
 *  - 步骤 3/4/5 不依赖折叠，和步骤 1/2 并行跑
 */
import { db } from '../db';
import { jsonParse } from './util';
import { getCharacterName } from './character';
import { clearUrgeAfterDate } from './proactive';
import { generateNpcMoment } from '../routes/moments';
import { generateSmsGreeting } from '../routes/sms';
import {
  foldTurnSegment,
  foldDateSummary,
  type TurnLine,
} from './turn-memory';
import { DEITY_ID } from '@idate/shared';

export async function endSceneSession(
  sessionId: string,
  playerId: string,
): Promise<void> {
  console.log('[scene-end] 开始', { sessionId, playerId });
  const session = db.prepare(
    'SELECT character_ids, root_location_id, current_location_id, round_no FROM scene_sessions WHERE id = ?',
  ).get(sessionId) as {
    character_ids: string;
    root_location_id: string | null;
    current_location_id: string | null;
    round_no: number;
  } | undefined;
  if (!session) {
    console.warn('[scene-end] session 不存在', { sessionId });
    return;
  }

  const charIds = jsonParse<string[]>(session.character_ids, []);
  if (!charIds.length) return;

  const player = db.prepare('SELECT name FROM players WHERE id = ?').get(playerId) as { name: string } | undefined;
  const playerName = player?.name ?? '玩家';

  const locId = session.current_location_id || session.root_location_id;
  let locName = '某处';
  if (locId) {
    const loc = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(locId) as { name: string } | undefined;
    if (loc?.name) locName = loc.name;
  }

  // 取最后几轮对话做朋友圈/短信 greeting 上下文
  const recentMsgs = db.prepare(
    `SELECT role, character_id, character_name, text FROM scene_messages
     WHERE scene_session_id = ? AND role IN ('player', 'npc')
     ORDER BY created_at DESC LIMIT 10`,
  ).all(sessionId) as Array<{
    role: string; character_id: string | null; character_name: string; text: string;
  }>;
  const lastExchange = recentMsgs.reverse().map((m) => {
    if (m.role === 'player') return `${playerName}：${m.text}`;
    return `${m.character_name || 'NPC'}：${m.text}`;
  }).join('\n');

  // 有 segment 的轮次集合（跨角色去重）
  const foldedRounds = new Set<number>();
  const segRows = db.prepare(
    `SELECT DISTINCT round_min FROM turn_memory_fold
     WHERE scene_session_id = ? AND character_id != '__director__' AND fold_type = 'segment'`,
  ).all(sessionId) as { round_min: number }[];
  for (const r of segRows) foldedRounds.add(r.round_min);

  // 所有轮次
  const allRounds = db.prepare(
    `SELECT DISTINCT round_no FROM scene_messages
     WHERE scene_session_id = ? AND round_no > 0
     ORDER BY round_no ASC`,
  ).all(sessionId) as { round_no: number }[];
  const roundsToFold = allRounds.map(r => r.round_no).filter(rn => !foldedRounds.has(rn));

  // 正式角色（跳过 DEITY）
  const formalCharIds = charIds.filter(cid => cid !== DEITY_ID);

  for (const characterId of formalCharIds) {
    const charName = getCharacterName(characterId);
    if (!charName) continue;

    // 步骤 3/4/5 不依赖折叠，先发出去并行跑
    // 约会结束 → 清零意愿（约会结束已直发短信+朋友圈）
    clearUrgeAfterDate(playerId, characterId);

    if (Math.random() < 0.6) {
      generateNpcMoment(
        playerId,
        characterId,
        'date_end',
        `你刚和玩家在${locName}约会结束。刚才的对话：\n${lastExchange}`,
      ).catch(err => console.error('[scene-end] generateNpcMoment failed:', err instanceof Error ? err.message : err));
    }

    // 新好友 + 空线程 → generateSmsGreeting
    const friendship = db.prepare(
      'SELECT created_at FROM friendships WHERE player_id = ? AND character_id = ? AND status = ?',
    ).get(playerId, characterId, 'active') as { created_at: number } | undefined;
    if (friendship) {
      const thread = db.prepare(
        'SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?',
      ).get(playerId, characterId) as { id: string } | undefined;
      if (thread) {
        const msgCount = db.prepare(
          'SELECT COUNT(*) as cnt FROM text_messages WHERE thread_id = ?',
        ).get(thread.id) as { cnt: number };
        if (msgCount.cnt === 0) {
          generateSmsGreeting(playerId, characterId, thread.id, {
            locationName: locName,
            lastExchange,
          }).catch(err => console.error('[scene-end] generateSmsGreeting failed:', err instanceof Error ? err.message : err));
        }
      }
    }

    // ── 步骤 1: 补折还没折的轮次（await，因为步骤 2 要读 DB）──
    // 分批并发（每批 5 个），避免一次性打上百个 LLM 请求
    const FOLD_BATCH = 5;
    for (let i = 0; i < roundsToFold.length; i += FOLD_BATCH) {
      const batch = roundsToFold.slice(i, i + FOLD_BATCH);
      await Promise.all(batch.map(async rn => {
        const turnMsgs = db.prepare(
          `SELECT role, character_id, character_name, text, internal, internal_notable
           FROM scene_messages
           WHERE scene_session_id = ? AND round_no = ? AND role IN ('player', 'npc')
           ORDER BY created_at ASC`,
        ).all(sessionId, rn) as Array<{
          role: string; character_id: string | null; character_name: string;
          text: string; internal: string; internal_notable: number;
        }>;

        const turns: TurnLine[] = [];
        for (const m of turnMsgs) {
          if (m.role === 'player') {
            turns.push({ role: 'player', text: m.text });
          } else if (m.character_id === characterId) {
            turns.push({
              role: charName,
              text: m.text,
              internal: m.internal || undefined,
            });
          }
        }
        if (!turns.length) return;

        return foldTurnSegment({
          sceneSessionId: sessionId,
          playerId,
          characterId,
          characterName: charName,
          roundNo: rn,
          turns,
          playerName,
        }).catch(err => console.error('[scene-end] foldTurnSegment failed:', err instanceof Error ? err.message : err));
      }));
    }

    // ── 步骤 2: foldDateSummary（把全部 segment + overview 折成一条 date_summary）──
    await foldDateSummary({
      sceneSessionId: sessionId,
      playerId,
      characterId,
      characterName: charName,
      playerName,
    }).catch(err => console.error('[scene-end] foldDateSummary failed:', err instanceof Error ? err.message : err));
  }
}
