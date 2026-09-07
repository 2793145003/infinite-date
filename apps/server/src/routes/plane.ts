/**
 * 位面任务（Plane Mission）路由
 *
 * 位面角色独立于主城 characters，存 plane_characters 表（见 lib/plane-schema.ts）。
 * 作者建卡 → 可选发布进公共池 → 玩家左右滑动刷池、进角色聊天（复用场景引擎）、
 * 完成剧情任务或好感满 100 即任务完成（advance 后自动发奖一次，会话不结束可继续聊）。
 *
 * 字段约定：
 * - summary：对外展示简介，不进聊天 prompt（公共池卡片 / 档案页给别人看）。
 * - persona：对内人设，进聊天 prompt；为空时自动复制 summary。
 * - greeting：开场白，可空（空则由聊天引擎 roll 生成）。
 * - goal：任务/目标描述；空 = 默认好感度型（好感到 100 完成）。
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { advanceScene, judgeStatsAndAmbient } from '../lib/scene-wiring';
import { applyStatsChanges } from './scene-scenario';
import { rollbackScene } from '../lib/scene-rollback';
import { getPlayerName } from '../lib/character';
import { expandPlaneText, normalizePlaneTokens } from '../lib/plane-wiring';
import { bumpPlanePlayCountIfFirstTalk } from '../lib/plane-playcount';
import { chat, chatJson, tryParseJsonReply } from '../llm/adapter';
import { getCosts } from '../lib/permission-config';
import { grantPlayerPermission } from '../lib/permission';

interface PlaneCharacterRow {
  id: string;
  creator_id: string;
  name: string;
  gender: string;
  summary: string;
  persona: string;
  greeting: string;
  avatar: string;
  appearance: string;
  goal: string;
  published: number;
  play_count: number;
  created_at: number;
  updated_at: number;
}

function toPlaneCharacter(row: PlaneCharacterRow) {
  return {
    id: row.id,
    name: row.name,
    gender: row.gender,
    summary: row.summary,
    persona: row.persona,
    greeting: row.greeting,
    avatar: row.avatar,
    appearance: row.appearance,
    goal: row.goal,
    published: !!row.published,
    playCount: row.play_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function planeRoutes(app: FastifyInstance): Promise<void> {
  // ── 建卡 ─────────────────────────────────────────────
  app.post('/plane/characters', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const body = (req.body ?? {}) as {
      name?: string; gender?: string; summary?: string; persona?: string;
      greeting?: string; avatar?: string; appearance?: string; goal?: string;
    };

    const name = (body.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: '名字不能为空' });

    const summary = (body.summary ?? '').trim();
    const persona = (body.persona ?? '').trim();
    // persona 空 → 复制 summary（对内对外都空则拒绝）
    const finalPersona = persona || summary;
    if (!finalPersona) return reply.code(400).send({ error: '对外简介（summary）或对内人设（persona）至少填一个' });

    const id = genId();
    const ts = now();
    db.prepare(
      `INSERT INTO plane_characters
        (id, creator_id, name, gender, summary, persona, greeting, avatar, appearance, goal, published, play_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, playerId, name,
      (body.gender ?? '').trim(),
      summary, finalPersona,
      (body.greeting ?? '').trim(),
      (body.avatar ?? '').trim(),
      (body.appearance ?? '').trim(),
      (body.goal ?? '').trim(),
      0, 0, ts, ts,
    );

    const row = db.prepare('SELECT * FROM plane_characters WHERE id = ?').get(id) as any;
    return reply.send({ character: toPlaneCharacter(row) });
  });

  // ── 列表 ─────────────────────────────────────────────
  // GET /plane/characters            → 我的角色
  // GET /plane/characters?published=1 → 公共池（第 6 步大厅用）
  app.get('/plane/characters', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { published } = req.query as { published?: string };
    if (published === '1') {
      const rows = db.prepare(
        'SELECT * FROM plane_characters WHERE published = 1 ORDER BY updated_at DESC',
      ).all() as any[];
      return reply.send({ characters: rows.map(toPlaneCharacter) });
    }

    const rows = db.prepare(
      'SELECT * FROM plane_characters WHERE creator_id = ? ORDER BY updated_at DESC',
    ).all(playerId) as any[];
    return reply.send({ characters: rows.map(toPlaneCharacter) });
  });

  // ── 编辑 ─────────────────────────────────────────────
  app.patch('/plane/characters/:id', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { id } = req.params as { id: string };

    const row = db.prepare(
      'SELECT * FROM plane_characters WHERE id = ? AND creator_id = ?',
    ).get(id, playerId) as any;
    if (!row) return reply.code(404).send({ error: '角色不存在或无权编辑' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const has = (k: string): boolean => typeof body[k] === 'string';
    const pick = (k: string): string => {
      if (has(k)) return String(body[k]).trim();
      return String((row as unknown as Record<string, string>)[k] ?? '');
    };

    const name = pick('name');
    const summary = pick('summary');
    let persona = pick('persona');
    const gender = pick('gender');
    const greeting = pick('greeting');
    const avatar = pick('avatar');
    const appearance = pick('appearance');
    const goal = pick('goal');

    // persona 空 → 复制 summary（无论是否显式清空）
    if (!persona) persona = summary;
    if (!name) return reply.code(400).send({ error: '名字不能为空' });
    if (!persona) return reply.code(400).send({ error: '对外简介（summary）或对内人设（persona）至少填一个' });

    db.prepare(
      'UPDATE plane_characters SET name=?, gender=?, summary=?, persona=?, greeting=?, avatar=?, appearance=?, goal=?, updated_at=? WHERE id=?',
    ).run(name, gender, summary, persona, greeting, avatar, appearance, goal, now(), id);

    const updated = db.prepare('SELECT * FROM plane_characters WHERE id = ?').get(id) as any;
    return reply.send({ character: toPlaneCharacter(updated) });
  });

  // ── 删除 ─────────────────────────────────────────────
  app.delete('/plane/characters/:id', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { id } = req.params as { id: string };

    const row = db.prepare(
      'SELECT id FROM plane_characters WHERE id = ? AND creator_id = ?',
    ).get(id, playerId);
    if (!row) return reply.code(404).send({ error: '角色不存在或无权删除' });

    db.prepare('DELETE FROM plane_characters WHERE id = ?').run(id);
    return reply.send({ ok: true });
  });

  // ── 发布 / 下架（toggle，或显式指定）─────────────────
  app.post('/plane/characters/:id/publish', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { id } = req.params as { id: string };
    const { published } = (req.body ?? {}) as { published?: boolean };

    const row = db.prepare(
      'SELECT id, published FROM plane_characters WHERE id = ? AND creator_id = ?',
    ).get(id, playerId) as any;
    if (!row) return reply.code(404).send({ error: '角色不存在或无权操作' });

    const target = published === undefined ? (row.published === 0 ? 1 : 0) : (published ? 1 : 0);
    db.prepare('UPDATE plane_characters SET published = ?, updated_at = ? WHERE id = ?').run(target, now(), id);
    return reply.send({ published: !!target });
  });

  // 鲁棒解析 LLM 输出的字符串数组（直接/```块/首[到末]/逐行引号四层兜底）
  const parseStringArray = (raw: string): string[] => {
    const pick = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    try {
      return pick(JSON.parse(raw));
    } catch {
      /* fall through */
    }
    const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (block?.[1]) {
      try {
        return pick(JSON.parse(block[1]));
      } catch {
        /* fall through */
      }
    }
    const first = raw.indexOf('[');
    const last = raw.lastIndexOf(']');
    if (first >= 0 && last > first) {
      try {
        return pick(JSON.parse(raw.slice(first, last + 1)));
      } catch {
        /* fall through */
      }
    }
    const out: string[] = [];
    for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = line.match(/["'“”]([^"'“”]{2,})["'“”]/);
      if (m?.[1]) out.push(m[1]);
    }
    return out;
  };

  // ── 开场白 roll（生成 3 个候选）────────────────────
  app.post('/plane/greetings/roll', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { name, gender, summary, persona } = (req.body ?? {}) as {
      name?: string; gender?: string; summary?: string; persona?: string;
    };
    const n = (name ?? '').trim() || '角色';
    const base = (persona ?? '').trim() || (summary ?? '').trim();
    const res = await chat([
      {
        role: 'system',
        content:
          '你是恋爱互动小说的开场白写手。根据角色设定写出 3 个不同的开场白。要求：①一句话、口语化、有画面感；②贴合角色人设与口吻；③直接对玩家说话，不带动作描述；④三条风格区分开（如俏皮/温柔/清冷）。只输出 JSON 字符串数组 ["...","...","..."]，不要任何解释。',
      },
      { role: 'user', content: `角色名：${n}${gender ? `\n性别：${gender}` : ''}${base ? `\n人设：${base}` : ''}` },
    ]);
    const arr = parseStringArray(res.content ?? '');
    return reply.send({ greetings: arr.slice(0, 3) });
  });

  // ── 根据其他字段生成外貌描述（独立功能）────────────
  app.post('/plane/appearance', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { name, gender, summary, persona } = (req.body ?? {}) as {
      name?: string; gender?: string; summary?: string; persona?: string;
    };
    const nameTrim = (name ?? '').trim();
    const summaryTrim = (summary ?? '').trim();
    const personaTrim = (persona ?? '').trim();
    const context = [
      nameTrim && `角色名：${nameTrim}`,
      gender && `性别：${gender === 'male' ? '男' : '女'}`,
      summaryTrim && `对外简介：${summaryTrim}`,
      personaTrim && `对内人设：${personaTrim}`,
    ].filter(Boolean).join('\n');
    if (!context.trim()) return reply.code(400).send({ error: '缺少生成外貌所需的字段' });

    const r = await chat(
      [
        {
          role: 'system',
          content: [
            '你是位面建卡助手。请根据角色已有的信息补一段外貌描述。',
            '约束：',
            '① 只写外貌（发型、瞳色、五官、体态、穿着、气质等），不写性格、身份、背景、剧情；',
            '② 贴合角色的性别、身份与气质，自然合理，不夸张、不堆砌；',
            '③ 用第三人称，人物称呼一律用 {{character_name}}；',
            '④ 2~4 句，纯中文，只输出外貌正文，不要任何解释、引号、前缀。',
          ].join('\n'),
        },
        { role: 'user', content: context },
      ],
      { callType: 'plane_appearance', playerId },
    );

    let text = normalizePlaneTokens((r?.content ?? '').trim());
    if (nameTrim && text) text = text.split(nameTrim).join('{{character_name}}');
    return reply.send({ appearance: text });
  });

  // ── 根据文本自动填表（忠实原文 + 转胶囊）────────────
  app.post('/plane/fill', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { text } = (req.body ?? {}) as { text?: string };
    const src = (text ?? '').trim();
    if (!src) return reply.code(400).send({ error: '缺少原文' });

    const FIELDS = ['name', 'gender', 'appearance', 'summary', 'persona', 'goal', 'greeting'] as const;
    type FillField = (typeof FIELDS)[number];
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: [...FIELDS],
      properties: {
        name: { type: 'string' },
        gender: { type: 'string' },
        appearance: { type: 'string' },
        summary: { type: 'string' },
        persona: { type: 'string' },
        goal: { type: 'string' },
        greeting: { type: 'string' },
      },
    };

    const res = await chatJson<Record<FillField, string>>(
      [
        {
          role: 'system',
          content: [
            '你是位面建卡助手。任务是把一段角色文案「原样搬进」表单字段——这是复制粘贴，不是总结、不是改写。',
            '铁律（最高优先级）：',
            '① 字段内容必须是原文原句，逐字照搬、一字不改。禁止概括、压缩、缩写、合并、删修饰语、删语气词（如「特别特别」「感觉」「其实」都要原样保留）、换同义词。',
            '② 去掉原文的口语标签词（「外貌的话」「外貌方面」「性格方面」「设定是」「人设」等），只保留标签后面的正文原文；但不要给正文添加原文没有的开头（如不要加「角色名是」「他」等前缀）。⚠️ 原文的分节标题（「角色简介」「性格特征」「扮演要点」「互动要点」「语言风格」「外貌」「开场白」等）必须原样保留、不要删、不要改，标题连同它下面的正文一起照搬。',
            '③ 唯一允许的改动：appearance/persona/goal 里，把原文明确出现的角色名/自称换成 {{character_name}}，把「你/您/玩家/主控」换成 {{player_name}}。代词「他/她/它」保持原文，不要替换。⚠️ summary（对外简介）例外：「你/您/玩家」保留原文「你」、不要换成 {{player_name}}（角色名仍换成 {{character_name}}）。',
            '④ 只填原文明确写到的内容，原文没提到的字段输出空字符串 ""，绝不编造、补写、扩写。',
            '⑤ 开场白 greeting 是角色说的话，原样照搬，不做任何胶囊转换。',
            '⑥ 除 {{character_name}} / {{player_name}} 占位符外，全程纯中文，禁止出现任何英文单词或字母（如 and、or、the），连接词一律用中文「和」「或」。',
            '',
            '字段对应关系（星野导出卡片有分节标题，按标题归位，禁止混字段）：',
            '- summary（对外简介）← 原文「# 对外简介」或「# 简介」这一整节，逐字照搬。它是给玩家看的第一印象/身份/背景/剧情，必须站在玩家角度、保留「你」的人称直接称呼玩家（「你/玩家」不要换成占位符）；角色名仍换成 {{character_name}}。没有这节时，才用原文里明确是「对外/给玩家看」的身份背景描述。',
            '- persona（对内人设）← 原文「核心设定」「详细人设」「背景经历」「性格特征」「扮演要点」「互动要点」「语言风格」「交互特点」等节，逐字照搬、一字不改（含隐藏设定，是 AI 演绎用的完整人设）。原文的分节标题（如「角色简介」「性格特征」「扮演要点」「互动要点」「语言风格」等）必须原样保留、不要删、不要改、不要合并，标题连同它下面的正文一起照搬。占位符规则同③（角色名→{{character_name}}，「你/玩家/主控」→{{player_name}}）。',
            '- appearance（外貌）← 原文「外貌」或「详细人设」里的外貌部分。',
            '- greeting（开场白）← 原文「# 开场白」这一整节。',
            '- goal（任务目标）← 原文明确写到「玩家/你要完成的任务」时才填（玩家视角的目标，如「你的目标是逃离这座祠堂」），否则 ""。角色自身的欲望/内驱力（如「永远不能失去你」）不是任务目标，归入 persona，不要填进 goal。',
            'name 填角色名；gender 只填 "male"/"female"（原文没写就 ""）。',
            '',
            '反例（禁止的简化）：',
            '原文「他有一头银灰色的短发，发丝柔软地垂落在额前，左眼正下方缀着一颗浅褐色的、几乎要隐入肤色的泪痣」',
            '✗ 错误「银灰色短发，左眼下有泪痣」← 这是简化，禁止',
            '✓ 正确「他有一头银灰色的短发，发丝柔软地垂落在额前，左眼正下方缀着一颗浅褐色的、几乎要隐入肤色的泪痣」← 逐字照搬',
            '',
            '再强调：即使原文很长，也必须逐字照搬整节，宁可字段很长，也不许概括、删减、只留大意。',
            '',
            '只输出 JSON 对象（键 name/gender/appearance/summary/persona/goal/greeting），不要任何解释。',
          ].join('\n'),
        },
        { role: 'user', content: `角色文案：\n\n${src}` },
      ],
      {
        schema,
        maxTokens: 4096,
        callType: 'plane_fill',
        playerId,
        normalize: (obj) => {
          const out = {} as Record<FillField, string>;
          for (const f of FIELDS) {
            const v = obj[f];
            out[f] = typeof v === 'string' ? normalizePlaneTokens(v).trim() : '';
          }
          const g = out.gender.toLowerCase();
          out.gender = g === 'male' || g === 'female' ? g : '';

          // 程序化兜底：角色名 → {{character_name}}（gemma 胶囊转换不稳定，漏转在这里补上）
          const charName = out.name.trim();
          if (charName) {
            for (const f of ['appearance', 'summary', 'persona', 'goal'] as const) {
              if (out[f]) out[f] = out[f].split(charName).join('{{character_name}}');
            }
          }

          // 程序化兜底：对内字段把「主控」换成 {{player_name}}（gemma 常漏转）
          for (const f of ['appearance', 'persona', 'goal'] as const) {
            if (out[f]) out[f] = out[f].split('主控').join('{{player_name}}');
          }

          // 程序化兜底：summary（对外简介）不应含 {{player_name}}，gemma 误转时换回「你」
          if (out.summary) out.summary = out.summary.split('{{player_name}}').join('你');

          // 程序化兜底：清洗滑落的英文连接词（gemma 偶把「和」写成 and）
          for (const f of FIELDS) {
            if (out[f]) out[f] = out[f].replace(/\band\b/g, '和').replace(/\bor\b/g, '或');
          }

          return out;
        },
      },
    );

    if (!res) return reply.code(502).send({ error: '填表失败，请重试' });
    return reply.send(res);
  });

  // ── 按字段润色 ──────────────────────────────
  app.post('/plane/polish', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { field, text, name, gender } = (req.body ?? {}) as {
      field?: string; text?: string; name?: string; gender?: string;
    };
    const src = (text ?? '').trim();
    if (!src) return reply.code(400).send({ error: '缺少文本' });

    const style: Record<string, string> = {
      appearance: '润色成有画面感的外貌描写，突出气质、穿着、神态',
      summary: '润色成吸引人的对外简介，让人想点进来看',
      persona: '润色成细腻、有层次的内在人设，便于 AI 演绎',
      goal: '润色成清晰、有戏剧张力的任务目标描述',
      greeting: '润色成口语化、贴合角色口吻的一句开场台词',
    };
    const fieldHint = style[field ?? ''] ?? '润色文笔，保持原意';

    const res = await chat(
      [
        {
          role: 'system',
          content: [
            '你是恋爱小说文案润色助手。',
            `任务：${fieldHint}。`,
            '约束：',
            '① 只润色文笔、语气、节奏，不改变原文设定、事实与剧情；',
            '② 保留占位符 {{player_name}} / {{character_name}} 原样不动；',
            '③ 长度与原文相当，不要大幅扩写；',
            '④ 只输出润色后的文本本身，不要任何解释、引号、前缀。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `${name ? `角色名：${name}\n` : ''}${gender ? `性别：${gender}\n` : ''}原文：\n\n${src}`,
        },
      ],
      { callType: 'plane_polish', playerId },
    );

    const polished = normalizePlaneTokens((res.content ?? '').trim());
    if (!polished) return reply.code(502).send({ error: '润色失败，请重试' });
    return reply.send({ polished });
  });

  // ── 进角色开会话（位面现场）────────────────────────────
  app.post('/plane/sessions', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { planeCharacterId } = (req.body ?? {}) as { planeCharacterId?: string };
    if (!planeCharacterId) return reply.code(400).send({ error: '缺少 planeCharacterId' });

    // 角色：公开池（任何人可玩）或自己的角色（自测）
    const pc = db.prepare('SELECT * FROM plane_characters WHERE id = ?').get(planeCharacterId) as any;
    if (!pc) return reply.code(404).send({ error: '角色不存在' });
    if (!pc.published && pc.creator_id !== playerId) return reply.code(403).send({ error: '角色未发布进池' });

    // 好感度数值：固定满值 100
    const statsConfig = [
      { name: '好感度', initial: 0, rules: '根据玩家与对方的互动质量判断好感度变化，满值 100。', target: 100 },
    ];
    const statsState = { '好感度': 0 };

    const ts = now();
    const sessionId = genId();
    db.prepare(
      `INSERT INTO scene_sessions
        (id, player_id, scene_type, character_ids, round_no, stats_state, stats_config, ended, goal, plane_character_id, created_at, updated_at)
       VALUES (?, ?, 'plane', ?, 0, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(
      sessionId, playerId, JSON.stringify([planeCharacterId]),
      JSON.stringify(statsState), JSON.stringify(statsConfig),
      (pc.goal ?? '').trim(), planeCharacterId, ts, ts,
    );

    // 开场白：有则写 0 轮 character 消息；空则由引擎首轮生成（可 roll）
    const greeting = expandPlaneText((pc.greeting ?? '').trim(), pc.name, getPlayerName(playerId));
    if (greeting) {
      db.prepare(
        `INSERT INTO scene_messages
          (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at)
         VALUES (?, ?, 0, 'character', ?, ?, ?, '{}', NULL, '', 0, ?)`,
      ).run(genId(), sessionId, planeCharacterId, pc.name, greeting, ts);
    }

    return reply.code(201).send({
      sessionId,
      planeCharacterId,
      characterName: pc.name,
      statsState,
      statsConfig,
      goal: expandPlaneText((pc.goal ?? '').trim(), pc.name, getPlayerName(playerId)),
      greeting,
      round: 0,
    });
  });

  // ── 推进一轮（SSE 复用场景引擎）──────────────────────
  app.post('/plane/sessions/:sessionId/advance', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const body = (req.body ?? {}) as { message?: string; quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string } };

    const sess = db.prepare('SELECT id, scene_type, plane_character_id FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!sess || sess.scene_type !== 'plane') return reply.code(404).send({ error: '位面会话不存在' });

    // 委托次数：玩家真正说过话（本条非空消息）才 +1，且每会话只计一次（进房/开场白自动推进不计）
    bumpPlanePlayCountIfFirstTalk(db, sessionId, sess.plane_character_id, body.message);

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'close');
    reply.hijack();
    const send = (data: unknown) => { try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ } };

    try {
      await planeTurn(playerId, sessionId, body.message, send, { quote: body.quote });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '推进失败' });
      raw.end();
    }
  });

  // ── 重试：回退到该轮开始前状态（保留玩家发言），重新生成一批回复 ──
  app.post('/plane/sessions/:sessionId/retry', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const sess = db.prepare('SELECT id, scene_type FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!sess || sess.scene_type !== 'plane') return reply.code(404).send({ error: '位面会话不存在' });

    const lastPlayer = db.prepare(
      "SELECT round_no FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1",
    ).get(sessionId) as { round_no: number } | undefined;
    if (!lastPlayer || lastPlayer.round_no < 1) return reply.code(400).send({ error: '没有可重试的内容' });

    // 回退该轮（保留玩家发言），随后 planeTurn 以 regenerate 重新生成「回应玩家上一条」
    const res = rollbackScene(playerId, sessionId, lastPlayer.round_no, true);
    if (!res.ok) return reply.code(400).send({ error: res.error ?? '重试失败' });

    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'close');
    reply.hijack();
    const send = (data: unknown) => { try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ } };

    try {
      await planeTurn(playerId, sessionId, undefined, send, { regenerate: true });
      raw.end();
    } catch (e: any) {
      send({ type: 'error', error: e?.message ?? '重试失败' });
      raw.end();
    }
  });

  // ── 撤回：回退到上一轮（删掉玩家最后发言所在轮，纯回退不涉及引擎）──
  app.post('/plane/sessions/:sessionId/undo', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const sess = db.prepare('SELECT id, scene_type FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!sess || sess.scene_type !== 'plane') return reply.code(404).send({ error: '位面会话不存在' });

    const lastPlayer = db.prepare(
      "SELECT round_no FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1",
    ).get(sessionId) as { round_no: number } | undefined;
    if (!lastPlayer) return reply.code(400).send({ error: '没有可撤回的消息' });

    let target = lastPlayer.round_no;
    if (target < 1) target = 1;
    const res = rollbackScene(playerId, sessionId, target);
    if (!res.ok) return reply.code(400).send({ error: res.error ?? '撤回失败' });
    return reply.send({ ok: true, round: res.targetRound });
  });

  // ── 结束位面会话（释放现场；不判定不发奖——发奖已在 advance 自动完成）──
  app.post('/plane/sessions/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const session = db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session || session.scene_type !== 'plane') return reply.code(404).send({ error: '位面会话不存在' });
    if (session.ended) return reply.code(400).send({ error: '会话已结束' });

    db.prepare('UPDATE scene_sessions SET ended = 1, updated_at = ? WHERE id = ?').run(Date.now(), sessionId);

    return reply.send({ ended: true });
  });

  // ── 删除位面聊天（物理删除，级联删消息；已发积分不重置）────────────
  app.delete('/plane/sessions/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const session = db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session || session.scene_type !== 'plane') return reply.code(404).send({ error: '位面会话不存在' });

    db.prepare('DELETE FROM scene_sessions WHERE id = ?').run(sessionId);

    return reply.send({ deleted: true });
  });

  // ── 读位面会话历史（前端「继续」恢复消息流）────────────
  app.get('/plane/sessions/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };

    const session = db.prepare('SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session || session.scene_type !== 'plane') return reply.code(404).send({ error: '位面会话不存在' });

    const messages = db.prepare(
      'SELECT id, round_no, role, character_id, character_name, text, quote, internal, internal_notable FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no ASC, created_at ASC',
    ).all(sessionId) as any[];

    const pc = db.prepare('SELECT name, avatar, goal FROM plane_characters WHERE id = ?').get(session.plane_character_id) as any;
    const statsState = jsonParse(session.stats_state ?? '{}', {}) as Record<string, number>;

    return reply.send({
      sessionId: session.id,
      planeCharacterId: session.plane_character_id,
      characterName: pc?.name ?? '（已删除）',
      avatar: pc?.avatar ?? '',
      goal: pc?.goal ?? '',
      statsState,
      round: session.round_no,
      ended: !!session.ended,
      messages,
    });
  });

  // ── 三页签：任务大厅（公共池卡片流）───────────────
  app.get('/plane/pool', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { exclude } = req.query as { exclude?: string };
    const excludeIds = (exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean);

    let rows = db.prepare('SELECT * FROM plane_characters WHERE published = 1 ORDER BY play_count DESC, updated_at DESC').all() as any[];
    if (excludeIds.length > 0) {
      const ex = new Set(excludeIds);
      rows = rows.filter((r) => !ex.has(r.id));
    }

    // 该玩家已完成的角色（拿过奖励）
    const doneRows = db.prepare("SELECT DISTINCT source_id FROM permission_transactions WHERE player_id = ? AND reason = '位面任务奖励'").all(playerId) as any[];
    const done = new Set(doneRows.map((r: any) => r.source_id));

    const playerName = getPlayerName(playerId);
    const pool = rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      gender: r.gender,
      summary: expandPlaneText(r.summary ?? '', r.name, playerName),
      greeting: expandPlaneText(r.greeting ?? '', r.name, playerName),
      avatar: r.avatar,
      playCount: r.play_count,
      goal: expandPlaneText(r.goal ?? '', r.name, playerName),
      goalPreview: r.goal ? expandPlaneText(r.goal, r.name, playerName) : '好感度达到 100 即完成',
      completed: done.has(r.id),
    }));
    return reply.send({ pool });
  });

  // ── 三页签：任务列表（?active=1 进行中 / 默认历史）──
  app.get('/plane/sessions', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { active } = req.query as { active?: string };

    const where = active === '1' ? "scene_type = 'plane' AND ended = 0" : "scene_type = 'plane'";
    const rows = db.prepare(`SELECT * FROM scene_sessions WHERE player_id = ? AND ${where} ORDER BY updated_at DESC`).all(playerId) as any[];

    const sessions = rows.map((s: any) => {
      const pc = db.prepare('SELECT name, avatar, goal FROM plane_characters WHERE id = ?').get(s.plane_character_id) as any;
      const statsState = jsonParse(s.stats_state ?? '{}', {}) as Record<string, number>;
      return {
        sessionId: s.id,
        planeCharacterId: s.plane_character_id,
        characterName: pc?.name ?? '（已删除）',
        avatar: pc?.avatar ?? '',
        goal: pc?.goal ?? '',
        affection: Number(statsState['好感度'] ?? 0),
        round: s.round_no,
        ended: !!s.ended,
        goalAchieved: !!s.goal_achieved,
        updatedAt: s.updated_at,
      };
    });
    return reply.send({ sessions });
  });
}

/**
 * 位面剧情型完成判定：LLM 根据对话历史判断玩家是否完成了 goal。
 */
async function judgePlaneGoal(playerId: string, sessionId: string, goal: string): Promise<boolean> {
  const msgs = db.prepare(
    "SELECT role, character_name, text FROM scene_messages WHERE scene_session_id = ? AND role != 'narration' ORDER BY round_no, created_at",
  ).all(sessionId) as any[];

  if (msgs.length === 0) return false;

  const transcript = msgs
    .map((m) => `${m.role === 'player' ? '玩家' : m.character_name}：${m.text ?? ''}`)
    .join('\n')
    .slice(-4000);

  const res = await chat(
    [
      { role: 'system', content: '你是互动小说的剧情完成度判定器。根据对话记录判断玩家是否完成了给定剧情目标。只输出 JSON：{"completed": true 或 false, "reason": "一句理由"}。' },
      { role: 'user', content: `剧情目标：${goal}\n\n对话记录：\n${transcript}\n\n玩家是否完成了这个目标？` },
    ],
    { temperature: 0.2, maxTokens: 200, callType: 'plane-goal-judge', sessionId, playerId },
  );

  const parsed = tryParseJsonReply(res.content);
  if (parsed && typeof parsed.completed === 'boolean') return parsed.completed;
  // 兜底：正则匹配 "completed": true
  return /"completed"\s*:\s*true/i.test(res.content);
}

/**
 * 位面回合：引擎逐拍 + 好感度判定 + 数值变动 + 目标达成 + done。
 * advance 与 retry 共用；retry 已 rollbackScene(keepPlayer) 后玩家消息从 DB 读，故 playerMsg 可 undefined。
 */
async function planeTurn(
  playerId: string,
  sessionId: string,
  playerMsg: string | undefined,
  send: (data: unknown) => void,
  opts?: { quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string }; regenerate?: boolean },
): Promise<void> {
  // 1) 引擎跑一轮（plane 分支已在 scene-wiring 里）
  const result = await advanceScene(playerId, sessionId, playerMsg, {
    quote: opts?.quote,
    engine: 'named',
    regenerate: opts?.regenerate,
    onBeat: (b) => send({
      type: 'beat',
      beat: {
        kind: b.kind,
        speaker: b.speaker ?? (b.kind === 'character' ? undefined : '旁白'),
        content: b.content,
        characterId: b.characterId,
        internal: b.internal,
        internalNotable: b.internalNotable,
      },
    }),
  });

  // 2) 好感度判定（位面 NPC 身份 = 角色 persona）
  const session = db.prepare('SELECT stats_config, stats_state, ambient_config, revealed_clues, plane_character_id, goal FROM scene_sessions WHERE id = ?').get(sessionId) as any;
  const statsConfig = jsonParse(session?.stats_config ?? '[]', []);
  const statsBefore = jsonParse(session?.stats_state ?? '{}', {});
  const ambientConfig = session?.ambient_config ?? '';
  const revealedBefore = jsonParse(session?.revealed_clues ?? '[]', []);

  const pc = db.prepare('SELECT name, persona, appearance FROM plane_characters WHERE id = ?').get(session?.plane_character_id) as any;
  const npcIdentities = pc ? `· ${pc.name} = 人设：${expandPlaneText(pc.persona, pc.name, getPlayerName(playerId))}${pc.appearance ? `，外貌：${expandPlaneText(pc.appearance, pc.name, getPlayerName(playerId))}` : ''}` : '';

  // 玩家消息文本：显式传入优先；否则（重试空推）读 DB 最后一条玩家消息
  const effPlayerMsg = (playerMsg && playerMsg.trim())
    ? playerMsg
    : (db.prepare("SELECT text FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1").get(sessionId) as any)?.text ?? '';
  const npcReply = result.output
    .filter((o: any) => o.kind === 'character')
    .map((o: any) => `${o.speaker}：${o.content}`)
    .join('\n');

  const judgeResult = await judgeStatsAndAmbient(
    statsConfig, statsBefore, effPlayerMsg, npcReply, ambientConfig, sessionId, npcIdentities, playerId,
  );

  // 3) 应用数值变动（delta + clamp [0,100]）
  const { newStatsState, statsChangesOverall } = applyStatsChanges(
    sessionId, 'plane', statsConfig, statsBefore, revealedBefore, judgeResult, result.roundNo, send,
  );

  // 4) 目标达成 + 自动发奖（无「结束」：达成即发奖一次，会话继续可聊，不置 ended）
  let reward = 0;
  let goalAchievedNow = false;
  let goalReasonNow = judgeResult.goalReason || '';
  const alreadyGrantedRow = db.prepare(
    "SELECT id FROM permission_transactions WHERE player_id = ? AND source_id = ? AND reason = '位面任务奖励' LIMIT 1",
  ).get(playerId, session.plane_character_id);
  if (((session?.goal ?? '') as string).trim()) {
    // 剧情型：LLM 判 goal 文本（已发奖则跳过判定，省 token）
    goalAchievedNow = alreadyGrantedRow ? true : await judgePlaneGoal(playerId, sessionId, ((session.goal ?? '') as string).trim());
    if (goalAchievedNow) goalReasonNow = goalReasonNow || '剧情目标已达成';
  } else {
    // 好感度型：好感满 100（纯数值比较，不靠 LLM）
    goalAchievedNow = Number(newStatsState['好感度'] ?? 0) >= 100;
    if (goalAchievedNow) goalReasonNow = goalReasonNow || '好感度已满';
  }

  if (goalAchievedNow) {
    db.prepare('UPDATE scene_sessions SET goal_achieved = 1, updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
    if (!alreadyGrantedRow) {
      reward = getCosts().plane_mission_reward;
      grantPlayerPermission(playerId, reward, '位面任务奖励', session.plane_character_id);
    }
  }

  // 5) done
  send({
    type: 'done',
    sessionId: result.sessionId,
    round: result.roundNo,
    stats: newStatsState,
    statsChanges: statsChangesOverall,
    statsChangeReasons: judgeResult.changes.map((c) => ({ name: c.name, reason: c.reason })),
    ambient: judgeResult.ambient,
    goalAchieved: goalAchievedNow,
    goalReason: goalReasonNow,
    reward,
    locationName: result.locationName,
  });
}
