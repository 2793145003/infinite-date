/**
 * 衍生世界路由 — 修仙程序化世界演化（女修手札式玩家养成）
 *
 * 成本基石：世界由程序规则演化，只有玩家「遇到并选择」的 NPC 才用 LLM（懒加载人设卡 + 对话）。
 * 整个 WorldEngine 状态序列化进 derivative_worlds.save_data，每次请求：恢复 → 操作 → 落库。
 *
 * 路由：
 *  POST   /world                    创建衍生世界
 *  GET    /world                    我的世界列表
 *  GET    /world/:id/state          世界状态（地图/玩家/NPC/事件）
 *  POST   /world/:id/advance        推进 N 月（休息跳月 / 闭关）
 *  POST   /world/:id/move           走格子（移动 + 相遇升格）
 *  POST   /world/:id/talk           与 NPC 对话（LLM）
 *  POST   /world/:id/craft/start    开始炼制（生成二消盘面）
 *  POST   /world/:id/craft/swap     二消交换（纯函数，无状态）
 *  POST   /world/:id/craft/finish   炼制结算（出成品）
 *  DELETE /world/:id                删除世界
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now, jsonParse } from '../lib/util';
import { WorldEngine } from '../world/world';
import { createPlayer } from '../world/player';
import { makeRng } from '../world/rng';
import { playerRecipes, playerCraftResult, hasMaterials } from '../world/craft';
import { newBoard, trySwap, ALL_TILES } from '../world/match2';
import type { Board } from '../world/match2';
import { generateCharacterCard, chatTurn } from '../world/llm';
import type { LlmGenerate } from '../world/llm';
import { chatJson } from '../llm/adapter';
import type { ChatTurn } from '../world/llm-prompt';
import { REALMS } from '../world/types';
import type { WorldSave, Npc, Player, CharacterCard, ChatReply } from '../world/types';

// ── 世界默认规模（玩家可覆盖）────────────────────────────
const WORLD_DEFAULTS = {
  npcCount: 40,   // 40 个 NPC 的修仙世界
  regions: 2,     // 2×2 大方格
  cells: 8,       // 每区域 8×8，全局 16×16 = 256 格
  boardSize: 8,   // 二消盘面 8×8
  movesLeft: 20,  // 二消步数
};

// ── 存档加载 / 落库 ──────────────────────────────────────

interface LoadedWorld {
  engine: WorldEngine;
  seed: number;
  name: string;
  chatHistory: Record<string, ChatTurn[]>; // npcId(字符串) → 对话历史
}

function loadWorld(worldId: string, pid: string): LoadedWorld | null {
  const row = db.prepare('SELECT seed, name, save_data, chat_history FROM derivative_worlds WHERE id = ? AND player_id = ? AND status = ?')
    .get(worldId, pid, 'active') as { seed: number; name: string; save_data: string; chat_history: string } | undefined;
  if (!row) return null;
  const save = jsonParse<WorldSave>(row.save_data, null as unknown as WorldSave);
  if (!save) return null;
  const engine = new WorldEngine({ seed: row.seed, npcCount: 0 }, save);
  const chatHistory = jsonParse<Record<string, ChatTurn[]>>(row.chat_history, {});
  return { engine, seed: row.seed, name: row.name, chatHistory };
}

function saveWorld(worldId: string, loaded: LoadedWorld): void {
  db.prepare('UPDATE derivative_worlds SET save_data = ?, tick = ?, chat_history = ?, updated_at = ? WHERE id = ?')
    .run(
      JSON.stringify(loaded.engine.serialize()),
      loaded.engine.world.tick,
      JSON.stringify(loaded.chatHistory),
      now(),
      worldId,
    );
}

// ── 摘要（前端渲染用）────────────────────────────────────

function mapSummary(engine: WorldEngine) {
  const m = engine.world.map.serialize();
  return {
    regions: m.regions,
    cells: m.cells,
    size: m.regions * m.cells,
    regionNames: m.regionNames,
    cellNames: m.cellNames,
  };
}

function npcSummary(n: Npc, engine: WorldEngine) {
  return {
    id: n.id,
    name: n.name,
    gender: n.gender,
    realm: n.realm,
    realmName: REALMS[n.realm],
    faction: n.faction,
    loc: n.loc,
    locName: engine.locName(n.loc),
    alive: n.alive,
    liveliness: n.liveliness,
    affinityToPlayer: n.affinityToPlayer,
    hasCard: !!n.characterData,
  };
}

function playerSummary(p: Player | undefined, engine: WorldEngine) {
  if (!p) return null;
  return {
    name: p.name,
    gender: p.gender,
    realm: p.realm,
    realmName: REALMS[p.realm],
    qi: p.qi,
    aptitude: p.aptitude,
    comprehension: p.comprehension,
    charm: p.charm,
    fortune: p.fortune,
    lifespan: p.lifespan,
    loc: p.loc,
    locName: engine.locName(p.loc),
    energy: p.energy,
    actionPoints: p.actionPoints,
    backpack: p.backpack,
    affinities: Object.fromEntries(p.affinities),
  };
}

// ── 路由 ──────────────────────────────────────────────────

export async function worldRoutes(app: FastifyInstance): Promise<void> {
  // 创建衍生世界
  app.post('/world', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const body = (req.body ?? {}) as { name?: string; seed?: number; npcCount?: number; regions?: number; cells?: number };
    const seed = body.seed ?? Math.floor(Math.random() * 0x7fffffff);
    const npcCount = Math.min(200, Math.max(10, body.npcCount ?? WORLD_DEFAULTS.npcCount));
    const regions = Math.min(5, Math.max(1, body.regions ?? WORLD_DEFAULTS.regions));
    const cells = Math.min(12, Math.max(4, body.cells ?? WORLD_DEFAULTS.cells));

    const engine = new WorldEngine({ seed, npcCount, regions, cells });
    const playerRow = db.prepare('SELECT name FROM players WHERE id = ?').get(pid) as { name: string } | undefined;
    const player = createPlayer(makeRng(seed ^ 0x9e3779b9), { name: playerRow?.name ?? '无名修士', loc: 0 });
    engine.attachPlayer(player);

    const id = genId();
    const name = body.name?.trim() || `第${engine.world.tick + 1}世`;
    db.prepare('INSERT INTO derivative_worlds (id, player_id, name, seed, save_data, chat_history, tick, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, pid, name, seed, JSON.stringify(engine.serialize()), '{}', engine.world.tick, 'active', now(), now());

    reply.send({
      id,
      name,
      tick: engine.world.tick,
      map: mapSummary(engine),
      player: playerSummary(engine.world.player, engine),
      npcCount: engine.npcs.length,
    });
  });

  // 我的世界列表
  app.get('/world', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const rows = db.prepare('SELECT id, name, seed, tick, created_at, updated_at FROM derivative_worlds WHERE player_id = ? AND status = ? ORDER BY updated_at DESC')
      .all(pid, 'active') as Array<{ id: string; name: string; seed: number; tick: number; created_at: number; updated_at: number }>;
    reply.send({ worlds: rows.map((r) => ({ ...r })) });
  });

  // 世界状态
  app.get('/world/:id/state', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const { id } = req.params as { id: string };
    const loaded = loadWorld(id, pid);
    if (!loaded) return reply.code(404).send({ error: '世界不存在' });
    const { engine } = loaded;
    reply.send({
      id,
      name: loaded.name,
      seed: loaded.seed,
      tick: engine.world.tick,
      map: mapSummary(engine),
      player: playerSummary(engine.world.player, engine),
      npcs: engine.npcs.map((n) => npcSummary(n, engine)),
      recentEvents: engine.world.events.slice(-40).reverse(),
      publicEvents: engine.publicEvents().slice(-20).reverse(),
    });
  });

  // 推进 N 月（休息 / 闭关）
  app.post('/world/:id/advance', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const { id } = req.params as { id: string };
    const loaded = loadWorld(id, pid);
    if (!loaded) return reply.code(404).send({ error: '世界不存在' });
    const body = (req.body ?? {}) as { months?: number };
    const months = Math.min(120, Math.max(1, body.months ?? 1));
    const events = loaded.engine.run(months);
    saveWorld(id, loaded);
    reply.send({
      tick: loaded.engine.world.tick,
      events: events.reverse(),
      player: playerSummary(loaded.engine.world.player, loaded.engine),
    });
  });

  // 走格子（移动 + 相遇升格）
  app.post('/world/:id/move', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const { id } = req.params as { id: string };
    const loaded = loadWorld(id, pid);
    if (!loaded) return reply.code(404).send({ error: '世界不存在' });
    const body = (req.body ?? {}) as { loc?: number };
    const size = loaded.engine.world.map.size;
    const loc = body.loc;
    if (typeof loc !== 'number' || loc < 0 || loc >= size * size) {
      return reply.code(400).send({ error: '无效坐标' });
    }
    const met = loaded.engine.playerMove(loc);
    saveWorld(id, loaded);
    reply.send({
      loc,
      locName: loaded.engine.locName(loc),
      met: met.map((n) => npcSummary(n, loaded.engine)),
      player: playerSummary(loaded.engine.world.player, loaded.engine),
    });
  });

  // 与 NPC 对话（LLM：懒加载人设卡 + 多轮对话 + 写回履历）
  app.post('/world/:id/talk', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const { id } = req.params as { id: string };
    const loaded = loadWorld(id, pid);
    if (!loaded) return reply.code(404).send({ error: '世界不存在' });
    const body = (req.body ?? {}) as { npcId?: number; message?: string };
    const npc = typeof body.npcId === 'number' ? loaded.engine.world.npcs.get(body.npcId) : undefined;
    if (!npc || !npc.alive) return reply.code(404).send({ error: '该修士不在此界或已陨落' });
    const message = (body.message ?? '').trim();
    if (!message) return reply.code(400).send({ error: '消息不能为空' });

    const genCard: LlmGenerate<CharacterCard> = (messages, schema, normalize) =>
      chatJson<CharacterCard>(messages, { schema, normalize, callType: 'world_card', sessionId: id, playerId: pid });
    const genChat: LlmGenerate<ChatReply> = (messages, schema, normalize) =>
      chatJson<ChatReply>(messages, { schema, normalize, callType: 'world_chat', sessionId: id, playerId: pid });

    // 懒加载人设卡（玩家遇到并选择才生成；生成后缓存，避免重复成本）
    let card: CharacterCard | null = npc.characterData ?? null;
    if (!card) {
      card = await generateCharacterCard(npc, loaded.engine.npcHistory(npc.id), genCard);
      if (card) {
        npc.characterData = card;
        saveWorld(id, loaded);
      }
    }
    if (!card) return reply.code(502).send({ error: '人设卡生成失败，请重试' });

    const historyKey = String(npc.id);
    const history = loaded.chatHistory[historyKey] ?? [];
    const outcome = await chatTurn(
      npc,
      card,
      loaded.engine.npcHistory(npc.id),
      history,
      message,
      genChat,
      (npcId, fact, delta) => loaded.engine.recordChat(npcId, fact, delta),
    );
    if (!outcome) return reply.code(502).send({ error: '对话失败，请重试' });

    // 多轮记忆：玩家发言 + NPC 回复写入对话历史（上限 40 轮，防无限膨胀）
    const nextHistory = [...history, { speaker: 'player' as const, text: message }, { speaker: 'npc' as const, text: outcome.reply.reply }].slice(-40);
    loaded.chatHistory[historyKey] = nextHistory;
    saveWorld(id, loaded);

    reply.send({
      npcId: npc.id,
      npcName: npc.name,
      reply: outcome.reply,
      event: outcome.event,
      affinityToPlayer: npc.affinityToPlayer,
      hasCard: !!npc.characterData,
    });
  });

  // 开始炼制：生成二消盘面（纯函数，盘面由前端持有，不落库）
  app.post('/world/:id/craft/start', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const { id } = req.params as { id: string };
    const loaded = loadWorld(id, pid);
    if (!loaded) return reply.code(404).send({ error: '世界不存在' });
    const body = (req.body ?? {}) as { recipeId?: number };
    const recipe = playerRecipes().find((r) => r.id === body.recipeId);
    if (!recipe) return reply.code(404).send({ error: '配方不存在' });
    const player = loaded.engine.world.player;
    if (!player) return reply.code(500).send({ error: '玩家未挂载' });
    if (!hasMaterials(player.backpack, recipe.materials)) {
      return reply.code(400).send({ error: `材料不足：${recipe.materials.map((m) => `${m.type}×${m.count}`).join('、')}` });
    }
    const board = newBoard(makeRng(loaded.seed ^ 0xc0ffee), WORLD_DEFAULTS.boardSize, ALL_TILES, WORLD_DEFAULTS.movesLeft);
    reply.send({
      recipeId: recipe.id,
      recipeName: recipe.name,
      outputName: recipe.outputName,
      board,
      movesLeft: WORLD_DEFAULTS.movesLeft,
    });
  });

  // 二消交换：纯函数无状态（盘面由前端传入，交换后原地返回；refill 用真实随机）
  app.post('/world/:id/craft/swap', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const body = (req.body ?? {}) as { board?: Board; x1?: number; y1?: number; x2?: number; y2?: number };
    if (!body.board || typeof body.x1 !== 'number' || typeof body.y1 !== 'number' || typeof body.x2 !== 'number' || typeof body.y2 !== 'number') {
      return reply.code(400).send({ error: '参数不完整' });
    }
    const outcome = trySwap(body.board, body.x1, body.y1, body.x2, body.y2, Math.random, ALL_TILES);
    reply.send({ board: body.board, outcome });
  });

  // 炼制结算：盘面分数 → 品质（气运加成）→ 出成品
  app.post('/world/:id/craft/finish', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const { id } = req.params as { id: string };
    const loaded = loadWorld(id, pid);
    if (!loaded) return reply.code(404).send({ error: '世界不存在' });
    const body = (req.body ?? {}) as { recipeId?: number; board?: Board };
    const recipe = playerRecipes().find((r) => r.id === body.recipeId);
    if (!recipe) return reply.code(404).send({ error: '配方不存在' });
    const player = loaded.engine.world.player;
    if (!player) return reply.code(500).send({ error: '玩家未挂载' });
    if (!body.board) return reply.code(400).send({ error: '缺少盘面' });
    const result = playerCraftResult(makeRng(loaded.seed), player, recipe, body.board, () => loaded.engine.world.nextItemId++);
    if (!result.success) return reply.code(400).send({ error: result.desc });
    saveWorld(id, loaded);
    reply.send({
      result,
      player: playerSummary(player, loaded.engine),
    });
  });

  // 删除世界
  app.delete('/world/:id', async (req, reply) => {
    const pid = requireAuth(req, reply);
    if (!pid) return;
    const { id } = req.params as { id: string };
    const r = db.prepare('UPDATE derivative_worlds SET status = ? WHERE id = ? AND player_id = ?').run('deleted', id, pid);
    if (r.changes === 0) return reply.code(404).send({ error: '世界不存在' });
    reply.send({ ok: true });
  });
}
