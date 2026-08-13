import { useState, useEffect, useRef, useCallback } from 'react';
import { api, imageUrl } from '../lib/api';
import type { SceneBeat } from '../lib/api';
import { renderTextWithActions } from '../lib/text-render';
import { CharacterEditModal } from '../components/CharacterEditModal';

interface Line {
  id: string;
  kind: 'narration' | 'character' | 'player';
  speaker?: string;
  characterId?: string;
  content: string;
  round_no?: number;
  /** 该气泡生成时刻（毫秒）。历史消息用后端 created_at，新生成用上屏时 wall-clock。 */
  time?: number;
  quote?: { quoteId?: string; quoteText?: string; quoteSenderName?: string } | null;
  /** 心声（内心独白）：仅 character 且 internalNotable=true 时前端显示 ⚡心声 按钮 */
  internal?: string;
  internalNotable?: boolean;
}

interface QuoteMsg {
  id: string;
  text: string;
  senderName: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 把毫秒时间戳格式化为 HH:MM（本地时区） */
const formatTime = (ms: number) => {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

/** 输入框草稿的 localStorage key（按会话隔离，切页/刷新后恢复，不必重打） */
const inputDraftKey = (sessionId: string) => `sc-conv-draft-${sessionId}`;

/** 场景缓存 key（按会话隔离，打开时即时恢复，再后台静默拉最新） */
const sceneCacheKey = (sessionId: string) => `sc-conv-cache-${sessionId}`;

/** 把后端消息行映射为前端 Line */
function toLine(m: { id?: string; round_no?: number; role: string; character_id?: string | null; character_name: string; text: string; quote?: string | null; internal?: string | null; internal_notable?: number | boolean | null; created_at?: number | string | null }): Line {
  let quote: Line['quote'] = null;
  if (m.quote) {
    try { quote = JSON.parse(m.quote); } catch { quote = null; }
  }
  const kind = m.role === 'player' ? 'player' as const : m.role === 'narration' ? 'narration' as const : 'character' as const;
  const ts = typeof m.created_at === 'number' ? m.created_at
    : typeof m.created_at === 'string' ? Number(m.created_at)
    : undefined;
  return {
    id: m.id ?? `${kind}-${m.character_name}-${m.text}`,
    kind,
    speaker: kind === 'narration' ? undefined : (m.character_name || (kind === 'player' ? '我' : '角色')),
    characterId: m.character_id ?? undefined,
    content: m.text,
    round_no: m.round_no,
    time: ts && !Number.isNaN(ts) ? ts : undefined,
    quote,
    internal: kind === 'character' ? (m.internal ?? '') : '',
    internalNotable: kind === 'character' ? !!m.internal_notable : false,
  };
}

/**
 * 场景对话页 —— 剧本式：旁白居中一条条出，角色台词气泡。
 * 支持：每个气泡复制/引用；每轮最后一个气泡重试/继续；玩家最后一个气泡撤回；结束约会。
 * 底层走新场景引擎 /scene。
 */
export function SceneConversation({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
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
  const [directorPlan, setDirectorPlan] = useState<{ kind: string; speaker?: string; intent: string; type?: string; to?: string; query?: string }[] | null>(null);
  // 当前地点名（顶栏中间显示；约会名左边）。move 后实时更新。
  const [locationName, setLocationName] = useState('约会');
  // 当前地点背景图文件名（uploads/，经 imageUrl 访问）；随 effLocId 联动，换地点换背景。空 = 无背景
  const [background, setBackground] = useState('');
  // 好友状态：characterId → 是否好友（角色名旁显示加好友按钮/对钩）
  const [friendMap, setFriendMap] = useState<Record<string, boolean>>({});
  // 正在编辑人设的角色 id（点角色名打开）
  const [editCharacterId, setEditCharacterId] = useState<string | null>(null);
  const [addingFriend, setAddingFriend] = useState<Record<string, boolean>>({});
  // 角色名 → characterId（SSE 新气泡只带名字，需反查 id 用于加好友/编辑）
  const [idByName, setIdByName] = useState<Record<string, string>>({});
  // 角色名 → 头像文件名（气泡说话人旁的头像）
  const [avatarByName, setAvatarByName] = useState<Record<string, string>>({});
  // 主角（同行者）characterId 集合：仅主角显示加好友按钮；路过打酱油的路人不显示
  const [mainCharIds, setMainCharIds] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const lastBeatRef = useRef(0); // 上一拍上屏时间戳，用于最小间隔

  const nextId = useCallback(() => `l${++idRef.current}`, []);

  /** 在光标位置插入一对全角括号，光标停在括号中间 */
  const insertBrackets = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? input.length;
    const end = el.selectionEnd ?? input.length;
    const newText = input.slice(0, start) + '（）' + input.slice(end);
    setInput(newText);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + 1, start + 1);
    });
  }, [input]);


  // 逐拍显示（真实流式节奏 + 均匀节拍）：后端每生成完一拍即推，收到就上屏。
  // 相邻两拍至少隔 BEAT_MS，让同一拍的多气泡（以及连发的各拍）以稳定节拍逐条上屏，
  // 不至于 LLM 生成太快时一屏全冒出来 / 后几个气泡一下子涌出。
  const BEAT_MS = 600;
  const appendBeat = useCallback(async (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => {
    const now = Date.now();
    const elapsed = now - lastBeatRef.current;
    if (lastBeatRef.current && elapsed < BEAT_MS) {
      await sleep(BEAT_MS - elapsed);
    }
    lastBeatRef.current = Date.now();
    const isNarration = b.kind === 'narration';
    setLines(prev => [...prev, {
      id: nextId(),
      kind: isNarration ? 'narration' : 'character',
      speaker: isNarration ? undefined : (b.speaker ?? '角色'),
      characterId: b.characterId,
      content: b.content,
      time: Date.now(), // 新生成气泡：用上屏时 wall-clock 作「气泡冒出来的时间」
      quote: null,
      internal: isNarration ? '' : (b.internal ?? ''),
      internalNotable: !isNarration && !!b.internalNotable,
    }]);
  }, [nextId]);

  // 加载历史；新场景自动生成开场
  useEffect(() => {
    let cancelled = false;

    // 从 sessionStorage 恢复缓存（即时显示，不等网络）
    const applyData = (data: { messages: any[]; locationName?: string; locationBackground?: string; participants?: any[]; round?: number }) => {
      setLines(data.messages.map(toLine));
      if (data.locationName) setLocationName(data.locationName);
      if (data.locationBackground) setBackground(data.locationBackground);
      const nameMap: Record<string, string> = {};
      const avMap: Record<string, string> = {};
      for (const p of data.participants ?? []) { nameMap[p.name] = p.characterId; if (p.avatar) avMap[p.name] = p.avatar; }
      for (const m of data.messages) if (m.role === 'npc' && m.character_id) nameMap[m.character_name] = m.character_id;
      setIdByName(nameMap);
      setAvatarByName(avMap);
      if (data.participants?.length) {
        const fm: Record<string, boolean> = {};
        for (const p of data.participants) { fm[p.characterId] = p.isFriend; mainCharIds.add(p.characterId); }
        setFriendMap(fm);
        setMainCharIds(new Set(mainCharIds));
      }
    };

    try {
      const cached = sessionStorage.getItem(sceneCacheKey(sessionId));
      if (cached) {
        applyData(JSON.parse(cached));
        setLoading(false); // 缓存恢复完毕，立即结束 loading
      }
    } catch { /* 缓存损坏：忽略，走正常加载 */ }

    (async () => {
      try {
        const data = await api.sceneGet(sessionId);
        if (cancelled) return;
        applyData(data);
        // 写缓存
        try { sessionStorage.setItem(sceneCacheKey(sessionId), JSON.stringify(data)); } catch { /* quota */ }
        // 有历史（重进约会）或已开场：立刻结束 loading
        setLoading(false);
        if (data.round === 0 && data.messages.length === 0) {
          // 开场流式生成：后端每拍生成完即推，收到即上屏
          setSending(true);
          setDirectorPlan(null);
          await api.sceneAdvanceStream(sessionId, undefined, undefined, async (b) => {
            if (!cancelled) await appendBeat(b);
          }, (beats) => {
            if (!cancelled) setDirectorPlan(beats);
          }).then((done) => {
            if (!cancelled && done && (done as any).locationName) setLocationName((done as any).locationName);
            if (!cancelled && done && (done as any).locationBackground) setBackground((done as any).locationBackground);
          });
          if (!cancelled) setSending(false);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 输入框草稿：切页/刷新回来自动恢复（问题2：输入栏缓存）
  useEffect(() => {
    try {
      const saved = localStorage.getItem(inputDraftKey(sessionId));
      if (saved) setInput(saved);
    } catch { /* storage 不可用时静默忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // 滚动到最新：直接操作容器 scrollTop=scrollHeight（钉到底），刷新/新消息后立即看到最新
  // （不用 scrollIntoView smooth，避免"从头往下滚"的视觉——问题1）
  useEffect(() => {
    // 内容有更新时定位到最新；用 requestAnimationFrame 保证在 DOM 更新后执行
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, sending]);

  const handleSend = async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || sending || retrying) return;
    setError('');
    const quote = quotingMsg ? { quoteId: quotingMsg.id, quoteText: quotingMsg.text, quoteSenderName: quotingMsg.senderName } : undefined;
    const playerLine: Line = { id: nextId(), kind: 'player', speaker: '我', content: text, time: Date.now(), quote: quote ?? null };
    setLines(prev => [...prev, playerLine]);
    setInput('');
    // 清空输入草稿（发送的内容已上屏，无需再留在输入框）
    try { localStorage.removeItem(inputDraftKey(sessionId)); } catch { /* ignore */ }
    setQuotingMsg(null);
    try {
      setSending(true);
      setDirectorPlan(null);
      const done = await api.sceneAdvanceStream(sessionId, text, quote, async (b) => await appendBeat(b), (beats) => setDirectorPlan(beats));
      if (done && (done as any).locationName) setLocationName((done as any).locationName);
      if (done && (done as any).locationBackground) setBackground((done as any).locationBackground);
      setSending(false);
    } catch (e) {
      setSending(false);
      // 失败/流中断：不盲目删刚发的玩家行——先用后端真值对账（学 handleUndo 的 sceneGet 模式）。
      // 若后端其实已把这句玩家发言落库（SSE 中断不代表落库失败），对账后它仍在列表里；
      // 若确未落库，则从对账结果里自然消失，再把原文放回输入框让玩家重发，不丢输入。
      try {
        const data = await api.sceneGet(sessionId);
        setLines(data.messages.map(toLine));
        try { sessionStorage.setItem(sceneCacheKey(sessionId), JSON.stringify(data)); } catch { /* quota */ }
        setError((e as Error).message);
      } catch {
        setLines(prev => prev.filter(l => l !== playerLine));
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
      setDirectorPlan(null);
      const done = await api.sceneContinueStream(sessionId, async (b) => await appendBeat(b), (beats) => setDirectorPlan(beats));
      if (done && (done as any).locationName) setLocationName((done as any).locationName);
      if (done && (done as any).locationBackground) setBackground((done as any).locationBackground);
      setSending(false);
    } catch (e) {
      setSending(false);
      setError((e as Error).message);
    }
  };

  const handleRetry = async () => {
    if (retrying || sending) return;
    setRetrying(true); setError('');
    try {
      // 先回退到上一次状态：删掉被重试的那一轮内容。
      // 普通轮 = 删最后一个玩家发言之后的内容；开场轮（尚无玩家发言）= 全部清空。
      setLines(prev => {
        const lastPlayerIdx = [...prev].reverse().findIndex(l => l.kind === 'player');
        if (lastPlayerIdx < 0) return []; // 开场/尚无玩家发言：清空回到起始
        // reverse().findIndex 返回的是「从末尾数的偏移」；玩家消息在原始数组的下标是
        // prev.length - 1 - lastPlayerIdx。要保留到它（含），slice 的长度需 +1。
        const keep = prev.length - lastPlayerIdx; // 保留到最后一个玩家发言（含）
        return prev.slice(0, keep);
      });
      // 后端回退到该轮开始前并重新生成，每拍完成即逐条推给前端
      setSending(true);
      setDirectorPlan(null);
      const done = await api.sceneRetryStream(sessionId, async (b) => await appendBeat(b), (beats) => setDirectorPlan(beats));
      if (done && (done as any).locationName) setLocationName((done as any).locationName);
      if (done && (done as any).locationBackground) setBackground((done as any).locationBackground);
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
      await api.sceneUndo(sessionId);
      const data = await api.sceneGet(sessionId);
      setLines(data.messages.map(toLine));
      try { sessionStorage.setItem(sceneCacheKey(sessionId), JSON.stringify(data)); } catch { /* quota */ }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {
      // 兼容非安全上下文
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const handleQuote = (l: Line) => {
    setQuotingMsg({ id: l.id, text: l.content, senderName: l.speaker === '我' ? '我' : (l.speaker ?? '角色') });
    inputRef.current?.focus();
  };

  const handleEnd = async () => {
    if (ending) return;
    setEnding(true);
    try {
      await api.sceneEnd(sessionId);
      onBack();
    } catch (e) {
      setError((e as Error).message);
      setEnding(false);
    }
  };

  // 加好友：点角色名旁的 + 按钮
  const handleAddFriend = async (characterId: string) => {
    if (!characterId) return;
    if (addingFriend[characterId]) return;
    setAddingFriend(prev => ({ ...prev, [characterId]: true }));
    try {
      await api.sceneAddFriend(characterId);
      setFriendMap(prev => ({ ...prev, [characterId]: true }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAddingFriend(prev => ({ ...prev, [characterId]: false }));
    }
  };

  // 点角色名 → 打开人设编辑（私人 fork 实时编辑）
  const handleOpenEdit = (characterId?: string) => {
    if (characterId) setEditCharacterId(characterId);
  };

  // 判断操作栏：每个气泡都有复制/引用；每轮(round)最后一个气泡加重试/继续；玩家最后一个气泡加撤回
  // 简化：以消息列表为准——最后一个角色/旁白气泡标注重试/继续，最后一个玩家气泡标注撤回
  const lastNonPlayerIdx = [...lines].reverse().findIndex(l => l.kind !== 'player');
  const lastNonPlayerGlobal = lastNonPlayerIdx >= 0 ? lines.length - 1 - lastNonPlayerIdx : -1;
  const lastPlayerIdx = [...lines].reverse().findIndex(l => l.kind === 'player');
  const lastPlayerGlobal = lastPlayerIdx >= 0 ? lines.length - 1 - lastPlayerIdx : -1;
  // 每轮组（round_no）由后端落库 round 分组——但前端 lines 没有 round_no，改用"相邻非玩家块"分轮
  const isRoundLast = (idx: number, l: Line) => {
    if (l.kind === 'player') return false;
    // 该气泡是最后一个非玩家气泡
    return idx === lastNonPlayerGlobal;
  };

  // 一拍多气泡分组：当前气泡是否紧跟着同一说话者的上一个气泡（中间无旁白/他人/玩家）。
  // 用于「只有每拍第一个气泡显示名字」+「同拍气泡间距收紧」。
  const isGroupContinuation = (idx: number, l: Line) => {
    if (idx <= 0) return false;
    const prev = lines[idx - 1];
    // 同一说话者：prev 也是非玩家字符气泡，且 speaker 相同（玩家自己不会连续多条）
    return prev && prev.kind !== 'narration' && prev.kind !== 'player'
      && prev.speaker && prev.speaker === l.speaker;
  };

  // 是否显示小时间戳：与上一次显示过时间戳的气泡时间差超过阈值（或首条）才显示。
  // 不依赖 round_no——新实时生成的气泡没有 round_no，靠真实时间差自然分节。
  const TIME_DIVIDER_MS = 60_000; // 超过 1 分钟才再显示一次时间戳
  const showRoundTime = (idx: number, l: Line) => {
    if (!l.time) return false;
    // 从 idx 往回找最近一条已显示过时间戳（且带 time）的 line
    for (let i = idx - 1; i >= 0; i--) {
      const p = lines[i];
      if (p && p.time != null) {
        // 同一条（分组气泡）里只显示最上面那个：本轮与上一条时间戳相差不足阈值 → 不重复显示
        return (l.time - p.time) >= TIME_DIVIDER_MS;
      }
    }
    return true; // 前面没有任何带 time 的 line → 这是第一条，显示
  };

  const showTyping = sending || retrying;

  return (
    <div className="id-chat-view">
      {background && (
        <div
          className="id-chat-bg"
          style={{ backgroundImage: `url(${imageUrl(background)})` }}
          aria-hidden
        />
      )}
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">约会</span>
        {/* 地点名居中显示；移动时随 SSE done 实时更新 */}
        <span className="id-appbar-location" key={locationName}>{locationName}</span>
        <button className="id-appbar-action id-appbar-action-danger" onClick={() => setShowEndModal(true)} disabled={ending}>
          {ending ? '…' : '结束'}
        </button>
      </div>

      <div className="id-chat-messages" ref={messagesRef}>
        {loading ? (
          <div className="id-loading">场景开场中…</div>
        ) : lines.length === 0 ? (
          <div className="id-empty"><span>🎬</span><span>约会开始</span></div>
        ) : (
          lines.map((l, idx) => (
            <div key={l.id}>
              {showRoundTime(idx, l) && (
                <div className="id-bubble-time">{formatTime(l.time!)}</div>
              )}
              {l.kind === 'narration' ? (
                <div>
                  <div className="id-narration">
                    <div className="id-narration-line" />
                    <div className="id-narration-text">{renderTextWithActions(l.content)}</div>
                    <div className="id-narration-line" />
                  </div>
                  {isRoundLast(idx, l) && !sending && !retrying && (
                    <div className="id-bubble-actions id-bubble-actions-narr">
                      <button className="id-bubble-action-btn" onClick={handleContinue} disabled={sending}>继续</button>
                      <button className="id-bubble-action-btn" onClick={handleRetry} disabled={retrying}>重试</button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className={`id-bubble-row ${l.kind === 'player' ? 'player' : 'npc'} ${isGroupContinuation(idx, l) ? 'id-bubble-row-grouped' : ''}`}>
                    {l.kind !== 'player' && (
                      <div className="id-bubble-avatar-col">
                        {!isGroupContinuation(idx, l) && (() => {
                          const sp = l.speaker;
                          const spAv = sp ? (avatarByName[sp] || '') : '';
                          return (
                            <div className="id-bubble-chat-avatar">
                              {spAv ? <img src={imageUrl(spAv)} alt="" className="id-bubble-chat-avatar-img" /> : (sp ? sp.charAt(0) : '?')}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                    <div className="id-bubble-main">
                      {l.kind !== 'player' && l.speaker && !isGroupContinuation(idx, l) && (
                        <div className="id-bubble-speaker">
                          {/* 点名字 → 打开人设编辑（私人 fork） */}
                          <button
                            className="id-speaker-name"
                            onClick={() => handleOpenEdit(l.characterId ?? idByName[l.speaker!])}
                            title="查看/编辑人设"
                          >
                            {l.speaker}
                          </button>
                          {/* 加好友按钮 / 已好友对钩 —— 仅主角（同行者）显示；所在地打酱油的路人不加好友 */}
                          {(() => {
                            const cid = l.characterId ? l.characterId : (l.speaker ? idByName[l.speaker] : undefined);
                            if (!cid || !mainCharIds.has(cid)) return null;
                            return friendMap[cid] ? (
                              <span className="id-friend-check" title="已加好友">✓</span>
                            ) : (
                              <button
                                className="id-friend-add"
                                onClick={(e) => { e.stopPropagation(); handleAddFriend(cid); }}
                                disabled={addingFriend[cid]}
                                title="加好友"
                              >
                                {addingFriend[cid] ? '…' : '＋好友'}
                              </button>
                            );
                          })()}
                        </div>
                      )}
                      <div className={`id-bubble ${l.kind === 'player' ? 'player' : 'npc'}`}>
                        {l.quote && l.quote.quoteText && (
                          <div className="id-bubble-quote">
                            <span className="id-bubble-quote-name">{l.quote.quoteSenderName ?? '引用'}</span>
                            <span className="id-bubble-quote-text">{l.quote.quoteText.slice(0, 50)}{l.quote.quoteText.length > 50 ? '…' : ''}</span>
                          </div>
                        )}
                        {renderTextWithActions(l.content)}
                      </div>
                    </div>
                  </div>
                  <div className="id-bubble-actions">
                    <button className="id-bubble-action-btn" onClick={() => handleCopy(l.content)}>
                      {copiedId === l.content ? '✓ 已复制' : '复制'}
                    </button>
                    <button className="id-bubble-action-btn" onClick={() => handleQuote(l)}>引用</button>
                    {isRoundLast(idx, l) && !sending && !retrying && (
                      <>
                        <button className="id-bubble-action-btn" onClick={handleContinue} disabled={sending}>继续</button>
                        <button className="id-bubble-action-btn" onClick={handleRetry} disabled={retrying}>重试</button>
                      </>
                    )}
                    {l.kind === 'player' && idx === lastPlayerGlobal && !sending && !retrying && (
                      <button className="id-bubble-action-btn id-bubble-action-danger" onClick={handleUndo} disabled={sending}>撤回</button>
                    )}
                  </div>
                  {l.kind !== 'player' && l.internal && l.internalNotable && (
                    <div>
                      <button className="id-internal-btn" onClick={() => setShowInternal(showInternal === l.id ? null : l.id)}>
                        ⚡ {showInternal === l.id ? '收起心声' : '心声'}
                      </button>
                      {showInternal === l.id && <div className="id-internal-text">{renderTextWithActions(l.internal)}</div>}
                    </div>
                  )}
                </>
              )}
            </div>
          ))
        )}
        {showTyping && <div className="id-typing-dots"><span /><span /><span /></div>}
        <div ref={endRef} />
      </div>

      {error && <div className="id-error-text">{error}</div>}

      <div className="id-chat-input-area">
        {quotingMsg && (
          <div className="id-quote-preview-bar">
            <div className="id-quote-preview-content">
              <span className="id-quote-preview-name">{quotingMsg.senderName}</span>
              <span className="id-quote-preview-text">{quotingMsg.text.slice(0, 50)}{quotingMsg.text.length > 50 ? '…' : ''}</span>
            </div>
            <button className="id-quote-preview-close" onClick={() => setQuotingMsg(null)}>✕</button>
          </div>
        )}
        <button className="id-chat-bracket-btn" onClick={insertBrackets} disabled={sending} title="插入括号">
          （）
        </button>
        <input
          ref={inputRef}
          className="id-chat-input"
          type="text"
          value={input}
          onChange={e => {
            const v = e.target.value;
            setInput(v);
            // 每次输入即持久化草稿（问题2：切页回来不用重打）
            try { localStorage.setItem(inputDraftKey(sessionId), v); } catch { /* ignore */ }
          }}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="你想做什么？"
          disabled={sending}
        />
        <button className="id-chat-send-btn" onClick={() => handleSend()} disabled={sending || !input.trim()}>➤</button>
      </div>

      {showEndModal && (
        <div className="id-modal-overlay" onClick={() => setShowEndModal(false)}>
          <div className="id-modal" onClick={(e) => e.stopPropagation()}>
            <div className="id-modal-title">结束约会？</div>
            <div className="id-modal-desc">结束后这段约会将被收尾归档，你可以随时再发起下一次。</div>
            <div className="id-modal-actions">
              <button className="id-btn danger" onClick={handleEnd} disabled={ending}>
                {ending ? '结束中…' : '确认结束'}
              </button>
              <button className="id-btn" onClick={() => setShowEndModal(false)} disabled={ending}>
                继续约会
              </button>
            </div>
          </div>
        </div>
      )}
      {editCharacterId && (
        <CharacterEditModal
          characterId={editCharacterId}
          onClose={() => setEditCharacterId(null)}
        />
      )}
    </div>
  );
}
