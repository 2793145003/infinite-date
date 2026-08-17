import { useState, useEffect, useRef } from 'react';
import { api, imageUrl, isLiveConflictError } from '../lib/api';
import type { ThreadInfo, TextMessage, NpcReply, SmsInvite } from '../lib/api';
import { renderTextWithActions } from '../lib/text-render';
import { usePresence } from '../lib/usePresence';
import { ImageUploadButton } from '../components/ImageUploadButton';
import { CharacterEditModal } from '../components/CharacterEditModal';
import { AutoTextarea } from '../components/AutoTextarea';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 格式化消息时间戳，QQ风格：今天显示 HH:MM，昨天显示"昨天 HH:MM"，更早显示 M月D日 HH:MM */
function formatMsgTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// ─── 创建会话本地缓存（刷新不丢草稿） ──────────────────
const CREATION_CACHE_KEY = 'idate_creation_cache';

interface CreationCache {
  sessionId: string;
  characterId: string;
  draft: Record<string, any>;
  ready: boolean;
  messages: TextMessage[];
}

function loadCreationCache(): CreationCache | null {
  try {
    const raw = localStorage.getItem(CREATION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.sessionId) return null;
    return parsed as CreationCache;
  } catch { return null; }
}

function saveCreationCache(cache: CreationCache | null) {
  if (cache) {
    try { localStorage.setItem(CREATION_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
  } else {
    localStorage.removeItem(CREATION_CACHE_KEY);
  }
}

export function SmsApp({
  threadId,
  characterId,
  onBack,
  onOpenThread,
  onNavigate,
}: {
  threadId?: string;
  characterId?: string;
  onBack: () => void;
  onOpenThread?: (threadId: string, characterId: string) => void;
  onNavigate?: (view: any) => void;
}) {
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(!threadId);

  useEffect(() => {
    if (!threadId) loadThreads();
  }, [threadId]);

  const loadThreads = async () => {
    try {
      const data = await api.getThreads();
      setThreads(data.threads);
    } catch { /* ignore */ }
    setLoadingThreads(false);
  };

  // 线程列表
  if (!threadId) {
    return (
      <div className="id-app">
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">短信</span>
        </div>
        <div className="id-app-scroll">
          {loadingThreads ? (
            <div className="id-loading">加载中…</div>
          ) : threads.length === 0 ? (
            <div className="id-empty"><span>💬</span><span>还没有短信</span></div>
          ) : (
            <div className="id-thread-list">
              {threads.map((t) => (
                <div key={t.id} className="id-thread-item" onClick={() => onOpenThread?.(t.id, t.character_id)}>
                  <div className={`id-thread-avatar ${t.character_id === 'DEITY' ? 'deity' : ''}`}>
                    {t.avatar ? (
                      <img src={imageUrl(t.avatar)} alt="" className="id-thread-avatar-img" />
                    ) : (
                      t.character_id === 'DEITY' ? '⚡' : (t.character_name?.[0] ?? '?')
                    )}
                    {t.character_id !== 'DEITY' && (
                      <span className={`id-thread-presence-dot ${t.online_state === 'online' ? 'online' : 'offline'}`} />
                    )}
                  </div>
                  <div className="id-thread-info">
                    <div className="id-thread-name">{t.character_name || '未知'}</div>
                    <div className="id-thread-preview">
                      {t.last_sender === 'player' ? '我: ' : ''}{t.last_message || ''}
                    </div>
                  </div>
                  {t.unread_count > 0 && <span className="id-thread-unread">{t.unread_count}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return <ChatView threadId={threadId} characterId={characterId!} onBack={onBack} onNavigate={onNavigate} />;
}

function ChatView({ threadId, characterId, onBack, onNavigate }: { threadId: string; characterId: string; onBack: () => void; onNavigate?: (view: any) => void }) {
  const [messages, setMessages] = useState<TextMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [npcName, setNpcName] = useState('短信');
  const [npcAvatar, setNpcAvatar] = useState<string | null>(null);
  const [creationSession, setCreationSession] = useState<string | null>(null);
  const [creationReady, setCreationReady] = useState(false);
  const [creationDraft, setCreationDraft] = useState<Record<string, any> | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [showInternal, setShowInternal] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [regeneratingGreeting, setRegeneratingGreeting] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [invite, setInvite] = useState<SmsInvite | null>(null);
  const [acceptingInvite, setAcceptingInvite] = useState(false);
  const [quotingMsg, setQuotingMsg] = useState<{ id: string; text: string; senderName: string } | null>(null);
  const [onlineState, setOnlineState] = useState<'online' | 'sleep' | 'mission'>('online');
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 在光标位置插入一对全角括号，光标停在括号中间 */
  const insertBrackets = () => {
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
  };

  // 恢复创建会话缓存（刷新后自动找回进行中的创建）
  const restoredRef = useRef<string | null>(null); // null=未检查, ''=无缓存, sessionId=已恢复
  useEffect(() => {
    if (restoredRef.current !== null) return;
    const cache = loadCreationCache();
    if (cache && cache.characterId === characterId) {
      restoredRef.current = cache.sessionId;
      setCreationSession(cache.sessionId);
      setCreationDraft(cache.draft);
      setCreationReady(cache.ready);
      setMessages(cache.messages);
      setLoading(false);
      if (characterId === 'DEITY') setNpcName('主神');
    } else {
      restoredRef.current = '';
    }
  }, []);

  // creation 状态变化时自动缓存
  useEffect(() => {
    if (creationSession && creationDraft) {
      saveCreationCache({
        sessionId: creationSession,
        characterId,
        draft: creationDraft,
        ready: creationReady,
        messages,
      });
    } else if (!creationSession) {
      saveCreationCache(null);
    }
  }, [creationSession, creationDraft, creationReady, messages]);

  useEffect(() => {
    // 如果恢复了创建会话缓存，跳过加载普通短信（创建消息不在text_messages表里）
    if (restoredRef.current && restoredRef.current.length > 0) return;
    loadMessages();
  }, [threadId]);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, sending]);

  const loadMessages = async () => {
    try {
      const data = await api.getMessages(threadId);
      setMessages(data.messages);
      setNpcName(data.thread.character_name || '短信');
      setNpcAvatar(data.thread.avatar || null);
      setOnlineState(data.thread.online_state ?? 'online');
      // 等DOM渲染完直接跳到底部
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    } catch { /* ignore */ }
    setLoading(false);
  };

  const handleSend = async () => {
    if ((!input.trim() && !pendingImage) || sending) return;
    const text = input.trim();
    const imgPath = pendingImage;
    const quoteId = quotingMsg?.id;
    const quoteText = quotingMsg?.text;
    const quoteSenderName = quotingMsg?.senderName;
    setInput('');
    setPendingImage(null);
    setQuotingMsg(null);
    setSending(true);

    // 创建模式
    if (creationSession) {
      const tempId = `temp-${Date.now()}`;
      setMessages(prev => [...prev, {
        id: tempId, sender: 'player', body: text, status: 'delivered',
        image_asset_id: imgPath,
        internal: '', internal_notable: 0, internal_viewed: 0,
        created_at: Date.now(), delivered_at: Date.now(),
      }]);

      try {
        const data = await api.creationChat(creationSession, text);
        setMessages(prev => [
          ...prev.map(m => m.id === tempId ? { ...m, id: `player-${Date.now()}` } : m),
          {
            id: `npc-${Date.now()}`, sender: 'npc' as const, body: data.message, status: 'delivered',
            image_asset_id: null,
            internal: '', internal_notable: 0, internal_viewed: 0,
            created_at: Date.now(), delivered_at: Date.now(),
          },
        ]);
        if (data.draft) setCreationDraft(data.draft);
        if (data.ready) setCreationReady(true);
      } catch (err) {
        setMessages(prev => prev.filter(m => m.id !== tempId));
        setInput(text);
        const msg = (err as Error & { body?: { error?: string } }).body?.error || (err as Error).message;
        // session已失效（后端已finalize/cancel/过期）→ 清除缓存，退出创建模式
        if (msg.includes('不存在') || msg.includes('已结束') || msg.includes('404')) {
          setCreationSession(null);
          setCreationReady(false);
          setCreationDraft(null);
          saveCreationCache(null);
        }
        alert(msg);
      } finally {
        setSending(false);
      }
      return;
    }

    // 普通短信模式
    const tempId = `temp-${Date.now()}`;
    const tempMetadata = quoteId ? JSON.stringify({ quote: { id: quotingMsg!.id, text: quotingMsg!.text, senderName: quotingMsg!.senderName } }) : undefined;
    setMessages(prev => [...prev, {
      id: tempId, sender: 'player', body: text, status: 'delivered',
      image_asset_id: imgPath,
      metadata: tempMetadata,
      internal: '', internal_notable: 0, internal_viewed: 0,
      created_at: Date.now(), delivered_at: Date.now(),
    }]);

    try {
      const data = await api.sendSms(threadId, text, imgPath ?? undefined, quoteId, quoteText, quoteSenderName);
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, id: data.playerMessage.id } : m));
      // NPC消息逐条显示
      for (let i = 0; i < data.npcMessages.length; i++) {
        const npc = data.npcMessages[i]!;
        setSending(true);
        await sleep(800 + Math.min(npc.text.length * 25, 1200));
        setSending(false);
        setMessages(prev => [...prev, {
          id: npc.id, sender: 'npc' as const, body: npc.text, status: 'delivered',
          image_asset_id: null,
          internal: i === 0 ? npc.internal : '',
          internal_notable: (i === 0 && npc.internal_notable) ? 1 : 0,
          internal_viewed: 0,
          created_at: Date.now() + i + 1, delivered_at: Date.now() + i + 1,
        }]);
        await sleep(300);
      }
      // 收到邀请 → 显示卡片
      setInvite(data.invite ?? null);
    } catch (err) {
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setInput(text);
      alert((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const isDeity = characterId === 'DEITY';

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {});
  };

  const handleUndoSms = async () => {
    if (undoing || sending) return;
    setUndoing(true);
    try {
      await api.undoSms(threadId);
      // 删除最后一条 player 消息及之后的所有 NPC 回复
      const lastPlayerIdx = [...messages].reverse().findIndex(m => m.sender === 'player');
      if (lastPlayerIdx !== -1) {
        const actualIdx = messages.length - 1 - lastPlayerIdx;
        setMessages(prev => prev.slice(0, actualIdx));
      }
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setUndoing(false);
    }
  };

  const handleRetrySms = async () => {
    if (retrying || sending) return;
    setRetrying(true);
    try {
      // 删除玩家最后一条消息之后的所有 NPC 回复（与后端一致）
      const lastPlayerIdx = [...messages].reverse().findIndex(m => m.sender === 'player');
      if (lastPlayerIdx !== -1) {
        const actualIdx = messages.length - 1 - lastPlayerIdx;
        setMessages(prev => prev.slice(0, actualIdx + 1)); // +1 保留玩家消息
      }
      const data = await api.retrySms(threadId);
      // NPC消息逐条显示
      for (let i = 0; i < data.npcMessages.length; i++) {
        const npc = data.npcMessages[i]!;
        setRetrying(true);
        await sleep(800 + Math.min(npc.text.length * 25, 1200));
        setMessages(prev => [...prev, {
          id: npc.id, sender: 'npc' as const, body: npc.text, status: 'delivered',
          image_asset_id: null,
          internal: i === 0 ? npc.internal : '',
          internal_notable: (i === 0 && npc.internal_notable) ? 1 : 0,
          internal_viewed: 0,
          created_at: Date.now() + i + 1, delivered_at: Date.now() + i + 1,
        }]);
        await sleep(300);
      }
      // 收到邀请 → 显示卡片
      setInvite(data.invite ?? null);
    } catch (err) {
      alert((err as Error).message);
      loadMessages(); // 恢复
    } finally {
      setRetrying(false);
    }
  };

  const handleRetryDreamSms = async () => {
    if (retrying || sending) return;
    setRetrying(true);
    try {
      // 本地只删末尾连续的 dream 气泡（与后端一致）
      setMessages(prev => {
        const out = [...prev];
        while (out.length > 0) {
          const last = out[out.length - 1]!;
          if (last.sender !== 'npc') break;
          let isDreamMsg = false;
          try { isDreamMsg = !!(last.metadata && JSON.parse(last.metadata).dream); } catch { /* ignore */ }
          if (!isDreamMsg) break;
          out.pop();
        }
        return out;
      });
      const data = await api.retryDreamSms(threadId);
      // 新梦短信逐条显示
      for (let i = 0; i < data.npcMessages.length; i++) {
        const npc = data.npcMessages[i]!;
        await sleep(800 + Math.min(npc.text.length * 25, 1200));
        setMessages(prev => [...prev, {
          id: npc.id, sender: 'npc' as const, body: npc.text, status: 'delivered',
          image_asset_id: null,
          metadata: '{"proactive":true,"dream":true}',
          internal: i === 0 ? npc.internal : '',
          internal_notable: (i === 0 && npc.internal_notable) ? 1 : 0,
          internal_viewed: 0,
          created_at: Date.now() + i + 1, delivered_at: Date.now() + i + 1,
        }]);
        await sleep(300);
      }
    } catch (err) {
      alert((err as Error).message);
      loadMessages();
    } finally {
      setRetrying(false);
    }
  };

  const handleRegenerateGreeting = async () => {
    if (regeneratingGreeting || sending) return;
    setRegeneratingGreeting(true);
    try {
      // 删除现有NPC消息
      setMessages(prev => prev.filter(m => m.sender !== 'npc'));
      const data = await api.regenerateSmsGreeting(threadId);
      for (let i = 0; i < data.npcMessages.length; i++) {
        const npc = data.npcMessages[i]!;
        await sleep(800 + Math.min(npc.text.length * 25, 1200));
        setMessages(prev => [...prev, {
          id: npc.id, sender: 'npc' as const, body: npc.text, status: 'delivered',
          image_asset_id: null,
          internal: i === 0 ? npc.internal : '',
          internal_notable: (i === 0 && npc.internal_notable) ? 1 : 0,
          internal_viewed: 0,
          created_at: Date.now() + i + 1, delivered_at: Date.now() + i + 1,
        }]);
        await sleep(300);
      }
    } catch (err) {
      alert((err as Error).message);
      loadMessages();
    } finally {
      setRegeneratingGreeting(false);
    }
  };

  const handleAcceptInvite = async () => {
    if (!invite || acceptingInvite) return;
    setAcceptingInvite(true);
    try {
      // 短信邀请迁移到新场景约会（scene）系统：这是【角色主动邀请玩家】过去赴会（非玩家邀请角色）
      // circumstance 用 npc_invite（玩家是被邀请方），见 scene.greeting.txt 对应情境节
      const data = await api.sceneStart({
        locationId: invite.locationId,
        characterIds: [characterId],
        circumstance: 'npc_invite',
      });
      setInvite(null);
      onNavigate?.({
        type: 'scene-conversation',
        sessionId: data.sessionId,
      });
    } catch (err) {
      if (isLiveConflictError(err)) { /* 全局现场互斥弹窗已接管，不显示红条 */ }
      else {
        const msg = (err as Error & { body?: { error?: string } }).body?.error || (err as Error).message;
        alert(msg);
      }
    } finally {
      setAcceptingInvite(false);
    }
  };

  // NPC主动消息：用户闲置时触发（仅短信线程模式）
  usePresence(threadId ? 'sms-thread' : 'none', { threadId, characterId }, async (proactiveMsgs) => {
    for (let i = 0; i < proactiveMsgs.length; i++) {
      const m = proactiveMsgs[i]!;
      setSending(true);
      const delay = Math.min(2000, Math.max(800, m.text.length * 50));
      await sleep(delay);
      setMessages(prev => [...prev, {
        id: m.id, sender: 'npc' as const, body: m.text, status: 'delivered',
        image_asset_id: null,
        internal: i === 0 ? m.internal : '',
        internal_notable: (i === 0 && m.internal_notable) ? 1 : 0,
        internal_viewed: 0,
        created_at: Date.now() + i + 1, delivered_at: Date.now() + i + 1,
      }]);
      setSending(false);
      await sleep(300);
    }
  });

  const handleStartCreation = async () => {
    if (creationSession || sending) return;
    setSending(true);
    try {
      const data = await api.startCreation();
      setCreationSession(data.sessionId);
      setCreationReady(false);
      if (data.draft) setCreationDraft(data.draft);
      setMessages(prev => [...prev, {
        id: `npc-create-${Date.now()}`, sender: 'npc' as const, body: data.message, status: 'delivered',
        image_asset_id: null,
        internal: '', internal_notable: 0, internal_viewed: 0,
        created_at: Date.now(), delivered_at: Date.now(),
      }]);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleFinalize = async () => {
    if (!creationSession) return;
    setSending(true);
    try {
      const data = await api.finalizeCreation(creationSession, true, creationDraft ?? undefined);
      setCreationSession(null);
      setCreationReady(false);
      setCreationDraft(null);
      setMessages(prev => [...prev, {
        id: `npc-done-${Date.now()}`, sender: 'npc' as const,
        body: `${data.characterName}已进入主城。在地图上找到ta，打个招呼吧。`,
        image_asset_id: null,
        status: 'delivered', internal: '', internal_notable: 0, internal_viewed: 0,
        created_at: Date.now(), delivered_at: Date.now(),
      }]);
    } catch (err) {
      const msg = (err as Error & { body?: { error?: string } }).body?.error || (err as Error).message;
      // session已失效 → 清除缓存，退出创建模式
      if (msg.includes('不存在') || msg.includes('已结束') || msg.includes('404')) {
        setCreationSession(null);
        setCreationReady(false);
        setCreationDraft(null);
        saveCreationCache(null);
      }
      alert(msg);
    } finally {
      setSending(false);
    }
  };

  const handleCancelCreation = async () => {
    if (!creationSession) return;
    try {
      await api.cancelCreation(creationSession);
    } catch { /* ignore */ }
    setCreationSession(null);
    setCreationReady(false);
    setCreationDraft(null);
  };

  return (
    <div className="id-chat-view">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">{npcName}</span>
        {!isDeity && !creationSession && (
          <button className="id-appbar-action" onClick={() => setShowEdit(true)} title="编辑角色">✏️</button>
        )}
      </div>

      {onlineState === 'sleep' && !isDeity && (
        <div className="id-thread-status-banner">💤 对方正在休息，可能没那么快回复</div>
      )}

      {isDeity && (
        <div className="id-deity-shortcuts">
          <button className="id-deity-shortcut-btn" onClick={handleStartCreation} disabled={!!creationSession}>召唤NPC</button>
        </div>
      )}

      {/* 创建模式：角色卡预览/编辑 */}
      {creationSession && creationDraft && (
        <div className="id-creation-card-panel">
          <button className="id-creation-card-toggle" onClick={() => setShowCard(!showCard)}>
            📋 角色卡 {showCard ? '▲' : '▼'}
          </button>
          {showCard && (
            <div className="id-creation-card">
              {/* 头像 */}
              <div className="id-card-section">
                <div className="id-card-row">
                  <label>头像</label>
                  <ImageUploadButton
                    square
                    onUploaded={(path) => setCreationDraft({ ...creationDraft, avatar: path })}
                    onClear={() => setCreationDraft({ ...creationDraft, avatar: '' })}
                    value={creationDraft.avatar}
                  />
                </div>
              </div>

              {/* 基本信息 */}
              <div className="id-card-section">
                <div className="id-card-row">
                  <label>名字</label>
                  <input value={creationDraft.name ?? ''} onChange={e => setCreationDraft({...creationDraft, name: e.target.value})} />
                </div>
                <div className="id-card-row">
                  <label>性别</label>
                  <select value={creationDraft.gender ?? ''} onChange={e => setCreationDraft({...creationDraft, gender: e.target.value})}>
                    <option value="">未设定</option>
                    <option value="male">男</option>
                    <option value="female">女</option>
                  </select>
                </div>
                <div className="id-card-row">
                  <label>年龄</label>
                  <input value={creationDraft.age ?? ''} onChange={e => setCreationDraft({...creationDraft, age: e.target.value})} />
                </div>
                <div className="id-card-row">
                  <label>外貌</label>
                  <AutoTextarea value={creationDraft.appearance ?? ''} onChange={e => setCreationDraft({...creationDraft, appearance: e.target.value})} />
                </div>
              </div>

              {/* 性格三层 */}
              <div className="id-card-section">
                <div className="id-card-section-title">性格</div>
                {['surface', 'core', 'extreme'].map(k => (
                  <div className="id-card-row" key={k}>
                    <label>{k === 'surface' ? '表层' : k === 'core' ? '内核' : '极端'}</label>
                    <AutoTextarea
                      value={creationDraft.personality?.[k] ?? ''}
                      onChange={e => setCreationDraft({
                        ...creationDraft,
                        personality: { ...creationDraft.personality, [k]: e.target.value }
                      })}
                    />
                  </div>
                ))}
              </div>

              {/* 说话风格 */}
              <div className="id-card-section">
                <div className="id-card-section-title">说话风格</div>
                <div className="id-card-row">
                  <label>概述</label>
                  <AutoTextarea value={creationDraft.speechStyle?.description ?? ''} onChange={e => setCreationDraft({...creationDraft, speechStyle: {...creationDraft.speechStyle, description: e.target.value}})} />
                </div>
                {(creationDraft.speechStyle?.examples ?? []).map((ex: any, i: number) => (
                  <div className="id-card-row" key={i}>
                    <label>台词{i + 1}</label>
                    <input
                      value={ex.line ?? ''}
                      onChange={e => {
                        const arr = [...(creationDraft.speechStyle?.examples ?? [])];
                        arr[i] = { ...arr[i], line: e.target.value };
                        setCreationDraft({...creationDraft, speechStyle: {...creationDraft.speechStyle, examples: arr}});
                      }}
                    />
                  </div>
                ))}
              </div>

              {/* 短信风格 */}
              <div className="id-card-section">
                <div className="id-card-section-title">短信风格</div>
                <div className="id-card-row">
                  <label>概述</label>
                  <AutoTextarea value={creationDraft.textingStyle?.description ?? ''} onChange={e => setCreationDraft({...creationDraft, textingStyle: {...creationDraft.textingStyle, description: e.target.value}})} />
                </div>
                {(creationDraft.textingStyle?.examples ?? []).map((ex: string, i: number) => (
                  <div className="id-card-row" key={i}>
                    <label>短信{i + 1}</label>
                    <input
                      value={ex}
                      onChange={e => {
                        const arr = [...(creationDraft.textingStyle?.examples ?? [])];
                        arr[i] = e.target.value;
                        setCreationDraft({...creationDraft, textingStyle: {...creationDraft.textingStyle, examples: arr}});
                      }}
                    />
                  </div>
                ))}
              </div>

              {/* 情绪信号 */}
              <div className="id-card-section">
                <div className="id-card-section-title">情绪信号</div>
                {['nervous', 'happy', 'angry', 'moved', 'defensive'].map(k => {
                  const labels: Record<string, string> = { nervous: '紧张', happy: '开心', angry: '愤怒', moved: '感动', defensive: '防御' };
                  return (
                    <div className="id-card-row" key={k}>
                      <label>{labels[k]}</label>
                      <AutoTextarea
                        value={creationDraft.emotional_signals?.[k] ?? ''}
                        onChange={e => setCreationDraft({
                          ...creationDraft,
                          emotional_signals: { ...creationDraft.emotional_signals, [k]: e.target.value }
                        })}
                      />
                    </div>
                  );
                })}
              </div>

              {/* 背景 */}
              <div className="id-card-section">
                <div className="id-card-section-title">背景</div>
                {['origin', 'shaping', 'current'].map(k => {
                  const labels: Record<string, string> = { origin: '出身', shaping: '经历', current: '现状' };
                  return (
                    <div className="id-card-row" key={k}>
                      <label>{labels[k]}</label>
                      <AutoTextarea
                        value={creationDraft.background?.[k] ?? ''}
                        onChange={e => setCreationDraft({
                          ...creationDraft,
                          background: { ...creationDraft.background, [k]: e.target.value }
                        })}
                      />
                    </div>
                  );
                })}
              </div>

              {/* 其他 */}
              <div className="id-card-section">
                <div className="id-card-row">
                  <label>喜好</label>
                  <input value={Array.isArray(creationDraft.likes) ? creationDraft.likes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''} onChange={e => setCreationDraft({...creationDraft, likes: e.target.value.split('、').filter(Boolean)})} />
                </div>
                <div className="id-card-row">
                  <label>厌恶</label>
                  <input value={Array.isArray(creationDraft.dislikes) ? creationDraft.dislikes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''} onChange={e => setCreationDraft({...creationDraft, dislikes: e.target.value.split('、').filter(Boolean)})} />
                </div>
                <div className="id-card-row">
                  <label>底线</label>
                  <AutoTextarea value={creationDraft.boundaries ?? ''} onChange={e => setCreationDraft({...creationDraft, boundaries: e.target.value})} />
                </div>
                <div className="id-card-row">
                  <label>目标</label>
                  <AutoTextarea value={creationDraft.goals ?? ''} onChange={e => setCreationDraft({...creationDraft, goals: e.target.value})} />
                </div>
                <div className="id-card-row">
                  <label>怪癖</label>
                  <AutoTextarea value={creationDraft.quirks ?? ''} onChange={e => setCreationDraft({...creationDraft, quirks: e.target.value})} />
                </div>
                <div className="id-card-row">
                  <label>与玩家的关系</label>
                  <AutoTextarea value={creationDraft.player_relation ?? ''} onChange={e => setCreationDraft({...creationDraft, player_relation: e.target.value})} placeholder="无特殊关系则留空" />
                </div>
                <div className="id-card-row">
                  <label>擅长</label>
                  <AutoTextarea value={creationDraft.skills ?? ''} onChange={e => setCreationDraft({...creationDraft, skills: e.target.value})} placeholder="战斗、生活技能、知识领域、社交特长……" />
                </div>
                <div className="id-card-row">
                  <label>不擅长</label>
                  <AutoTextarea value={creationDraft.ineptitudes ?? ''} onChange={e => setCreationDraft({...creationDraft, ineptitudes: e.target.value})} placeholder="软肋、不感兴趣、总做不好的事……" />
                </div>
              </div>
            </div>
          )}
          <button
            className="id-chat-send-btn"
            style={{ width: '100%', marginTop: '0.5rem' }}
            onClick={handleFinalize}
            disabled={sending || !creationDraft?.name?.trim()}
          >
            ✓ 保存角色
          </button>
        </div>
      )}

      <div className="id-chat-messages" ref={scrollRef}>
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : messages.length === 0 ? (
          <div className="id-empty">开始对话</div>
        ) : (
          messages.map((msg, i) => {
            const isLastPlayer = msg.sender === 'player' && !messages.slice(i + 1).some(m => m.sender === 'player');
            const isLastNpc = msg.sender === 'npc' && !messages.slice(i + 1).some(m => m.sender === 'npc');
            const hasPlayerMessages = messages.some(m => m.sender === 'player');
            let isDream = false;
            if (msg.sender === 'npc' && msg.metadata) {
              try { isDream = !!JSON.parse(msg.metadata).dream; } catch { /* ignore */ }
            }
            const prevMsg = i > 0 ? messages[i - 1] : null;
            const showTime = !prevMsg || (msg.created_at - prevMsg.created_at > 5 * 60 * 1000);
            return (
            <div key={msg.id}>
              {showTime && <div className="id-bubble-time">{formatMsgTime(msg.created_at)}</div>}
              <div className={`id-bubble-row ${msg.sender}`}>
                {msg.sender === 'npc' && (
                  <div className="id-sms-chat-avatar">
                    {npcAvatar ? (
                      <img src={imageUrl(npcAvatar)} alt="" className="id-sms-chat-avatar-img" />
                    ) : (
                      characterId === 'DEITY' ? '⚡' : ((npcName && npcName !== '短信') ? npcName[0] : '?')
                    )}
                  </div>
                )}
                <div>
                  <div className={`id-bubble ${msg.sender}`}>
                    {msg.image_asset_id && (
                      <img
                        src={imageUrl(msg.image_asset_id)}
                        alt="图片"
                        className="id-bubble-image"
                        loading="lazy"
                        onClick={(e) => (e.target as HTMLImageElement).classList.toggle('id-bubble-image-expanded')}
                      />
                    )}
                    {msg.metadata && (() => { try { const q = JSON.parse(msg.metadata!).quote; return q ? <div className="id-bubble-quote"><span className="id-bubble-quote-name">{q.senderName}</span><span className="id-bubble-quote-text">{q.text}</span></div> : null; } catch { return null; } })()}
                    {msg.body && renderTextWithActions(msg.body)}
                  </div>
                </div>
              </div>
              {!isDeity && msg.sender === 'npc' && msg.internal && !!msg.internal_notable && (
                <div>
                  <button className="id-internal-btn" onClick={() => setShowInternal(showInternal === msg.id ? null : msg.id)}>
                    ⚡ {showInternal === msg.id ? '收起心声' : '心声'}
                  </button>
                  {showInternal === msg.id && <div className="id-internal-text">{msg.internal}</div>}
                </div>
              )}
              {!creationSession && (
                <div className="id-bubble-actions">
                  <button className="id-bubble-action-btn" onClick={() => handleCopy(msg.body, msg.id)}>
                    {copiedId === msg.id ? '✓ 已复制' : '复制'}
                  </button>
                  <button className="id-bubble-action-btn" onClick={() => { setQuotingMsg({ id: msg.id, text: msg.body, senderName: msg.sender === 'player' ? '我' : npcName }); inputRef.current?.focus(); }}>
                    引用
                  </button>
                  {isLastNpc && !sending && !retrying && !undoing && !regeneratingGreeting && (
                    <button className="id-bubble-action-btn" onClick={isDream ? handleRetryDreamSms : (hasPlayerMessages ? handleRetrySms : handleRegenerateGreeting)} disabled={retrying || regeneratingGreeting}>
                      重试
                    </button>
                  )}
                  {isLastPlayer && !sending && !retrying && !undoing && (
                    <button className="id-bubble-action-btn id-bubble-action-danger" onClick={handleUndoSms} disabled={undoing}>
                      撤回
                    </button>
                  )}
                </div>
              )}
            </div>
            );
          })
        )}
        {(sending || retrying || regeneratingGreeting) && (
          <div className="id-typing-dots"><span /><span /><span /></div>
        )}
        {invite && !sending && !retrying && (
          <div className="id-sms-invite-card">
            <div className="id-sms-invite-text">{npcName}邀请你过去找ta</div>
            <button
              className="id-sms-invite-btn"
              onClick={handleAcceptInvite}
              disabled={acceptingInvite}
            >
              {acceptingInvite ? '前往中…' : '前往'}
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

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
        {creationReady ? (
          <>
            <button className="id-chat-send-btn" style={{ width: 'auto', padding: '0 1rem' }} onClick={handleFinalize} disabled={sending}>
              ✓ 就这样吧
            </button>
            <button className="id-chat-send-btn" style={{ width: 'auto', padding: '0 1rem', background: 'rgba(255,255,255,0.05)', borderColor: 'var(--border)' }} onClick={() => setCreationReady(false)}>
              继续修改
            </button>
          </>
        ) : (
          <>
            <button className="id-chat-bracket-btn" onClick={insertBrackets} disabled={sending} title="插入括号">
              （）
            </button>
            <ImageUploadButton
              onUploaded={(p) => setPendingImage(p)}
              onClear={() => setPendingImage(null)}
              disabled={sending}
            />
            <input
              ref={inputRef}
              className="id-chat-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder={creationSession ? '描述你的角色…' : '输入消息…'}
              disabled={sending}
            />
            <button className="id-chat-send-btn" onClick={handleSend} disabled={sending || (!input.trim() && !pendingImage)}>
              ➤
            </button>
            {creationSession && (
              <button className="id-chat-send-btn" style={{ width: 'auto', padding: '0 0.7rem', background: 'rgba(255,255,255,0.05)', borderColor: 'var(--border)', color: 'var(--text-mute)' }} onClick={handleCancelCreation} disabled={sending}>
                ✕
              </button>
            )}
          </>
        )}
      </div>

      {showEdit && (
        <CharacterEditModal
          characterId={characterId}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            // 刷新消息以反映新角色名
            loadMessages();
          }}
        />
      )}
    </div>
  );
}
