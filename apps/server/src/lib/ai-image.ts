/**
 * AI 生图模块 — 调独立容器的 Krea 2 Turbo 出图，最后存进 image_blobs。
 *
 * 流程：自然语言 prompt → gemma 扩写成英文 → 拼统一画风后缀
 *       → HTTP 调 Krea 2 容器 /generate → 图片字节 → 存 image_blobs → 返回文件名
 *
 * 头像模式（scene=false）：gemma 中文 appearance → 英文外观，按 gender 锚定称呼（男/女），
 *   画风后缀含 upper body portrait 半身像（保精致脸）。
 * 场景模式（scene=true）：gemma 中文场景 → 英文场景，传入可选角色外貌/性别；
 *   gemma 输出 {prompt, has_person, has_face} 自主判断画面是否出现人物/脸部，
 *   has_person=true 时按 gender 锚定称呼；has_face=true 时才追加脸质量词（不加半身像），
 *   避免只拍身体局部（腹肌/背肌/背影）时被脸词带偏、在腹部生成脸。
 *
 * Krea 2 是 flow-matching（guidance 0.0），没有负提示词分支——请求体不含 negative_prompt。
 */
import { config } from '../config';
import { db } from '../db';
import { chat, chatJson, type ChatMessage } from '../llm/adapter';
import { genId } from './util';

// ─── gemma 扩写 system prompt（两个分支）───────────────
// 头像：中文 appearance → 英文外观，只写外观不写动作/背景/构图。
const AVATAR_PROMPT_SYSTEM =
  '你是角色外观转写助手。把中文角色人设转写成一段英文外观描述，用于文生图模型。' +
  '规则：只写外观（性别、发色发型、瞳色眼型、脸型五官、皮肤、服装、气质），不写动作、不写背景、不写构图；' +
  '按给定性别锚定称呼开头（男 = male，女 = female），年龄与形象完全由外貌描述决定、不预设 handsome/young/beautiful 等形容词；未给性别时不写死性别、按人设自身判断；忠实还原人设，不自行添加设定；' +
  '人设信息不足时，只补全外观必需的通用描述（发色瞳色脸型服装气质），不要杜撰具体特征；' +
  '头发长度等视觉关键信息要具体（shoulder-length / chin-length / waist-length），不用含糊的 medium-length；' +
  '输出单段英文，逗号分隔，不加引号不加解释。';

// 配图：gemma 扮演摄影师，帮角色拍一张图。是否出人由「这张图是什么」自然决定，而非显式分类。
const SCENE_PROMPT_SYSTEM =
  '你是一位摄影师。一位角色想请你拍一张图，画面内容见下文的描述。' +
  '你还会收到这位角色的「角色外貌」和「角色性别」（可能为空）。' +
  '想象你要按下快门拍出这张图：' +
  '如果这是角色本人在画面里的图（自拍、合影、角色在场），就用「角色外貌」描述他，并按「角色性别」锚定称呼（不要用中性的 person）；' +
  '如果画面里是角色以外的其他人，忠实还原描述里对那个人的描写；' +
  '如果画面只是风景、物品、环境、动物或植物，就不要出现任何人，也不要把角色外貌写进画面。' +
  '忠实还原画面描述，不自行添加设定。' +
  '输出 JSON：{"prompt":"英文提示词，逗号分隔","has_person":true 或 false,"has_face":true 或 false}；' +
  'has_person 表示画面里是否出现了人物（含身体局部）；' +
  'has_face 表示画面里是否出现了脸部/面孔（只拍身体局部如腹肌、背肌、腿、手、背影时 has_person=true 但 has_face=false）。不要输出其它文字。';

// 场景转写 JSON 约束（guidedJson 输出 prompt + has_person）
const SCENE_EXPAND_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    has_person: { type: 'boolean' },
    has_face: { type: 'boolean' },
  },
  required: ['prompt', 'has_person', 'has_face'],
  additionalProperties: false,
};

// ─── 画风后缀（写死，保证全游戏画风统一）───────────────
// 头像：国乙半写实厚涂 CG（半身像 + 精致脸 + 冷色调）。
const AVATAR_STYLE_SUFFIX =
  'masterpiece, top-tier quality, upper body portrait, semi-realistic anime illustration, delicate soft lighting, ' +
  'elegant refined face, aegyo sal under eyes, glossy lips, smooth porcelain skin, soft shading, ' +
  'cold muted color palette, detailed expressive eyes, premium otome game card CG';

// 场景：同源半写实插画基础后缀（无人物词，只锁画风/光影/配色）。
const SCENE_STYLE_SUFFIX =
  'masterpiece, top-tier quality, semi-realistic anime illustration, delicate soft lighting, ' +
  'soft shading, cold muted color palette, premium otome game CG style';

// 场景出脸时的脸质量词（has_face=true 时追加；不含 upper body portrait，避免纯景物被框成半身像）。
const SCENE_FACE_QUALITY =
  'elegant refined face, detailed expressive eyes, aegyo sal under eyes, glossy lips, smooth porcelain skin';

interface SceneExpandResult {
  prompt: string;
  hasPerson: boolean;
  hasFace: boolean;
}

/**
 * 头像扩写：中文 appearance → 英文外观（单段自然语言）。
 * 失败（截断 / 空输出）重试一次，仍失败返回 null。
 */
async function gemmaExpandAvatar(prompt: string, gender?: string): Promise<string | null> {
  const genderText = gender === 'female' ? '女' : gender === 'male' ? '男' : '';
  const userContent = genderText ? `性别：${genderText}\n外貌：${prompt}` : prompt;
  const messages: ChatMessage[] = [
    { role: 'system', content: AVATAR_PROMPT_SYSTEM },
    { role: 'user', content: userContent },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat(messages, { temperature: 0.7, maxTokens: 512, callType: 'krea2-prompt-expand' });
    if (res.truncated) continue;
    const out = res.content.trim();
    if (!out) continue;
    return out;
  }
  return null;
}

/**
 * 场景扩写：中文场景 → 英文 prompt + 是否出人（hasPerson）+ 是否出脸（hasFace）。
 * 用 guidedJson 约束输出 {prompt, has_person}，chatJson 内部重试，失败返回 null。
 */
async function gemmaExpandScene(scene: string, appearance?: string, gender?: string): Promise<SceneExpandResult | null> {
  const genderText = gender === 'female' ? '女' : gender === 'male' ? '男' : '';
  const parts: string[] = [`画面内容：${scene}`];
  if (appearance?.trim()) parts.push(`角色外貌：${appearance.trim()}`);
  if (genderText) parts.push(`角色性别：${genderText}`);
  const userContent = parts.join('\n\n');
  return chatJson<SceneExpandResult>(
    [
      { role: 'system', content: SCENE_PROMPT_SYSTEM },
      { role: 'user', content: userContent },
    ],
    {
      schema: SCENE_EXPAND_SCHEMA,
      temperature: 0.7,
      maxTokens: 512,
      maxRetries: 1,
      callType: 'krea2-prompt-expand',
      normalize: (obj) => {
        const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
        if (!prompt) return null;
        return { prompt, hasPerson: obj.has_person === true, hasFace: obj.has_face === true };
      },
    },
  );
}

/** Krea 2 生图请求体（flow-matching 无负提示词）。 */
interface ImageGenBody {
  prompt: string;
  width: number;
  height: number;
  seed: number;
}

/** 调 Krea 2 生图容器出图，返回 PNG 字节。 */
async function callImage(body: ImageGenBody): Promise<Buffer | null> {
  const res = await fetch(`${config.ideogramUrl.replace(/\/+$/, '')}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.ideogramApiKey ? { 'X-API-Key': config.ideogramApiKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`生图服务返回 ${res.status}: ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 0 ? buf : null;
}

/** 存 image_blobs，返回文件名（与 upload 路由同格式，avatar/moments 引用无缝兼容）。 */
function storeImage(playerId: string, buffer: Buffer, mimetype: string): string {
  const ext = mimetype.split('/')[1] || 'png';
  const filename = `${playerId}_${Date.now()}_${genId()}.${ext}`;
  db.prepare(
    'INSERT INTO image_blobs (id, data, mimetype, size, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(filename, buffer, mimetype, buffer.length, Date.now());
  return filename;
}

export interface GenerateImageOptions {
  width?: number;
  height?: number;
  seed?: number;
  /** 场景配图模式（短信/朋友圈/背景图）。不设 = 头像模式（外观转写 + 半身像）。 */
  scene?: boolean;
  /** 角色外貌（scene 模式用，画面出现角色本人时锚定外貌）。 */
  appearance?: string;
  /** 性别 'male'|'female'（头像模式锚定称呼；scene 模式出人时锚定称呼，避免中性 person）。 */
  gender?: string;
}

export interface GenerateImageResult {
  ok: boolean;
  filename?: string;
  error?: string;
}

/**
 * 生成一张图并入库。playerId 用于文件名所有权前缀（共享图由 avatar 等引用豁免）。
 * prompt 为中文自然语言（头像=appearance，配图=场景描述），gemma 负责扩写成英文。
 */
// 生图尺寸校验：Krea 2 只接受 256–1536 的整数，非法/超范围回退默认，
// 防止恶意客户端传超大尺寸（如 16384）耗尽容器显存/算力。
function sanitizeImageDim(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return fallback;
  if (v < 256 || v > 1536) return fallback;
  return v;
}

export async function generateImage(
  playerId: string,
  naturalPrompt: string,
  opts: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  const width = sanitizeImageDim(opts.width, config.ideogramWidth);
  const height = sanitizeImageDim(opts.height, config.ideogramHeight);
  const seed = opts.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const scene = opts.scene ?? false;

  if (!config.ideogramUrl) {
    return { ok: false, error: '未配置生图服务地址（IDEOGRAM_URL）' };
  }

  try {
    let finalPrompt: string;
    if (scene) {
      // 场景配图：gemma 判断是否出人/出脸，按 has_face 决定是否追加脸质量词。
      // gemma 失败时用原始中文直接拼基础后缀（Krea 2 的 Qwen3-VL 编码器能理解中文）。
      const expanded = await gemmaExpandScene(naturalPrompt.trim(), opts.appearance, opts.gender);
      const faceWords = expanded?.hasFace ? `, ${SCENE_FACE_QUALITY}` : '';
      const promptPart = expanded?.prompt ?? naturalPrompt.trim();
      finalPrompt = `${promptPart}, ${SCENE_STYLE_SUFFIX}${faceWords}`;
    } else {
      // 头像：gemma 失败时用原始中文直接拼后缀（Krea 2 的 Qwen3-VL 编码器能理解中文）。
      const expanded = await gemmaExpandAvatar(naturalPrompt.trim(), opts.gender);
      finalPrompt = `${expanded ?? naturalPrompt.trim()}, ${AVATAR_STYLE_SUFFIX}`;
    }

    const body: ImageGenBody = { prompt: finalPrompt, width, height, seed };

    const buffer = await callImage(body);
    if (!buffer) return { ok: false, error: '生图服务返回空图片' };

    // 占位图/黑图检测已移除：生图服务（server.py）内部已有 std 换 seed 兜底，
    // 且 Krea 2 无 safety 拦截不会返回灰底占位图；后端这层阈值 15 会误杀暗色场景（星空 std≈10）。
    const filename = storeImage(playerId, buffer, 'image/png');
    return { ok: true, filename };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '生图失败' };
  }
}
