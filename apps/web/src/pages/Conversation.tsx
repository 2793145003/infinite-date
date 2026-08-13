import { useState, useEffect, useRef, useCallback } from 'react';
import { api, imageUrl } from '../lib/api';
import { renderTextWithActions } from '../lib/text-render';
import { usePresence } from '../lib/usePresence';
import { CharacterEditModal } from '../components/CharacterEditModal';
import { ImageUploadButton } from '../components/ImageUploadButton';
import { useChatMessages, type ChatMessage, type SendResponseLike, type NpcResponseLike } from '../hooks/useChatMessages';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface ConvMessage extends ChatMessage {
  role: 'player' | 'npc' | 'narration' | 'quest_npc';
  image_path?: string | null;
  speaker?: string | null;
}

interface GroupGreeting {
  messages: { speaker: string; text: string }[];
  internals: Record<string, string>;
  internals_notable: Record<string, boolean>;
}

export function Conversation({
  sessionId,
  characterId,
  greeting,
  isGroup = false,
  participants = [],
  onBack,
}: {
  sessionId: string;
  characterId?: string;
  greeting?: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null | GroupGreeting;
  isGroup?: boolean;
  participants?: { characterId: string; name: string }[];
  onBack: () => void;
}) {
  const [npcName, setNpcName] = useState('对话');
  const [isFriend, setIsFriend] = useState(false);
  const [friendLoaded, setFriendLoaded] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [missionInfo, setMissionInfo] = useState<{ worldName: string; item: string; briefing: string } | null>(null);
  const [showMissionDetail, setShowMissionDetail] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const greetingShownRef = useRef(false);
  // greeting 显示期间的 typing 指示器（greeting 发生在 hook 的 handleSend 生命周期之外）
  const [greetingTyping, setGreetingTyping] = useState(false);

  // 组件特有的 loadMessages：映射后端消息并设置 friend/mission 状态
  const loadMessagesCb = useCallback(async (): Promise<ConvMessage[]> => {
    if (isGroup) {
      const data = await api.getGroupMessages(sessionId);
      return data.messages.map(m => ({
        id: m.id,
        role: m.role === 'player' ? 'player' as const : 'npc' as const,
        text: m.text,
        speaker: m.speaker,
        speakerName: m.speaker ?? undefined,
        internal: m.internal ?? '',
        internal_notable: !!m.internal_notable,
        internal_viewed: !!m.internal_viewed,
        created_at: m.created_at,
      }));
    }
    const data = await api.getConversationMessages(sessionId);
    setIsFriend(data.isFriend);
    setFriendLoaded(true);
    setMissionInfo(data.missionInfo ?? null);
    const msgs = data.messages as Array<typeof data.messages[number] & { speaker?: string | null }>;
    return msgs.map(m => {
      const sp = m.speaker;
      return {
        id: m.id,
        role: m.role === 'player' ? 'player' as const : m.role === 'narration' ? 'narration' as const : m.role === 'quest_npc' ? 'quest_npc' as const : 'npc' as const,
        text: m.text,
        speaker: sp,
        speakerName: sp ?? undefined,
        internal: m.internal ?? '',
        internal_notable: !!m.internal_notable,
        internal_viewed: !!m.internal_viewed,
        created_at: m.created_at,
      };
    });
  }, [sessionId, isGroup, participants]);

  // sendMessage：群聊 vs 单聊走不同 API
  const sendMessageCb = useCallback(async (text: string, imagePath?: string, quoteId?: string, quoteText?: string, quoteSenderName?: string): Promise<SendResponseLike> => {
    if (isGroup) {
      const data = await api.sendGroupMessage(sessionId, text, quoteId, quoteText, quoteSenderName);
      return {
        playerMessage: data.playerMessage,
        npcMessages: data.npcMessages.map(m => ({
          id: m.id, text: m.text, speaker: m.speaker,
          internal: m.internal, internal_notable: m.internal_notable,
        })),
        scene_concluded: data.scene_concluded,
      };
    }
    const data = await api.sendConversationMessage(sessionId, text, imagePath, quoteId, quoteText, quoteSenderName);
    return data;
  }, [sessionId, isGroup]);

  const chat = useChatMessages<ConvMessage>({
    npcRole: 'npc',
    playerRole: 'player',
    loadMessages: loadMessagesCb,
    sendMessage: sendMessageCb,
    undo: () => api.undoConversation(sessionId),
    retry: () => api.retryConversation(sessionId) as Promise<NpcResponseLike>,
    nudge: () => api.nudgeConversation(sessionId) as Promise<NpcResponseLike>,
    endSession: () => api.endConversation(sessionId),
  });

  const {
    messages, setMessages,
    input, setInput,
    sending, pendingImage, setPendingImage,
    copiedId, showInternal, setShowInternal,
    undoing, retrying, nudging,
    showEndModal, setShowEndModal, ending,
    sceneConcluded,
    endRef, inputRef,
    reload, insertBrackets, handleCopy,
    revealNpcMessages, revealProactive,
    handleSend, handleUndo, handleRetry, handleNudge, handleEnd,
    quotingMsg, setQuotingMsg,
  } = chat;

  // 包装 reload 以匹配原始 loadMessages 的静默错误处理
  const safeReload = useCallback(async () => {
    try { await reload(); } catch { /* ignore */ }
  }, [reload]);

  // 初始化：greeting 显示 or 加载消息
  useEffect(() => {
    if (isGroup) {
      // 群聊模式
      const groupGreeting = greeting as GroupGreeting | null;
      if (groupGreeting?.messages?.length && !greetingShownRef.current) {
        greetingShownRef.current = true;
        setGreetingTyping(true);
        (async () => {
          await revealNpcMessages(
            groupGreeting.messages.map((m, i) => ({
              id: `greeting-${i}`, text: m.text, speaker: m.speaker,
              internal: groupGreeting.internals[m.speaker] ?? '',
              internal_notable: groupGreeting.internals_notable[m.speaker] ?? false,
            })),
            (msgs) => setMessages(prev => [...prev, ...msgs]),
            setGreetingTyping,
          );
        })();
      } else {
        safeReload();
      }
      // 群聊标题用 participants 名字
      if (participants.length > 0) {
        setNpcName(participants.map(p => p.name).join(' & '));
      }
    } else if (greeting?.messages?.length && !greetingShownRef.current) {
      // 单聊 greeting — greeting 在此分支非 GroupGreeting
      greetingShownRef.current = true;
      setGreetingTyping(true);
      const g = greeting as { environment: string; messages: string[]; internal: string; internal_notable: boolean };
      (async () => {
        // 先显示环境旁白
        if (g.environment) {
          await sleep(600);
          setMessages(prev => [...prev, {
            id: `narration-${Date.now()}`, role: 'narration' as const, text: g.environment,
            internal: '', internal_notable: false, internal_viewed: false, created_at: Date.now(),
          }]);
          await sleep(800);
        }
        await revealNpcMessages(
          g.messages.map((text, i) => ({
            id: `greeting-${i}`, text,
            internal: i === 0 ? g.internal : '',
            internal_notable: i === 0 && g.internal_notable,
          })),
          (msgs) => setMessages(prev => [...prev, ...msgs]),
          setGreetingTyping,
        );
      })();
      api.getConversationMessages(sessionId).then(data => {
        setIsFriend(data.isFriend);
        setFriendLoaded(true);
        setMissionInfo(data.missionInfo ?? null);
      }).catch(() => {});
    } else if (!greeting?.messages?.length) {
      safeReload();
    }
    if (!isGroup) {
      loadCharacterName();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const loadCharacterName = async () => {
    try {
      const data = await api.getMapNpcs();
      for (const loc of Object.values(data.locations)) {
        const npc = loc.find(n => n.characterId === characterId);
        if (npc) { setNpcName(npc.name); break; }
      }
    } catch { /* ignore */ }
  };

  // 包装 handleSend 以保留原始 alert 错误处理
  const onSend = async () => {
    try {
      await handleSend();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const handleAddFriend = async () => {
    if (addingFriend) return;
    setAddingFriend(true);
    try {
      await api.addFriend(sessionId);
      setIsFriend(true);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setAddingFriend(false);
    }
  };

  // 包装 undo / retry / nudge 以保留原始 alert 错误处理
  const onUndo = async () => {
    try {
      await handleUndo();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const onRetry = async () => {
    try {
      await handleRetry();
    } catch (err) {
      alert((err as Error).message);
      safeReload();
    }
  };

  const onNudge = async () => {
    try {
      await handleNudge();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const onEnd = async () => {
    try {
      await handleEnd(onBack);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  // NPC 主动消息：用户闲置时触发（仅单聊）
  usePresence('conversation', { sessionId, characterId }, async (proactiveMsgs) => {
    if (isGroup) return;
    await revealProactive(
      proactiveMsgs.map(m => ({
        id: m.id, text: m.text,
        internal: m.internal,
        internal_notable: m.internal_notable,
      })),
    );
  });

  // typing 指示器：greeting 期间或 hook 的 sending/retrying/nudging
  const showTyping = greetingTyping || sending || retrying || nudging;

  return (
    <div className="id-chat-view">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">{npcName}</span>
        {!isGroup && (
          <button className="id-appbar-action" onClick={() => setShowEdit(true)} title="编辑角色">✏️</button>
        )}
        {!isGroup && friendLoaded && !isFriend && (
          <button className="id-appbar-action" onClick={handleAddFriend} disabled={addingFriend}>
            {addingFriend ? '…' : '加好友'}
          </button>
        )}
        {!isGroup && friendLoaded && isFriend && (
          <span className="id-appbar-action id-appbar-action-done">✓ 好友</span>
        )}
        <button className="id-appbar-action id-appbar-action-danger" onClick={() => setShowEndModal(true)} disabled={ending}>
          {ending ? '…' : '结束'}
        </button>
      </div>

      {/* 任务横幅 */}
      {missionInfo && (
        <div className="id-mission-banner" onClick={() => setShowMissionDetail(!showMissionDetail)}>
          <span className="id-mission-banner-icon">🌍</span>
          <div className="id-mission-banner-info">
            <div className="id-mission-banner-world">{missionInfo.worldName}</div>
            <div className="id-mission-banner-goal">回收：{missionInfo.item.length > 20 ? missionInfo.item.slice(0, 20) + '…' : missionInfo.item}</div>
          </div>
          <span className="id-mission-banner-toggle">{showMissionDetail ? '▲' : '▼'}</span>
        </div>
      )}
      {missionInfo && showMissionDetail && (
        <div className="id-mission-detail">
          <div className="id-mission-detail-row">
            <span className="id-mission-detail-label">世界</span>
            <span>{missionInfo.worldName}</span>
          </div>
          <div className="id-mission-detail-row">
            <span className="id-mission-detail-label">目标</span>
            <span>{missionInfo.item}</span>
          </div>
          <div className="id-mission-detail-row">
            <span className="id-mission-detail-label">简报</span>
            <span>{missionInfo.briefing}</span>
          </div>
        </div>
      )}

      <div className="id-chat-messages">
        {messages.length === 0 ? (
          <div className="id-empty"><span>👋</span><span>打个招呼吧</span></div>
        ) : (
          messages.map((msg, i) => {
            const isLastNpc = msg.role === 'npc' && !messages.slice(i + 1).some(m => m.role === 'npc');
            const isLastPlayer = msg.role === 'player' && !messages.slice(i + 1).some(m => m.role === 'player');
            return (
            <div key={msg.id}>
              {msg.role === 'narration' ? (
                <div className="id-narration">
                  <div className="id-narration-line" />
                  <div className="id-narration-text">{msg.text}</div>
                  <div className="id-narration-line" />
                </div>
              ) : msg.role === 'quest_npc' ? (
                <div className="id-quest-npc-bubble">
                  {renderTextWithActions(msg.text)}
                </div>
              ) : (
              <>
              <div className={`id-bubble-row ${msg.role}`}>
                <div>
                  {isGroup && msg.role === 'npc' && msg.speaker && (
                    <div className="id-bubble-speaker">{msg.speakerName ?? 'NPC'}</div>
                  )}
                  <div className={`id-bubble ${msg.role}`}>
                    {msg.image_path && (
                      <img
                        src={imageUrl(msg.image_path)}
                        alt="图片"
                        className="id-bubble-image"
                        loading="lazy"
                        onClick={(e) => (e.target as HTMLImageElement).classList.toggle('id-bubble-image-expanded')}
                      />
                    )}
                    {(msg as any).metadata && (() => { try { const q = JSON.parse((msg as any).metadata).quote; return q ? <div className="id-bubble-quote"><span className="id-bubble-quote-name">{q.senderName}</span><span className="id-bubble-quote-text">{q.text}</span></div> : null; } catch { return null; } })()}
                    {msg.text && renderTextWithActions(msg.text)}
                  </div>
                </div>
              </div>
              {msg.role === 'npc' && msg.internal && msg.internal_notable && (
                <div>
                  <button className="id-internal-btn" onClick={() => setShowInternal(showInternal === msg.id ? null : msg.id)}>
                    ⚡ {showInternal === msg.id ? '收起心声' : '心声'}
                  </button>
                  {showInternal === msg.id && <div className="id-internal-text">{msg.internal}</div>}
                </div>
              )}
              <div className="id-bubble-actions">
                <button className="id-bubble-action-btn" onClick={() => handleCopy(msg.text)}>
                  {copiedId === msg.text ? '✓ 已复制' : '复制'}
                </button>
                <button className="id-bubble-action-btn" onClick={() => {
                  const speakerName: string = msg.role === 'player' ? '我'
                    : isGroup ? (msg.speakerName ?? 'NPC')
                    : (npcName || 'NPC');
                  setQuotingMsg({ id: msg.id, text: msg.text, senderName: speakerName });
                  inputRef.current?.focus();
                }}>
                  引用
                </button>
                {!isGroup && isLastNpc && !sending && !retrying && !nudging && (
                  <>
                    <button className="id-bubble-action-btn" onClick={onNudge} disabled={nudging}>
                      继续
                    </button>
                    <button className="id-bubble-action-btn" onClick={onRetry} disabled={retrying}>
                      重试
                    </button>
                  </>
                )}
                {!isGroup && isLastPlayer && !sending && !undoing && (
                  <button className="id-bubble-action-btn id-bubble-action-danger" onClick={onUndo} disabled={undoing}>
                    撤回
                  </button>
                )}
              </div>
              </>
              )}
            </div>
            );
          })
        )}
        {showTyping && (
          <div className="id-typing-dots"><span /><span /><span /></div>
        )}
        {sceneConcluded && !sending && !retrying && !nudging && (
          <div className="id-scene-concluded">
            <span className="id-scene-concluded-text">对话已自然结束</span>
            <button className="id-bubble-action-btn" onClick={() => setShowEndModal(true)} disabled={ending}>
              结束约会
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
        <button className="id-chat-bracket-btn" onClick={insertBrackets} disabled={sending} title="插入括号">
          （）
        </button>
        {!isGroup && (
          <ImageUploadButton
            onUploaded={(p) => setPendingImage(p)}
            onClear={() => setPendingImage(null)}
            disabled={sending}
          />
        )}
        <input
          ref={inputRef}
          className="id-chat-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSend()}
          placeholder="输入消息…"
          disabled={sending}
        />
        <button className="id-chat-send-btn" onClick={onSend} disabled={sending || (!input.trim() && (!pendingImage || isGroup))}>
          ➤
        </button>
      </div>

      {!isGroup && showEdit && (
        <CharacterEditModal
          characterId={characterId!}
          onClose={() => setShowEdit(false)}
          onSaved={() => safeReload()}
        />
      )}

      {showEndModal && (
        <div className="id-modal-overlay" onClick={() => setShowEndModal(false)}>
          <div className="id-modal" onClick={(e) => e.stopPropagation()}>
            <div className="id-modal-title">结束约会？</div>
            <div className="id-modal-desc">
              结束后这段对话将被收尾归档，你可以随时再发起下一次约会。
            </div>
            <div className="id-modal-actions">
              <button className="id-btn danger" onClick={onEnd} disabled={ending}>
                {ending ? '结束中…' : '确认结束'}
              </button>
              <button className="id-btn" onClick={() => setShowEndModal(false)} disabled={ending}>
                继续对话
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
