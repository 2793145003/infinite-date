/**
 * scene-rollback —— 场景约会「回滚」模块（只新增，不碰旧表/旧服务）
 *
 * 目标：把一场场景约会的状态退回到「某一轮之后」，或退回「整场约会之前」。
 * 只覆盖新场景引擎自有的数据（scene_* 表 + turn_memory_fold/turn_player_facts/memory_embeddings），
 * 旧对话通道（messages/chronicles/player_facts）不在范围内，本模块完全不动。
 *
 * 设计（对应用户确认的分层）：
 *  ┌ 机制 ─────────────────────────────────────────────────────────────┐
 *  │ 追加型记忆（带 round_no 或 scene_session_id）→ 删行，无需快照      │
 *  │   scene_messages / turn_memory_fold(segment,date_summary)          │
 *  │   turn_player_facts / memory_embeddings(按 source_id 联删)          │
 *  │                                                                    │
 *  │ 跨场覆盖写（唯一「回到约会前」要恢复的值）→ 场基线快照(1行/场)     │
 *  │   scene_relationships.player_description / current_activity              │
 *  │                                                                    │
 *  │ 本场内覆盖写累积值（按轮撤回要恢复）→ 轮滚动快照(上限10/场)        │
 *  │   scene_sessions.stats_state / 本场 relationships / overviews      │
 *  └────────────────────────────────────────────────────────────────────┘
 *
 * 两个入口语义：
 *   targetRound = 0   → 整场删除：清空本场全部追加型记忆 + 恢复场基线描述
 *   targetRound > 0   → 按轮撤回：恢复该轮快照的累积值 + 删 round_no >= target 的追加型
 */
import { db } from '../db';
import { genId, now, jsonParse } from './util';
import { embed, storeEmbedding } from './embedding';
import { SCENE_SCHEMA_SQL } from './scene-schema';

// ─── 建表（幂等；全新表，不动任何旧表）────────────────────
let rollbackReady = false;

export function ensureRollbackTables(): void {
  if (rollbackReady) return;
  rollbackReady = true;

  db.exec(SCENE_SCHEMA_SQL);
}

/** 轮滚动快照保留上限（近期撤回只在窗口内意义大；滚出窗口只剩「整场删除」更粗语义） */
export const MAX_ROUND_SNAPSHOTS = 10;

// ─── 读取辅助 ──────────────────────────────────────────

type Relationship = { characterId: string; playerDescription: string; currentActivity: string };
type Overview = { characterId: string; summary: string };

/** 读本场参与角色的现有关系描述（scene_relationships 跨场覆盖写的最新值） */
function readRelationships(playerId: string, characterIds: string[]): Relationship[] {
  if (!characterIds.length) return [];
  const placeholders = characterIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT character_id, player_description, current_activity FROM scene_relationships
     WHERE player_id = ? AND character_id IN (${placeholders})`
  ).all(playerId, ...characterIds) as { character_id: string; player_description: string; current_activity: string }[];
  return rows.map(r => ({ characterId: r.character_id, playerDescription: r.player_description, currentActivity: r.current_activity ?? '' }));
}

/** 读本场参与角色的长期总览（turn_memory_fold fold_type='overview'，每角色一场一条） */
function readOverviews(playerId: string, sessionId: string, characterIds: string[]): Overview[] {
  if (!characterIds.length) return [];
  const out: Overview[] = [];
  for (const cid of characterIds) {
    const row = db.prepare(
      `SELECT id, summary FROM turn_memory_fold
       WHERE player_id=? AND scene_session_id=? AND character_id=? AND fold_type='overview'
       ORDER BY created_at DESC LIMIT 1`
    ).get(playerId, sessionId, cid) as { id: string; summary: string } | undefined;
    if (row) out.push({ characterId: cid, summary: row.summary });
  }
  return out;
}

function readSession(playerId: string, sessionId: string): any {
  return db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId);
}

// ─── 拍摄快照 ──────────────────────────────────────────

/**
 * 场基线快照：开会时（第一轮前）拍一次「约会前」的跨场状态。
 * 只存会跨场被覆盖写的值（scene_relationships.player_description / current_activity）+ 起始 stats_state。
 */
export function captureStartSnapshot(playerId: string, sessionId: string): void {
  ensureRollbackTables();
  const session = readSession(playerId, sessionId);
  if (!session) return;
  const characterIds = jsonParse<string[]>(session.character_ids, []);
  const relationships = readRelationships(playerId, characterIds);

  db.prepare(`
    INSERT INTO scene_start_snapshot (scene_session_id, player_id, character_ids, stats_state, relationships, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scene_session_id) DO NOTHING
  `).run(sessionId, playerId, JSON.stringify(characterIds), session.stats_state, JSON.stringify(relationships), now());
}

/**
 * 轮滚动快照：每一轮【开始前】拍一份本轮前的累积态。
 * 保留最近 MAX_ROUND_SNAPSHOTS 份；超出则淘汰最旧的。
 */
export function captureRoundSnapshot(playerId: string, sessionId: string, roundNo: number): void {
  ensureRollbackTables();
  const session = readSession(playerId, sessionId);
  if (!session) return;
  const characterIds = jsonParse<string[]>(session.character_ids, []);
  const relationships = readRelationships(playerId, characterIds);
  const overviews = readOverviews(playerId, sessionId, characterIds);

  // 幂等：先删同轮旧快照再插入（重试/重复推进同轮时会重拍，不产生重复行）
  db.prepare('DELETE FROM scene_round_snapshots WHERE scene_session_id = ? AND round_no = ?')
    .run(sessionId, roundNo);

  db.prepare(`
    INSERT INTO scene_round_snapshots (id, scene_session_id, round_no, stats_state, relationships, overviews, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(genId(), sessionId, roundNo, session.stats_state, JSON.stringify(relationships), JSON.stringify(overviews), now());

  // 滚动淘汰最旧，保留最近 MAX_ROUND_SNAPSHOTS 份
  db.prepare(`
    DELETE FROM scene_round_snapshots
    WHERE scene_session_id = ? AND id NOT IN (
      SELECT id FROM scene_round_snapshots
      WHERE scene_session_id = ? ORDER BY round_no DESC LIMIT ?
    )
  `).run(sessionId, sessionId, MAX_ROUND_SNAPSHOTS);
}

// ─── 追加型记忆删除（删行）────────────────────────────

/** 删除本场 round_no >= targetRound 的追加型场景记忆行 + 它们对应的 embedding 向量。
 *  按轮撤回时默认把该轮的玩家发言也一并删掉（回到玩家开口之前）；重试（keepPlayerMessage=true）则保留本轮玩家发言，只删 NPC/旁白回复。 */
function deleteAppendedRows(sessionId: string, targetRound: number, keepPlayerMessage = false): void {
  // 1) 台词：删掉 targetRound 起的非玩家消息（重试保留本轮玩家发言，只重生成 NPC/旁白回复），
  //    以及更后面（round_no > targetRound）的全部消息。
  if (keepPlayerMessage) {
    db.prepare(
      "DELETE FROM scene_messages WHERE scene_session_id = ? AND (round_no > ? OR (round_no = ? AND role != 'player'))"
    ).run(sessionId, targetRound, targetRound);
  } else {
    db.prepare('DELETE FROM scene_messages WHERE scene_session_id = ? AND round_no >= ?')
      .run(sessionId, targetRound);
  }

  // 2) 单轮摘要 segment（按轮界）；date_summary 是场末一次性，不做按轮删
  const foldRows = db.prepare(
    `SELECT id, character_id, fold_type FROM turn_memory_fold
     WHERE scene_session_id = ? AND fold_type = 'segment' AND round_max >= ?`
  ).all(sessionId, targetRound) as { id: string; character_id: string }[];

  // 3) 玩家事实（带 scene_session_id + round_no）
  const factRows = db.prepare(
    'SELECT id, character_id FROM turn_player_facts WHERE scene_session_id = ? AND round_no >= ?'
  ).all(sessionId, targetRound) as { id: string; character_id: string }[];

  // 4) 联删这些行对应的 embedding（memory_embeddings.source_id = 记忆行 id）
  const segSourceIds = foldRows.map(r => r.id);
  const factSourceIds = factRows.map(r => r.id);
  const allSourceIds = [...segSourceIds, ...factSourceIds];
  if (allSourceIds.length) {
    const placeholders = allSourceIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM memory_embeddings WHERE source_id IN (${placeholders})`).run(...allSourceIds);
  }

  // 5) 真的删行
  if (foldRows.length) {
    db.prepare('DELETE FROM turn_memory_fold WHERE id IN (' + foldRows.map(() => '?').join(',') + ')')
      .run(...foldRows.map(r => r.id));
  }
  if (factRows.length) {
    db.prepare('DELETE FROM turn_player_facts WHERE id IN (' + factRows.map(() => '?').join(',') + ')')
      .run(...factRows.map(r => r.id));
  }
}

/** 删掉本场【所有】追加型记忆（整场删除用；含 overview/date_summary 全部） */
function deleteAllAppendedRows(sessionId: string): void {
  db.prepare('DELETE FROM scene_messages WHERE scene_session_id = ?').run(sessionId);

  // turn_player_facts + 它们的 embedding
  const factRows = db.prepare('SELECT id FROM turn_player_facts WHERE scene_session_id = ?')
    .all(sessionId) as { id: string }[];
  if (factRows.length) {
    const factIds = factRows.map(r => r.id);
    db.prepare(`DELETE FROM memory_embeddings WHERE source_id IN (${factIds.map(() => '?').join(',')})`).run(...factIds);
    db.prepare(`DELETE FROM turn_player_facts WHERE id IN (${factIds.map(() => '?').join(',')})`).run(...factIds);
  }

  // turn_memory_fold 全部（segment/overview/date_summary/director_note）+ 它们对应的 embedding
  const foldRows = db.prepare('SELECT id FROM turn_memory_fold WHERE scene_session_id = ?')
    .all(sessionId) as { id: string }[];
  if (foldRows.length) {
    const ids = foldRows.map(r => r.id);
    const sourcePlaceholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM memory_embeddings WHERE source_id IN (${sourcePlaceholders})`).run(...ids);
    db.prepare(`DELETE FROM turn_memory_fold WHERE id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
  }
}

// ─── 累积值恢复 ────────────────────────────────────────

/** 恢复累积型：把 session 的 stats_state / 关系描述 / 长期总览设回快照里的值 */
function restoreCumulativeFromSnapshot(
  playerId: string,
  sessionId: string,
  statsState: string,
  relationships: Relationship[],
  overviews: Overview[],
): void {
  // session stats
  db.prepare('UPDATE scene_sessions SET stats_state = ?, updated_at = ? WHERE id = ?')
    .run(statsState, now(), sessionId);

  // relationships（player_description + current_activity 跨场覆盖写 → 恢复为快照值）
  for (const rel of relationships) {
    db.prepare(`
      INSERT INTO scene_relationships (id, player_id, character_id, scene_session_id, player_description, current_activity, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id, character_id) DO UPDATE SET
        player_description = excluded.player_description,
        current_activity   = excluded.current_activity,
        scene_session_id   = excluded.scene_session_id,
        updated_at         = excluded.updated_at
    `).run(genId(), playerId, rel.characterId, sessionId, rel.playerDescription, rel.currentActivity ?? '', now());
  }

  // overviews：覆盖写回快照文本，并重嵌向量。
  // 先清空本场【所有】overview（含 embedding）再只回写快照里的——否则快照里没有、
  // 但本场后面轮次才新生成的 overview 会残留（角色遗漏），按轮撤回就撤不干净。
  const allOvRows = db.prepare(
    `SELECT id, character_id FROM turn_memory_fold
     WHERE scene_session_id = ? AND fold_type = 'overview'`
  ).all(sessionId) as { id: string; character_id: string }[];
  if (allOvRows.length) {
    db.prepare(`DELETE FROM memory_embeddings WHERE source_id IN (${
      allOvRows.map(() => '?').join(',')
    })`).run(...allOvRows.map(r => r.id));
    db.prepare(`DELETE FROM turn_memory_fold WHERE id IN (${
      allOvRows.map(() => '?').join(',')
    })`).run(...allOvRows.map(r => r.id));
  }
  for (const ov of overviews) {
    if (!ov.summary.trim()) continue;
    const ovId = genId();
    db.prepare(`
      INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, summary, created_at)
      VALUES (?, ?, ?, ?, 'overview', ?, ?)
    `).run(ovId, playerId, sessionId, ov.characterId, ov.summary, now());
    // 重嵌向量（异步，不阻塞回滚返回）
    const vec = embed(ov.summary);
    vec.then(v => { if (v) storeEmbedding(playerId, ov.characterId, 'turn_overview', ovId, ov.summary, v); })
       .catch(err => console.error('[scene-rollback] overview re-embed failed:', err instanceof Error ? err.message : err));
  }
}

// ─── 统一入口 ──────────────────────────────────────────

/**
 * 把一场场景约会回滚到 targetRound 之后的状态。
 *   targetRound = 0   → 整场删除：清空本场全部追加型记忆 + 恢复场基线(player_description + current_activity + 起始stats)
 *   targetRound > 0   → 按轮撤回：恢复 targetRound 那份轮快照的累积值 + 删 round_no >= targetRound 的追加型
 *
 * 返回 { ok, targetRound, mode: 'full' | 'round' }；无对应快照时仍尽力删追加型（累积值无法恢复则留现值）。
 */
export function rollbackScene(
  playerId: string,
  sessionId: string,
  targetRound: number,
  keepPlayerMessage = false,
): { ok: boolean; targetRound: number; mode: 'full' | 'round'; error?: string } {
  ensureRollbackTables();
  const session = readSession(playerId, sessionId);
  if (!session) return { ok: false, targetRound, mode: 'round', error: '场景会话不存在' };

  if (targetRound <= 0) {
    // ── 整场删除 ──
    const start = db.prepare('SELECT stats_state, relationships FROM scene_start_snapshot WHERE scene_session_id = ?')
      .get(sessionId) as { stats_state: string; relationships: string } | undefined;

    deleteAllAppendedRows(sessionId);
    db.prepare('DELETE FROM scene_round_snapshots WHERE scene_session_id = ?').run(sessionId);

    if (start) {
      restoreCumulativeFromSnapshot(
        playerId, sessionId,
        start.stats_state,
        jsonParse<Relationship[]>(start.relationships, []),
        [],  // 整场删除：overview 属本场，应删空（回到约会前 = 不记得这场）
      );
    } else {
      // 无基线快照（如旧session没拍）→ 只删追加型，累积值留现值，保证不炸
      db.prepare('UPDATE scene_sessions SET round_no = 0, stats_state = ?, updated_at = ? WHERE id = ?')
        .run('{}', now(), sessionId);
    }
    // 统一设 round_no=0 + ended=0（无快照路径已在上面设了 round_no=0，这里覆盖也无害）
    db.prepare('UPDATE scene_sessions SET round_no = 0, ended = 0, updated_at = ? WHERE id = ?').run(now(), sessionId);
    return { ok: true, targetRound: 0, mode: 'full' };
  }

  // ── 按轮撤回 ──
  const snap = db.prepare(
    `SELECT stats_state, relationships, overviews FROM scene_round_snapshots
     WHERE scene_session_id = ? AND round_no = ?`
  ).get(sessionId, targetRound) as
    { stats_state: string; relationships: string; overviews: string } | undefined;

  deleteAppendedRows(sessionId, targetRound, keepPlayerMessage);

  if (snap) {
    restoreCumulativeFromSnapshot(
      playerId, sessionId,
      snap.stats_state,
      jsonParse<Relationship[]>(snap.relationships, []),
      jsonParse<Overview[]>(snap.overviews, []),
    );
  } else {
    // 无该轮快照（如滚出窗口）→ 删追加型后 round_no 设为现存最大轮
    const remain = db.prepare('SELECT COALESCE(MAX(round_no),0) AS r FROM scene_messages WHERE scene_session_id = ?')
      .get(sessionId) as { r: number };
    db.prepare('UPDATE scene_sessions SET round_no = ?, updated_at = ? WHERE id = ?')
      .run(remain.r, now(), sessionId);
  }

  // 修正 round_no = 现存最大（快照恢复兜底，避免轮号越界）
  const remain = db.prepare('SELECT COALESCE(MAX(round_no),0) AS r FROM scene_messages WHERE scene_session_id = ?')
    .get(sessionId) as { r: number };
  db.prepare('UPDATE scene_sessions SET round_no = ?, updated_at = ? WHERE id = ?')
    .run(remain.r, now(), sessionId);

  // B2：清除陈旧轮快照。round_no 已被压回 remaining，任何 > remaining 的快照都属于
  // 「撤回前玩到的更远轮」，留着会让 MAX_ROUND_SNAPSHOTS 的 ORDER BY round_no DESC 淘汰
  // 把真实新轮挤掉（留最高的陈旧轮）→ 后续撤回找不到正确快照、记忆撤不干净。须在此清掉。
  db.prepare('DELETE FROM scene_round_snapshots WHERE scene_session_id = ? AND round_no > ?')
    .run(sessionId, remain.r);

  return { ok: true, targetRound, mode: 'round' };
}
