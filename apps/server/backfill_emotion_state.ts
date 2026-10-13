/**
 * 心绪状态回填 —— 把已有的消息级心绪，汇总成角色级状态（character_emotion_state）
 *
 * 背景：心绪原先是挂在消息 metadata 上的（会话维度）。改为角色级状态后，注入与弹窗都读状态表，
 * 状态表若为空，短信侧的心绪注入会整个失效。本脚本为每个 (玩家, 角色) 取**最近一轮**心绪写入状态，
 * updated_at 用那条消息的真实时间——这样时间衰减才是按真实经过时间算的，
 * 久未联系的角色读出来会自然接近基线（他早消气了），而不是永远停在上次的值。
 *
 * 用法：
 *   cd apps/server && npx tsx backfill_emotion_state.ts          # 只读预演
 *   cd apps/server && npx tsx backfill_emotion_state.ts --apply  # 写入
 */
import fs from 'node:fs';
import path from 'node:path';
import { db } from './src/db';
import { normalizeEmotions, topEmotion, EMOTION_KEYS } from './src/lib/emotion';
import { now } from './src/lib/util';

const APPLY = process.argv.includes('--apply');
const ROLLBACK = path.resolve(`data/rollback-emotion-state-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);

interface Pick {
  playerId: string;
  characterId: string;
  threadId: string;
  msgId: string;
  createdAt: number;
  emotions: Record<string, number>;
}

function collect(): Pick[] {
  // 每个线程里最近一条带 emotions 的 NPC 消息
  const rows = db
    .prepare(
      `SELECT m.id AS msg_id, m.thread_id, m.metadata, m.created_at, t.player_id, t.character_id
       FROM text_messages m
       JOIN message_threads t ON t.id = m.thread_id
       WHERE m.sender = 'npc'
         AND m.metadata LIKE '%"emotions"%'
         AND m.id = (
           SELECT id FROM text_messages
           WHERE thread_id = m.thread_id AND sender = 'npc' AND metadata LIKE '%"emotions"%'
           ORDER BY created_at DESC, rowid DESC LIMIT 1
         )`,
    )
    .all() as Array<{ msg_id: string; thread_id: string; metadata: string; created_at: number; player_id: string; character_id: string }>;

  const out: Pick[] = [];
  for (const r of rows) {
    let emo: unknown = null;
    try {
      emo = (JSON.parse(r.metadata) as { emotions?: unknown }).emotions;
    } catch {
      continue;
    }
    const e = normalizeEmotions(emo);
    if (!e) continue;
    out.push({
      playerId: r.player_id,
      characterId: r.character_id,
      threadId: r.thread_id,
      msgId: r.msg_id,
      createdAt: r.created_at,
      emotions: e as unknown as Record<string, number>,
    });
  }
  // 同一角色可能有多条线程：只保留时间最新的那条
  const byChar = new Map<string, Pick>();
  for (const p of out) {
    const key = `${p.playerId}|${p.characterId}`;
    const prev = byChar.get(key);
    if (!prev || p.createdAt > prev.createdAt) byChar.set(key, p);
  }
  return [...byChar.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function main() {
  console.log(`=== 心绪状态回填 ${APPLY ? '【写库】' : '【预演，不写库】'} ===`);
  const picks = collect();
  console.log(`找到 ${picks.length} 个（玩家, 角色）需要状态\n`);

  const rollbacks: string[] = [
    `-- 心绪状态回填回滚（${new Date().toISOString()}）`,
    'BEGIN;',
  ];
  const nowTs = now();
  let aged = 0;

  for (const p of picks) {
    const top = topEmotion(p.emotions as never);
    const hours = ((nowTs - p.createdAt) / 3_600_000).toFixed(1);
    const stale = nowTs - p.createdAt > 6 * 3_600_000; // 超过 2 个半衰期
    if (stale) aged++;
    console.log(
      `  ${p.characterId.slice(0, 8)}…  ${EMOTION_KEYS.map((k) => p.emotions[k]).join('/')}` +
        ` → 最强「${top.cn}」${top.value}　来自 ${hours}h 前${stale ? '（已过衰减期，读出来会接近基线）' : ''}`,
    );
    if (APPLY) {
      rollbacks.push(`DELETE FROM character_emotion_state WHERE player_id = '${p.playerId}' AND character_id = '${p.characterId}';`);
      db.prepare(
        `INSERT INTO character_emotion_state (player_id, character_id, emotions, source, source_id, updated_at)
         VALUES (?, ?, ?, 'sms', ?, ?)
         ON CONFLICT(player_id, character_id) DO UPDATE SET
           emotions = excluded.emotions, source = excluded.source,
           source_id = excluded.source_id, updated_at = excluded.updated_at`,
      ).run(p.playerId, p.characterId, JSON.stringify(p.emotions), p.threadId, p.createdAt);
    }
  }

  if (APPLY) {
    rollbacks.push('COMMIT;');
    fs.writeFileSync(ROLLBACK, rollbacks.join('\n'), 'utf-8');
    const cnt = (db.prepare('SELECT count(*) AS c FROM character_emotion_state').get() as { c: number }).c;
    console.log(`\n已写入，状态表共 ${cnt} 条`);
    console.log(`回滚脚本：${ROLLBACK}`);
  }
  console.log(`\n其中 ${aged} 个角色距上次互动已超过 2 个半衰期（读出来会自然接近基线，属预期）`);
  console.log(APPLY ? '完成（写库）' : '预演完成（未写库，加 --apply 生效）');
}

main();
