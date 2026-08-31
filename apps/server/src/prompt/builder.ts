/**
 * Prompt Builder — 角色数据→LLM prompt的组装逻辑
 * 参考lysk架构设计，内容为无限流meta层
 */
import type { CharacterData, LlmStructuredReply } from '@idate/shared';
import { loadPrompt, renderPrompt } from './loader';
import { tryParseJsonReply, chat, type ChatMessage } from '../llm/adapter';
import { DEITY_ID } from '@idate/shared';
import { db } from '../db';
import { getLocationPath } from '../routes/location';
import { config } from '../config';

/**
 * vLLM guided_json schema — 从源头约束LLM输出合法JSON
 * 避免 gemma 等模型输出语法错误的JSON导致fallback裸露
 */
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    messages: { type: 'array', items: { type: 'string' } },
    internal: { type: 'string' },
    internal_notable: { type: 'boolean' },
    player_description: { type: 'string' },
    scene_concluded: { type: 'boolean' },
    current_location: { type: 'string' },
    need_search: { type: 'boolean' },
    search_query: { type: 'string' },
    image_prompt: { type: 'string' },
  },
  required: ['messages', 'internal', 'internal_notable', 'player_description', 'scene_concluded'],
};

export interface PromptContext {
  characterData: CharacterData | null;
  playerDescription: string;
  playerProfile: string; // 玩家性别+外貌（来自设置）
  chronicleSummary: string;
  recentMessages: { role: 'player' | 'assistant'; text: string }[];
  isTextMessage: boolean; // true=短信场景, false=约会场景
  isDeity: boolean; // true=主神对话
  locationName?: string; // 约会起始地点
  currentLocationName?: string; // 约会中实时地点（移动后与起始不同时传入）
  worldContext?: string; // 世界设定文本
  hubLocations?: string; // 主城地点列表（名称+简述），让NPC知道主城有什么地方
  retrievedMemories?: string | null; // 向量检索命中的相关记忆（Phase 5）
  currentTime?: string; // 当前时间（日期+时段）
  relationshipDuration?: string; // 认识多久（"3天前初次相遇"等）
  situationalNote?: string; // 情境注脚（可选，如"被吵醒"），追加在 system prompt 末尾
}

/**
 * 格式化认识时长
 */
export function formatRelationshipDuration(created_at: number): string {
  const diff = Date.now() - created_at;
  const days = Math.floor(diff / 86400000);
  if (days < 1) return '今天刚认识';
  if (days === 1) return '昨天初次相遇';
  if (days < 7) return `${days}天前初次相遇`;
  if (days < 14) return '一周前初次相遇';
  if (days < 30) return `${Math.floor(days / 7)}周前初次相遇`;
  if (days < 60) return '一个月前初次相遇';
  if (days < 365) return `${Math.floor(days / 30)}个月前初次相遇`;
  return `${Math.floor(days / 365)}年前初次相遇`;
}

/**
 * 格式化当前时间（中文日期+时段）
 */
export function formatCurrentTime(): string {
  const now = new Date();
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  const day = days[now.getDay()];
  const hour = now.getHours();
  let period: string;
  if (hour < 6) period = '凌晨';
  else if (hour < 12) period = '上午';
  else if (hour < 14) period = '中午';
  else if (hour < 18) period = '下午';
  else if (hour < 22) period = '晚上';
  else period = '深夜';
  return `星期${day} ${period}（约${hour}点）`;
}

/**
 * 获取主城地点列表文本 — 注入NPC system prompt，避免NPC虚构地点
 * 只取公开地点（NPC知道公共场所，不知道玩家的私有地点）
 * 显示完整路径（如"星河公园 › 湖边长椅"），让NPC知道地点的层级关系
 */
export function getHubLocationsText(): string {
  const locations = db.prepare(
    "SELECT id, name, summary FROM locations WHERE is_public = 1 ORDER BY name"
  ).all() as Array<{ id: string; name: string; summary: string }>;
  if (locations.length === 0) return '';
  return locations.map(l => {
    const path = getLocationPath(l.id);
    return `- ${path}${l.summary ? `：${l.summary}` : ''}`;
  }).join('\n');
}

/**
 * 获取玩家性别+外貌文本（注入prompt）
 */
export function getPlayerProfile(playerId: string): string {
  const player = db.prepare('SELECT name, gender, appearance FROM players WHERE id = ?').get(playerId) as {
    name: string; gender: string; appearance: string;
  } | undefined;
  if (!player) return '';
  const genderText = player.gender === 'female' ? '女' : player.gender === 'male' ? '男' : '其他';
  const parts: string[] = [`性别：${genderText}`];
  if (player.appearance) parts.push(`外貌：${player.appearance}`);
  return parts.join('，');
}

/**
 * 构建NPC的system prompt
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  if (ctx.isDeity) {
    return loadPrompt('deity.system');
  }

  const tpl = loadPrompt('roleplay.system');
  const char = ctx.characterData;
  if (!char) return tpl;

  // 角色卡统一注入（character-card.txt 模板）
  const characterCard = formatCharacterCard(char);

  // 叙事规则按场景只注入对应的一条
  const narrativeRules = ctx.isTextMessage
    ? '- 你正在发短信，玩家看不见你。绝对不要写动作描写、场景描写或舞台指示——没有（括号动作）、没有环境描述，只有纯文字消息。通过文字特征传达情绪：回复速度的快慢暗示、消息长短的变化、标点的有无、语气词的增减、打字习惯（如突然用句号表示冷淡）'
    : [
        '- 玩家能看见你。每条回复都要有身体语言——表情变化、肢体动作、与环境的互动、和玩家之间的物理距离感。用（括号）包裹动作描写，穿插在台词之间，不要全堆在开头或结尾。角色卡的emotional_signals是行为倾向参考，不要逐字照搬，每次根据当下情境变化细节',
        '- 情绪通过行为传达，不直接写心理陈述',
        '- 动作描写省略主语，不写"我"——直接写动作本身（如"唇角微微抿出弧度"而非"我唇角微微抿出弧度"）',
        '- 动作描写直接呈现状态，不要用"由于…而…"句式解释原因。写"指尖微微蜷缩"而非"由于放松而微微蜷缩"，写"肌肉紧绷"而非"由于过度紧绷而战栗"',
      ].join('\n');

  // 输出格式里 messages 字段的条数 + 动作描写说明，按场景区分（短信只有纯文字）
  const messageRule = ctx.isTextMessage
    ? '短信场景可发多条（逐条弹出），只有纯文字消息，绝对不要动作描写'
    : '约会场景一般一条，动作描写用中文括号（）';

  // 组装地点文本：优先显示当前地点（移动后的），否则显示起始地点
  const locationText = ctx.currentLocationName || ctx.locationName || '';

  // 生图是否可用：未配置生图服务时，明确告诉 NPC 不要分享图片
  const imageGenInstruction = config.ideogramUrl
    ? '当你想要分享图片时，用中文描述图片的内容。如果画面里出现你自己，用你的性别和外貌特征来描述，不要省略。'
    : '（生图功能未启用：不要分享图片，image_prompt 始终留空）';

  const rendered = renderPrompt(tpl, {
    character_name: char.name,
    character_card: characterCard,
    player_description: ctx.playerDescription,
    player_profile: ctx.playerProfile,
    chronicle_summary: ctx.chronicleSummary,
    retrieved_memories: ctx.retrievedMemories ?? '',
    location: locationText,
    world_context: ctx.worldContext ?? '',
    hub_locations: ctx.hubLocations ?? '',
    current_time: ctx.currentTime ?? formatCurrentTime(),
    relationship_duration: ctx.relationshipDuration ?? '',
    narrative_rules: narrativeRules,
    message_rule: messageRule,
    image_gen_instruction: imageGenInstruction,
  });
  if (ctx.situationalNote) return rendered + '\n\n' + ctx.situationalNote;
  return rendered;
}

/**
 * 构建对话消息列表
 */
export function buildMessages(
  systemPrompt: string,
  recentMessages: { role: 'player' | 'assistant'; text: string }[],
  currentPlayerInput: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of recentMessages) {
    messages.push({
      role: msg.role === 'player' ? 'user' : 'assistant',
      content: msg.text,
    });
  }

  messages.push({ role: 'user', content: currentPlayerInput });
  return messages;
}

/**
 * 把一条短信消息转成给 LLM 看的文本。
 * 图片消息（image_asset_id 非空）用 metadata.image_prompt（图的文字描述）替代，
 * 让 NPC 后续回复时知道自己发过/收到过什么图。
 * 玩家发图时可能同时配了文字（body 非空），此时别把文字丢掉。
 */
export function smsMessageText(m: { sender: string; body: string; image_asset_id?: string | null; metadata?: string | null }): string {
  if (!m.image_asset_id) return m.body;
  let prompt = '';
  if (m.metadata) {
    try {
      const meta = JSON.parse(m.metadata) as { image_prompt?: string };
      prompt = (meta.image_prompt ?? '').trim();
    } catch {
      prompt = '';
    }
  }
  const imgDesc = prompt ? `（照片：${prompt}）` : '（照片）';
  return m.body ? `${m.body}${imgDesc}` : imgDesc;
}

/**
 * 调用LLM并解析结构化输出
 * parse失败重试一次，再失败则把原始输出当纯文本reply
 */
/** 归一化文本用于相似度比较（只保留字母数字，忽略标点/空格/括号） */
function _normText(s: string): string {
  return s.replace(/[^\p{L}\p{N}]/gu, '');
}

/** 检查 NPC 回复是否逐字复述/高度模仿了玩家的话 */
function _isEchoingPlayer(replyMessages: string[], playerInput: string): boolean {
  const playerNorm = _normText(playerInput);
  if (!playerNorm || playerNorm.length < 2) return false;
  return replyMessages.some(msg => {
    const msgNorm = _normText(msg);
    if (!msgNorm) return false;
    if (msgNorm === playerNorm) return true;
    // 玩家话被几乎完整包含在回复里
    if (msgNorm.includes(playerNorm) && playerNorm.length >= 3) return true;
    return false;
  });
}

export async function generateReply(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; playerId?: string },
): Promise<LlmStructuredReply> {
  // 提取玩家最后一条消息用于复述检测
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const playerInput = lastUserMsg?.content ?? '';

  // 第一层防御：guided_json 从源头约束输出格式
  const result = await chat(messages, {
    temperature: opts?.temperature ?? 0.8,
    maxTokens: opts?.maxTokens ?? 1024,
    guidedJson: REPLY_SCHEMA,
    playerId: opts?.playerId,
  });

  const parsed = tryParseJsonReply(result.content);
  if (parsed && typeof parsed.messages !== 'undefined') {
    const reply = normalizeReply(parsed);
    // 复述检测：如果 NPC 回复逐字复述了玩家的话，带提示重试一次
    if (playerInput && _isEchoingPlayer(reply.messages, playerInput)) {
      const echoRetryMessages = [...messages, {
        role: 'user' as const,
        content: '（你刚才把我说的话原样重复了一遍。请不要复述我的话，用你自己的方式回应。）',
      }];
      const echoRetry = await chat(echoRetryMessages, {
        temperature: 0.95,
        maxTokens: opts?.maxTokens ?? 1024,
        guidedJson: REPLY_SCHEMA,
        playerId: opts?.playerId,
      });
      const echoParsed = tryParseJsonReply(echoRetry.content);
      if (echoParsed && typeof echoParsed.messages !== 'undefined') {
        const echoReply = normalizeReply(echoParsed);
        if (!_isEchoingPlayer(echoReply.messages, playerInput)) {
          return echoReply;
        }
      }
    }
    return reply;
  }

  // 第二层防御：重试一次，附带提示（不用guided_json，让模型自由修正）
  const retryMessages = [...messages, {
    role: 'assistant' as const,
    content: result.content,
  }, {
    role: 'user' as const,
    content: '请用JSON格式回复，包含messages数组、internal、internal_notable、player_description、scene_concluded字段。',
  }];
  const retryResult = await chat(retryMessages, {
    temperature: 0.5,
    maxTokens: opts?.maxTokens ?? 1024,
    guidedJson: REPLY_SCHEMA,
    playerId: opts?.playerId,
  });
  const retryParsed = tryParseJsonReply(retryResult.content);
  if (retryParsed && typeof retryParsed.messages !== 'undefined') {
    return normalizeReply(retryParsed);
  }

  // 第三层防御：从损坏的JSON中抢救消息文本
  const salvaged = salvageMessagesFromText(result.content || retryResult.content || '');
  if (salvaged) {
    return salvaged;
  }

  // 最终fallback：纯文本（已经过 cleanMessageText 清洗）
  const fallbackText = cleanMessageText(result.content || retryResult.content || '……');
  return {
    messages: [fallbackText || '……'],
    internal: '',
    internal_notable: false,
    player_description: '',
    scene_concluded: false,
    current_location: '',
  };
}

// ─── 格式化辅助 ─────────────────────────────────────────────

/**
 * 格式化角色卡为一个文本块 — 所有场景共用（普通约会、群聊、任务开场白）
 * 内容来自 character-card.txt 模板，保证字段完整、格式统一
 */
export function formatCharacterCard(char: CharacterData): string {
  const tpl = loadPrompt('character-card');
  return renderPrompt(tpl, {
    gender: char.gender === 'female' ? '女' : '男', // 旧数据缺失视为男性
    appearance: char.appearance?.trim() || '未设定',
    personality: formatPersonality(char),
    speech_style: formatSpeechStyle(char),
    texting_style: formatTextingStyle(char),
    emotional_signals: formatEmotionalSignals(char),
    background: formatBackground(char),
    preferences: formatPreferences(char),
    backstory_milestones: formatBackstoryMilestones(char),
    player_relation: char.player_relation || '无预设关系',
    skills: formatSkills(char),
  });
}

/**
 * 格式化角色性格三件套（任务开场白等轻量场景用）
 */
export function formatPersonalityOnly(char: CharacterData): string {
  return formatPersonality(char);
}

/** NPC 邀请任务 worldgen 注入的男主信息（姓名/性别/性格/擅长/过去经历） */
export interface NpcMissionProfile {
  name: string;
  gender: string;
  persona: string;
  skills: string;
  backstory: string;
}

export function formatNpcMissionProfile(char: CharacterData): NpcMissionProfile {
  const genderText = char.gender === 'female' ? '女' : char.gender === 'male' ? '男' : '未设定';
  return {
    name: char.name,
    gender: genderText,
    persona: formatPersonality(char),
    skills: formatSkills(char),
    backstory: [formatBackground(char), formatBackstoryMilestones(char)].join('\n'),
  };
}

function formatPersonality(char: CharacterData): string {
  return [
    `【表面】${char.personality.surface}`,
    `【内核】${char.personality.core}`,
    `【极端】${char.personality.extreme}`,
  ].join('\n');
}

function formatSpeechStyle(char: CharacterData): string {
  const examples = char.speechStyle.examples
    .map(e => `  [${e.context}] ${e.line}`)
    .join('\n');
  return `${char.speechStyle.description}\n示例：\n${examples}`;
}

function formatTextingStyle(char: CharacterData): string {
  const examples = char.textingStyle.examples
    .map(e => `  - ${e}`)
    .join('\n');
  return `${char.textingStyle.description}\n示例：\n${examples}`;
}

function formatEmotionalSignals(char: CharacterData): string {
  const s = char.emotional_signals;
  return [
    `紧张时：${s.nervous}`,
    `开心时：${s.happy}`,
    `生气时：${s.angry}`,
    `被触动时：${s.moved}`,
    `防御时：${s.defensive}`,
  ].join('\n');
}

function formatBackground(char: CharacterData): string {
  const b = char.background;
  const parts: string[] = [];
  if (char.age) parts.push(`年龄：${char.age}`);
  if (char.appearance) parts.push(`外貌：${char.appearance}`);
  parts.push(`出身：${b.origin}`, `经历：${b.shaping}`, `现状：${b.current}`);
  return parts.join('\n');
}

function formatSkills(char: CharacterData): string {
  const parts: string[] = [];
  if (char.skills) parts.push(`擅长：${char.skills}`);
  if (char.ineptitudes) parts.push(`不擅长：${char.ineptitudes}`);
  return parts.length > 0 ? parts.join('\n') : '无特殊记录';
}

/**
 * 格式化角色喜好/厌恶/目标/怪癖/底线
 * 这些是角色的个人偏好与行为边界，LLM需要知道才能正确回应关于角色爱好的问题
 */
function formatPreferences(char: CharacterData): string {
  const parts: string[] = [];
  if (char.likes && char.likes.length > 0) {
    parts.push(`喜欢：\n${char.likes.map(l => `  - ${l}`).join('\n')}`);
  }
  if (char.dislikes && char.dislikes.length > 0) {
    parts.push(`厌恶：\n${char.dislikes.map(d => `  - ${d}`).join('\n')}`);
  }
  if (char.goals) parts.push(`目标：${char.goals}`);
  if (char.quirks) parts.push(`小癖好：${char.quirks}`);
  if (char.boundaries) parts.push(`底线：${char.boundaries}`);
  return parts.length > 0 ? parts.join('\n') : '无特殊记录';
}

/**
 * 格式化故事里程碑 — 角色人生中的关键转折点
 * LLM需要知道这些才能在对话中自然引用角色的过去
 */
function formatBackstoryMilestones(char: CharacterData): string {
  const ms = char.backstory_milestones;
  if (!ms || ms.length === 0) return '无特殊记录';
  return ms.map(m =>
    `【${m.label}】（${m.time_description}）${m.summary}${m.dramatic_potential === 'high' ? ' ★关键转折' : ''}`
  ).join('\n');
}

function normalizeReply(raw: Record<string, unknown>): LlmStructuredReply {
  return {
    messages: Array.isArray(raw.messages) ? (raw.messages as string[]).map(s => cleanMessageText(String(s))) : [cleanMessageText(String(raw.messages ?? '……'))],
    internal: cleanMessageText(String(raw.internal ?? '')),
    internal_notable: Boolean(raw.internal_notable),
    player_description: String(raw.player_description ?? ''),
    scene_concluded: Boolean(raw.scene_concluded),
    current_location: raw.current_location ? String(raw.current_location).trim() : '',
    need_search: Boolean(raw.need_search),
    search_query: raw.search_query ? String(raw.search_query).trim() : '',
    image_prompt: raw.image_prompt ? String(raw.image_prompt).trim() : '',
  };
}

/** 清洗消息文本 — 去掉 LLM 可能残留的 markdown 代码块标记 + 修复双重转义的换行符 + 删除所有装饰性引号 */
function cleanMessageText(s: string): string {
  let t = s.trim();
  // 统一英文括号为中文括号——LLM 混用两种，后续处理只管中文一套
  t = t.replace(/\(/g, '（').replace(/\)/g, '）');
  // 去掉 ```json ... ``` 或 ``` ... ``` 包裹
  t = t.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  // 去掉行内残留的 ``` 标记
  t = t.replace(/```/g, '');
  // 修复 LLM 双重转义的换行符：JSON.parse 把 \\n 解析成字面量 \n（反斜杠+n），
  // 需要转回真实换行符，否则玩家看到裸文字 \n（CSS pre-wrap 只渲染真实换行）
  t = t.replace(/\\n/g, '\n');

  // 删除所有装饰性引号字符（""""「」『』''）
  // 气泡本身就是"说话"的容器，不需要引号包裹台词。
  // LLM 常输出混用引号把台词分段（如 唱歌……？" (动作) "虽然……），全删只留纯文本。
  t = t.replace(/[\u201c\u201d\u300c\u300d\u300e\u300f\u2018\u2019]/g, '');
  // 直引号也去掉（台词场景里直引号只用于包裹对话，无其他语义）
  t = t.replace(/"/g, '');

  // 去掉右括号后多余的逗号
  // LLM 常输出"（动作描写），台词"——括号已起分隔作用，逗号冗余
  t = t.replace(/）[ \t]*，/g, '）');

  // 修复不配对的中文括号：删除深度为0时多余的 ），末尾缺少的 ) 不补（避免误伤）
  t = fixUnbalancedParens(t);

  // 去掉头尾换行 + 压缩中间连续空行为最多一个
  t = t.replace(/^\n+/, '').replace(/\n+$/, '').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * 修复不配对的中文括号（）。
 * LLM 有时输出多余的 ）（深度为0时出现的右括号），删除它们。
 * 只处理中文括号，不碰英文括号（英文括号可能用于其他语义）。
 */
function fixUnbalancedParens(t: string): string {
  let depth = 0;
  let result = '';
  for (const ch of t) {
    if (ch === '\uff08' || ch === '(') { // （或(
      depth++;
      result += ch;
    } else if (ch === '\uff09' || ch === ')') { // ）或)
      if (depth > 0) {
        depth--;
        result += ch;
      }
      // depth===0 时跳过（多余的右括号）
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * 从损坏的JSON文本中抢救消息内容。
 * 当 tryParseJsonReply 三种策略全失败时调用。
 *
 * 策略：用正则提取 "messages" 字段后的字符串值，
 * 即使整体JSON有语法错误（未转义引号、尾逗号等）也能工作。
 */
function salvageMessagesFromText(raw: string): LlmStructuredReply | null {
  if (!raw) return null;

  // 尝试提取 messages 数组中的字符串
  // 匹配 "messages": ["...", "..."] 或 "messages":["..."]
  const msgPattern = /"messages"\s*:\s*\[([\s\S]*?)\]/;
  const msgMatch = raw.match(msgPattern);
  const messages: string[] = [];

  if (msgMatch?.[1]) {
    // 逐个提取引号内的字符串
    // 匹配 "..." 但处理转义引号 — 匹配到未被转义引号关闭为止
    const stringPattern = /"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = stringPattern.exec(msgMatch[1])) !== null) {
      if (!m[1]) continue;
      messages.push(cleanMessageText(m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')));
    }
  }

  // 如果没提取到 messages，尝试提取 "message" 单字段（creation路由格式）
  if (messages.length === 0) {
    const singleMsg = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (singleMsg?.[1]) {
      messages.push(cleanMessageText(singleMsg[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')));
    }
  }

  // 提取 internal
  let internal = '';
  const internalMatch = raw.match(/"internal"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (internalMatch?.[1]) {
    internal = internalMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }

  // 提取 player_description
  let playerDescription = '';
  const descMatch = raw.match(/"player_description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (descMatch?.[1]) {
    playerDescription = descMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }

  // 提取 internal_notable
  let internalNotable = false;
  const notableMatch = raw.match(/"internal_notable"\s*:\s*(true|false)/);
  if (notableMatch?.[1]) {
    internalNotable = notableMatch[1] === 'true';
  }

  // 提取 scene_concluded
  let sceneConcluded = false;
  const concludedMatch = raw.match(/"scene_concluded"\s*:\s*(true|false)/);
  if (concludedMatch?.[1]) {
    sceneConcluded = concludedMatch[1] === 'true';
  }

  // 提取 current_location
  let currentLocation = '';
  const locMatch = raw.match(/"current_location"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (locMatch?.[1]) {
    currentLocation = locMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
  }

  if (messages.length > 0) {
    return {
      messages,
      internal,
      internal_notable: internalNotable,
      player_description: playerDescription,
      scene_concluded: sceneConcluded,
      current_location: currentLocation,
    };
  }

  return null;
}

// ─── 群聊模式 ─────────────────────────────────────────────────

/** 群聊LLM结构化输出 */
export interface GroupLlmReply {
  messages: { speaker: string; text: string }[];
  internals: Record<string, string>;
  internals_notable: Record<string, boolean>;
  player_descriptions: Record<string, string>;
  scene_concluded: boolean;
}

/** 群聊 guided_json schema */
export const GROUP_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['speaker', 'text'],
      },
    },
    internals: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    internals_notable: {
      type: 'object',
      additionalProperties: { type: 'boolean' },
    },
    player_descriptions: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    scene_concluded: { type: 'boolean' },
  },
  required: ['messages', 'internals', 'player_descriptions', 'scene_concluded'],
};

/** 单角色信息打包 — 用于群聊prompt组装 */
export interface GroupCharContext {
  characterData: CharacterData;
  playerDescription: string;
  chronicleSummary: string;
  retrievedMemories: string | null;
  relationshipDuration: string;
}

/**
 * 构建群聊 system prompt — 两个角色卡注入同一模板
 */
export function buildGroupSystemPrompt(
  charA: GroupCharContext,
  charB: GroupCharContext,
  playerProfile: string,
  locationName: string,
  hubLocations: string,
  currentTime?: string,
): string {
  const tpl = loadPrompt('group.system');
  const a = charA.characterData;
  const b = charB.characterData;

  return renderPrompt(tpl, {
    char_a_name: a.name,
    char_a_card: formatCharacterCard(a),
    char_a_player_description: charA.playerDescription,
    char_a_chronicle: charA.chronicleSummary,
    char_a_memories: charA.retrievedMemories ?? '',
    char_a_relationship_duration: charA.relationshipDuration,
    char_b_name: b.name,
    char_b_card: formatCharacterCard(b),
    char_b_player_description: charB.playerDescription,
    char_b_chronicle: charB.chronicleSummary,
    char_b_memories: charB.retrievedMemories ?? '',
    char_b_relationship_duration: charB.relationshipDuration,
    player_profile: playerProfile,
    location: locationName,
    hub_locations: hubLocations,
    current_time: currentTime ?? formatCurrentTime(),
  });
}

/**
 * 构建群聊历史消息 — NPC消息前缀角色名，让LLM理解对话流
 */
export function buildGroupMessages(
  systemPrompt: string,
  recentMessages: { role: 'player' | 'assistant'; text: string; speakerName?: string }[],
  currentPlayerInput: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];
  for (const msg of recentMessages) {
    if (msg.role === 'player') {
      messages.push({ role: 'user', content: msg.text });
    } else {
      // NPC消息：前缀角色名
      const prefix = msg.speakerName ? `${msg.speakerName}：` : '';
      messages.push({ role: 'assistant', content: `${prefix}${msg.text}` });
    }
  }
  messages.push({ role: 'user', content: currentPlayerInput });
  return messages;
}

/**
 * 调用LLM生成群聊回复
 * parse失败重试一次，再失败则从裸文本中抢救
 */
export async function generateGroupReply(
  messages: ChatMessage[],
  charNames: string[],
  opts?: { temperature?: number; maxTokens?: number; playerId?: string },
): Promise<GroupLlmReply> {
  const result = await chat(messages, {
    temperature: opts?.temperature ?? 0.85,
    maxTokens: opts?.maxTokens ?? 1024,
    guidedJson: GROUP_REPLY_SCHEMA,
    playerId: opts?.playerId,
  });

  const parsed = tryParseJsonReply(result.content);
  if (parsed && Array.isArray(parsed.messages)) {
    const normalized = normalizeGroupReply(parsed, charNames);
    if (normalized) return normalized;
  }

  // 重试（speaker无法识别或格式错误）
  const retryMessages = [...messages, {
    role: 'assistant' as const,
    content: result.content,
  }, {
    role: 'user' as const,
    content: `请用JSON格式回复，messages数组中每条包含speaker和text字段。speaker只能是${charNames.map(n => `"${n}"`).join('或')}。`,
  }];
  const retryResult = await chat(retryMessages, {
    temperature: 0.5,
    maxTokens: opts?.maxTokens ?? 1024,
    guidedJson: GROUP_REPLY_SCHEMA,
    playerId: opts?.playerId,
  });
  const retryParsed = tryParseJsonReply(retryResult.content);
  if (retryParsed && Array.isArray(retryParsed.messages)) {
    const normalized = normalizeGroupReply(retryParsed, charNames);
    if (normalized) return normalized;
  }

  // Fallback：从裸文本抢救——把整段文本归给第一个角色
  const fallbackText = cleanMessageText(result.content || retryResult.content || '……');
  return {
    messages: [{ speaker: charNames[0] ?? '?', text: fallbackText || '……' }],
    internals: {},
    internals_notable: {},
    player_descriptions: {},
    scene_concluded: false,
  };
}

/** 规范化群聊LLM输出 — 清洗文本 + 校验speaker。返回null表示speaker无法识别，调用方应重试。 */
function normalizeGroupReply(raw: Record<string, unknown>, charNames: string[]): GroupLlmReply | null {
  const rawMsgs = Array.isArray(raw.messages) ? raw.messages as Array<Record<string, unknown>> : [];

  const messages = rawMsgs
    .map(m => ({
      speaker: String(m.speaker ?? '').trim(),
      text: cleanMessageText(String(m.text ?? '')),
    }))
    .filter(m => m.text.length > 0);

  if (messages.length === 0) return null;

  // 校验speaker：必须精确匹配某个角色名
  const nameSet = new Set(charNames);
  for (const msg of messages) {
    if (!nameSet.has(msg.speaker)) {
      // 无法识别speaker — 返回null让调用方重试
      return null;
    }
  }

  const internals: Record<string, string> = {};
  const internalsNotable: Record<string, boolean> = {};
  const playerDescriptions: Record<string, string> = {};

  const rawInternals = raw.internals as Record<string, unknown> | undefined;
  const rawNotables = raw.internals_notable as Record<string, unknown> | undefined;
  const rawDescs = raw.player_descriptions as Record<string, unknown> | undefined;

  for (const name of charNames) {
    internals[name] = rawInternals?.[name] ? cleanMessageText(String(rawInternals[name])) : '';
    internalsNotable[name] = rawNotables?.[name] != null ? Boolean(rawNotables[name]) : false;
    playerDescriptions[name] = rawDescs?.[name] ? String(rawDescs[name]) : '';
  }

  return {
    messages: messages.length > 0 ? messages : [{ speaker: charNames[0] ?? '?', text: '……' }],
    internals,
    internals_notable: internalsNotable,
    player_descriptions: playerDescriptions,
    scene_concluded: Boolean(raw.scene_concluded),
  };
}
