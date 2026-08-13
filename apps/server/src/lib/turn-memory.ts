/**
 * turn-memory —— 场景引擎按「轮」的三层记忆折叠 (Scene Engine §3.3.6)
 *
 * 三层（单位 = 轮，玩家上一句 → 下一句之间的完整一轮 = 导演分镜 + 逐拍演员）:
 *   N=5  热窗           最近 N 轮原文（逐字，不折叠）
 *   I=12 中期折叠起点    折叠 12~15 这一段
 *   M=15 中期上界        角色可见 I~M（单轮事件摘要）
 *   长期                1 条滚动总览（增量更新：总览 + 一批新摘要 → 新总览）
 *
 * 关键约束（用户逐条确认）：
 *  - 长期不是"全部记忆重生成"，是"现有总览 + 一批新摘要 → 新总览"（全部记忆放不下）
 *  - 折叠时机 = M 内的后几轮（I~M），不是"滑出热窗就折"——角色始终能看到 N~M
 *  - 轮内更新全部在场者，各自归位，绝不跨角色合并（防张冠李戴）
 *  - 每角色各折自己的；导演单独折场记
 *
 * 复用：db / chat / genId / now；独立建表，不动现有 chronicles 折叠通道。
 */
import { db } from '../db';
import { genId, now, jsonParse } from './util';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import { embed, storeEmbedding, retrieveMemories } from './embedding';
import { SCENE_SCHEMA_SQL } from './scene-schema';

// ─── 参数（可调）──────────────
export const HOT_WINDOW_N = 5;   // 最近 N 轮原文（热窗）
export const MID_I = 12;         // 折叠起点：折叠 12~15 这一段
export const MID_M = 15;         // 中期上界：角色可见的单轮摘要轮数

// ─── 建表（统一走 scene-schema.ts，见 REVIEW_V4.md 🔴-1）───
let turnMemoryReady = false;

export function ensureTable() {
  if (turnMemoryReady) return;
  turnMemoryReady = true;
  db.exec(SCENE_SCHEMA_SQL);
}

// ─── 并发去重：同一 scene+角色 同时只跑一个折叠 ──
const inflight = new Map<string, Promise<void>>();

export interface TurnLine {
  role: 'player' | string;      // 说话者（角色名 或 'player'）
  text: string;
  internal?: string;
}

/**
 * 折叠某一轮（roundNo）中某角色的片段 → 单轮事件摘要（segment）
 * 归属该角色自己；异步、可后台跑。
 */
export async function foldTurnSegment(opts: {
  sceneSessionId: string;
  playerId: string;
  characterId: string;
  characterName: string;
  roundNo: number;
  turns: TurnLine[];            // 这一轮中该角色的说话内容（含内心）
  playerName?: string;
}): Promise<void> {
  ensureTable();
  if (!opts.turns.length) return;
  const key = `${opts.sceneSessionId}|${opts.characterId}|seg|${opts.roundNo}`;
  if (inflight.has(key)) return;
  const p = doFoldTurnSegment(opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  await p;
}

async function doFoldTurnSegment(opts: {
  sceneSessionId: string; playerId: string; characterId: string; characterName: string;
  roundNo: number; turns: TurnLine[]; playerName?: string;
}): Promise<void> {
  const playerName = opts.playerName ?? '玩家';
  const dialog = opts.turns
    .map(t => `${t.role === 'player' ? playerName : opts.characterName}：${t.text}${t.internal ? ` [内心：${t.internal}]` : ''}`)
    .join('\n');

  const system = `你是一个记忆整理系统。以下是一个约会/场景中「${opts.characterName}」这一角的单轮记录。
请为「${opts.characterName}」这一角色生成单轮事件摘要。只写这一轮里该角色明确发生/参与的事：他去做什么事、说过什么（若剧情需要）、内心活动。
- 写出具体的动作、对话要点和场景氛围，不要只概括为"双方进行了互动"这种空话。
- 允许写角色的情绪反应，但必须基于记录中明确出现的内容，不要推测未见情感。
- 用第三人称、简短（2-3句）。
同时 player_facts：从这一轮里提取关于玩家（${playerName}）的持久事实——玩家向${opts.characterName}透露的个人信息、偏好、习惯、性格特征、生活习惯、重要情况。每条一句话，第三人称（"${playerName}…"），只提取明确的、未来仍成立的事实。
严格排除：玩家发出的提问型/一次性台词（如"你喜欢日出吗""你最近好吗"）不算事实；"明天要去医院复查"这类会发生的具体事项可提取，但纯对话问句不要。不要推测。如果没有，返回空数组。

【关键区分】只提取玩家**实际说出或做出**的事实。角色（${opts.characterName}）对玩家的指控、猜测、误解或主观判断不算玩家事实——例如${opts.characterName}说"你在疏远我"不等于玩家真的在疏远。只有玩家自己明确表达或做出的事才算。\n只输出 JSON。`;
  const res = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: `记录：\n${dialog}` },
    ],
    {
      temperature: 0.3, maxTokens: 320,
      guidedJson: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          player_facts: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'player_facts'],
      } as any,
    },
  );
  const parsed = tryParseJsonReply(res.content);
  const summary = String(parsed?.summary ?? '').trim();
  if (!summary) return;

  // 回滚守卫：折叠是异步(COMMIT 后 fire-and-forget)，期间若该轮已被 rollbackScene 撤回
  // (会删除 scene_messages WHERE round_no >= target)，此轮就不该再写记忆——否则会把已回退轮
  // 的记忆折叠"写回"已删位置，产生孤儿/幽灵记忆。此处检查该轮是否仍有场景消息残留，无则跳过。
  const stillExists = db.prepare(
    'SELECT 1 FROM scene_messages WHERE scene_session_id = ? AND round_no = ? LIMIT 1'
  ).get(opts.sceneSessionId, opts.roundNo);
  if (!stillExists) return;

  const segId = genId();
  db.prepare(`
    INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, round_min, round_max, summary, created_at)
    VALUES (?, ?, ?, ?, 'segment', ?, ?, ?, ?)
  `).run(segId, opts.playerId, opts.sceneSessionId, opts.characterId, opts.roundNo, opts.roundNo, summary, now());

  // 语义检索：单轮摘要也存 embedding（source_type='turn_segment'），按 player+character 隔离
  const segVec = await embed(summary);
  if (segVec) {
    storeEmbedding(opts.playerId, opts.characterId, 'turn_segment', segId, summary, segVec);
  }

  // player_facts：该角色从自己的轮内容里提取的玩家事实，逐条落 turn_player_facts（按角色归属）
  const playerFacts = Array.isArray(parsed?.player_facts)
    ? (parsed.player_facts as string[]).map(String).filter(Boolean)
    : [];
  if (playerFacts.length) {
    const ins = db.prepare(`
      INSERT INTO turn_player_facts (id, player_id, character_id, scene_session_id, round_no, fact, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fact of playerFacts) {
      const fId = genId();
      ins.run(fId, opts.playerId, opts.characterId, opts.sceneSessionId, opts.roundNo, fact, now());
      const fVec = await embed(fact);
      if (fVec) {
        storeEmbedding(opts.playerId, opts.characterId, 'turn_player_fact', fId, fact, fVec);
      }
    }
  }
}

/**
 * 读取某角色在场景里积累的 player_facts（按角色归属，供 actor 上下文/检索）
 */
export function getTurnPlayerFacts(opts: {
  sceneSessionId: string;
  playerId: string;
  characterId: string;
}): string[] {
  ensureTable();
  const rows = db.prepare(`
    SELECT fact FROM turn_player_facts
    WHERE player_id=? AND scene_session_id=? AND character_id=?
    ORDER BY round_no ASC
  `).all(opts.playerId, opts.sceneSessionId, opts.characterId) as { fact: string }[];
  return rows.map(r => r.fact);
}

/**
 * 增量更新长期总览：用「现有总览 + 本轮单轮摘要」→ 新总览（不是全部记忆重生成）
 * 归某角色自己；每角色一条长期总览。
 */
export async function refreshOverview(opts: {
  sceneSessionId: string;
  playerId: string;
  characterId: string;
  characterName: string;
  newSegments: string[];        // 本轮（或本批）新增的单轮摘要
  existingOverview?: string;    // 现有总览
  playerName?: string;
}): Promise<void> {
  ensureTable();
  if (!opts.newSegments.length && !opts.existingOverview) return;
  const key = `${opts.sceneSessionId}|${opts.characterId}|ov`;
  if (inflight.has(key)) return;
  const p = doRefreshOverview(opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  await p;
}

async function doRefreshOverview(opts: {
  sceneSessionId: string; playerId: string; characterId: string; characterName: string;
  newSegments: string[]; existingOverview?: string; playerName?: string;
}): Promise<void> {
  const playerName = opts.playerName ?? '玩家';
  const prev = opts.existingOverview?.trim() ?? '（无）';
  const additions = opts.newSegments.filter(Boolean).join('\n');
  const system = `你是一个记忆整理系统。请基于「${opts.characterName}」这一角色与${playerName}的长期关系总览，吸收下面新增的单轮片段，生成一条更新后的总览。
原则：
- 这是滚动总览，概括两人关系的持续状态、重大进展、反复出现的主题。
- 写出具体的关键事件和互动模式，不要只写"关系升温""建立了信任"这种空话。
- 新增单轮片段里明确的新事实要并入；已被更晚内容覆盖的旧表述可精简。
- 如果新增单轮片段为空或无实质内容，直接返回现有总览原文，不要写"无法合并"之类的废话。
- 用第三人称、简洁（2-4句）。
只输出 JSON。`;
  const res = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: `现有总览：\n${prev}\n\n新增单轮片段：\n${additions}` },
    ],
    { temperature: 0.3, maxTokens: 384, guidedJson: { type: 'object', properties: { summary: { type: 'string' } } } as any },
  );
  const parsed = tryParseJsonReply(res.content);
  const summary = String(parsed?.summary ?? '').trim();
  if (!summary) return;

  // upsert：删旧的 overview，写新的
  db.prepare(`DELETE FROM turn_memory_fold WHERE player_id=? AND scene_session_id=? AND character_id=? AND fold_type='overview'`)
    .run(opts.playerId, opts.sceneSessionId, opts.characterId);
  const ovId = genId();
  db.prepare(`
    INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, summary, created_at)
    VALUES (?, ?, ?, ?, 'overview', ?, ?)
  `).run(ovId, opts.playerId, opts.sceneSessionId, opts.characterId, summary, now());

  // 已折叠的 segment 删除——防止无限堆积（三层折叠：segment 折进 overview 后即失效）
  db.prepare(`DELETE FROM turn_memory_fold WHERE player_id=? AND scene_session_id=? AND character_id=? AND fold_type='segment'`)
    .run(opts.playerId, opts.sceneSessionId, opts.characterId);
  // 对应的 embedding 也清理
  db.prepare(`DELETE FROM memory_embeddings WHERE player_id=? AND character_id=? AND source_type='turn_segment'`)
    .run(opts.playerId, opts.characterId);

  // 长期总览也存 embedding（source_type='turn_overview'），可语义检索
  const ovVec = await embed(summary);
  if (ovVec) {
    storeEmbedding(opts.playerId, opts.characterId, 'turn_overview', ovId, summary, ovVec);
  }
}

/** 约会摘要的 fold_type（整场收尾，一次性生成） */
export const DATE_SUMMARY_TYPE = 'date_summary';

/**
 * 场末生成整场约会摘要并入库 + 语义检索。
 * 一次 LLM：把该角色全部单轮摘要 + 现有总览整合成一条整场约会摘要。
 * 归该角色自己；source_type='turn_date_summary' 可检索。
 */
export async function foldDateSummary(opts: {
  sceneSessionId: string;
  playerId: string;
  characterId: string;
  characterName: string;
  playerName?: string;
}): Promise<string | null> {
  ensureTable();
  const playerName = opts.playerName ?? '玩家';

  // 收集该角色本场的单轮摘要 + 总览
  const segs = (db.prepare(`
    SELECT summary FROM turn_memory_fold
    WHERE player_id=? AND scene_session_id=? AND character_id=? AND fold_type='segment'
    ORDER BY round_min ASC
  `).all(opts.playerId, opts.sceneSessionId, opts.characterId) as { summary: string }[]).map(r => r.summary);
  const ov = getOverview(opts.sceneSessionId, opts.characterId, opts.playerId);
  if (!segs.length && !ov) {
    console.warn('[foldDateSummary] 跳过：无 segment 且无 overview', { sceneSessionId: opts.sceneSessionId, characterId: opts.characterId });
    return null;
  }

  const system = `你是一个记忆整理系统。请为「${opts.characterName}」这一角色与该玩家「${playerName}」的这整场约会/场景，生成一条收尾约会摘要。
要求：
- 必须包含：什么时间（大致时段）、什么地点、两人做了什么事、互动中的关键情节。
- 写出具体的动作和对话要点，不要只概括为"双方进行了互动""展现了体贴"这种空话。
- 允许写情绪氛围和关键感受，但必须基于片段中明确出现的内容，不要推测未见的情感。
- 用第三人称、简洁叙述（3-6句）。不要美化扩写，不要写"此次互动体现了"这种总结体。
只输出 JSON。`;
  const res = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: `本场单轮摘要：\n${segs.join('\n')}\n\n长期总览：\n${ov || '（无）'}` },
    ],
    { temperature: 0.3, maxTokens: 512, guidedJson: { type: 'object', properties: { summary: { type: 'string' } } } as any },
  );
  const parsed = tryParseJsonReply(res.content);
  const summary = String(parsed?.summary ?? '').trim();
  if (!summary) {
    console.warn('[foldDateSummary] LLM 返回空 summary', { sceneSessionId: opts.sceneSessionId, characterId: opts.characterId, rawContent: res.content.slice(0, 200) });
    return null;
  }

  const dsId = genId();
  db.prepare(`
    INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, summary, created_at)
    VALUES (?, ?, ?, ?, 'date_summary', ?, ?)
  `).run(dsId, opts.playerId, opts.sceneSessionId, opts.characterId, summary, now());
  console.log('[foldDateSummary] 写入成功', { sceneSessionId: opts.sceneSessionId, characterId: opts.characterId, segments: segs.length, hasOverview: !!ov, summary: summary.slice(0, 80) });

  const dsVec = await embed(summary);
  if (dsVec) {
    storeEmbedding(opts.playerId, opts.characterId, 'turn_date_summary', dsId, summary, dsVec);
  }
  return summary;
}

/**
 * 语义检索该 player×character 的场景记忆（单轮摘要/总览/约会摘要）。
 * 直接复用 embedding.retrieveMemories —— 它已按 player_id + character_id 过滤，天然归属正确。
 * queryType 可限定检索哪层（默认全查）：'turn_segment' | 'turn_overview' | 'turn_date_summary'
 */
export async function retrieveTurnMemory(
  playerId: string,
  characterId: string,
  query: string,
): Promise<string | null> {
  // 这里 retrieveMemories 会全查该 player×character 的 embedding（含 chronicle/fact/turn_*）
  // 为聚焦场景记忆，先直接调用它；若需限定类型可再在 memory_embeddings 层加过滤。
  return retrieveMemories(playerId, characterId, query);
}

/**
 * 组装某角色在此刻应看到的三层记忆（热窗原文 + 中期摘要 + 长期总览）
 * 供 actor 上下文注入（导演另有导演版：见 assembleDirectorMemory）。
 */
export function assembleRoleMemory(opts: {
  sceneSessionId: string;
  playerId: string;
  characterId: string;
  hotWindowRounds: TurnLine[][];   // 最近 N 轮原文（热窗，逐字）
  playerName?: string;
}): { hot: string; mid: string; overview: string } {
  ensureTable();
  const playerName = opts.playerName ?? '玩家';
  const hot = opts.hotWindowRounds
    .flat()
    .map(t => `${t.role === 'player' ? playerName : t.role}：${t.text}${t.internal ? ` [内心：${t.internal}]` : ''}`)
    .join('\n');

  const midRows = db.prepare(`
    SELECT summary FROM turn_memory_fold
    WHERE player_id=? AND scene_session_id=? AND character_id=? AND fold_type='segment'
    ORDER BY round_min ASC
  `).all(opts.playerId, opts.sceneSessionId, opts.characterId) as { summary: string }[];

  const ovRow = db.prepare(`
    SELECT summary FROM turn_memory_fold
    WHERE player_id=? AND scene_session_id=? AND character_id=? AND fold_type='overview'
    ORDER BY created_at DESC LIMIT 1
  `).get(opts.playerId, opts.sceneSessionId, opts.characterId) as { summary: string } | undefined;

  return {
    hot,
    mid: midRows.map(r => r.summary).join('\n'),
    overview: ovRow?.summary ?? '',
  };
}

/**
 * 导演场记：每轮结束后，把导演这一轮的编排/氛围/走向折进导演场记摘要
 * （导演用完即弃，场末可再整体折成玩家可读的约会摘要——导演不跨场累积）
 */
export async function foldDirectorNote(opts: {
  sceneSessionId: string;
  playerId: string;
  directorSummary: string;       // 导演这一轮的编排/氛围/走向描述
}): Promise<void> {
  ensureTable();
  if (!opts.directorSummary.trim()) return;
  db.prepare(`
    INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, summary, created_at)
    VALUES (?, ?, ?, '__director__', 'segment', ?, ?)
  `).run(genId(), opts.playerId, opts.sceneSessionId, opts.directorSummary.trim(), now());
}

/** 读导演场记（供本场导演编排时参考本场氛围/走向；不跨场） */
export function assembleDirectorMemory(sceneSessionId: string, playerId: string): string {
  ensureTable();
  const rows = db.prepare(`
    SELECT summary FROM turn_memory_fold
    WHERE player_id=? AND scene_session_id=? AND character_id='__director__' AND fold_type='segment'
    ORDER BY created_at ASC
  `).all(playerId, sceneSessionId) as { summary: string }[];
  return rows.map(r => r.summary).join('\n');
}

/** 取长期总览（供 player 可读回顾 / 跨场 embedding） */
export function getOverview(sceneSessionId: string, characterId: string, playerId: string): string {
  ensureTable();
  const row = db.prepare(`
    SELECT summary FROM turn_memory_fold
    WHERE player_id=? AND scene_session_id=? AND character_id=? AND fold_type='overview'
    ORDER BY created_at DESC LIMIT 1
  `).get(playerId, sceneSessionId, characterId) as { summary: string } | undefined;
  return row?.summary ?? '';
}

// ─── 轮末统一更新（控制器）─────────────────────
//
// 三层（单位 = 轮，N=5 热窗 / I=12~M=15 中期 / 长期总览）:
//   - 热窗(≤N): 最近 N 轮原文（逐字，不折叠）
//   - 中期(N<I<M): 每个角色各生成"单轮事件摘要"，角色可见 N~M 这段
//   - 长期: 1 条滚动总览。到 M 边界时，把 I~M 这一批按角色各自折成的
//            segment，用"现有总览 + 这批摘要"增量刷新（不全量重生成）
//
// 由调用方在整轮完成后调用一次（轮是原子单位，可整体重说/撤回/继续）。

export interface TurnMemoryInput {
  sceneSessionId: string;
  playerId: string;
  roundNo: number;                 // 本轮序号（从 1 开始）
  playerName?: string;
  /// 每个在场角色的本轮回合片段（role='player' 的行归玩家，其余归该角色自己）
  characters: Array<{
    characterId: string;
    characterName: string;
    turns: TurnLine[];
  }>;
  directorSummary?: string;        // 导演这一轮的场记描述（可选）
  playerTurns?: TurnLine[];        // 玩家本轮的发言（归玩家记忆，无角色否定）
}

/**
 * 在整轮完成后调用一次。按轮号做三层折叠：
 *   roundNo <= N      → 进热窗（不折叠，返回 hot 层）
 *   N < roundNo <= M  → 每角色各折一 segment（异步，归属正确），进中期
 *   roundNo 触发 M 边界（roundNo % span==0 且 roundNo>=M）→ 把该批 I~M segment
 *                                                       增量刷新进长期总览
 * 返回各角色应看到的 memory（调用方注入 actor 上下文）。
 */
export async function runTurnMemoryUpdate(
  input: TurnMemoryInput,
  opts?: { sync?: boolean; onLog?: (s: string) => void },
): Promise<Map<string, { hot: string; mid: string; overview: string }>> {
  ensureTable();
  const log = opts?.onLog ?? (() => {});
  const { sceneSessionId, roundNo } = input;
  const N = HOT_WINDOW_N, M = MID_M, I = MID_I;
  const span = M - I;                       // 每次折叠的批宽

  const result = new Map<string, { hot: string; mid: string; overview: string }>();

  // 这一轮是否属于中期（要折成单轮摘要）？
  const inMid = roundNo > N;
  // 是否到 M 边界（该折叠 I~M 这一批进总览了）？
  const atMBoundary = roundNo >= M && roundNo % span === 0;

  const foldPromises: Promise<void>[] = [];

  for (const ch of input.characters) {
    // 热窗原文：本轮原文（供 actor 上下文；真实多轮热窗由调用方拼）
    const hotText = ch.turns.map(t => `${t.role === 'player' ? input.playerName ?? '玩家' : ch.characterName}：${t.text}`).join('\n');

    if (inMid) {
      // 每个角色各折自己的单轮摘要（归属正确，异步）
      foldPromises.push(foldTurnSegment({
        sceneSessionId, playerId: input.playerId, characterId: ch.characterId, characterName: ch.characterName,
        roundNo, turns: ch.turns, playerName: input.playerName,
      }));
    }

    // 读现有多层
    const mem = assembleRoleMemory({ sceneSessionId, playerId: input.playerId, characterId: ch.characterId, hotWindowRounds: [] });
    result.set(ch.characterId, { hot: hotText, mid: mem.mid, overview: mem.overview });
  }

  // 导演场记（每轮完成后折，异步）
  if (input.directorSummary) {
    foldPromises.push(foldDirectorNote({ sceneSessionId, playerId: input.playerId, directorSummary: input.directorSummary }));
  }

  if (opts?.sync) await Promise.all(foldPromises);
  else void Promise.all(foldPromises).catch(err =>
    console.error(`[turn-memory] 折叠失败 scene=${sceneSessionId}:`, err instanceof Error ? err.message : err),
  );

  // 到 M 边界 → 增量刷新长期总览（总览 + 本批 I~M segment → 新总览，不全量重生成）
  if (atMBoundary) {
    for (const ch of input.characters) {
      const mem = assembleRoleMemory({ sceneSessionId, playerId: input.playerId, characterId: ch.characterId, hotWindowRounds: [] });
      const ov = refreshOverview({
        sceneSessionId, playerId: input.playerId, characterId: ch.characterId, characterName: ch.characterName,
        newSegments: mem.mid ? mem.mid.split('\n') : [],
        existingOverview: mem.overview, playerName: input.playerName,
      });
      if (opts?.sync) await ov; else void ov.catch(err =>
        console.error(`[turn-memory] 总览刷新失败 scene=${sceneSessionId} char=${ch.characterId}:`, err instanceof Error ? err.message : err),
      );
    }
  }

  log(`[轮${roundNo}] 热窗=≤${N}轮原文; 中期=${inMid ? '折segment' : '否'}; 总览边界=${atMBoundary ? '增量刷新' : '否'}`);
  return result;
}

