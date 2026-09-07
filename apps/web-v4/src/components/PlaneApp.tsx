import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, Trash2, Globe, Globe2, Heart, X, Send, RotateCcw } from 'lucide-react';
import { api, imageUrl, type PlaneCharacter, type PlanePoolItem, type PlaneSessionSummary } from '../lib/api';
import { CapsuleField } from './CapsuleField';
import { toLine, beatToLine, renderText, sleep, type Bubble } from '../lib/plane-chat-utils';

/**
 * 位面任务主应用 —— 挂载于「设置-实验功能」入口。
 * 三页签：任务大厅（公共池 swipe 卡片流）/ 任务列表（进行中 & 历史）/ 我的角色（建卡 + 发布管理）。
 * 玩家左右滑看上下张，点卡片进聊天（复用场景对话 UI + 角色图背景）。
 */

type Tab = 'hall' | 'missions' | 'mine';

// 大厅快聊：当前活跃会话缓存（与「进入位面」共享同一会话）
type HallChat = {
  planeCharacterId: string;
  sessionId: string;
  lines: Bubble[];
  characterName: string;
  avatar: string;
};

// 性别枚举 → 中文显示（与主城人设卡对齐：male/female/空；旧自由文本原样兜底）
const genderLabel = (g?: string) => (g === 'male' ? '男' : g === 'female' ? '女' : g || '');

// 位面建卡表单胶囊输入框样式（对齐主城人设卡 CapsuleField）
const planeLabelCls = 'text-[12px] font-semibold text-ink';
const planeAreaCls = 'w-full rounded-xl bg-bg-muted border border-border px-3 py-2 text-[13px] text-ink outline-none focus:bg-bg-soft transition';

export const PlaneApp: React.FC<{ onBack?: () => void; onModalChange?: (open: boolean) => void; onThinPaper?: (open: boolean) => void }> = ({ onBack, onModalChange, onThinPaper }) => {
  const [tab, setTab] = useState<Tab>('hall');
  const [error, setError] = useState('');

  // 大厅快聊：会话缓存 + 逐拍气泡（与「进入位面」共享同一会话）
  // 多会话：按角色缓存（key=planeCharacterId），切角色接回上一段而非新建
  const [hallChat, setHallChatState] = useState<HallChat | null>(null);
  const [hallSending, setHallSending] = useState(false);
  const [hallRetrying, setHallRetrying] = useState(false);
  const [hallUndoing, setHallUndoing] = useState(false);
  const hallChatRef = useRef<HallChat | null>(null);
  const hallChatsRef = useRef<Map<string, HallChat>>(new Map());
  const hallIdRef = useRef(0);
  // 当前大厅滑到的角色（滑动接回的竞态保护：异步接回完成时仍停在该角色才刷新）
  const currentCharRef = useRef<string | null>(null);
  const setHallChat = (updater: HallChat | null | ((prev: HallChat | null) => HallChat | null)) => {
    const prev = hallChatRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    hallChatRef.current = next;
    setHallChatState(next);
    const cid = next?.planeCharacterId ?? prev?.planeCharacterId;
    if (cid) {
      if (next) hallChatsRef.current.set(cid, next);
      else hallChatsRef.current.delete(cid);
    }
  };

  const [pool, setPool] = useState<PlanePoolItem[]>([]);
  const [poolLoading, setPoolLoading] = useState(true);

  const [sessions, setSessions] = useState<PlaneSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const [mine, setMine] = useState<PlaneCharacter[]>([]);
  const [mineLoading, setMineLoading] = useState(true);

  const [editing, setEditing] = useState<PlaneCharacter | 'new' | null>(null);

  // 任务列表「继续」→ 跳回大厅定位到该角色（seq 递增保证重复触发）
  const [hallFocus, setHallFocus] = useState<{ id: string; seq: number } | null>(null);

  // 好感度增减提示：最近一次数值变动（+N/-N），显示在顶栏好感度旁，数秒后自动消失
  const [affectionPulse, setAffectionPulse] = useState<{ sessionId: string; delta: number; key: number } | null>(null);
  useEffect(() => {
    if (!affectionPulse) return;
    const t = setTimeout(() => setAffectionPulse(null), 2600);
    return () => clearTimeout(t);
  }, [affectionPulse]);

  // 大厅简介阶段（薄纸铺满）→ 通知 App 把 dock 背景换成薄纸色
  const [hallIntroOpen, setHallIntroOpen] = useState(false);

  // 建卡/编辑弹窗打开时 → 通知 App 隐藏底部 dock（dock z-40 会压住 main z-10 内的弹窗）
  useEffect(() => {
    onModalChange?.(editing !== null);
    return () => { onModalChange?.(false); };
  }, [editing, onModalChange]);

  // 简介薄纸阶段 → 通知 App 把 dock 背景换成薄纸色（dock 保留，只改背景）
  useEffect(() => {
    onThinPaper?.(hallIntroOpen);
    return () => { onThinPaper?.(false); };
  }, [hallIntroOpen, onThinPaper]);

  const loadPool = async () => {
    try {
      const r = await api.getPlanePool();
      setPool(r.pool);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPoolLoading(false);
    }
  };

  const loadSessions = async () => {
    try {
      const r = await api.listPlaneSessions();
      setSessions(r.sessions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSessionsLoading(false);
    }
  };

  const loadMine = async () => {
    try {
      const r = await api.listPlaneCharacters();
      setMine(r.characters);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMineLoading(false);
    }
  };

  useEffect(() => {
    loadPool();
    loadSessions();
    loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 接回该角色上一段（内存缓存 → 后端进行中会话），不新建、不写视图；无则 null */
  const fetchHallChat = async (planeCharacterId: string): Promise<HallChat | null> => {
    const cached = hallChatsRef.current.get(planeCharacterId);
    if (cached) return cached;
    try {
      const active = await api.listPlaneSessions(true);
      const existing = active.sessions.find((s) => s.planeCharacterId === planeCharacterId);
      if (existing) {
        const detail = await api.getPlaneSession(existing.sessionId);
        return {
          planeCharacterId,
          sessionId: existing.sessionId,
          lines: detail.messages.filter((m) => !(m.role === 'narration' && m.character_name === '数值变动')).map(toLine),
          characterName: existing.characterName,
          avatar: detail.avatar ?? '',
        };
      }
    } catch { /* 忽略，回退新建 */ }
    return null;
  };

  /** 确保大厅会话：优先接回上一段，都没有才新建（并写入视图） */
  const ensureHallSession = async (planeCharacterId: string): Promise<HallChat> => {
    const existing = await fetchHallChat(planeCharacterId);
    if (existing) { setHallChat(existing); return existing; }
    // 全新一段
    const s = await api.createPlaneSession(planeCharacterId);
    const detail = await api.getPlaneSession(s.sessionId);
    const chat: HallChat = {
      planeCharacterId,
      sessionId: s.sessionId,
      lines: detail.messages.filter((m) => !(m.role === 'narration' && m.character_name === '数值变动')).map(toLine),
      characterName: s.characterName,
      avatar: detail.avatar ?? '',
    };
    setHallChat(chat);
    return chat;
  };

  /** 大厅滑到某角色：优先内存缓存；缓存空但有进行中会话时异步接回历史（不新建） */
  const selectCharacter = (id: string | null) => {
    currentCharRef.current = id;
    if (!id) { setHallChat(null); return; }
    const cached = hallChatsRef.current.get(id);
    if (cached) { setHallChat(cached); return; }
    setHallChat(null);
    const active = sessions.find((s) => s.planeCharacterId === id && !s.ended);
    if (active) {
      fetchHallChat(id).then((chat) => {
        // 仅当用户仍停在该角色时才刷新（避免快速滑动切走后覆盖）
        if (chat && currentCharRef.current === id) setHallChat(chat);
      });
    }
  };

  // sessions 加载完成后，若当前大厅正停在一个有进行中会话的角色，自动接回历史（兜底首次加载时序）
  useEffect(() => {
    const id = currentCharRef.current;
    if (!id) return;
    const active = sessions.find((s) => s.planeCharacterId === id && !s.ended);
    const cached = hallChatsRef.current.get(id);
    if (active && !cached) {
      fetchHallChat(id).then((chat) => {
        if (chat && currentCharRef.current === id) setHallChat(chat);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  /** 任务列表「继续」：跳回大厅定位到该角色，直接对话（接回上一段） */
  const continueInHall = (sid: string) => {
    const s = sessions.find((x) => x.sessionId === sid);
    if (!s) return;
    setHallFocus((prev) => ({ id: s.planeCharacterId, seq: (prev?.seq ?? 0) + 1 }));
    setTab('hall');
    ensureHallSession(s.planeCharacterId).catch(() => {});
  };

  /** 结束一段进行中的任务：标记结束移入历史，退出回任务列表 */
  const endSession = async (sid: string) => {
    if (!window.confirm('结束这段任务？结束后移入历史，可随时删除。')) return;
    try {
      setError('');
      await api.endPlaneSession(sid);
      for (const [cid, c] of hallChatsRef.current) {
        if (c.sessionId === sid) hallChatsRef.current.delete(cid);
      }
      if (hallChatRef.current?.sessionId === sid) setHallChat(null);
      await loadSessions();
      setTab('missions');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 重来：删除当前进度，回大厅定位到该角色从零开始 */
  const restartSession = async (sid: string) => {
    const s = sessions.find((x) => x.sessionId === sid);
    if (!s) return;
    if (!window.confirm(`重新开始「${s.characterName}」的任务？当前进度将删除，从零好感重来。`)) return;
    try {
      setError('');
      await api.deletePlaneSession(sid);
      for (const [cid, c] of hallChatsRef.current) {
        if (c.sessionId === sid) hallChatsRef.current.delete(cid);
      }
      if (hallChatRef.current?.sessionId === sid) setHallChat(null);
      await loadSessions();
      setHallFocus((prev) => ({ id: s.planeCharacterId, seq: (prev?.seq ?? 0) + 1 }));
      setTab('hall');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 大厅快聊：发送一条消息（确保会话 + 流式逐拍回显） */
  const sendHallMessage = async (planeCharacterId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed || hallSending) return;
    setError('');
    setHallSending(true);
    try {
      const chat = await ensureHallSession(planeCharacterId);
      const playerLine: Bubble = {
        id: `h${++hallIdRef.current}`,
        kind: 'player',
        speaker: '我',
        content: trimmed,
        time: Date.now(),
        internal: '',
        internalNotable: false,
      };
      setHallChat({ ...chat, lines: [...chat.lines, playerLine] });
      let lastBeat = 0;
      const res = await api.planeAdvanceStream(chat.sessionId, trimmed, async (b) => {
        if (b.kind === 'narration' && b.speaker === '数值变动') return; // 数值变动旁白不进气泡，改顶栏好感度旁显示
        if (b.kind === 'narration' || b.kind === 'character') {
          const now = Date.now();
          if (lastBeat && now - lastBeat < 600) await sleep(600 - (now - lastBeat));
          lastBeat = Date.now();
          setHallChat((prev) => {
            if (!prev || prev.sessionId !== chat.sessionId) return prev;
            return { ...prev, lines: [...prev.lines, beatToLine(b, `h${++hallIdRef.current}`)] };
          });
        }
      });
      if (res?.statsChanges?.length) {
        const delta = res.statsChanges.reduce((s, c) => s + (c.after - c.before), 0);
        if (delta !== 0) setAffectionPulse({ sessionId: chat.sessionId, delta, key: Date.now() });
      }
      loadSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHallSending(false);
    }
  };

  /** 大厅快聊：重试最后一批回复（回退到最后一个玩家发言，重新生成） */
  const retryHallMessage = async (planeCharacterId: string) => {
    const chat = hallChatRef.current;
    if (!chat || chat.planeCharacterId !== planeCharacterId || hallSending || hallRetrying) return;
    setError('');
    setHallRetrying(true);
    try {
      // 前端先回退：删掉最后一个玩家发言之后的角色/旁白回复
      setHallChat((prev) => {
        if (!prev || prev.planeCharacterId !== planeCharacterId) return prev;
        for (let i = prev.lines.length - 1; i >= 0; i--) {
          if (prev.lines[i].kind === 'player') {
            return { ...prev, lines: prev.lines.slice(0, i + 1) };
          }
        }
        return prev;
      });
      let lastBeat = 0;
      const res = await api.planeRetryStream(chat.sessionId, async (b) => {
        if (b.kind === 'narration' && b.speaker === '数值变动') return; // 数值变动旁白不进气泡，改顶栏好感度旁显示
        if (b.kind === 'narration' || b.kind === 'character') {
          const now = Date.now();
          if (lastBeat && now - lastBeat < 600) await sleep(600 - (now - lastBeat));
          lastBeat = Date.now();
          setHallChat((prev) => {
            if (!prev || prev.sessionId !== chat.sessionId) return prev;
            return { ...prev, lines: [...prev.lines, beatToLine(b, `h${++hallIdRef.current}`)] };
          });
        }
      });
      if (res?.statsChanges?.length) {
        const delta = res.statsChanges.reduce((s, c) => s + (c.after - c.before), 0);
        if (delta !== 0) setAffectionPulse({ sessionId: chat.sessionId, delta, key: Date.now() });
      }
      loadSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHallRetrying(false);
    }
  };

  /** 大厅快聊：撤回最后一个玩家发言所在轮（回退整轮，重新对账） */
  const undoHallMessage = async (planeCharacterId: string) => {
    const chat = hallChatRef.current;
    if (!chat || chat.planeCharacterId !== planeCharacterId || hallSending || hallUndoing) return;
    setError('');
    setHallUndoing(true);
    try {
      await api.planeUndo(chat.sessionId);
      const detail = await api.getPlaneSession(chat.sessionId);
      setHallChat((prev) => {
        if (!prev || prev.planeCharacterId !== planeCharacterId) return prev;
        return { ...prev, lines: detail.messages.map(toLine) };
      });
      loadSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHallUndoing(false);
    }
  };

  const togglePublish = async (c: PlaneCharacter) => {
    try {
      setError('');
      await api.publishPlaneCharacter(c.id, !c.published);
      await loadMine();
      await loadPool();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteChar = async (c: PlaneCharacter) => {
    if (!window.confirm(`确定删除「${c.name}」？此操作不可恢复。`)) return;
    try {
      setError('');
      await api.deletePlaneCharacter(c.id);
      await loadMine();
      await loadPool();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteSession = async (sid: string) => {
    if (!window.confirm('删除这段聊天？已发放的积分不会重置。')) return;
    try {
      setError('');
      await api.deletePlaneSession(sid);
      // 同步大厅缓存：删掉的会话若被缓存则清掉
      for (const [cid, c] of hallChatsRef.current) {
        if (c.sessionId === sid) hallChatsRef.current.delete(cid);
      }
      if (hallChatRef.current?.sessionId === sid) setHallChat(null);
      await loadSessions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-bg-soft">
      {/* 顶栏 */}
      <header className="relative shrink-0 px-3.5 py-2.5 flex items-center justify-between bg-bg-soft border-b border-border sticky top-0 z-30">
        <div className="flex items-center gap-2 min-w-0">
          {onBack && (
            <button
              onClick={onBack}
              className="p-1 -ml-1 text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
              aria-label="返回"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}
          <h1 className="text-[16px] font-bold text-ink tracking-tight">位面任务</h1>
        </div>
        <span className="text-[11px] text-ink-muted">去别的位面做委托</span>
      </header>

      {/* 页签栏 */}
      <nav className="relative shrink-0 flex border-b border-border bg-bg-soft">
        {(
          [
            ['hall', '任务大厅'],
            ['missions', '任务列表'],
            ['mine', '我的角色'],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              setTab(k);
              setError('');
            }}
            className={`flex-1 py-2.5 text-[13px] font-semibold transition relative cursor-pointer ${
              tab === k ? 'text-ink' : 'text-ink-muted hover:text-ink-soft'
            }`}
          >
            {label}
            {tab === k && (
              <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-[3px] rounded-full bg-solid" />
            )}
          </button>
        ))}
      </nav>

      {/* 错误条 */}
      {error && (
        <div className="relative shrink-0 px-3 py-1.5 text-[11px] text-rose bg-rose/10 border-b border-rose/20">{error}</div>
      )}

      {/* 内容 */}
      <div className="relative flex-1 overflow-hidden">
        {tab === 'hall' && (
          <HallView
            pool={pool}
            loading={poolLoading}
            onGoMine={() => setTab('mine')}
            hallChat={hallChat}
            hallSending={hallSending}
            hallRetrying={hallRetrying}
            hallUndoing={hallUndoing}
            onSendHall={sendHallMessage}
            onRetryHall={retryHallMessage}
            onUndoHall={undoHallMessage}
            onSelectCharacter={selectCharacter}
            sessions={sessions}
            focus={hallFocus}
            onEndSession={endSession}
            affectionPulse={affectionPulse}
            onIntroChange={setHallIntroOpen}
          />
        )}
        {tab === 'missions' && (
          <MissionsView
            sessions={sessions}
            loading={sessionsLoading}
            onContinue={continueInHall}
            onGoHall={() => setTab('hall')}
            onDelete={deleteSession}
            onRestart={restartSession}
          />
        )}
        {tab === 'mine' && (
          <MineView
            mine={mine}
            loading={mineLoading}
            onNew={() => setEditing('new')}
            onEdit={(c) => setEditing(c)}
            onTogglePublish={togglePublish}
            onDelete={deleteChar}
          />
        )}
      </div>

      {/* 建卡/编辑弹窗 */}
      {editing && (
        <CharacterFormModal
          character={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadMine();
            loadPool();
          }}
        />
      )}

    </div>
  );
};

/* ── 任务大厅：swipe 卡片流 ─────────────────────────── */
const HallView: React.FC<{
  pool: PlanePoolItem[];
  loading: boolean;
  onGoMine: () => void;
  hallChat: HallChat | null;
  hallSending: boolean;
  hallRetrying: boolean;
  hallUndoing: boolean;
  onSendHall: (planeCharacterId: string, text: string) => void;
  onRetryHall: (planeCharacterId: string) => void;
  onUndoHall: (planeCharacterId: string) => void;
  onSelectCharacter: (id: string | null) => void;
  sessions: PlaneSessionSummary[];
  focus: { id: string; seq: number } | null;
  onEndSession: (sessionId: string) => void;
  affectionPulse: { sessionId: string; delta: number; key: number } | null;
  onIntroChange?: (open: boolean) => void;
}> = ({ pool, loading, onGoMine, hallChat, hallSending, hallRetrying, hallUndoing, onSendHall, onRetryHall, onUndoHall, onSelectCharacter, sessions, focus, onEndSession, affectionPulse, onIntroChange }) => {
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const dragXRef = useRef(0);
  const axisLock = useRef<'x' | 'y' | null>(null);
  const slideTimer = useRef<number | null>(null);
  const [draft, setDraft] = useState('');
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const bubblesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [nextPreview, setNextPreview] = useState<string | null>(null);
  const [preview, setPreview] = useState<PlanePoolItem | null>(null);
  // 松手切换的滑动动画方向（left=切下一个/right=切上一个），null=空闲
  const [slideDir, setSlideDir] = useState<'left' | 'right' | null>(null);
  // 心声：当前展开心声的气泡 id（点击 ⚡心声 切换，与约会一致）
  const [showInternal, setShowInternal] = useState<string | null>(null);

  // 重新随机「下一个」任务（排除当前）
  const rerollNext = (curIdx: number) => {
    if (pool.length <= 1) { setNextPreview(null); return; }
    let n = curIdx;
    let guard = 0;
    while (n === curIdx && guard < 20) {
      n = Math.floor(Math.random() * pool.length);
      guard++;
    }
    setNextPreview(pool[n].id);
  };
  // 左滑 / 点右箭头：切到「下一个」随机任务（当前入历史栈）
  const nextCard = () => {
    if (!nextPreview) return;
    const i = pool.findIndex((c) => c.id === nextPreview);
    if (i < 0) return;
    setHistory((h) => [...h, pool[index].id]);
    setIndex(i);
    setSummaryExpanded(false);
    setShowInternal(null);
    rerollNext(i);
  };
  // 右滑 / 点左箭头：回到「上一个」聊过的角色（历史出栈）
  const prevCard = () => {
    if (history.length === 0) return;
    const prevId = history[history.length - 1];
    const i = pool.findIndex((c) => c.id === prevId);
    if (i < 0) return;
    setHistory((h) => h.slice(0, -1));
    setIndex(i);
    setSummaryExpanded(false);
    setShowInternal(null);
  };

  useEffect(() => {
    if (!pool.length) return;
    const start = Math.floor(Math.random() * pool.length);
    setIndex(start);
    setHistory([]);
    setPreview(null);
    setShowInternal(null);
    rerollNext(start);
    setDragX(0);
    setSummaryExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);

  // 滑到某角色 → 通知父组件把当前会话切到该角色的缓存
  useEffect(() => {
    onSelectCharacter(pool[index]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, index]);

  // 任务列表「继续」跳回：定位到指定角色
  useEffect(() => {
    if (focus) {
      const i = pool.findIndex((c) => c.id === focus.id);
      if (i >= 0) setIndex(i);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  // 简介阶段：切角色/切池重置；无简介直接进任务，有简介等手动点「进入任务」（无自动跳转）
  useEffect(() => {
    const c = pool[index];
    const len = (c?.summary || '').length;
    setIntroDone(!len);
  }, [pool, index]);

  // 气泡自动滚到最新
  useEffect(() => {
    const el = bubblesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [hallChat?.lines.length]);

  // 简介薄纸是否已上报（避免每次依赖变化重复通知父组件）
  const introReportedRef = useRef(false);
  // 简介薄纸阶段上报父组件：隐藏 dock、薄纸盖到底（须放提前 return 之前，否则 Hook 顺序不稳会白屏）
  useEffect(() => {
    const c = pool[index] ?? null;
    const hasChatHere = !!hallChat && hallChat.planeCharacterId === c?.id && hallChat.lines.length > 0;
    const hasActive = !!c && sessions.some((s) => s.planeCharacterId === c.id && !s.ended);
    const intro = !loading && !!c && !introDone && !hasChatHere && !hasActive;
    if (intro !== introReportedRef.current) {
      introReportedRef.current = intro;
      onIntroChange?.(intro);
    }
    return () => {
      if (introReportedRef.current) {
        introReportedRef.current = false;
        onIntroChange?.(false);
      }
    };
  }, [pool, index, introDone, hallChat, sessions, loading, onIntroChange]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    axisLock.current = null;
    dragXRef.current = 0;
    // 取消进行中的切换动画（快速连滑时避免卡片卡在滑出位置）
    if (slideTimer.current !== null) {
      window.clearTimeout(slideTimer.current);
      slideTimer.current = null;
    }
    setSlideDir(null);
    setPreview(null);
    setDragX(0);
    setDragging(true);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const dx = e.touches[0].clientX - touchStart.current.x;
    const dy = e.touches[0].clientY - touchStart.current.y;
    // 方向锁定：首次位移超过阈值才锁定轴向，避免横纵手势互相干扰
    // 锁定那一帧也要继续走下面的跟手逻辑，否则快速滑动（touchmove 次数少）会漏掉首帧位移，表现为「第一下无效」
    if (axisLock.current === null) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        axisLock.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      } else {
        return;
      }
    }
    if (axisLock.current === 'x') {
      dragXRef.current = dx;
      setDragX(dx);
      if (dx < -10) {
        setPreview(nextPreview ? pool.find((c) => c.id === nextPreview) ?? null : null);
      } else if (dx > 10) {
        const prevId = history[history.length - 1];
        setPreview(prevId ? pool.find((c) => c.id === prevId) ?? null : null);
      } else {
        setPreview(null);
      }
    }
  };
  const onTouchEnd = () => {
    const dx = dragXRef.current;
    let switched = false;
    if (axisLock.current === 'x') {
      if (dx < -60) {
        // 左滑切换：当前卡片滑出左侧，相邻卡片从右侧滑入中心，动画结束后再切数据
        switched = true;
        setSlideDir('left');
        slideTimer.current = window.setTimeout(() => {
          nextCard();
          setSlideDir(null);
          setPreview(null);
          slideTimer.current = null;
        }, 240);
      } else if (dx > 60 && history.length > 0) {
        switched = true;
        setSlideDir('right');
        slideTimer.current = window.setTimeout(() => {
          prevCard();
          setSlideDir(null);
          setPreview(null);
          slideTimer.current = null;
        }, 240);
      } else if (dx < -10) {
        rerollNext(index);
      }
    }
    touchStart.current = null;
    axisLock.current = null;
    dragXRef.current = 0;
    setDragging(false);
    setDragX(0);
    // 触发切换时 preview 要滑入中心，延迟到动画结束再清；其余情况立即清
    if (!switched) setPreview(null);
  };

  if (loading) {
    return <div className="h-full flex items-center justify-center text-ink-muted text-xs">正在接入位面公共池…</div>;
  }
  if (pool.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="text-3xl">🌌</span>
        <div className="text-sm font-semibold text-ink">公共池还没有角色</div>
        <div className="text-xs text-ink-muted leading-relaxed">去「我的角色」创建并发布，你的角色会进入公共池，其他玩家也能滑到。</div>
        <button
          onClick={onGoMine}
          className="mt-2 px-4 py-2 rounded-xl bg-solid text-solid-contrast text-sm font-semibold hover:bg-solid-soft transition cursor-pointer"
        >
          去创建
        </button>
      </div>
    );
  }

  const card = pool[index];

  // 卡片横排滑动：拖动跟手 / 松手切换滑出 / 空闲归位
  const cardX = slideDir === 'left' ? '-100%' : slideDir === 'right' ? '100%' : `${dragX}px`;
  // 相邻卡片预览：拖动时在侧面跟手露出，松手切换动画时滑入中心
  const previewX = slideDir ? '0px' : dragX < 0 ? `calc(100% + ${dragX}px)` : `calc(-100% + ${dragX}px)`;
  const cardTransition = dragging ? 'none' : 'transform 0.24s ease';

  const handleSend = () => {
    const text = draft.trim();
    if (!text || hallSending) return;
    setDraft('');
    onSendHall(card.id, text);
  };

  // 括号键：在光标处插入一对全角圆括号（），光标停在中间，方便写动作描写
  const insertBrackets = () => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + '（）' + draft.slice(end);
    setDraft(next);
    // 同步聚焦：移动端程序化 focus 需在用户手势的同步调用栈内才会弹软键盘
    el.focus();
    // 光标停在括号中间（等 React 渲染更新 value 后再设 selection）
    requestAnimationFrame(() => {
      el.setSelectionRange(start + 1, start + 1);
    });
  };

  // 最后一个玩家气泡 / 最后一个角色气泡下标（用于重试、撤回按钮）
  let lastPlayerGlobal = -1;
  let lastNpcGlobal = -1;
  if (hallChat && hallChat.planeCharacterId === card.id) {
    for (let i = hallChat.lines.length - 1; i >= 0; i--) {
      if (lastPlayerGlobal < 0 && hallChat.lines[i].kind === 'player') lastPlayerGlobal = i;
      if (lastNpcGlobal < 0 && hallChat.lines[i].kind === 'character') lastNpcGlobal = i;
      if (lastPlayerGlobal >= 0 && lastNpcGlobal >= 0) break;
    }
  }

  const hasChat = hallChat && hallChat.planeCharacterId === card.id && hallChat.lines.length > 0;
  const activeSession = sessions.find((s) => s.planeCharacterId === card.id && !s.ended);
  const showIntro = !introDone && !hasChat && !activeSession;

  return (
    <div
      className="relative h-full overflow-hidden select-none pb-[81px]"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* 预览层：滑动时从侧边滑入的相邻卡片（横排并排，只作预览不可交互） */}
      {preview && (
        <div
          className="absolute inset-0"
          style={{
            transform: `translateX(${previewX})`,
            transition: cardTransition,
          }}
        >
          {preview.avatar ? (
            <img
              src={imageUrl(preview.avatar)}
              alt={preview.name}
              className="absolute inset-0 w-full h-full object-cover object-top"
              referrerPolicy="no-referrer"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-b from-solid-soft to-bg-muted" />
          )}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to bottom, var(--bg-overlay), transparent 24%), linear-gradient(to top, var(--overlay-bg), transparent 52%)',
            }}
          />
          <div className="absolute bottom-8 inset-x-0 px-6 text-center">
            <span className="text-lg font-bold text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.5)]">{preview.name}</span>
          </div>
        </div>
      )}

      {/* 立绘背景：铺满整个大厅 */}
      <div
        key={`bg-${card.id}`}
        className="absolute inset-0"
        style={{
          transform: `translateX(${cardX})`,
          transition: cardTransition,
        }}
      >
        {card.avatar ? (
          <img
            src={imageUrl(card.avatar)}
            alt={card.name}
            className="absolute inset-0 w-full h-full object-cover object-top"
            referrerPolicy="no-referrer"
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-b from-solid-soft to-bg-muted" />
        )}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(to bottom, var(--bg-overlay), transparent 24%), linear-gradient(to top, var(--overlay-bg), transparent 52%)',
          }}
        />
      </div>

      <div
        key={card.id}
        className="relative z-10 h-full flex flex-col plane-card-fade-in"
        style={{
          transform: `translateX(${cardX})`,
          transition: cardTransition,
        }}
      >
        {/* 顶部条：翻页 + 名字 + 圆点 + 委托 */}
        <div className="shrink-0 px-4 pt-3 pb-1 text-white">
          <div className="flex items-center gap-2">
            <button
              onClick={prevCard}
              className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-40 cursor-pointer bg-white/15 backdrop-blur-sm border border-white/30 text-white"
              aria-label="上一张"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-lg font-bold [text-shadow:0_1px_2px_rgba(0,0,0,0.5)]">{card.name}</span>
            {card.gender && (
              <span className={`text-[11px] px-1.5 py-0.5 rounded-full bg-white/20`}>{genderLabel(card.gender)}</span>
            )}
            {card.completed && (
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-500/90 font-semibold">✓ 已完成</span>
            )}
            <button
              onClick={nextCard}
              className="ml-auto w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-40 cursor-pointer bg-white/15 backdrop-blur-sm border border-white/30 text-white"
              aria-label="下一张"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 mt-1.5">
            {pool.map((_, i) => (
              <span
                key={i}
                className={`rounded-full transition-all ${i === index ? 'w-4 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/40'}`}
              />
            ))}
            <span className={`ml-2 text-[11px] text-white/70`}>{card.playCount} 次委托</span>
            {activeSession && (
              <span className={`ml-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-white/90`}>
                <Heart className="w-3 h-3 fill-current text-rose-400" />
                {activeSession.affection}
                {affectionPulse && affectionPulse.sessionId === activeSession.sessionId && (
                  <span
                    key={affectionPulse.key}
                    className={`text-[12px] font-bold leading-none animate-in fade-in slide-in-from-bottom-1 duration-300 ${affectionPulse.delta > 0 ? 'text-emerald-400' : 'text-rose-400'}`}
                  >
                    {affectionPulse.delta > 0 ? `+${affectionPulse.delta}` : `${affectionPulse.delta}`}
                  </span>
                )}
              </span>
            )}
            {activeSession && (
              <button
                onClick={() => onEndSession(activeSession.sessionId)}
                className="ml-auto px-2 py-0.5 rounded-full bg-white/15 backdrop-blur-sm border border-white/25 text-white/80 text-[11px] font-semibold hover:bg-white/25 transition active:scale-95 cursor-pointer"
              >
                结束
              </button>
            )}
          </div>
        </div>

        {/* 气泡区（快聊）：flex-1，从下往上堆；未开聊先播简介旁白，播放完弹出开场白 */}
        <div className="flex-1 min-h-0 flex flex-col justify-end px-3 overflow-hidden">
          {hasChat ? (
            <div ref={bubblesRef} className="overflow-y-auto space-y-1.5 max-h-full [touch-action:pan-y]">
              {hallChat.lines.map((l, idx) =>
                l.kind === 'narration' ? (
                  <div key={l.id} className="text-center text-[11px] text-white/85 italic px-2 [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
                    {renderText(l.content, 'text-white/60')}
                  </div>
                ) : (
                  <div key={l.id} className={`flex flex-col ${l.kind === 'player' ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`max-w-[80%] px-3 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words rounded-2xl ${
                        l.kind === 'player'
                          ? 'bg-chat-pink-soft/90 text-ink-on backdrop-blur-md rounded-2xl rounded-tr-sm'
                          : 'bg-bg-muted text-ink backdrop-blur-md rounded-2xl rounded-bl-sm border border-border'
                      }`}
                    >
                      {renderText(l.content, l.kind === 'player' ? 'text-ink-on/65' : 'text-ink-muted/70')}
                    </div>
                    {/* 撤回：最后一个玩家气泡下方 */}
                    {l.kind === 'player' && idx === lastPlayerGlobal && !hallSending && !hallRetrying && (
                      <button
                        onClick={() => onUndoHall(card.id)}
                        disabled={hallUndoing}
                        className="mt-1 px-2 py-0.5 rounded-full bg-white/15 backdrop-blur-sm border border-white/20 text-white/80 text-[11px] font-semibold hover:bg-white/25 transition active:scale-95 cursor-pointer disabled:opacity-40"
                      >
                        {hallUndoing ? '撤回中…' : '撤回'}
                      </button>
                    )}
                    {/* 重试：最后一个角色回复气泡下方 */}
                    {idx === lastNpcGlobal && l.kind !== 'player' && !hallSending && !hallUndoing && (
                      <button
                        onClick={() => onRetryHall(card.id)}
                        disabled={hallRetrying}
                        className="mt-1 px-2 py-0.5 rounded-full bg-white/15 backdrop-blur-sm border border-white/20 text-white/80 text-[11px] font-semibold hover:bg-white/25 transition active:scale-95 cursor-pointer disabled:opacity-40"
                      >
                        {hallRetrying ? '重试中…' : '重试'}
                      </button>
                    )}
                    {/* 内心独白（心声）：与约会一致，⚡ 按钮展开小号斜体玫红卡片 */}
                    {l.kind !== 'player' && l.internal && l.internalNotable && (
                      <>
                        <button
                          onClick={() => setShowInternal(showInternal === l.id ? null : l.id)}
                          className="mt-1 px-2 py-0.5 rounded-lg bg-chat-pink-border/20 text-rose text-[11px] font-bold cursor-pointer transition active:scale-95"
                        >
                          ⚡ {showInternal === l.id ? '收起心声' : '心声'}
                        </button>
                        {showInternal === l.id && (
                          <div className="mt-1 max-w-[78%] bg-chat-pink-bg/90 backdrop-blur-md border border-chat-pink-border/40 rounded-2xl px-3 py-2.5 text-[12px] italic leading-relaxed text-rose">
                            {renderText(l.internal)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              )}
              {(hallSending || hallRetrying) && hallChat.planeCharacterId === card.id && (
                <div className="flex items-center gap-1 pl-1">
                  <span className="w-1 h-1 rounded-full bg-solid animate-pulse" />
                  <span className="w-1 h-1 rounded-full bg-solid animate-pulse [animation-delay:-0.15s]" />
                  <span className="w-1 h-1 rounded-full bg-solid animate-pulse [animation-delay:-0.3s]" />
                </div>
              )}
            </div>
          ) : !introDone && !activeSession ? (
            /* 简介旁白：薄纸已铺满整个内容层，这里左对齐深色文字 */
            <div className="flex-1 min-h-0">
              <p className="h-full overflow-y-auto [touch-action:pan-y] mx-2 rounded-2xl bg-bg-soft/92 px-4 py-4 text-left text-ink text-[13.5px] leading-relaxed whitespace-pre-wrap">
                {card.summary}
              </p>
            </div>
          ) : (
            /* 简介播放完：弹出开场白气泡 */
            card.greeting && (
              <div className="pb-0.5 idate-intro-pop">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-bg-muted backdrop-blur-md border border-border px-3 py-2 text-[12.5px] text-ink leading-relaxed whitespace-pre-wrap">
                  {renderText(card.greeting, 'text-ink-muted/70')}
                </div>
              </div>
            )
          )}
        </div>

        {/* 底部信息区：简介阶段显「进入任务」；进入后显「简介 · 目标 ▾」入口 / 目标徽章 */}
        <div className={`shrink-0 px-4 ${showIntro ? 'pb-0 pt-2' : 'pb-2'}`}>
          {showIntro ? (
            <button
              onClick={() => setIntroDone(true)}
              className="w-full h-11 rounded-full bg-solid text-solid-contrast text-[14px] font-semibold shadow-md active:scale-[0.98] transition cursor-pointer"
            >
              进入任务
            </button>
          ) : card.summary ? (
            <div onClick={() => setSummaryExpanded(true)} className="cursor-pointer active:opacity-80 inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
              <span>简介 · 目标 ▾</span>
            </div>
          ) : (
            <div className="inline-block text-[11px] font-medium text-ink-soft bg-white/15 backdrop-blur-md border border-white/20 rounded-lg px-2 py-1">
              🎯 {card.goalPreview || '好感满 100 即完成'}
            </div>
          )}
        </div>

        {/* 底部快聊输入框：简介播放完即弹出；有会话直接接回接着聊 */}
        {(introDone || hasChat || activeSession) && (
          <div className="shrink-0 px-3 pb-1.5 idate-intro-pop">
            <div className="flex items-center gap-1.5">
              <button
                onClick={insertBrackets}
                disabled={hallSending}
                className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold bg-white/15 backdrop-blur-sm border border-white/25 text-white/85 hover:bg-white/25 transition active:scale-95 shrink-0 cursor-pointer disabled:opacity-40"
                aria-label="插入括号"
              >
                （）
              </button>
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder={`和 ${card.name} 聊点什么…`}
                disabled={hallSending}
                className="h-10 flex-1 rounded-full bg-white/15 backdrop-blur-md border border-white/25 px-4 text-[13px] text-ink placeholder:text-ink-faint outline-none focus:bg-white/25 transition"
              />
              <button
                onClick={handleSend}
                disabled={hallSending || !draft.trim()}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition active:scale-95 shrink-0 cursor-pointer ${
                  draft.trim() && !hallSending
                    ? 'bg-solid text-solid-contrast shadow-md'
                    : 'bg-solid/40 text-white/70 cursor-not-allowed'
                }`}
                aria-label="发送"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

        {/* 简介全屏浮层：全文可滚动，看得全（主题面板 + 主题文字，对齐主界面弹窗） */}
        {summaryExpanded && (
          <div className="absolute inset-x-0 top-0 bottom-[81px] z-20 bg-black/40 backdrop-blur-xs flex items-center justify-center p-5" onClick={() => setSummaryExpanded(false)}>
            <div
              className="max-h-[60vh] w-full overflow-y-auto rounded-2xl bg-panel border border-border p-4 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[13px] font-semibold text-ink">角色简介</span>
                <span className="text-[11px] text-ink-muted cursor-pointer" onClick={() => setSummaryExpanded(false)}>关闭 ✕</span>
              </div>
              <p className="text-[13px] leading-relaxed text-ink-soft whitespace-pre-wrap">{card.summary}</p>
              <div className="mt-3 pt-3 border-t border-border">
                <div className="text-[12px] font-semibold text-ink mb-1">🎯 委托目标</div>
                <p className="text-[12.5px] leading-relaxed text-ink-soft whitespace-pre-wrap">{card.goal || card.goalPreview || '好感满 100 即完成'}</p>
              </div>
            </div>
          </div>
        )}
    </div>
  );
};

/* ── 任务列表：进行中 & 历史 ─────────────────────────── */
const MissionsView: React.FC<{
  sessions: PlaneSessionSummary[];
  loading: boolean;
  onContinue: (sid: string) => void;
  onGoHall: () => void;
  onDelete: (sid: string) => void;
  onRestart: (sid: string) => void;
}> = ({ sessions, loading, onContinue, onGoHall, onDelete, onRestart }) => {
  if (loading) {
    return <div className="h-full flex items-center justify-center text-ink-muted text-xs">加载任务…</div>;
  }
  if (sessions.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="text-3xl">📋</span>
        <div className="text-sm font-semibold text-ink">还没有任务记录</div>
        <div className="text-xs text-ink-muted leading-relaxed">去任务大厅滑一个角色，开始你的第一段位面委托。</div>
        <button
          onClick={onGoHall}
          className="mt-2 px-4 py-2 rounded-xl bg-solid text-solid-contrast text-sm font-semibold hover:bg-solid-soft transition cursor-pointer"
        >
          去任务大厅
        </button>
      </div>
    );
  }

  const active = sessions.filter((s) => !s.ended);
  const history = sessions.filter((s) => s.ended);

  return (
    <div className="h-full overflow-y-auto px-3 py-3 pb-[81px] space-y-4">
      <section>
        <h2 className="text-[12px] font-bold text-ink-muted mb-2">进行中（{active.length}）</h2>
        {active.length === 0 ? (
          <div className="text-center text-ink-muted text-xs py-4">暂无进行中的任务</div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {active.map((s) => (
              <div
                key={s.sessionId}
                onClick={() => onContinue(s.sessionId)}
                className="relative rounded-xl overflow-hidden aspect-[3/4] bg-bg-muted border border-border cursor-pointer active:opacity-80 transition"
              >
                {s.avatar ? (
                  <img src={imageUrl(s.avatar)} alt="" className="absolute inset-0 w-full h-full object-cover object-top" referrerPolicy="no-referrer" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-cyan font-bold text-xl">{s.characterName.charAt(0)}</div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />
                {s.goalAchieved && (
                  <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-emerald-500/90 text-white text-[9px] font-semibold">✓ 完成</span>
                )}
                <div className="absolute inset-x-0 bottom-0 p-1.5">
                  <div className="text-[11px] font-semibold text-white truncate leading-tight">{s.characterName}</div>
                  <div className="text-[10px] text-white/75 flex items-center gap-0.5 mt-0.5">
                    <Heart className="w-2.5 h-2.5 fill-rose text-rose" /> {s.affection}/100
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-[12px] font-bold text-ink-muted mb-2">历史（{history.length}）</h2>
        {history.length === 0 ? (
          <div className="text-center text-ink-muted text-xs py-4">暂无历史任务</div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {history.map((s) => (
              <div key={s.sessionId} className="relative rounded-xl overflow-hidden aspect-[3/4] bg-bg-muted/50 border border-border">
                {s.avatar ? (
                  <img src={imageUrl(s.avatar)} alt="" className="absolute inset-0 w-full h-full object-cover object-top opacity-60" referrerPolicy="no-referrer" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-cyan font-bold text-xl">{s.characterName.charAt(0)}</div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                <span className={`absolute top-1 left-1 px-1 py-0.5 rounded text-white text-[9px] font-semibold ${s.goalAchieved ? 'bg-emerald-500/90' : 'bg-rose/80'}`}>
                  {s.goalAchieved ? '✓ 完成' : '未完成'}
                </span>
                <button
                  onClick={() => onRestart(s.sessionId)}
                  className="absolute top-1 right-7 w-5 h-5 rounded-full bg-black/55 text-white/90 flex items-center justify-center active:scale-90 transition cursor-pointer"
                  aria-label="重来"
                  title="重来"
                >
                  <RotateCcw className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onDelete(s.sessionId)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/55 text-white/90 flex items-center justify-center active:scale-90 transition cursor-pointer"
                  aria-label="删除聊天"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <div className="absolute inset-x-0 bottom-0 p-1.5">
                  <div className="text-[11px] font-semibold text-white truncate leading-tight">{s.characterName}</div>
                  <div className="text-[10px] text-white/75 mt-0.5">好感 {s.affection}/100</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

/* ── 我的角色：建卡入口 + 角色列表 ───────────────────────── */
const MineView: React.FC<{
  mine: PlaneCharacter[];
  loading: boolean;
  onNew: () => void;
  onEdit: (c: PlaneCharacter) => void;
  onTogglePublish: (c: PlaneCharacter) => void;
  onDelete: (c: PlaneCharacter) => void;
}> = ({ mine, loading, onNew, onEdit, onTogglePublish, onDelete }) => {
  if (loading) {
    return <div className="h-full flex items-center justify-center text-ink-muted text-xs">加载角色…</div>;
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-3 pb-[81px] space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={onNew}
          className="relative rounded-xl overflow-hidden aspect-[3/4] border-2 border-dashed border-border text-ink-muted flex flex-col items-center justify-center gap-1 hover:bg-bg-muted hover:text-ink transition cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span className="text-[11px] font-semibold">新建角色</span>
        </button>

        {mine.map((c) => (
          <div
            key={c.id}
            onClick={() => onEdit(c)}
            className="relative rounded-xl overflow-hidden aspect-[3/4] bg-bg-muted border border-border cursor-pointer active:opacity-80 transition"
          >
            {c.avatar ? (
              <img src={imageUrl(c.avatar)} alt="" className="absolute inset-0 w-full h-full object-cover object-top" referrerPolicy="no-referrer" />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-cyan font-bold text-xl">{c.name.charAt(0)}</div>
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent" />
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePublish(c); }}
              className="absolute top-1 left-1 px-1 py-0.5 rounded-full text-white text-[9px] font-semibold flex items-center gap-0.5 bg-black/55 active:scale-90 transition cursor-pointer"
              aria-label={c.published ? '下架角色' : '发布角色'}
            >
              {c.published ? <Globe2 className="w-2.5 h-2.5 text-emerald-300" /> : <Globe className="w-2.5 h-2.5" />}
              {c.published ? '已发布' : '发布'}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(c); }}
              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/55 text-white/90 flex items-center justify-center active:scale-90 transition cursor-pointer"
              aria-label="删除角色"
            >
              <Trash2 className="w-3 h-3" />
            </button>
            <div className="absolute inset-x-0 bottom-0 p-1.5">
              <div className="text-[11px] font-semibold text-white truncate leading-tight">{c.name}</div>
              <div className="text-[9px] text-white/70 truncate mt-0.5">{c.playCount} 次委托</div>
            </div>
          </div>
        ))}
      </div>

      {mine.length === 0 && (
        <div className="text-center text-ink-muted text-xs py-10 leading-relaxed">
          还没有角色。创建一个位面角色，发布后它会进入公共池，
          <br />
          其他玩家滑到就能接你的委托。
        </div>
      )}
    </div>
  );
};

/* ── 建卡/编辑表单弹窗 ──────────────────────────────── */
type PolishableField = 'appearance' | 'summary' | 'persona' | 'goal' | 'greeting';

const CharacterFormModal: React.FC<{
  character: PlaneCharacter | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ character, onClose, onSaved }) => {
  const isNew = character === null;
  const draftKey = character ? `plane-draft-${character.id}` : 'plane-draft-new';
  const [form, setForm] = useState(() => {
    // 草稿箱：打开时若存在草稿则恢复，避免误关/刷新后重写
    try {
      const draft = localStorage.getItem(draftKey);
      if (draft) {
        const p = JSON.parse(draft);
        return {
          name: p.name ?? character?.name ?? '',
          gender: p.gender ?? character?.gender ?? '',
          summary: p.summary ?? character?.summary ?? '',
          persona: p.persona ?? character?.persona ?? '',
          greeting: p.greeting ?? character?.greeting ?? '',
          goal: p.goal ?? character?.goal ?? '',
          avatar: p.avatar ?? character?.avatar ?? '',
          appearance: p.appearance ?? character?.appearance ?? '',
        };
      }
    } catch { /* 草稿损坏则忽略 */ }
    return {
      name: character?.name ?? '',
      gender: character?.gender ?? '',
      summary: character?.summary ?? '',
      persona: character?.persona ?? '',
      greeting: character?.greeting ?? '',
      goal: character?.goal ?? '',
      avatar: character?.avatar ?? '',
      appearance: character?.appearance ?? '',
    };
  });
  // 草稿自动保存（防抖 500ms）：内容一有变化就写 localStorage
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify(form)); } catch { /* 忽略配额/隐私模式 */ }
    }, 500);
    return () => clearTimeout(t);
  }, [form, draftKey]);
  const [saving, setSaving] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [rolls, setRolls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [fillOpen, setFillOpen] = useState(false);
  const [fillText, setFillText] = useState('');
  const [filling, setFilling] = useState(false);
  const [polishing, setPolishing] = useState<PolishableField | null>(null);
  const [generatingAppearance, setGeneratingAppearance] = useState(false);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // 从文本自动填表（后端忠实原文 + 转胶囊；空字段保留原值不覆盖）
  const doFill = async () => {
    const src = fillText.trim();
    if (!src) return;
    setFilling(true);
    setErr('');
    try {
      const r = await api.fillPlaneFromText(src);
      setForm((f) => ({
        ...f,
        name: r.name || f.name,
        gender: r.gender || f.gender,
        appearance: r.appearance || f.appearance,
        summary: r.summary || f.summary,
        persona: r.persona || f.persona,
        goal: r.goal || f.goal,
        greeting: r.greeting || f.greeting,
      }));
      setFillOpen(false);
      setFillText('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setFilling(false);
    }
  };

  // 按字段润色
  const polish = async (field: PolishableField) => {
    const text = form[field].trim();
    if (!text || polishing) return;
    setPolishing(field);
    setErr('');
    try {
      const r = await api.polishPlaneField({
        field,
        text,
        name: form.name.trim() || undefined,
        gender: form.gender.trim() || undefined,
      });
      if (r.polished) set(field, r.polished);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPolishing(null);
    }
  };

  // 生成外貌：独立功能，根据名字/性别/简介/人设补一段外貌描述
  const genAppearance = async () => {
    setGeneratingAppearance(true);
    setErr('');
    try {
      const r = await api.generatePlaneAppearance({
        name: form.name.trim() || undefined,
        gender: form.gender.trim() || undefined,
        summary: form.summary.trim() || undefined,
        persona: form.persona.trim() || undefined,
      });
      if (r.appearance) set('appearance', r.appearance);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGeneratingAppearance(false);
    }
  };

  const polishBtn = (field: PolishableField) => (
    <button
      onClick={() => polish(field)}
      disabled={polishing !== null || !form[field].trim()}
      className="px-2.5 py-1 rounded-full bg-bg-muted border border-border text-[11px] text-ink-muted font-semibold hover:bg-bg-soft transition cursor-pointer disabled:opacity-50"
    >
      {polishing === field ? '润色中…' : '✨ 润色'}
    </button>
  );

  const roll = async () => {
    setRolling(true);
    setErr('');
    try {
      const r = await api.rollPlaneGreetings(form);
      setRolls(r.greetings);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRolling(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setErr('');
    try {
      const r = await api.uploadImage(file);
      set('avatar', r.imagePath);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  // 生成角色图（崽图）：按外貌出图，用聊天背景分辨率（竖屏 768×1344）
  const generate = async () => {
    const appearance = form.appearance.trim();
    if (!appearance) {
      setErr('请先填写「外貌」，再生成角色图');
      return;
    }
    setGenerating(true);
    setErr('');
    try {
      const r = await api.generateImage(appearance, {
        portrait: true,
        gender: form.gender || undefined,
        width: 768,
        height: 1344,
      });
      setPendingAvatar(r.imagePath);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  // 应用预览中的生成图（用户点「使用这张」才真正替换 avatar）
  const applyPendingAvatar = () => {
    if (pendingAvatar) {
      set('avatar', pendingAvatar);
      setPendingAvatar(null);
    }
  };

  const save = async () => {
    if (!form.name.trim()) {
      setErr('名字不能为空');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const body = {
        name: form.name.trim(),
        gender: form.gender.trim(),
        summary: form.summary.trim(),
        persona: form.persona.trim(),
        greeting: form.greeting.trim(),
        goal: form.goal.trim(),
        avatar: form.avatar,
        appearance: form.appearance.trim(),
      };
      if (isNew) await api.createPlaneCharacter(body);
      else await api.updatePlaneCharacter(character!.id, body);
      try { localStorage.removeItem(draftKey); } catch { /* 忽略 */ }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-h-[88%] bg-panel rounded-t-3xl overflow-y-auto px-4 pt-4 shadow-xl"
        style={{ paddingBottom: 'calc(24px + env(safe-area-inset-bottom, 0px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[16px] font-bold text-ink">{isNew ? '新建角色' : '编辑角色'}</h2>
          <button onClick={onClose} className="p-1 text-ink-muted hover:text-ink transition cursor-pointer" aria-label="关闭">
            <X className="w-5 h-5" />
          </button>
        </div>

        {err && <div className="mb-2 px-3 py-1.5 text-[11px] text-rose bg-rose/10 rounded-lg">{err}</div>}

        {/* 头像 */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-16 h-16 rounded-2xl overflow-hidden bg-bg-muted border border-border flex items-center justify-center text-cyan font-bold shrink-0">
            {form.avatar ? (
              <img src={imageUrl(form.avatar)} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              (form.name || '角色').charAt(0)
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || generating}
                className="px-3 py-1.5 rounded-lg bg-bg-muted border border-border text-[12px] text-ink font-medium hover:bg-bg-soft transition cursor-pointer disabled:opacity-50"
              >
                {uploading ? '上传中…' : '上传角色图'}
              </button>
              <button
                onClick={generate}
                disabled={generating || uploading}
                className="px-3 py-1.5 rounded-lg bg-bg-muted border border-border text-[12px] text-ink font-medium hover:bg-bg-soft transition cursor-pointer disabled:opacity-50"
              >
                {generating ? '生成中…' : '生成角色图'}
              </button>
            </div>
            <span className="text-[10px] text-ink-faint">角色图会作为聊天背景展示（生成按「外貌」出图，竖屏背景）</span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {/* 生成角色图独立框：生成中 loading，完成显示大图预览 + 使用/再次生成 */}
        {(generating || pendingAvatar) && (
          <div className="mb-4 rounded-xl border border-border bg-bg-soft/50 p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-ink">生成角色图</span>
              {pendingAvatar && (
                <button
                  type="button"
                  onClick={() => setPendingAvatar(null)}
                  className="w-6 h-6 rounded flex items-center justify-center text-ink-muted hover:text-ink transition cursor-pointer"
                  aria-label="关闭预览"
                >
                  ✕
                </button>
              )}
            </div>
            {generating ? (
              <div className="flex flex-col items-center gap-2 py-8">
                <div className="w-6 h-6 border-2 border-ink/20 border-t-ink rounded-full animate-spin" />
                <span className="text-xs text-ink-muted">生成中…（约 10 秒）</span>
              </div>
            ) : pendingAvatar ? (
              <>
                <img
                  src={imageUrl(pendingAvatar)}
                  alt="生成的角色图"
                  className="w-full max-w-[220px] mx-auto rounded-xl border border-border"
                  referrerPolicy="no-referrer"
                />
                <div className="flex items-center justify-center gap-2 mt-3">
                  <button
                    type="button"
                    onClick={applyPendingAvatar}
                    className="px-4 py-2 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:opacity-90 transition cursor-pointer"
                  >
                    使用这张
                  </button>
                  <button
                    type="button"
                    onClick={generate}
                    disabled={generating}
                    className="px-4 py-2 rounded-lg frosted-glass border border-border text-xs text-ink hover:bg-bg-soft transition disabled:opacity-50 cursor-pointer"
                  >
                    再次生成
                  </button>
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* 字段 */}
        <div className="mb-3">
          <button
            onClick={() => setFillOpen((o) => !o)}
            className="w-full px-3 py-2 rounded-xl bg-bg-muted border border-dashed border-border text-[12px] text-ink-muted hover:text-cyan hover:border-cyan transition cursor-pointer"
          >
            📄 从文本导入（粘贴角色文案，自动填表 · 忠实原文）
          </button>
          {fillOpen && (
            <div className="mt-2 p-2.5 rounded-xl bg-bg-muted border border-border">
              <textarea
                value={fillText}
                onChange={(e) => setFillText(e.target.value)}
                placeholder="粘贴角色文案……自动提取 名字/性别/外貌/简介/人设/目标/开场白，原文没有的留空，不编造"
                rows={5}
                className="w-full px-3 py-2 rounded-lg bg-panel border border-border text-[13px] text-ink resize-none focus:outline-none focus:border-cyan"
              />
              <div className="mt-2 flex gap-2 justify-end">
                <button
                  onClick={() => { setFillOpen(false); setFillText(''); }}
                  className="px-3 py-1.5 rounded-lg text-[12px] text-ink-muted hover:bg-bg-soft transition cursor-pointer"
                >
                  取消
                </button>
                <button
                  onClick={doFill}
                  disabled={filling || !fillText.trim()}
                  className="px-3 py-1.5 rounded-lg bg-cyan text-white text-[12px] font-semibold hover:opacity-90 transition cursor-pointer disabled:opacity-50"
                >
                  {filling ? '提取中…' : '自动填表'}
                </button>
              </div>
            </div>
          )}
        </div>
        <Field label="名字 *" value={form.name} onChange={(v) => set('name', v)} placeholder="角色的名字" />
        <Field
          label="性别"
          value={form.gender}
          onChange={(v) => set('gender', v)}
          options={[
            { value: '', label: '未设定' },
            { value: 'male', label: '男' },
            { value: 'female', label: '女' },
          ]}
        />
        <CapsuleField
          characterName={form.name}
          label="外貌"
          labelClassName={planeLabelCls}
          value={form.appearance}
          onChange={(v) => set('appearance', v)}
          placeholder="外貌、气质、穿着……用于生成角色图"
          inputClassName={planeAreaCls}
          headerExtra={
            <div className="flex gap-1.5">
              <button
                onClick={genAppearance}
                disabled={generatingAppearance || (!form.name.trim() && !form.summary.trim() && !form.persona.trim())}
                className="px-2.5 py-1 rounded-full bg-bg-muted border border-border text-[11px] text-cyan font-semibold hover:bg-bg-soft transition cursor-pointer disabled:opacity-50"
              >
                {generatingAppearance ? '生成中…' : '✨ 生成外貌'}
              </button>
              {polishBtn('appearance')}
            </div>
          }
        />
        <CapsuleField
          characterName={form.name}
          label="对外简介"
          labelClassName={planeLabelCls}
          value={form.summary}
          onChange={(v) => set('summary', v)}
          placeholder="给其他玩家看的，不进对话提示词"
          inputClassName={planeAreaCls}
          headerExtra={polishBtn('summary')}
        />
        <CapsuleField
          characterName={form.name}
          label="对内人设"
          labelClassName={planeLabelCls}
          value={form.persona}
          onChange={(v) => set('persona', v)}
          placeholder="进对话提示词的详细设定；留空则复制对外简介"
          inputClassName={planeAreaCls}
          headerExtra={polishBtn('persona')}
        />
        <CapsuleField
          characterName={form.name}
          label="任务目标"
          labelClassName={planeLabelCls}
          value={form.goal}
          onChange={(v) => set('goal', v)}
          placeholder="留空 = 好感满 100 即完成；填写则按剧情判定"
          inputClassName={planeAreaCls}
          headerExtra={polishBtn('goal')}
        />

        {/* 开场白（可 roll） */}
        <div className="mb-3">
          <CapsuleField
            characterName={form.name}
            label="开场白"
            labelClassName={planeLabelCls}
            value={form.greeting}
            onChange={(v) => set('greeting', v)}
            placeholder="留空则进入时自动生成"
            inputClassName={planeAreaCls}
            rows={2}
            headerExtra={
              <div className="flex gap-1.5">
                {polishBtn('greeting')}
                <button
                  onClick={roll}
                  disabled={rolling}
                  className="px-2.5 py-1 rounded-full bg-bg-muted border border-border text-[11px] text-cyan font-semibold hover:bg-bg-soft transition cursor-pointer disabled:opacity-50"
                >
                  {rolling ? '生成中…' : '🎲 roll 一个'}
                </button>
              </div>
            }
          />
          {rolls.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {rolls.map((g, i) => (
                <button
                  key={i}
                  onClick={() => {
                    set('greeting', g);
                    setRolls([]);
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg bg-bg-muted/60 border border-border text-[12px] text-ink hover:bg-bg-muted transition cursor-pointer"
                >
                  {g}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={save}
          disabled={saving}
          className="w-full py-3 rounded-xl bg-solid text-solid-contrast text-sm font-semibold hover:bg-solid-soft transition active:scale-[0.98] cursor-pointer disabled:opacity-60"
        >
          {saving ? '保存中…' : isNew ? '创建角色' : '保存修改'}
        </button>
      </div>
    </div>
  );
};

const Field: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  textarea?: boolean;
  options?: readonly { value: string; label: string }[];
}> = ({ label, value, onChange, placeholder, textarea, options }) => (
  <div className="mb-3">
    <label className="block text-[12px] font-semibold text-ink mb-1.5">{label}</label>
    {textarea ? (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full rounded-xl bg-bg-muted border border-border px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted outline-none focus:bg-bg-soft transition resize-none"
      />
    ) : options ? (
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-bg-muted border border-border px-3 py-2 text-[13px] text-ink outline-none focus:bg-bg-soft transition cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ) : (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl bg-bg-muted border border-border px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted outline-none focus:bg-bg-soft transition"
      />
    )}
  </div>
);
