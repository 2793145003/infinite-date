/**
 * v4 API 客户端 —— 认证 + token 注入 + 401 处理
 * 认证方式：Bearer token（邀请码换 token，存 localStorage 'idate_token'）
 */

// ─── 角色数据（后端 CharacterData，本地定义避免引入 monorepo 依赖）────

import type { SceneNpc, SceneLocationEntry } from '../components/admin/types';
import { compressImage } from './image-compress';
import { uploadFileXhr, type UploadProgress } from './upload-client';

export type { UploadProgress, UploadResult } from './upload-client';

export interface Personality {
  surface: string;
  core: string;
  extreme: string;
}

export interface SpeechStyle {
  description: string;
  examples: { context: string; line: string }[];
}

export interface TextingStyle {
  description: string;
  examples: string[];
}

export interface Background {
  origin: string;
  shaping: string;
  current: string;
}

export interface EmotionalSignals {
  nervous: string;
  happy: string;
  angry: string;
  moved: string;
  defensive: string;
}

export interface BackstoryMilestone {
  label: string;
  time_description: string;
  summary: string;
  diff: Record<string, unknown>;
  dramatic_potential: 'high' | 'medium' | 'low';
}

export interface CharacterData {
  name: string;
  gender?: string;
  age: string;
  appearance: string;
  personality: Personality;
  speechStyle: SpeechStyle;
  textingStyle: TextingStyle;
  background: Background;
  emotional_signals: EmotionalSignals;
  likes: string[];
  dislikes: string[];
  boundaries: string;
  goals: string;
  quirks: string;
  backstory_milestones: BackstoryMilestone[];
  player_relation?: string;
  drive?: string;
  skills?: string;
  ineptitudes?: string;
  sleepType?: 'night_owl' | 'normal';
  avatar?: string;
}

const API_BASE = '/v4/api';

export function getToken(): string | null {
  try {
    return localStorage.getItem('idate_token');
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  localStorage.setItem('idate_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('idate_token');
}

/** 构建图片URL（头像/图片经 /v4/api/uploads 前缀访问后端静态资源） */
export function imageUrl(filename: string): string {
  if (!filename) return '';
  if (filename.startsWith('http') || filename.startsWith('data:') || filename.startsWith('/')) return filename;
  return `${API_BASE}/uploads/${filename}`;
}

// 全局 401 回调：token 失效时回到登录页
let onAuthFail: (() => void) | null = null;
export function setAuthFailHandler(fn: () => void): void {
  onAuthFail = fn;
}

/**
 * 全局 fetch 拦截：自动注入 Authorization header + 统一 401 处理。
 * 在应用启动时调用一次（main.tsx）。这样所有 fetch('/v4/api/...') 都自动带 token。
 */
export function installFetchAuth(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = getToken();
    const headers = new Headers(init?.headers);
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const res = await originalFetch(input, { ...init, headers });
    if (res.status === 401) {
      clearToken();
      onAuthFail?.();
    }
    return res;
  };
}

/**
 * 图片 401 自愈：<img> 标签不走 fetch 拦截器，token 失效时图片静默裂图、无任何自愈。
 * 全局捕获图片 error（capture 阶段——error 事件不冒泡），若图片来自 /uploads/，
 * 则节流探测一次 /auth/me：token 失效时 installFetchAuth 的 401 处理会自动
 * clearToken + onAuthFail（回登录页），与 fetch 请求的掉线行为对齐。
 */
let _lastImageProbeAt = 0;
let _imageProbing = false;
const IMAGE_PROBE_INTERVAL_MS = 30_000;

export function installImageAuthRecovery(): void {
  document.addEventListener(
    'error',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLImageElement)) return;
      const src = t.currentSrc || t.src || '';
      if (!src.includes('/uploads/')) return;
      _scheduleImageAuthProbe();
    },
    true, // capture：img 的 error 事件不冒泡，必须在捕获阶段监听
  );
}

function _scheduleImageAuthProbe(): void {
  const now = Date.now();
  if (_imageProbing || now - _lastImageProbeAt < IMAGE_PROBE_INTERVAL_MS) return;
  if (!getToken()) return; // 已登出：无需探测
  _imageProbing = true;
  _lastImageProbeAt = now;
  // 探测认证状态：若 401，installFetchAuth 拦截器统一 clearToken + onAuthFail（回登录页）
  fetch(`${API_BASE}/auth/me`)
    .catch(() => {})
    .finally(() => {
      _imageProbing = false;
    });
}

export async function request<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const hasBody = opts.body != null;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((opts.headers as Record<string, string>) || {}),
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  } catch {
    throw new Error('网络连接失败');
  }

  if (res.status === 401) {
    clearToken();
    onAuthFail?.();
    throw new Error('未认证');
  }

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

/** SSE 事件中的 error 类型——用自定义类区分坏帧 catch */
class SseError extends Error {}

/**
 * 流式请求（SSE）：边接收边回调每条 data 事件。
 * 用于 /scene-scenario/.../advance 这类每拍生成完即推的模式，避免 30s 超时 & 全量等待。
 * 返回 done 事件解析出的对象（若无则 null）。
 */
export async function requestStream<T = unknown>(
  path: string,
  opts: RequestInit & { body: string },
  onEvent: (evt: {
    type: string;
    beat?: { kind: string; speaker?: string; content: string; characterId?: string };
    content?: string;
    error?: string;
    round?: number;
    locationName?: string;
    locationId?: string | null;
    beats?: { kind: string; speaker?: string; intent: string; type?: string; to?: string; query?: string }[];
  }) => void,
): Promise<T | null> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // 120s 超时：防止服务端 hang 住时 reader.read() 永久挂起
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);
  // 如果调用方传了 signal，两者取先触发
  const externalSignal = opts.signal;
  if (externalSignal) {
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers, signal: controller.signal });
  if (res.status === 401) {
    clearTimeout(timeoutId);
    clearToken();
    onAuthFail?.();
    throw new Error('未认证');
  }
  if (!res.ok || !res.body) {
    clearTimeout(timeoutId);
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done: T | null = null;

  try {
    while (true) {
      const { value, done: isDone } = await reader.read();
      if (isDone) break;
      buf += decoder.decode(value, { stream: true });
      // 按 SSE 事件块切分（data 行以空行分隔）
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const evt = JSON.parse(dataLine.slice(6));
          if (evt && evt.type === 'done') done = evt as T;
          if (evt && evt.type === 'error') {
            // 后端 SSE 发来 error 事件 → 冒泡到外层 catch，让调用方处理 UI
            throw new SseError(evt.error || '服务器错误');
          }
          await onEvent(evt); // 逐条 await：保证 SSE 事件按到达顺序串行处理（气泡逐条上屏，而非并发挤成一团）
        } catch (e) {
          if (e instanceof SseError) throw e; // SSE error 事件：冒泡
          /* 忽略坏帧（JSON 解析失败等） */
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new Error('请求超时（120秒无响应）');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  return done;
}

export interface PlayerInfo {
  id: string;
  name: string;
  pronouns: string;
  gender: string;
  appearance: string;
  avatar?: string;
  home_bg?: string;
  tutorial_step: number;
  rating_score?: number;
  is_admin?: boolean;
}

// ─── 后端响应类型 ─────────────────────────────────────────

export interface MyCharacterSummary {
  characterId: string;
  name: string;
  hasFork: boolean;
  forkUpdatedAt: number | null;
  factCount: number;
  chronicleCount: number;
  isFriend: boolean;
  friendCreatedAt: number | null;
}

export interface FactItem {
  id: string;
  character_id: string;
  fact: string;
  round_no: number;
  source: string;
  created_at: number;
  updated_at: number;
  character_name: string;
}

export interface ApiMomentComment {
  id: string;
  authorType: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
}

export interface ApiMomentLike {
  id: string;
  authorType: string;
  authorId: string;
  authorName: string;
}

export interface ApiMoment {
  id: string;
  authorType: string;
  authorId: string;
  authorName: string;
  authorAvatar: string;
  content: string;
  imagePath: string | null;
  mood: string;
  locationName: string;
  triggerType: string;
  visibility?: string;
  createdAt: number;
  likes: ApiMomentLike[];
  comments: ApiMomentComment[];
}

export interface ApiEmail {
  id: string;
  sender_type: string;
  character_id: string | null;
  subject: string;
  body: string;
  is_read: number;
  created_at: number;
  sender_name: string;
}

// ─── 任务系统类型 ─────────────────────────────────────────

export interface DivineResult {
  guaXiang: string;   // 卦象名，如"地天泰"
  name: string;       // 卦名，如"泰"
  lines: number[];    // 六爻阴阳 [0阴1阳，初→上]
  dong: number[];     // 动爻位 [1-6]
  shichen: string;
  dayGanZhi: string;
}

export interface MissionInfo {
  id: string;
  questType: string;
  status: 'available' | 'active' | 'completed' | 'declined' | 'preparing' | 'failed';
  title: string;
  description: string;
  reward: number;
  worldName: string | null;
  missionGoal?: string;
  item?: string;
  obsession?: string;
  briefing: string;
  hexagram?: { ben?: string; bian?: string; hu?: string; dong?: number[]; lines?: number[] } | null;
  descendIdentity?: { player: string; maleLead: string } | null;
  landmarks: { name: string; feature: string }[];
  minorCharacters?: { name: string; trait: string }[];
  worldNpcs?: { role: string; name: string; persona: string }[];
  worldTension: string;
  targetState?: string;
  missionHook: string;
  twistSeed: string;
  characterId: string | null;
  sessionId?: string | null;
  evaluationResult: { goal_achieved: boolean; cooperation_quality: string; summary: string } | null;
  ratingScore: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// ─── 剧本系统类型 ─────────────────────────────────────────

export interface StatsConfigItem {
  name: string;
  initial: number;
  rules: string;
  target: number | null;
}

export interface ScenarioData {
  title: string;
  description: string;
  worldview: string;
  player_role: string;
  npc_role: string;
  npc_roles: string;
  opening_scene: string;
  greeting: string;
  greetings: string;
  goal: string;
  stats_config: string;
  status: string;
}

/** NPC 角色槽位（可带简短身份） */
export interface NpcRoleSlot {
  identity?: string;
  description: string;
}

export interface ScenarioInfo {
  id: string;
  authorId: string;
  title: string;
  description: string;
  worldview: string;
  playerRole: string;
  npcRole: string;
  npcRoles: NpcRoleSlot[];
  openingScene: string;
  greeting: string;
  greetings: string[];
  goal: string;
  statsConfig: StatsConfigItem[];
  status: string;
  playCount: number;
  createdAt: number;
  updatedAt: number;
}

// ─── 位面任务系统类型（Plane Mission）──────────────────────

export interface PlaneCharacter {
  id: string;
  name: string;
  gender: string;
  summary: string;   // 对外展示简介，不进聊天 prompt
  persona: string;   // 对内人设，进聊天 prompt；空则复制 summary
  greeting: string;  // 开场白，可空（空则引擎 roll）
  avatar: string;
  appearance: string; // 外貌描述，用于生成角色图/崽图（聊天背景）
  goal: string;      // 剧情目标；空 = 默认好感度型（好感满 100 完成）
  published: boolean;
  playCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlanePoolItem {
  id: string;
  name: string;
  gender: string;
  summary: string;
  greeting: string; // 开场白（已展开胶囊），可空
  avatar: string;
  playCount: number;
  goal: string;
  goalPreview: string;
  completed: boolean;
}

export interface PlaneSessionSummary {
  sessionId: string;
  planeCharacterId: string;
  characterName: string;
  avatar: string;
  goal: string;
  affection: number;
  round: number;
  ended: boolean;
  goalAchieved: boolean;
  updatedAt: number;
}

export interface PlaneSessionMessage {
  id: string;
  round_no: number;
  role: string;
  character_id: string | null;
  character_name: string;
  text: string;
  quote: string | null;
  internal: string;
  internal_notable: number;
}

export interface PlaneSessionDetail {
  sessionId: string;
  planeCharacterId: string;
  characterName: string;
  avatar: string;
  goal: string;
  statsState: Record<string, number>;
  round: number;
  ended: boolean;
  messages: PlaneSessionMessage[];
}

// ─── 生图可用性缓存 ─────────────────────────────────────
let _imageGenEnabled: boolean | null = null;

async function getImageGenEnabled(): Promise<boolean> {
  if (_imageGenEnabled !== null) return _imageGenEnabled;
  try {
    const r = await request<{ imageGenEnabled?: boolean }>('/health');
    _imageGenEnabled = r.imageGenEnabled ?? false;
  } catch {
    _imageGenEnabled = false;
  }
  return _imageGenEnabled;
}

// ─── API 方法 ────────────────────────────────────────────

export const api = {
  // 认证 / 玩家
  login: (code: string) =>
    request<{ token: string; player: PlayerInfo }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  me: () => request<{ player: PlayerInfo; permissions: number }>('/auth/me'),
  getPlayer: () => request<{ player: PlayerInfo; permissions: number }>('/player'),
  updatePlayer: (data: { name?: string; pronouns?: string; gender?: string; appearance?: string; avatar?: string; home_bg?: string }) =>
    request('/player', { method: 'PATCH', body: JSON.stringify(data) }),

  // 设置（LLM 配置）
  getSettings: () =>
    request<{ baseUrl: string; model: string; apiKeySet: boolean }>('/settings'),
  updateSettings: (data: { baseUrl?: string; apiKey?: string; model?: string }) =>
    request<{ ok: boolean; apiKeySet: boolean }>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteAccount: () =>
    request<{ ok: boolean; token?: string }>('/player', { method: 'DELETE' }),

  // 角色
  listMyCharacters: () => request<{ characters: MyCharacterSummary[] }>('/me/characters'),
  getCharacterEdit: (characterId: string) =>
    request<{ characterData: CharacterData; characterDataExpanded: CharacterData; hasFork: boolean; isPublic: boolean; publicData: CharacterData | null }>(
      `/characters/${characterId}/edit`
    ),
  forkCharacter: (characterId: string, characterData: CharacterData) =>
    request(`/characters/${characterId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ characterData }),
    }),

  // 角色创建（聊天式：AI 引导对话生成角色卡）
  startCreation: () =>
    request<{ sessionId: string; message: string; draft: Record<string, unknown> }>('/creation/start', { method: 'POST' }),
  creationChat: (sessionId: string, text: string) =>
    request<{ message: string; draft: Record<string, unknown>; ready: boolean }>(`/creation/${sessionId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  finalizeCreation: (sessionId: string, isPublic = true, draftOverride?: Record<string, unknown>) =>
    request<{ characterId: string; characterName: string }>(`/creation/${sessionId}/finalize`, {
      method: 'POST',
      body: JSON.stringify({ isPublic, draftOverride }),
    }),
  cancelCreation: (sessionId: string) =>
    request<{ ok: boolean }>(`/creation/${sessionId}/cancel`, { method: 'POST' }),
  importCharacter: (json: string, isPublic = true) =>
    request<{ characterId: string; characterName: string }>(`/creation/import`, {
      method: 'POST',
      body: JSON.stringify({ json, isPublic }),
    }),
  /**
   * 头像上传（multipart）。用 XHR 而不是 fetch：
   *  - 只有 XHR 的 upload.onprogress 能驱动进度条
   *  - 老实现用裸 fetch，没有超时：弱网下请求会永久挂着，UI 永远停在「上传中」、按钮点不动
   * opts.compress=true 时先在本机 canvas 缩放/重编码（实测 2.4MB 原图 → 143KB，约 90ms），
   * 手机原图不必再在弱网上传几十秒。压缩失败一律回退原文件，不阻断上传。
   */
  uploadImage: (
    file: File,
    opts: { compress?: boolean; onProgress?: (p: UploadProgress) => void } = {},
  ) => {
    const token = getToken();
    const upload = (f: File) =>
      uploadFileXhr(f, {
        apiBase: API_BASE,
        token,
        timeoutMs: 90_000,
        onProgress: opts.onProgress,
        onUnauthorized: () => {
          clearToken();
          onAuthFail?.();
        },
      });

    if (!opts.compress) return upload(file);
    opts.onProgress?.({ phase: 'compress', pct: 0 });
    return compressImage(file).then((r) => upload(r.file));
  },

  // AI 生成图片（调 /ai-image/generate，prompt 传中文描述，返回 imagePath）
  // 头像：不传 opts（默认头像模式）；场景配图：传 { scene: true, appearance? }
  generateImage: (prompt: string, opts: { scene?: boolean; portrait?: boolean; appearance?: string; gender?: string; width?: number; height?: number } = {}) =>
    request<{ imagePath: string }>('/ai-image/generate', {
      method: 'POST',
      body: JSON.stringify({ prompt, width: opts.width ?? 1024, height: opts.height ?? 1024, scene: opts.scene, portrait: opts.portrait, appearance: opts.appearance, gender: opts.gender }),
    }),

  // 生图服务是否可用（health 接口返回，模块级缓存）
  getImageGenEnabled: () => getImageGenEnabled(),

  // 事实记忆（日记页 → 角色记忆）
  listFacts: () => request<{ facts: FactItem[] }>('/facts'),
  addFact: (fact: string, characterId?: string) =>
    request('/facts', { method: 'POST', body: JSON.stringify({ fact, characterId }) }),
  updateFact: (id: string, fact: string) =>
    request(`/facts/${id}`, { method: 'PATCH', body: JSON.stringify({ fact }) }),
  deleteFact: (id: string) => request(`/facts/${id}`, { method: 'DELETE' }),

  // 朋友圈
  listMoments: () => request<{ moments: ApiMoment[]; serverTime: number }>('/moments'),
  createMoment: (content: string, imagePath?: string, visibility?: string, visibleTo?: string[], location?: string) =>
    request('/moments', { method: 'POST', body: JSON.stringify({ content, imagePath, visibility, visibleTo, location }) }),
  // 评论：可传 signal。评论接口是快接口，调用方用超时兜底，避免响应丢失时前端一直挂着
  // （注意：request() 其它调用包含 LLM 长请求，不能加全局超时）
  commentMoment: (momentId: string, text: string, signal?: AbortSignal) =>
    request(`/moments/${momentId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      ...(signal ? { signal } : {}),
    }),
  likeMoment: (momentId: string) => request(`/moments/${momentId}/like`, { method: 'POST' }),
  deleteMoment: (momentId: string) => request(`/moments/${momentId}`, { method: 'DELETE' }),
  unreadMoments: (since = 0) => request<{ count: number }>(`/moments/unread-count?since=${since}`),

  // ─── 我的空间（好友/记忆/重置 fork 管理）──────────────────────
  resetCharacterFork: (characterId: string) =>
    request<{ ok: boolean }>(`/me/characters/${characterId}/fork`, { method: 'DELETE' }),
  clearCharacterMemory: (characterId: string) =>
    request<{ ok: boolean }>(`/me/memory/${characterId}`, { method: 'DELETE' }),
  clearAllMemory: () =>
    request<{ ok: boolean }>('/me/memory', { method: 'DELETE' }),
  deleteFriend: (characterId: string) =>
    request<{ ok: boolean }>(`/me/friend/${characterId}`, { method: 'DELETE' }),

  // 信箱
  listEmails: () => request<{ emails: ApiEmail[] }>('/emails'),
  readEmail: (emailId: string) => request(`/emails/${emailId}/read`, { method: 'POST' }),
  unreadEmails: () => request<{ count: number }>('/emails/unread-count'),

  // ─── 任务系统 ──────────────────────────────────────────
  divine: (cast: number[]) =>
    request<DivineResult>('/missions/divine', {
      method: 'POST',
      body: JSON.stringify({ cast }),
    }),
  generateMission: (cast?: number[]) =>
    request<{ missionId: string; world: { id: string; name: string; summary: string; tone: string; briefing: string; worldTension: string; targetState: string; hexagram: string } }>('/missions/generate', {
      method: 'POST',
      body: cast ? JSON.stringify({ cast }) : undefined,
    }),
  prepareMission: (cast: number[]) =>
    request<{ preparing: boolean; missionId: string; guaXiang: string; name: string; lines: number[]; dong: number[] }>('/missions/prepare', {
      method: 'POST',
      body: JSON.stringify({ cast }),
    }),
  // 场景约会：角色主动邀约玩家赴会（短信「前往」按钮触发，circumstance='npc_invite'）
  sceneStart: (data: { locationId: string; characterIds: string[]; circumstance?: string }) =>
    request<{ sessionId: string; location: string; characters: string[]; round: number }>('/scene/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getMissions: () => request<{ missions: MissionInfo[] }>('/missions'),
  acceptMission: (missionId: string, companionId: string) =>
    request<{ sessionId: string; greeting: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null }>(`/missions/${missionId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ companionId }),
    }),
  declineMission: (missionId: string) =>
    request<{ ok: boolean }>(`/missions/${missionId}/decline`, { method: 'POST' }),
  endMission: (sessionId: string) =>
    request<{ ok: boolean; missionId?: string }>('/missions/end', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
  getMissionFriends: () =>
    request<{ friends: { characterId: string; name: string }[] }>('/missions/friends'),

  // 进行中的会话（主页待办/任务现场）
  getActiveSession: () =>
    request<{ session: { id: string; characterId: string; characterName: string; locationId: string | null; locationName: string; isGroup?: boolean; participants?: { characterId: string; name: string }[]; createdAt: number } | null }>('/sessions/active'),

  // 进行中的场景约会（地图约会现场，主页待办用）
  getActiveScene: () =>
    request<{ session: { id: string; characterId: string; characterName: string; locationId: string | null; locationName: string; isGroup?: boolean; participants?: { characterId: string; name: string }[]; createdAt: number } | null }>('/scene/active'),

  // NPC 当前行程（空闲时显示「在哪做什么」；非好友 403 → catch 后回退「空闲」）
  getNpcSchedule: (characterId: string) =>
    request<{ current: { locationId: string; locationName: string; activity: string } | null }>(`/npcs/${characterId}/schedule`),

  // 首页每日寄语（每天每角色一句；生成失败返回 poem=null，前端兜底默认句）
  getHomePoem: (characterId: string) =>
    request<{ poem: string | null; generatedAt: number | null }>(`/home-poem?characterId=${encodeURIComponent(characterId)}`),

  // 短信联系人线程（按最后消息时间降序，用于判断「最后一个联系的人」）
  getSmsThreads: () =>
    request<{ threads: { character_id: string; character_name: string; last_message_at: number | null }[] }>('/sms/threads'),

  // 短信未读总数（首页/导航角标）
  unreadSms: () => request<{ count: number }>('/sms/unread-count'),

  // 某线程最近若干轮心绪（旧接口，保留兼容）
  getThreadEmotions: (threadId: string, limit = 5) =>
    request<EmotionPanelData>(`/sms/threads/${threadId}/emotions?limit=${limit}`),

  // 角色此刻的心绪 + 跨渠道（短信/约会合并）的情绪史 —— 点头像弹窗统一走这个
  getCharacterEmotions: (characterId: string, limit = 5) =>
    request<EmotionPanelData>(`/characters/${characterId}/emotions?limit=${limit}`),

  // ─── 剧本系统（场景剧本 scene-scenario）────────────────
  createScenario: (data: { title: string; description: string }) =>
    request<{ scenarioId: string }>('/scene-scenario', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getScenarios: (params: { mine?: boolean }) =>
    request<{ scenarios: ScenarioInfo[] }>(`/scene-scenario${params.mine ? '?mine=1' : ''}`),
  getScenario: (scenarioId: string) =>
    request<{ scenario: ScenarioInfo }>(`/scene-scenario/detail/${scenarioId}`),
  updateScenario: (scenarioId: string, data: Partial<ScenarioData>) =>
    request<{ scenario: ScenarioInfo }>(`/scene-scenario/detail/${scenarioId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  rollScenarioField: (scenarioId: string, field: string) =>
    request<{ field: string; value: string }>(`/scene-scenario/detail/${scenarioId}/roll`, {
      method: 'POST',
      body: JSON.stringify({ field }),
    }),
  rollScenarioStats: (scenarioId: string) =>
    request<{ stats: StatsConfigItem[] }>(`/scene-scenario/detail/${scenarioId}/roll-stats`, {
      method: 'POST',
    }),
  rollScenarioNpcRoles: (scenarioId: string) =>
    request<{ npcRoles: NpcRoleSlot[] }>(`/scene-scenario/detail/${scenarioId}/roll-roles`, {
      method: 'POST',
    }),
  deleteScenario: (scenarioId: string) =>
    request<{ ok: boolean }>(`/scene-scenario/detail/${scenarioId}`, { method: 'DELETE' }),

  sceneScenarioEnter: (scenarioId: string, characterId: string, characterIds?: string[]) =>
    request<{
      sessionId: string;
      scenarioId: string;
      title: string;
      characters: string[];
      statsState: Record<string, number>;
      statsConfig: Array<{ name: string; initial: number; rules: string; target?: number | null }>;
      worldview: string;
      playerRole: string;
      goal: string;
      ambientConfig: string;
      openingScene: string;
      round: number;
    }>(`/scene-scenario/${scenarioId}/enter`, {
      method: 'POST',
      body: JSON.stringify({ characterId, characterIds }),
    }),

  sceneScenarioAdvanceStream: (
    sessionId: string,
    message: string | undefined,
    onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => void,
  ) =>
    requestStream<{
      sessionId: string;
      round: number;
      stats: Record<string, number>;
      statsChanges: Array<{ name: string; before: number; after: number }>;
      statsChangeReasons: Array<{ name: string; reason: string }>;
      ambient: string[];
      goalAchieved: boolean;
      goalReason: string;
      locationName: string;
    }>(
      `/scene-scenario/${sessionId}/advance`,
      { method: 'POST', body: JSON.stringify({ message }) },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat);
      },
    ),

  sceneScenarioContinueStream: (
    sessionId: string,
    onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => void,
  ) =>
    requestStream<{
      sessionId: string;
      round: number;
      stats: Record<string, number>;
      statsChanges: Array<{ name: string; before: number; after: number }>;
      ambient: string[];
      goalAchieved: boolean;
      goalReason: string;
      locationName: string;
    }>(
      `/scene-scenario/${sessionId}/continue`,
      { method: 'POST', body: '{}' },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat);
      },
    ),

  sceneScenarioRetryStream: (
    sessionId: string,
    onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => void,
  ) =>
    requestStream<{
      sessionId: string;
      round: number;
      stats: Record<string, number>;
      statsChanges: Array<{ name: string; before: number; after: number }>;
      statsChangeReasons: Array<{ name: string; reason: string }>;
      ambient: string[];
      goalAchieved: boolean;
      goalReason: string;
      locationName: string;
    }>(
      `/scene-scenario/${sessionId}/retry`,
      { method: 'POST', body: '{}' },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat);
      },
    ),

  sceneScenarioUndo: (sessionId: string) =>
    request<{ ok: boolean; round: number; stats: Record<string, number> }>(`/scene-scenario/${sessionId}/undo`, {
      method: 'POST',
      body: '{}',
    }),

  sceneScenarioEnd: (sessionId: string, dreamText?: string) =>
    request<{ ok: boolean; ended: boolean }>(`/scene-scenario/${sessionId}/end`, {
      method: 'POST',
      body: JSON.stringify({ dreamText }),
    }),

  sceneScenarioGet: (sessionId: string) =>
    request<{
      sessionId: string;
      scenarioId: string;
      sceneType: string;
      round: number;
      ended: boolean;
      participants: { characterId: string; name: string; avatar: string; isFriend: boolean }[];
      messages: { id: string; round_no: number; role: string; character_id: string | null; character_name: string; text: string; quote: string | null; internal: string | null; internal_notable?: number | boolean | null; created_at: number }[];
      statsConfig: Array<{ name: string; initial: number; rules: string; target?: number | null }>;
      statsState: Record<string, number>;
      goalAchieved: boolean;
      dreamText: string | null;
      dreamCustom: boolean;
      worldview: string;
      playerRole: string;
      companionRole: string;
      goal: string;
      ambientConfig: string;
      openingScene: string;
      missionTitle: string;
      missionInfo: {
        briefing?: string;
        worldTension?: string;
        targetState?: string;
        missionGoal?: string;
        worldName?: string;
        landmarks?: { name: string; feature: string }[];
        coreNpcs?: { role: string; name: string; persona: string }[];
      } | null;
    }>(`/scene-scenario/${sessionId}`),

  getActiveSceneScenario: () =>
    request<{
      active: boolean;
      sessionId?: string;
      scenarioId?: string;
      title?: string;
      round?: number;
      goalAchieved?: boolean;
      characters?: string[];
    }>('/scene-scenario/active'),

  // ─── 互动小说（共写引擎）────────────────────────────
  importNovel: (text: string) =>
    request<{ novelId: string }>('/novel/import', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  createNovel: (data: { title: string; summary?: string }) =>
    request<{ novelId: string }>('/novel', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getNovels: (params: { mine?: boolean }) =>
    request<{ novels: NovelInfo[] }>(`/novel${params.mine ? '?mine=1' : ''}`),
  getNovel: (novelId: string) =>
    request<{ novel: NovelInfo; characters: NovelCharacter[] }>(`/novel/detail/${novelId}`),
  updateNovel: (novelId: string, data: Record<string, unknown>) =>
    request<{ novel: NovelInfo }>(`/novel/detail/${novelId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteNovel: (novelId: string) =>
    request<{ ok: boolean }>(`/novel/detail/${novelId}`, { method: 'DELETE' }),
  rollNovelField: (novelId: string, field: string) =>
    request<{ field: string; value: string }>(`/novel/detail/${novelId}/roll`, {
      method: 'POST',
      body: JSON.stringify({ field }),
    }),
  rollNovelCharacters: (novelId: string, count?: number, direction?: string) =>
    request<{ characters: NovelCharacter[] }>(`/novel/detail/${novelId}/roll-characters`, {
      method: 'POST',
      body: JSON.stringify({ count, direction }),
    }),
  rollNovelOpening: (novelId: string) =>
    request<{ opening: string }>(`/novel/detail/${novelId}/roll-opening`, { method: 'POST' }),
  addNovelCharacter: (novelId: string, data: { name: string; gender?: string; persona?: string; emotional_anchor?: string; appearance?: string; avatar?: string }) =>
    request<{ character: NovelCharacter }>(`/novel/detail/${novelId}/character`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateNovelCharacter: (novelId: string, charId: string, data: { name?: string; gender?: string; persona?: string; emotional_anchor?: string; appearance?: string; avatar?: string }) =>
    request<{ character: NovelCharacter }>(`/novel/detail/${novelId}/character/${charId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteNovelCharacter: (novelId: string, charId: string) =>
    request<{ ok: boolean }>(`/novel/detail/${novelId}/character/${charId}`, { method: 'DELETE' }),
  novelEnter: (novelId: string) =>
    request<{ sessionId: string; reused?: boolean }>(`/novel/${novelId}/enter`, { method: 'POST' }),
  getActiveNovel: () =>
    request<{ active: boolean; sessionId?: string; novelId?: string; title?: string }>('/novel/active'),
  getNovelSession: (sessionId: string) =>
    request<NovelSessionData>(`/novel/session/${sessionId}`),
  updateNovelExcluded: (sessionId: string, excludedCharIds: string[]) =>
    request<{ excludedCharIds: string[] }>(`/novel/session/${sessionId}/excluded`, {
      method: 'PATCH',
      body: JSON.stringify({ excludedCharIds }),
    }),
  polishNovel: (sessionId: string, text: string) =>
    request<{ polished: string }>(`/novel/session/${sessionId}/polish`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  continueNovel: (sessionId: string, text: string, onDelta?: (delta: string) => void) =>
    requestStream<{ text: string }>(
      `/novel/session/${sessionId}/continue`,
      { method: 'POST', body: JSON.stringify({ text }) },
      (evt) => {
        if (evt.type === 'delta' && evt.content) onDelta?.(evt.content);
      },
    ),
  endNovel: (sessionId: string, text?: string) =>
    request<{ ok: boolean; ended: boolean }>(`/novel/session/${sessionId}/end`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  retractNovel: (sessionId: string) =>
    request<{ removed: boolean; remaining: number }>(`/novel/session/${sessionId}/retract`, {
      method: 'POST',
    }),

  // ─── 回忆归档（日记页）──────────────────────────────
  getArchiveDates: (q?: string) =>
    request<{ dates: ArchiveDateItem[] }>(`/archive/dates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getArchiveDate: (sessionId: string) =>
    request<{ session: ArchiveDateDetail; messages: ArchiveMessage[] }>(`/archive/dates/${sessionId}`),
  getArchiveSceneDates: (q?: string) =>
    request<{ dates: ArchiveSceneDateItem[] }>(`/archive/scene-dates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getArchiveSceneDate: (sessionId: string) =>
    request<{ session: ArchiveSceneDateDetail; messages: ArchiveSceneMessage[] }>(`/archive/scene-dates/${sessionId}`),
  getArchiveSms: (q?: string) =>
    request<{ threads: ArchiveSmsItem[] }>(`/archive/sms${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getArchiveSmsDetail: (threadId: string) =>
    request<{ thread: ArchiveSmsDetail; messages: ArchiveTextMessage[] }>(`/archive/sms/${threadId}`),
  getArchiveScenarios: (q?: string) =>
    request<{ sessions: ArchiveScenarioItem[] }>(`/archive/scenarios${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getArchiveScenario: (scenarioSessionId: string) =>
    request<{ session: ArchiveScenarioDetail; messages: ArchiveMessage[] }>(`/archive/scenarios/${scenarioSessionId}`),
  getArchiveSceneScenarios: (q?: string) =>
    request<{ sessions: ArchiveSceneScenarioItem[] }>(`/archive/scene-scenarios${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getArchiveSceneScenario: (sessionId: string) =>
    request<{ session: ArchiveSceneScenarioDetail; messages: ArchiveSceneMessage[] }>(`/archive/scene-scenarios/${sessionId}`),
  exportArchive: (type: 'date' | 'sms' | 'scenario' | 'scene' | 'scene-scenario', ids?: string[]) =>
    request<{ markdown: string }>('/archive/export', {
      method: 'POST',
      body: JSON.stringify({ type, ids: ids ?? [] }),
    }),

  // ─── 管理员 — 公共NPC管理 ───────────────────────────────
  adminListCharacters: () =>
    request<{ characters: { id: string; name: string; avatar: string; creator: string | null; createdAt: number; updatedAt: number; characterData: string }[] }>('/admin/characters'),

  adminUpdateCharacter: (id: string, characterData: string) =>
    request<{ ok: boolean }>(`/admin/characters/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ characterData }),
    }),

  adminDeleteCharacter: (id: string) =>
    request<{ ok: boolean }>(`/admin/characters/${id}`, { method: 'DELETE' }),

  adminListOverrides: (id: string) =>
    request<{ overrides: { id: string; playerId: string; playerName: string; characterData: string; updatedAt: number }[] }>(`/admin/characters/${id}/overrides`),

  adminRegenerateMilestones: (id: string) =>
    request<{ milestones: { label: string; time_description: string; summary: string; diff: Record<string, unknown>; dramatic_potential: string }[] }>(`/admin/characters/${id}/regenerate-milestones`, {
      method: 'POST',
    }),

  // 管理员 — 权限发放
  adminGrantPermission: (playerId: string, amount: number, reason?: string) =>
    request<{ ok: boolean; playerId: string; balanceAfter: number }>('/admin/grant-permission', {
      method: 'POST',
      body: JSON.stringify({ playerId, amount, reason }),
    }),

  adminGetPermissions: (playerId: string) =>
    request<{ playerId: string; balance: number; transactions: { id: string; delta: number; reason: string; balance_after: number; created_at: number }[] }>(`/admin/permissions/${playerId}`),

  // 管理员 — 邀请码管理
  adminListInviteCodes: () =>
    request<{ codes: { code: string; playerId: string; playerName: string; isAdmin: boolean; permissionBalance: number; createdAt: number; revokedAt: number | null; active: boolean; lastLoginAt: number | null }[] }>('/admin/invite-codes'),

  adminCreateInviteCode: (permissionAmount?: number) =>
    request<{ ok: boolean; code: string; playerId: string; permissionBalance: number }>('/admin/invite-codes', {
      method: 'POST',
      body: JSON.stringify({ permissionAmount }),
    }),

  adminRevokeInviteCode: (code: string) =>
    request<{ ok: boolean }>(`/admin/invite-codes/${code}/revoke`, { method: 'POST' }),

  adminDeleteInviteCode: (code: string) =>
    request<{ ok: boolean }>(`/admin/invite-codes/${code}`, { method: 'DELETE' }),

  // 管理员 — 地点管理（新地图 scene_locations）
  adminListLocations: () =>
    request<{ locations: SceneLocationEntry[] }>('/admin/scene-map/locations'),

  adminCreateLocation: (data: { name: string; summary?: string; isPublic?: boolean; parentId?: string | null }) =>
    request<{ ok: boolean; id: string }>('/admin/scene-map/locations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  adminMoveLocation: (locationId: string, parentId: string | null) =>
    request<{ ok: boolean }>(`/admin/scene-map/locations/${locationId}/parent`, {
      method: 'PUT',
      body: JSON.stringify({ parentId }),
    }),

  adminUpdateLocation: (locationId: string, data: { name?: string; summary?: string }) =>
    request<{ ok: boolean }>(`/admin/scene-map/locations/${locationId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  adminDeleteLocation: (locationId: string) =>
    request<{ ok: boolean }>(`/admin/scene-map/locations/${locationId}`, { method: 'DELETE' }),

  adminSetHome: (locationId: string, characterId: string | null) =>
    request<{ ok: boolean }>(`/admin/scene-map/locations/${locationId}/home`, {
      method: 'PUT',
      body: JSON.stringify({ characterId }),
    }),

  adminRemoveHome: (locationId: string, characterId: string) =>
    request<{ ok: boolean }>(`/admin/scene-map/locations/${locationId}/home/${characterId}`, { method: 'DELETE' }),

  adminRemoveNpcFromLocation: (locationId: string, npcId: string) =>
    request<{ ok: boolean; npcs: SceneNpc[] }>(`/admin/scene-map/locations/${locationId}/npc/${npcId}`, { method: 'DELETE' }),

  adminUpdateNpcOnLocation: (locationId: string, npcId: string, data: { role: string; name: string; persona?: string }) =>
    request<{ ok: boolean; npcs: SceneNpc[] }>(`/admin/scene-map/locations/${locationId}/npc/${npcId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  adminSetSceneBackground: (locationId: string, background: string) =>
    request<{ ok: boolean; background: string }>(`/admin/scene-locations/${locationId}/background`, {
      method: 'PUT',
      body: JSON.stringify({ background }),
    }),

  adminSetSceneActivities: (locationId: string, activities: string[]) =>
    request<{ ok: boolean; activities: string[] }>(`/admin/scene-locations/${locationId}/activities`, {
      method: 'PUT',
      body: JSON.stringify({ activities }),
    }),

  adminGenerateSceneActivities: (locationId: string) =>
    request<{ ok: boolean; activities: string[] }>(`/admin/scene-locations/${locationId}/generate-activities`, {
      method: 'POST',
    }),

  // 场景地点 — 玩家创建子地点（写 scene_locations；显式 isPublic 否则继承父级）
  sceneCreateLocation: (data: { name: string; summary?: string; parentId?: string | null; isPublic?: boolean }) =>
    request<{ location: { id: string; name: string } }>(`/scene/locations`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // 场景地点 — 常驻路人（玩家接口，LocationPanel 复用）
  sceneAddNpc: (locationId: string, data: { role: string; name: string; persona?: string }) =>
    request<{ npcs: SceneNpc[] }>(`/scene/locations/${locationId}/npcs`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // 场景地点 — 玩家上传/生成地点背景（私有地点直写，公共地点进提交池）
  setLocationBackground: (locationId: string, background: string) =>
    request<{ ok: boolean; mode: string; background: string }>(`/scene/locations/${locationId}/background`, {
      method: 'POST',
      body: JSON.stringify({ background }),
    }),

  // ─── 位面任务（Plane Mission）──────────────────────────
  rollPlaneGreetings: (data: { name?: string; gender?: string; summary?: string; persona?: string }) =>
    request<{ greetings: string[] }>('/plane/greetings/roll', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  fillPlaneFromText: (text: string) =>
    request<{ name: string; gender: string; appearance: string; summary: string; persona: string; goal: string; greeting: string }>('/plane/fill', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  polishPlaneField: (data: { field: string; text: string; name?: string; gender?: string }) =>
    request<{ polished: string }>('/plane/polish', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  generatePlaneAppearance: (data: { name?: string; gender?: string; summary?: string; persona?: string }) =>
    request<{ appearance: string }>('/plane/appearance', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createPlaneCharacter: (data: { name: string; gender?: string; summary?: string; persona?: string; greeting?: string; avatar?: string; appearance?: string; goal?: string }) =>
    request<{ character: PlaneCharacter }>('/plane/characters', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  listPlaneCharacters: (published?: boolean) =>
    request<{ characters: PlaneCharacter[] }>(`/plane/characters${published ? '?published=1' : ''}`),
  updatePlaneCharacter: (id: string, data: Partial<{ name: string; gender: string; summary: string; persona: string; greeting: string; avatar: string; appearance: string; goal: string }>) =>
    request<{ character: PlaneCharacter }>(`/plane/characters/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deletePlaneCharacter: (id: string) =>
    request<{ ok: boolean }>(`/plane/characters/${id}`, { method: 'DELETE' }),
  publishPlaneCharacter: (id: string, published?: boolean) =>
    request<{ published: boolean }>(`/plane/characters/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify(published === undefined ? {} : { published }),
    }),
  getPlanePool: (exclude?: string[]) =>
    request<{ pool: PlanePoolItem[] }>(`/plane/pool${exclude && exclude.length ? `?exclude=${exclude.join(',')}` : ''}`),
  createPlaneSession: (planeCharacterId: string) =>
    request<{
      sessionId: string;
      planeCharacterId: string;
      characterName: string;
      statsState: Record<string, number>;
      statsConfig: Array<{ name: string; initial: number; rules: string; target: number }>;
      goal: string;
      greeting: string;
      round: number;
    }>('/plane/sessions', {
      method: 'POST',
      body: JSON.stringify({ planeCharacterId }),
    }),
  getPlaneSession: (sessionId: string) =>
    request<PlaneSessionDetail>(`/plane/sessions/${sessionId}`),
  planeAdvanceStream: (
    sessionId: string,
    message: string | undefined,
    onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => void,
  ) =>
    requestStream<{
      sessionId: string;
      round: number;
      stats: Record<string, number>;
      statsChanges: Array<{ name: string; before: number; after: number }>;
      ambient: string[];
      goalAchieved: boolean;
      goalReason: string;
      reward: number;
      locationName: string;
    }>(
      `/plane/sessions/${sessionId}/advance`,
      { method: 'POST', body: JSON.stringify({ message }) },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat);
      },
    ),
  planeRetryStream: (
    sessionId: string,
    onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => void,
  ) =>
    requestStream<{
      sessionId: string;
      round: number;
      stats: Record<string, number>;
      statsChanges: Array<{ name: string; before: number; after: number }>;
      ambient: string[];
      goalAchieved: boolean;
      goalReason: string;
      reward: number;
      locationName: string;
    }>(
      `/plane/sessions/${sessionId}/retry`,
      { method: 'POST', body: '{}' },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat);
      },
    ),
  planeUndo: (sessionId: string) =>
    request<{ ok: boolean; round: number }>(`/plane/sessions/${sessionId}/undo`, {
      method: 'POST',
      body: '{}',
    }),
  endPlaneSession: (sessionId: string) =>
    request<{ ended: boolean }>(`/plane/sessions/${sessionId}/end`, {
      method: 'POST',
      body: '{}',
    }),
  deletePlaneSession: (sessionId: string) =>
    request<{ deleted: boolean }>(`/plane/sessions/${sessionId}`, { method: 'DELETE' }),
  listPlaneSessions: (active?: boolean) =>
    request<{ sessions: PlaneSessionSummary[] }>(`/plane/sessions${active ? '?active=1' : ''}`),

  // ─── 衍生世界（修仙程序化世界演化）────────────────────
  worldCreate: (data: { name?: string; seed?: number; npcCount?: number; regions?: number; cells?: number }) =>
    request<{ id: string; name: string; tick: number; map: WorldMapSummary; player: WorldPlayerSummary | null; npcCount: number }>('/world', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  worldList: () => request<{ worlds: WorldSummary[] }>('/world'),
  worldState: (id: string) => request<WorldState>(`/world/${id}/state`),
  worldAdvance: (id: string, months: number) =>
    request<{ tick: number; events: WorldEvent[]; player: WorldPlayerSummary | null }>(`/world/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ months }),
    }),
  worldMove: (id: string, loc: number) =>
    request<{ loc: number; locName: string; met: WorldNpcSummary[]; player: WorldPlayerSummary | null }>(`/world/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ loc }),
    }),
  worldTalk: (id: string, npcId: number, message: string) =>
    request<{ npcId: number; npcName: string; reply: WorldChatReply; event: WorldEvent | null; affinityToPlayer: number; hasCard: boolean }>(`/world/${id}/talk`, {
      method: 'POST',
      body: JSON.stringify({ npcId, message }),
    }),
  worldCraftStart: (id: string, recipeId: number) =>
    request<{ recipeId: number; recipeName: string; outputName: string; board: WorldBoard; movesLeft: number }>(`/world/${id}/craft/start`, {
      method: 'POST',
      body: JSON.stringify({ recipeId }),
    }),
  worldCraftSwap: (id: string, board: WorldBoard, x1: number, y1: number, x2: number, y2: number) =>
    request<{ board: WorldBoard; outcome: { valid: boolean; gained?: number; score?: number; chains?: number } }>(`/world/${id}/craft/swap`, {
      method: 'POST',
      body: JSON.stringify({ board, x1, y1, x2, y2 }),
    }),
  worldCraftFinish: (id: string, recipeId: number, board: WorldBoard) =>
    request<{ result: WorldCraftResult; player: WorldPlayerSummary | null }>(`/world/${id}/craft/finish`, {
      method: 'POST',
      body: JSON.stringify({ recipeId, board }),
    }),
  worldDelete: (id: string) => request<{ ok: boolean }>(`/world/${id}`, { method: 'DELETE' }),
};

// ─── 回忆归档类型（日记页）──────────────────────────────

export interface ArchiveDateItem {
  id: string;
  characterId: string;
  characterName: string;
  isGroup: boolean;
  locationId: string | null;
  locationName: string;
  summary: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveDateDetail {
  id: string;
  characterId: string;
  characterName: string;
  isGroup: boolean;
  participants: { characterId: string; name: string }[];
  locationId: string | null;
  locationName: string;
  mode: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveMessage {
  id: string;
  role: string;
  text: string;
  speaker: string | null;
  internal: string;
  internal_notable: number;
  internal_viewed: number;
  created_at: number;
}

/** 心绪弹窗数据：turns 旧→新（便于直接画折线），current 为最新一轮 */
export interface EmotionTurn {
  messageId: string;
  createdAt: number;
  emotions: Record<string, number>;
  top: { key: string; cn: string; value: number };
}
export interface EmotionPanelData {
  characterId: string;
  /** 这份「此刻心绪」最后是哪个渠道更新的：sms | scene | null */
  source?: string | null;
  turns: EmotionTurn[];
  current: { key: string; cn: string; value: number; emotions: Record<string, number>; createdAt: number } | null;
}

export interface ArchiveSmsItem {
  id: string;
  characterId: string;
  characterName: string;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
}

export interface ArchiveSmsDetail {
  id: string;
  characterId: string;
  characterName: string;
  createdAt: number;
}

export interface ArchiveTextMessage {
  id: string;
  sender: string;
  body: string;
  image_asset_id: string | null;
  internal: string;
  internal_notable: number;
  internal_viewed: number;
  created_at: number;
  delivered_at: number | null;
}

export interface ArchiveScenarioItem {
  id: string;
  scenarioId: string;
  scenarioTitle: string;
  scenarioDescription: string;
  characterId: string;
  characterName: string;
  goalAchieved: boolean;
  dreamText: string | null;
  dreamCustom: boolean;
  ended: boolean;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveScenarioDetail {
  id: string;
  scenarioId: string;
  scenarioTitle: string;
  scenarioDescription: string;
  worldview: string;
  playerRole: string;
  npcRole: string;
  npcRoles: NpcRoleSlot[];
  openingScene: string;
  greeting: string;
  greetings: string[];
  goal: string;
  statsConfig: StatsConfigItem[];
  statsState: Record<string, number>;
  characterId: string;
  characterName: string;
  goalAchieved: boolean;
  dreamText: string | null;
  dreamCustom: boolean;
  ended: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveSceneDateItem {
  id: string;
  characterId: string;
  characterName: string;
  isGroup: boolean;
  locationId: string | null;
  locationName: string;
  summary: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveSceneDateDetail {
  id: string;
  sceneType: string;
  characterId: string;
  characterName: string;
  isGroup: boolean;
  participants: { characterId: string; name: string }[];
  locationId: string | null;
  locationName: string;
  summary: string;
  roundNo: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveSceneMessage {
  id: string;
  role: string;
  character_id: string | null;
  character_name: string;
  text: string;
  internal: string;
  internal_notable: number;
  created_at: number;
}

export interface ArchiveSceneScenarioItem {
  id: string;
  scenarioId: string;
  scenarioTitle: string;
  scenarioDescription: string;
  characterId: string;
  characterName: string;
  isGroup: boolean;
  goalAchieved: boolean;
  dreamText: string | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArchiveSceneScenarioDetail {
  id: string;
  scenarioId: string;
  scenarioTitle: string;
  scenarioDescription: string;
  characterId: string;
  characterName: string;
  isGroup: boolean;
  worldview: string;
  playerRole: string;
  npcRoles: NpcRoleSlot[];
  goal: string;
  openingScene: string;
  goalAchieved: boolean;
  dreamText: string | null;
  roundNo: number;
  createdAt: number;
  updatedAt: number;
}

// ─── 互动小说类型 ────────────────────────────────────

export interface NovelInfo {
  id: string;
  authorId: string | null;
  title: string;
  summary: string;
  worldSetting: string;
  protagonistSetting: string;
  opening: string;
  coverUrl: string | null;
  status: string;
  playCount: number;
  createdAt: number;
  updatedAt: number;
  characterNames?: string[];
  characterAvatars?: string[];
}

export interface NovelCharacter {
  id: string;
  novelId: string;
  name: string;
  gender: string;
  persona: string;
  emotionalAnchor: string;
  appearance: string;
  avatar: string;
}

export interface NovelTurn {
  id: string;
  role: string;
  text: string;
  display: boolean;
  createdAt: number;
}

export interface NovelSessionData {
  sessionId: string;
  novelId: string;
  status: string;
  isAuthor: boolean;
  excludedCharIds: string[];
  novel: NovelInfo;
  protagonist: { name: string; pronoun: string };
  characters: NovelCharacter[];
  turns: NovelTurn[];
}

// ─── 衍生世界类型（修仙程序化世界演化）──────────────────

export interface WorldNpcSummary {
  id: number;
  name: string;
  gender: string;
  realm: number;
  realmName: string;
  faction: string;
  loc: number;
  locName: string;
  alive: boolean;
  liveliness: number;
  affinityToPlayer: number;
  hasCard: boolean;
}

export interface WorldItem {
  id: number;
  name: string;
  type: string;
  quality: string;
  lifespanBonus?: number;
  qiBonus?: number;
  realmBreak?: number;
}

export interface WorldPlayerSummary {
  name: string;
  gender: string;
  realm: number;
  realmName: string;
  qi: number;
  aptitude: number;
  comprehension: number;
  charm: number;
  fortune: number;
  lifespan: number;
  loc: number;
  locName: string;
  energy: number;
  actionPoints: number;
  backpack: WorldItem[];
  affinities: Record<string, number>;
}

export interface WorldEvent {
  id: number;
  tick: number;
  type: string;
  desc: string;
  visibility: string;
  loc: number;
  npcIds: number[];
  playerIntervened?: boolean;
  outcome?: string;
}

export interface WorldMapSummary {
  regions: number;
  cells: number;
  size: number;
  regionNames: string[];
  cellNames: string[];
}

export interface WorldSummary {
  id: string;
  name: string;
  seed: number;
  tick: number;
  created_at: number;
  updated_at: number;
}

export interface WorldState {
  id: string;
  name: string;
  seed: number;
  tick: number;
  map: WorldMapSummary;
  player: WorldPlayerSummary | null;
  npcs: WorldNpcSummary[];
  recentEvents: WorldEvent[];
  publicEvents: WorldEvent[];
}

export interface WorldBoard {
  size: number;
  cells: (string | null)[][];
  score: number;
  movesLeft: number;
}

export interface WorldChatReply {
  reply: string;
  innerThought: string;
  affinityDelta: number;
  fact: string;
}

export interface WorldCraftResult {
  success: boolean;
  item?: WorldItem;
  quality?: string;
  score?: number;
  desc: string;
}
