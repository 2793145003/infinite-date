/**
 * 地点探索路由
 *
 * 进入地点 → 程序掷骰决定是否偶遇（ENCOUNTER_RATE）
 *   偶遇 → 随机选NPC → LLM写环境描写（含NPC出现）→ 创建conversation_session + greeting
 *   不偶遇 → 创建explore_session → LLM写纯环境描写 → 多轮自由交互
 *
 * 探索中不再触发偶遇。物品发现由LLM根据玩家行为自然决定。
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { getActiveLiveSlot } from '../lib/session-mutex';
import { genId, now } from '../lib/util';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import { formatCurrentTime } from '../prompt/builder';
import { embed, storeEmbedding } from '../lib/embedding';
import { generateGreeting } from './conversation';
import { DEITY_ID } from '@idate/shared';

// ─── 常量 ──────────────────────────────────────────────

/** 偶遇概率 */
const ENCOUNTER_RATE = 0.3;

// ─── 类型 ──────────────────────────────────────────────

interface NpcInfo {
  id: string;
  name: string;
  appearance: string;
  isKnown: boolean;
}

// ─── 辅助函数 ──────────────────────────────────────────

/** 获取地点的子地点文本 */
function getLocationChildren(locationId: string): string {
  const children = db.prepare(`
    SELECT name, summary FROM locations
    WHERE parent_id = ? AND character_instance_id IS NULL
    ORDER BY name
  `).all(locationId) as { name: string; summary: string }[];
  if (children.length === 0) return '';
  return '子地点：\n' + children.map(c => `- ${c.name}${c.summary ? `：${c.summary}` : ''}`).join('\n');
}

/** 获取玩家认识的所有NPC（有relationship的） */
function getKnownNpcs(playerId: string): NpcInfo[] {
  const rows = db.prepare(`
    SELECT DISTINCT r.character_id as id,
      COALESCE(
        (SELECT json_extract(character_data, '$.name') FROM characters WHERE id = r.character_id),
        (SELECT json_extract(character_data, '$.name') FROM character_player_data WHERE id = r.character_id)
      ) as name,
      COALESCE(
        (SELECT json_extract(character_data, '$.appearance') FROM characters WHERE id = r.character_id),
        (SELECT json_extract(character_data, '$.appearance') FROM character_player_data WHERE id = r.character_id)
      ) as appearance
    FROM relationships r
    WHERE r.player_id = ?
  `).all(playerId) as { id: string; name: string | null; appearance: string | null }[];
  return rows
    .filter(r => r.id !== DEITY_ID && r.name)
    .map(r => ({ id: r.id, name: r.name!, appearance: r.appearance ?? '', isKnown: true }));
}

/** 获取玩家不认识的公共NPC（有relationship的不重复） */
function getUnknownNpcs(playerId: string): NpcInfo[] {
  const knownIds = new Set(
    (db.prepare('SELECT character_id FROM relationships WHERE player_id = ?').all(playerId) as Array<{ character_id: string }>)
      .map(r => r.character_id)
  );

  const allChars = db.prepare(`
    SELECT id, json_extract(character_data, '$.name') as name,
           json_extract(character_data, '$.appearance') as appearance
    FROM characters
  `).all() as { id: string; name: string | null; appearance: string | null }[];

  return allChars
    .filter(c => !knownIds.has(c.id) && c.id !== DEITY_ID && c.name)
    .map(c => ({ id: c.id, name: c.name!, appearance: c.appearance ?? '', isKnown: false }));
}

/** 随机选一个NPC用于偶遇 */
function pickRandomNpc(npcs: NpcInfo[]): NpcInfo | null {
  if (npcs.length === 0) return null;
  return npcs[Math.floor(Math.random() * npcs.length)] ?? null;
}

/** 获取已通过探索发现的物品facts（避免重复发现） */
function getFoundItems(playerId: string): string[] {
  const rows = db.prepare(`
    SELECT fact FROM player_facts WHERE player_id = ? AND source = 'exploration'
  `).all(playerId) as { fact: string }[];
  return rows.map(r => r.fact);
}

/** 写入发现的物品到player_facts + 向量化 */
async function recordFoundItem(
  playerId: string,
  ownerCharacterId: string,
  factText: string,
): Promise<void> {
  const factId = genId();
  const ts = now();
  db.prepare(`
    INSERT INTO player_facts (id, player_id, character_id, character_instance_id, fact, source, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'exploration', ?, ?)
  `).run(factId, playerId, ownerCharacterId, factText, ts, ts);

  const vec = await embed(factText);
  if (vec) {
    storeEmbedding(playerId, ownerCharacterId, 'fact', factId, factText, vec);
  }
}

/** LLM JSON schema — 探索场景描写（偶遇/纯探索共用） */
const NARRATION_SCHEMA = {
  type: 'object',
  properties: {
    narration: { type: 'string' },
    found_item_owner_id: { type: 'string' },
    found_item_owner_name: { type: 'string' },
    found_item_description: { type: 'string' },
    found_item_fact: { type: 'string' },
  },
  required: ['narration', 'found_item_owner_id', 'found_item_description', 'found_item_fact'],
};

// ─── 路由 ──────────────────────────────────────────────

export async function exploreRoutes(app: FastifyInstance): Promise<void> {

  // ─── 进入地点探索 ───────────────────────────────────

  app.post('/explore', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { locationId } = req.body as { locationId?: string };
    if (!locationId) {
      return reply.code(400).send({ error: '需要locationId' });
    }

    // 校验地点（只允许公开地点，或玩家自己创建的地点 —— 防止探索他人私有地点）
    const loc = db.prepare(`
      SELECT id, name, summary FROM locations
      WHERE id = ? AND character_instance_id IS NULL
        AND (is_public = 1 OR (creator_type = 'player' AND creator_id = ?))
    `).get(locationId, playerId) as { id: string; name: string; summary: string } | undefined;
    if (!loc) {
      return reply.code(404).send({ error: '地点不存在' });
    }

    // 全局现场互斥：人只有一个，同一时间只能"在场"于一个玩法现场。
    // 旧探索算现场；新探索（scene-explore）纯内存不算，天然不在此列。
    const live = getActiveLiveSlot(playerId);
    if (live) {
      return reply.code(409).send({ error: '已有进行中的现场', live });
    }

    // ── 掷骰：是否偶遇 ────────────────────────────────
    const knownNpcs = getKnownNpcs(playerId);
    const unknownNpcs = getUnknownNpcs(playerId);
    const allNpcs = [...knownNpcs, ...unknownNpcs];

    let encounterNpc: NpcInfo | null = null;
    if (allNpcs.length > 0 && Math.random() < ENCOUNTER_RATE) {
      encounterNpc = pickRandomNpc(allNpcs);
    }

    const foundItems = getFoundItems(playerId);
    const children = getLocationChildren(locationId);
    const systemPrompt = renderPrompt(loadPrompt('explore.system'), {
      location_name: loc.name,
      location_summary: loc.summary,
      location_children: children,
      current_time: formatCurrentTime(),
      found_items: foundItems.length > 0 ? foundItems.map(f => `- ${f}`).join('\n') : '（无）',
    });

    // 根据是否偶遇，给LLM不同的user message
    let userMessage: string;
    if (encounterNpc) {
      const npcDesc = encounterNpc.isKnown
        ? encounterNpc.name
        : `一个你不认识的人（外貌：${encounterNpc.appearance || '未知'}）`;
      userMessage = `玩家走进了${loc.name}。描写这里的环境。${npcDesc}恰好经过这里——把这个人自然地融入环境描写中（路过、在远处出现等），但不要替这个人说话，也不要描述玩家的反应。`;
    } else {
      userMessage = `玩家走进了${loc.name}。描写这里的环境。`;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    let llmResult: { narration: string; found_item_owner_id: string; found_item_owner_name: string; found_item_description: string; found_item_fact: string };
    try {
      const result = await chat(messages, {
        temperature: 0.85,
        maxTokens: 1024,
        guidedJson: NARRATION_SCHEMA,
        playerId,
      });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed) throw new Error('探索场景生成解析失败');
      llmResult = parsed as unknown as typeof llmResult;
    } catch (err) {
      app.log.error({ err }, '探索场景生成失败');
      return reply.code(502).send({ error: '探索场景生成失败，请重试' });
    }

    // 处理物品发现（found_item_owner_id 非空 = 发现了物品）
    const foundItem = llmResult.found_item_owner_id?.trim()
      ? { owner_character_id: llmResult.found_item_owner_id, owner_name: llmResult.found_item_owner_name || '', item_description: llmResult.found_item_description, fact_text: llmResult.found_item_fact }
      : null;
    if (foundItem) {
      await recordFoundItem(playerId, foundItem.owner_character_id, foundItem.fact_text);
    }

    // ── 偶遇 → 创建约会session ────────────────────────
    if (encounterNpc) {
      try {
        const npc = encounterNpc;
      const encounterContext = npc.isKnown
        ? `你们刚在${loc.name}偶遇——${npc.name}恰好经过`
        : `你们刚在${loc.name}偶遇——你注意到${npc.appearance || '一个人'}恰好经过`;

      const sessionId = genId();
      const ts = now();
      db.prepare(`
        INSERT INTO conversation_sessions (id, player_id, character_id, location_id, mode, summary, ended, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'chat', '', 0, ?, ?)
      `).run(sessionId, playerId, npc.id, locationId, ts, ts);

      // 创建/更新relationship
      const existingRel = db.prepare('SELECT id FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, npc.id);
      const isFirstMeeting = !existingRel;
      if (isFirstMeeting) {
        db.prepare(`
          INSERT INTO relationships (id, player_id, character_id, player_description, updated_at, created_at)
          VALUES (?, ?, ?, '刚认识的陌生人', ?, ?)
        `).run(genId(), playerId, npc.id, ts, ts);
      } else {
        db.prepare('UPDATE relationships SET updated_at = ? WHERE player_id = ? AND character_id = ?').run(ts, playerId, npc.id);
      }

      // 生成greeting（注入偶遇上下文）
      let greeting;
      try {
        greeting = await generateGreeting(sessionId, playerId, npc.id, locationId, 'talk', encounterContext, isFirstMeeting);
      } catch (err) {
        app.log.error({ err }, '偶遇greeting生成失败，回滚session');
        db.prepare('DELETE FROM conversation_sessions WHERE id = ?').run(sessionId);
        return reply.code(502).send({ error: 'NPC开场白生成失败，请重试' });
      }

      if (!greeting) {
        db.prepare('DELETE FROM conversation_sessions WHERE id = ?').run(sessionId);
        return reply.code(502).send({ error: 'NPC开场白生成失败，请重试' });
      }

      for (let i = 0; i < greeting.messages.length; i++) {
        const msg = String(greeting.messages[i] ?? '');
        const internal = i === 0 ? String(greeting.internal ?? '') : '';
        const internalNotable = i === 0 && greeting.internal_notable ? 1 : 0;
        db.prepare(`
          INSERT INTO messages (id, session_id, role, text, metadata, internal, internal_notable, internal_viewed, created_at)
          VALUES (?, ?, 'assistant', ?, '{}', ?, ?, 0, ?)
        `).run(genId(), sessionId, msg, internal, internalNotable, now());
      }
      db.prepare('UPDATE conversation_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

      return reply.send({
        type: 'encounter',
        sessionId,
        characterId: npc.id,
        characterName: npc.isKnown ? npc.name : '???',
        isKnown: npc.isKnown,
        narration: llmResult.narration,
        greeting: {
          messages: greeting.messages,
          internal: greeting.internal,
          internal_notable: greeting.internal_notable,
        },
        foundItem: foundItem ? {
          ownerName: foundItem.owner_name || '???',
          itemDescription: foundItem.item_description,
        } : null,
      });
      } catch (err) {
        app.log.error({ err, npcId: encounterNpc?.id, isKnown: encounterNpc?.isKnown }, '偶遇流程异常');
        return reply.code(502).send({ error: '偶遇流程异常，请重试' });
      }
    }

    // ── 纯探索 → 创建explore_session ──────────────────
    const exploreSessionId = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO explore_sessions (id, player_id, location_id, ended, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(exploreSessionId, playerId, locationId, ts, ts);

    db.prepare(`
      INSERT INTO explore_messages (id, explore_session_id, role, text, metadata, created_at)
      VALUES (?, ?, 'narration', ?, '{}', ?)
    `).run(genId(), exploreSessionId, llmResult.narration, now());

    return reply.send({
      type: 'explore',
      exploreSessionId,
      locationId,
      locationName: loc.name,
      narration: llmResult.narration,
      foundItem: foundItem ? {
        ownerName: foundItem.owner_name || '???',
        itemDescription: foundItem.item_description,
      } : null,
    });
  });

  // ─── 探索中行动（多轮） ─────────────────────────────

  app.post('/explore/:sessionId/act', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { text } = req.body as { text?: string };

    if (!text?.trim()) {
      return reply.code(400).send({ error: '行为不能为空' });
    }

    const session = db.prepare(`
      SELECT id, location_id FROM explore_sessions WHERE id = ? AND player_id = ? AND ended = 0
    `).get(sessionId, playerId) as { id: string; location_id: string } | undefined;

    if (!session) {
      return reply.code(404).send({ error: '探索不存在或已结束' });
    }

    // 存玩家输入
    db.prepare(`
      INSERT INTO explore_messages (id, explore_session_id, role, text, metadata, created_at)
      VALUES (?, ?, 'player', ?, '{}', ?)
    `).run(genId(), sessionId, text.trim(), now());

    const loc = db.prepare('SELECT name, summary FROM locations WHERE id = ?').get(session.location_id) as
      { name: string; summary: string } | undefined;
    if (!loc) {
      return reply.code(500).send({ error: '地点数据缺失' });
    }

    // 获取对话历史
    const history = db.prepare(`
      SELECT role, text FROM explore_messages
      WHERE explore_session_id = ? AND created_at < ?
      ORDER BY created_at ASC
    `).all(sessionId, now()) as Array<{ role: string; text: string }>;

    const foundItems = getFoundItems(playerId);
    const systemPrompt = renderPrompt(loadPrompt('explore.continue'), {
      location_name: loc.name,
      location_summary: loc.summary,
      current_time: formatCurrentTime(),
      found_items: foundItems.length > 0 ? foundItems.map(f => `- ${f}`).join('\n') : '（无）',
    });

    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({
        role: (h.role === 'player' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: h.text,
      })),
    ];

    let llmResult: { narration: string; found_item_owner_id: string; found_item_owner_name: string; found_item_description: string; found_item_fact: string };
    try {
      const result = await chat(chatMessages, {
        temperature: 0.85,
        maxTokens: 768,
        guidedJson: NARRATION_SCHEMA,
        playerId,
      });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed) throw new Error('探索反馈解析失败');
      llmResult = parsed as unknown as typeof llmResult;
    } catch (err) {
      app.log.error({ err }, '探索反馈生成失败');
      return reply.code(502).send({ error: '探索反馈生成失败' });
    }

    const foundItem = llmResult.found_item_owner_id?.trim()
      ? { owner_character_id: llmResult.found_item_owner_id, owner_name: llmResult.found_item_owner_name || '', item_description: llmResult.found_item_description, fact_text: llmResult.found_item_fact }
      : null;
    if (foundItem) {
      await recordFoundItem(playerId, foundItem.owner_character_id, foundItem.fact_text);
    }

    const metadata = foundItem ? JSON.stringify({ found_item: true }) : '{}';
    db.prepare(`
      INSERT INTO explore_messages (id, explore_session_id, role, text, metadata, created_at)
      VALUES (?, ?, 'narration', ?, ?, ?)
    `).run(genId(), sessionId, llmResult.narration, metadata, now());

    db.prepare('UPDATE explore_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

    return reply.send({
      narration: llmResult.narration,
      foundItem: foundItem ? {
        ownerName: foundItem.owner_name || '???',
        itemDescription: foundItem.item_description,
      } : null,
    });
  });

  // ─── 结束探索 ───────────────────────────────────────

  app.post('/explore/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare(`
      SELECT id FROM explore_sessions WHERE id = ? AND player_id = ? AND ended = 0
    `).get(sessionId, playerId);

    if (!session) {
      return reply.code(404).send({ error: '探索不存在或已结束' });
    }

    db.prepare('UPDATE explore_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(now(), sessionId);
    return reply.send({ ok: true });
  });

  // ─── 获取进行中的探索 ───────────────────────────────

  app.get('/explore/active', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const session = db.prepare(`
      SELECT es.id, es.location_id, l.name as location_name
      FROM explore_sessions es
      JOIN locations l ON es.location_id = l.id
      WHERE es.player_id = ? AND es.ended = 0
    `).get(playerId) as { id: string; location_id: string; location_name: string } | undefined;

    if (!session) {
      return reply.send({ session: null });
    }

    const messages = db.prepare(`
      SELECT id, role, text, created_at FROM explore_messages
      WHERE explore_session_id = ? ORDER BY created_at ASC
    `).all(session.id) as Array<{ id: string; role: string; text: string; created_at: number }>;

    return reply.send({
      session: {
        id: session.id,
        locationId: session.location_id,
        locationName: session.location_name,
        messages,
      },
    });
  });
}
