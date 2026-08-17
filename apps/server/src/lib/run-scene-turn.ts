/**
 * runSceneTurnNamed —— 场景引擎内核（Scene Engine §3.x，点名版）
 *
 * 干净的"turn 编排"层，不碰 DB（落库由调用方在单一事务里做）。
 * 两阶段生成：
 *  ① 导演(director)一次出 beats[]（kind/speaker/intent，不含台词）
 *  ② 逐拍演员/旁白(actor)每拍单独一次 LLM，只产出这一拍的内容
 *
 * 特性：
 *  - 导演输出 JSON 校验 + 带具体报错重试（最多 retries 次）
 *  - 数值结算并进 narration 拍（旁白拍携带 fn+args，原子结算+照述，§3.3.7）
 *  - 内心戏由角色自我带出，与导演 intent 解耦（§3.3.5）
 *
 * 纯函数：返回最终 output + statsState，由调用方决定如何落库/注入记忆。
 */
import { chat, chatJson } from '../llm/adapter';
import { loadPrompt, renderPrompt, loadGreetingSection } from '../prompt/loader';
import { statsFns, isValidStatsFn } from './stats-functions';
import { cleanStraySymbols } from './clean-text';
import { extractLastPlayerLine } from './repeat-detect';

// ─── 类型 ─────────────────────────────────────────────

export interface SceneBeat {
  kind: 'narration' | 'character' | 'action';
  speaker?: string;
  intent?: string;
  type?: string;        // action 子类型: move
  to?: string;          // move 目标
  fn?: string;          // narration 拍携带的结算函数名
  args?: Record<string, unknown>; // 结算参数 {delta, reason}
}

// ─── 点名版自动旁白概率 ─────────────────────────────────
// 点名版 namer 只负责"选谁说话"、没有导演的"排旁白"职责，
// 导致旁白结构性消失（生产数据显示点名版会话旁白占比 ~0% vs 导演版 ~19%）。
// 这里在代码层补偿：男主说话前/后有几率自动插入环境旁白。
// 数值是可调参数：过低旁白几乎不出现，过高会打断对话节奏。
const NARRATE_BEFORE_P = 0.15; // 男主说话前·氛围铺垫概率
const NARRATE_AFTER_P = 0.18;   // 男主说话后·余韵/转场概率

export interface StatsConfigItem {
  name: string;
  fn: string;
  initial?: number;
  target?: number | null;
  rules?: string;
}

export interface StatsChange {
  name: string;
  before: number;
  after: number;
  delta: number;
  reason: string;
}

export interface TurnOutputItem {
  kind: 'narration' | 'character';
  /** 台词或旁白文本 */
  content: string;
  speaker?: string;
  /** 内心戏（仅 character） */
  internal?: string;
  internalNotable?: boolean;
  /** 角色对玩家的一句话定性（仅 character，随互动微调） */
  playerDescription?: string;
  /** 角色感知的当前活动/目的（仅 character，随剧情演进） */
  currentActivity?: string;
  /** 稳定角色 id（仅 character，改名无关）：前端反查/持久化用 */
  characterId?: string;
  /** 若该旁白拍触发了数值结算：真实 changes（旁白唯一的数字来源） */
  statsChanges?: StatsChange[];
}

export interface SceneTurnResult {
  /** 导演产出的原始 beats（通过校验） */
  beats: SceneBeat[];
  /** 逐拍生成的最终输出（旁白/角色台词序列） */
  output: TurnOutputItem[];
  /** 结算后的 stats_state */
  statsState: Record<string, number>;
  /** 导演通过校验所用的尝试次数 */
  attempts: number;
}

export interface SceneTurnInput {
  scene: {
    location: string;
    scene_tone: string;
    scene_rules: string;
    companions: string;
    companions_raw?: string;
    resident_npcs: string;
    scene_relations: string;
    player_descriptions: string;
    conversation_so_far: string;
    /** 玩家是否已在对话里发过言（用于判断是否为开场回合） */
    has_player_spoken: boolean;
    /** 玩家名字（runActor 把对话历史重建为真实的 user/assistant 轮流轮次时，靠它区分哪些是玩家的发言） */
    player_name?: string;
    /** 本轮玩家新发的原始消息文本（不在 conversation_so_far 历史里）。runActor 在说话时才统一格式收尾。 */
    player_message?: string;
    /** 本轮玩家引用的历史消息（原始对象）。runActor 说话时统一拼成「（旁白：<玩家>引用了<发送者>的历史消息：「…」）」 */
    quote?: { quoteText?: string; quoteSenderName?: string };
    /** 开场情境（approach/caught/default）——开场回合导演要用它取对应的 greeting 小节，不能硬编码 default */
    circumstance?: string;
    max_beats?: string;
    /** 导演共享的角色记忆：在场角色各自记得的往事（导演编排戏份时参考，可安排角色提起/呼应） */
    scene_memory?: string;
    /** 地点介绍（summary）。演员【当前场景】用它来知道此刻身处何方、开口要贴合该地点的用途 */
    location_desc?: string;
    /** 地图上已存在、可前往的地点名列表（供导演 move 选择，避免即兴编造新地点污染地图） */
    available_locations?: string;
    /** 距场景上一次互动已过去的时长（人类可读；无明显间隔则为空）。导演/演员据此感知时间流逝，不再被开场时刻语境带偏。 */
    time_elapsed?: string;
    /** 环境线索（旁白可在相关情境自然带出；仅任务场景有，剧本/约会为空）。 */
    environmental_clues?: string;
  };
  /** 在场角色 → 演员上下文（system 用 actor 模板填充的变量） */
  actors: Record<string, {
    character_id?: string;
    character_name: string;
    character_card: string;
    player_profile: string;
    player_description: string;
    current_activity: string;
    chronicle_summary: string;
    retrieved_memories: string;
    /** 任务场景下，该演员（同伴/居民）各自的立场——由代码逐人注入，不做「若你是……」条件判断 */
    stance?: string;
  }>;
  /** 数值系统定义；空数组 = 纯闲聊场景 */
  stats_config?: StatsConfigItem[];
  /** 当前 stats_state；无穷值系统则省略 */
  stats_state?: Record<string, number>;
  /** 覆盖模板名（默认 scene.actor / scene.namer） */
  templates?: { actor?: string; namer?: string };
  /** 导演重试上限 */
  maxRetries?: number;
  /** 导演一次性输出的最大拍数 */
  max_beats?: number;
  /** 当前时间（喂给演员模板） */
  current_time?: string;
  /** 归属玩家 id：per-player LLM 配置（演员/旁白/字数检查/复述检测都走该玩家的配置） */
  player_id?: string;
  /** 本轮是否存在真实玩家发言（区别于 continue 空推进）。用于「玩家发了话但导演只排了动作/无台本」时兜底补一句角色回应，杜绝发了没回复。 */
  has_player_turn_input?: boolean;
}

// ─── 辅助 ─────────────────────────────────────────────

function formatStatsConfig(cfg?: StatsConfigItem[]): string {
  if (!cfg || cfg.length === 0) return '（无）';
  return cfg
    .map(c => `· ${c.name}：调用函数 ${c.fn}（当前${c.initial ?? 0}，目标${c.target ?? '无'}）。规则：${c.rules ?? ''}`)
    .join('\n');
}

/** 从 companions/resident 描述里抽出带名字的角色（用于校验 speaker 在场） */
function extractNamedSpeakers(texts: string[]): string[] {
  const names: string[] = [];
  for (const t of texts) {
    const m = t.match(/[^\s（(]+(?=（|\(|$)/g);
    if (m) names.push(...m);
  }
  return names;
}

/**
 * 校验导演输出的 beats，返回错误列表（空=通过）。
 * 不合规带具体报错，供导演重试修正。
 */
export function validateBeats(beats: SceneBeat[], namedSpeakers: string[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(beats) || beats.length === 0) {
    return ['beats 为空或不是数组'];
  }
  const validKinds = ['narration', 'character', 'action'];
  beats.forEach((b, i) => {
    if (!b || typeof b !== 'object') { errors.push(`[拍${i}] 不是对象`); return; }
    if (!validKinds.includes(b.kind as string)) {
      errors.push(`[拍${i}] kind='${b.kind}' 非法，应为 ${validKinds.join('/')}`);
    }
    if (b.kind === 'character') {
      if (!b.speaker || typeof b.speaker !== 'string') errors.push(`[拍${i}] character 缺非空 speaker`);
      // 玩家不被导演编排：玩家说什么由真实玩家决定，导演绝不能排"玩家"拍（把话头抛回玩家是省略玩家拍，
      // 不是排一个玩家角色拍）。因此 '玩家' 与"不在场角色"一样视为非法。
      else if (b.speaker === '玩家') errors.push(`[拍${i}] speaker='玩家' 非法——玩家不被导演编排，把话头抛回玩家请省略该拍，不要排玩家`);
      else if (namedSpeakers.length && !namedSpeakers.some(s => s.includes(b.speaker!) || b.speaker!.includes(s)))
        errors.push(`[拍${i}] speaker='${b.speaker}' 不在场角色（在场：${namedSpeakers.join('、')}）`);
    }
    if (b.kind === 'action') {
      if (b.type !== 'move') errors.push(`[拍${i}] action.type='${b.type}' 非法，应为 move`);
      if (b.type === 'move' && !b.to) errors.push(`[拍${i}] move 缺 to（目标地点）`);
    }
    if (b.fn) {
      if (!isValidStatsFn(b.fn)) errors.push(`[拍${i}] 旁白拍 fn='${b.fn}' 不是已注册结算函数`);
      const delta = Number((b.args as any)?.delta);
      if (Number.isNaN(delta)) errors.push(`[拍${i}] 旁白拍 args.delta='${(b.args as any)?.delta}' 无法解析为数字`);
    }
    if (!b.intent || typeof b.intent !== 'string' || !b.intent.trim()) {
      errors.push(`[拍${i}] 缺 intent（非空字符串）`);
    }
  });
  return errors;
}

/** 解析 LLM 输出的 JSON（容忍 ```json 包裹 / 前后杂讯 / 提取首个 {...}）。失败返回 null。 */
function parseJsonLoose(text: string): unknown | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[1] ?? m[0]);
  } catch {
    return null;
  }
}

// ─── 旁白 ─────────────────────────────────────────────

export async function runNarration(build: string, logs?: (s: string) => void, playerId?: string): Promise<string> {
  const res = await chat(
    [
      {
        role: 'system',
        content: [
          '你是一位文学性的环境叙述者，只写旁白——它是电影里"这一下镜头想拍"的瞬间。',
          '【镜头想拍的瞬间有且只有四类】',
          '① 有变化在发生——世界在动（时间/地点推进、转场、天色变化），或某个角色心里起了变化却没从嘴上说出来（他不开心，氛围就沉下来、落雨、光线变暗；她心里松动，风就缓了、光就亮了）。**环境是人物内心的镜子。**',
          '② 这一刻本身"活"得有质感——一个正在发生的、贴着人物的当下瞬间，值得让镜头给一个特写。',
          '③ 对话到头了需要带开——没话题了，镜头转场去制造新话题、带出新局面。',
          '④ 对话尴尬/冷场时，顶替路人递话头——尤其本场没有路人可接场时：若角色说出口的话让玩家接不上、气氛陷入尴尬沉默，旁白可以凭空冒出一件当下的小东西/小动静来递个新话把，让双方有台阶下、有新的可聊的抓手，打破尴尬、给双方递新话题，**但不替角色说话、不代拟台词**。',
          '【分辨"活"与"死"】要拍的是**正在发生的当下**（动着的、贴着人物此刻的），不是**静止的、无人触碰的背景**。',
          '【怎么写】景物由此刻此地现取——这一瞬、这一处、眼前这个人才有的光景，不必雕琢成"美文"。写之前先自问：这一句是"变化在发生"、"当下一瞬有质感"、还是"在转场/递话把"？四者都不占，这句就没有存在理由，不要写。',
          '【红线】不代写人物动作神态情绪本身（这些由角色在台词里带出）；不重复已用过的旁白意象；不照抄角色台词、不复述前文已交代的事实；不扮演角色、不说话、不拟人、不替角色说心里话；绝不输出任何"（旁白：…）""旁白：…"标签前缀或包裹——直接输出纯旁白文字本身。',
          '若给出了数值素材，必须严格基于它来写，不得另编或篡改数字。',
        ].join('\n'),
      },
      { role: 'user', content: build },
    ],
    { temperature: 0.8, maxTokens: 4096, callType: 'narration', playerId },
  );
  // 截断检测：输出被 max_tokens 切断 → 只生成了半句/不完整旁白，丢弃（返回空，调用方跳过该拍）
  if (res.truncated) {
    logs?.(`⚠️ 旁白输出被截断，丢弃该拍。`);
    return '';
  }
  // 防御性清理：模型偶尔仍会输出“（旁白：…）/旁白：…”标签前缀，直接剥掉。
  const cleaned = res.content.trim().replace(/^[（(]\s*旁白\s*[:：]\s*/u, '').replace(/^旁白\s*[:：]\s*/u, '');
  return cleaned.trim();
}

/**
 * 自动旁白：点名版男主发言时，在说话前/说话后有几率自动插入一段环境旁白。
 * 因为 namer 只负责"选谁说话"、没有导演的"排旁白"职责，导致点名版旁白结构性消失。
 * 这里在代码层补偿：男主这一拍说话前/后随机补一段旁白，恢复导演版那种旁白在场感。
 * 只在男主（maleNames）发言时触发；连续旁白不触发（上一拍已是旁白则跳过）。
 * @returns 是否实际插入了一条旁白
 */
async function maybeAutoNarration(opts: {
  p: number;                 // 触发概率（0~1）
  before: boolean;           // true=说话前(环境铺垫/氛围), false=说话后(余韵/转场)
  speaker: string;           // 本次发言的男主名（用于旁白呼应「他」）
  conversationSoFar: string; // 当前对话上下文（追加旁白用）
  currentTime: string;       // 当前时间（让旁白知道天色/光线该写什么）
  appendConversation: (s: string) => void; // 追加一段到对话上下文
  output: TurnOutputItem[];
  beats: SceneBeat[];
  log: (s: string) => void;
  onBeat?: (b: TurnOutputItem) => void;
  lastEmittedKind: () => string | null;   // 上一拍类型（旁白则跳过）
  setLastEmittedKind: (k: string) => void;
  emittedNarrationThisRound: Set<string>;
  playerId?: string;
}): Promise<boolean> {
  // 上一拍已是旁白 → 不连续旁白，跳过
  if (opts.lastEmittedKind() === 'narration') return false;
  if (Math.random() >= opts.p) return false;
  const timeHint = opts.currentTime ? `【当前时间】${opts.currentTime}\n` : '';
  const build = opts.before
    ? `${timeHint}【当前情境】\n${opts.conversationSoFar}\n\n【即将】「${opts.speaker}」要开口了。请写一句说话前的环境/氛围铺垫旁白（可以映照他此刻的心情，或铺垫接下来的气氛）。注意：环境描写（天色、光线、声响）必须与当前时间吻合，不要脑补与时间矛盾的天色。`
    : `${timeHint}【当前情境】\n${opts.conversationSoFar}\n\n【刚发生】「${opts.speaker}」刚说完话。请写一句说话后的余韵/转场旁白（捕捉他话落之后的空气、反应，或自然过渡到下一节）。注意：环境描写（天色、光线、声响）必须与当前时间吻合，不要脑补与时间矛盾的天色。`;
  const line = await runNarration(build, opts.log, opts.playerId);
  if (!line.trim()) return false;
  const narrationCore = line.replace(/（[^（）]*）/g, '').replace(/\\([^()]*\\)/g, '').replace(/[。！？，、：；\s]/g, '').trim();
  if (narrationCore && opts.emittedNarrationThisRound.has(narrationCore)) return false;
  opts.output.push({ kind: 'narration', content: line });
  opts.onBeat?.({ kind: 'narration', content: line });
  opts.beats.push({ kind: 'narration', intent: opts.before ? '男主说话前·氛围铺垫' : '男主说话后·余韵' });
  if (narrationCore) opts.emittedNarrationThisRound.add(narrationCore);
  opts.setLastEmittedKind('narration');
  opts.appendConversation(`\n（一段环境旁白：“${line}”）`);
  opts.log(`🎬 自动旁白（${opts.before ? '说话前' : '说话后'}）：${line}`);
  return true;
}

// ─── 演员 ─────────────────────────────────────────────

interface ActorOut {
  /** 多段气泡：一拍允许多条，每条一个气泡（参考旧版约会 messages 数组） */
  texts: string[];
  player_description?: string;
  /** 角色感知的当前活动/目的（如"正坐车前往码头"），随剧情演进 */
  current_activity?: string;
  internal?: string;
  internal_notable?: boolean;
  /** 角色主动带出移动意图：填目标地点名（如"我的办公室""阳台"），后端走层级匹配。只在角色真的要带人走时才填。 */
  move_to?: string;
}

/** 演员输出的 JSON Schema（vLLM json_schema 约束，强制输出可 parse 的合法 JSON）。
 *  字段类型明确，与 parseJsonLoose 兜底 + normalizeActorOut 构成「生成约束→解析容错→结构校验」三层。
 *  只有 texts 数组，没有 text 单字段——彻底避免模型把所有话塞进单个 text 用空行假装分段（气泡不分）。
 *  参考旧版约会：messages 数组是唯一通道，模型只能拆成多元素，天然分气泡。 */
const ACTOR_JSON_SCHEMA = {
  type: 'object',
  properties: {
    texts: { type: 'array', items: { type: 'string' } },
    player_description: { type: 'string' },
    current_activity: { type: 'string' },
    internal: { type: 'string' },
    internal_notable: { type: 'boolean' },
    move_to: { type: 'string' },
  },
  required: ['texts'],
} as const;

/**
 * 严格校验 + 归一化演员输出对象（已 parse 成对象的输入）。
 * 要求：texts 必须是非空 string 数组（可缺省，此时用非空 string 的 text 充当）；
 * player_description / internal 必须是 string；internal_notable 必须是 boolean（缺省 false）。
 * 任一不满足返回 null（调用方据此重试 LLM）。经此归一化的输出保证不含 ```json / 字段名 / 残缺结构。
 */
function normalizeActorOut(obj: Record<string, unknown>): ActorOut | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  // texts：唯一通道，必须是非空 string 数组（不允许用 text 单字段兜底——那样模型会用空行假装分段，气泡不分）
  if (!Array.isArray(obj.texts)) return null;
  if (!obj.texts.every((s: unknown) => typeof s === 'string')) return null;
  // 清洗：修复 LLM 双重转义的换行符。Gemma 在 JSON 字符串里写段落分隔时常用 `\\n`(两个字面字符)，
  // JSON.parse 后它就是字面 `\n`(反斜杠+n)，会原样落库——而气泡 white-space:pre-wrap 只渲染真实换行符，玩家会看见裸 `\n` 文本。
  // 与旧版 chat 路径 cleanMessageText 的 `\n` 处理对齐，把字面 `\n` 转回真实换行符。
  const unescapeNL = (s: string) => s.replace(/\\n/g, '\n');
  // 清理 LLM 偶发把 JSON 结构尾部粘到台词文本里（如 "...台词"],true,true,true,false,"）
  // 匹配末尾的 "或] + 逗号 + true/false/null 序列，正常台词不受影响
  const stripJsonTail = (s: string) => {
    let out = s.replace(/["\]]\s*,?\s*(?:true|false|null)(?:\s*,\s*(?:true|false|null))*\s*,?\s*$/s, '');
    // 去掉清理后末尾可能残留的孤立引号
    out = out.replace(/["\s]+$/s, '');
    return out;
  };
  const clean = (obj.texts as string[])
    .filter((s) => s && s.trim())
    .map(unescapeNL)
    .map(stripJsonTail)
    .filter((s) => s && s.trim());
  if (clean.length === 0) return null; // texts 存在但全空 → 非法（没有真台词）
  const out: ActorOut = { texts: clean };
  // player_description：string（可选）
  if (obj.player_description !== undefined && typeof obj.player_description !== 'string') return null;
  if (typeof obj.player_description === 'string') out.player_description = obj.player_description;
  // current_activity：string（可选）
  if (obj.current_activity !== undefined && typeof obj.current_activity !== 'string') return null;
  if (typeof obj.current_activity === 'string') out.current_activity = obj.current_activity;
  // internal：string（可选）
  if (obj.internal !== undefined && typeof obj.internal !== 'string') return null;
  if (typeof obj.internal === 'string') out.internal = unescapeNL(obj.internal);
  // internal_notable：boolean（可选，缺省 false）
  if (obj.internal_notable !== undefined && typeof obj.internal_notable !== 'boolean') return null;
  out.internal_notable = typeof obj.internal_notable === 'boolean' ? obj.internal_notable : false;
  // move_to：string（可选）——角色主动带人走时填目标地点名
  if (obj.move_to !== undefined && typeof obj.move_to !== 'string') return null;
  if (typeof obj.move_to === 'string' && obj.move_to.trim()) out.move_to = obj.move_to.trim();

  return out;
}

export async function runActor(
  input: SceneTurnInput,
  speaker: string,
  beatIntent: string,
  conversationSoFar: string,
  logs?: (s: string) => void,
): Promise<ActorOut> {
  // 松散匹配角色名：导演常输出全名（如"主播助理"）而 actor 表键可能是短名（"助理"）——与校验一致用双向包含
  const actorKey = Object.keys(input.actors).find(
    k => k.includes(speaker) || speaker.includes(k) || speaker === k,
  );
  const actor = actorKey ? input.actors[actorKey] : undefined;
  if (!actor) {
    logs?.(`⚠️ 未找到角色「${speaker}」的演员上下文，跳过该拍。`);
    return { texts: [], player_description: '' };
  }
  const tpl = loadPrompt(input.templates?.actor ?? 'scene.actor');
  // system = 只写「你是谁（人设）+ 这一下你要做什么（导演给的方向）」。对话历史**不进 system**，
  // 而是作为真实的 user/assistant 轮流轮次喂给模型（重建"正在和玩家连续聊天"的对话结构感，
  // 而不是压成一段平铺文本）——这是让角色回到旧版"有灵性、自然续写"的关键。
  let system = renderPrompt(tpl, {
    character_name: actor.character_name,
    character_card: actor.character_card,
    player_profile: actor.player_profile,
    player_name: input.scene.player_name ?? '',
    player_description: actor.player_description,
    current_activity: actor.current_activity,
    chronicle_summary: actor.chronicle_summary,
    retrieved_memories: actor.retrieved_memories ?? '',
    current_time: input.current_time ?? '',
    time_elapsed: input.scene.time_elapsed ?? '',
    location: input.scene.location,
    location_desc: input.scene.location_desc ?? '',
    available_locations: input.scene.available_locations ?? '',
    companions: input.scene.companions_raw ?? '',
    scene_tone: input.scene.scene_tone ?? '',
    scene_rules: [input.scene.scene_rules, actor.stance].filter(Boolean).join('\n'),
    beat_intent: beatIntent,
  });
  // 剧本场景无地点：location 为空时清理掉模板里残留的「地点：」空行
  if (!input.scene.location) {
    system = system.replace(/^地点：\s*$/m, '').replace(/^【地点导航】\n\s*\n/gm, '').replace(/^【地点导航】\n(?=（)/gm, '');
  }
  // 群聊：只有同场确实还有别的角色时，才在 system 里告诉演员「谁也在场」。
  // 用 companions_raw（真实角色列表，非 locationName 兜底）判断，避免单人场景误报。
  const otherCompanions = (input.scene.companions_raw ?? '').trim();
  const systemFinal = otherCompanions
    ? system + `\n\n【此刻同场的人】\n除了你和玩家，现在同场还有：${otherCompanions}`
    : system;

  // 把 conversationSoFar（`名字：话` 逐行）作为**已发生的对话**喂进去——
  // 角色＝assistant，其他所有人（玩家/别的角色/旁白）＝user。
  // 关键：每个角色只把自己的发言标为 assistant（那行是我的话），其余都标 user
  // （那些是别人/外部输入，不是我的）。这样模型清楚「我是 assistant，我在和
  // 一堆 user 对话」，不会把别的角色的话复述成自己、也不会串角色。
  // 行首名与当前 actor 相同 → assistant；否则（其他角色/玩家/旁白）→ user。
  // 末尾**不**加"轮到你了"类 nudge——消融测试(A/B)证明：加了那句反而把模型框回"扮演/接指令"
  // 模式、输出僵硬；不加时模型把"接着对话"视为自然延续，主动有主体感、更灵性、更自然分段。
  // system 里那句"你是你自己，接着这场对话继续说"已足够。直接以对话历史结尾让模型续写。
  const myName = actor.character_name;
  const playerName = input.scene.player_name ?? '';
  const dialogTurns: { role: 'user' | 'assistant'; content: string }[] = [];
  // 唯一格式拼装点（到「这个角色要说话」这一刻才统一拼）：
  //   - 行首 == 我 → assistant（自己说过的话）
  //   - 已以「（」开头（旁白/情境/已格式化的历史）→ user，保持原样，不重复套括号
  //   - 行首 == 玩家名 → user 裸（玩家是唯一要接的锚）
  //   - 其余（其他角色的裸话）→ user，统一套「（旁白：…）」成背景
  const lines = conversationSoFar.split('\n');
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith(`${myName}：`) || line.startsWith(`${myName}:`)) {
      dialogTurns.push({ role: 'assistant', content: line });
      continue;
    }
    const alreadyParen = line.startsWith('（');
    const isPlayer = playerName && (line.startsWith(`${playerName}：`) || line.startsWith(`${playerName}:`));
    if (alreadyParen || isPlayer) {
      dialogTurns.push({ role: 'user', content: line });
    } else {
      dialogTurns.push({ role: 'user', content: `（旁白：${line}）` });
    }
  }
  // 本轮新增：玩家引用的历史消息（统一措辞）+ 玩家本条新话（收尾锚）。
  const quote = input.scene.quote;
  if (quote && quote.quoteText) {
    const sender = quote.quoteSenderName || '对方';
    dialogTurns.push({ role: 'user', content: `（旁白：${playerName}引用了${sender}的历史消息：「${quote.quoteText}」）` });
  }
  const playerMsg = input.scene.player_message;
  if (playerMsg && playerMsg.trim()) {
    dialogTurns.push({ role: 'user', content: `${playerName}：${playerMsg}` });
  }
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: systemFinal },
    ...dialogTurns,
  ];

  // 严格解析 + 重试：先解析 JSON 并校验所有字段类型，任一字段对不上就重新调用 LLM，
  // 绝不把残缺 JSON/```json/字段名原文当台词露给用户。交由通用 chatJson 处理（剥围栏→parse→validate→重试）。
  let result = await chatJson<ActorOut>(
    messages,
    {
      schema: ACTOR_JSON_SCHEMA,
      temperature: 0.85,
      maxTokens: 2048,
      maxRetries: 2, // 共 3 次尝试
      normalize: normalizeActorOut,
      retryHint: () => 'texts 须为非空 string 数组（或 text 为非空 string），player_description/current_activity/internal 须为 string，internal_notable 须为 boolean',
      callType: 'actor',
      playerId: input.player_id,
    },
  );
  if (!result) {
    logs?.(`⚠️ 角色「${speaker}」多次重试仍无法产出合法输出，丢弃该拍。`);
    return { texts: [], player_description: '' };
  }
  // —— "X个字" 字数错配修正（LLM抓指代对象 + 程序数字 + LLM重写）——
  // 只在 actor 输出含"X个字"时触发额外调用；平时零开销。核心思路：
  //   数数字交给程序（确定性可靠），LLM 只做它擅长的（语义判断指代的是哪个词 + 文笔重写），
  //   绕开 Gemma「不会数汉字」的天生缺陷。保留正确用法（玩家恰好说2字词时）。
  try {
    const playerMsgNow = input.scene.player_message || '';
    // 只有任一条动描/台词里出现"一两三四五六七八九十+个字"（数字+个字）才触发额外LLM，平时零开销
    if (playerMsgNow && result.texts?.some((t: string) => /[一两三四五六七八九十]+个?字/.test(t))) {
      const fixedTexts = await fixXGeZi(result.texts, playerMsgNow, logs, input.scene.player_name, input.player_id);
      result.texts = fixedTexts;
      logs?.(`🔧 "X个字"字数修正完成: ${JSON.stringify(fixedTexts.map(s=>s.slice(0,20)))}`);
    }
  } catch (e: any) {
    logs?.(`⚠️ "X个字"修正异常(不影响原输出): ${e?.message || e}`);
  }
  // —— 复述检测 + LLM改写（程序检测首条bubble是否复述玩家话，命中则调LLM改写）——
  try {
    let playerMsgNow = input.scene.player_message || '';
    // 重试/继续空推轮：本轮无新玩家消息（player_message 为空），但角色可能复述对话历史里
    // 玩家最后一条话。从 conversationSoFar 末尾取玩家最近发言作检测锚点（只用于检测，不落库、不追加历史）。
    if (!playerMsgNow) {
      playerMsgNow = extractLastPlayerLine(conversationSoFar, playerName);
    }
    if (playerMsgNow && result.texts?.length) {
      const fixedTexts = await fixRepeatEcho(result.texts, playerMsgNow, logs, input.scene.player_name, input.player_id);
      if (fixedTexts !== result.texts) {
        result.texts = fixedTexts;
        logs?.(`🔧 复述改写完成: ${JSON.stringify(fixedTexts.map(s => s.slice(0, 20)))}`);
      }
    }
  } catch (e: any) {
    logs?.(`⚠️ 复述改写异常(不影响原输出): ${e?.message || e}`);
  }

  // —— 跨轮复述检测：角色本轮输出和自己在 conversationSoFar 里最近的发言高度相似时，
  //    带具体内容提示重试。Gemma 在玩家连续发"嗯""好"等相似短消息时，容易逐字复述上一轮回复。
  try {
    const myLines = conversationSoFar
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return t.startsWith(`${myName}：`) || t.startsWith(`${myName}:`);
      })
      .map((l) => l.replace(/^[^：:]+[：:]\s*/, ''));
    if (myLines.length > 0 && result.texts?.length) {
      const lastSpoken = myLines.slice(-3);
      const dupCheck = (texts: string[]) =>
        texts.some((t) => lastSpoken.some((prev) => _textSimilarity(t, prev) >= 0.8));
      if (dupCheck(result.texts)) {
        // 把重复的具体内容贴给模型，让它知道避开什么
        const prevQuote = lastSpoken.map((s, i) => `${i + 1}. ${s.slice(0, 80)}`).join('\n');
        const makeHint = (attempt: number) =>
          `（系统提示：你刚才已经说过以下内容——\n${prevQuote}\n\n` +
          `这是第${attempt}次提醒，请务必换一种完全不同的回应。` +
          `不要再说类似的动作或台词，推进到新的情绪、新的动作或新的话题方向。）`;
        // 最多重试2次（共3次尝试），每次升温
        for (let attempt = 1; attempt <= 2; attempt++) {
          logs?.(`🔁 检测到跨轮复述，第${attempt}次重试（temperature ${0.9 + attempt * 0.05}）…`);
          const hintMessages = [...messages, {
            role: 'user' as const,
            content: makeHint(attempt),
          }];
          const retryResult = await chatJson<ActorOut>(
            hintMessages,
            {
              schema: ACTOR_JSON_SCHEMA,
              temperature: 0.9 + attempt * 0.05,
              maxTokens: 4096,
              maxRetries: 1,
              normalize: normalizeActorOut,
              retryHint: () => 'texts 须为非空 string 数组',
              callType: 'actor',
              playerId: input.player_id,
            },
          );
          if (retryResult?.texts?.length && !dupCheck(retryResult.texts)) {
            logs?.(`✅ 第${attempt}次重试成功，已换新内容`);
            result = retryResult;
            break;
          }
          if (attempt === 2) {
            logs?.(`⚠️ 2次重试后仍复述，保留最后输出`);
          }
        }
      }
    }
  } catch (e: any) {
    logs?.(`⚠️ 跨轮复述检测异常(不影响原输出): ${e?.message || e}`);
  }

  return result;
}

/** 跨轮复述检测：归一化后比较（只保留字母数字，忽略标点/空格/括号差异） */
function _textSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');
  const na = norm(a), nb = norm(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  // 开头「第一句」重复检测：两条台词开口说的第一句相同（去动描括号、截到首个句末标点），
  // 判定为复读。此前只比「完全相同/包含」，导致「制服我？！（瞳孔…）」与「制服我？！（凄厉…）」
  // 这类「开头同句、后文不同」的复读漏掉——NPC 被重复点名时反复喊同一句。
  const firstA = _firstSpokenSentence(a);
  const firstB = _firstSpokenSentence(b);
  if (firstA && firstA === firstB) return 0.85;
  return 0;
}

/** 提取台词「开口说的第一句」：去掉动描括号后，截取第一个句末标点（。！？…）前的内容 */
function _firstSpokenSentence(s: string): string {
  const noAction = s.replace(/（[^（）]*）/g, '').trim();
  const m = noAction.match(/^([^。！？…!?]*)/);
  const first = (m?.[1] ?? noAction).trim();
  // 太短（单字）不判复读——「嗯」「好」这类口头禅重复由「完全相同」分支覆盖，避免过度误伤
  return first.length >= 2 ? first : '';
}

// ─── "X个字" 字数错配修正函数 ─────────────────────────
// 思路：LLM抓指代对象(语义) + 程序数字/比对(确定性) + LLM重写(文笔自然)。
// 绕开 Gemma「不会数汉字」的缺陷——数数字只交给程序。
const _NUM_MAP: Record<string, number> = { '一':1,'一个':1,'两':2,'两个':2,'三':3,'三个':3,'四':4,'四个':4,'五':5,'五个':5,'六':6,'七':7,'七个':7,'八':8,'九':9,'十':10,'几':-1 };
const _CJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
function _extractXGeZiCount(line: string): number | null {
  const m = line.match(/([一两三四五六七八九十几个]+)\s*个?字/);
  if (!m || !m[1]) return null;
  const k = m[1] as keyof typeof _NUM_MAP;
  return _NUM_MAP[k] ?? null;
}
function _countHanzi(s: string): number {
  const m = s.match(_CJK);
  return m ? m.length : 0;
}
function _cleanQuote(q: string, playerName?: string): string {
  // 剥离 LLM 返回 quote 里可能带的玩家名前缀（如"星落：某某"），用动态名而非硬编码
  const name = playerName?.trim();
  const prefixRe = name ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`) : null;
  return (prefixRe ? q.replace(prefixRe, '') : q).replace(/[\s，。？！,?!、；;：:""''~～…（）()]/g, '');
}
/** 对 texts 里含"X个字"的条目做字数校验修正：LLM抓指代对象→程序数字→LLM重写。 */
async function fixXGeZi(
  texts: string[],
  playerMsg: string,
  logs?: (s: string) => void,
  playerName?: string,
  playerId?: string,
): Promise<string[]> {
  const sysQuote =
    '玩家刚说了一句话，角色回应中出现了"X个字"（如"这两个字"），它指代玩家话里的某个词或短语。\n' +
    '你的任务：找出"X个字"在玩家话里具体指代的是哪几个字（玩家原话中连续的一段，最贴切被指代的那部分）。宁可取玩家真正强调的核心短词，不要取整句。\n' +
    '只输出一个JSON：{"quote":"玩家话里被指代的那几个字"}';
  const sysRewrite =
    '你是台词润色师。角色说过一句话，其中用"X个字"（如"这两个字"）指代了玩家的话，但字数对不上。\n' +
    '请重写这句角色台词，把指代改得自然、准确、贴合角色语气：可以用"这句话""这个字""这句话本身"等恰当表达，保持原有的动作神态、氛围、风格不变，只修正那个错误指代。\n' +
    '只输出重写后的完整句子，不要任何解释。';

  const out = [...texts];
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t == null || !/[一两三四五六七八九十]+个?字/.test(t)) continue;
    try {
      // ① LLM抓指代对象(语义)
      const qres = await chatJson<{ quote: string }>(
        [{ role: 'system', content: sysQuote }, { role: 'user', content: `【玩家的话】${playerMsg}\n【角色回应】${t}` }],
        { schema: { type: 'object', properties: { quote: { type: 'string' } }, required: ['quote'] }, temperature: 0, maxTokens: 300, maxRetries: 1, callType: 'xgezi-check', playerId }
      );
      if (!qres) continue;
      const quote = _cleanQuote(qres.quote || '', playerName);
      const qn = _countHanzi(quote);
      // ② 程序数字 + 比对
      const xc = _extractXGeZiCount(t);
      let changed = false;
      if (xc === null) changed = false;
      else if (xc === -1) changed = true;         // "几个字"泛指，视为需改
      else changed = (qn !== xc);                  // 字数对不上 → 改
      if (!changed) continue;                       // 字数对得上(如玩家说2字词)→ 保留
      // ③ 字数对不上 → LLM重写
      const rw = await chat(
        [{ role: 'system', content: sysRewrite }, { role: 'user', content: `【玩家的原话】${playerMsg}\n【角色这时的原句】${t}\n【问题】"${xc === -1 ? '几' : xc}个字"与玩家实际核心"${quote}"（${qn}字）不符，请重写。` }],
        { temperature: 0, maxTokens: 500, callType: 'xgezi-check', playerId }
      );
      const rewritten = (rw.content || '').trim();
      if (rewritten) {
        out[i] = rewritten;
        logs?.(`   ↳ 修正[${i}]: "${t.slice(0,18)}…" → "${rewritten.slice(0,18)}…"`);
      }
    } catch (e: any) {
      logs?.(`   ⚠️ 条目[${i}]修正失败(保留原样): ${e?.message || e}`);
    }
  }
  return out;
}

// ─── 复述检测 + LLM改写函数 ─────────────────────────────
// 思路：程序检测首条bubble是否复述玩家话（括号前文本去标点去"你我"后连续≥3字在玩家话中出现），
//   命中则调LLM用思维链改写（分3类：复述内容/依附比喻/实际动作，删前两类保留第三类重新表述）。
//   与 fixXGeZi 同模式：程序检测 + LLM改写，平时零开销（不复述不触发LLM）。
const _STRIP_REPEAT = /[。！？，、；：""''～…\?\-~,\.\s你我]/g;
function _isRepeatEcho(first: string, playerMsg: string): boolean {
  const bracketIdx = first.search(/[（(]/);
  const beforeBracket = bracketIdx > 0 ? first.slice(0, bracketIdx) : first;
  const bubbleClean = beforeBracket.replace(_STRIP_REPEAT, '');
  if (bubbleClean.length < 2) return false;
  const prefix = bubbleClean.slice(0, 4);
  const playerClean = playerMsg.replace(_STRIP_REPEAT, '');
  if (prefix.length >= 3 && playerClean.includes(prefix.slice(0, 3))) return true;
  if (prefix.length >= 4 && playerClean.includes(prefix.slice(0, 4))) return true;
  return false;
}

const _REPEAT_SYS =
  '你是文本编辑，精通中文台词润色。\n' +
  '你会收到玩家说的话和角色的回复。角色回复的开头重复了玩家的话，需要改掉。\n\n' +
  '请按以下步骤操作：\n' +
  '1. 找出角色回复中哪些部分是重复玩家原话的（包括开头复述的词、以及动作描写中暗示复述的片段如"重复着你的话""这两个字"等）\n' +
  '2. 找出哪些部分是依附于复述行为的比喻或感受（如"仿佛在承接承诺""像是要把这三个字印在心里"），这些在删掉复述后会失去依托\n' +
  '3. 找出哪些是角色实际的动作、神态和台词——这些要保留\n' +
  '4. 删掉第1、2类内容，只保留第3类，以合理的方式重新表述\n' +
  '5. 角色此时可能没有开口说话，不要添加说话的描写（如"应道""说道""低声说"等）\n' +
  '6. 保留原有的括号格式\n\n' +
  '先输出分析过程，然后输出【结果】标签，最后在【结果】后只输出处理后的内容。';

async function fixRepeatEcho(
  texts: string[],
  playerMsg: string,
  logs?: (s: string) => void,
  playerName?: string,
  playerId?: string,
): Promise<string[]> {
  if (!texts.length) return texts;
  const first = texts[0] ?? '';
  if (!first || !_isRepeatEcho(first, playerMsg)) return texts;

  logs?.(`🔍 检测到复述开场: "${first.slice(0, 30)}…"`);
  try {
    const rw = await chat(
      [
        { role: 'system', content: _REPEAT_SYS },
        {
          role: 'user', content:
            `${playerName || '玩家'}说了「${playerMsg}」\n` +
            `角色回复了：\n${first}\n` +
            `请分析并改掉重复的部分。保持语义和情绪不变。`,
        },
      ],
      { temperature: 0.85, maxTokens: 800, callType: 'repeat-echo-fix', playerId },
    );
    const full = (rw.content || '').trim();
    const match = full.match(/【结果】\s*([\s\S]*?)$/);
    const rewritten = (match && match[1]) ? match[1].trim() : '';
    if (!rewritten) {
      logs?.('   ⚠️ 改写结果为空，保留原文');
      return texts;
    }
    // 验证改写后不再复述
    if (_isRepeatEcho(rewritten, playerMsg)) {
      logs?.('   ⚠️ 改写后仍复述，保留原文');
      return texts;
    }
    logs?.(`   ↳ 改写: "${first.slice(0, 18)}…" → "${rewritten.slice(0, 18)}…"`);
    const out = [...texts];
    out[0] = rewritten;
    return out;
  } catch (e: any) {
    logs?.(`   ⚠️ 复述改写失败(保留原样): ${e?.message || e}`);
    return texts;
  }
}

// ─── 主入口 ───────────────────────────────────────────

// ════════════════════════════════════════════════════════════════
// 点名版导演（runSceneTurnNamed）
//
// 与旧导演版的区别（旧版已删除）：导演不再"一次排一整轮 beats"，而是"逐拍点名"——
// 每一拍：代码算出可用白名单 → 极简 namer 导演从编号表里选一个该说话的人 →
// 被点名者用 runActor/runNarration 真正生成。
//
// 落库/记忆/统计全部复用调用方（advanceScene）管线：
// 只要求返回的 result 形状与旧导演版一致（旧版已删除） {beats, output, statsState, attempts}。
//
// 硬约束（代码层强制，不靠导演自觉）：
//  - 白名单：第一拍玩家不可选；每拍剔除"上一拍发言人"（不连续）
//  - 玩家发言后必须至少一个"男主"说过话才算结束；否则兜底强制拉男主
//  - 拍数上限（导演不知，代码截断）
// ════════════════════════════════════════════════════════════════

/** 区分"男主"与"路人"：scene-wiring 把常驻路人塞进 actors 时，其 character_card 带「本地的常驻人物」标记；男主用 buildCharacterCard（无此标记）。 */
function isPasserby(actor: { character_card: string } | undefined): boolean {
  return !!actor?.character_card?.includes('本地的常驻人物');
}

/** "男主" = 能加好友、有行程的在场角色（非路人）。兜底必须落在这类角色上。 */
function namedMaleNames(input: SceneTurnInput): string[] {
  return Object.keys(input.actors).filter((k) => !isPasserby(input.actors[k]));
}

/** 可用候选：男主 + 路人 + 旁白（可被点名；路人也参与，只是不作为兜底男主）。 */
function buildCandidatePool(input: SceneTurnInput): string[] {
  const allActors = Object.keys(input.actors);
  // 旁白作为独立候选（与角色/路人平等竞争）
  const pool = [...allActors, '旁白'];
  return pool;
}

/**
 * 极简点名器：让 namer 从编号表里选一个该说话的人（或"玩家"=把话头还给玩家）。
 * 返回被选中的候选人字符串（"玩家" 表示把话头还给玩家/结束）。
 */
export async function pickNextSpeaker(
  input: SceneTurnInput,
  available: string[],
  conversationSoFar: string,
  log: (s: string) => void,
  renderProfiles?: (avail: string[]) => string,
): Promise<{ speaker: string }> {
  const tpl = loadPrompt(input.templates?.namer ?? 'scene.namer');
  const system = renderPrompt(tpl, {
    conversation_so_far: conversationSoFar,
    available_candidates: available.map((c, i) => `${i + 1}：${c}`).join('\n'),
    candidate_profiles: renderProfiles ? renderProfiles(available) : '',
    available_locations: input.scene.available_locations ?? '',
    location: input.scene.location ?? '',
  });
  const msgs: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: system },
    { role: 'user', content: '选择编号。' },
  ];
  const res = await chatJson<{ pick: number }>(msgs, {
    schema: {
      type: 'object',
      properties: {
        pick: { type: 'integer' },
      },
      required: ['pick'],
    },
    temperature: 0.2,
    maxTokens: 80,
    callType: 'namer',
    playerId: input.player_id,
  });
  const idx = typeof res?.pick === 'number' ? res.pick : NaN;
  const named = (available[idx - 1] ?? available[0])!; // 越界/NaN 兜底到第一个
  log(`【点名】候选[${available.map((c, i) => `${i + 1}:${c}`).join(',')}] → 选「${idx}」→「${named}」`);
  return { speaker: named };
}

/**
 * 点名版主入口。返回形状与旧导演版一致（旧版已删除），供同名落库/记忆管线复用。
 */
export async function runSceneTurnNamed(
  input: SceneTurnInput,
  opts?: {
    onLog?: (s: string) => void;
    onBeat?: (b: TurnOutputItem) => void;
  },
): Promise<SceneTurnResult> {
  const log = opts?.onLog ?? (() => {});
  const onBeat = opts?.onBeat;

  const maxBeats = Number(input.max_beats ?? input.scene.max_beats ?? 5) || 5;
  const pool = buildCandidatePool(input);
  const maleNames = namedMaleNames(input);

  // ── 候选身份人设表：给 namer 看每个在场者的完整人设 ──
  // 男主（非路人）：完整角色卡（buildCharacterCard）
  // 路人：character_card 里带「本地的常驻人物」标记的人设
  // 旁白：固定环境叙述者人设
  // 玩家：玩家资料（player_profile）
  // 显式标注谁是「男主」、谁是「路人」，让 namer 在点名时知道每个候选的身份主次。
  const NARRATOR_PROFILE = '旁白——环境叙述者：只写此刻画面/氛围/转场，不替角色说话，不写具体台词。';
  const profilesMap: Record<string, string> = {};
  for (const [name, actor] of Object.entries(input.actors)) {
    const isResident = isPasserby(actor);
    if (isResident) {
      profilesMap[name] = `本地常驻路人（配角）——${name}。${actor?.character_card ?? ''}`;
    } else {
      // 男主（可加好友、有行程的同行者）
      profilesMap[name] = `男主（同行者）——${name}。${actor?.character_card ?? ''}`;
    }
  }
  profilesMap['旁白'] = NARRATOR_PROFILE;
  // 玩家资料：取自任一 actor 的 player_profile（各角色视角下对玩家的描述/资料）
  const firstActorProfile = Object.values(input.actors)[0]?.player_profile;
  profilesMap['玩家'] = firstActorProfile
    ? `玩家——${firstActorProfile}`
    : '玩家——本场对话的另一方。';

  // 渲染候选表：名字 + 身份 + 人设（供 v2 模板 candidate_profiles 使用）
  const renderCandidateProfiles = (avail: string[]): string =>
    avail.map((n, i) => `${i + 1}：${n} —— ${profilesMap[n] ?? ''}`).join('\n');

  let statsState = { ...(input.stats_state ?? {}) };
  const output: TurnOutputItem[] = [];
  const beats: SceneBeat[] = []; // 点名的"结果"回填为 character/narration beats 供 move/stats 落库
  const attempts = 0; // 点名版不重试，固定为 0（类型兼容 SceneTurnResult）

  const emittedThisRound = new Set<string>();
  // 上一条实际输出的拍的类型（narration/character）——旁白不得连续两拍
  let lastEmittedKind: string | null = null;
  let lastSpeaker: string | null = null; // 上一拍发过言的人（点名单剔除用）
  let conversationSoFar = input.scene.conversation_so_far;
  // 本轮玩家新发言：namer/narration 需要看到（用 convWithPlayer 拼在末尾传入），
  // 但 runActor 不需要——runActor 自己会在 dialogTurns 末尾追加 player_message。
  // 之前把 player_message 追加进 conversationSoFar 再传给 runActor，导致重复出现两次。
  const pMsgRaw = input.scene.player_message?.trim();
  const pn = input.scene.player_name ?? '';
  const convWithPlayer = (base: string): string =>
    pMsgRaw ? `${base}\n${pn ? `${pn}：` : ''}${pMsgRaw}` : base;

  // 旁白去重集合（预填历史）——与旧导演版相同（旧版已删除）
  const emittedNarrationThisRound = new Set<string>();
  for (const line of conversationSoFar.split('\n')) {
    const t = line.trim();
    let content: string | null = null;
    let m = t.match(/^（旁白）\s*(.+)$/);
    if (m) content = m[1] ?? null;
    else if ((m = t.match(/^（旁白[：:]?\s*(.+?)）$/))) content = m[1] ?? null;
    else if ((m = t.match(/^（一段环境旁白[：:]?\s*[“"]\s*(.+?)\s*[”"]\s*）$/))) content = m[1] ?? null;
    if (content == null) continue;
    const core = content.replace(/[“”"]/g, '').replace(/[。！？，、：；\s]/g, '').trim();
    if (core) emittedNarrationThisRound.add(core);
  }

  const maleSpoke = new Set<string>();
  const hasPlayerInput = input.has_player_turn_input;
  let movePushed = false; // 每轮只接受第一个 move 拍（namer 多次点名可能重复判定同一移动）

  // 首次开场（玩家从未发过言）：先来一段环境旁白作为第一拍
  if (!input.scene.has_player_spoken) {
    try {
      const locName = input.scene.location ?? '某个地方';
      const locDesc = input.scene.location_desc ?? '';
      // 剧本场景无地点名：用世界观描述代替，避免裸露的「当前地点：。」
      const locLabel = locName || (locDesc ? locDesc.slice(0, 40) : '某个地方');
      // 注入开场情境（circumstance）——让旁白感知"初遇/被逮到/赴约"等氛围
      let circumstanceInfo = '';
      const circumstance = input.scene.circumstance;
      if (circumstance && circumstance !== 'default') {
        const greeting = loadGreetingSection(circumstance, {
          companions: input.scene.companions ?? '',
          location: locLabel,
        });
        // 只取情境描述部分（去掉 default 基础纪律，旁白不需要导演纪律）
        const parts = greeting.split('【本场情境】');
        circumstanceInfo = parts[1]?.trim() ?? parts[0]?.trim() ?? '';
      }
      const ct = input.current_time ?? '';
      const timePrefix = ct ? `当前时间：${ct}。` : '';
      const narrationBuild = `${timePrefix}当前地点：${locLabel}。${locDesc ? locDesc : ''}。${circumstanceInfo}。${input.scene.environmental_clues ? `环境线索（可在合适时自然带出，不必每次都提）：${input.scene.environmental_clues}。` : ''}写一段环境旁白。注意：环境描写（天色、光线、声响）必须与当前时间吻合，不要脑补与时间矛盾的天色。`;
      const narrationLine = await runNarration(narrationBuild, log, input.player_id);
      if (narrationLine) {
        output.push({ kind: 'narration', content: narrationLine });
        onBeat?.({ kind: 'narration', content: narrationLine });
        beats.push({ kind: 'narration', intent: '开场环境' });
        lastEmittedKind = 'narration';
        conversationSoFar += `\n（一段环境旁白："${narrationLine}"）`;
        log(`🎬 [开场旁白] ${narrationLine.slice(0, 60)}`);
      }
    } catch (e) {
      log(`⚠️ 开场旁白生成失败：${(e as Error).message}`);
    }
  }

  let beatNo = 0;
  // 点名循环：每拍生成完再继续，直到点到"玩家"（=结束）或达拍数上限
  // 注意：本循环是「生成完一拍才点下一次名」——这正是"逐拍"与"整轮预排"的关键差异
  while (beatNo < maxBeats) {
    // ── 算本拍可用白名单 ──
    // 多人剧本（≥2个男主）：所有男主都发过言之前，"玩家"不可选——
    // 避免 namer 在第一个 NPC 回完后就把话头还给玩家，导致其余 NPC 永远没机会开口。
    // 所有男主都发过言之后：只给 namer "玩家"选项——直接结束轮次，
    // 避免 A→B→A→B 循环到 maxBeats 导致每人说一堆。
    const allMalesSpoke = maleNames.length >= 2 && maleNames.every((n) => maleSpoke.has(n));
    let available: string[] = [];
    if (allMalesSpoke) {
      // 多人剧本全员已发言 → 只给"玩家"= 结束
      available = ['玩家'];
    } else if (beatNo === 0) {
      // 第一拍：玩家不可选（玩家刚发言，第一拍必须有人接；开场轮也无"玩家"候选概念）
      // 旁白不参与点名——由 maybeAutoNarration 自动插入
      available = pool.filter((c) => c !== '玩家' && c !== '旁白' && c !== lastSpeaker);
    } else {
      // 第二拍起：可点"玩家"（把话头还给玩家 = 结束）
      // 旁白不参与点名——由 maybeAutoNarration 自动插入
      // 但多人剧本未全员发言时，暂不开放"玩家"选项
      available = [...pool, ...(maleNames.length < 2 ? ['玩家'] : [])].filter((c) => c !== '旁白' && c !== lastSpeaker);
    }
    // 兜底白名单：全被剔除时，至少保留一个男主
    if (available.length === 0) {
      available = maleNames.filter((c) => c !== lastSpeaker);
    }
    if (available.length === 0) break;

  // ── 点名选人 ──
    let speaker: string;
    try {
      // 第一拍：用 convWithPlayer 让 namer 看到玩家本轮新消息（如"（看向方知衡）"），
      // 这样 namer 能根据玩家说话对象选对人。
      // 后续拍：用裸 conversationSoFar，避免每拍末尾都是玩家消息导致误判。
      const convForNamer = beatNo === 0 ? convWithPlayer(conversationSoFar) : conversationSoFar;
      const picked = await pickNextSpeaker(input, available, convForNamer, log, renderCandidateProfiles);
      speaker = picked.speaker;
    } catch (e) {
      log(`⚠️ 点名失败：${(e as Error).message}——若尚未有男主发言则兜底，否则结束。`);
      break;
    }

    // 点到"玩家"= 把话头还给玩家 = 这一轮结束
    if (speaker === '玩家') {
      log('→ 点到玩家：把话头还给玩家，本轮结束。');
      beats.push({ kind: 'character', speaker: '玩家', intent: '把话头交给玩家（结束）' });
      break;
    }
    // ── 被点名者真正生成（复用 runActor / runNarration，与导演版同款执行体）──
    if (speaker === '旁白') {
      // 连续旁白兜底：上一拍已是旁白 → 跳过（保证旁白不连续）
      if (lastEmittedKind === 'narration') {
        log('↩️ 跳过：上一拍已是旁白，旁白不连续。');
        lastSpeaker = '旁白';
        beatNo++;
        continue;
      }
      const line = await runNarration(
        `【当前情境】\n${convWithPlayer(conversationSoFar)}${input.scene.environmental_clues ? `\n环境线索（可在合适时自然带出，不必每次都提）：${input.scene.environmental_clues}。` : ''}\n\n请写这一句旁白。`,
        log,
        input.player_id,
      );
      if (!line.trim()) {
        log('↩️ 跳过空旁白拍（截断或生成失败）。');
        lastSpeaker = '旁白';
        beatNo++;
        continue;
      }
      const narrationCore = line.replace(/（[^（）]*）/g, '').replace(/\\([^()]*\\)/g, '').replace(/[。！？，、：；\s]/g, '').trim();
      if (narrationCore && emittedNarrationThisRound.has(narrationCore)) {
        log(`↩️ 跳过重复旁白：${line}`);
        lastSpeaker = '旁白';
        beatNo++;
        continue;
      }
      output.push({ kind: 'narration', content: line });
      onBeat?.({ kind: 'narration', content: line });
      beats.push({ kind: 'narration', intent: '旁白' });
      if (narrationCore) emittedNarrationThisRound.add(narrationCore);
      lastEmittedKind = 'narration';
      lastSpeaker = '旁白';
      conversationSoFar += `\n（一段环境旁白：“${line}”）`;
      beatNo++;
      continue;
    }

    // speaker 是角色/路人（input.actors 里的某个 key）
    const actKey = Object.keys(input.actors).find(
      (k) => k.includes(speaker) || speaker.includes(k) || k === speaker,
    );
    if (!actKey) {
      log(`⚠️ 点名到未知者「${speaker}」，跳过该拍。`);
      lastSpeaker = speaker;
      beatNo++;
      continue;
    }
    // 连续同角色：上一条刚是这人 → 跳过（不连续）
    if (lastSpeaker !== null && actKey === lastSpeaker) {
      log(`↩️ 跳过连续同角色拍：${speaker} 上一条刚说过。`);
      lastSpeaker = speaker;
      beatNo++;
      continue;
    }
    const out = await runActor(input, speaker, '自然地推进此刻的互动，回应玩家刚才的话。', conversationSoFar, log);
    const actCharId = input.actors[actKey]?.character_id;

    const rawBubbles = (Array.isArray(out.texts) && out.texts.length > 0)
      ? out.texts.filter((s: string) => s && s.trim())
      : [];
    // 去重：同一角色不允许把同一句说第二遍（含跨拍、跨他人间隔）
    // 纯动作描写是合法回复——角色可以不说话只用动作回应，不过滤
    const filtered: string[] = [];
    for (const b of rawBubbles) {
      const key = `${speaker}│${b.trim()}`;
      if (emittedThisRound.has(key)) continue;
      emittedThisRound.add(key);
      filtered.push(b);
    }
    const bubbles: string[] = [];
    for (const b of filtered) {
      if (bubbles.length && bubbles[bubbles.length - 1]!.trim() === b.trim()) continue;
      bubbles.push(b);
    }
    if (bubbles.length === 0) {
      log(`← ${speaker} 生成空，跳过该拍。`);
      lastSpeaker = speaker;
      beatNo++;
      continue;
    }

    // 自动旁白：男主说话前有几率铺垫氛围（点名版旁白补偿）
    const isMaleLead = maleNames.includes(speaker);
    if (isMaleLead) {
      await maybeAutoNarration({
        p: NARRATE_BEFORE_P,
        before: true,
        speaker,
        conversationSoFar,
        currentTime: input.current_time ?? '',
        appendConversation: (s) => { conversationSoFar += s; },
        output,
        beats,
        log,
        onBeat,
        lastEmittedKind: () => lastEmittedKind,
        setLastEmittedKind: (k) => { lastEmittedKind = k; },
        emittedNarrationThisRound,
        playerId: input.player_id,
      });
    }

    for (let bi = 0; bi < bubbles.length; bi++) {
      const bubble = cleanStraySymbols(bubbles[bi]!);
      const internal = bi === 0 ? out.internal : '';
      const internalNotable = bi === 0 ? out.internal_notable : false;
      output.push({
        kind: 'character',
        content: bubble,
        speaker,
        characterId: actCharId,
        internal,
        internalNotable,
        playerDescription: out.player_description,
        currentActivity: out.current_activity,
      });
      onBeat?.({
        kind: 'character',
        content: bubble,
        speaker,
        characterId: actCharId,
        internal,
        internalNotable,
        playerDescription: out.player_description,
        currentActivity: out.current_activity,
      });
      conversationSoFar += `\n${speaker}：${bubble}`;
    }
    beats.push({ kind: 'character', speaker, intent: '互动推进' });
    lastEmittedKind = 'character';
    lastSpeaker = speaker;
    // 男主已发言记录
    if (maleNames.includes(speaker)) maleSpoke.add(speaker);

    // 角色主动带出移动：actor 输出 move_to 时推一个 move beat（每轮只接受第一个）
    if (out.move_to && !movePushed) {
      log(`🧭 角色「${speaker}」带出移动 → ${out.move_to}`);
      beats.push({ kind: 'action', type: 'move', to: out.move_to, intent: `${speaker}带对方去${out.move_to}` });
      movePushed = true;
    }

    // 自动旁白：男主说话后有几率补一句余韵/转场（点名版旁白补偿）
    if (isMaleLead) {
      await maybeAutoNarration({
        p: NARRATE_AFTER_P,
        before: false,
        speaker,
        conversationSoFar,
        currentTime: input.current_time ?? '',
        appendConversation: (s) => { conversationSoFar += s; },
        output,
        beats,
        log,
        onBeat,
        lastEmittedKind: () => lastEmittedKind,
        setLastEmittedKind: (k) => { lastEmittedKind = k; },
        emittedNarrationThisRound,
        playerId: input.player_id,
      });
    }

    beatNo++;
  }

  // ── 兜底 ──
  //   · 本轮玩家发了话（hasPlayerInput）→ 必须有一个男主回应，无论是否开场。
  //     旁白/路人说了不算，必须是男主（能加好友、有行程的角色）。
  //     （注意：不能用 isOpening 当门槛——isOpening 看的是「历史里有没有玩家消息」，
  //       而「玩家第一次发言」时历史里恰好还没有玩家消息，会被误判成开场轮而漏掉回应。
  //       判定依据必须是「本轮有没有玩家输入」，即 hasPlayerInput。）
  //   · 本轮无玩家输入（开场轮/continue）→ 若完全没有可见输出，兜底拉一个男主开场。
  if (hasPlayerInput) {
    if (maleSpoke.size === 0) {
      log('⚠️ 玩家发了话但本轮无任何男主发言，强制兜底拉男主回应…');
      const fbName = maleNames[0]!;
      const fb = await runActor(input, fbName, '针对玩家刚才这句话自然地回应。', conversationSoFar, log);
      const fbBubbles = (Array.isArray(fb.texts) ? fb.texts : []).filter((s: string) => s && s.trim());
      const actCharId = input.actors[fbName]?.character_id;
      for (let bi = 0; bi < fbBubbles.length; bi++) {
        const bubble = cleanStraySymbols(fbBubbles[bi]!);
        const internal = bi === 0 ? fb.internal : '';
        output.push({ kind: 'character', content: bubble, speaker: fbName, characterId: actCharId, internal, internalNotable: bi === 0 ? !!fb.internal_notable : false, playerDescription: fb.player_description, currentActivity: fb.current_activity });
        onBeat?.({ kind: 'character', content: bubble, speaker: fbName, characterId: actCharId, internal, internalNotable: bi === 0 ? !!fb.internal_notable : false, playerDescription: fb.player_description, currentActivity: fb.current_activity });
        conversationSoFar += `\n${fbName}：${bubble}`;
      }
      beats.push({ kind: 'character', speaker: fbName, intent: '回应玩家（兜底）' });
      maleSpoke.add(fbName);
      log(`✅ 兜底由「${fbName}」补出 ${fbBubbles.length} 条气泡。`);
    }
  } else {
    // 无玩家输入的开场/continue：若完全没有可见输出则兜底拉男主开场
    const visibleCount = output.filter((o) => o.kind === 'character' || o.kind === 'narration').length;
    if (visibleCount === 0 && maleNames.length > 0) {
      log('⚠️ 开场无可见输出，兜底让男主开场…');
      const fbName = maleNames[0]!;
      // 兜底男主 intent 注入 circumstance 情境提示
      let fbIntent = '开场自然地开口，和玩家展开对话。';
      const fbCirc = input.scene.circumstance;
      if (fbCirc && fbCirc !== 'default') {
        const fbGreeting = loadGreetingSection(fbCirc, {
          companions: input.scene.companions ?? '',
          location: input.scene.location ?? '',
        });
        const fbParts = fbGreeting.split('【本场情境】');
        const fbSpecific = fbParts[1]?.trim() ?? '';
        if (fbSpecific) fbIntent = `${fbIntent}\n${fbSpecific}`;
      }
      const fb = await runActor(input, fbName, fbIntent, conversationSoFar, log);
      const fbBubbles = (Array.isArray(fb.texts) ? fb.texts : []).filter((s: string) =>
        s.replace(/（[^（）]*）/g, '').replace(/\\([^()]*\\)/g, '').trim().length > 0);
      const actCharId = input.actors[fbName]?.character_id;
      for (let bi = 0; bi < fbBubbles.length; bi++) {
        const bubble = cleanStraySymbols(fbBubbles[bi]!);
        const internal = bi === 0 ? fb.internal : '';
        output.push({ kind: 'character', content: bubble, speaker: fbName, characterId: actCharId, internal, internalNotable: bi === 0 ? !!fb.internal_notable : false, playerDescription: fb.player_description, currentActivity: fb.current_activity });
        onBeat?.({ kind: 'character', content: bubble, speaker: fbName, characterId: actCharId, internal, internalNotable: bi === 0 ? !!fb.internal_notable : false, playerDescription: fb.player_description, currentActivity: fb.current_activity });
        conversationSoFar += `\n${fbName}：${bubble}`;
      }
      beats.push({ kind: 'character', speaker: fbName, intent: '开场（兜底）' });
      maleSpoke.add(fbName);
    }
  }

  return { beats, output, statsState, attempts };
}

