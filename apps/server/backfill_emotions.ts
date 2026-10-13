/**
 * 心绪历史回填 —— 给已有的最近 N 轮短信补上心绪
 *
 * 背景：心绪功能上线前的历史消息没有 emotions，点头像弹窗是空的。本脚本按「当时可见的历史」
 * 重放生产 prompt，为最近 N 轮补出心绪。
 *
 * 忠实性：每一轮只用**该轮之前**的消息做上下文（不偷看未来），并按旧→新顺序处理，
 * 把上一轮的心绪（真实的或刚回填的）按同样的衰减规则注入本轮——与真实运行时一致。
 *
 * 安全：
 *   - 默认 dry-run，只跑模型、不写库；加 --apply 才写。
 *   - 幂等：已经带 emotions 的消息一律跳过，可安全重跑。
 *   - 写库前把**受影响行的原 metadata** 导出为回滚 SQL（data/rollback-emotion-backfill-*.sql）。
 *
 * 用法：
 *   cd apps/server && npx tsx backfill_emotions.ts --limit=3            # 试跑 3 个线程（不写库）
 *   cd apps/server && npx tsx backfill_emotions.ts --limit=3 --apply    # 真写
 *   cd apps/server && npx tsx backfill_emotions.ts --thread=<id> --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './src/db';
import { loadCharacterData } from './src/lib/character';
import { buildSystemPrompt, buildMessages, generateReply, getHubLocationsText, getPlayerProfile, type PromptContext } from './src/prompt/builder';
import { attachEmotionToMessage, decayEmotions, emotionInjectionNote, topEmotion, EMOTION_KEYS } from './src/lib/emotion';
import type { EmotionScores } from '@idate/shared';
import { now } from './src/lib/util';

const argv = process.argv.slice(2);
const argVal = (k: string, d: string) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const LIMIT = Number(argVal('limit', '5'));
const ROUNDS = Number(argVal('rounds', '5'));
const ONLY_THREAD = argVal('thread', '');
const APPLY = argv.includes('--apply');
const CONTEXT = 8; // 每轮最多带多少条历史

interface Turn { playerIdx: number; playerBody: string; npcIds: string[] }

/** 找出该线程最近 ROUNDS 轮「玩家消息 + 其后 NPC 回复」 */
function turnsOf(threadId: string): { rows: Array<{ id: string; sender: string; body: string; metadata: string; created_at: number }>; turns: Turn[] } {
  const rows = db
    .prepare(
      `SELECT id, sender, body, metadata, created_at FROM text_messages
       WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(threadId) as Array<{ id: string; sender: string; body: string; metadata: string; created_at: number }>;

  const turns: Turn[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.sender !== 'player' || !rows[i]!.body.trim()) continue;
    const npcIds: string[] = [];
    for (let j = i + 1; j < rows.length && rows[j]!.sender === 'npc'; j++) npcIds.push(rows[j]!.id);
    if (npcIds.length) turns.push({ playerIdx: i, playerBody: rows[i]!.body, npcIds });
  }
  return { rows, turns: turns.slice(-ROUNDS) };
}

function hasEmotion(metadata: string): boolean {
  try {
    const m = JSON.parse(metadata) as { emotions?: unknown };
    return !!m.emotions;
  } catch {
    return false;
  }
}

function readEmotion(metadata: string): EmotionScores | null {
  try {
    const m = JSON.parse(metadata) as { emotions?: EmotionScores };
    return m.emotions ?? null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`=== 心绪历史回填 ${APPLY ? '【写库】' : '【dry-run，不写库】'} ===`);
  if (!APPLY) console.log('（加 --apply 才真正写入；本模式只跑模型看质量）');

  const threads = db
    .prepare(
      `SELECT t.id AS thread_id, t.character_id, t.player_id,
              (SELECT count(*) FROM text_messages m WHERE m.thread_id = t.id AND m.sender='npc') AS n
       FROM message_threads t
       WHERE t.character_id != 'DEITY' AND t.id != ?
       ORDER BY n DESC LIMIT ?`,
    )
    .all(ONLY_THREAD, LIMIT) as Array<{ thread_id: string; character_id: string; player_id: string; n: number }>;

  const snapshotTs = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackFile = path.resolve(`data/rollback-emotion-backfill-${snapshotTs}.sql`);
  const rollbacks: string[] = [
    `-- 心绪历史回填回滚脚本（生成于 ${new Date().toISOString()}）`,
    `-- 用法：把本文件喂给 sqlite 即可还原这些行被改前的 metadata`,
    'BEGIN;',
  ];

  let done = 0, skipped = 0, failed = 0;

  for (const t of threads) {
    const cd = loadCharacterData(t.player_id, t.character_id);
    if (!cd) { console.log(`- 跳过 ${t.character_id}（角色数据缺失）`); continue; }
    const { rows, turns } = turnsOf(t.thread_id);
    if (!turns.length) { console.log(`- 跳过 ${cd.name}（没有完整轮次）`); continue; }

    console.log(`\n──────── ${cd.name}（${turns.length} 轮待查）────────`);

    // 起点心绪：这些轮次之前，最近一轮已有的心绪（真实的）
    let prevEmotion: EmotionScores | null = null;
    for (let i = turns[0]!.playerIdx - 1; i >= 0; i--) {
      const e = readEmotion(rows[i]!.metadata);
      if (e) { prevEmotion = e; break; }
    }

    for (const turn of turns) {
      const firstNpc = rows.find((r) => r.id === turn.npcIds[0]!);
      if (!firstNpc) continue;

      if (hasEmotion(firstNpc.metadata)) {
        console.log(`  轮次 玩家「${turn.playerBody.slice(0, 20)}」→ 已有心绪，跳过`);
        skipped++;
        prevEmotion = readEmotion(firstNpc.metadata) ?? prevEmotion;
        continue;
      }

      // 历史 = 该轮玩家消息之前的最近 CONTEXT 条
      const history = rows
        .slice(Math.max(0, turn.playerIdx - CONTEXT), turn.playerIdx)
        .map((r) => ({
          role: (r.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant',
          text: r.body,
        }));

      const ctx: PromptContext = {
        characterData: cd,
        playerDescription: '（历史回填）',
        playerProfile: getPlayerProfile(t.player_id),
        chronicleSummary: '',
        recentMessages: history,
        isTextMessage: true,
        isDeity: false,
        locationName: '（短信中无法确定位置）',
        hubLocations: getHubLocationsText(),
        retrievedMemories: null,
        emotionsEnabled: true,
      };
      const input = prevEmotion
        ? `${emotionInjectionNote(decayEmotions(prevEmotion))}\n${turn.playerBody}`
        : turn.playerBody;

      try {
        const reply = await generateReply(buildMessages(buildSystemPrompt(ctx), history, input), {
          temperature: 0.85, maxTokens: 1024, playerId: t.player_id,
        });
        if (!reply.emotions) {
          console.log(`  轮次 玩家「${turn.playerBody.slice(0, 20)}」→ ❌ 未取得心绪，跳过`);
          failed++;
          continue;
        }
        const top = topEmotion(reply.emotions);
        const actual = rows.find((r) => r.id === turn.npcIds[0]!)!.body.slice(0, 34);
        console.log(`  玩家「${turn.playerBody.slice(0, 18)}」→ 实际回复「${actual}」`);
        console.log(`      补出心绪 ${EMOTION_KEYS.map((k) => (reply.emotions as unknown as Record<string, number>)[k]).join('/')} → 最强「${top.cn}」${top.value}`);

        if (APPLY) {
          rollbacks.push(
            `UPDATE text_messages SET metadata = '${firstNpc.metadata.replace(/'/g, "''")}' WHERE id = '${firstNpc.id}';`,
          );
          attachEmotionToMessage('text_messages', firstNpc.id, reply.emotions);
        }
        prevEmotion = reply.emotions;
        done++;
      } catch (err) {
        console.log(`  ❌ ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  }

  if (APPLY && rollbacks.length > 2) {
    rollbacks.push('COMMIT;');
    fs.writeFileSync(rollbackFile, rollbacks.join('\n'), 'utf-8');
    console.log(`\n回滚脚本已写入 ${rollbackFile}（含 ${rollbacks.length - 3} 条 UPDATE）`);
  }

  console.log(`\n=== 汇总 ===`);
  console.log(`回填成功 ${done} 轮　跳过（已有心绪）${skipped} 轮　失败 ${failed} 轮　${APPLY ? '已写库' : '未写库'}`);
  if (APPLY) {
    const withEmo = (db.prepare(`SELECT count(*) AS c FROM text_messages WHERE metadata LIKE '%"emotions"%'`).get() as { c: number }).c;
    console.log(`库中带心绪的消息数：${withEmo}`);
  }
  console.log(`完成于 ${now()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
