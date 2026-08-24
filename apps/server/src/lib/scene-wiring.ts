/**
 * scene-wiring —— 把场景引擎内核（runSceneTurnNamed）接到新 scene 表上的接线层。
 *
 * 职责：
 *  1. 从新表读场景上下文（scene_locations / npcs / scene_relationships / characters）
 *  2. 组装 runSceneTurnNamed 的 SceneTurnInput（场景 + actors）
 *  3. 调 runSceneTurnNamed 跑一轮（逐拍点名 → 演员/旁白）
 *  4. 落库：写 scene_messages（含 stats_delta）、更新 scene_sessions、写 scene_relationships、折叠 turn_memory
 *
 * 纯数据层接线，不含业务路由。对外暴露 advanceScene() 供路由调用。
 */
import { db } from '../db';
import { genId, jsonParse } from './util';
import { ensureSceneSession } from './scene-session';
import { ensureSceneMap, getNpcs, getLocationBackground, SceneNpc } from './scene-map';
import {
  runSceneTurnNamed,
  runNarration,
  SceneTurnInput,
  SceneTurnResult,
  TurnOutputItem,
  SceneBeat,
} from './run-scene-turn';
import { getCharacterName } from './character';
import { overrideSceneScheduleToLocation } from './schedule';

/**
 * 清洗 LLM 生成的 NPC 台词里的「游离（不配对）右闭符号」。
 *
 * 背景：Gemma 在生成台词时偶发在句尾多补一个孤立的右括号/右引号（如 `…躯壳。）`
 * 或 `…响应。”`），因为 JSON schema 只校验字符串类型、管不着内容里的字符配对，
 * 于是这种「多出一个右闭符号」会原样落库、污染展示。
 *
 * 规则（只修游离、绝不碰成对）：
 *   统计全串中 `（`/`）`、`“`/`”` 各自的左右数量。
 *   若右闭符号数量 > 左开符号数量，说明存在「多余」的右闭符号，
 *   从字符串末尾开始，把多出来的那几个右闭符号删掉。
 *   —— 因为「游离」的右闭符号几乎总是出现在句尾。
 *   成对的（`（他…）`、`“话”`）左右数量相等，完全不触发，零误伤。
 *
 * 只用于 NPC 台词；玩家消息（用户原话）与旁白不清洗。
 * 纯函数，无副作用，可安全用于落库前的增量清洗与存量数据回刷。
 */
export { cleanStraySymbols } from './clean-text';
import { cleanStraySymbols } from './clean-text';
import { loadGreetingSection } from '../prompt/loader';
import { buildAllActorMemories } from './memory-wiring';
import { runTurnMemoryUpdate, TurnLine, TurnMemoryInput } from './turn-memory';
import { buildCharacterCard } from './character-card';
import { captureStartSnapshot, captureRoundSnapshot } from './scene-rollback';
import { chat, tryParseJsonReply, ChatMessage } from '../llm/adapter';
import { loadPrompt, renderPrompt } from '../prompt/loader';
import { embed, storeEmbedding } from './embedding';

const HUB_WORLD_ID = 'default-world';

/**
 * 喂给导演/演员的「对话历史」滑窗条数：只保留最近 N 条场景消息，更早的内容交给
 * chronicle_summary / retrieved_memories 等记忆摘要兜底，避免把整场全量对话平铺进
 * actor 的 prompt 导致上下文无限增长（曾引发超 max_model_len → actor 生成失败 → 玩家无回复）。
 */
const CONVERSATION_WINDOW = 30;

// ─── 类型 ─────────────────────────────────────────────

export interface SceneActorSource {
  /** actor 键（导演输出里匹配的名字）；建议用角色名 */
  key: string;
  characterId: string;
  characterName: string;
}

export interface AdvanceSceneResult {
  sessionId: string;
  roundNo: number;
  output: TurnOutputItem[];
  statsState: Record<string, number>;
  statsChangesOverall: { name: string; before: number; after: number }[];
  playerDescription: string | null;
  currentActivity: string | null;
  /** 本轮结束后会话所在的地点 id（move 后更新） */
  locationId: string | null;
  /** 本轮结束后会话所在的地点名（顶栏用） */
  locationName: string;
  /** 本轮结束后会话所在的地点背景图文件名（uploads/；空 = 无背景） */
  locationBackground: string;
}

// ─── 任务 NPC 定位 ─────────────────────────────────────

/** 任务 NPC 的定位：按 role 映射成角色视角的一句话，不用「贵人/对手」剧作词。role 缺失时按普通居民兜底。 */
function roleStance(role: string, playerName: string): string {
  const map: Record<string, string> = {
    '任务核心对象': '你就是这个困境里陷得最深、最需要被拉一把的那个人。',
    '贵人': `你愿意帮 ${playerName} 一把——按你的性格和立场，你会主动搭手。`,
    '靠山': `你平时不显眼，但紧要关头能实打实地帮上 ${playerName}。`,
    '对手': `你对 ${playerName} 这些外来者不信任、有戒心，不会轻易配合。`,
    '竞争者': `你和 ${playerName} 在争同一件事，但未必是敌人。`,
    '所求之人': `你就是 ${playerName} 这次要找、要见的那个人。`,
  };
  const stance = map[role] ?? `你是这个世界的居民，${playerName} 是来帮助这个世界（和这里的人）的，按你的立场自然地向他们求助或配合。`;
  return stance + '注意保持角色人设。';
}

/**
 * 任务场景：按「常在地点 place」过滤世界 NPC——只有 place 等于当前地点名（或没写 place）的 NPC 才在场。
 * 否则"人还在栖霞竹苑、玩家在路上却已把她拉进对话"——出场时机错位，NPC 会串成跟着主角赶路的人。
 */
function filterNpcsByPlace(npcs: SceneNpc[], currentLocationId: string | null | undefined): SceneNpc[] {
  const curName = currentLocationId
    ? (db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(currentLocationId) as { name?: string } | undefined)?.name ?? ''
    : '';
  if (!curName) return npcs; // 拿不到当前地点名，不过滤（兜底，保持原行为）
  return npcs.filter((n) => !n.place || n.place === curName);
}

// ─── 玩家画像 ─────────────────────────────────────────

/**
 * 组装玩家画像：昵称/性别/外貌自设（players 表）+ 玩家事实（player_facts/turn_player_facts）。
 */
function buildPlayerProfile(playerId: string): { playerName: string; profile: string } {
  const p = db.prepare(
    'SELECT name, pronouns, gender, appearance, persona_notes FROM players WHERE id = ?'
  ).get(playerId) as any;
  const genderText = p?.gender === 'female' ? '女' : p?.gender === 'male' ? '男' : '';
  const playerName = p?.name || '玩家';
  const nameLabel = genderText ? `${playerName}（${genderText}性）` : playerName;
  const parts: string[] = [];
  if (p?.gender) {
    parts.push(`性别：${genderText}`);
  }
  if (p?.appearance) parts.push(`外貌：${p.appearance}`);
  if (p?.pronouns) parts.push(`称呼：${p.pronouns}`);
  if (p?.persona_notes) parts.push(`自设：${p.persona_notes}`);
  // 玩家昵称要存在，但必须明确它是「对面的人」：以昵称作为信息区块标题，紧跟其属性，
  // 这样模型认出「知欣」是要面对的人，而不是把它当成自己或别的角色。
  const hasRealName = playerName && playerName !== 'Player' && playerName !== '玩家';
  if (hasRealName && parts.length) {
    return { playerName: nameLabel, profile: `【${nameLabel}的信息】\n${parts.join('\n')}` };
  }
  return { playerName: nameLabel, profile: parts.join('\n') || `（玩家「${playerName}」）` };
}

// ─── 场景上下文组装 ──────────────────────────────────

interface SceneContext {
  location: string;
  locationName: string;
  locationDesc: string;    // 地点介绍(summary)——供演员贴合地点开口
  tone: string;
  rules: string;
  companions: string;
  companionsRaw: string;      // 真实在场角色列表（无 locationName 兜底），供 actor 判断谁同场
  residentNpcs: string;      // 路段人口述（包含到场路人描述）
  sceneRelations: string;
  playerDescriptions: string;
  conversationSoFar: string;
  hasPlayerSpoken: boolean;
  availableLocations: string;  // 层级化地点导航（供导演/namer move 决策）
}

/**
 * 构建层级化地点导航文本，给导演/namer 看"我在哪、这里面有什么、能去哪、能回到哪"。
 * 替代旧的全表扁平顿号列表——那个 54 个地点一长串，导演根本分不清层级关系。
 *
 * 可见性过滤：只显示公开地点 + 玩家自己创建的私有地点，他人私有地点不出现。
 * 角色家始终包含：无论当前在哪，参与角色的家地点都列在【可前往】中，
 *   让"带我回家"这类自然请求有目标可 move。
 *
 * 输出格式：
 *   【当前地点】林溯家
 *   【内部区域】卧室、浴室、琴房、餐厅
 *   【同层可前往】云枢资本集团总部、星海购物中心、穆昭的家…
 *   【可前往】穆昭的家、林溯家、冷惊尘家…
 *   【可回到】云枢市（镜像）
 */
function buildHierarchicalLocations(
  currentLocId: string | null,
  playerId: string,
  characterIds: string[],
): string {
  const visFilter = `AND (is_public = 1 OR creator_id = ?)`;

  if (!currentLocId) {
    // 无当前地点（极端兜底）：返回所有根地点
    const roots = db.prepare(
      `SELECT name FROM scene_locations WHERE world_id = ? AND parent_id IS NULL AND id NOT LIKE 'temp-%' ${visFilter} ORDER BY name`
    ).all(HUB_WORLD_ID, playerId) as { name: string }[];
    return `【可前往】${roots.map(r => r.name).join('、')}`;
  }

  const cur = db.prepare('SELECT name, parent_id FROM scene_locations WHERE id = ?').get(currentLocId) as { name: string; parent_id: string | null } | undefined;
  if (!cur) return '（无地点信息）';

  const parts: string[] = [];
  parts.push(`【当前地点】${cur.name}`);

  // 子节点（当前地点内部区域）
  const children = db.prepare(
    `SELECT name FROM scene_locations WHERE parent_id = ? AND id NOT LIKE 'temp-%' ${visFilter} ORDER BY name`
  ).all(currentLocId, playerId) as { name: string }[];
  if (children.length) {
    parts.push(`【内部区域】${children.map(r => r.name).join('、')}`);
  }

  // 同层地点（同 parent_id，排除自己、排除 temp）
  const siblings = db.prepare(
    `SELECT name FROM scene_locations WHERE parent_id IS ? AND id != ? AND id NOT LIKE 'temp-%' ${visFilter} ORDER BY name`
  ).all(cur.parent_id, currentLocId, playerId) as { name: string }[];
  if (siblings.length) {
    const label = cur.parent_id ? '【同层可前往】' : '【可前往】';
    parts.push(`${label}${siblings.map(r => r.name).join('、')}`);
  }

  // 角色家：无论当前在哪，参与角色的家始终可作为 move 目标
  if (characterIds.length) {
    const placeholders = characterIds.map(() => '?').join(',');
    const homes = db.prepare(
      `SELECT sl.name FROM scene_locations sl
       JOIN scene_homes sh ON sh.location_id = sl.id
       WHERE sh.character_id IN (${placeholders}) AND sl.id != ? AND sl.id NOT LIKE 'temp-%'
       ORDER BY sl.name`
    ).all(...characterIds, currentLocId) as { name: string }[];
    if (homes.length) {
      parts.push(`【可前往】${homes.map(r => r.name).join('、')}`);
    }
  }

  // 父节点（可回到）
  if (cur.parent_id) {
    const parent = db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(cur.parent_id) as { name: string } | undefined;
    if (parent) parts.push(`【可回到】${parent.name}`);
  }

  return parts.join('\n');
}

/**
 * 从 scene_sessions + scene_locations 组装场景上下文。
 */
function buildSceneContext(session: any): SceneContext {
  // ── 剧本模式：不依赖 scene_locations，用世界观描述驱动 ──
  if (session.scene_type === 'scenario') {
    return buildScenarioSceneContext(session);
  }
  ensureSceneMap();
  // 地点：优先用 move 后的 current_location_id，回退到起始 root_location_id
  const effLocId = session.current_location_id || session.root_location_id;
  const loc = db.prepare(
    'SELECT name, summary, npcs FROM scene_locations WHERE id = ?'
  ).get(effLocId) as any;
  const locationName = loc?.name || '某个地方';
  const summary = loc?.summary || '';

  // 路人（地点在场的固定工具人）
  // 任务场景：世界 NPC 挂根地点、始终在场，不随 move 走（move 只是换地点背景，NPC 不是"到了才刷新"）；
  // 约会场景：随当前地点走。
  let residentNpcs = '';
  const npcLocId = session.scene_type === 'mission' ? (session.root_location_id || effLocId) : effLocId;
  const npcLoc = npcLocId === effLocId ? loc : db.prepare('SELECT npcs FROM scene_locations WHERE id = ?').get(npcLocId) as any;
  if (npcLoc?.npcs) {
    let npcs = jsonParse<SceneNpc[]>(npcLoc.npcs, []);
    if (session.scene_type === 'mission') npcs = filterNpcsByPlace(npcs, session.current_location_id);
    if (npcs.length) {
      residentNpcs = npcs
        .map((n) => `${n.name}（${n.role}）：${n.persona}`)
        .join('\n');
    }
  }

  // 参与角色
  const characterIds = jsonParse<string[]>(session.character_ids, []);
  const companions = characterIds
    .map((cid) => `${getCharacterName(cid)}（角色）`)
    .join('、');

  // 场景基调/规则（用地点 summary + 固定 tone/rules）
  let tone = summary ? `地点氛围：${summary}` : '温馨放松';
  let rules = '注意保持角色人设，推进关系自然。';

  // 任务模式：注入任务世界观（世界困境）+ 目标（目标态）+ 开局情境
  if (session.scene_type === 'mission') {
    const worldview = session.worldview || '';
    const playerRole = session.player_role || '';
    const npcRoles = parseNpcRoles(session.npc_roles);
    const goal = session.goal || '';
    const openingScene = session.opening_scene || '';
    // 玩家昵称：避免"玩家/男主"这类剧作术语——小模型不知道"男主"是什么，一律用名字/角色视角描述指代
    const playerNickname = (db.prepare('SELECT name FROM players WHERE id = ?').get(session.player_id) as any)?.name || '';
    if (worldview) {
      tone = `任务世界：${worldview}` + (summary ? `\n地点氛围：${summary}` : '');
    }
    const missionRules: string[] = [];
    const mainName = playerNickname || '对方';
    if (playerRole) missionRules.push(`来帮助这个世界的人：${playerRole.replace(/你/g, mainName)}`);
    if (npcRoles.length) {
      // male_lead 视角可能用"他"指男主，注入演员 prompt 时"他"指代男主自己，改写为男主名（兜底；accept 落库已清洗，这里防旧数据/漏网）
      const companionName = characterIds.length ? (getCharacterName(characterIds[0]!) ?? '') : '';
      missionRules.push(npcRoles.map((r) => {
        const desc = companionName ? r.description.replace(/他|她/g, companionName) : r.description;
        // 去掉 desc 开头的「{男主名}是」，避免与元认知前缀连读成「方知衡是…方知衡是」病句
        const body = companionName && desc.startsWith(companionName)
          ? desc.slice(companionName.length).replace(/^是/, '')
          : desc;
        return `同行的同伴：${companionName} 是主城的 NPC，和 ${mainName} 一起降临到这个世界，降临身份是——${body}`;
      }).join('\n'));
    }
    if (goal) missionRules.push(`任务目标：${goal}`);
    if (openingScene) missionRules.push(`开局情境：${openingScene}`);
    missionRules.push(`这是任务世界：${mainName}是降临到此、来帮助这个世界（或世界里的人）走向目标态的人。`);
    rules = missionRules.join('\n');
  }

  // 特殊开场情境：被房主逮到（caught） / 玩家走近被注意到（approach） —— 从 scene.greeting 模板按情境取
  let circumstancePrefix = '';
  const circumstance = (session.circumstance as string) || '';
  if (circumstance) {
    const greeting = loadGreetingSection(circumstance, {
      companions,
      location: locationName,
    });
    // 模板正文即情境开场指引（rules 给导演），并把情境描述也注入对话前缀（供演员感知当下情境）
    rules = greeting;
    circumstancePrefix = greeting;
    if (circumstance === 'caught') {
      tone = `地点氛围：${summary}。这是一个紧张的、略带尴尬的瞬间——你被这家的主人撞见了。`;
    } else if (circumstance === 'approach') {
      tone = `地点氛围：${summary}。这是一次自然相遇——你只是正常路过，对方主动注意到了你、主动向你走来开口搭话。你是被接近的一方，不是打扰者。`;
    } else if (circumstance === 'invite') {
      tone = `地点氛围：${summary}。这是一场赴约——玩家主动邀请了在场角色来${locationName}见面，他们各自应约而来，是为此专门赶来的。`;
    } else if (circumstance === 'npc_invite') {
      tone = `地点氛围：${summary}。这是一场赴约——是在场角色主动邀请玩家来${locationName}见面的，玩家是被邀请方，是为此专门赶来的。`;
    } else if (circumstance === 'deity_pick') {
      tone = `地点氛围：${summary}。这是一场突如其来的相遇——在场角色被主神随机抽中传送来这里，他们自己都有点莫名其妙，并不是主动要来的。`;
    }
  }

  // 关系 + 玩家视角描述：读 scene_relationships（玩家对该角色的当前描述 + 当前活动）
  let playerDescriptions = '';
  let sceneRelations = '';
  if (characterIds.length) {
    sceneRelations = characterIds
      .map((cid) => getCharacterName(cid))
      .join('、') + ' 是本次共同在场的角色。';
    playerDescriptions = characterIds
      .map((cid) => {
        const rel = db.prepare(
          'SELECT player_description, current_activity FROM scene_relationships WHERE player_id = ? AND character_id = ? ORDER BY updated_at DESC LIMIT 1'
        ).get(session.player_id, cid) as any;
        const name = getCharacterName(cid);
        const desc = rel?.player_description
          ? `${name}：${rel.player_description}`
          : `${name}：刚认识的${name}`;
        const act = rel?.current_activity ? `（当前活动：${rel.current_activity}）` : '';
        return desc + act;
      })
      .join('\n');
  }

  // 历史对话（上一轮 scene_messages）—— 滑窗:只保留最近 CONVERSATION_WINDOW 条,
  // 更早的内容交给 chronicle_summary / retrieved_memories 记忆摘要兜底,避免全量平铺导致 actor 上下文超长
  // ⚠️ 必须取「最近」N 条：先按时间倒序 LIMIT N 截出最新 N 条，再按时间正序返回，
  //    这样导演/演员看到的收尾是「玩家刚说的话 + 最近几拍」，而不是被开场旧旁白/旧独白钉死。
  //    旧写法 `ORDER BY round_no,created_at LIMIT N` 取的是最旧 N 条 → 最新玩家话永远进不来
  //    → 旁白死盯开场酒杯、角色顺着旧独白自说自话（2026-08-07 修复）。
  const convRowsRaw = db.prepare(
    'SELECT role, character_name, character_id, text FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no DESC, created_at DESC LIMIT ?'
  ).all(session.id, CONVERSATION_WINDOW) as any[];
  const hasPlayerSpoken = !!convRowsRaw.find((r) => r.role === 'player');
  // 倒序取完再反转回时间正序，保证对话顺序连贯
  const convRows = convRowsRaw.reverse();
  // 历史对话名统一映射到当前名：落库 character_name 是导演当时的 speaker（可能是改名前旧名），
  // 若带 character_id 则用 getCharacterName 取实时当前名，避免导演看到新旧名并存 → 抄旧名导致演员失声/说旧名
  const conversationSoFar = convRows
    .map((r) => {
      if (r.role === 'narration') return `（旁白）${r.text}`;
      const currentName = r.character_id ? getCharacterName(r.character_id) : r.character_name;
      return `${currentName}：${r.text}`;
    })
    .join('\n');

  return {
    location: locationName,
    locationName,
    locationDesc: summary,
    tone,
    rules,
    companions: companions || locationName,
    companionsRaw: companions,
    residentNpcs,
    sceneRelations,
    playerDescriptions,
    conversationSoFar: circumstancePrefix ? circumstancePrefix + '\\n' + conversationSoFar : conversationSoFar,
    hasPlayerSpoken,
    // 层级化地点导航：给导演/namer 看"我在哪、这里面有什么、能去哪、能回到哪"
    availableLocations: buildHierarchicalLocations(effLocId, session.player_id, characterIds),
  };
}

/**
 * 剧本模式上下文：不依赖 scene_locations，用世界观/身份/目标/开场情境驱动。
 * scene_type='scenario' 时调用。
 */
function buildScenarioSceneContext(session: any): SceneContext {
  const characterIds = jsonParse<string[]>(session.character_ids, []);
  const companions = characterIds
    .map((cid) => `${getCharacterName(cid)}（角色）`)
    .join('、');

  const worldview = session.worldview || '';
  const playerRole = session.player_role || '';
  const npcRolesRaw = parseNpcRoles(session.npc_roles);
  const goal = session.goal || '';
  const openingScene = session.opening_scene || '';

  // tone：世界观氛围
  const tone = worldview ? `世界观：${worldview}` : '';

  // rules：玩家身份 + NPC身份 + 目标 + 开场情境
  const rulesParts: string[] = [];
  if (playerRole) rulesParts.push(`玩家身份：${playerRole}`);
  if (npcRolesRaw.length) {
    rulesParts.push(npcRolesRaw.map((r, i) => `NPC${i + 1}身份：${r.identity || '未设置'} —— ${r.description}`).join('\n'));
  } else if (companions) {
    rulesParts.push(`NPC身份：由在场角色的人设决定，但处于场景设定中`);
  }
  if (goal) rulesParts.push(`目标：${goal}`);
  rulesParts.push('注意：角色在场景中的身份是对原人设的情境化应用，不改变角色本质性格。');
  const rules = rulesParts.join('\n');

  // 关系 + 玩家描述（复用普通约会的逻辑，读 scene_relationships）
  let playerDescriptions = '';
  let sceneRelations = '';
  if (characterIds.length) {
    sceneRelations = characterIds
      .map((cid) => getCharacterName(cid))
      .join('、') + ' 是本次场景中在场的角色。';
    playerDescriptions = characterIds
      .map((cid) => {
        const rel = db.prepare(
          'SELECT player_description, current_activity FROM scene_relationships WHERE player_id = ? AND character_id = ? ORDER BY updated_at DESC LIMIT 1'
        ).get(session.player_id, cid) as any;
        const name = getCharacterName(cid);
        const desc = rel?.player_description
          ? `${name}：${rel.player_description}`
          : `${name}：刚认识的${name}`;
        const act = rel?.current_activity ? `（当前活动：${rel.current_activity}）` : '';
        return desc + act;
      })
      .join('\n');
  }

  // 历史对话（同普通约会逻辑）
  const convRowsRaw = db.prepare(
    'SELECT role, character_name, character_id, text FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no DESC, created_at DESC LIMIT ?'
  ).all(session.id, CONVERSATION_WINDOW) as any[];
  const hasPlayerSpoken = !!convRowsRaw.find((r) => r.role === 'player');
  const convRows = convRowsRaw.reverse();
  const conversationSoFar = convRows
    .map((r) => {
      if (r.role === 'narration') return `（旁白）${r.text}`;
      const currentName = r.character_id ? getCharacterName(r.character_id) : r.character_name;
      return `${currentName}：${r.text}`;
    })
    .join('\n');

  // 开场情境作为前缀（类似普通约会的 circumstancePrefix）
  const circumstancePrefix = openingScene ? `（开场情境）${openingScene}` : '';

  return {
    location: '',
    locationName: '',
    locationDesc: worldview,
    tone,
    rules,
    companions: companions || '在场角色',
    companionsRaw: companions,
    residentNpcs: '',       // 剧本无地点路人
    sceneRelations,
    playerDescriptions,
    conversationSoFar: circumstancePrefix ? circumstancePrefix + '\\n' + conversationSoFar : conversationSoFar,
    hasPlayerSpoken,
    availableLocations: '',  // 剧本禁用 move
  };
}

/**
 * 计算距离场景上一次互动的时长（人类可读）。用于让导演/演员感知"时间流逝、时段/天色已变"，
 * 避免被开场时刻（如凌晨 greeting）的语境带偏成"还以为是清晨"。
 * 无明显间隔（<30 分钟）返回空串（交给导演别强调时间）。
 */
function computeTimeElapsed(sessionId: string, nowTs: number): string {
  const last = db.prepare(
    'SELECT MAX(created_at) AS t FROM scene_messages WHERE scene_session_id = ?'
  ).get(sessionId) as { t: number | null } | undefined;
  if (!last?.t) return ''; // 尚无任何消息（开场前）
  const elapsed = Math.floor((nowTs - last.t) / 1000); // 秒
  if (elapsed < 1800) return ''; // <30 分钟，视为连续互动，不强调时间
  const mins = Math.floor(elapsed / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `已过去${days}天${hours % 24}小时`;
  if (hours >= 1) return `已过去${hours}小时${mins % 60}分`;
  return `已过去${mins}分钟`;
}

// ─── 主入口：跑一轮并落库 ────────────────────────────

/**
 * 场景引擎：点名版（named）。
 * 旧导演版（director）已移除，统一使用点名版。
 */
export function getSceneEngine(): 'named' {
  return 'named';
}

export async function advanceScene(
  playerId: string,
  sessionId: string,
  playerMessage?: string,
  opts?: {
    onLog?: (s: string) => void;
    quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string };
    /** 逐拍回调：每生成完一拍触发，用于流式推送。 */
    onBeat?: (b: TurnOutputItem) => void;
    /** 导演回调：导演编排完分镜（开始逐拍前）触发一次，用于把导演计划推给前端。 */
    onDirector?: (beats: SceneBeat[]) => void;
    /** 引擎选择：'director'（默认，现有导演一次排 beats）| 'named'（点名版逐拍点名）。 */
    engine?: 'director' | 'named';
    /**
     * 重试轮标记：retry 路径回退到该轮开始前、保留玩家发言后重新生成回复时传 true。
     * 此时虽无"本轮新发"的 playerMessage，但语义上仍在回应玩家上一条发言——
     * 须让它参与"玩家发了话必须有男主回应"的兜底判断，否则重试轮可能只排路人就收尾、男主沉默。
     */
    regenerate?: boolean;
  },
): Promise<AdvanceSceneResult> {
  ensureSceneSession();
  ensureSceneMap();
  const log = opts?.onLog ?? (() => {});
  const quote = opts?.quote ?? null;

  // 重试/继续空推轮（本轮无新玩家发言）：从 DB 读玩家最后一条消息，
  // 用于 ① 引用上下文（仅重试 regenerate）② 记忆折叠输入（重试+继续）。
  // 只借文本/引用，绝不落库玩家消息（上一轮已落库，避免多出一条）。
  const lastPlayerRow = (!playerMessage || !playerMessage.trim())
    ? db.prepare(
        "SELECT text, quote FROM scene_messages WHERE scene_session_id = ? AND role = 'player' ORDER BY round_no DESC, created_at DESC LIMIT 1"
      ).get(sessionId) as { text: string; quote: string | null } | undefined
    : undefined;
  // 重试重新生成「回应玩家上一条发言」时补回引用上下文（正常 advance 由 opts.quote 传入）
  const effectiveQuote = quote ?? (opts?.regenerate && lastPlayerRow?.quote
    ? (jsonParse(lastPlayerRow.quote, null) as { quoteId?: string; quoteText?: string; quoteSenderName?: string } | null)
    : null);

  // 1) 读会话
  const session = db.prepare(
    'SELECT * FROM scene_sessions WHERE id = ? AND player_id = ?'
  ).get(sessionId, playerId) as any;
  if (!session) throw new Error('场景会话不存在');
  if (session.ended) throw new Error('场景已结束');

  // 2) 玩家画像 + 场景上下文
  const { playerName, profile } = buildPlayerProfile(playerId);
  const sceneCtx = buildSceneContext(session);

  // 3) 组装 actors
  const characterIds = jsonParse<string[]>(session.character_ids, []);
  if (!characterIds.length) throw new Error('场景没有参与者');

  // 收集热窗（最近几轮原文）供 buildActorMemories —— 简化：用历史对话
  const hotRows = db.prepare(
    'SELECT role, character_name, text, round_no FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no DESC, created_at DESC LIMIT 20'
  ).all(sessionId) as any[];

  const actorsBase: Record<string, { character_id: string; hotWindowRounds: TurnLine[][] }> = {};
  const actorOrder: SceneActorSource[] = [];
  for (const cid of characterIds) {
    const name = getCharacterName(cid);
    const key = name;
    actorsBase[key] = {
      character_id: cid,
      hotWindowRounds: hotRows
        .filter((r) => r.character_name === name || r.character_id === cid)
        .map((r) => [
          {
            role: r.role === 'player' ? 'player' : name, // 一律用当前名，避免改名后历史旧名污染演员记忆
            text: r.text,
          },
        ]),
    };
    actorOrder.push({ key, characterId: cid, characterName: name });
  }

  // 地点的常驻路人同样作为可出场演员（导演会编排他们，必须真有演员上下文，否则空拍造成主角连拍）
  // 路人随「当前地点」走：移动后换成新地点的路人，旧地点的路人自然退场。
  // 主角（character_ids）不受此影响，始终跟着玩家。
  // 剧本模式无地点概念，跳过路人。
  const isScenario = session.scene_type === 'scenario';
  const rNpcs = isScenario ? [] : (session.scene_type === 'mission'
    ? filterNpcsByPlace(getNpcs(session.root_location_id || session.current_location_id || ''), session.current_location_id)  // 任务场景：世界 NPC 挂根地点，按常在地点 place 过滤——只有人在当前地点才在场
    : getNpcs(session.current_location_id || session.root_location_id));
  for (const n of rNpcs) {
    const key = n.name;
    if (actorsBase[key]) continue; // 与主角重名则跳过
    actorsBase[key] = {
      character_id: n.id,
      hotWindowRounds: hotRows
        .filter((r) => r.character_name === n.name || r.character_id === n.id)
        .map((r) => [
          {
            role: r.role === 'player' ? 'player' : n.name, // 一律用当前名
            text: r.text,
          },
        ]),
    };
    actorOrder.push({ key, characterId: n.id, characterName: n.name });
  }

  // 4) 组装每个 actor 的记忆上下文
  // 场景上下文摘要：地点名 + 地点描述 + 情境基调，拼进记忆检索 query
  const sceneCtxForMemory = [
    sceneCtx.locationName,
    sceneCtx.locationDesc,
    sceneCtx.tone,
  ].filter(Boolean).join(' ');

  const mems = await buildAllActorMemories({
    sceneSessionId: sessionId,
    playerId,
    playerName,
    playerMessage: playerMessage ?? undefined,
    sceneContext: sceneCtxForMemory,
    actors: actorsBase,
  });

  const actors: SceneTurnInput['actors'] = {};
  const npcById = new Map(rNpcs.map((n) => [n.id, n]));
  // 任务场景：同伴（男主）与任务 NPC 立场不同，逐人注入各自那句，不写「若你是……」让模型自己猜
  const isMission = session.scene_type === 'mission';
  for (const a of actorOrder) {
    let actorCurrentActivity = '';
    const npc = npcById.get(a.characterId);
    let stance = '';
    if (isMission) {
      if (npc) {
        // 任务 NPC：role 定位 + 第一人称关系定位（我在哪、来找我的是谁），
        // 让她清楚自己的位置和面对的人，不被"跟着主角走"的对话历史带跑。
        const playerNickname = (db.prepare('SELECT name FROM players WHERE id = ?').get(playerId) as any)?.name || playerName;
        const companionName = characterIds.length ? (getCharacterName(characterIds[0]!) ?? '') : '';
        const npcRoles = parseNpcRoles(session.npc_roles);
        const who: string[] = [];
        if (session.player_role) who.push(`${playerNickname}（${session.player_role.replace(/你/g, playerNickname)}）`);
        if (npcRoles.length && companionName) {
          const d = npcRoles[0]!.description.replace(/他|她/g, companionName);
          const body = companionName && d.startsWith(companionName) ? d.slice(companionName.length).replace(/^是/, '') : d;
          who.push(`${companionName}（${body}）`);
        }
        const relationLine = who.length ? `\n来找你的/跟着一起来的人：${who.join('；')}。` : '';
        stance = roleStance(npc.role, playerName)
          + (npc.place ? `\n你此刻人在「${npc.place}」，就在你自己该在的地方，没有在赶路。` : '')
          + relationLine;
      } else {
        // 男主：先看任务世界的人物名单（只有名字+人设，不给 role，六亲关系仍隐藏），再给同伴立场
        const npcList = rNpcs.map((n) => `${n.name}：${n.persona}`).join('\n');
        // 男主只握「人际情报」（谁可能知道内情），不握「真相」——卡关时揪出知情者，而不是自己泄底。
        const intelNames = rNpcs.filter((n) => n.clues?.length).map((n) => n.name);
        const intelLine = intelNames.length
          ? `你隐约觉得 ${intelNames.join('、')} 这些人可能知道些内情（但你自己并不清楚具体真相是什么）。`
          : '';
        stance = `【任务世界的这些人】\n${npcList}\n\n你是和 ${playerName} 一起从主城降临到这里的 NPC 同伴，陪 ${playerName} 一起推进这件事，把这个世界引向目标态。注意保持角色人设。${intelLine ? `\n\n【你对这些人的直觉】${intelLine} 当 ${playerName} 卡住、原地兜圈子时，你可以凭直觉揪出那个可能知情的人——带 ${playerName} 去找他、替他追问、或点一句「这事儿，怕得问 XX」。不要直接把真相说出来，因为你也不知道。` : ''}`;
      }
    }
    actors[a.key] = {
      character_id: a.characterId,
      character_name: a.characterName,
      character_card: npc
        ? (isMission
          // 任务世界 NPC：不是"常驻路人打圆场"，而是这个世界的居民/角色——你是谁、你的处境、你人在哪。
          ? `【角色】${npc.name}\n【你是什么人】${npc.persona}${npc.role ? `\n【你的处境】${npc.role}` : ''}${npc.place ? `\n【你此刻人在】${npc.place}` : ''}${npc.clues?.length ? `\n【你心里知道的事】${npc.clues.join('；')}\n（这是你藏着、但不轻易全说的事：对方问到了、或话题自然触及了，你才淡淡透露一点；不要一上来就全盘托出，也不要死咬不说。）` : ''}`
          // 约会场景路人：常驻者，自然接话打圆场
          : `【角色】${npc.name}（本地的常驻人物）\n【人设/职责】${npc.persona}\n（你是这里的常驻者，平时在玩家和主角身边自然活动，接话、引话题、打圆场都自然）${npc.clues?.length ? `\n【你心里知道的事】${npc.clues.join('；')}\n（这是你藏着、但不轻易全说的事：对方问到了、或话题自然触及了，你才淡淡透露一点；不要一上来就全盘托出，也不要死咬不说。）` : ''}`)
        : buildCharacterCard(playerId, a.characterId),
      player_profile: profile,
      player_description: npc
        ? '常驻在此的熟面孔'
        : (() => {
            const rel = db.prepare(
              'SELECT player_description, current_activity FROM scene_relationships WHERE player_id = ? AND character_id = ? ORDER BY updated_at DESC LIMIT 1'
            ).get(playerId, a.characterId) as any;
            actorCurrentActivity = rel?.current_activity ?? '';
            return rel?.player_description ?? '刚认识的陌生人';
          })(),
      current_activity: npc ? '' : actorCurrentActivity,
      chronicle_summary: mems[a.key]?.chronicle_summary ?? '',
      retrieved_memories: mems[a.key]?.retrieved_memories ?? '',
      stance,
    };
  }

  // 5) 组装 SceneTurnInput
  const curStats = jsonParse<Record<string, number>>(session.stats_state, {});
  // 导演共享的角色记忆：把每个非路人在场角色的记忆汇总给导演（导演据此安排戏份，让角色主动提起/呼应往事）
  // 入参来自步骤4 buildAllActorMemories（到上轮为止的 chronicle_summary 三层记忆 + retrieved_memories 语义检索）。
  const npcIdSet = new Set(rNpcs.map((n) => n.id));
  const sceneMemoryParts: string[] = [];
  for (const a of actorOrder) {
    if (npcIdSet.has(a.characterId)) continue; // 跳过常驻路人（导演不需它们的长线记忆）
    const m = mems[a.key];
    if (!m) continue;
    const lines: string[] = [];
    if (m.chronicle_summary && m.chronicle_summary !== '（尚无历史记忆）') lines.push(m.chronicle_summary);
    if (m.retrieved_memories) lines.push(m.retrieved_memories);
    if (lines.length) sceneMemoryParts.push(`【${a.characterName}记得的】\n${lines.join('\n\n')}`);
  }
  const scene_memory = sceneMemoryParts.join('\n\n');
  const input: SceneTurnInput = {
    scene: {
      location: sceneCtx.location,
      location_desc: sceneCtx.locationDesc,
      scene_tone: sceneCtx.tone,
      scene_rules: sceneCtx.rules,
      companions: sceneCtx.companions,
      companions_raw: sceneCtx.companionsRaw,
      resident_npcs: sceneCtx.residentNpcs,
      scene_relations: sceneCtx.sceneRelations,
      player_descriptions: sceneCtx.playerDescriptions,
      available_locations: sceneCtx.availableLocations,
      // conversation_so_far 只含纯历史（上一轮已落库消息），不做任何格式拼装。
      // 玩家本条新话、引用的历史消息均以原始字段随下游传递，由 runActor（说话那一刻）统一拼装格式。
      conversation_so_far: sceneCtx.conversationSoFar,
      player_message: playerMessage,
      quote: effectiveQuote ? { quoteText: effectiveQuote.quoteText, quoteSenderName: effectiveQuote.quoteSenderName } : undefined,
      has_player_spoken: sceneCtx.hasPlayerSpoken,
      player_name: playerName,
      circumstance: session.circumstance ?? undefined,
      scene_memory,
      time_elapsed: computeTimeElapsed(sessionId, Date.now()),
      environmental_clues: readMissionMeta(sessionId).environmentalClues || undefined,
    },
    actors,
    stats_config: jsonParse(session.stats_config ?? '[]', []),
    stats_state: curStats,
    current_time: new Date().toLocaleString('zh-CN'),
    player_id: playerId,
    // 重试轮（regenerate）：虽无"本轮新发" playerMessage，但语义是重新生成对玩家上一条发言的回应，
    // 必须视为有玩家输入——否则点名版的"玩家发了话必须有男主回应"兜底被跳过，重试轮可能只排路人就收尾。
    has_player_turn_input: !!playerMessage && !!playerMessage.trim() || !!opts?.regenerate,
  };

  // 6) 跑一轮 —— 在 LLM 开跑前先拍快照（供后续按轮撤回）
  //    场基线快照每次开会只拍一次（insert-once）；轮快照每轮开始前拍一份本次轮前的累积态
  captureRoundSnapshot(playerId, sessionId, opts?.regenerate ? session.round_no : session.round_no + 1);
  if (session.round_no === 0) captureStartSnapshot(playerId, sessionId);

  // 6.5) 玩家消息先落库（在引擎跑之前）——
  //   否则引擎报错时 catch 直接抛出，玩家消息永远不落库 → "我的消息不见了"
  const earlyRound = session.round_no + 1;
  const earlyNow = Date.now();
  const earlyQuoteJson = quote ? JSON.stringify(quote) : null;
  const insertMsgEarly = db.prepare(
    'INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  if (playerMessage && playerMessage.trim()) {
    const pMsgId = genId();
    insertMsgEarly.run(
      pMsgId, sessionId, earlyRound, 'player', null, playerName,
      playerMessage.trim(), JSON.stringify({}), earlyQuoteJson, '', 0, earlyNow,
    );
    // embedding 索引（fire-and-forget）—— 内联，不依赖事务块内的 indexSceneMessage
    const firstCharId = actorOrder.find(a => !npcIdSet?.has(a.characterId))?.characterId ?? null;
    if (firstCharId && playerMessage.trim()) {
      const content = `${playerName}：${playerMessage.trim()}`;
      embed(content).then(vec => {
        if (vec) storeEmbedding(playerId, firstCharId, 'scene_message', pMsgId, content, vec);
      }).catch(() => {});
    }
  }

  let result: SceneTurnResult;
  result = await runSceneTurnNamed(input, { onLog: log, onBeat: opts?.onBeat });

  // 7) 落库本轮 output
  //    整个同步落库包在一个事务里（BEGIN…COMMIT）：任何一步失败即 ROLLBACK 整体回退，
  //    避免"玩家消息已写、NPC/旁白/stats 未写"的半落库残局。
  //    记忆折叠（下方 sync:false）是 fire-and-forget、先 await LLM 才写库，
  //    在同步单线程下必然晚于本段 COMMIT 执行，不会污染本事务。
  // 重试（regenerate）路径：rollback 已把 round_no 修正为玩家发言所在轮，重新生成的 NPC/旁白
  // 应落回同一轮（不推进），否则重试后的回复会和玩家发言分属两轮。
  const nextRound = opts?.regenerate ? session.round_no : session.round_no + 1;
  const now = Date.now();
  db.exec('BEGIN');
  try {
    // 乐观锁：先原子推进 round_no（期望值 = 调用方读到的 session.round_no）。
    // 若 changes=0 说明并发回合已抢先推进过这一轮 → ROLLBACK 并抛冲突，杜绝两批写进同一轮。
    const lock = db.prepare(
      'UPDATE scene_sessions SET round_no = ?, stats_state = ?, updated_at = ? WHERE id = ? AND round_no = ?'
    );
    const lockRes = lock.run(nextRound, JSON.stringify(result.statsState), now, sessionId, session.round_no);
    if (lockRes.changes === 0) {
      db.exec('ROLLBACK');
      const err = new Error('回合冲突：会话已被并发推进，请刷新后重试');
      (err as any).code = 'SCENE_ROUND_CONFLICT';
      throw err;
    }

    const insertMsg = db.prepare(
      'INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

  /** fire-and-forget: 存对话原文 embedding 供三路搜索的【对话原文】通道检索 */
  function indexSceneMessage(msgId: string, charId: string | null, charName: string, text: string) {
    if (!charId || !text.trim()) return;
    const content = `${charName}：${text}`;
    embed(content).then(vec => {
      if (vec) storeEmbedding(playerId, charId, 'scene_message', msgId, content, vec);
    }).catch(() => { /* embedding 不可用时降级，不影响主流程 */ });
  }

  const quoteJson = quote ? JSON.stringify(quote) : null;
  // 汇总 stats 变更 + 最后的关系描述
  let lastPlayerDescription: string | null = null;
  let lastCurrentActivity: string | null = null;
  const statsChangesOverall: { name: string; before: number; after: number }[] = [];

  // 先落玩家消息（若有输入话术）—— 已在引擎开跑前落库（6.5 步），此处不再重复
  // role='player' 的消息已在引擎之前写入，保证引擎报错时玩家消息不丢

  for (const item of result.output) {
    if (item.kind === 'character') {
      const actor = actorOrder.find((a) => a.key === item.speaker);
      const npcMsgId = genId();
      insertMsg.run(
        npcMsgId,
        sessionId,
        nextRound,
        'npc',
        actor?.characterId ?? null,
        item.speaker ?? actor?.characterName ?? '角色',
        cleanStraySymbols(item.content),
        JSON.stringify({}),
        null,
        item.internal ?? '',
        item.internalNotable ? 1 : 0,
        now,
      );
      indexSceneMessage(npcMsgId, actor?.characterId ?? null, item.speaker ?? actor?.characterName ?? '角色', cleanStraySymbols(item.content));
    } else {
      // narration
      insertMsg.run(
        genId(),
        sessionId,
        nextRound,
        'narration',
        null,
        '旁白',
        item.content,
        JSON.stringify(item.statsChanges ?? []),
        null,
        '',
        0,
        now,
      );
      if (item.statsChanges) statsChangesOverall.push(...item.statsChanges);
    }
  }

  // 8) 更新会话：round_no + stats_state + 处理 move（换地点 + 齐行程）
  //
  // 剧本模式无地点概念，跳过 move 逻辑。
  let newLocationId: string | null = null;
  let newLocationName = '';
  let moveBeats: any[] = [];

  if (!isScenario) {
    newLocationId = session.current_location_id || session.root_location_id;
    // 找出本轮所有 move 拍（多个时取最后一个为目标）
    moveBeats = result.beats.filter((b) => b.kind === 'action' && b.type === 'move' && b.to);
    if (moveBeats.length > 0) {
      const target = moveBeats[moveBeats.length - 1]!.to!.trim();
      const effLocId = session.current_location_id || session.root_location_id;

      // 层级优先匹配：角色家 → 子节点 → 同级 → 全表
      //   角色家优先：玩家说"带我回家"时，角色的家应最先匹配，
      //   避免误入同名/模糊匹配到他人私有地点。
      const curLoc = db.prepare('SELECT name, parent_id, is_public FROM scene_locations WHERE id = ?').get(effLocId) as { name: string; parent_id: string | null; is_public: number } | undefined;
      let matched: { id: string; name: string } | undefined;
      const visCond = `AND (is_public = 1 OR creator_id = ?)`;

      // 0) 角色家（精确名匹配，大小写不敏感）——无论角色在哪，家始终可达
      if (!matched && characterIds.length) {
        const placeholders = characterIds.map(() => '?').join(',');
        matched = db.prepare(
          `SELECT sl.id, sl.name FROM scene_locations sl
           JOIN scene_homes sh ON sh.location_id = sl.id
           WHERE sh.character_id IN (${placeholders}) AND sl.id NOT LIKE 'temp-%'
             AND sl.name = ? COLLATE NOCASE LIMIT 1`
        ).get(...characterIds, target) as { id: string; name: string } | undefined;
        if (matched) log(`🧭 [move] 匹配到角色家「${matched.name}」`);
      }

      // 1) 当前地点的子节点（精确名匹配，大小写不敏感）
      if (effLocId && !matched) {
        matched = db.prepare(
          `SELECT id, name FROM scene_locations WHERE parent_id = ? AND id NOT LIKE 'temp-%' ${visCond} AND name = ? COLLATE NOCASE LIMIT 1`
        ).get(effLocId, playerId, target) as { id: string; name: string } | undefined;
        if (matched) log(`🧭 [move] 匹配到子节点「${matched.name}」`);
      }

      // 2) 同级地点（同 parent_id）
      if (!matched && curLoc) {
        matched = db.prepare(
          `SELECT id, name FROM scene_locations WHERE parent_id IS ? AND id != ? AND id NOT LIKE 'temp-%' ${visCond} AND name = ? COLLATE NOCASE LIMIT 1`
        ).get(curLoc.parent_id, effLocId, playerId, target) as { id: string; name: string } | undefined;
        if (matched) log(`🧭 [move] 匹配到同级地点「${matched.name}」`);
      }

      // 3) 全表模糊匹配（兜底）——同样过滤他人私有地点
      if (!matched) {
        matched = db.prepare(
          `SELECT id, name FROM scene_locations WHERE id NOT LIKE 'temp-%' ${visCond} AND (name = ? COLLATE NOCASE OR name LIKE ?) ORDER BY CASE WHEN name = ? COLLATE NOCASE THEN 0 ELSE 1 END LIMIT 1`
        ).get(playerId, target, `%${target}%`, target) as { id: string; name: string } | undefined;
        if (matched) log(`🧭 [move] 全表匹配到「${matched.name}」`);
      }

      if (matched) {
        newLocationId = matched.id;
        newLocationName = matched.name;
      } else {
        // 4) 都没匹配到 → 作为当前地点的子地点创建
        //    继承父地点的 is_public：私有地点下不会冒出公开子地点
        //    继承父地点的 world_id：任务地图（mission-xxx）里兜底创建的地点不能挂到默认世界，否则污染主城
        const newId = genId();
        const childIsPublic = curLoc?.is_public ?? 1;
        const parentWorld = db.prepare('SELECT world_id FROM scene_locations WHERE id = ?').get(effLocId) as { world_id: string } | undefined;
        db.prepare(
          'INSERT INTO scene_locations (id, world_id, name, summary, parent_id, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(newId, parentWorld?.world_id ?? HUB_WORLD_ID, target, '', effLocId, childIsPublic, now, now);
        newLocationId = newId;
        newLocationName = target;
        log(`🧭 [move] 创建子地点「${target}」（parent=${curLoc?.name ?? effLocId}）`);
      }

      // 更新会话 current_location_id
      if (newLocationId && newLocationId !== (session.current_location_id || session.root_location_id)) {
        db.prepare('UPDATE scene_sessions SET current_location_id = ?, updated_at = ? WHERE id = ?')
          .run(newLocationId, now, sessionId);
      }

      // 3) 把参与角色的行程记录对齐到新地点
      for (const cid of characterIds) {
        overrideSceneScheduleToLocation(
          playerId, cid,
          newLocationId ?? effLocId ?? '',
          newLocationName || '某个地方',
          '和你约会', 120,
        );
      }
    } else {
      // 无 move：会话 current 地点名 = 当前有效地点（current 兜底 root）
      newLocationId = session.current_location_id || session.root_location_id || null;
      const curLoc = newLocationId ? db.prepare('SELECT name FROM scene_locations WHERE id = ?').get(newLocationId) as { name: string } | undefined : undefined;
      newLocationName = curLoc?.name || '某个地方';
    }
  }
  // 注：round_no / stats_state 已由事务开头乐观锁 UPDATE 一次性推进（见上方 BEGIN 处），此处不再重复写。

  // 8b) 会话若无 current_location_id（老数据/临时地点），保持为 root 兜底一致：
  //  临时地点场景 current_location_id 为 NULL，顶栏用 root 兜底会回到起始名，这不对。
  //  因此在临时地点情况下，把"导演起的名"记为会话地点名，供顶栏读取 —— 存进 stats_state 不合适，
  //  直接用返回的 locationName 给前端即可，前端本地记 displayLocation。

  // 9) 折叠记忆（异步不阻塞返回）
  const charTurns = buildTurnMemoryInput(actorOrder, result.output, playerName, nextRound, playerMessage || lastPlayerRow?.text);
  void runTurnMemoryUpdate({
    sceneSessionId: sessionId,
    playerId,
    roundNo: nextRound,
    playerName,
    characters: charTurns,
  }, { sync: false, onLog: log }).catch(err => {
    log(`⚠️ 记忆折叠失败: ${err instanceof Error ? err.message : err}`);
  });

  // 10) 关系写入：取最后一个 character 的 playerDescription
  //     只写正式角色（主角），跳过常驻路人 —— 路人不占 characters 表、跨场不延续、
  //     读侧也用固定文案不走本表（见上方 buildCharacterCard 的 npc 分支），
  //     若写入会产生只会成为孤儿的关系记录。
  for (const item of result.output) {
    if (item.kind === 'character' && item.playerDescription) {
      const actor = actorOrder.find((a) => a.key === item.speaker);
      if (actor && !npcById.has(actor.characterId)) {
        db.prepare(
          `INSERT INTO scene_relationships (id, player_id, character_id, scene_session_id, player_description, current_activity, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(player_id, character_id) DO UPDATE SET player_description = excluded.player_description, current_activity = excluded.current_activity, scene_session_id = excluded.scene_session_id, updated_at = excluded.updated_at`
        ).run(genId(), playerId, actor.characterId, sessionId, item.playerDescription, item.currentActivity ?? '', now);
        lastPlayerDescription = item.playerDescription;
        lastCurrentActivity = item.currentActivity ?? null;
      }
    }
  }

  db.exec('COMMIT');

  // move 后转场旁白：地点切换了，在新环境里插一段正常的环境旁白。
  // 放在 COMMIT 之后——不阻塞事务，也不影响落库。
  // 约束：output 末尾不能是旁白（避免旁白连旁白）。
  if (moveBeats.length > 0 && newLocationName) {
    const lastOut = result.output[result.output.length - 1];
    if (lastOut?.kind !== 'narration') {
      try {
        const locDesc = newLocationId
          ? (db.prepare('SELECT summary FROM scene_locations WHERE id = ?').get(newLocationId) as { summary?: string } | undefined)?.summary ?? ''
          : '';
        const narrationBuild = `当前地点：${newLocationName}。${locDesc ? locDesc : ''}。写一段环境旁白。`;
        const narrationLine = await runNarration(narrationBuild, log);
        if (narrationLine) {
          result.output.push({ kind: 'narration', content: narrationLine });
          log(`🎬 [转场旁白] ${narrationLine.slice(0, 60)}`);
        }
      } catch (e) {
        log(`⚠️ 转场旁白生成失败：${(e as Error).message}`);
      }
    }
  }

  return {
    sessionId,
    roundNo: nextRound,
    output: result.output,
    statsState: result.statsState,
    statsChangesOverall,
    playerDescription: lastPlayerDescription,
    currentActivity: lastCurrentActivity,
    locationId: newLocationId,
    locationName: newLocationName,
    locationBackground: newLocationId ? getLocationBackground(newLocationId) : '',
  };
  } catch (err) {
    // 任何落库失败（含乐观锁冲突）→ 整体回滚，不留半落库残局
    try { db.exec('ROLLBACK'); } catch { /* 事务可能已不在 */ }
    throw err;
  }
}

// ─── 辅助 ─────────────────────────────────────────────

/**
 * 把本轮 output 按角色归组，转成 runTurnMemoryUpdate 需要的 characters 输入。
 * 关键：把本轮的玩家发言也作为 role='player' 行并入每个在场角色的 turns，
 *       这样折叠(记忆整理)时模型才看得到玩家原话，能提取「关于玩家的事实」——
 *       否则 turns 只有角色自说自话，player_facts 永远提取不到(记忆APP为空)。
 */
function buildTurnMemoryInput(
  actorOrder: SceneActorSource[],
  output: TurnOutputItem[],
  playerName: string,
  roundNo: number,
  playerMessage?: string,
) {
  // 玩家本轮新发言——作为 role='player' 行并入每个角色的 turns 开头（时间上玩家先说、角色后答）
  const playerTurn: TurnLine | null = playerMessage && playerMessage.trim()
    ? { role: 'player', text: playerMessage.trim() }
    : null;

  const map = new Map<string, TurnLine[]>();
  for (const out of output) {
    if (out.kind === 'character') {
      const actor = actorOrder.find((a) => a.key === out.speaker);
      const cid = actor?.characterId ?? out.speaker ?? 'unknown';
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid)!.push({ role: out.speaker ?? actor?.characterName ?? '角色', text: out.content });
    }
  }
  // 把玩家发言加到每个角色的 turns 开头
  if (playerTurn) {
    for (const turns of map.values()) {
      turns.unshift(playerTurn);
    }
  }
  return Array.from(map.entries()).map(([cid, turns]) => {
    const actor = actorOrder.find((a) => a.characterId === cid);
    return {
      characterId: cid,
      characterName: actor?.characterName ?? getCharacterName(cid),
      turns,
    };
  });
}

// ─── 剧本数值+气氛组判定 ──────────────────────────────

/** NPC 角色槽位格式（可带简短身份） */
export interface NpcRoleSlot {
  identity?: string;   // 简短身份标签，如"未婚夫""前任"
  description: string;  // 完整描述
}

/** 兼容旧格式：string[] → NpcRoleSlot[] */
export function parseNpcRoles(raw: string): NpcRoleSlot[] {
  const arr = jsonParse<any[]>(raw, []);
  return arr.map(item => {
    if (typeof item === 'string') return { identity: '', description: item };
    return {
      identity: typeof item.identity === 'string' ? item.identity : '',
      description: typeof item.description === 'string' ? item.description : String(item),
    };
  });
}

/**
 * 构建 NPC 身份映射文本（供 stats-judge prompt 使用）。
 * 把 character_ids 和 npc_roles 对齐，输出"角色名 = 身份：描述"。
 */
export function buildNpcIdentities(characterIds: string[], npcRolesRaw: string): string {
  const slots = parseNpcRoles(npcRolesRaw);
  if (!characterIds.length || !slots.length) return '';
  const lines: string[] = [];
  for (let i = 0; i < characterIds.length && i < slots.length; i++) {
    const cid = characterIds[i];
    if (!cid) continue;
    const name = getCharacterName(cid);
    const slot = slots[i];
    if (!slot) continue;
    const idLabel = slot.identity?.trim() || '（未设置身份）';
    lines.push(`· ${name} = ${idLabel}：${slot.description}`);
  }
  return lines.join('\n');
}

export interface StatsAmbientResult {
  changes: Array<{ name: string; delta: number; reason: string }>;
  ambient: string[];
  goalAchieved: boolean;
  goalReason: string;
  /** 破案玩法：本轮对话揭示的线索 id 列表（进度 = 累计已揭示线索数，代码据此算，不信任 LLM 的 delta） */
  revealedClues: number[];
}

/**
 * 任务元信息（仅 mission 场景）：从 session 反查 mission.metadata。
 * truth=谜底（hidden_thread + 最后一条线索）；environmentalClues=旁白可带出的环境线索；goalPath=可参考的通关流程。
 * 破案玩法（有线索）：达成看「真相是否揭晓」——判定器需要谜底才能判「揭晓没」。
 * 其他玩法（无线索）：达成看「通关流程是否走完」——判定器需要 goalPath 才能判「走到哪一步」。
 */
function readMissionMeta(sessionId?: string): { truth: string; environmentalClues: string; clues: { id: number; content: string }[]; goalPath: string } {
  const empty = { truth: '', environmentalClues: '', clues: [] as { id: number; content: string }[], goalPath: '' };
  if (!sessionId) return empty;
  const sess = db.prepare('SELECT scene_type, root_location_id FROM scene_sessions WHERE id = ?').get(sessionId) as { scene_type: string; root_location_id: string } | undefined;
  if (sess?.scene_type !== 'mission' || !sess.root_location_id?.startsWith('temp-')) return empty;
  const missionId = sess.root_location_id.slice('temp-'.length);
  const mission = db.prepare('SELECT metadata FROM missions WHERE id = ?').get(missionId) as { metadata: string } | undefined;
  if (!mission?.metadata) return empty;
  const meta = jsonParse<{ hidden_thread?: string; clues?: { id: number; content: string }[]; environmental_clues?: string[]; goal_path?: string }>(mission.metadata, {});
  const clues = meta.clues ?? [];
  const truthClue = clues.length ? clues[clues.length - 1]?.content : '';
  const truth = [meta.hidden_thread, truthClue].filter((s) => s && s.trim()).join('；');
  const environmentalClues = (meta.environmental_clues ?? []).filter((s) => s && s.trim()).join('；');
  const goalPath = (meta.goal_path ?? '').trim();
  return { truth, environmentalClues, clues, goalPath };
}

/**
 * 数值+气氛组合并 LLM 判定。
 * advanceScene 完成后调用，拿玩家消息 + NPC 回复 + 当前数值规则 + 气氛组配置，
 * 一次 LLM 调用同时输出数值变动和气氛组弹幕。
 */
export async function judgeStatsAndAmbient(
  statsConfig: Array<{ name: string; initial: number; rules: string; target?: number | null }>,
  statsBefore: Record<string, number>,
  playerMessage: string,
  npcReply: string,
  ambientConfig: string,
  sessionId?: string,
  npcIdentities?: string,
  playerId?: string,
): Promise<StatsAmbientResult> {
  // 没有数值系统且没有气氛组、且不是 mission 场景（无通关流程/线索可判）→ 直接返回空
  const hasStats = statsConfig.length > 0;
  const hasAmbient = !!ambientConfig.trim();
  const missionMeta = readMissionMeta(sessionId);
  const hasClues = missionMeta.clues.length > 0;
  const hasGoalPath = !!missionMeta.goalPath;
  if (!hasStats && !hasAmbient && !hasClues && !hasGoalPath) {
    return { changes: [], ambient: [], goalAchieved: false, goalReason: '', revealedClues: [] };
  }

  const statsRules = hasStats
    ? statsConfig.map(s => `· ${s.name}（当前${statsBefore[s.name] ?? s.initial}，目标${s.target ?? '无'}）：${s.rules}`).join('\n')
    : '（无数值系统）';
  const ambientDesc = hasAmbient ? ambientConfig : '无';
  const npcIdentitiesStr = npcIdentities?.trim() || '（未设置角色身份）';

  // goal 判定依据：破案（有线索）→ 真相揭晓；其他玩法（有通关流程）→ 通关流程；都无 → 笼统。
  const goalJudgeRule = hasClues
    ? `达成不看数值，看「真相是否揭晓」——当本轮对话里，NPC 把下面的谜底说破、或玩家已经拼出了真相、或核心人物终于吐露了真相时，goal_achieved 为 true；否则为 false。数值只是氛围参考，不因数值到顶就判达成。\n\n【任务的谜底（真相）】\n${missionMeta.truth}`
    : hasGoalPath
      ? `达成看「通关流程」是否走完——当本轮对话里，玩家实际推进/完成了下面通关流程的某一步、尤其是最后一步（目标态达成）时，goal_achieved 为 true；否则为 false。数值只是氛围参考，不因数值到顶就判达成。\n\n【任务的通关流程】\n${missionMeta.goalPath}`
      : '看对话推进与数值是否达到目标。';

  // 破案玩法（有线索）：进度按「已揭示线索数」算，判定器只输出本轮揭示的线索编号，不输出数值 delta。
  const cluesSection = hasClues
    ? `【线索列表】本场景是推理玩法，任务共有以下线索（编号即线索 id）：\n${missionMeta.clues.map(c => `${c.id}. ${c.content}`).join('\n')}\n本轮你只负责判断：对话中 NPC 是否说破了某条线索、或玩家是否拼出了某条线索——把对应的线索编号写进 revealed_clues。没揭示任何线索则返回空数组。`
    : '';
  const changeRule = hasClues
    ? '本场景进度按「已揭示的线索数」算，不需要 changes 的数值增减——changes 一律返回空数组，改为把本轮揭示的线索编号写进 revealed_clues。'
    : '根据规则判定本轮是否触发了数值增减，增减幅度一般为5-30，特殊情况可更大。';

  const judgePrompt = loadPrompt('scenario.stats-judge');
  const filledPrompt = renderPrompt(judgePrompt, {
    stats_rules: statsRules,
    stats_before: JSON.stringify(statsBefore, null, 2),
    player_message: playerMessage,
    npc_reply: npcReply,
    ambient_config: ambientDesc,
    npc_identities: npcIdentitiesStr,
    goal_judge_rule: goalJudgeRule,
    clues_section: cluesSection,
    change_rule: changeRule,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: filledPrompt },
    { role: 'user', content: '请判定。' },
  ];

  const result = await chat(messages, {
    temperature: 0.3,
    maxTokens: 512,
    callType: 'stats_ambient',
    sessionId,
    playerId,
    guidedJson: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              delta: { type: 'integer' },
              reason: { type: 'string' },
            },
            required: ['name', 'delta', 'reason'],
          },
        },
        ambient: {
          type: 'array',
          items: { type: 'string' },
        },
        revealed_clues: { type: 'array', items: { type: 'integer' } },
        goal_achieved: { type: 'boolean' },
        goal_reason: { type: 'string' },
      },
      required: ['changes', 'ambient', 'goal_achieved', 'goal_reason'],
    },
  });

  const parsed = tryParseJsonReply(result.content);
  if (!parsed) {
    return { changes: [], ambient: [], goalAchieved: false, goalReason: '', revealedClues: [] };
  }

  return {
    changes: Array.isArray(parsed.changes) ? (parsed.changes as Array<{ name: string; delta: number; reason: string }>) : [],
    // 代码层硬拦：ambient_config 为空时强制返回空数组，不信任 LLM 自觉遵守
    ambient: hasAmbient ? (Array.isArray(parsed.ambient) ? (parsed.ambient as string[]) : []) : [],
    goalAchieved: Boolean(parsed.goal_achieved),
    goalReason: String(parsed.goal_reason ?? ''),
    revealedClues: Array.isArray(parsed.revealed_clues) ? (parsed.revealed_clues as number[]).map(Number) : [],
  };
}

/**
 * mission 场景的 goal 判定：无数值无气氛组，只判「目标是否达成」，达成则落库 goal_achieved=1。
 * 约会场景（date）不调用——只有任务场景有「任务完成」概念。
 * 判定依据来自 readMissionMeta 的通关流程（goalPath）或破案线索（clues）；两者都无则不判。
 */
export async function judgeMissionGoal(
  sessionId: string,
  playerMessage: string,
  npcReply: string,
  playerId: string,
): Promise<{ goalAchieved: boolean; goalReason: string }> {
  const meta = readMissionMeta(sessionId);
  if (!meta.goalPath && !meta.clues.length) {
    return { goalAchieved: false, goalReason: '' };
  }
  const result = await judgeStatsAndAmbient([], {}, playerMessage, npcReply, '', sessionId, undefined, playerId);
  if (result.goalAchieved) {
    db.prepare('UPDATE scene_sessions SET goal_achieved = 1, updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }
  return { goalAchieved: result.goalAchieved, goalReason: result.goalReason };
}

/**
 * 将气氛组内容存为 scene_messages（role='narration', character_name='气氛组'）。
 * 这些消息进入 conversation_so_far，NPC 下一轮能看到并自然反应。
 */
export function storeAmbientMessages(sessionId: string, roundNo: number, ambient: string[]): void {
  if (!ambient.length) return;
  const now = Date.now();
  const insert = db.prepare(
    'INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, internal, internal_notable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const text of ambient) {
    insert.run(
      genId(), sessionId, roundNo,
      'narration', null, '气氛组',
      text,
      JSON.stringify({}), null, '', 0,
      now,
    );
  }
}

// ─── 剧本做梦 ──────────────────────────────────────────

/**
 * 剧本做梦：读 scene_messages 做总结，生成梦内容存回原NPC记忆。
 * 适配自旧 generateAndStoreDream，改为读 scene_messages / turn_memory_fold。
 */
export async function generateScenarioDream(
  app: { log: { error: (obj: unknown, msg?: string) => void } },
  sceneSessionId: string,
  playerId: string,
  characterId: string,
): Promise<void> {
  // 如果已有梦，跳过
  const existing = db.prepare('SELECT dream_text FROM scene_sessions WHERE id = ?').get(sceneSessionId) as { dream_text: string | null } | undefined;
  if (existing?.dream_text) return;

  const session = db.prepare('SELECT scenario_id, worldview, player_role, npc_roles, goal, opening_scene FROM scene_sessions WHERE id = ?').get(sceneSessionId) as { scenario_id: string; worldview: string; player_role: string; npc_roles: string; goal: string; opening_scene: string } | undefined;
  if (!session?.scenario_id) return;

  const scenario = db.prepare('SELECT title, description, worldview FROM scenarios WHERE id = ?').get(session.scenario_id) as { title: string; description: string; worldview: string } | undefined;
  if (!scenario) return;

  // 获取对话总结：优先 turn_memory_fold，回退 scene_messages
  const folds = db.prepare(
    `SELECT summary FROM turn_memory_fold
     WHERE player_id = ? AND scene_session_id = ? AND character_id = ? AND fold_type IN ('overview', 'segment')
     ORDER BY fold_type, round_max ASC`
  ).all(playerId, sceneSessionId, characterId) as Array<{ summary: string }>;

  let sessionSummary: string;
  if (folds.length > 0) {
    sessionSummary = folds.map((f, i) => `片段${i + 1}：${f.summary}`).join('\n');
  } else {
    const msgs = db.prepare(
      'SELECT role, character_name, text FROM scene_messages WHERE scene_session_id = ? ORDER BY round_no, created_at ASC LIMIT 30'
    ).all(sceneSessionId) as Array<{ role: string; character_name: string; text: string }>;
    sessionSummary = msgs.map(m => {
      if (m.role === 'player') return `玩家：${m.text}`;
      if (m.role === 'narration') return `（旁白）${m.text}`;
      return `${m.character_name}：${m.text}`;
    }).join('\n');
  }

  const charName = getCharacterName(characterId);
  const { buildCharacterCard } = await import('./character-card');
  const card = buildCharacterCard(playerId, characterId);
  const personality = card || '';

  const dreamPrompt = loadPrompt('scenario.dream');
  const filledPrompt = renderPrompt(dreamPrompt, {
    scenario_title: scenario.title,
    worldview: scenario.worldview,
    session_summary: sessionSummary,
    character_name: charName,
    personality,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: filledPrompt },
    { role: 'user', content: '请生成梦的内容。' },
  ];

  const result = await chat(messages, {
    temperature: 0.85,
    maxTokens: 512,
    callType: 'dream',
    sessionId: sceneSessionId,
    playerId,
    guidedJson: {
      type: 'object',
      properties: { dream: { type: 'string' } },
      required: ['dream'],
    },
  });

  const parsed = tryParseJsonReply(result.content);
  if (!parsed || typeof parsed.dream !== 'string') {
    app.log.error({ err: '梦生成失败：LLM返回格式错误' }, '梦生成失败');
    return;
  }
  const dreamText = parsed.dream as string;

  // 存梦到 scene_sessions
  const now = Date.now();
  db.prepare('UPDATE scene_sessions SET dream_text = ?, dream_custom = 0, updated_at = ? WHERE id = ?').run(dreamText, now, sceneSessionId);

  // 存入 chronicle 记忆（原NPC的）—— 标注 source='dream_scenario'，记忆检索时过滤
  const dreamChronicleId = genId();
  db.prepare(
    `INSERT INTO chronicles (id, player_id, character_id, session_id, summary, key_memories, created_at, source, summary_type) VALUES (?, ?, ?, ?, ?, '[]', ?, 'dream_scenario', 'dream')`
  ).run(dreamChronicleId, playerId, characterId, sceneSessionId, `[梦] ${dreamText}`, now);

  // 向量化
  try {
    const { embed, storeEmbedding } = await import('./embedding');
    const dreamVec = await embed(dreamText);
    if (dreamVec) {
      storeEmbedding(playerId, characterId, 'dream_scenario', dreamChronicleId, dreamText, dreamVec);
    }
  } catch { /* 不影响流程 */ }

  // NPC 主动发一条梦短信（如果已加好友）
  try {
    const thread = db.prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { id: string } | undefined;
    if (thread) {
      const { generateReply } = await import('../prompt/builder');
      const dreamMessages = await buildDreamSmsMessages(sceneSessionId, playerId, characterId);
      if (dreamMessages) {
        const reply_data = await generateReply(dreamMessages, { temperature: 0.9, maxTokens: 768, playerId });

        for (let i = 0; i < reply_data.messages.length; i++) {
          const msg = reply_data.messages[i]!;
          const msgId = genId();
          const msgTs = now;
          const internal = i === 0 ? reply_data.internal : '';
          const internalNotable = i === 0 && reply_data.internal_notable ? 1 : 0;
          db.prepare(
            `INSERT INTO text_messages (id, thread_id, sender, body, status, internal, internal_notable, internal_viewed, created_at, delivered_at, metadata) VALUES (?, ?, 'npc', ?, 'delivered', ?, ?, 0, ?, ?, ?)`
          ).run(msgId, thread.id, msg, internal, internalNotable, msgTs, msgTs, `{"proactive":true,"dream":true,"scene_session_id":"${sceneSessionId}"}`);
        }
        db.prepare('UPDATE message_threads SET last_message_at = ?, unread_count = unread_count + ?, updated_at = ? WHERE id = ?').run(now, reply_data.messages.length, now, thread.id);
      }
    }
  } catch (err) {
    app.log.error({ err }, '梦短信发送失败');
  }
}

/**
 * 构造梦境短信的 LLM 消息（system + user）。
 *
 * 与普通短信不同：不读 getUnifiedTimeline 跨场时间线（短信历史/朋友圈/约会原文是
 * "日常短信延续话题"的原料，梦醒短信用不上，且是三套视角打架的根源），
 * 只喂：梦正文 + 剧本要素（简介/世界观/双方剧本身份/剧情目标/开局情境）+ 角色卡 + 玩家现实身份，
 * 两个身份层（现实 vs 梦里扮演的角色）分开标注。
 *
 * 供 generateScenarioDream（首次生成）与 sms.ts 的梦短信重试（retry-dream）共用。
 */
export async function buildDreamSmsMessages(
  sceneSessionId: string,
  playerId: string,
  characterId: string,
): Promise<ChatMessage[] | null> {
  const session = db.prepare(
    'SELECT scenario_id, worldview, player_role, npc_roles, goal, opening_scene, dream_text FROM scene_sessions WHERE id = ?'
  ).get(sceneSessionId) as { scenario_id: string; worldview: string; player_role: string; npc_roles: string; goal: string; opening_scene: string; dream_text: string | null } | undefined;
  if (!session?.dream_text || !session?.scenario_id) return null;

  const scenario = db.prepare('SELECT title, description FROM scenarios WHERE id = ?').get(session.scenario_id) as { title: string; description: string } | undefined;
  if (!scenario) return null;

  const { loadCharacterData } = await import('./character');
  const { buildSystemPrompt, getPlayerProfile, getHubLocationsText, formatRelationshipDuration } = await import('../prompt/builder');
  type PromptContext = import('../prompt/builder').PromptContext;

  const charData = loadCharacterData(playerId, characterId);
  if (!charData) return null;

  const rel = db.prepare('SELECT player_description, created_at FROM relationships WHERE player_id = ? AND character_id = ?').get(playerId, characterId) as { player_description: string; created_at: number } | undefined;
  const playerName = (db.prepare('SELECT name FROM players WHERE id = ?').get(playerId) as { name: string } | undefined)?.name ?? '玩家';
  let npcRoleDesc = '';
  try {
    npcRoleDesc = (jsonParse(session.npc_roles, []) as Array<{ description?: string }>)[0]?.description ?? '';
  } catch { /* ignore */ }

  const dreamChronicle = [
    '【你刚做的梦——梦里经历的一段剧本】',
    '',
    `你（${charData.name}）刚从一个梦里醒来。梦里，你扮演了一个角色，玩家（${playerName}）扮演了另一个角色，你们共同走完了一段剧本。下面这段剧本的设定文字，其中的「你」指的都是剧本里的视角——「你扮演的角色」或「玩家扮演的角色」，不是现实中的你和玩家。`,
    '',
    `【剧本名】${scenario.title}`,
    '',
    `【剧本简介】${scenario.description}`,
    '',
    '【世界观】',
    session.worldview,
    '',
    '【你扮演的角色】',
    npcRoleDesc,
    '',
    '【玩家扮演的角色】',
    session.player_role,
    '',
    `【剧情目标】${session.goal}`,
    '',
    `【开局情境】${session.opening_scene}`,
    '',
    '【梦的内容】',
    session.dream_text,
    '',
    `【重要提醒】梦醒后，你仍是${charData.name}本人，对方仍是玩家本人。剧本里你扮演的角色和玩家扮演的角色，只是你们在梦里各自扮演的身份。这条短信说的是这个梦——不要把梦里角色的称呼、关系当成现实的，也不要编造梦里没发生过的对白或细节。`,
  ].join('\n');

  const ctx: PromptContext = {
    characterData: charData,
    playerDescription: rel?.player_description ?? '刚认识的陌生人',
    playerProfile: getPlayerProfile(playerId),
    chronicleSummary: dreamChronicle,
    recentMessages: [],
    isTextMessage: true,
    isDeity: false,
    locationName: '',
    hubLocations: getHubLocationsText(),
    retrievedMemories: null,
    relationshipDuration: rel?.created_at ? formatRelationshipDuration(rel.created_at) : undefined,
  };

  const systemPrompt = buildSystemPrompt(ctx);
  const dreamSmsPrompt = `（你刚从一场漫长的梦中醒来。梦里${session.dream_text}\n\n你模糊地记得和对方一起经历了一些事——像是一场共同冒险的残影。你想告诉对方这件事。\n用你自己的方式提起这个梦——可能是"我刚做了个奇怪的梦"，可能是直接说梦里的片段，也可能是感慨一句。\n不要复述全部梦内容，挑最有感觉的片段说就好。简短，符合你发短信的习惯。）`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: dreamSmsPrompt },
  ];
}
