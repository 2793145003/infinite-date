import React, { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import { getAnimeMaleAvatar } from '../data/animeAvatars';

/**
 * 场景对话页（v4 版）—— 从 v2 旧 UI SceneConversation 移植。
 * 剧本式：旁白居中一条条出，角色台词气泡。
 * 支持：每个气泡复制/引用；每轮最后一个气泡重试/继续；玩家最后一个气泡撤回；结束约会；加好友。
 * 底层走命名引擎 /scene-named（后端注释明确：测完切生产只需前端把 /scene/* 换成 /scene-named/*）。
 */

/** 后端消息行（scene-named GET 返回的 messages 元素） */
type Line = {
  id?: string;
  round_no?: number;
  role: string;
  character_id?: string | null;
  character_name: string;
  text: string;
  quote?: string | null;
  internal?: string | null;
  internal_notable?: number | boolean | null;
  created_at?: number | string | null;
};

/** 引用载荷（推进请求 body.quote） */
type QuotePayload = { quoteId?: string; quoteText?: string; quoteSenderName?: string };

/** 前端显示气泡（由 Line 映射 / SSE beat 上屏） */
type Bubble = {
  id: string;
  kind: 'narration' | 'character' | 'player';
  speaker?: string;
  characterId?: string;
  content: string;
  time?: number;
  quote: QuotePayload | null;
  internal: string;
  internalNotable: boolean;
};

type QuoteMsg = { id: string; text: string; senderName: string };

/** SSE 'beat' 事件载荷 */
type Beat = {
  kind: string;
  speaker?: string;
  content: string;
  characterId?: string;
  internal?: string;
  internalNotable?: boolean;
};

type SceneParticipant = {
  characterId: string;
  name: string;
  avatar?: string;
  isFriend: boolean;
};

type SceneData = {
  sessionId: string;
  locationName: string;
  locationBackground: string;
  round: number;
  ended: boolean;
  messages: Line[];
  participants?: SceneParticipant[];
};

/** 推进/继续的 done 事件携带地点信息（retry 的 done 不带） */
type StreamDone = {
  locationName?: string;
  locationBackground?: string;
  [key: string]: unknown;
};

/** SSE 事件（泛化解析） */
type SseEvent = {
  type: string;
  beat?: Beat;
  error?: string;
  [key: string]: unknown;
};

/** 图片URL：与 v2 imageUrl 同构，走 /v4/api 前缀（<img> 自动携带 httpOnly cookie 认证） */
const imageUrl = (filename: string): string => `/v4/api/uploads/${filename}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const formatTime = (ms: number): string => {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

/** 把后端消息行映射为前端 Bubble */
function toLine(m: Line): Bubble {
  let quote: QuotePayload | null = null;
  if (m.quote) {
    try { quote = JSON.parse(m.quote) as QuotePayload; } catch { quote = null; }
  }
  const kind: Bubble['kind'] =
    m.role === 'player' ? 'player' : m.role === 'narration' ? 'narration' : 'character';
  const ts =
    typeof m.created_at === 'number'
      ? m.created_at
      : typeof m.created_at === 'string'
        ? Number(m.created_at)
        : undefined;
  return {
    id: m.id ?? `${kind}-${m.character_name}-${m.text}`,
    kind,
    speaker: kind === 'narration' ? undefined : m.character_name || (kind === 'player' ? '我' : '角色'),
    characterId: m.character_id ?? undefined,
    content: m.text,
    time: ts && !Number.isNaN(ts) ? ts : undefined,
    quote,
    internal: kind === 'character' ? m.internal ?? '' : '',
    internalNotable: kind === 'character' ? !!m.internal_notable : false,
  };
}

/** 普通 POST（JSON，无响应体关心）：undo / end / add-friend */
async function postJson(path: string): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * SSE 流式 POST：边接收边逐条 await onEvent，返回 done 事件解析出的对象（若无则 null）。
 * 参考 v2 lib/api.ts 的 requestStream 实现，按 '\n\n' 切分事件、解析 'data: {...}' JSON。
 */
async function streamPost<T>(
  path: string,
  body: string,
  onEvent: (evt: SseEvent) => void | Promise<void>,
): Promise<T | null> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done: T | null = null;

  while (true) {
    const { value, done: isDone } = await reader.read();
    if (isDone) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      let evt: SseEvent;
      try {
        evt = JSON.parse(dataLine.slice(6)) as SseEvent;
      } catch {
        continue; // 坏帧：忽略
      }
      if (evt.type === 'done') done = evt as unknown as T;
      if (evt.type === 'error') throw new Error(evt.error || '服务器错误');
      await onEvent(evt); // 逐条 await：气泡串行上屏
    }
  }
  return done;
}

/** 渲染带动作标记的文本：*星号动作* 与（中文括号动作）/（半角）→ 柔色斜体，与台词区分开 */
function renderText(text: string, dimClass = 'text-ink-muted/70'): ReactNode[] {
  const parts = text.split(/(\*[^*]+\*|（[^）]+）|\([^)]+\))/);
  return parts.map((seg, i) => {
    const isStar = seg.startsWith('*') && seg.endsWith('*') && seg.length > 2;
    const isBracket =
      (seg.startsWith('（') || seg.startsWith('(')) && (seg.endsWith('）') || seg.endsWith(')'));
    if (isStar || isBracket) {
      return (
        <span key={i} className={`${dimClass} italic`} style={{ fontSize: '0.85em' }}>
          {isStar ? seg.slice(1, -1) : seg}
        </span>
      );
    }
    return <span key={i}>{seg}</span>;
  });
}

export const SceneConversationScreen: React.FC<{ sessionId: string; onBack: () => void }> = ({
  sessionId,
  onBack,
}) => {
  const [lines, setLines] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [ending, setEnding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [quotingMsg, setQuotingMsg] = useState<QuoteMsg | null>(null);
  // 心声：当前展开心声的气泡 id（点击 ⚡心声 切换展开/收起）
  const [showInternal, setShowInternal] = useState<string | null>(null);
  const [showEndModal, setShowEndModal] = useState(false);
  // 当前地点名（顶栏中间显示）；移动后随 SSE done 实时更新
  const [locationName, setLocationName] = useState('约会');
  // 当前地点背景图文件名（uploads/）；空 = 无背景
  const [background, setBackground] = useState('');
  // 好友状态：characterId → 是否好友（角色名旁显示加好友按钮/对钩）
  const [friendMap, setFriendMap] = useState<Record<string, boolean>>({});
  const [addingFriend, setAddingFriend] = useState<Record<string, boolean>>({});
  // 角色名 → characterId（SSE 新气泡只带名字，需反查 id 用于加好友）
  const [idByName, setIdByName] = useState<Record<string, string>>({});
  // 角色名 → 头像文件名（气泡说话人旁的头像）
  const [avatarByName, setAvatarByName] = useState<Record<string, string>>({});
  // 主角（同行者）characterId 集合：仅主角显示加好友按钮；路过打酱油的路人不显示
  const [mainCharIds, setMainCharIds] = useState<Set<string>>(new Set());

  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);
  const lastBeatRef = useRef(0); // 上一拍上屏时间戳，用于最小间隔
  const [kbH, setKbH] = useState(0); // 软键盘高度（visualViewport 与布局视口差值）

  const nextId = useCallback(() => `l${++idRef.current}`, []);

  const inputDraftKey = (sessionId: string) => `sc-conv-draft-${sessionId}`;
  const sceneCacheKey = (sessionId: string) => `sc-conv-cache-${sessionId}`;

  /** 在光标位置插入一对全角括号，光标停在括号中间 */
  const insertBrackets = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? input.length;
    const end = el.selectionEnd ?? input.length;
    const newText = input.slice(0, start) + '（）' + input.slice(end);
    setInput(newText);
    // 滚动到最新消息（防止手机软键盘顶起时输入框/最新消息被遮挡）
    const msgEl = messagesRef.current;
    if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
    // 同步聚焦：移动端程序化 focus 需在用户手势的同步调用栈内才会弹软键盘
    el.focus();
    // 光标停在括号中间（等 React 渲染更新 value 后再设 selection）
    requestAnimationFrame(() => {
      el.setSelectionRange(start + 1, start + 1);
    });
  }, [input]);

  // 逐拍显示（真实流式节奏 + 均匀节拍）：后端每生成完一拍即推，收到就上屏。
  const BEAT_MS = 600;
  const appendBeat = useCallback(
    async (b: Beat) => {
      const now = Date.now();
      const elapsed = now - lastBeatRef.current;
      if (lastBeatRef.current && elapsed < BEAT_MS) {
        await sleep(BEAT_MS - elapsed);
      }
      lastBeatRef.current = Date.now();
      const isNarration = b.kind === 'narration';
      setLines((prev) => [
        ...prev,
        {
          id: nextId(),
          kind: isNarration ? 'narration' : 'character',
          speaker: isNarration ? undefined : b.speaker ?? '角色',
          characterId: b.characterId,
          content: b.content,
          time: Date.now(),
          quote: null,
          internal: isNarration ? '' : b.internal ?? '',
          internalNotable: !isNarration && !!b.internalNotable,
        },
      ]);
    },
    [nextId],
  );

  /** 执行一次 SSE 流并据 done 更新地点/背景 */
  const runStream = async (path: string, body: string): Promise<StreamDone | null> => {
    const done = await streamPost<StreamDone>(path, body, async (evt) => {
      if (evt.type === 'beat' && evt.beat) await appendBeat(evt.beat);
    });
    if (done?.locationName) setLocationName(done.locationName);
    if (done?.locationBackground) setBackground(done.locationBackground);
    return done;
  };

  // 应用 GET 数据（历史 / 对账）
  const applyData = (data: SceneData) => {
    setLines(data.messages.map(toLine));
    if (data.locationName) setLocationName(data.locationName);
    if (data.locationBackground) setBackground(data.locationBackground);
    const nameMap: Record<string, string> = {};
    const avMap: Record<string, string> = {};
    const fm: Record<string, boolean> = {};
    const mainIds = new Set<string>();
    for (const p of data.participants ?? []) {
      nameMap[p.name] = p.characterId;
      if (p.avatar) avMap[p.name] = p.avatar;
      fm[p.characterId] = !!p.isFriend;
      mainIds.add(p.characterId);
    }
    for (const m of data.messages) {
      if (m.role !== 'player' && m.character_id && m.character_name) {
        nameMap[m.character_name] = m.character_id;
      }
    }
    setIdByName(nameMap);
    setAvatarByName(avMap);
    setFriendMap(fm);
    setMainCharIds(mainIds);
  };

  // 加载历史；新场景自动生成开场（round===0 且无消息时推进一次）
  useEffect(() => {
    let cancelled = false;

    try {
      const cached = sessionStorage.getItem(sceneCacheKey(sessionId));
      if (cached) {
        applyData(JSON.parse(cached) as SceneData);
        setLoading(false);
      }
    } catch { /* 缓存损坏：忽略，走正常加载 */ }

    (async () => {
      try {
        const res = await fetch(`/v4/api/scene-named/${sessionId}`);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as SceneData;
        if (cancelled) return;
        applyData(data);
        try { sessionStorage.setItem(sceneCacheKey(sessionId), JSON.stringify(data)); } catch { /* quota */ }
        setLoading(false);
        if (data.round === 0 && data.messages.length === 0) {
          setSending(true);
          await runStream(`/v4/api/scene-named/${sessionId}/advance`, JSON.stringify({ message: undefined, quote: undefined }));
          if (!cancelled) setSending(false);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 输入框草稿：切页/刷新回来自动恢复
  useEffect(() => {
    try {
      const saved = localStorage.getItem(inputDraftKey(sessionId));
      if (saved) setInput(saved);
    } catch { /* storage 不可用时静默忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 滚动到最新：直接操作容器 scrollTop=scrollHeight（钉到底）
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, sending]);

  // 软键盘高度：用 visualViewport 与布局视口的差值估算，键盘弹出时抬高输入栏（不改 viewport meta，避免页面整体跳动）
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const h = Math.max(0, Math.round(window.innerHeight - vv.height));
      setKbH(h);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  const handleSend = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || sending || retrying) return;
    setError('');
    const quote = quotingMsg
      ? { quoteId: quotingMsg.id, quoteText: quotingMsg.text, quoteSenderName: quotingMsg.senderName }
      : undefined;
    const playerLine: Bubble = {
      id: nextId(),
      kind: 'player',
      speaker: '我',
      content: text,
      time: Date.now(),
      quote: quote ?? null,
      internal: '',
      internalNotable: false,
    };
    setLines((prev) => [...prev, playerLine]);
    setInput('');
    try { localStorage.removeItem(inputDraftKey(sessionId)); } catch { /* ignore */ }
    setQuotingMsg(null);
    try {
      setSending(true);
      await runStream(`/v4/api/scene-named/${sessionId}/advance`, JSON.stringify({ message: text, quote }));
      setSending(false);
    } catch (e) {
      setSending(false);
      // 失败/流中断：先与后端真值对账，确未落库才删玩家行并放回输入框
      try {
        const res = await fetch(`/v4/api/scene-named/${sessionId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SceneData;
        setLines(data.messages.map(toLine));
        try { sessionStorage.setItem(sceneCacheKey(sessionId), JSON.stringify(data)); } catch { /* quota */ }
        setError((e as Error).message);
      } catch {
        setLines((prev) => prev.filter((l) => l !== playerLine));
        setInput(text);
        try { localStorage.setItem(inputDraftKey(sessionId), text); } catch { /* ignore */ }
        setError((e as Error).message);
      }
    }
  };

  const handleContinue = async () => {
    if (sending || retrying) return;
    setError('');
    try {
      setSending(true);
      await runStream(`/v4/api/scene-named/${sessionId}/continue`, '{}');
      setSending(false);
    } catch (e) {
      setSending(false);
      setError((e as Error).message);
    }
  };

  const handleRetry = async () => {
    if (retrying || sending) return;
    setRetrying(true);
    setError('');
    try {
      // 先回退到上一次状态：删掉被重试的那一轮内容。
      setLines((prev) => {
        const lastPlayerIdx = [...prev].reverse().findIndex((l) => l.kind === 'player');
        if (lastPlayerIdx < 0) return []; // 开场/尚无玩家发言：清空回到起始
        const keep = prev.length - lastPlayerIdx; // 保留到最后一个玩家发言（含）
        return prev.slice(0, keep);
      });
      setSending(true);
      await runStream(`/v4/api/scene-named/${sessionId}/retry`, '{}');
      setSending(false);
    } catch (e) {
      setSending(false);
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  const handleUndo = async () => {
    if (sending || retrying) return;
    setError('');
    try {
      await postJson(`/v4/api/scene-named/${sessionId}/undo`);
      const res = await fetch(`/v4/api/scene-named/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SceneData;
      setLines(data.messages.map(toLine));
      try { sessionStorage.setItem(sceneCacheKey(sessionId), JSON.stringify(data)); } catch { /* quota */ }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopiedId(text);
        setTimeout(() => setCopiedId(null), 1500);
      })
      .catch(() => {
        setCopiedId(text);
        setTimeout(() => setCopiedId(null), 1500);
      });
  };

  const handleQuote = (l: Bubble) => {
    setQuotingMsg({
      id: l.id,
      text: l.content,
      senderName: l.speaker === '我' ? '我' : l.speaker ?? '角色',
    });
    inputRef.current?.focus();
  };

  const handleEnd = async () => {
    if (ending) return;
    setEnding(true);
    try {
      await postJson(`/v4/api/scene-named/${sessionId}/end`);
      onBack();
    } catch (e) {
      setError((e as Error).message);
      setEnding(false);
    }
  };

  // 加好友：点角色名旁的 + 按钮（add-friend 端点仍在 /scene/ 下）
  const handleAddFriend = async (characterId: string) => {
    if (!characterId || addingFriend[characterId]) return;
    setAddingFriend((prev) => ({ ...prev, [characterId]: true }));
    try {
      await postJson(`/v4/api/scene/character/${characterId}/add-friend`);
      setFriendMap((prev) => ({ ...prev, [characterId]: true }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAddingFriend((prev) => ({ ...prev, [characterId]: false }));
    }
  };

  const resolveAvatar = (speaker?: string): string | undefined => {
    if (!speaker) return undefined;
    const av = avatarByName[speaker];
    if (av) return imageUrl(av);
    return getAnimeMaleAvatar(speaker);
  };

  // 操作栏判定：以消息列表为准——最后一个角色/旁白气泡标注重试/继续，最后一个玩家气泡标注撤回
  const lastNonPlayerIdx = [...lines].reverse().findIndex((l) => l.kind !== 'player');
  const lastNonPlayerGlobal = lastNonPlayerIdx >= 0 ? lines.length - 1 - lastNonPlayerIdx : -1;
  const lastPlayerIdx = [...lines].reverse().findIndex((l) => l.kind === 'player');
  const lastPlayerGlobal = lastPlayerIdx >= 0 ? lines.length - 1 - lastPlayerIdx : -1;

  const isRoundLast = (idx: number, l: Bubble) => l.kind !== 'player' && idx === lastNonPlayerGlobal;

  // 一拍多气泡分组：当前气泡是否紧跟着同一说话者的上一个气泡（中间无旁白/他人/玩家）
  const isGroupContinuation = (idx: number, l: Bubble) => {
    if (idx <= 0) return false;
    const prev = lines[idx - 1];
    return (
      !!prev &&
      prev.kind !== 'narration' &&
      prev.kind !== 'player' &&
      !!prev.speaker &&
      prev.speaker === l.speaker
    );
  };

  // 是否显示小时间戳：与上一次显示过时间戳的气泡时间差超过阈值（或首条）才显示
  const TIME_DIVIDER_MS = 60_000;
  const showRoundTime = (idx: number, l: Bubble) => {
    if (!l.time) return false;
    for (let i = idx - 1; i >= 0; i--) {
      const p = lines[i];
      if (p && p.time != null) {
        return l.time - p.time >= TIME_DIVIDER_MS;
      }
    }
    return true;
  };

  const showTyping = sending || retrying;

  return (
    <div className="relative h-full flex flex-col overflow-hidden bg-bg-soft">
      {/* 地点背景（可选） */}
      {background && (
        <>
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${imageUrl(background)})` }}
            aria-hidden
          />
          <div className="absolute inset-0 bg-bg-soft" aria-hidden />
        </>
      )}

      {/* 顶栏 */}
      <header className="relative px-3.5 py-2.5 flex items-center justify-between shrink-0 sticky top-0 z-30 bg-bg-soft backdrop-blur-md border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="p-1 -ml-1 text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
            aria-label="返回"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-[15px] font-bold text-ink tracking-tight">约会</h1>
        </div>
        <span key={locationName} className="text-[11px] text-ink-muted truncate max-w-[140px]">
          {locationName}
        </span>
        <button
          onClick={() => setShowEndModal(true)}
          disabled={ending}
          className="px-3 py-1 rounded-full bg-solid/90 text-solid-contrast text-[11px] font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer disabled:opacity-50 shrink-0"
        >
          {ending ? '…' : '结束'}
        </button>
      </header>

      {/* 消息流 */}
      <div ref={messagesRef} className="relative flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {loading ? (
          <div className="text-center text-ink-muted text-xs py-10">场景开场中…</div>
        ) : lines.length === 0 ? (
          <div className="flex flex-col items-center gap-1 text-center text-ink-muted py-10">
            <span className="text-xl">🎬</span>
            <span className="text-xs">约会开始</span>
          </div>
        ) : (
          lines.map((l, idx) => (
            <div key={l.id}>
              {showRoundTime(idx, l) && (
                <div className="text-center text-[10px] text-ink-faint mb-2">{formatTime(l.time!)}</div>
              )}

              {/* 旁白：居中一条条出 */}
              {l.kind === 'narration' ? (
                <div className="flex flex-col items-center gap-1.5">
                  <div className="flex items-center gap-2 w-full max-w-[94%]">
                    <div className="flex-1 h-px bg-solid/10" />
                    <div className="text-[12.5px] text-ink-muted leading-relaxed text-center">
                      {renderText(l.content)}
                    </div>
                    <div className="flex-1 h-px bg-solid/10" />
                  </div>
                  {isRoundLast(idx, l) && !sending && !retrying && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleContinue}
                        disabled={sending}
                        className="px-3 py-0.5 rounded-full bg-solid text-solid-contrast text-[11px] font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer"
                      >
                        继续
                      </button>
                      <button
                        onClick={handleRetry}
                        disabled={retrying}
                        className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                      >
                        重试
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div
                    className={`flex ${l.kind === 'player' ? 'justify-end' : 'justify-start'} items-start gap-2`}
                  >
                    {/* NPC 头像（同拍同一说话者只显示第一个，连续气泡头像列留空，不渲染空灰圈——对齐 v2/v3） */}
                    {l.kind !== 'player' && (
                      <div className="w-8 shrink-0 flex items-start">
                        {!isGroupContinuation(idx, l) && (
                          <div className="w-8 h-8 rounded-full overflow-hidden border border-border-dark/5 flex items-center justify-center text-[13px] font-bold bg-bg-soft text-cyan shrink-0">
                            {(() => {
                              const src = resolveAvatar(l.speaker);
                              return src ? (
                                <img src={src} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              ) : (
                                l.speaker ? l.speaker.charAt(0) : '?'
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}

                    <div className={`flex flex-col ${l.kind === 'player' ? 'items-end' : 'items-start'} max-w-[78%] min-w-0`}>
                      {/* 说话者名 + 加好友 */}
                      {l.kind !== 'player' && l.speaker && !isGroupContinuation(idx, l) && (
                        <div className="flex items-center gap-1.5 pl-0.5 mb-1">
                          <span className="text-xs font-bold text-ink/90">{l.speaker}</span>
                          {(() => {
                            const cid = l.characterId || (l.speaker ? idByName[l.speaker] : undefined);
                            if (!cid || !mainCharIds.has(cid)) return null;
                            return friendMap[cid] ? (
                              <span className="text-[10px] text-rose font-semibold" title="已加好友">
                                ✓ 好友
                              </span>
                            ) : (
                              <button
                                onClick={() => handleAddFriend(cid)}
                                disabled={addingFriend[cid]}
                                title="加好友"
                                className="px-1.5 py-0.5 rounded-full bg-bg-soft border border-border text-[10px] text-cyan font-medium hover:bg-bg-soft transition cursor-pointer active:scale-95 disabled:opacity-60"
                              >
                                {addingFriend[cid] ? '…' : '＋好友'}
                              </button>
                            );
                          })()}
                        </div>
                      )}

                      {/* 气泡 */}
                      <div
                        className={`px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                          l.kind === 'player'
                            ? 'bg-solid text-solid-contrast rounded-2xl rounded-tr-sm'
                            : 'bg-bg-muted backdrop-blur-md rounded-2xl rounded-tl-sm border border-border text-ink shadow-xs'
                        }`}
                      >
                        {l.quote && l.quote.quoteText && (
                          <div
                            className={`mb-1.5 px-2 py-1 rounded-lg text-[11px] ${
                              l.kind === 'player'
                                ? 'bg-bg-soft/15 text-white/80'
                                : 'bg-bg-muted text-ink-muted'
                            }`}
                          >
                            <span className="font-semibold">{l.quote.quoteSenderName ?? '引用'}：</span>
                            <span>
                              {l.quote.quoteText.slice(0, 50)}
                              {l.quote.quoteText.length > 50 ? '…' : ''}
                            </span>
                          </div>
                        )}
                        {renderText(l.content, l.kind === 'player' ? 'text-solid-contrast/65' : 'text-ink-muted/70')}
                      </div>
                    </div>
                  </div>

                  {/* 操作栏：复制/引用；每轮最后一条加继续/重试；玩家最后一条加撤回 */}
                  <div
                    className={`flex items-center gap-1.5 mt-1 ${
                      l.kind === 'player' ? 'justify-end pr-0.5' : 'justify-start pl-10'
                    }`}
                  >
                    <button
                      onClick={() => handleCopy(l.content)}
                      className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink-muted transition cursor-pointer"
                    >
                      {copiedId === l.content ? '✓ 已复制' : '复制'}
                    </button>
                    <button
                      onClick={() => handleQuote(l)}
                      className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink-muted transition cursor-pointer"
                    >
                      引用
                    </button>
                    {isRoundLast(idx, l) && !sending && !retrying && (
                      <>
                        <button
                          onClick={handleContinue}
                          disabled={sending}
                          className="px-2.5 py-0.5 rounded-full bg-solid text-solid-contrast text-[11px] font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer"
                        >
                          继续
                        </button>
                        <button
                          onClick={handleRetry}
                          disabled={retrying}
                          className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                        >
                          重试
                        </button>
                      </>
                    )}
                    {l.kind === 'player' && idx === lastPlayerGlobal && !sending && !retrying && (
                      <button
                        onClick={handleUndo}
                        disabled={sending}
                        className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-rose hover:text-ink-on text-[11px] text-ink transition cursor-pointer"
                      >
                        撤回
                      </button>
                    )}
                  </div>

                  {/* 内心独白（心声）：与台词区分开，小号斜体 + 玫红色卡片（与台词气泡同宽对齐） */}
                  {l.kind !== 'player' && l.internal && l.internalNotable && (
                    <div className="flex flex-col items-start gap-1 mt-1">
                      <button
                        onClick={() => setShowInternal(showInternal === l.id ? null : l.id)}
                        className="ml-10 px-2 py-0.5 rounded-lg bg-chat-pink-border/20 text-rose text-[11px] font-bold cursor-pointer transition active:scale-95"
                      >
                        ⚡ {showInternal === l.id ? '收起心声' : '心声'}
                      </button>
                      {showInternal === l.id && (
                        <div className="ml-10 max-w-[78%] bg-chat-pink-bg/90 backdrop-blur-md border border-chat-pink-border/40 rounded-2xl px-3 py-2.5 text-[12px] italic leading-relaxed text-rose">
                          {renderText(l.internal)}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ))
        )}

        {showTyping && (
          <div className="flex items-center gap-1 pl-10 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-solid animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-solid animate-pulse [animation-delay:-0.15s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-solid animate-pulse [animation-delay:-0.3s]" />
          </div>
        )}
      </div>

      {error && (
        <div className="relative shrink-0 px-3 py-1.5 text-[11px] text-rose bg-rose/10 border-b border-rose/20">
          {error}
        </div>
      )}

      {/* 底部输入栏（预留 dock 高度 81px + 软键盘高度，键盘弹出时输入框上移到键盘上方） */}
      <footer
        className="relative shrink-0 sticky bottom-0 z-20 bg-bg-soft backdrop-blur-md border-t border-border"
        style={{ paddingBottom: `calc(81px + ${kbH}px)` }}
      >
        {quotingMsg && (
          <div className="flex items-center gap-2 px-3 pt-2">
            <div className="flex-1 min-w-0 bg-bg-input rounded-xl px-3 py-1.5 text-[11px]">
              <span className="text-ink-faint">{quotingMsg.senderName}：</span>
              <span className="text-ink-soft">
                {quotingMsg.text.slice(0, 50)}
                {quotingMsg.text.length > 50 ? '…' : ''}
              </span>
            </div>
            <button
              onClick={() => setQuotingMsg(null)}
              className="text-ink-faint hover:text-ink transition cursor-pointer"
              aria-label="取消引用"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center gap-1.5 px-2.5 pt-2">
          <button
            onClick={insertBrackets}
            disabled={sending}
            title="插入括号"
            className="w-9 h-9 rounded-full bg-black/[0.04] border border-border-dark/5 flex items-center justify-center text-sm font-semibold text-ink hover:bg-black/[0.08] transition cursor-pointer shrink-0 disabled:opacity-50"
          >
            （）
          </button>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              const v = e.target.value;
              setInput(v);
              try { localStorage.setItem(inputDraftKey(sessionId), v); } catch { /* ignore */ }
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="你想做什么？"
            disabled={sending}
            className="h-10 flex-1 rounded-full bg-bg-muted backdrop-blur-xl border border-border-strong px-4 text-[13px] text-ink placeholder:text-ink-muted outline-none focus:bg-bg-soft transition"
          />
          <button
            onClick={() => handleSend()}
            disabled={sending || !input.trim()}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition active:scale-95 shrink-0 cursor-pointer ${
              input.trim() && !sending
                ? 'bg-solid text-solid-contrast shadow-sm'
                : 'bg-solid-soft text-solid-contrast cursor-not-allowed'
            }`}
            aria-label="发送"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </footer>

      {/* 结束约会确认弹窗 */}
      {showEndModal && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-6"
          onClick={() => setShowEndModal(false)}
        >
          <div
            className="w-full max-w-[320px] bg-panel rounded-2xl p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-bold text-ink">结束约会？</div>
            <div className="text-xs text-ink-muted mt-2 leading-relaxed">
              结束后这段约会将被收尾归档，你可以随时再发起下一次。
            </div>
            <div className="flex flex-col gap-2 mt-4">
              <button
                onClick={handleEnd}
                disabled={ending}
                className="py-2.5 rounded-xl bg-rose text-ink-on text-sm font-semibold hover:opacity-90 transition active:scale-[0.98] cursor-pointer disabled:opacity-60"
              >
                {ending ? '结束中…' : '确认结束'}
              </button>
              <button
                onClick={() => setShowEndModal(false)}
                disabled={ending}
                className="py-2.5 rounded-xl bg-bg-soft border border-border text-ink text-sm font-medium hover:bg-bg-soft transition active:scale-[0.98] cursor-pointer disabled:opacity-60"
              >
                继续约会
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
