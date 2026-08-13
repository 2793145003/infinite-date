import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { StatsConfigItem } from '../lib/api';
import type { View } from '../App';
import { renderTextWithActions } from '../lib/text-render';
import { useChatMessages, type ChatMessage, type SendResponseLike, type NpcResponseLike } from '../hooks/useChatMessages';

interface ScenarioMessage extends ChatMessage {
  role: string; // 'player' | 'assistant' | 'narration' 等
}

export function ScenarioConversation({
  scenarioSessionId,
  onBack,
  onNavigate,
}: {
  scenarioSessionId: string;
  onBack: () => void;
  onNavigate: (view: View) => void;
}) {
  const [statsState, setStatsState] = useState<Record<string, number>>({});
  const [statsConfig, setStatsConfig] = useState<StatsConfigItem[]>([]);
  const [goalAchieved, setGoalAchieved] = useState(false);
  const [ended, setEnded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scenarioTitle, setScenarioTitle] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  const [participants, setParticipants] = useState<{ characterId: string; name: string }[]>([]);

  // 组件特有的 loadMessages：映射后端消息并设置 scenario 特有状态
  const loadMessagesCb = useCallback(async (): Promise<ScenarioMessage[]> => {
    const data = await api.getScenarioMessages(scenarioSessionId);
    setStatsState(data.statsState);
    setStatsConfig(data.statsConfig);
    setGoalAchieved(data.goalAchieved);
    setEnded(data.ended);
    setScenarioTitle(data.scenario.title);
    setCharacterName(data.characterName);
    setIsGroup(data.isGroup);
    if (data.participants) setParticipants(data.participants);
    const parts = data.participants ?? [];
    return data.messages.map(m => {
      const sp = m.speaker ?? null;
      return {
        id: m.id,
        role: m.role,
        text: m.text,
        speaker: sp,
        speakerName: sp ?? undefined,
        internal: m.internal ?? '',
        internal_notable: !!m.internal_notable,
        internal_viewed: !!m.internal_viewed,
        created_at: m.created_at,
      };
    });
  }, [scenarioSessionId]);

  // 发送/重试/戳一下成功后更新 stats
  const onSendResponse = useCallback((data: NpcResponseLike) => {
    if (data.stats) {
      setStatsState(data.stats.stats);
      if (data.stats.goal_achieved) setGoalAchieved(true);
    }
  }, []);

  const chat = useChatMessages<ScenarioMessage>({
    npcRole: 'assistant',
    playerRole: 'player',
    loadMessages: loadMessagesCb,
    sendMessage: (text, _imagePath, quoteId, quoteText, quoteSenderName) => api.scenarioSend(scenarioSessionId, text, quoteId, quoteText, quoteSenderName) as Promise<SendResponseLike>,
    undo: () => api.scenarioUndo(scenarioSessionId),
    retry: () => api.scenarioRetry(scenarioSessionId) as Promise<NpcResponseLike>,
    nudge: () => api.scenarioNudge(scenarioSessionId) as Promise<NpcResponseLike>,
    endSession: () => api.endScenario(scenarioSessionId),
    onSendResponse,
    attachInternalToFirst: !isGroup,
  });

  const {
    messages,
    input, setInput,
    sending,
    copiedId, showInternal, setShowInternal,
    undoing, retrying, nudging,
    showEndModal, setShowEndModal, ending,
    endRef, inputRef,
    reload, insertBrackets, handleCopy,
    handleSend, handleUndo, handleRetry, handleNudge, handleEnd,
    quotingMsg, setQuotingMsg,
  } = chat;

  // 初始加载
  useEffect(() => {
    (async () => {
      try {
        await reload();
      } catch {
        setError('加载失败');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioSessionId]);

  // 包装 handleSend 以保留原始 error 状态设置
  const onSend = async () => {
    if (ended) return;
    setError('');
    try {
      await handleSend();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    }
  };

  // 包装 undo / retry / nudge 以保留原始 alert 错误处理
  const onUndo = async () => {
    if (ended) return;
    try {
      await handleUndo();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const onRetry = async () => {
    if (ended) return;
    try {
      await handleRetry();
    } catch (err) {
      alert((err as Error).message);
      try { await reload(); } catch { setError('加载失败'); }
    }
  };

  const onNudge = async () => {
    if (ended) return;
    try {
      await handleNudge();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const onEnd = async () => {
    try {
      await handleEnd(onBack);
    } catch {
      setError('结束失败');
    }
  };

  if (loading) return <div className="id-app"><div className="id-empty">加载中...</div></div>;

  return (
    <div className="id-chat-view">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">{scenarioTitle}</span>
        <span className="id-scenario-char-name">{isGroup && participants.length > 0 ? participants.map(p => p.name).join(' & ') : characterName}</span>
        {!ended && (
          <button className="id-appbar-action id-appbar-action-danger" onClick={() => setShowEndModal(true)} disabled={ending}>
            {ending ? '…' : '结束'}
          </button>
        )}
      </div>

      {/* 数值面板 */}
      {statsConfig.length > 0 && (
        <div className="id-stats-panel">
          {statsConfig.map(s => {
            const val = statsState[s.name] ?? s.initial;
            const isTarget = s.target != null;
            const achieved = isTarget && val >= (s.target ?? 0);
            return (
              <div key={s.name} className={`id-stat-bar ${achieved ? 'achieved' : ''}`}>
                <span className="id-stat-name">{s.name}</span>
                <span className="id-stat-value">{val}{isTarget ? `/${s.target}` : ''}</span>
              </div>
            );
          })}
        </div>
      )}

      {goalAchieved && <div className="id-goal-achieved-banner">目标达成！</div>}

      <div className="id-chat-messages">
        {messages.length === 0 ? (
          <div className="id-empty"><span>🎭</span><span>剧本开始了</span></div>
        ) : (
          messages.map((msg, i) => {
            const isLastNpc = msg.role === 'assistant' && !messages.slice(i + 1).some(m => m.role === 'assistant');
            const isLastPlayer = msg.role === 'player' && !messages.slice(i + 1).some(m => m.role === 'player');
            return (
            <div key={msg.id}>
              {msg.role === 'narration' ? (
                <div className="id-narration">
                  <div className="id-narration-line" />
                  <div className="id-narration-text">{renderTextWithActions(msg.text)}</div>
                  <div className="id-narration-line" />
                </div>
              ) : (
              <>
              <div className={`id-bubble-row ${msg.role === 'player' ? 'player' : 'npc'}`}>
                <div>
                  {isGroup && msg.role === 'assistant' && msg.speaker && (
                    <div className="id-bubble-speaker">{msg.speakerName ?? 'NPC'}</div>
                  )}
                  <div className={`id-bubble ${msg.role === 'player' ? 'player' : 'npc'}`}>
                    {(msg as any).metadata && (() => { try { const q = JSON.parse((msg as any).metadata).quote; return q ? <div className="id-bubble-quote"><span className="id-bubble-quote-name">{q.senderName}</span><span className="id-bubble-quote-text">{q.text}</span></div> : null; } catch { return null; } })()}
                    {renderTextWithActions(msg.text)}
                  </div>
                </div>
              </div>
              {msg.role === 'assistant' && msg.internal && msg.internal_notable && (
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
                    : (characterName || 'NPC');
                  setQuotingMsg({ id: msg.id, text: msg.text, senderName: speakerName });
                  inputRef.current?.focus();
                }}>
                  引用
                </button>
                {!isGroup && isLastNpc && !sending && !retrying && !nudging && !ended && (
                  <>
                    <button className="id-bubble-action-btn" onClick={onNudge} disabled={nudging}>
                      继续
                    </button>
                    <button className="id-bubble-action-btn" onClick={onRetry} disabled={retrying}>
                      重试
                    </button>
                  </>
                )}
                {!isGroup && isLastPlayer && !sending && !undoing && !ended && (
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
        {(sending || retrying || nudging) && (
          <div className="id-typing-dots"><span /><span /><span /></div>
        )}
        {ended && !sending && (
          <div className="id-scene-concluded">
            <span className="id-scene-concluded-text">剧本已结束</span>
            <button className="id-bubble-action-btn" onClick={() => onNavigate({ type: 'scenario-dream', scenarioSessionId })}>
              查看梦
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <div className="id-error-text">{error}</div>}

      {!ended && (
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
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onSend()}
            placeholder="输入消息…"
            disabled={sending}
          />
          <button className="id-chat-send-btn" onClick={onSend} disabled={sending || !input.trim() || ended}>
            ➤
          </button>
        </div>
      )}

      {showEndModal && (
        <div className="id-modal-overlay" onClick={() => setShowEndModal(false)}>
          <div className="id-modal" onClick={e => e.stopPropagation()}>
            <div className="id-modal-title">结束剧本？</div>
            <div className="id-modal-desc">
              结束后这段对话将被收尾，NPC将进入梦境回顾这段经历。
            </div>
            <div className="id-modal-actions">
              <button className="id-btn danger" onClick={onEnd} disabled={ending}>
                {ending ? '结束中…' : '确认结束'}
              </button>
              <button className="id-btn" onClick={() => setShowEndModal(false)} disabled={ending}>
                继续剧本
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
