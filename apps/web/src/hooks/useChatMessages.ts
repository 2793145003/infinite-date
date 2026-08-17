import { useState, useEffect, useRef, useCallback } from 'react';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 通用聊天消息类型。
 * - role 'player' / 'npc' / 'narration' / 'quest_npc' / 'assistant' 等
 *   不同组件使用不同角色集合，hook 不限制具体取值。
 */
export interface ChatMessage {
  id: string;
  role: string;
  text: string;
  image_path?: string | null;
  speaker?: string | null;
  speakerName?: string;
  internal: string;
  internal_notable: boolean;
  internal_viewed: boolean;
  created_at: number;
}

/**
 * NPC 回复的最小子集（兼容 Conversation 的 NpcReply 和 Scenario 的简化结构）。
 */
export interface NpcReplyLike {
  id: string;
  text: string;
  speaker?: string | null;
  internal: string;
  internal_notable: boolean;
}

/**
 * NPC 回复响应（retry / nudge 共用）。
 */
export interface NpcResponseLike {
  npcMessages: NpcReplyLike[];
  scene_concluded?: boolean;
  stats?: { stats: Record<string, number>; goal_achieved?: boolean } | null;
}

/**
 * 发送消息响应（send 专用，比 NpcResponseLike 多 playerMessage）。
 */
export interface SendResponseLike extends NpcResponseLike {
  playerMessage: { id: string };
}

export interface ChatMessageOptions<M extends ChatMessage = ChatMessage> {
  /** NPC 角色标识，用于 revealNpcMessages 时构造消息 role（Conversation 用 'npc'，Scenario 用 'assistant'） */
  npcRole: string;
  /** 玩家角色标识 */
  playerRole?: string;
  /** 初始消息列表加载函数；返回的消息需映射为 ChatMessage[]；可在此设置组件特有状态 */
  loadMessages: () => Promise<M[]>;
  /** 发送消息；返回后端响应 */
  sendMessage: (text: string, imagePath?: string, quoteId?: string, quoteText?: string, quoteSenderName?: string) => Promise<SendResponseLike>;
  /** 撤回操作（可选） */
  undo?: () => Promise<unknown>;
  /** 重试操作；返回新的 NPC 回复 */
  retry?: () => Promise<NpcResponseLike>;
  /** 戳一下 / 继续；返回新的 NPC 回复 */
  nudge?: () => Promise<NpcResponseLike>;
  /** 结束会话 */
  endSession: () => Promise<unknown>;
  /** 每条 NPC 消息显示后，是否将 internal 附加到第一条；默认 true */
  attachInternalToFirst?: boolean;
  /** 发送/重试/戳一下成功后回调（用于更新 stats 等组件特有状态） */
  onSendResponse?: (data: NpcResponseLike) => void;
  /** 场景结束时回调 */
  onSceneConcluded?: () => void;
  /** 将 speaker（character_id）映射为角色名，用于群聊/多人剧本显示。可选 */
  resolveSpeakerName?: (speaker: string) => string | undefined;
}

export function useChatMessages<M extends ChatMessage = ChatMessage>(
  options: ChatMessageOptions<M>,
) {
  const {
    npcRole,
    playerRole = 'player',
    loadMessages,
    sendMessage,
    undo,
    retry,
    nudge,
    endSession,
    attachInternalToFirst = true,
    onSendResponse,
    onSceneConcluded,
    resolveSpeakerName,
  } = options;

  const [messages, setMessages] = useState<M[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [nudging, setNudging] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [ending, setEnding] = useState(false);
  const [sceneConcluded, setSceneConcluded] = useState(false);
  const [quotingMsg, setQuotingMsg] = useState<{ id: string; text: string; senderName: string } | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const initialLoadRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  /** 逐条显示 NPC 消息，模仿"对方正在输入"体验 */
  const revealNpcMessages = useCallback(
    async (
      npcMessages: NpcReplyLike[],
      append: (msgs: M[]) => void,
      setTyping: (v: boolean) => void,
    ) => {
      for (let i = 0; i < npcMessages.length; i++) {
        const msg = npcMessages[i]!;
        setTyping(true);
        // 等待时间：根据消息长度估算，800ms~2000ms
        await sleep(800 + Math.min(msg.text.length * 25, 1200));
        setTyping(false);
        append([{
          id: msg.id,
          role: npcRole,
          text: msg.text,
          speaker: msg.speaker ?? null,
          speakerName: msg.speaker ? (resolveSpeakerName?.(msg.speaker) ?? msg.speaker) : undefined,
          internal: attachInternalToFirst && i === 0 ? msg.internal : '',
          internal_notable: attachInternalToFirst && i === 0 && msg.internal_notable,
          internal_viewed: false,
          created_at: Date.now() + i + 1,
        } as unknown as M]);
        await sleep(300);
      }
    },
    [npcRole, attachInternalToFirst, resolveSpeakerName],
  );

  /** 自动滚动到底部：首次 instant，后续 smooth */
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: initialLoadRef.current ? 'auto' : 'smooth' });
    if (initialLoadRef.current && messages.length > 0) {
      initialLoadRef.current = false;
    }
  }, [messages, sending]);

  /** 加载消息（调用 loadMessages 回调，并设置 messages） */
  const reload = useCallback(async () => {
    const msgs = await loadMessages();
    setMessages(msgs);
  }, [loadMessages]);

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

  /** 复制文本并显示"已复制"反馈 */
  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 1500);
    }).catch(() => {});
  }, []);

  const handleSend = useCallback(async () => {
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

    const tempId = `temp-${Date.now()}`;
    const tempMetadata = quotingMsg ? JSON.stringify({ quote: { id: quotingMsg.id, text: quotingMsg.text, senderName: quotingMsg.senderName } }) : undefined;
    setMessages(prev => [...prev, {
      id: tempId,
      role: playerRole,
      text,
      image_path: imgPath,
      metadata: tempMetadata,
      internal: '',
      internal_notable: false,
      internal_viewed: false,
      created_at: Date.now(),
    } as unknown as M]);

    try {
      const data = await sendMessage(text, imgPath ?? undefined, quoteId, quoteText, quoteSenderName);
      // 更新临时消息 ID
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, id: data.playerMessage.id } : m));

      await revealNpcMessages(
        data.npcMessages,
        (msgs) => setMessages(prev => [...prev, ...msgs]),
        setSending,
      );

      if (data.scene_concluded) {
        setSceneConcluded(true);
        onSceneConcluded?.();
      }
      onSendResponse?.(data);
    } catch (err) {
      setMessages(prev => prev.filter(m => m.id !== tempId));
      setInput(text);
      // 不 throw——异常已处理（回滚 UI），throw 会冒泡到 React 事件处理器导致未处理错误
    } finally {
      setSending(false);
    }
  }, [input, pendingImage, sending, playerRole, sendMessage, revealNpcMessages, onSceneConcluded, onSendResponse]);

  const handleUndo = useCallback(async () => {
    if (undoing || !undo) return;
    setUndoing(true);
    try {
      await undo();
      // 删除最后一条 player 消息和之后的 NPC 回复
      const lastPlayerIdx = [...messages].reverse().findIndex(m => m.role === playerRole);
      if (lastPlayerIdx !== -1) {
        const actualIdx = messages.length - 1 - lastPlayerIdx;
        setMessages(prev => prev.slice(0, actualIdx));
      }
    } catch (err) {
      throw err;
    } finally {
      setUndoing(false);
    }
  }, [undoing, undo, messages, playerRole]);

  const handleRetry = useCallback(async () => {
    if (retrying || !retry) return;
    setRetrying(true);
    try {
      // 删除最后一批 NPC 回复（与后端一致）
      const lastPlayerIdx = [...messages].reverse().findIndex(m => m.role === playerRole);
      if (lastPlayerIdx !== -1) {
        const actualIdx = messages.length - 1 - lastPlayerIdx;
        setMessages(prev => prev.slice(0, actualIdx + 1)); // +1 保留玩家消息
      } else {
        // 没有 player 消息：greeting 重试，清空所有消息
        setMessages([]);
      }
      const data = await retry();
      await revealNpcMessages(
        data.npcMessages,
        (msgs) => setMessages(prev => [...prev, ...msgs]),
        setRetrying,
      );
      if (data.scene_concluded) {
        setSceneConcluded(true);
      } else {
        setSceneConcluded(false);
      }
      onSendResponse?.(data);
    } catch (err) {
      throw err;
    } finally {
      setRetrying(false);
    }
  }, [retrying, retry, messages, playerRole, revealNpcMessages, onSendResponse]);

  const handleNudge = useCallback(async () => {
    if (nudging || !nudge) return;
    setNudging(true);
    try {
      const data = await nudge();
      await revealNpcMessages(
        data.npcMessages,
        (msgs) => setMessages(prev => [...prev, ...msgs]),
        setNudging,
      );
      onSendResponse?.(data);
    } catch (err) {
      throw err;
    } finally {
      setNudging(false);
    }
  }, [nudging, nudge, revealNpcMessages, onSendResponse]);

  const handleEnd = useCallback(async (onEnded?: () => void) => {
    if (ending) return;
    setEnding(true);
    try {
      await endSession();
      onEnded?.();
    } catch (err) {
      throw err;
    } finally {
      setEnding(false);
    }
  }, [ending, endSession]);

  /** 逐条显示 NPC 主动消息（供 usePresence 等外部调用） */
  const revealProactive = useCallback(
    async (proactiveMsgs: NpcReplyLike[]) => {
      await revealNpcMessages(
        proactiveMsgs,
        (msgs) => setMessages(prev => [...prev, ...msgs]),
        setSending,
      );
    },
    [revealNpcMessages],
  );

  return {
    // 状态
    messages,
    setMessages,
    input,
    setInput,
    sending,
    pendingImage,
    setPendingImage,
    copiedId,
    showInternal,
    setShowInternal,
    undoing,
    retrying,
    nudging,
    showEndModal,
    setShowEndModal,
    ending,
    sceneConcluded,
    setSceneConcluded,
    // quote
    quotingMsg,
    setQuotingMsg,
    // refs
    endRef,
    inputRef,
    initialLoadRef,
    // 方法
    reload,
    insertBrackets,
    handleCopy,
    revealNpcMessages,
    revealProactive,
    handleSend,
    handleUndo,
    handleRetry,
    handleNudge,
    handleEnd,
  };
}

export type UseChatMessagesReturn<M extends ChatMessage = ChatMessage> = ReturnType<typeof useChatMessages<M>>;
