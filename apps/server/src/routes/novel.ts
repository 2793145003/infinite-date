/**
 * 互动小说路由 — 共写引擎
 *
 * 玩家创建小说（设定 + 角色 + 开场），进入后与 AI 接力写正文。
 * 角色隔离在小说内，永不进约会系统。
 *
 * 路由：
 *  POST   /novel                                      创建小说
 *  GET    /novel                                      小说列表（?mine=1 我的）
 *  GET    /novel/detail/:novelId                      小说详情（含角色）
 *  PATCH  /novel/detail/:novelId                      更新小说字段
 *  DELETE /novel/detail/:novelId                      删除小说
 *  POST   /novel/detail/:novelId/roll                 Roll 单字段（world_setting / protagonist_setting）
 *  POST   /novel/detail/:novelId/roll-characters      Roll 角色（数组）
 *  POST   /novel/detail/:novelId/roll-opening         Roll 开场
 *  POST   /novel/detail/:novelId/character            添加角色
 *  PATCH  /novel/detail/:novelId/character/:charId    编辑角色
 *  DELETE /novel/detail/:novelId/character/:charId    删除角色
 *  POST   /novel/:novelId/enter                       开始一局（创建 novel_session）
 *  GET    /novel/active                               查活跃小说会话
 *  GET    /novel/session/:sessionId                   读时间线
 *  PATCH  /novel/session/:sessionId/excluded          更新出场名单
 *  POST   /novel/session/:sessionId/polish            润色玩家段落（独立，不落库）
 *  POST   /novel/session/:sessionId/continue          续写下一段（SSE）
 *  POST   /novel/session/:sessionId/retract           撤回最后一段（末尾栈式，可连续）
 *  POST   /novel/session/:sessionId/end               写结尾（标记 ended）
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { chat, chatStream, tryParseJsonReply, ChatMessage } from '../llm/adapter';
import { loadPrompt, renderPrompt } from '../prompt/loader';

// ── 字段定义（可 Roll 的字符串字段）────────────────────────────
const NOVEL_FIELDS = ['world_setting', 'protagonist_setting'] as const;
type NovelField = typeof NOVEL_FIELDS[number];

const FIELD_SCHEMAS: Record<NovelField, Record<string, unknown>> = {
  world_setting: { type: 'object', properties: { world_setting: { type: 'string' } }, required: ['world_setting'] },
  protagonist_setting: { type: 'object', properties: { protagonist_setting: { type: 'string' } }, required: ['protagonist_setting'] },
};

const CHARACTERS_SCHEMA = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          gender: { type: 'string', enum: ['female', 'male'] },
          persona: { type: 'string' },
          appearance: { type: 'string' },
        },
        required: ['name', 'persona', 'appearance'],
      },
    },
  },
  required: ['characters'],
};

const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    world_setting: { type: 'string' },
    protagonist_setting: { type: 'string' },
    opening: { type: 'string' },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          gender: { type: 'string', enum: ['female', 'male'] },
          persona: { type: 'string' },
          appearance: { type: 'string' },
        },
        required: ['name', 'persona'],
      },
    },
  },
  required: ['title', 'summary', 'world_setting', 'protagonist_setting', 'opening', 'characters'],
};

// 段摘要生成：一句话摘要 + 该段发生的时间（「第N天·时段」）
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    time: { type: 'string' },
  },
  required: ['summary', 'time'],
};

// 允许 PATCH 更新的字段
const ALLOWED_PATCH_FIELDS = [
  'title', 'summary', 'world_setting', 'protagonist_setting', 'opening', 'cover_url', 'status',
];

// ── 格式化 ────────────────────────────────────────────
function formatNovel(row: any) {
  return {
    id: row.id,
    authorId: row.author_id,
    title: row.title,
    summary: row.summary,
    worldSetting: row.world_setting,
    protagonistSetting: row.protagonist_setting,
    opening: row.opening,
    coverUrl: row.cover_url,
    status: row.status,
    playCount: row.play_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatNovelCharacter(row: any) {
  return {
    id: row.id,
    novelId: row.novel_id,
    name: row.name,
    gender: row.gender ?? '',
    persona: row.persona,
    emotionalAnchor: row.emotional_anchor ?? '',
    appearance: row.appearance,
    avatar: row.avatar ?? '',
  };
}

// 主角：名字 + 第三人称代词（跟玩家性别）
function getProtagonist(playerId: string): { name: string; pronoun: string } {
  const p = db.prepare('SELECT name, gender FROM players WHERE id = ?').get(playerId) as { name: string; gender: string } | undefined;
  const name = p?.name || '她';
  const pronoun = p?.gender === 'male' ? '他' : '她';
  return { name, pronoun };
}

// 设定字段里的 {{player_name}} 占位符 → 玩家昵称（正文类 prompt 注入时展开；roll 类保留让 LLM 沿用）
function expandPlayerName(s: string, name: string): string {
  if (!s) return s;
  return s.replace(/\{\{player_name\}\}/g, () => name);
}

// 角色列表 → prompt 文本（被点暗的不带人设，只列名字 + 去向说明）
function buildCharactersText(novelId: string, excludedIds: string[]): string {
  const all = db.prepare('SELECT * FROM novel_characters WHERE novel_id = ? ORDER BY created_at').all(novelId) as any[];
  const excludedSet = new Set(excludedIds);
  const active = all.filter(c => !excludedSet.has(c.id));
  const excluded = all.filter(c => excludedSet.has(c.id));

  const lines: string[] = active.map((c) => {
    const genderTag = c.gender === 'female' ? '（女）' : c.gender === 'male' ? '（男）' : '';
    const parts = [`- ${c.name}${genderTag}`];
    if (c.persona) parts.push(c.persona);
    if (c.appearance) parts.push(`外貌：${c.appearance}`);
    const base = parts.join('：');
    return c.emotional_anchor ? `${base}\n${c.emotional_anchor}` : base;
  });

  if (excluded.length > 0) {
    const names = excluded.map(c => c.name).join('、');
    lines.push('');
    lines.push(`（以下角色今天不在场，有各自的事要忙：${names}。他们不在这场戏里出场；如果正文提到他们，由在场的角色自然解释他们的去向。）`);
  }

  return lines.join('\n');
}

// ── 三折叠参数 ──────────────────────────────────────────
const HOT_WINDOW_N = 5;   // 热窗：最近 N 段用原文
const MID_WINDOW_M = 20;  // 中期：再往前 M 段用段摘要（novel_turns.summary）

// 续写上下文：三折叠注入
//   长期 = novel_sessions.story_overview（故事总览，异步增量维护）
//   中期 = 再往前 M 段的 summary（段摘要，异步生成）
//   热窗 = 最近 N 段原文
function buildContext(sessionId: string): { summary: string; recentText: string; currentTime: string } {
  const rows = db.prepare(
    'SELECT text, summary, time FROM novel_turns WHERE session_id = ? AND display = 1 ORDER BY created_at'
  ).all(sessionId) as { text: string; summary: string; time: string }[];

  const total = rows.length;
  const hotStart = Math.max(0, total - HOT_WINDOW_N);
  const midStart = Math.max(0, hotStart - MID_WINDOW_M);

  const midRows = rows.slice(midStart, hotStart);
  const hotRows = rows.slice(hotStart);

  const segments: string[] = [];
  if (midRows.length > 0) {
    segments.push('（更早的剧情，按发生顺序）');
    for (const r of midRows) {
      segments.push('· ' + (r.time ? `（${r.time}）` : '') + (r.summary || r.text.slice(0, 80)));
    }
  }
  const hotText = hotRows.map(r => r.text).join('\n\n');
  if (hotText) segments.push(hotText);

  const session = db.prepare('SELECT story_overview FROM novel_sessions WHERE id = ?').get(sessionId) as any;
  // 当前时间 = 最近一个有 time 的段（异步生成有延迟时往前兜底，时间通常连续）
  const currentTimeRow = db.prepare(
    "SELECT time FROM novel_turns WHERE session_id = ? AND display = 1 AND time != '' ORDER BY created_at DESC LIMIT 1"
  ).get(sessionId) as { time: string } | undefined;
  return {
    summary: session?.story_overview || '',
    recentText: segments.join('\n\n'),
    currentTime: currentTimeRow?.time || '',
  };
}

// 异步生成某段的段摘要 + 该段发生的时间，写回 turn.summary / turn.time（不阻塞续写响应）
async function generateTurnSummary(sessionId: string, turnId: string, text: string, playerId: string): Promise<void> {
  const { name } = getProtagonist(playerId);
  // 取本段之前最近几段作为前文（已有摘要用摘要，否则用原文），供推断时间、地点、天数
  const prior = db.prepare(
    `SELECT text, summary, time FROM novel_turns
     WHERE session_id = ? AND display = 1
       AND created_at < (SELECT created_at FROM novel_turns WHERE id = ?)
     ORDER BY created_at DESC LIMIT 5`
  ).all(sessionId, turnId) as { text: string; summary: string; time: string }[];
  const priorText = prior.slice().reverse()
    .map(r => {
      const base = expandPlayerName(r.summary || r.text, name);
      return (r.time ? `（${r.time}）` : '') + base;
    })
    .join('\n\n');

  const filled = renderPrompt(loadPrompt('novel.summary'), {
    text: expandPlayerName(text, name),
    prior_text: priorText || '（暂无）',
  });
  const result = await chat(
    [{ role: 'system', content: filled }],
    { temperature: 0.3, maxTokens: 256, guidedJson: SUMMARY_SCHEMA, playerId, sessionId, callType: 'novel_summary' },
  );
  const parsed = tryParseJsonReply(result.content);
  const summary = cleanNovelText(typeof parsed?.summary === 'string' ? parsed.summary : '');
  const time = cleanNovelText(typeof parsed?.time === 'string' ? parsed.time : '');
  if (!summary && !time) return;
  db.prepare('UPDATE novel_turns SET summary = ?, time = ? WHERE id = ?').run(summary, time, turnId);
}

// 异步总览增量更新：滑出「热窗 + 中期」窗口的段摘要折进总览（旧总览 + 一批新摘要 → 新总览）
async function updateStoryOverview(sessionId: string, playerId: string): Promise<void> {
  const rows = db.prepare(
    'SELECT summary FROM novel_turns WHERE session_id = ? AND display = 1 ORDER BY created_at'
  ).all(sessionId) as { summary: string }[];

  const total = rows.length;
  const target = total - HOT_WINDOW_N - MID_WINDOW_M;
  if (target <= 0) return; // 还没到折叠点

  const session = db.prepare('SELECT story_overview, overview_upto FROM novel_sessions WHERE id = ?').get(sessionId) as any;
  const upto = (session?.overview_upto ?? 0) as number;
  if (target <= upto) return; // 没有新段要折

  const newSummaries = rows.slice(upto, target).map(r => r.summary).filter(s => !!s);
  if (newSummaries.length === 0) return; // 摘要还没生成完，下次再试

  const oldOverview = (session?.story_overview || '') as string;
  const filled = renderPrompt(loadPrompt('novel.overview'), {
    overview: oldOverview || '（暂无）',
    new_summaries: newSummaries.join('\n'),
  });
  const result = await chat(
    [{ role: 'system', content: filled }],
    { temperature: 0.3, maxTokens: 512, playerId, sessionId, callType: 'novel_overview' },
  );
  const merged = cleanNovelText(result.content);
  if (!merged) return;

  db.prepare('UPDATE novel_sessions SET story_overview = ?, overview_upto = ?, updated_at = ? WHERE id = ?')
    .run(merged, target, now(), sessionId);
}

// 清洗续写/润色输出：剥 markdown 围栏 + 结尾接力信号（gemma 自发的元文本）
function cleanNovelText(s: string): string {
  let t = s.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').replace(/```/g, '');
  const handoffPatterns = [
    /\s*[（(]?轮到你了[）)]?\s*$/,
    /\s*请接龙\s*$/,
    /\s*[（(]?请继续[）)]?\s*$/,
    /\s*[（(]?待续[）)]?\s*$/,
    /\s*[（(]?未完待续[）)]?\s*$/,
  ];
  for (const p of handoffPatterns) t = t.replace(p, '');
  return t.trim();
}

// ── 路由 ──────────────────────────────────────────────
export async function novelRoutes(app: FastifyInstance): Promise<void> {

  // ── 一键导入：粘贴完整设定文本 → 解析+补全 → 落库（小说+角色）──
  app.post('/novel/import', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { text } = req.body as { text?: string };
    if (!text?.trim()) return reply.code(400).send({ error: '请先粘贴设定文本' });
    if (text.trim().length > 30000) return reply.code(400).send({ error: '文本过长（上限 3 万字），请精简后再导入' });

    const filledPrompt = loadPrompt('novel.import');
    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: text.trim() },
    ];

    let parsed: any;
    try {
      const result = await chat(messages, { temperature: 0.4, maxTokens: 8192, guidedJson: IMPORT_SCHEMA, playerId, callType: 'novel_import' });
      parsed = tryParseJsonReply(result.content);
      if (!parsed || typeof parsed.title !== 'string' || !parsed.title.trim()) {
        return reply.code(502).send({ error: '解析失败，请重试' });
      }
    } catch (err) {
      app.log.error({ err }, '导入小说失败');
      return reply.code(502).send({ error: '解析失败，请重试' });
    }

    const novelId = genId();
    const ts = now();
    const insertNovel = db.prepare(`INSERT INTO novels (id, author_id, title, summary, world_setting, protagonist_setting, opening, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`);
    const insertChar = db.prepare('INSERT INTO novel_characters (id, novel_id, name, gender, persona, appearance, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    db.exec('BEGIN');
    try {
      insertNovel.run(
        novelId, playerId,
        parsed.title.trim(),
        (parsed.summary ?? '').trim(),
        (parsed.world_setting ?? '').trim(),
        (parsed.protagonist_setting ?? '').trim(),
        (parsed.opening ?? '').trim(),
        ts, ts,
      );
      const chars = Array.isArray(parsed.characters) ? parsed.characters : [];
      for (const c of chars) {
        if (!c?.name?.trim()) continue;
        const g = c.gender === 'female' || c.gender === 'male' ? c.gender : '';
        insertChar.run(genId(), novelId, c.name.trim(), g, (c.persona ?? '').trim(), (c.appearance ?? '').trim(), '', ts);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return reply.send({ novelId });
  });

  // ── 创建小说 ──────────────────────────────────────────
  app.post('/novel', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { title, summary } = req.body as { title?: string; summary?: string };
    if (!title?.trim()) return reply.code(400).send({ error: '小说名不能为空' });

    const novelId = genId();
    const ts = now();
    db.prepare(`INSERT INTO novels (id, author_id, title, summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)`)
      .run(novelId, playerId, title.trim(), (summary ?? '').trim(), ts, ts);

    return reply.send({ novelId });
  });

  // ── 小说列表 ──────────────────────────────────────────
  app.get('/novel', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { mine } = req.query as { mine?: string };
    let rows: any[];
    if (mine === '1') {
      rows = db.prepare('SELECT * FROM novels WHERE author_id = ? ORDER BY updated_at DESC').all(playerId);
    } else {
      rows = db.prepare("SELECT * FROM novels WHERE status = 'published' ORDER BY play_count DESC, created_at DESC").all();
    }

    const { name: playerName } = getProtagonist(playerId);
    const novels = rows.map((row) => {
      const chars = db.prepare('SELECT name, avatar FROM novel_characters WHERE novel_id = ? ORDER BY created_at').all(row.id) as { name: string; avatar: string }[];
      const fmt = formatNovel(row);
      return {
        ...fmt,
        summary: expandPlayerName(fmt.summary, playerName),
        characterNames: chars.map(c => c.name),
        characterAvatars: chars.map(c => c.avatar ?? ''),
      };
    });
    return reply.send({ novels });
  });

  // ── 小说详情 ──────────────────────────────────────────
  app.get('/novel/detail/:novelId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
    if (!row) return reply.code(404).send({ error: '小说不存在' });
    if (row.status !== 'published' && row.author_id !== playerId) {
      return reply.code(403).send({ error: '小说未发布' });
    }

    const chars = db.prepare('SELECT * FROM novel_characters WHERE novel_id = ? ORDER BY created_at').all(novelId) as any[];
    return reply.send({ novel: formatNovel(row), characters: chars.map(formatNovelCharacter) });
  });

  // ── 更新小说字段 ──────────────────────────────────────
  app.patch('/novel/detail/:novelId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const updates = req.body as Record<string, unknown>;

    const row = db.prepare('SELECT author_id FROM novels WHERE id = ?').get(novelId) as { author_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: '小说不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能编辑自己的小说' });

    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (ALLOWED_PATCH_FIELDS.includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
    if (setClauses.length === 0) return reply.code(400).send({ error: '没有可更新的字段' });
    setClauses.push('updated_at = ?');
    values.push(now(), novelId);

    db.prepare(`UPDATE novels SET ${setClauses.join(', ')} WHERE id = ?`).run(...values as never[]);
    const updated = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
    return reply.send({ novel: formatNovel(updated) });
  });

  // ── 删除小说 ──────────────────────────────────────────
  app.delete('/novel/detail/:novelId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const row = db.prepare('SELECT author_id FROM novels WHERE id = ?').get(novelId) as { author_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: '小说不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能删除自己的小说' });

    db.prepare('DELETE FROM novels WHERE id = ?').run(novelId);
    return reply.send({ ok: true });
  });

  // ── Roll 单字段（world_setting / protagonist_setting）──
  app.post('/novel/detail/:novelId/roll', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const { field } = req.body as { field: NovelField };
    if (!NOVEL_FIELDS.includes(field)) return reply.code(400).send({ error: '不支持的字段' });

    const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
    if (!row) return reply.code(404).send({ error: '小说不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能 roll 自己的小说' });

    const rollPrompt = loadPrompt('novel.roll');
    const filledPrompt = renderPrompt(rollPrompt, {
      title: row.title,
      summary: row.summary,
      world_setting: row.world_setting,
      protagonist_setting: row.protagonist_setting,
      opening: row.opening,
      target_field: field,
      output_schema: JSON.stringify(FIELD_SCHEMAS[field]),
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: `请生成「${field}」字段。` },
    ];

    try {
      const result = await chat(messages, { temperature: 0.9, maxTokens: 512, guidedJson: FIELD_SCHEMAS[field], playerId });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed || typeof parsed[field] !== 'string') return reply.code(502).send({ error: '生成失败，请重试' });

      const value = parsed[field] as string;
      db.prepare(`UPDATE novels SET ${field} = ?, updated_at = ? WHERE id = ?`).run(value, now(), novelId);
      return reply.send({ field, value });
    } catch (err) {
      app.log.error({ err }, '小说 roll 失败');
      return reply.code(502).send({ error: '生成失败，请重试' });
    }
  });

  // ── Roll 角色（数组）──────────────────────────────────
  app.post('/novel/detail/:novelId/roll-characters', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const { count, direction } = req.body as { count?: number; direction?: string };

    const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
    if (!row) return reply.code(404).send({ error: '小说不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能 roll 自己的小说' });

    const n = Math.min(Math.max(count ?? 3, 1), 6);

    const rollPrompt = loadPrompt('novel.roll-characters');
    const filledPrompt = renderPrompt(rollPrompt, {
      world_setting: row.world_setting,
      protagonist_setting: row.protagonist_setting,
      direction: direction?.trim() ? `\n方向要求：${direction.trim()}` : '',
      output_schema: JSON.stringify(CHARACTERS_SCHEMA),
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: `请生成 ${n} 个原创角色。` },
    ];

    try {
      const result = await chat(messages, { temperature: 0.9, maxTokens: 1024, guidedJson: CHARACTERS_SCHEMA, playerId });
      const parsed = tryParseJsonReply(result.content);
      if (!parsed || !Array.isArray(parsed.characters)) return reply.code(502).send({ error: '生成失败，请重试' });

      const chars = (parsed.characters as Array<{ name: string; gender?: string; persona: string; appearance: string }>).slice(0, n);
      const ts = now();
      const created = chars.map((c) => {
        const id = genId();
        const gender = c.gender === 'female' || c.gender === 'male' ? c.gender : '';
        db.prepare('INSERT INTO novel_characters (id, novel_id, name, gender, persona, appearance, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, novelId, c.name.trim(), gender, c.persona?.trim() ?? '', c.appearance?.trim() ?? '', '', ts);
        return { id, novelId, name: c.name.trim(), gender, persona: c.persona?.trim() ?? '', appearance: c.appearance?.trim() ?? '', avatar: '' };
      });

      return reply.send({ characters: created });
    } catch (err) {
      app.log.error({ err }, '角色 roll 失败');
      return reply.code(502).send({ error: '生成失败，请重试' });
    }
  });

  // ── Roll 开场 ─────────────────────────────────────────
  app.post('/novel/detail/:novelId/roll-opening', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
    if (!row) return reply.code(404).send({ error: '小说不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能 roll 自己的小说' });

    const { pronoun } = getProtagonist(playerId);
    const charactersText = buildCharactersText(novelId, []);

    const rollPrompt = loadPrompt('novel.roll-opening');
    const filledPrompt = renderPrompt(rollPrompt, {
      world_setting: row.world_setting,
      player_name: '{{player_name}}',
      protagonist_setting: row.protagonist_setting,
      pronoun,
      characters: charactersText,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: '请写开场。' },
    ];

    try {
      const result = await chat(messages, { temperature: 0.9, maxTokens: 1200, playerId });
      const opening = cleanNovelText(result.content);
      if (!opening) return reply.code(502).send({ error: '生成失败，请重试' });

      db.prepare('UPDATE novels SET opening = ?, updated_at = ? WHERE id = ?').run(opening, now(), novelId);
      return reply.send({ opening });
    } catch (err) {
      app.log.error({ err }, '开场 roll 失败');
      return reply.code(502).send({ error: '生成失败，请重试' });
    }
  });

  // ── 添加角色 ──────────────────────────────────────────
  app.post('/novel/detail/:novelId/character', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const { name, gender, persona, appearance, avatar, emotional_anchor } = req.body as { name?: string; gender?: string; persona?: string; appearance?: string; avatar?: string; emotional_anchor?: string };
    if (!name?.trim()) return reply.code(400).send({ error: '角色名字不能为空' });
    const g = gender === 'female' || gender === 'male' ? gender : '';

    const row = db.prepare('SELECT author_id FROM novels WHERE id = ?').get(novelId) as { author_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: '小说不存在' });
    if (row.author_id !== playerId) return reply.code(403).send({ error: '只能编辑自己的小说' });

    const id = genId();
    const ts = now();
    db.prepare('INSERT INTO novel_characters (id, novel_id, name, gender, persona, emotional_anchor, appearance, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, novelId, name.trim(), g, persona?.trim() ?? '', emotional_anchor?.trim() ?? '', appearance?.trim() ?? '', avatar?.trim() ?? '', ts);

    const created = db.prepare('SELECT * FROM novel_characters WHERE id = ?').get(id) as any;
    return reply.send({ character: formatNovelCharacter(created) });
  });

  // ── 编辑角色 ──────────────────────────────────────────
  app.patch('/novel/detail/:novelId/character/:charId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId, charId } = req.params as { novelId: string; charId: string };
    const { name, gender, persona, appearance, avatar, emotional_anchor } = req.body as { name?: string; gender?: string; persona?: string; appearance?: string; avatar?: string; emotional_anchor?: string };

    const novel = db.prepare('SELECT author_id FROM novels WHERE id = ?').get(novelId) as { author_id: string } | undefined;
    if (!novel) return reply.code(404).send({ error: '小说不存在' });
    if (novel.author_id !== playerId) return reply.code(403).send({ error: '只能编辑自己的小说' });

    const char = db.prepare('SELECT id FROM novel_characters WHERE id = ? AND novel_id = ?').get(charId, novelId);
    if (!char) return reply.code(404).send({ error: '角色不存在' });

    const setClauses: string[] = [];
    const values: string[] = [];
    if (name !== undefined) { setClauses.push('name = ?'); values.push(name.trim()); }
    if (gender !== undefined) { setClauses.push('gender = ?'); values.push(gender === 'female' || gender === 'male' ? gender : ''); }
    if (persona !== undefined) { setClauses.push('persona = ?'); values.push(persona); }
    if (appearance !== undefined) { setClauses.push('appearance = ?'); values.push(appearance); }
    if (avatar !== undefined) { setClauses.push('avatar = ?'); values.push(avatar); }
    if (emotional_anchor !== undefined) { setClauses.push('emotional_anchor = ?'); values.push(emotional_anchor); }
    if (setClauses.length === 0) return reply.code(400).send({ error: '没有可更新的字段' });

    db.prepare(`UPDATE novel_characters SET ${setClauses.join(', ')} WHERE id = ?`).run(...values, charId);
    const updated = db.prepare('SELECT * FROM novel_characters WHERE id = ?').get(charId) as any;
    return reply.send({ character: formatNovelCharacter(updated) });
  });

  // ── 删除角色 ──────────────────────────────────────────
  app.delete('/novel/detail/:novelId/character/:charId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId, charId } = req.params as { novelId: string; charId: string };
    const novel = db.prepare('SELECT author_id FROM novels WHERE id = ?').get(novelId) as { author_id: string } | undefined;
    if (!novel) return reply.code(404).send({ error: '小说不存在' });
    if (novel.author_id !== playerId) return reply.code(403).send({ error: '只能编辑自己的小说' });

    db.prepare('DELETE FROM novel_characters WHERE id = ? AND novel_id = ?').run(charId, novelId);
    return reply.send({ ok: true });
  });

  // ── 开始一局 ──────────────────────────────────────────
  app.post('/novel/:novelId/enter', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { novelId } = req.params as { novelId: string };
    const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as any;
    if (!novel) return reply.code(404).send({ error: '小说不存在' });
    if (novel.status !== 'published') return reply.code(403).send({ error: '小说未发布' });

    // 同小说最多一条 active 进行中，重复 enter 复用
    const existing = db.prepare("SELECT id FROM novel_sessions WHERE player_id = ? AND novel_id = ? AND status = 'active'").get(playerId, novelId) as { id: string } | undefined;
    if (existing) {
      return reply.send({ sessionId: existing.id, reused: true });
    }

    const sessionId = genId();
    const ts = now();
    db.prepare("INSERT INTO novel_sessions (id, player_id, novel_id, status, excluded_chars, created_at, updated_at) VALUES (?, ?, ?, 'active', '[]', ?, ?)")
      .run(sessionId, playerId, novelId, ts, ts);

    // 开场落库为正文第一段
    if (novel.opening?.trim()) {
      const openingId = genId();
      db.prepare('INSERT INTO novel_turns (id, session_id, role, text, display, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(openingId, sessionId, 'assistant', novel.opening.trim(), ts);
      // 三折叠：开场段也生成摘要（异步，不阻塞 enter 响应）
      void generateTurnSummary(sessionId, openingId, novel.opening.trim(), playerId)
        .catch(err => app.log.error({ err }, '开场摘要生成失败'));
    }

    db.prepare('UPDATE novels SET play_count = play_count + 1 WHERE id = ?').run(novelId);

    return reply.code(201).send({ sessionId });
  });

  // ── 查活跃小说会话 ────────────────────────────────────
  app.get('/novel/active', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const session = db.prepare(
      `SELECT s.id, s.novel_id, n.title
       FROM novel_sessions s JOIN novels n ON n.id = s.novel_id
       WHERE s.player_id = ? AND s.status = 'active'
       ORDER BY s.updated_at DESC LIMIT 1`
    ).get(playerId) as any;

    if (!session) return reply.send({ active: false });
    return reply.send({ active: true, sessionId: session.id, novelId: session.novel_id, title: session.title });
  });

  // ── 读时间线 ──────────────────────────────────────────
  app.get('/novel/session/:sessionId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare('SELECT * FROM novel_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '小说会话不存在' });

    const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(session.novel_id) as any;
    const chars = db.prepare('SELECT * FROM novel_characters WHERE novel_id = ? ORDER BY created_at').all(session.novel_id) as any[];
    const turns = db.prepare('SELECT id, role, text, display, created_at FROM novel_turns WHERE session_id = ? ORDER BY created_at').all(sessionId) as any[];

    const { name, pronoun } = getProtagonist(playerId);

    return reply.send({
      sessionId: session.id,
      novelId: session.novel_id,
      status: session.status,
      isAuthor: novel.author_id === playerId,
      excludedCharIds: jsonParse<string[]>(session.excluded_chars, []),
      novel: formatNovel(novel),
      protagonist: { name, pronoun },
      characters: chars.map(formatNovelCharacter),
      turns: turns.map(t => ({ id: t.id, role: t.role, text: expandPlayerName(t.text, name), display: !!t.display, createdAt: t.created_at })),
    });
  });

  // ── 更新出场名单 ──────────────────────────────────────
  app.patch('/novel/session/:sessionId/excluded', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { excludedCharIds } = req.body as { excludedCharIds?: string[] };

    const session = db.prepare('SELECT * FROM novel_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '小说会话不存在' });

    const ids = Array.isArray(excludedCharIds) ? excludedCharIds : [];
    db.prepare('UPDATE novel_sessions SET excluded_chars = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ids), now(), sessionId);
    return reply.send({ excludedCharIds: ids });
  });

  // ── 润色（独立功能，不落库）────────────────────────────
  app.post('/novel/session/:sessionId/polish', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { text } = req.body as { text?: string };
    if (!text?.trim()) return reply.code(400).send({ error: '段落不能为空' });

    const session = db.prepare('SELECT * FROM novel_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '小说会话不存在' });

    const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(session.novel_id) as any;
    const { name, pronoun } = getProtagonist(playerId);
    const excludedIds = jsonParse<string[]>(session.excluded_chars, []);
    const charactersText = buildCharactersText(session.novel_id, excludedIds);

    // 最近 3 段前文（用于对齐叙事人称/文风），展开 {{player_name}}
    const recentRows = db.prepare('SELECT text FROM novel_turns WHERE session_id = ? AND display = 1 ORDER BY created_at DESC LIMIT 3').all(sessionId) as { text: string }[];
    const recentText = recentRows.slice().reverse().map(r => expandPlayerName(r.text, name)).join('\n\n');

    const polishPrompt = loadPrompt('novel.polish');
    const filledPrompt = renderPrompt(polishPrompt, {
      recent_text: recentText,
      world_setting: expandPlayerName(novel.world_setting || '', name),
      player_name: name,
      protagonist_setting: expandPlayerName(novel.protagonist_setting || '', name),
      pronoun,
      characters: charactersText,
      player_input: text.trim(),
    });

    const messages: ChatMessage[] = [{ role: 'system', content: filledPrompt }];

    try {
      const result = await chat(messages, { temperature: 0.7, maxTokens: 1024, playerId });
      return reply.send({ polished: cleanNovelText(result.content) });
    } catch (err) {
      app.log.error({ err }, '润色失败');
      return reply.code(502).send({ error: '生成失败，请重试' });
    }
  });

  // ── 续写下一段（SSE）──────────────────────────────────
  app.post('/novel/session/:sessionId/continue', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { text } = req.body as { text?: string };

    const session = db.prepare('SELECT * FROM novel_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '小说会话不存在' });
    if (session.status === 'ended') return reply.code(400).send({ error: '这一局已经写完结尾了' });

    const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(session.novel_id) as any;

    // 玩家这段落库（正文显示）。playerTurnId 提升到 try 外，供失败回滚时删除。
    let playerTurnId: string | null = null;
    if (text?.trim()) {
      playerTurnId = genId();
      db.prepare('INSERT INTO novel_turns (id, session_id, role, text, display, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(playerTurnId, sessionId, 'player', text.trim(), now());
      // 三折叠：玩家段也生成摘要（异步，不阻塞续写）
      void generateTurnSummary(sessionId, playerTurnId, text.trim(), playerId)
        .catch(err => app.log.error({ err }, '玩家段摘要生成失败'));
    }

    const { name, pronoun } = getProtagonist(playerId);
    const excludedIds = jsonParse<string[]>(session.excluded_chars, []);
    const charactersText = buildCharactersText(session.novel_id, excludedIds);

    const { summary, recentText, currentTime } = buildContext(sessionId);
    const continuePrompt = loadPrompt('novel.continue');
    const filledPrompt = renderPrompt(continuePrompt, {
      world_setting: expandPlayerName(novel.world_setting || '', name),
      player_name: name,
      protagonist_setting: expandPlayerName(novel.protagonist_setting || '', name),
      pronoun,
      characters: charactersText,
      summary: expandPlayerName(summary, name),
      recent_text: expandPlayerName(recentText, name),
      current_time: currentTime,
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: filledPrompt },
      { role: 'user', content: '请接着写下一段。' },
    ];

    // SSE
    const raw = reply.raw;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache');
    // 流式续写是一次性响应：结束后必须关闭连接。
    // 若设 keep-alive，hijack 后的 chunked 响应在 raw.end() 后连接上会残留数据，
    // 污染代理(3001)/网关(8080)复用的下一条请求 → 后端报 400 "Bad Request"（重试续写报错的根因）。
    raw.setHeader('Connection', 'close');
    reply.hijack();
    const send = (data: unknown) => { try { raw.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ } };

    try {
      // 流式续写：逐 token 推 delta（打字机），结束后清洗落库
      let full = '';
      let pending = '';
      let lastFlush = Date.now();
      for await (const delta of chatStream(messages, { temperature: 0.8, maxTokens: 3000, playerId, sessionId, callType: 'novel_continue' })) {
        full += delta;
        pending += delta;
        // 合并 delta：每 60ms 或累积 24 字 flush 一次，SSE 频率从 ~150/秒 降到 ~16/秒。
        // 打字机观感不变（人眼 60ms 一帧），但前端 setData/重渲染压力降一个量级。
        const now = Date.now();
        if (now - lastFlush >= 60 || pending.length >= 24) {
          send({ type: 'delta', content: pending });
          pending = '';
          lastFlush = now;
        }
      }
      if (pending) send({ type: 'delta', content: pending });
      const continuation = cleanNovelText(full);

      const turnId = genId();
      db.prepare('INSERT INTO novel_turns (id, session_id, role, text, display, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(turnId, sessionId, 'assistant', continuation, now());
      db.prepare('UPDATE novel_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

      // 三折叠：异步生成段摘要 + 增量更新总览（fire-and-forget，不阻塞 SSE）
      void generateTurnSummary(sessionId, turnId, continuation, playerId)
        .catch(err => app.log.error({ err }, '段摘要生成失败'));
      void updateStoryOverview(sessionId, playerId)
        .catch(err => app.log.error({ err }, '总览更新失败'));

      send({ type: 'done', text: continuation });
      raw.end();
    } catch (e: any) {
      // 失败回滚：删除已落库的玩家段，避免「半截落库」——否则前端重拉会把这段
      // 又显示回正文流，玩家再点续写会二次插入同一段，正文出现重复。
      if (playerTurnId) {
        db.prepare('DELETE FROM novel_turns WHERE id = ?').run(playerTurnId);
      }
      send({ type: 'error', error: e?.message ?? '续写失败' });
      raw.end();
    }
  });

  // ── 撤回最后一段（末尾栈式，可连续）────────────────────
  app.post('/novel/session/:sessionId/retract', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const session = db.prepare('SELECT * FROM novel_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '小说会话不存在' });
    if (session.status === 'ended') return reply.code(400).send({ error: '这一局已经完结，不能再撤回' });

    const last = db.prepare('SELECT id FROM novel_turns WHERE session_id = ? AND display = 1 ORDER BY created_at DESC LIMIT 1').get(sessionId) as { id: string } | undefined;
    if (!last) return reply.send({ removed: false, remaining: 0 });

    db.prepare('DELETE FROM novel_turns WHERE id = ?').run(last.id);
    db.prepare('UPDATE novel_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);

    const remaining = (db.prepare('SELECT COUNT(*) c FROM novel_turns WHERE session_id = ? AND display = 1').get(sessionId) as { c: number }).c;
    return reply.send({ removed: true, remaining });
  });

  // ── 写结尾（标记 ended）────────────────────────────────
  app.post('/novel/session/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { sessionId } = req.params as { sessionId: string };
    const { text } = req.body as { text?: string };

    const session = db.prepare('SELECT * FROM novel_sessions WHERE id = ? AND player_id = ?').get(sessionId, playerId) as any;
    if (!session) return reply.code(404).send({ error: '小说会话不存在' });
    if (session.status === 'ended') return reply.code(400).send({ error: '这一局已经结束了' });

    // 玩家写的结尾段落落库（若有）
    if (text?.trim()) {
      db.prepare('INSERT INTO novel_turns (id, session_id, role, text, display, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .run(genId(), sessionId, 'player', text.trim(), now());
    }

    db.prepare("UPDATE novel_sessions SET status = 'ended', updated_at = ? WHERE id = ?").run(now(), sessionId);
    return reply.send({ ok: true, ended: true });
  });
}
