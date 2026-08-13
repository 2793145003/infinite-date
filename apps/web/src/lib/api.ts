/**
 * API客户端
 */
import { raiseLiveConflict, type LiveSlotType } from './live-conflict';
import type { SceneNpc, SceneLocationEntry } from '../components/admin/types';

const API_BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('idate_token');
}

export function setToken(token: string): void {
  localStorage.setItem('idate_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('idate_token');
}

/** 构建带认证token的图片URL（<img>标签无法自定义header，过渡期仍用 query token） */
export function imageUrl(filename: string): string {
  const token = getToken();
  return `${API_BASE}/uploads/${filename}${token ? `?token=${token}` : ''}`;
}

// 全局 401 回调：token 失效时回到登录页
let onAuthFail: (() => void) | null = null;
export function setAuthFailHandler(fn: () => void): void { onAuthFail = fn; }

/** 判断错误是否为「现场互斥」弹窗错误（api.ts 已自动弹出全局弹窗，调用方应静默不显示红条） */
export function isLiveConflictError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'LIVE_CONFLICT';
}

async function request<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const hasBody = opts.body != null;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers as Record<string, string> || {}),
  };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...opts, headers, signal: AbortSignal.timeout(30_000) });
  } catch {
    // 网络错误（服务器不可达）：不清 token，让调用方决定怎么处理
    throw new Error('网络连接失败');
  }

  if (res.status === 401) {
    clearToken();
    onAuthFail?.();
    throw new Error('未认证');
  }

  const data = await res.json();
  if (!res.ok) {
    // 现场互斥冲突（409 + live）：交给全局弹窗处理，不当作普通错误冒泡。
    // 调用方 catch 到 LIVE_CONFLICT 错误时应静默（弹窗已接管交互），不得显示红条。
    if (res.status === 409 && data && typeof data === 'object' && (data as { live?: unknown }).live) {
      const liveBody = (data as { live?: unknown }).live as Record<string, unknown>;
      raiseLiveConflict({
        live: {
          type: (liveBody.type ?? 'conversation') as LiveSlotType,
          sessionId: liveBody.sessionId as string | undefined,
          scenarioSessionId: liveBody.scenarioSessionId as string | undefined,
          missionId: liveBody.missionId as string | undefined,
          isGroup: !!liveBody.isGroup,
        },
        // 供"结束原现场后重做"使用：结束时用同一 path/opts 重新发起原创建请求
        redo: { path, opts },
      });
      const conflictErr = new Error('LIVE_CONFLICT') as Error & { status?: number; body?: unknown; code?: string };
      conflictErr.status = 409;
      conflictErr.body = data;
      conflictErr.code = 'LIVE_CONFLICT';
      throw conflictErr;
    }
    const err = new Error(data.error || `HTTP ${res.status}`) as Error & { status?: number; body?: unknown; code?: string };
    err.status = res.status;
    err.body = data;
    if (res.status === 409) err.code = 'CONFLICT';
    throw err;
  }
  return data as T;
}

/** SSE 事件中的 error 类型——用自定义类区分坏帧 catch */
class SseError extends Error {}

/**
 * 流式请求（SSE）：边接收边回调每条 data 事件。
 * 用于 /scene/.../advance 这类每拍生成完即推的模式，避免 30s 超时 & 全量等待。
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

export const api = {
  // 认证
  login: (code: string) =>
    request<{ token: string; player: PlayerInfo }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  /** 原始请求（供现场互斥弹窗"结束原现场后重做"用）：直接用已构造的 path/opts 重新发起 */
  fetchRaw: <T = unknown>(path: string, opts: RequestInit) =>
    request<T>(path, opts),

  me: () =>
    request<{ player: PlayerInfo; permissions: number }>('/auth/me'),

  // 玩家
  getPlayer: () =>
    request<{ player: PlayerInfo; permissions: number }>('/player'),

  updatePlayer: (data: { name?: string; pronouns?: string; gender?: string; appearance?: string }) =>
    request('/player', { method: 'PATCH', body: JSON.stringify(data) }),

  // 角色创建
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

  // 地图NPC
  getMapNpcs: () =>
    request<{ locations: Record<string, { characterId: string; name: string; avatarType?: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown'; activity: string }[]> }>(`/map/npcs`),

  // 新地图专用：谁在哪个地点（基于 scene_locations + scene_homes 生成，不含父链传播）
  sceneMapNpcs: () =>
    request<{ locations: Record<string, { characterId: string; name: string; avatarType?: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown'; activity: string }[]> }>(`/scene/map/npcs`),

  // 新地图专用：角色行程（点头像看现在在哪/接下来去哪）
  getSceneNpcSchedule: (characterId: string) =>
    request<{
      characterId: string;
      characterName: string;
      current: { locationId: string; locationName: string; activity: string; startTime: number; duration: number } | null;
      upcoming: { locationId: string; locationName: string; activity: string; startTime: number; duration: number }[];
    }>(`/scene/npcs/${characterId}/schedule`),

  // 约会/对话
  startConversation: (characterId: string, locationId: string, opts?: { trigger?: 'talk' | 'invite' | 'deity_pick' }) =>
    request<{
      sessionId: string;
      greeting: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null;
    }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ characterId, locationId, mode: 'chat', trigger: opts?.trigger }),
    }),

  getConversationMessages: (sessionId: string) =>
    request<{ session: { character_id: string; ended: number }; messages: { id: string; role: string; text: string; image_path: string | null; internal: string; internal_notable: number; internal_viewed: number; created_at: number }[]; isFriend: boolean; missionInfo: { worldName: string; item: string; briefing: string } | null }>(`/sessions/${sessionId}/messages`),

  sendConversationMessage: (sessionId: string, text: string, imagePath?: string, quoteId?: string, quoteText?: string, quoteSenderName?: string) =>
    request<{
      playerMessage: { id: string; text: string; imagePath: string | null };
      npcMessages: NpcReply[];
      scene_concluded?: boolean;
      environment?: string;
      quest_npc_line?: string;
      currentLocationName?: string;
    }>(`/sessions/${sessionId}/send`, {
      method: 'POST',
      body: JSON.stringify({ text, imagePath, quoteId, quoteText, quoteSenderName }),
    }),

  endConversation: (sessionId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/end`, { method: 'POST' }),

  addFriend: (sessionId: string) =>
    request<{ ok?: boolean; alreadyFriend?: boolean; threadId?: string }>(`/sessions/${sessionId}/add-friend`, { method: 'POST' }),

  undoConversation: (sessionId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/undo`, { method: 'DELETE' }),

  retryConversation: (sessionId: string) =>
    request<{ npcMessages: NpcReply[]; environment?: string; quest_npc_line?: string; scene_concluded?: boolean; currentLocationName?: string }>(`/sessions/${sessionId}/retry`, { method: 'POST' }),

  nudgeConversation: (sessionId: string) =>
    request<{ npcMessages: NpcReply[] }>(`/sessions/${sessionId}/nudge`, { method: 'POST' }),

  // 探索
  startExplore: (locationId: string) =>
    request<{
      type: 'encounter' | 'explore';
      // encounter
      sessionId?: string;
      characterId?: string;
      characterName?: string;
      isKnown?: boolean;
      greeting?: { messages: string[]; internal: string; internal_notable: boolean };
      // explore
      exploreSessionId?: string;
      locationName?: string;
      // 共有
      narration: string;
      foundItem?: { ownerName: string; itemDescription: string } | null;
    }>('/explore', {
      method: 'POST',
      body: JSON.stringify({ locationId }),
    }),

  exploreAct: (sessionId: string, text: string) =>
    request<{
      narration: string;
      foundItem?: { ownerName: string; itemDescription: string } | null;
    }>(`/explore/${sessionId}/act`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  endExplore: (sessionId: string) =>
    request<{ ok: boolean }>(`/explore/${sessionId}/end`, { method: 'POST' }),

  // 短信
  getThreads: () =>
    request<{ threads: ThreadInfo[] }>('/sms/threads'),

  getMessages: (threadId: string) =>
    request<{ thread: ThreadInfo; messages: TextMessage[] }>(`/sms/threads/${threadId}/messages`),

  sendSms: (threadId: string, text: string, imagePath?: string, quoteId?: string, quoteText?: string, quoteSenderName?: string) =>
    request<{
      playerMessage: { id: string; text: string; imageAssetId: string | null };
      npcMessages: NpcReply[];
      invite?: SmsInvite;
    }>(`/sms/threads/${threadId}/send`, {
      method: 'POST',
      body: JSON.stringify({ text, imagePath, quoteId, quoteText, quoteSenderName }),
    }),

  undoSms: (threadId: string) =>
    request<{ ok: boolean }>(`/sms/threads/${threadId}/undo`, { method: 'DELETE' }),

  retrySms: (threadId: string) =>
    request<{ npcMessages: NpcReply[]; invite?: SmsInvite }>(`/sms/threads/${threadId}/retry`, { method: 'POST' }),

  regenerateSmsGreeting: (threadId: string) =>
    request<{ npcMessages: NpcReply[] }>(`/sms/threads/${threadId}/regenerate-greeting`, { method: 'POST' }),

  createDeityThread: () =>
    request<{ threadId: string }>('/sms/deity/thread', { method: 'POST' }),

  // 邮件
  getEmails: () =>
    request<{ emails: EmailInfo[] }>('/emails'),

  readEmail: (emailId: string) =>
    request(`/emails/${emailId}/read`, { method: 'POST' }),

  getUnreadEmailCount: () =>
    request<{ count: number }>('/emails/unread-count'),

  // 约会
  createSession: (data: { characterId: string; locationId?: string; mode?: string }) =>
    request<{ sessionId: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getSessionMessages: (sessionId: string) =>
    request<{ session: SessionInfo; messages: SessionMessage[] }>(`/sessions/${sessionId}/messages`),

  sendSessionMessage: (sessionId: string, text: string) =>
    request<{
      playerMessage: { id: string; text: string };
      npcMessages: NpcReply[];
      scene_concluded: boolean;
      item_obtained: boolean | null;
    }>(`/sessions/${sessionId}/send`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  endSession: (sessionId: string) =>
    request(`/sessions/${sessionId}/end`, { method: 'POST' }),

  getActiveSession: () =>
    request<{ session: { id: string; characterId: string; characterName: string; locationId: string | null; locationName: string; isGroup?: boolean; participants?: { characterId: string; name: string }[]; createdAt: number } | null }>('/sessions/active'),

  // ─── 群聊约会 ──────────────────────────────────────────────
  startGroupSession: (characterIds: string[], locationId: string, opts?: { trigger?: 'invite' | 'deity_pick' }) =>
    request<{
      sessionId: string;
      greeting: { messages: { speaker: string; text: string }[]; internals: Record<string, string>; internals_notable: Record<string, boolean> };
      participants: { characterId: string; name: string }[];
    }>('/sessions/group', {
      method: 'POST',
      body: JSON.stringify({ characterIds, locationId, trigger: opts?.trigger }),
    }),

  getGroupMessages: (sessionId: string) =>
    request<{
      session: { id: string; character_id: string; location_id: string | null; ended: number; is_group: number };
      messages: { id: string; role: string; text: string; speaker: string | null; internal: string; internal_notable: number; internal_viewed: number; created_at: number }[];
      isGroup: true;
      participants: { characterId: string; name: string; joinOrder: number }[];
    }>(`/sessions/${sessionId}/messages`),

  sendGroupMessage: (sessionId: string, text: string, quoteId?: string, quoteText?: string, quoteSenderName?: string) =>
    request<{
      playerMessage: { id: string; text: string };
      npcMessages: { id: string; speaker: string; text: string; internal: string; internal_notable: boolean }[];
      scene_concluded: boolean;
    }>(`/sessions/${sessionId}/group-send`, {
      method: 'POST',
      body: JSON.stringify({ text, quoteId, quoteText, quoteSenderName }),
    }),

  // 设置
  getSettings: () =>
    request<{ baseUrl: string; model: string; apiKeySet: boolean }>('/settings'),

  updateSettings: (data: { baseUrl?: string; apiKey?: string; model?: string }) =>
    request<{ ok: boolean; apiKeySet: boolean }>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteAccount: () =>
    request<{ ok: boolean; token?: string }>('/player', { method: 'DELETE' }),

  // 管理员 — 公共NPC管理
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

  // 玩家事实（记忆）
  getFacts: () =>
    request<{ facts: { id: string; character_id: string; character_name: string; fact: string; source: string; created_at: number; updated_at: number }[] }>('/facts'),

  getLegacyFacts: () =>
    request<{ facts: { id: string; character_id: string; character_name: string; fact: string; source: string; created_at: number; updated_at: number }[] }>('/facts/legacy'),

  updateFact: (id: string, fact: string) =>
    request<{ ok: boolean }>(`/facts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fact }),
    }),

  deleteFact: (id: string) =>
    request<{ ok: boolean }>(`/facts/${id}`, { method: 'DELETE' }),

  addFact: (fact: string, characterId?: string) =>
    request<{ ok: boolean; id: string }>('/facts', {
      method: 'POST',
      body: JSON.stringify({ fact, characterId }),
    }),

  // 地点
  getLocations: (parentId?: string) =>
    request<{ locations: LocationInfo[] }>(`/locations${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''}`),

  getLocation: (id: string) =>
    request<{ location: LocationInfo }>(`/locations/${id}`),

  createLocation: (data: { name: string; summary?: string; isPublic: boolean; parentId?: string | null }) =>
    request<{ location: LocationInfo }>('/locations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteLocation: (id: string) =>
    request<{ ok: boolean }>(`/locations/${id}`, { method: 'DELETE' }),

  // NPC行程
  getNpcSchedule: (characterId: string) =>
    request<{
      characterId: string;
      characterName: string;
      current: { locationId: string; locationName: string; activity: string; startTime: number; duration: number } | null;
      upcoming: { locationId: string; locationName: string; activity: string; startTime: number; duration: number }[];
    }>(`/npcs/${characterId}/schedule`),

  // 在线状态 + NPC主动消息
  heartbeat: (data: { view: string; sessionId?: string; threadId?: string; characterId?: string; idleMs: number }) =>
    request<PresenceResponse>('/presence', { method: 'POST', body: JSON.stringify(data) }),

  clearPresence: () =>
    request<{ ok: boolean }>('/presence', { method: 'DELETE' }),

  // ─── 任务系统 ──────────────────────────────────────────
  generateMission: () =>
    request<{ missionId: string; world: { id: string; name: string; summary: string; tone: string; briefing: string; item: string; obsession: string } }>('/missions/generate', { method: 'POST' }),

  getMissions: () =>
    request<{ missions: MissionInfo[] }>('/missions'),

  acceptMission: (missionId: string, companionId: string) =>
    request<{ sessionId: string; greeting: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null }>(`/missions/${missionId}/accept`, {
      method: 'POST',
      body: JSON.stringify({ companionId }),
    }),

  declineMission: (missionId: string) =>
    request<{ ok: boolean }>(`/missions/${missionId}/decline`, { method: 'POST' }),

  getMissionFriends: () =>
    request<{ friends: { characterId: string; name: string }[] }>('/missions/friends'),

  // 角色编辑（普通用户）
  getCharacterForEdit: (characterId: string) =>
    request<{ characterData: Record<string, unknown>; hasFork: boolean; isPublic: boolean; publicData: Record<string, unknown> | null }>(`/characters/${characterId}/edit`),

  forkCharacter: (characterId: string, characterData: Record<string, unknown>) =>
    request<{ ok: boolean; forked: boolean }>(`/characters/${characterId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ characterData }),
    }),

  // ─── 个人空间 ──────────────────────────────────────────────
  getMyCharacters: () =>
    request<{ characters: { characterId: string; name: string; hasFork: boolean; forkUpdatedAt: number | null; factCount: number; chronicleCount: number; isFriend: boolean }[] }>('/me/characters'),

  resetCharacterFork: (characterId: string) =>
    request<{ ok: boolean }>(`/me/characters/${characterId}/fork`, { method: 'DELETE' }),

  clearCharacterMemory: (characterId: string) =>
    request<{ ok: boolean }>(`/me/memory/${characterId}`, { method: 'DELETE' }),

  clearAllMemory: () =>
    request<{ ok: boolean }>('/me/memory', { method: 'DELETE' }),

  deleteFriend: (characterId: string) =>
    request<{ ok: boolean }>(`/me/friend/${characterId}`, { method: 'DELETE' }),

  // ─── 朋友圈 ──────────────────────────────────────────────
  getMoments: () =>
    request<{ moments: MomentInfo[]; serverTime: number }>('/moments'),

  getUnreadMomentsCount: (since: number) =>
    request<{ count: number }>(`/moments/unread-count?since=${since}`),

  createMoment: (content: string, imagePath?: string) =>
    request<{ ok: boolean; momentId: string }>('/moments', {
      method: 'POST',
      body: JSON.stringify({ content, imagePath }),
    }),

  uploadImage: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const token = getToken();
    return fetch(`${API_BASE}/upload/image`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: formData,
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      return data as { imagePath: string; size: number };
    });
  },

  commentMoment: (momentId: string, text: string) =>
    request<{ ok: boolean; interactionId: string }>(`/moments/${momentId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  likeMoment: (momentId: string) =>
    request<{ ok: boolean; liked: boolean }>(`/moments/${momentId}/like`, { method: 'POST' }),

  deleteMoment: (momentId: string) =>
    request<{ ok: boolean }>(`/moments/${momentId}`, { method: 'DELETE' }),

  // ─── 功能建议 ──────────────────────────────────────────────
  getSuggestions: () =>
    request<{ suggestions: SuggestionInfo[]; isAdmin: boolean; serverTime: number }>('/suggestions'),

  getUnreadSuggestionsCount: (since: number) =>
    request<{ count: number }>(`/suggestions/unread-count?since=${since}`),

  createSuggestion: (data: { title: string; body?: string; category?: string; isAnonymous?: boolean }) =>
    request<{ ok: boolean; suggestionId: string }>('/suggestions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  likeSuggestion: (suggestionId: string) =>
    request<{ ok: boolean; liked: boolean }>(`/suggestions/${suggestionId}/like`, { method: 'POST' }),

  commentSuggestion: (suggestionId: string, text: string) =>
    request<{ ok: boolean; commentId: string }>(`/suggestions/${suggestionId}/comment`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  deleteSuggestionComment: (suggestionId: string, commentId: string) =>
    request<{ ok: boolean }>(`/suggestions/${suggestionId}/comment/${commentId}`, { method: 'DELETE' }),

  // 管理员 — 建议管理
  adminUpdateSuggestion: (suggestionId: string, data: { status?: string; adminNote?: string }) =>
    request<{ ok: boolean }>(`/admin/suggestions/${suggestionId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  adminDeleteSuggestion: (suggestionId: string) =>
    request<{ ok: boolean }>(`/admin/suggestions/${suggestionId}`, { method: 'DELETE' }),

  // ─── 更新日志 ──────────────────────────────────────────────
  getChangelog: () =>
    request<{ entries: ChangelogEntry[]; isAdmin: boolean }>('/changelog'),

  adminCreateChangelog: (data: { version?: string; title: string; body?: string }) =>
    request<{ ok: boolean; entryId: string }>('/admin/changelog', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  adminUpdateChangelog: (entryId: string, data: { version?: string; title?: string; body?: string }) =>
    request<{ ok: boolean }>(`/admin/changelog/${entryId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  adminDeleteChangelog: (entryId: string) =>
    request<{ ok: boolean }>(`/admin/changelog/${entryId}`, { method: 'DELETE' }),

  // ─── 剧本系统（场景剧本）────────────────────────────────────

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

  enterScenario: (scenarioId: string, characterId: string, characterIds?: string[]) =>
    request<{
      scenarioSessionId: string;
      sessionId: string;
      greeting: { messages: { speaker: string; text: string }[]; internals: Record<string, string>; internals_notable: Record<string, boolean> } | null;
      stats: Record<string, number>;
      statsConfig: StatsConfigItem[];
    }>(`/scenarios/${scenarioId}/enter`, {
      method: 'POST',
      body: JSON.stringify(characterIds ? { characterIds } : { characterId }),
    }),

  scenarioSend: (scenarioSessionId: string, text: string, quoteId?: string, quoteText?: string, quoteSenderName?: string) =>
    request<{
      playerMessage: { id: string; text: string };
      npcMessages: { id: string; text: string; speaker?: string; internal: string; internal_notable: boolean }[];
      stats: { stats: Record<string, number>; changes: Array<{ name: string; delta: number; reason: string }>; goal_achieved: boolean } | null;
    }>(`/scenarios/${scenarioSessionId}/send`, {
      method: 'POST',
      body: JSON.stringify({ text, quoteId, quoteText, quoteSenderName }),
    }),

  getScenarioMessages: (scenarioSessionId: string) =>
    request<{
      messages: Array<{ id: string; role: string; text: string; speaker: string | null; internal: string; internal_notable: number; internal_viewed: number; created_at: number }>;
      scenario: ScenarioInfo;
      statsState: Record<string, number>;
      statsConfig: StatsConfigItem[];
      goalAchieved: boolean;
      ended: boolean;
      dreamText: string | null;
      isGroup: boolean;
      characterId: string;
      characterName: string;
      participants?: { characterId: string; name: string }[];
    }>(`/scenarios/${scenarioSessionId}/messages`),

  getActiveScenario: () =>
    request<{ active: boolean; sessionId?: string; scenarioId?: string; title?: string; round?: number; goalAchieved?: boolean; characters?: string[] }>('/scene-scenario/active'),

  endScenario: (scenarioSessionId: string) =>
    request<{ ok: boolean }>(`/scenarios/${scenarioSessionId}/end`, { method: 'POST' }),

  scenarioUndo: (scenarioSessionId: string) =>
    request<{ ok: boolean }>(`/scenarios/${scenarioSessionId}/undo`, { method: 'DELETE' }),

  scenarioRetry: (scenarioSessionId: string) =>
    request<{ npcMessages: NpcReply[]; stats: { stats: Record<string, number>; changes: Array<{ name: string; delta: number; reason: string }>; goal_achieved: boolean } | null }>(`/scenarios/${scenarioSessionId}/retry`, { method: 'POST' }),

  scenarioNudge: (scenarioSessionId: string) =>
    request<{ npcMessages: NpcReply[] }>(`/scenarios/${scenarioSessionId}/nudge`, { method: 'POST' }),

  scenarioDream: (scenarioSessionId: string) =>
    request<{ dreamText: string | null }>(`/scenarios/${scenarioSessionId}/dream`, { method: 'GET' }),

  // ─── 回忆录 ──────────────────────────────────────────────

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

  // ─── 新场景引擎（scene）─────────────────────────────────────────
  sceneStart: (data: { locationId: string; characterIds: string[]; circumstance?: string }) =>
    request<{ sessionId: string; location: string; characters: string[]; round: number }>('/scene/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sceneAdvance: (sessionId: string, message?: string, quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string }) =>
    request<{
      sessionId: string;
      round: number;
      beats: { kind: 'narration' | 'character'; speaker?: string; content: string }[];
      stats: Record<string, number>;
      statsChanges: Array<{ name: string; before: number; after: number }>;
    }>(`/scene/${sessionId}/advance`, {
      method: 'POST',
      body: JSON.stringify({ message, quote }),
    }),
  sceneContinue: (sessionId: string) =>
    request<{
      sessionId: string;
      round: number;
      beats: { kind: 'narration' | 'character'; speaker?: string; content: string }[];
    }>(`/scene/${sessionId}/continue`, { method: 'POST', body: '{}' }),
  sceneRetry: (sessionId: string) =>
    request<{ ok: boolean; round: number; beats: { kind: 'narration' | 'character'; speaker?: string; content: string }[] }>(`/scene/${sessionId}/retry`, { method: 'POST', body: '{}' }),
  /// 流式推进：每生成完一拍就回调 onBeat，返回 done 事件对象
  sceneAdvanceStream: (sessionId: string, message?: string, quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string },
    onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => void,
    onDirector?: (beats: { kind: string; speaker?: string; intent: string; type?: string; to?: string; query?: string }[]) => void) =>
    requestStream<{ sessionId: string; round: number; stats: Record<string, number>; statsChanges: Array<{ name: string; before: number; after: number }> }>(
      `/scene/${sessionId}/advance`,
      { method: 'POST', body: JSON.stringify({ message, quote }) },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat); // 透传 Promise，让 requestStream 逐条 await（气泡串行上屏）
        if (evt.type === 'director' && evt.beats) onDirector?.(evt.beats);
      },
    ),
  sceneContinueStream: (sessionId: string, onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => void,
    onDirector?: (beats: { kind: string; speaker?: string; intent: string; type?: string; to?: string; query?: string }[]) => void) =>
    requestStream<{ sessionId: string; round: number; stats: Record<string, number>; statsChanges: Array<{ name: string; before: number; after: number }> }>(
      `/scene/${sessionId}/continue`,
      { method: 'POST', body: '{}' },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat);
        if (evt.type === 'director' && evt.beats) onDirector?.(evt.beats);
      },
    ),
  sceneRetryStream: (sessionId: string, onBeat?: (b: { kind: string; speaker?: string; content: string; characterId?: string }) => void,
    onDirector?: (beats: { kind: string; speaker?: string; intent: string; type?: string; to?: string; query?: string }[]) => void) =>
    requestStream<{ ok: boolean; round: number }>(
      `/scene/${sessionId}/retry`,
      { method: 'POST', body: '{}' },
      (evt) => {
        if (evt.type === 'beat' && evt.beat) return onBeat?.(evt.beat);
        if (evt.type === 'director' && evt.beats) onDirector?.(evt.beats);
      },
    ),
  sceneUndo: (sessionId: string) =>
    request<{ ok: boolean; round: number }>(`/scene/${sessionId}/undo`, { method: 'POST', body: '{}' }),
  sceneEnd: (sessionId: string) =>
    request<{ ok: boolean; ended: boolean }>(`/scene/${sessionId}/end`, { method: 'POST', body: '{}' }),
  sceneGet: (sessionId: string) =>
    request<{
      sessionId: string;
      location: string | null;
      locationName: string;
      locationBackground: string;
      sceneType: string;
      round: number;
      ended: boolean;
      participants?: { characterId: string; name: string; avatar?: string; isFriend: boolean }[];
      messages: { id: string; round_no: number; role: string; character_id: string | null; character_name: string; text: string; quote: string | null; internal: string | null; internal_notable?: number | boolean | null }[];
    }>(`/scene/${sessionId}`),
  sceneAddFriend: (characterId: string) =>
    request<{ ok: boolean; alreadyFriend: boolean; threadId?: string }>(`/scene/character/${characterId}/add-friend`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // ─── 剧本场景引擎（scene-scenario）──────────────────────────────
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
      goal: string;
      ambientConfig: string;
      openingScene: string;
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

  /** 进行中的场景约会（主页待办） */
  getActiveSceneDate: () =>
    request<{
      session: {
        id: string;
        characterId: string;
        characterName: string;
        avatar?: string;
        isGroup?: boolean;
        participants?: { characterId: string; name: string; avatar?: string }[];
        locationId: string | null;
        locationName: string;
        createdAt: number;
      } | null;
    }>('/scene/active'),
  sceneLocations: (parentId?: string) =>
    request<{ locations: SceneLocationInfo[] }>(`/scene/locations${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ''}`),
  sceneCreateLocation: (data: { name: string; summary?: string; parentId?: string | null; isPublic?: boolean }) =>
    request<{ location: SceneLocationInfo }>('/scene/locations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sceneSetBackground: (locationId: string, background: string) =>
    request<{ ok: boolean; mode: 'private' | 'public'; background: string; submissions?: { uploaderId: string; image: string }[] }>(
      `/scene/locations/${locationId}/background`,
      {
        method: 'POST',
        body: JSON.stringify({ background }),
      }
    ),
  sceneAddNpc: (locationId: string, data: { role: string; name: string; persona?: string }) =>
    request<{ npcs: SceneNpcInfo[] }>(`/scene/locations/${locationId}/npcs`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sceneExploreStart: (locationId: string) =>
    request<{ exploreSessionId: string; locationId: string; locationName: string; narration: string }>(
      '/scene/explore',
      { method: 'POST', body: JSON.stringify({ locationId }) }
    ),
  sceneExploreStep: (sessionId: string, text?: string) =>
    request<SceneExploreStep>(`/scene/explore/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  sceneExploreEnd: (sessionId: string) =>
    request<{ ok: boolean }>(`/scene/explore/${sessionId}/end`, { method: 'POST' }),
};

// ─── 类型 ────────────────────────────────────────────────

export interface PlayerInfo {
  id: string;
  name: string;
  pronouns: string;
  gender: string;
  appearance: string;
  tutorial_step: number;
  rating_score?: number;
  is_admin?: boolean;
}

export interface ThreadInfo {
  id: string;
  character_id: string;
  character_name?: string;
  avatar?: string | null;
  last_message?: string;
  last_sender?: string;
  unread_count: number;
  last_message_at: number | null;
}

export interface TextMessage {
  id: string;
  sender: 'player' | 'npc';
  body: string;
  status: string;
  image_asset_id: string | null;
  metadata?: string;
  internal: string;
  internal_notable: number;
  internal_viewed: number;
  created_at: number;
  delivered_at: number | null;
}

export interface NpcReply {
  id: string;
  text: string;
  speaker?: string | null;
  internal: string;
  internal_notable: boolean;
  internal_viewed: boolean;
  environment?: string;
}

export interface SmsInvite {
  locationId: string;
  locationName: string;
}

export interface EmailInfo {
  id: string;
  sender_type: string;
  subject: string;
  body: string;
  is_read: number;
  created_at: number;
}

export interface SessionInfo {
  id: string;
  character_id: string;
  location_id: string | null;
  mode: string;
  ended: number;
}

export interface SessionMessage {
  id: string;
  role: 'player' | 'assistant';
  text: string;
  internal: string;
  internal_viewed: number;
  created_at: number;
}

export interface LocationInfo {
  id: string;
  name: string;
  summary: string;
  creatorType: 'system' | 'player' | 'character';
  isPublic: boolean;
  isMine: boolean;
  isHome: boolean;
  parentId: string | null;
  path: string;
  hasChildren: boolean;
  createdAt: number;
}

export interface ProactiveMessage {
  id: string;
  text: string;
  internal: string;
  internal_notable: boolean;
}

export interface PresenceResponse {
  proactive: boolean;
  messages?: ProactiveMessage[];
}

export interface MissionInfo {
  id: string;
  questType: string;
  status: 'available' | 'active' | 'completed' | 'declined';
  title: string;
  description: string;
  reward: number;
  worldName: string | null;
  item: string;
  obsession: string;
  briefing: string;
  landmarks: { name: string; feature: string }[];
  minorCharacters: { name: string; trait: string }[];
  worldTension: string;
  missionHook: string;
  twistSeed: string;
  characterId: string | null;
  evaluationResult: { item_obtained: boolean; obsession_resolved: boolean; cooperation_quality: string; summary: string } | null;
  ratingScore: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// ─── 朋友圈类型 ────────────────────────────────────────────

export interface MomentInteraction {
  id: string;
  authorType: 'player' | 'character';
  authorId: string;
  authorName: string;
  body?: string;
  createdAt: number;
}

export interface MomentInfo {
  id: string;
  authorType: 'player' | 'character';
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  content: string;
  imagePath: string | null;
  mood: string;
  locationName: string;
  triggerType: string;
  createdAt: number;
  likes: MomentInteraction[];
  comments: MomentInteraction[];
}

// ─── 功能建议 & 更新日志类型 ────────────────────────────────────

export interface SuggestionInteraction {
  id: string;
  playerId?: string;   // 仅管理员可见
  authorName: string;
  isMine?: boolean;
  body?: string;
  createdAt: number;
}

export interface SuggestionInfo {
  id: string;
  authorName: string | null;  // null = 匿名
  isAnonymous: boolean;
  title: string;
  body: string;
  category: string;       // general/bug/feature/improvement
  status: string;         // open/planned/done/declined
  adminNote: string;
  createdAt: number;
  updatedAt: number;
  likes: SuggestionInteraction[];
  comments: SuggestionInteraction[];
  myLiked: boolean;
}

export interface ChangelogEntry {
  id: string;
  version: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

// ─── 剧本系统类型 ────────────────────────────────────────────

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

export interface ActiveScenarioSession {
  scenarioSessionId: string;
  scenarioId: string;
  scenarioTitle: string;
  characterId: string;
  characterName: string;
  isGroup: boolean;
  participants?: { characterId: string; name: string }[];
  statsState: Record<string, number>;
  statsConfig: StatsConfigItem[];
  goalAchieved: boolean;
  createdAt: number;
}

// ─── 回忆录类型 ────────────────────────────────────────────

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

// ─── 场景约会回忆类型 ───────────────────────────────────────────

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

// ─── 场景剧本回忆类型 ───────────────────────────────────────────

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

// ─── 新场景引擎类型 ────────────────────────────────────────────

export interface SceneNpcInfo {
  id: string;
  role: string;
  name: string;
  persona: string;
}

export interface SceneLocationInfo {
  id: string;
  name: string;
  summary: string;
  creatorType: 'system' | 'player' | 'character';
  creatorId: string | null;
  isPublic: boolean;
  parentId: string | null;
  path: string;
  hasChildren: boolean;
  npcs: SceneNpcInfo[];
  isHome: boolean;
  background: string;
}

/** 场景对话里的一拍（一条消息） */
export interface SceneBeat {
  kind: 'narration' | 'character';
  speaker?: string;
  content: string;
  characterId?: string;
  internal?: string;
  internalNotable?: boolean;
}

/** 探索一步的返回 */
export interface SceneExploreStep {
  type: 'narration' | 'encounter' | 'item' | 'caught';
  narration?: string;
  characterId?: string;
  characterName?: string;
  isKnown?: boolean;
  itemDescription?: string;
  itemOwnerName?: string;
}
