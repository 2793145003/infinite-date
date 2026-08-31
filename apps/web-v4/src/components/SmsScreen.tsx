import React, { useState, useEffect, useRef } from 'react';
import { Send, ArrowLeft, Image as ImageIcon, MapPin, Target } from 'lucide-react';
import { getAnimeMaleAvatar } from '../data/animeAvatars';
import { imageUrl, api } from '../lib/api';
import { ImageViewer } from './ImageViewer';

interface SmsThread {
  id: string;
  character_id: string;
  character_name: string;
  avatar: string | null;
  gender: string | null;
  age: string | null;
  appearance: string | null;
  last_message: string;
  last_sender: string;
  online_state: string;
  unread_count: number;
}

interface SmsMessage {
  id: string;
  sender: string;
  body: string;
  created_at: number;
  status?: string;
  metadata?: string;
  internal?: string;
  internal_notable?: number | boolean;
  imagePath?: string | null;
}

interface SmsInvite {
  locationId: string;
  locationName: string;
}

interface SmsScreenProps {
  onOpenScenario?: () => void;
  onBackToHome?: () => void;
  onOpenCharacterArchive?: () => void;
  onOpenConversation?: (sessionId: string) => void;
  onOpenScene?: (sessionId: string) => void;
  /** 传入后自动打开该角色的短信线程（而不是停在列表） */
  initialCharacterId?: string | null;
}

const onlineLabel = (state: string): string => {
  switch (state) {
    case 'sleep': return '睡觉中';
    case 'mission': return '任务中';
    case 'offline': return '离线';
    default: return '在线';
  }
};

const onlineDot = (state: string): string => {
  switch (state) {
    case 'sleep': return 'bg-zinc-400';
    case 'mission': return 'bg-status-amber';
    case 'offline': return 'bg-zinc-400';
    default: return 'bg-status-green';
  }
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

export const SmsScreen: React.FC<SmsScreenProps> = ({ onOpenScenario, onBackToHome, onOpenCharacterArchive, onOpenConversation, onOpenScene, initialCharacterId }) => {
  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [activeThread, setActiveThread] = useState<SmsThread | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [invite, setInvite] = useState<SmsInvite | null>(null);
  const [acceptingInvite, setAcceptingInvite] = useState(false);
  const [acceptingTask, setAcceptingTask] = useState(false);
  const [decliningTask, setDecliningTask] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [quotingMsg, setQuotingMsg] = useState<{ id: string; text: string; senderName: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [showInternal, setShowInternal] = useState<string | null>(null);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoOpenedRef = useRef<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  };

  // 后端短信消息字段 image_asset_id → 前端 imagePath
  const mapSmsMessage = (m: { image_asset_id?: string | null; imagePath?: string | null; [k: string]: unknown }): SmsMessage => ({
    ...(m as unknown as SmsMessage),
    imagePath: m.image_asset_id ?? m.imagePath ?? null,
  });

  // 是否「载入中」的占位图片气泡（图片还没生成完，image_asset_id 尚为空）
  const isPendingImage = (m: SmsMessage): boolean => {
    if (!m.metadata) return false;
    try {
      return (JSON.parse(m.metadata) as { pending?: boolean }).pending === true;
    } catch {
      return false;
    }
  };

  const scrollToBottom = () => {
    // 直接钉到底部（scrollTop=scrollHeight 立即跳转）。
    // 不能用 scrollIntoView({ behavior:'smooth' })——smooth 在初始加载大量消息时会从顶部慢慢滚、甚至不生效，用户反馈"默认翻不到底"。
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const loadThreads = async () => {
    try {
      const res = await fetch('/v4/api/sms/threads');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setThreads(data.threads || []);
    } catch (e) {
      console.error('加载短信线程失败', e);
    } finally {
      setLoadingThreads(false);
    }
  };

  useEffect(() => {
    loadThreads();
  }, []);

  // 传入 initialCharacterId 时，线程加载完成后自动打开该角色的对话（不进列表）
  useEffect(() => {
    if (!initialCharacterId || loadingThreads) return;
    if (autoOpenedRef.current === initialCharacterId) return;
    const target = threads.find((t) => t.character_id === initialCharacterId);
    if (!target) return;
    autoOpenedRef.current = initialCharacterId;
    setActiveThread(target);
    setInvite(null);
    fetch(`/v4/api/sms/threads/${target.id}/messages`)
      .then((res) => res.json())
      .then((data) => setMessages((data.messages || []).map(mapSmsMessage)))
      .catch((e) => {
        console.error('加载消息失败', e);
        setMessages([]);
      });
  }, [threads, initialCharacterId, loadingThreads]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isSending]);

  // 「载入中」占位图片气泡的局部轮询：图片生成完（约 9 秒）后端会把图填进占位气泡，
  // 这里定期拉取消息，直到占位气泡都变成真图（或超时约 30 秒）为止。
  const hasPendingImage = messages.some((m) => isPendingImage(m));
  useEffect(() => {
    if (!hasPendingImage || !activeThread || isSending) return;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(`/v4/api/sms/threads/${activeThread.id}/messages`);
        if (!res.ok) return; // 非正常响应（401/500等）不处理
        const data = await res.json();
        const next = (data.messages || []).map(mapSmsMessage);
        // 只替换图片：按 id 把填好的图更新到对应的占位气泡，绝不整体替换整个列表
        setMessages((prev) =>
          prev.flatMap((m) => {
            if (!isPendingImage(m)) return [m];
            const filled = next.find((n) => n.id === m.id);
            if (!filled) return []; // 后端已删占位（生成失败）→ 移除占位气泡
            if (filled.imagePath) return [{ ...m, imagePath: filled.imagePath, metadata: filled.metadata }]; // 图填好了
            return [m]; // 还在生成，保留「传输中」占位
          }),
        );
        if (!next.some((n: SmsMessage) => isPendingImage(n))) clearInterval(timer);
      } catch {
        // 忽略单次失败，下一轮再试
      }
      if (attempts >= 12) clearInterval(timer); // 最多约 30 秒
    }, 2500);
    return () => clearInterval(timer);
  }, [hasPendingImage, activeThread, isSending]);

  const openThread = async (thread: SmsThread) => {
    setActiveThread(thread);
    setInvite(null);
    try {
      const res = await fetch(`/v4/api/sms/threads/${thread.id}/messages`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMessages((data.messages || []).map(mapSmsMessage));
      loadThreads();
    } catch (e) {
      console.error('加载消息失败', e);
      setMessages([]);
    }
  };

  const backToList = () => {
    setActiveThread(null);
    setMessages([]);
    setInvite(null);
    loadThreads();
  };

  // NPC 回复逐条显示（打字机节奏）：每个气泡间隔约 650ms 依次出现，不一次性刷屏
  // tailPlaceholder：配图在路上时的「传输中」占位气泡，排在最后一条文字之后
  const appendMessagesGradually = (msgs: SmsMessage[], tailPlaceholder?: SmsMessage) => {
    const all = tailPlaceholder ? [...msgs, tailPlaceholder] : msgs;
    all.forEach((msg, idx) => {
      setTimeout(() => {
        setMessages((prev) => [...prev, msg]);
      }, idx * 650);
    });
  };

  const handleSend = async (textToSend?: string, imagePath?: string) => {
    const text = (textToSend ?? inputText).trim();
    if ((!text && !imagePath) || isSending || !activeThread) return;
    const quoteId = quotingMsg?.id;
    const quoteText = quotingMsg?.text;
    const quoteSenderName = quotingMsg?.senderName;
    setInputText('');
    setQuotingMsg(null);
    setIsSending(true);

    const localMsg: SmsMessage = {
      id: `local-${Date.now()}`,
      sender: 'player',
      body: text,
      imagePath: imagePath ?? null,
      created_at: Date.now(),
      status: 'sending',
      metadata: quoteId ? JSON.stringify({ quote: { id: quotingMsg!.id, text: quotingMsg!.text, senderName: quotingMsg!.senderName } }) : undefined,
    };
    setMessages((prev) => [...prev, localMsg]);

    try {
      const res = await fetch(`/v4/api/sms/threads/${activeThread.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, imagePath, quoteId, quoteText, quoteSenderName }),
      });
      const data = await res.json();
      if (data.error) {
        showToast(data.error);
        setMessages((prev) => prev.filter((m) => m.id !== localMsg.id));
        return;
      }

      const serverPlayerId = data.playerMessage?.id;
      const npcMsgs: SmsMessage[] = (data.npcMessages || []).map((m: { id: string; text: string; internal?: string; internal_notable?: boolean; imagePath?: string | null }) => ({
        id: m.id,
        sender: 'npc',
        body: m.text,
        imagePath: m.imagePath ?? null,
        created_at: Date.now(),
        status: 'delivered',
        internal: m.internal ?? '',
        internal_notable: m.internal_notable ? 1 : 0,
      }));

      // 玩家消息先落位（拿到 serverPlayerId），NPC 回复逐条显示（打字机节奏）
      if (serverPlayerId) {
        setMessages((prev) => prev.map((m) => (m.id === localMsg.id ? { ...m, id: serverPlayerId, status: 'delivered' } : m)));
      }
      // 配图在路上：末尾补一个「传输中」占位气泡，触发轮询直到真图填入
      const imagePlaceholder: SmsMessage | undefined = data.imagePending
        ? {
            id: data.imagePending.id, // 用后端返回的真实占位 id，前后端对齐后轮询才能按 id 只替换图片那一条
            sender: 'npc',
            body: '',
            created_at: Date.now(),
            status: 'delivered',
            metadata: JSON.stringify({ pending: true }),
          }
        : undefined;
      appendMessagesGradually(npcMsgs, imagePlaceholder);

      if (data.invite) setInvite(data.invite);
      if (data.delayed) showToast('对方正在忙，稍后会回复你');
    } catch (e) {
      console.error('发送失败', e);
      showToast('发送失败，请重试');
      setMessages((prev) => prev.filter((m) => m.id !== localMsg.id));
    } finally {
      setIsSending(false);
    }
  };

  // 上传图片并作为图片短信发送
  const handleUploadImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await api.uploadImage(file);
      if (!data?.imagePath) {
        showToast('图片上传失败');
        return;
      }
      await handleSend('', data.imagePath);
    } catch {
      showToast('图片上传失败，请重试');
    } finally {
      // 清空 input，允许重复选择同一文件
      if (e.target) e.target.value = '';
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {});
  };

  const handleQuote = (msg: SmsMessage) => {
    setQuotingMsg({
      id: msg.id,
      text: msg.body,
      senderName: msg.sender === 'player' ? '我' : activeThread?.character_name ?? 'NPC',
    });
    inputRef.current?.focus();
  };

  const handleUndo = async () => {
    if (undoing || isSending || !activeThread) return;
    setUndoing(true);
    try {
      const res = await fetch(`/v4/api/sms/threads/${activeThread.id}/undo`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) {
        showToast(data.error);
        return;
      }
      // 删除最后一条 player 消息及之后的所有 NPC 回复
      const lastPlayerIdx = [...messages].reverse().findIndex((m) => m.sender === 'player');
      if (lastPlayerIdx !== -1) {
        const actualIdx = messages.length - 1 - lastPlayerIdx;
        setMessages((prev) => prev.slice(0, actualIdx));
      }
    } catch (e) {
      showToast('撤回失败');
    } finally {
      setUndoing(false);
    }
  };

  const handleRetry = async () => {
    if (retrying || isSending || !activeThread) return;
    setRetrying(true);
    try {
      // 删除玩家最后一条消息之后的所有 NPC 回复（保留玩家消息）
      const lastPlayerIdx = [...messages].reverse().findIndex((m) => m.sender === 'player');
      if (lastPlayerIdx !== -1) {
        const actualIdx = messages.length - 1 - lastPlayerIdx;
        setMessages((prev) => prev.slice(0, actualIdx + 1));
      }
      const res = await fetch(`/v4/api/sms/threads/${activeThread.id}/retry`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        showToast(data.error);
        // 失败恢复
        const r2 = await fetch(`/v4/api/sms/threads/${activeThread.id}/messages`);
        const d2 = await r2.json();
        setMessages(d2.messages || []);
        return;
      }
      const npcMsgs: SmsMessage[] = (data.npcMessages || []).map((m: { id: string; text: string; internal?: string; internal_notable?: boolean }) => ({
        id: m.id,
        sender: 'npc',
        body: m.text,
        created_at: Date.now(),
        status: 'delivered',
        internal: m.internal ?? '',
        internal_notable: m.internal_notable ? 1 : 0,
      }));
      // 配图在路上：末尾补「传输中」占位气泡，触发轮询直到真图填入
      const imagePlaceholder: SmsMessage | undefined = data.imagePending
        ? {
            id: data.imagePending.id, // 用后端返回的真实占位 id，前后端对齐后轮询才能按 id 只替换图片那一条
            sender: 'npc',
            body: '',
            created_at: Date.now(),
            status: 'delivered',
            metadata: JSON.stringify({ pending: true }),
          }
        : undefined;
      appendMessagesGradually(npcMsgs, imagePlaceholder);
      setInvite(data.invite ?? null);
    } catch (e) {
      showToast('重试失败');
    } finally {
      setRetrying(false);
    }
  };

  const handleAcceptInvite = async () => {
    if (!invite || acceptingInvite || !activeThread) return;
    setAcceptingInvite(true);
    try {
      // 短信邀请 → 场景约会：角色主动邀玩家赴会（circumstance='npc_invite'）
      const data = await api.sceneStart({
        locationId: invite.locationId,
        characterIds: [activeThread.character_id],
        circumstance: 'npc_invite',
      });
      setInvite(null);
      onOpenConversation?.(data.sessionId);
    } catch (err) {
      showToast((err as Error).message || '赴约失败');
    } finally {
      setAcceptingInvite(false);
    }
  };

  const handleAcceptTask = async (missionId: string) => {
    if (acceptingTask) return;
    setAcceptingTask(true);
    try {
      // NPC 任务同行者 = 邀请 NPC 本人（companionId 传空，后端用 assignee_id）
      const data = await api.acceptMission(missionId, '');
      onOpenScene?.(data.sessionId);
    } catch (err) {
      showToast((err as Error).message || '接受任务失败');
    } finally {
      setAcceptingTask(false);
    }
  };

  const handleDeclineTask = async (missionId: string, msgId: string) => {
    if (decliningTask) return;
    setDecliningTask(true);
    try {
      await api.declineMission(missionId);
      // 本地移除 task_invite 标记（按钮消失）
      setMessages((prev) => prev.map((m) => {
        if (m.id !== msgId) return m;
        try {
          const meta = JSON.parse(m.metadata || '{}');
          delete meta.task_invite;
          return { ...m, metadata: JSON.stringify(meta) };
        } catch { return m; }
      }));
    } catch {
      showToast('操作失败');
    } finally {
      setDecliningTask(false);
    }
  };

  // ============ 线程列表视图 ============
  if (!activeThread) {
    return (
      <div className="h-full flex flex-col">
        <header className="px-3.5 py-2.5 flex items-center justify-between shrink-0 sticky top-0 z-30">
          <div className="flex items-center gap-2.5">
            {onBackToHome && (
              <button
                onClick={onBackToHome}
                className="p-1 -ml-1 text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
                aria-label="返回首页"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <h1 className="text-[15px] font-bold text-ink tracking-tight">短信</h1>
          </div>
          {onOpenCharacterArchive && (
            <button
              onClick={onOpenCharacterArchive}
              className="px-2.5 py-1 rounded-lg bg-bg-soft hover:bg-bg-soft border border-border text-ink text-[11px] font-medium transition active:scale-95 cursor-pointer shadow-2xs"
            >
              角色档案
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-2 pb-[81px]">
          {loadingThreads ? (
            <div className="text-center text-ink-muted text-xs py-10">加载中…</div>
          ) : threads.length === 0 ? (
            <div className="text-center text-ink-muted text-xs py-10">还没有短信，去认识一个角色吧</div>
          ) : (
            <div className="flex flex-col gap-1">
              {threads.map((thread) => (
                <button
                  key={thread.id}
                  onClick={() => openThread(thread)}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-2xl frosted-glass hover:bg-bg-soft transition cursor-pointer text-left"
                >
                  <div className="relative shrink-0">
                    {thread.character_id === 'DEITY' ? (
                      <div className="w-12 h-12 rounded-full flex items-center justify-center bg-bg-amber-soft text-amber text-lg border border-border/80 shadow-2xs">⚡</div>
                    ) : (
                      <img
                        src={thread.avatar ? imageUrl(thread.avatar) : getAnimeMaleAvatar(thread.character_name)}
                        alt={thread.character_name}
                        referrerPolicy="no-referrer"
                        className="w-12 h-12 rounded-full object-cover border border-border/80 shadow-2xs"
                      />
                    )}
                    <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full ring-1.5 ring-white ${onlineDot(thread.online_state)}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-bold text-ink tracking-tight truncate">{thread.character_name}</span>
                      <span className="text-[10px] text-ink-muted shrink-0">{onlineLabel(thread.online_state)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-xs text-ink-muted truncate">{thread.last_message || '开始聊天吧'}</span>
                      {thread.unread_count > 0 && (
                        <span className="min-w-[16px] h-4 px-1 rounded-full bg-status-red text-white text-[9px] font-bold flex items-center justify-center shrink-0">
                          {thread.unread_count > 99 ? '99+' : thread.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {toast && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 rounded-full text-xs font-semibold text-solid-contrast bg-solid shadow-md border border-border-dark animate-fade-in">
            {toast}
          </div>
        )}
      </div>
    );
  }

  // ============ 线程详情视图 ============
  const isDeity = activeThread.character_id === 'DEITY';
  const avatar = activeThread.avatar ? imageUrl(activeThread.avatar) : getAnimeMaleAvatar(activeThread.character_name);
  // 主神头像：⚡ 闪电图标 + 琥珀底（照 v3），非主神用图片
  const renderAvatar = (cls: string) =>
    isDeity ? (
      <div className={`${cls} rounded-full flex items-center justify-center bg-bg-amber-soft text-amber border border-border/80 shadow-2xs shrink-0`}>⚡</div>
    ) : (
      <img
        src={avatar}
        alt={activeThread.character_name}
        referrerPolicy="no-referrer"
        className={`${cls} rounded-full object-cover shrink-0 border border-border/80 shadow-2xs`}
      />
    );

  return (
    <div className="h-full flex flex-col">
      <header className="px-3.5 py-2.5 flex items-center justify-between shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2.5">
          <button
            onClick={backToList}
            className="p-1 -ml-1 text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
            aria-label="返回短信列表"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="relative">
            {renderAvatar('w-8.5 h-8.5')}
            <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ring-1.5 ring-white ${onlineDot(activeThread.online_state)}`} />
          </div>
          <div>
            <h2 className="text-xs font-bold text-ink tracking-tight">{activeThread.character_name}</h2>
            <span className="text-[10px] text-ink-muted block truncate max-w-[150px]">{onlineLabel(activeThread.online_state)}</span>
          </div>
        </div>
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2 pb-2">
        {messages.length === 0 && (
          <div className="text-center text-ink-muted text-xs py-10">还没有消息，发条短信打个招呼吧</div>
        )}
        {messages.map((msg, idx) => {
          const isPlayer = msg.sender === 'player';
          // 与 v2 一致：撤回/重试按钮显示在「该类消息的最后一条」上（后面没有同类消息即可），
          // 而非「消息列表的最后一条」——玩家消息后面已有 NPC 回复时，撤回按钮仍应显示。
          const isLastPlayer = msg.sender === 'player' && !messages.slice(idx + 1).some((m) => m.sender === 'player');
          const isLastNpc = msg.sender === 'npc' && !messages.slice(idx + 1).some((m) => m.sender === 'npc');
          // 任务邀请：NPC 消息 metadata 里带 task_invite 时渲染任务邀请卡牌
          let taskInvite: { missionId: string } | null = null;
          if (!isPlayer && msg.metadata) {
            try {
              const meta = JSON.parse(msg.metadata);
              if (meta.task_invite) taskInvite = meta.task_invite;
            } catch { /* ignore */ }
          }
          return (
            <div key={msg.id} className={`flex ${isPlayer ? 'justify-end' : 'justify-start'} gap-2 px-1 mb-3`}>
              {!isPlayer && renderAvatar('w-8 h-8 mt-auto')}
              <div className={`flex flex-col ${isPlayer ? 'items-end' : 'items-start'} max-w-[72%]`}>
                <div
                  className={`px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                    isPlayer
                      ? 'bg-chat-pink-soft/90 text-ink-on backdrop-blur-md rounded-2xl rounded-tr-sm'
                      : 'bg-bg-muted text-ink backdrop-blur-md rounded-2xl rounded-bl-sm border border-border'
                  }`}
                >
                  {msg.metadata && (() => {
                    try {
                      const q = JSON.parse(msg.metadata).quote;
                      return q ? (
                        <div className="mb-1 px-2 py-1 rounded-md bg-solid/5 border-l-2 border-border-strong text-[11px] text-ink-muted">
                          <span className="font-semibold text-ink">{q.senderName}：</span>
                          <span>{q.text}</span>
                        </div>
                      ) : null;
                    } catch { return null; }
                  })()}
                  {msg.imagePath && (
                    <img
                      src={imageUrl(msg.imagePath)}
                      alt="图片消息"
                      className="rounded-xl max-w-full my-0.5 object-contain cursor-zoom-in"
                      style={{ maxHeight: 220 }}
                      onClick={() => setViewerSrc(msg.imagePath!)}
                    />
                  )}
                  {!msg.imagePath && isPendingImage(msg) && (
                    <div className="rounded-xl my-0.5 w-40 h-28 bg-bg-muted-2 border border-border flex items-center justify-center gap-1.5 text-ink-muted text-[11px]">
                      <span className="animate-pulse">⏳</span>传输中…
                    </div>
                  )}
                  {msg.body}
                </div>
                {/* 心声（内心独白）：与 v2 一致，NPC 消息且 internal_notable 为真时显示 */}
                {activeThread.character_id !== 'DEITY' && !isPlayer && msg.internal && !!msg.internal_notable && (
                  <div className="mt-1.5 flex flex-col items-start gap-1">
                    <button
                      onClick={() => setShowInternal(showInternal === msg.id ? null : msg.id)}
                      className="self-start px-2 py-0.5 rounded-lg bg-chat-pink-border/20 text-rose text-[11px] font-bold cursor-pointer transition active:scale-95"
                    >
                      ⚡ {showInternal === msg.id ? '收起心声' : '心声'}
                    </button>
                    {showInternal === msg.id && (
                      <div className="bg-chat-pink-bg/90 backdrop-blur-md border border-chat-pink-border/40 rounded-2xl px-3 py-2.5 text-[12px] italic leading-relaxed text-rose">
                        {msg.internal}
                      </div>
                    )}
                  </div>
                )}
                {taskInvite && (
                  <div className="mt-1.5 w-full rounded-xl overflow-hidden border border-amber/70 bg-bg-amber-soft/90 backdrop-blur-md shadow-xs">
                    <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                      <Target className="w-3.5 h-3.5 text-amber" />
                      <span className="text-[10px] font-semibold tracking-wide text-amber">任务邀约</span>
                    </div>
                    <div className="px-3 pb-2.5">
                      <div className="text-[12px] text-ink leading-relaxed">邀你一起去做个任务</div>
                      <div className="flex gap-2 mt-2">
                        <button
                          onClick={() => handleAcceptTask(taskInvite!.missionId)}
                          disabled={acceptingTask || decliningTask}
                          className="flex-1 py-1.5 rounded-lg bg-amber text-ink-on text-xs font-medium active:scale-95 transition cursor-pointer disabled:opacity-60"
                        >
                          {acceptingTask ? '接受中…' : '接受'}
                        </button>
                        <button
                          onClick={() => handleDeclineTask(taskInvite!.missionId, msg.id)}
                          disabled={acceptingTask || decliningTask}
                          className="flex-1 py-1.5 rounded-lg bg-bg-soft border border-border text-ink-muted text-xs font-medium active:scale-95 transition cursor-pointer disabled:opacity-60"
                        >
                          拒绝
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-0.5 mt-0.5 px-1">
                  <span className="text-[9px] text-ink-muted mr-1 shrink-0">
                    {formatTime(msg.created_at)}
                    {msg.status === 'sending' ? ' · 发送中' : ''}
                  </span>
                  <button onClick={() => handleCopy(msg.body, msg.id)} className="text-[10px] text-ink-muted hover:text-ink px-1 py-0.5 rounded transition cursor-pointer">
                    {copiedId === msg.id ? '✓ 已复制' : '复制'}
                  </button>
                  <button onClick={() => handleQuote(msg)} className="text-[10px] text-ink-muted hover:text-ink px-1 py-0.5 rounded transition cursor-pointer">
                    引用
                  </button>
                  {isLastNpc && !isSending && !retrying && !undoing && (
                    <button onClick={handleRetry} disabled={retrying} className="text-[10px] text-ink-muted hover:text-ink px-1 py-0.5 rounded transition cursor-pointer">
                      重试
                    </button>
                  )}
                  {isLastPlayer && !isSending && !retrying && !undoing && (
                    <button onClick={handleUndo} disabled={undoing} className="text-[10px] text-ink-muted hover:text-ink px-1 py-0.5 rounded transition cursor-pointer">
                      撤回
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {invite && (
          <div className="flex justify-start gap-2 px-1 mb-3">
            {renderAvatar('w-8 h-8 mt-auto')}
            <div className="max-w-[78%] rounded-2xl rounded-bl-sm overflow-hidden border border-chat-pink-border/70 bg-chat-pink-bg/90 backdrop-blur-md shadow-xs">
              <div className="flex items-center gap-1.5 px-3.5 pt-2.5 pb-1">
                <MapPin className="w-3.5 h-3.5 text-rose" />
                <span className="text-[10px] font-semibold tracking-wide text-rose">约会邀约</span>
              </div>
              <div className="px-3.5 pb-2.5">
                <div className="text-[13px] text-ink leading-relaxed">
                  {activeThread?.character_name ?? '对方'}想约你去「<span className="font-medium text-rose">{invite.locationName}</span>」见面
                </div>
                <button
                  onClick={handleAcceptInvite}
                  disabled={acceptingInvite}
                  className="mt-2.5 w-full py-1.5 rounded-xl bg-rose text-ink-on text-xs font-medium active:scale-95 transition cursor-pointer disabled:opacity-60"
                >
                  {acceptingInvite ? '赴约中…' : '前往赴约'}
                </button>
              </div>
            </div>
          </div>
        )}

        {isSending && (
          <div className="flex justify-start gap-2 px-1 mb-3">
            {renderAvatar('w-8 h-8 mt-auto')}
            <div className="px-3.5 py-2.5 bg-bg-muted backdrop-blur-md rounded-2xl rounded-bl-sm border border-border">
              <span className="text-xs text-ink-muted">对方正在输入…</span>
            </div>
          </div>
        )}
      </div>

      <footer className="px-2.5 pt-2 pb-[81px] shrink-0 sticky bottom-0 z-20">
        {quotingMsg && (
          <div className="flex items-center gap-2 mb-1.5">
            <div className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-xl bg-bg-muted backdrop-blur-xl border border-border-strong text-[11px] min-w-0">
              <span className="font-semibold text-ink shrink-0">{quotingMsg.senderName}：</span>
              <span className="text-ink-muted truncate">{quotingMsg.text.slice(0, 50)}{quotingMsg.text.length > 50 ? '…' : ''}</span>
            </div>
            <button onClick={() => setQuotingMsg(null)} className="w-6 h-6 rounded-full bg-bg-muted border border-border-strong text-ink text-xs flex items-center justify-center cursor-pointer shrink-0" aria-label="取消引用">✕</button>
          </div>
        )}
        <div className="flex items-center gap-1.5 sm:gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-10 h-10 rounded-full flex items-center justify-center text-ink transition active:scale-95 cursor-pointer shrink-0 bg-bg-muted hover:bg-bg-soft backdrop-blur-xl border border-border-strong shadow-[0_2px_10px_var(--color-shadow-black-04)]"
          title="上传图片"
        >
          <ImageIcon className="w-4 h-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleUploadImage}
          className="hidden"
        />

        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSend();
          }}
          placeholder="发短信…"
          disabled={isSending}
          className="h-10 flex-1 rounded-full bg-bg-muted backdrop-blur-xl border border-border-strong px-4 text-[13px] text-ink placeholder:text-ink-muted outline-none focus:bg-bg-soft transition shadow-[0_2px_10px_var(--color-shadow-black-04)]"
        />

        <button
          onClick={() => handleSend()}
          disabled={!inputText.trim() || isSending}
          className={`w-10 h-10 rounded-full border flex items-center justify-center transition active:scale-95 shrink-0 cursor-pointer shadow-[0_2px_10px_var(--color-shadow-black-04)] ${
            inputText.trim() && !isSending
              ? 'bg-bg-muted backdrop-blur-xl border-border-strong text-ink hover:bg-bg-soft'
              : 'bg-bg-soft/40 border-border-soft text-ink cursor-not-allowed'
          }`}
          aria-label="发送短信"
        >
          <Send className="w-3.5 h-3.5 ml-0.5 fill-current" />
        </button>
        </div>
      </footer>

      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 rounded-full text-xs font-semibold text-solid-contrast bg-solid shadow-md border border-border-dark animate-fade-in">
          {toast}
        </div>
      )}

      {viewerSrc && <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </div>
  );
};
