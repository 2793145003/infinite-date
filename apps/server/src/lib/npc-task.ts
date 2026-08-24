/**
 * NPC 任务邀请触发 + 邀请短信 + solo 回归。
 * checkNpcTaskInvite / sweepSoloMissions 挂进 moment-scheduler 的 5 分钟 tick。
 *
 * 触发条件（全 DB 读 + 时间比对，无 LLM，通过才调 buildNpcMission 那次 LLM）：
 * 1. 是好友（friendships active）
 * 2. 空档段：非 sleep（睡着不触发）+ 不在约会中 + 在主城（有行程）
 * 3. 玩家无进行中现场（getActiveLiveSlot 为空）
 * 4. 该 NPC 今天没发过邀请（last_task_invite_day != 今天）
 */
import { db } from '../db';
import { genId, now, jsonParse } from './util';
import { loadCharacterData } from './character';
import { getNpcOnlineState, getCurrentSchedule, bjDayKey } from './schedule';
import { getActiveLiveSlot } from './session-mutex';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { chat, type ChatMessage } from '../llm/adapter';
import { buildNpcMission, type BuiltNpcMission } from './npc-mission';
import { getCosts } from './permission-config';
import { grantCharacterPermission } from './permission';
import { DEITY_ID } from '@idate/shared';

export async function checkNpcTaskInvite(playerId: string): Promise<void> {
  const ts = Date.now();
  const today = bjDayKey(ts);

  // 3. 玩家有进行中现场（约会/对话/探索/剧本/任务）→ 不打断
  if (getActiveLiveSlot(playerId)) return;

  // 玩家已有未处理的 NPC 任务邀请 → 不堆积（一次只留一个待处理邀请）
  const pending = db.prepare(
    "SELECT 1 FROM missions WHERE player_id = ? AND quest_type = 'npc' AND status = 'available'",
  ).get(playerId);
  if (pending) return;

  const friends = db.prepare(`
    SELECT f.character_id, r.last_task_invite_day
    FROM friendships f
    JOIN relationships r ON r.player_id = f.player_id AND r.character_id = f.character_id
    WHERE f.player_id = ? AND f.status = 'active' AND f.character_id != ?
  `).all(playerId, DEITY_ID) as Array<{ character_id: string; last_task_invite_day: string | null }>;

  for (const f of friends) {
    // 4. 该 NPC 今天发过邀请 → 跳过
    if (f.last_task_invite_day === today) continue;

    // 该 NPC 有未完成的 NPC 任务（available/active/solo）→ 不重复邀请
    const npcBusy = db.prepare(`
      SELECT 1 FROM missions WHERE player_id = ? AND assignee_id = ? AND quest_type = 'npc'
        AND status IN ('available', 'active', 'solo')
    `).get(playerId, f.character_id);
    if (npcBusy) continue;

    const charData = loadCharacterData(playerId, f.character_id);
    if (!charData) continue;

    // 2. 空档段：非 sleep + 不在约会 + 在主城（有行程）
    const online = getNpcOnlineState(playerId, f.character_id, charData as unknown as Record<string, any>, ts);
    if (online === 'sleep') continue;

    const inDate = db.prepare(`
      SELECT 1 FROM conversation_sessions WHERE player_id = ? AND character_id = ? AND ended = 0
      UNION ALL
      SELECT 1 FROM scene_sessions ss, json_each(ss.character_ids) j
      WHERE ss.player_id = ? AND j.value = ? AND ss.ended = 0
      LIMIT 1
    `).get(playerId, f.character_id, playerId, f.character_id);
    if (inDate) continue;

    const schedule = getCurrentSchedule(playerId, f.character_id, charData as unknown as Record<string, any>, ts);
    if (!schedule) continue;

    // 判定通过 → 生成任务 + 发邀请短信 + 记 last_task_invite_day
    try {
      const built = await buildNpcMission(playerId, f.character_id);
      insertNpcSms(playerId, f.character_id, built.world.briefing?.trim() || built.world.summary, { task_invite: { missionId: built.missionId } });
      db.prepare('UPDATE relationships SET last_task_invite_day = ? WHERE player_id = ? AND character_id = ?')
        .run(today, playerId, f.character_id);
      break; // 每次 tick 每玩家最多触发 1 个邀请
    } catch (err) {
      console.error('[npc-task] invite failed for', playerId, f.character_id, err instanceof Error ? err.message : err);
    }
  }
}

/** 扫描到期的 solo 任务 → completed + NPC 回归短信（"回来晚了" + 分享成果） */
export async function sweepSoloMissions(): Promise<void> {
  const ts = Date.now();
  const due = db.prepare(`
    SELECT id, player_id, assignee_id, metadata FROM missions
    WHERE quest_type = 'npc' AND status = 'solo' AND solo_complete_at IS NOT NULL AND solo_complete_at <= ?
  `).all(ts) as Array<{ id: string; player_id: string; assignee_id: string; metadata: string }>;

  for (const m of due) {
    try {
      // 抢占：solo → completed（原子，避免重复处理）
      const claimed = db.prepare(
        "UPDATE missions SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'solo'",
      ).run(ts, m.id);
      if (claimed.changes === 0) continue;

      // solo 收益：仅邀请 NPC 独获（极少，体现「跟玩家一起才赚得多」）
      const soloReward = getCosts().npc_mission_solo_reward;
      if (soloReward > 0) {
        try {
          const instance = db.prepare(`
            SELECT id FROM character_instances
            WHERE player_id = ? AND source_character_id = ? AND is_active = 1
          `).get(m.player_id, m.assignee_id) as { id: string } | undefined;
          if (instance) {
            grantCharacterPermission(m.player_id, m.assignee_id, instance.id, soloReward, 'npc_mission_solo_reward', m.id);
          }
        } catch { /* NPC权限失败不阻塞 */ }
      }

      await sendSoloReturnSms(m.player_id, m.assignee_id, m.id, m.metadata);
    } catch (err) {
      console.error('[npc-task] solo 回归失败', m.id, err instanceof Error ? err.message : err);
    }
  }
}

/** 落库 NPC 短信（邀请/回归共用），返回是否成功 */
function insertNpcSms(playerId: string, characterId: string, body: string, metadata: Record<string, unknown>): boolean {
  const thread = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?')
    .get(playerId, characterId) as { id: string } | undefined;
  if (!thread) return false;

  const ts = now();
  const msgId = genId();
  db.prepare(`
    INSERT INTO text_messages (id, thread_id, sender, body, status, internal, internal_notable, internal_viewed, created_at, delivered_at, metadata)
    VALUES (?, ?, 'npc', ?, 'delivered', '', 0, 0, ?, ?, ?)
  `).run(msgId, thread.id, body, ts, ts, JSON.stringify(metadata));

  db.prepare('UPDATE message_threads SET last_message_at = ?, unread_count = unread_count + 1, updated_at = ? WHERE id = ?')
    .run(ts, ts, thread.id);
  return true;
}

/** solo 回归短信：NPC 按人设 + 任务内容生成「回来晚了 + 分享成果」 */
async function sendSoloReturnSms(playerId: string, characterId: string, missionId: string, metadata: string): Promise<void> {
  const meta = jsonParse<{ briefing?: string; mission_goal?: string }>(metadata, {});
  const char = loadCharacterData(playerId, characterId);
  const companionName = char?.name || '这位同伴';

  // 任务期间玩家发来、NPC 没及时回的短信（最后一条 NPC 回复之后的所有玩家消息）
  let playerMessages = '';
  const thread = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?')
    .get(playerId, characterId) as { id: string } | undefined;
  if (thread) {
    const lastNpc = db.prepare(
      "SELECT created_at FROM text_messages WHERE thread_id = ? AND sender = 'npc' ORDER BY created_at DESC LIMIT 1",
    ).get(thread.id) as { created_at: number } | undefined;
    const cutoff = lastNpc?.created_at ?? 0;
    const pending = db.prepare(
      "SELECT body FROM text_messages WHERE thread_id = ? AND sender = 'player' AND created_at > ? ORDER BY created_at ASC",
    ).all(thread.id, cutoff) as Array<{ body: string }>;
    playerMessages = pending.map((m, i) => `${i + 1}. ${m.body}`).join('\n');
  }

  const prompt = renderPrompt(loadPrompt('mission.solo-return'), {
    companion_name: companionName,
    briefing: meta.briefing ?? '',
    mission_goal: meta.mission_goal ?? '把这件事办成了',
    player_messages: playerMessages,
  });

  let body: string;
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt },
      { role: 'user', content: '发这条短信。' },
    ];
    const result = await chat(messages, { temperature: 0.85, maxTokens: 512, playerId });
    body = result.content.trim();
    if (!body) throw new Error('空短信');
  } catch (err) {
    console.error('[npc-task] solo 回归短信生成失败:', err);
    body = '抱歉，之前去了任务世界，回来晚了。那件事我办成了。';
  }

  insertNpcSms(playerId, characterId, body, { solo_return: { missionId } });
}
