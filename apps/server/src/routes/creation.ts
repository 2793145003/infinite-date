/**
 * 角色创建路由 — 系统引导式多轮对话
 * 玩家通过主神短信说"召唤新NPC"触发，AI按性格三层逐层引导提问
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { loadPrompt } from '../prompt/loader';
import { chat, tryParseJsonReply, type ChatMessage } from '../llm/adapter';
import type { CharacterData } from '@idate/shared';
import { searchCharacter } from '../lib/wiki-search';
import { spendPlayerPermission } from '../lib/permission';
import { getCosts } from '../lib/permission-config';

const CREATION_KEYWORDS = ['召唤新npc', '召唤npc', '创建角色', '新建角色', '召唤新角色'];

/**
 * guidedJson schema — 约束LLM输出合法JSON
 * prompt要求输出 { message, character_draft, ready }
 */
const CREATION_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    character_draft: { type: 'object' },
    ready: { type: 'boolean' },
  },
  required: ['message', 'character_draft', 'ready'],
};

// ─── 类型安全转换辅助 ─────────────────────────────────
function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => {
    if (typeof x === 'string') return x;
    if (typeof x === 'object' && x !== null) {
      const o = x as Record<string, unknown>;
      const item = String(o.item ?? '');
      const reason = String(o.reason ?? '');
      return reason ? `${item}（${reason}）` : item;
    }
    return String(x);
  });
}

function normalizeSpeechExamples(v: unknown): { context: string; line: string }[] {
  if (!Array.isArray(v)) return [];
  return v.map(item => {
    if (typeof item === 'string') return { context: '', line: item };
    if (typeof item === 'object' && item !== null) {
      const o = item as Record<string, unknown>;
      return { context: String(o.context ?? ''), line: String(o.line ?? '') };
    }
    return { context: '', line: String(item) };
  });
}

function normalizeMilestones(v: unknown): CharacterData['backstory_milestones'] {
  if (!Array.isArray(v)) return [];
  return v.map(item => {
    if (typeof item === 'string') {
      return { label: item, time_description: '', summary: '', diff: {}, dramatic_potential: 'medium' as const };
    }
    if (typeof item === 'object' && item !== null) {
      const o = item as Record<string, unknown>;
      const dp = o.dramatic_potential;
      return {
        label: String(o.label ?? ''),
        time_description: String(o.time_description ?? ''),
        summary: String(o.summary ?? ''),
        diff: (o.diff as Record<string, unknown>) ?? {},
        dramatic_potential: dp === 'high' || dp === 'low' ? dp : 'medium',
      };
    }
    return { label: String(item), time_description: '', summary: '', diff: {}, dramatic_potential: 'medium' as const };
  });
}

export function isCreationKeyword(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return CREATION_KEYWORDS.some(k => lower === k || lower.includes(k));
}

export async function creationRoutes(app: FastifyInstance): Promise<void> {

  // 开始/恢复创建会话
  app.post('/creation/start', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    // 检查是否已有进行中的创建会话
    const existing = db.prepare(
      "SELECT * FROM creator_sessions WHERE player_id = ? AND status = 'active'"
    ).get(playerId) as { id: string; draft_character: string; messages: string } | undefined;

    if (existing) {
      const draft = jsonParse(existing.draft_character, {});
      const messages = jsonParse<{ role: string; content: string }[]>(existing.messages, []);
      const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
      return reply.send({
        sessionId: existing.id,
        message: lastMsg?.content ?? '继续描述你的角色吧',
        draft,
      });
    }

    const sessionId = genId();
    const ts = now();
    db.prepare(
      'INSERT INTO creator_sessions (id, player_id, status, draft_character, draft_relationship, messages, search_results, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sessionId, playerId, 'active', '{}', '', '[]', '[]', ts, ts);

    // 用creation prompt生成第一句话
    const systemPrompt = loadPrompt('deity.creation.system');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '玩家点击了"召唤新NPC"按钮，开始创建流程。请说第一句话引导玩家——问玩家想召唤谁，可以是已有的角色名，也可以是原创角色。' },
    ];

    try {
      const result = await chat(messages, { temperature: 0.7, maxTokens: 2048, guidedJson: CREATION_SCHEMA });
      const parsed = tryParseJsonReply(result.content);

      let message = '你想邀请谁进入你的轮回？';
      let draft = {};

      if (parsed) {
        if (typeof parsed.message === 'string') message = parsed.message;
        if (parsed.character_draft && typeof parsed.character_draft === 'object') {
          draft = parsed.character_draft as Record<string, unknown>;
        }
      }

      // 更新session
      db.prepare(
        'UPDATE creator_sessions SET draft_character = ?, messages = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(draft), JSON.stringify([{ role: 'assistant', content: message }]), now(), sessionId);

      return reply.send({ sessionId, message, draft });
    } catch (err) {
      app.log.error({ err }, '创建会话启动失败');
      return reply.code(502).send({ error: '启动创建失败，请稍后重试' });
    }
  });

  // 发送对话（继续引导）
  app.post('/creation/:sessionId/chat', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { text } = req.body as { text?: string };

    if (!text?.trim()) {
      return reply.code(400).send({ error: '消息不能为空' });
    }

    const session = db.prepare(
      'SELECT * FROM creator_sessions WHERE id = ? AND player_id = ? AND status = ?'
    ).get(sessionId, playerId, 'active') as {
      id: string; draft_character: string; messages: string;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: '创建会话不存在或已结束' });
    }

    const history = jsonParse<{ role: string; content: string }[]>(session.messages, []);
    const draft = jsonParse<Record<string, unknown>>(session.draft_character, {});

    const systemPrompt = loadPrompt('deity.creation.system');
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      // 注入当前草稿让LLM知道已填了什么
      { role: 'system', content: `当前角色卡草稿：\n${JSON.stringify(draft, null, 2)}` },
    ];

    // 如果是第一轮玩家输入（history 只有 assistant 的开场白），尝试 wiki 搜索
    const isFirstPlayerMessage = history.length <= 1;
    if (isFirstPlayerMessage && text.trim().length <= 20) {
      try {
        const wikiResult = await searchCharacter(text.trim());
        if (wikiResult) {
          // 截取 wiki 内容（避免太长），注入为 system context
          const wikiContent = wikiResult.wikitext.slice(0, 4000);
          messages.push({
            role: 'system',
            content: `玩家说了"${text.trim()}"，我从 ${wikiResult.source} wiki 搜索到了这个角色的资料页面。\n` +
              `页面名：${wikiResult.name}\n` +
              `来源：${wikiResult.url}\n\n` +
              `以下是 wiki 页面的原始内容（wiki 标记格式），请基于这些真实资料提取角色信息，填充 character_draft 的所有字段：\n\n${wikiContent}\n\n` +
              `要求：基于上述 wiki 资料填充角色卡，不要凭空编造。wiki 中没有的字段留空。ready 设为 true。`,
          });
        }
      } catch (e) {
        console.warn('[creation] wiki search failed:', e);
      }
    }

    messages.push(
      ...history.map(m => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: m.content,
      })),
      { role: 'user', content: text.trim() },
    );

    try {
      const result = await chat(messages, { temperature: 0.75, maxTokens: 4096, guidedJson: CREATION_SCHEMA });
      const parsed = tryParseJsonReply(result.content);

      let message = '继续描述吧';
      let newDraft = draft;
      let ready = false;

      if (parsed) {
        if (typeof parsed.message === 'string') message = parsed.message;
        if (parsed.character_draft && typeof parsed.character_draft === 'object') {
          // 深 merge：LLM 每轮返回完整草稿，直接用 LLM 的版本替换
          newDraft = parsed.character_draft as Record<string, unknown>;
        }
        if (typeof parsed.ready === 'boolean') ready = parsed.ready;
      }

      // 更新session
      const updatedHistory = [...history, { role: 'user', content: text.trim() }, { role: 'assistant', content: message }];
      db.prepare(
        'UPDATE creator_sessions SET draft_character = ?, messages = ?, updated_at = ? WHERE id = ?'
      ).run(JSON.stringify(newDraft), JSON.stringify(updatedHistory), now(), sessionId);

      return reply.send({ message, draft: newDraft, ready });
    } catch (err) {
      app.log.error({ err }, '创建对话生成失败');
      return reply.code(502).send({ error: '回复生成失败，请稍后重试' });
    }
  });

  // 定稿：确认创建角色
  app.post('/creation/:sessionId/finalize', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { isPublic, draftOverride } = req.body as { isPublic?: boolean; draftOverride?: Record<string, unknown> };

    const session = db.prepare(
      'SELECT * FROM creator_sessions WHERE id = ? AND player_id = ? AND status = ?'
    ).get(sessionId, playerId, 'active') as {
      id: string; draft_character: string;
    } | undefined;

    if (!session) {
      return reply.code(404).send({ error: '创建会话不存在或已结束' });
    }

    // 玩家手动编辑的角色卡优先
    const draft = draftOverride ?? jsonParse<Record<string, unknown>>(session.draft_character, {});

    // 基本校验
    const name = String(draft.name ?? '').trim();
    if (!name) {
      return reply.code(400).send({ error: '角色名不能为空' });
    }

    const charData: CharacterData = {
      name,
      age: String(draft.age ?? ''),
      appearance: String(draft.appearance ?? ''),
      personality: {
        surface: String((draft.personality as Record<string, unknown>)?.surface ?? ''),
        core: String((draft.personality as Record<string, unknown>)?.core ?? ''),
        extreme: String((draft.personality as Record<string, unknown>)?.extreme ?? ''),
      },
      speechStyle: {
        description: String((draft.speechStyle as Record<string, unknown>)?.description ?? ''),
        examples: normalizeSpeechExamples((draft.speechStyle as Record<string, unknown>)?.examples),
      },
      textingStyle: {
        description: String((draft.textingStyle as Record<string, unknown>)?.description ?? ''),
        examples: normalizeStringArray((draft.textingStyle as Record<string, unknown>)?.examples),
      },
      background: {
        origin: String((draft.background as Record<string, unknown>)?.origin ?? ''),
        shaping: String((draft.background as Record<string, unknown>)?.shaping ?? ''),
        current: String((draft.background as Record<string, unknown>)?.current ?? ''),
      },
      emotional_signals: {
        nervous: String((draft.emotional_signals as Record<string, unknown>)?.nervous ?? ''),
        happy: String((draft.emotional_signals as Record<string, unknown>)?.happy ?? ''),
        angry: String((draft.emotional_signals as Record<string, unknown>)?.angry ?? ''),
        moved: String((draft.emotional_signals as Record<string, unknown>)?.moved ?? ''),
        defensive: String((draft.emotional_signals as Record<string, unknown>)?.defensive ?? ''),
      },
      likes: normalizeStringArray(draft.likes),
      dislikes: normalizeStringArray(draft.dislikes),
      boundaries: String(draft.boundaries ?? ''),
      goals: String(draft.goals ?? ''),
      quirks: String(draft.quirks ?? ''),
      backstory_milestones: normalizeMilestones(draft.backstory_milestones),
      player_relation: String(draft.player_relation ?? '').trim() || undefined,
      skills: String(draft.skills ?? '').trim() || undefined,
      ineptitudes: String(draft.ineptitudes ?? '').trim() || undefined,
      sleepType: draft.sleepType === 'night_owl' || draft.sleepType === 'normal' ? draft.sleepType : undefined,
      avatar: typeof draft.avatar === 'string' && draft.avatar ? draft.avatar : undefined,
    };

    const ts = now();
    const pub = isPublic !== false; // 默认公开

    // 消耗权限 + 全部建数据操作包在同一个事务里：任一步失败 ROLLBACK，扣费与数据一起回滚，不产生"白扣费/半成品"
    db.exec('BEGIN');
    try {
    // 消耗权限
    const cost = pub ? getCosts().create_public_npc : getCosts().create_private_npc;
    const spendResult = spendPlayerPermission(playerId, cost, 'create_npc');
    if (!spendResult.ok) {
      db.exec('ROLLBACK');
      return reply.code(403).send({ error: `权限不足（需要${cost}）` });
    }

    // 同名角色已存在则复用（fork机制：characters是公共模板，不重复创建）
    const existing = db.prepare(
      'SELECT id FROM characters WHERE json_extract(character_data, \'$.name\') = ? COLLATE NOCASE LIMIT 1'
    ).get(name) as { id: string } | undefined;
    const charId = existing?.id ?? genId();

    if (!existing) {
      db.prepare(
        'INSERT INTO characters (id, character_data, creator_player_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(charId, JSON.stringify(charData), playerId, ts, ts);
    }

    // 创建character_player_data（override或private）
    let cpdId: string;
    if (pub) {
      // 公共角色：同角色复用已有的player_data，更新内容
      const existingCpd = db.prepare(
        'SELECT id FROM character_player_data WHERE player_id = ? AND source_character_id = ?'
      ).get(playerId, charId) as { id: string } | undefined;
      if (existingCpd) {
        cpdId = existingCpd.id;
        db.prepare(
          'UPDATE character_player_data SET character_data = ?, updated_at = ? WHERE id = ?'
        ).run(JSON.stringify(charData), ts, cpdId);
      } else {
        cpdId = genId();
        db.prepare(
          'INSERT INTO character_player_data (id, source_character_id, player_id, character_data, is_free_override, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'
        ).run(cpdId, charId, playerId, JSON.stringify(charData), ts, ts);
      }
    } else {
      // 私有角色：source_character_id为NULL
      cpdId = genId();
      db.prepare(
        'INSERT INTO character_player_data (id, source_character_id, player_id, character_data, is_free_override, created_at, updated_at) VALUES (?, NULL, ?, ?, 0, ?, ?)'
      ).run(cpdId, playerId, JSON.stringify(charData), ts, ts);
    }

    // fork 同一角色时，清理旧的个人数据（保持单副本）
    if (existing) {
      db.prepare('DELETE FROM message_threads WHERE player_id = ? AND character_id = ?').run(playerId, charId);
      db.prepare('DELETE FROM friendships WHERE player_id = ? AND character_id = ?').run(playerId, charId);
      db.prepare('DELETE FROM relationships WHERE player_id = ? AND character_id = ?').run(playerId, charId);
      db.prepare('DELETE FROM character_instances WHERE player_id = ? AND source_character_id = ?').run(playerId, charId);
    }

    // 创建character_instance
    const instanceId = genId();
    db.prepare(
      'INSERT INTO character_instances (id, player_id, source_type, source_character_id, character_data_id, instance_no, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)'
    ).run(instanceId, playerId, pub ? 'override' : 'private', pub ? charId : null, cpdId, ts);

    // 创建relationship（角色存在于玩家世界，但还不是好友）
    const initDesc = charData.player_relation || '刚认识的陌生人';
    const relCharId = pub ? charId : cpdId;
    db.prepare(
      'INSERT OR IGNORE INTO relationships (id, player_id, character_id, player_description, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(genId(), playerId, relCharId, initDesc, ts);

    // 放到中央广场（创建的角色默认在中央广场，后续行程系统可动态调整）
    db.prepare(
      'INSERT OR IGNORE INTO location_npc_access (id, location_id, character_id, activity, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(genId(), 'plaza', relCharId, '在空旷的广场上发呆', ts);

    // 建家（与 db/index.ts 启动时建家逻辑一致：已有同名玩家地点则复用，否则新建系统家）
    {
      const hasHome = db.prepare('SELECT 1 FROM location_homes WHERE character_id = ?').get(relCharId);
      if (!hasHome) {
        const homeName = `${name}家`;
        // 已有同名玩家地点？加入 location_homes
        const existingHome = db.prepare(`SELECT id FROM locations WHERE name = ? AND creator_type = 'player'`).get(homeName) as { id: string } | undefined;
        if (existingHome) {
          db.prepare('INSERT OR IGNORE INTO location_homes (location_id, character_id, created_at) VALUES (?, ?, ?)').run(existingHome.id, relCharId, ts);
        } else {
          const homeId = `home-${relCharId}`;
          db.prepare(`
            INSERT OR IGNORE INTO locations (id, world_id, name, summary, creator_type, is_public, created_at)
            VALUES (?, 'default-world', ?, ?, 'player', 1, ?)
          `).run(homeId, homeName, `${name}的住所`, ts);
          db.prepare('INSERT OR IGNORE INTO location_homes (location_id, character_id, created_at) VALUES (?, ?, ?)').run(homeId, relCharId, ts);
        }
      }
    }

    // 标记创建会话完成
    db.prepare(
      'UPDATE creator_sessions SET status = ? WHERE id = ?'
    ).run('completed', sessionId);

    db.exec('COMMIT');

    return reply.send({
      characterId: pub ? charId : cpdId,
      characterName: name,
    });
    } catch (err) {
      // 任一步失败：整体回滚，扣费与数据一起还原，不产生"白扣费/半成品"
      try { db.exec('ROLLBACK'); } catch { /* 事务可能已不在 */ }
      app.log.error({ err }, '创建角色失败');
      return reply.code(500).send({ error: '创建角色失败，请重试' });
    }
  });

  // 取消创建
  app.post('/creation/:sessionId/cancel', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    db.prepare(
      'UPDATE creator_sessions SET status = ? WHERE id = ? AND player_id = ?'
    ).run('cancelled', sessionId, playerId);

    return reply.send({ ok: true });
  });
}
