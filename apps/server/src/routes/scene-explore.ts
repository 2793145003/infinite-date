/**
 * 场景探索路由（新引擎）
 *
 * 探索是一次性临时场景：进入后玩家可一直 roll，每步按概率随机三种之一：
 *   - 30% 偶遇到一个角色（返回角色信息，前端确认后调 /scene/start 开正式 date）
 *   - 60% 一段环境旁白（玩家可描述行为，也可直接点"前进"）
 *   - 10% 捡到物品/彩蛋（写入 player_facts + 向量化）
 * 会话全程纯内存（explore-store），离开即结束、不落库、不恢复上次；
 * 只有探索产生的持久结果（捡到的物品）才写 player_facts。
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';
import { genId, now } from '../lib/util';
import { createExploreSession, getExploreSession, addExploreMessage, endExploreSession, exploreHistory } from '../lib/explore-store';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { chatJson, type ChatMessage } from '../llm/adapter';
import { formatCurrentTime } from '../prompt/builder';
import { embed, storeEmbedding } from '../lib/embedding';
import { getCharacterName } from '../lib/character';

// 每步概率
const P_ENCOUNTER = 0.3; // 偶遇角色
const P_NARRATION = 0.6; // 旁白
// 剩余 0.1 = 物品

interface RollResult {
  type: 'encounter' | 'narration' | 'item';
  narration?: string;
  characterId?: string;
  characterName?: string;
  isKnown?: boolean;
  itemDescription?: string;
  itemOwnerName?: string;
}

/** 环境旁白生成的 JSON schema */
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

/** 获取玩家认识的角色（有 relationship 的，排除主神） */
function getKnownChars(playerId: string): { id: string; name: string }[] {
  const rows = db.prepare(`
    SELECT DISTINCT r.character_id as id,
      COALESCE(
        (SELECT json_extract(character_data, '$.name') FROM characters WHERE id = r.character_id),
        (SELECT json_extract(character_data, '$.name') FROM character_player_data WHERE id = r.character_id)
      ) as name
    FROM relationships r
    WHERE r.player_id = ?
  `).all(playerId) as { id: string; name: string | null }[];
  return rows
    .filter(r => r.id !== 'deity' && r.name)
    .map(r => ({ id: r.id, name: r.name! }));
}

/** 获取玩家不认识的公共角色（排除主神与已有 relationship 的） */
function getUnknownChars(playerId: string): { id: string; name: string }[] {
  const knownIds = new Set(
    (db.prepare('SELECT character_id FROM relationships WHERE player_id = ?').all(playerId) as Array<{ character_id: string }>)
      .map(r => r.character_id)
  );
  const rows = db.prepare(`
    SELECT id, json_extract(character_data, '$.name') as name
    FROM characters
  `).all() as { id: string; name: string | null }[];
  return rows
    .filter(c => !knownIds.has(c.id) && c.id !== 'deity' && c.name)
    .map(c => ({ id: c.id, name: c.name! }));
}

/** 平均随机抽一个 */
function pickRandom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)] ?? null;
}

/** 玩家已发现的物品（避免重复） */
function getFoundItems(playerId: string): string[] {
  const rows = db.prepare(
    "SELECT fact FROM player_facts WHERE player_id = ? AND source = 'exploration'"
  ).all(playerId) as { fact: string }[];
  return rows.map(r => r.fact);
}

/** 写物品发现 + 向量化 */
async function recordFoundItem(playerId: string, ownerId: string, factText: string): Promise<void> {
  const factId = genId();
  const ts = now();
  db.prepare(`
    INSERT INTO player_facts (id, player_id, character_id, character_instance_id, fact, source, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'exploration', ?, ?)
  `).run(factId, playerId, ownerId, factText, ts, ts);
  const vec = await embed(factText);
  if (vec) storeEmbedding(playerId, ownerId, 'fact', factId, factText, vec);
}

/** 计算两段文本的相似度（0-1，基于字符 2-gram Jaccard）。用于检测旁白重复。 */
function textSim(a: string, b: string): number {
  const gram = (s: string) => {
    const set = new Set<string>();
    const t = s.replace(/\s+/g, '');
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = gram(a), B = gram(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 生成一段环境旁白（纯探索 / 前进 / 玩家描述行为后）
 * mode: 'system' = 进探索时的开场（每次重新生成一段独特的环境描写）
 *       'continue' = 点"逛逛"时（接着已有的旁白续写，避免同质化）
 */
async function genNarration(
  locationName: string,
  locationSummary: string,
  history: { role: string; text: string }[],
  playerInput: string | null,
  homeOwnerName?: string, // 若正在别人的家，捡到的物品应属于这位房主
  mode: 'system' | 'continue' = 'continue',
  aboutItem?: boolean, // 这一轮是"发现物品"：旁白必须描写发现的过程与物品所在，而非无关的环境
  playerId?: string,
): Promise<RollResult> {
  const tpl = mode === 'system' ? 'explore.system' : 'explore.continue';
  const systemPrompt = renderPrompt(loadPrompt(tpl), {
    location_name: locationName,
    location_summary: locationSummary,
    location_children: '',
    current_time: formatCurrentTime(),
    found_items: '（无）',
  });

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const h of history.slice(-6)) {
    messages.push({ role: h.role === 'player' ? 'user' : 'assistant', content: h.text });
  }
  if (aboutItem) {
    // 这一轮专门发现物品：旁白必须描写发现的过程与物品所在，而非无关的环境。
    messages.push({ role: 'user', content: `这一轮你会发现一样物品。请写一段旁白，描写你注意到这件物品的过程：它在什么位置（长椅上/草丛里/柜台角落/墙边……）、你是怎么发现它的、它大概是什么样子。found_item_description 必须写这同一件物品，且 narration 里要自然地提到它——让旁白和拾获的东西是同一件事，而不是旁白讲环境、物品另起一行。` });
  } else if (playerInput) {
    messages.push({ role: 'user', content: `玩家继续行动：${playerInput}. 描写接下来发生的事。` });
  } else {
    messages.push({ role: 'user', content: `玩家在原地没有额外动作。描写环境本身的动静与氛围，让场景自然流转。` });
  }
  // 在别人家探索时，若有物品，必属这家的主人
  if (homeOwnerName) {
    messages.push({ role: 'user', content: `提醒：你现在在「${homeOwnerName}」的家里。若物品栏（found_item_*）需要填，物品必须属于这家的主人「${homeOwnerName}」，不能是朝三暮四的路人或其他陌生人。` });
  }

  // 上一条旁白（用于在线去重：若新旁白与它像到几乎复述，就重写一次）
  // 注意：history 里旁白记录的 role 是 'narration'（内存 explore-history），不是 'assistant'
  const lastNarration = [...history].reverse().find(h => (h.role === 'narration' || h.role === 'assistant') && h.text)?.text ?? '';

  const run = async (forceRetry: boolean): Promise<RollResult> => {
    const msg = [...messages];
    if (forceRetry) {
      msg.push({ role: 'user', content: `注意：你刚才写的那段旁白和上一条几乎一样，重复了。请完全换一个角度、换一处细节重新写一段真正不一样、往前推进的新旁白，不要复用刚才的句式。` });
    }
    // 严格解析 + 重试：narration 必须是非空 string，否则重试 LLM；绝不把残缺 JSON 当旁白露给用户
    const parsed = await chatJson<Record<string, unknown>>(msg, {
      schema: NARRATION_SCHEMA,
      temperature: 0.9,
      maxTokens: 768,
      maxRetries: 2,
      normalize: (obj) => (typeof obj.narration === 'string' && obj.narration.trim() ? obj : null),
      callType: 'explore_narration',
      playerId,
    });
    if (!parsed) throw new Error('探索场景解析失败');
    const p = parsed as unknown as Record<string, string>;
    const narration = String(p.narration ?? '');
    const ownerId = String(p.found_item_owner_id ?? '').trim();
    const ownerName = String(p.found_item_owner_name ?? '');
    const itemDesc = String(p.found_item_description ?? '');
    const itemFact = String(p.found_item_fact ?? '');
    // 物品判定（沿用原逻辑）
    const out: RollResult = ownerId
      ? { type: 'item', narration, itemOwnerName: ownerName || '???', itemDescription: itemDesc }
      : { type: 'narration', narration };
    (out as any).__sim = lastNarration ? textSim(narration, lastNarration) : 0;
    return out;
  };

  let out = await run(false);
  // 与上一条过于相似（同质化）→ 重写一次，仍不行就退而接受
  if (!aboutItem && (out as any).__sim > 0.78) {
    out = await run(true);
  }
  delete (out as any).__sim;
  return out;
}

export async function sceneExploreRoutes(app: FastifyInstance): Promise<void> {

  // ─── 开始探索 ──────────────────────────────────────────
  app.post('/scene/explore', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { locationId } = req.body as { locationId?: string };
    if (!locationId) return reply.code(400).send({ error: '需要 locationId' });

    const loc = db.prepare('SELECT id, name, summary FROM scene_locations WHERE id = ?').get(locationId) as
      { id: string; name: string; summary: string } | undefined;
    if (!loc) return reply.code(404).send({ error: '地点不存在' });

    // 探索是一次性临时场景：每次进入都新开一场，纯内存，不落库、不恢复上次
    const session = createExploreSession(playerId, locationId);

    // 首段旁白（强制纯环境描写，不 roll）——刚进来：用 system 模板，每次重新生成一段独特的开场
    const result = await genNarration(loc.name, loc.summary, [], null, undefined, 'system', undefined, playerId);
    const openingNarration = result.narration ?? '你走进这里，环顾四周。';
    addExploreMessage(session, 'narration', openingNarration);

    return reply.send({
      exploreSessionId: session.id,
      locationId,
      locationName: loc.name,
      narration: openingNarration,
    });
  });

  // ─── 探索中 roll 一步 ─────────────────────────────────
  app.post('/scene/explore/:sessionId/step', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const { text } = req.body as { text?: string };

    const session = getExploreSession(sessionId, playerId);
    if (!session) return reply.code(404).send({ error: '探索不存在或已结束' });

    // 存玩家输入（可选）
    if (text?.trim()) {
      addExploreMessage(session, 'player', text.trim());
    }

    const loc = db.prepare('SELECT name, summary FROM scene_locations WHERE id = ?').get(session.locationId) as
      { name: string; summary: string } | undefined;
    // 若当前探索地点是某人的家：逛逛只能偶遇住这里的人、捡到的物品也只属于这里的主人。
    const residents = db.prepare(
      `SELECT h.character_id as id, json_extract(c.character_data, '$.name') as name
       FROM scene_homes h JOIN characters c ON c.id = h.character_id
       WHERE h.location_id = ?`
    ).all(session.locationId) as { id: string; name: string | null }[];
    const homeResidents = residents.filter(r => r.name).map(r => ({ id: r.id, name: r.name! }));
    const history = exploreHistory(session);

    // ── roll ─────────────────────────────────────────────
    const roll = Math.random();
    const isHome = homeResidents.length > 0; // 是否在别人家里（无物品档，有被逮到）

    // 60% 旁白（LLM 可能顺带标一件物品；但在别人家里，物品不成立——家里不"捡东西"）
    if (roll < P_NARRATION) {
      const homeOwner = homeResidents.length > 0 ? (homeResidents[0] as { id: string; name: string }) : undefined;
      const result = await genNarration(loc?.name ?? '', loc?.summary ?? '', history, text?.trim() || null, homeOwner?.name, undefined, undefined, playerId);
      // 非家：LLM 顺带标了物品也算；家：一律按旁白，不出现"捡东西/拾获"交互
      const role = (!isHome && result.type === 'item') ? 'item' : 'narration';
      addExploreMessage(session, role, result.narration ?? '');

      if (role === 'item' && result.itemDescription) {
        const itemOwnerId = homeOwner?.id ?? (db.prepare('SELECT id FROM characters LIMIT 1').get() as any)?.id;
        if (itemOwnerId) {
          await recordFoundItem(playerId, itemOwnerId, `在${loc?.name ?? '某处'}发现了物品：${result.itemDescription}`);
        }
      }

      return reply.send({
        type: role,
        narration: result.narration,
        ...(role === 'item' ? { itemDescription: result.itemDescription, itemOwnerName: homeOwner ? homeOwner.name : result.itemOwnerName } : {}),
      });
    }

    if (roll < P_NARRATION + P_ENCOUNTER) {
      // 25~30% 偶遇角色
      // 若当前探索地点是某人的家，逛逛也只能偶遇住在这里的人（不会在别人家遇到无关路人）。
      const useHomePool = homeResidents.length > 0;
      let pool: { id: string; name: string }[];
      if (useHomePool) {
        pool = homeResidents;
      } else {
        const known = getKnownChars(playerId);
        const unknown = getUnknownChars(playerId);
        pool = [...known, ...unknown];
      }
      const npc = pickRandom(pool);
      if (!npc) {
        // 无角色可遇 → 退化为旁白
        const result = await genNarration(loc?.name ?? '', loc?.summary ?? '', history, text?.trim() || null, undefined, undefined, undefined, playerId);
        addExploreMessage(session, 'narration', result.narration ?? '');
        return reply.send({ type: 'narration', narration: result.narration });
      }
      const isKnown = !!db.prepare('SELECT 1 FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, npc.id);
      const encounterNarration = isKnown
        ? `你注意到 ${npc.name} 也在这里，恰好与你相遇。`
        : `一个你不认识的身影出现在视野里。`;
      addExploreMessage(session, 'encounter', `${encounterNarration} （角色：${npc.name}）`);

      return reply.send({
        type: 'encounter',
        characterId: npc.id,
        characterName: npc.name,
        isKnown,
        narration: encounterNarration,
      });
    }

    // 10% 物品（仅非家）／ 在别人家里则是「被房主逮到」
    if (isHome) {
      // 在别人家逛久了有概率被房主逮到 → 转入特殊约会。
      const owner = homeResidents[0] as { id: string; name: string };
      const caughtNarration = `${owner.name} 回来了，正好撞见你在他家里。你被抓了个正着。`;
      addExploreMessage(session, 'caught', `${caughtNarration} （角色：${owner.name}）`);

      return reply.send({
        type: 'caught',
        characterId: owner.id,
        characterName: owner.name,
        narration: caughtNarration,
      });
    }

    // 非家：10% 物品 —— 这一轮专门发现物品，旁白必须与拾获的同一件事（让旁白和物品相关）
    const result = await genNarration(loc?.name ?? '', loc?.summary ?? '', history, text?.trim() || null, undefined, 'continue', true, playerId);
    const foundItem = result.type === 'item'
      ? { ownerName: result.itemOwnerName || '???', description: result.itemDescription || '' }
      : null;
    const finalDesc = foundItem?.description || '一件不起眼却透着灵气的小物件';
    const finalOwner = foundItem?.ownerName || '路边';
    addExploreMessage(session, 'item', result.narration ?? `你在${loc?.name ?? '这里'}发现了一样小东西。`, JSON.stringify({ found_item: true }));

    const ownerId = (db.prepare('SELECT id FROM characters LIMIT 1').get() as any)?.id;
    if (ownerId) {
      await recordFoundItem(playerId, ownerId, `在${loc?.name ?? '某处'}发现了物品：${finalDesc}`);
    }

    return reply.send({
      type: 'item',
      narration: result.narration,
      itemDescription: finalDesc,
      itemOwnerName: finalOwner,
    });
  });

  // ─── 结束探索 ─────────────────────────────────────────
  app.post('/scene/explore/:sessionId/end', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;
    const { sessionId } = req.params as { sessionId: string };
    const session = getExploreSession(sessionId, playerId);
    if (!session) return reply.code(404).send({ error: '探索不存在或已结束' });
    // 一次性临时场景：直接从内存移除，无残留
    endExploreSession(sessionId);
    return reply.send({ ok: true });
  });
}
