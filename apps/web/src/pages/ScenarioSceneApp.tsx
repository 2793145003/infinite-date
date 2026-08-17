import { useState, useEffect, useRef, useCallback } from 'react';
import { api, imageUrl } from '../lib/api';
import { renderTextWithActions } from '../lib/text-render';
import type { View } from '../App';

interface Line {
  id: string;
  kind: 'narration' | 'character' | 'player' | 'ambient';
  speaker?: string;
  characterId?: string;
  content: string;
  round_no?: number;
  time?: number;
  internal?: string;
  internalNotable?: boolean;
}

interface StatsConfigItem {
  name: string;
  initial: number;
  rules: string;
  target?: number | null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const formatTime = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function toLine(m: any): Line {
  const isAmbient = m.role === 'narration' && m.character_name === '气氛组';
  const kind = isAmbient ? 'ambient' as const
    : m.role === 'player' ? 'player' as const
    : m.role === 'narration' ? 'narration' as const
    : 'character' as const;
  const ts = typeof m.created_at === 'number' ? m.created_at : typeof m.created_at === 'string' ? Number(m.created_at) : undefined;
  return {
    id: m.id ?? `${kind}-${m.character_name}-${m.text}`,
    kind,
    speaker: kind === 'narration' || kind === 'ambient' ? undefined : (m.character_name || (kind === 'player' ? '我' : '角色')),
    characterId: m.character_id ?? undefined,
    content: m.text,
    round_no: m.round_no,
    time: ts && !Number.isNaN(ts) ? ts : undefined,
    internal: kind === 'character' ? (m.internal ?? '') : '',
    internalNotable: kind === 'character' ? !!m.internal_notable : false,
  };
}

export function ScenarioSceneApp({
  scenarioSessionId,
  onBack,
  onNavigate,
}: {
  scenarioSessionId: string;
  onBack: () => void;
  onNavigate: (v: View) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [ending, setEnding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState<string | null>(null);
  const [showEndModal, setShowEndModal] = useState(false);
  const [showTyping, setShowTyping] = useState(false);

  // 剧本元数据
  const [title, setTitle] = useState('剧本');
  const [goal, setGoal] = useState('');
  const [missionTitle, setMissionTitle] = useState('');
  const [missionInfo, setMissionInfo] = useState<{ briefing?: string; worldTension?: string; targetState?: string; missionGoal?: string; worldName?: string; landmarks?: { name: string; feature: string }[]; coreNpcs?: { role: string; name: string; persona: string }[] } | null>(null);
  const [playerRole, setPlayerRole] = useState('');
  const [companionRole, setCompanionRole] = useState('');
  const [showMissionInfo, setShowMissionInfo] = useState(false);
  const [goalAchieved, setGoalAchieved] = useState(false);
  const [statsConfig, setStatsConfig] = useState<StatsConfigItem[]>([]);
  const [statsState, setStatsState] = useState<Record<string, number>>({});
  const [statsChanges, setStatsChanges] = useState<Array<{ name: string; before: number; after: number; reason?: string }>>([]);
  const [dreamText, setDreamText] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [sceneType, setSceneType] = useState<string>('scenario');

  // 参与者
  const [participants, setParticipants] = useState<Array<{ characterId: string; name: string; avatar: string; isFriend: boolean }>>([]);
  const [avatarByName, setAvatarByName] = useState<Record<string, string>>({});

  const endRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);
  const lastBeatRef = useRef(0);
  const nextId = useCallback(() => `l${++idRef.current}`, []);

  const BEAT_MS = 600;
  const appendBeat = useCallback(async (b: { kind: string; speaker?: string; content: string; characterId?: string; internal?: string; internalNotable?: boolean }) => {
    const now = Date.now();
    const elapsed = now - lastBeatRef.current;
    if (lastBeatRef.current && elapsed < BEAT_MS) await sleep(BEAT_MS - elapsed);
    lastBeatRef.current = Date.now();
    const isAmbient = b.speaker === '气氛组';
    const isNarration = b.kind === 'narration';
    setLines(prev => [...prev, {
      id: nextId(),
      kind: isAmbient ? 'ambient' : isNarration ? 'narration' : 'character',
      speaker: isAmbient || isNarration ? undefined : (b.speaker ?? '角色'),
      characterId: b.characterId,
      content: b.content,
      time: Date.now(),
      internal: isNarration || isAmbient ? '' : (b.internal ?? ''),
      internalNotable: isNarration || isAmbient ? false : !!b.internalNotable,
    }]);
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [nextId]);

  // 滚动到最新：直接钉到底（和约会一致），不用 scrollIntoView smooth 避免"从头滚下来"
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, sending, showTyping]);

  // 加载剧本会话
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.sceneScenarioGet(scenarioSessionId);
        if (cancelled) return;
        const msgs = data.messages.map(toLine);
        setLines(msgs);
        setStatsConfig(data.statsConfig);
        setStatsState(data.statsState);
        setGoalAchieved(data.goalAchieved);
        setDreamText(data.dreamText);
        setEnded(data.ended);
        setSceneType(data.sceneType ?? 'scenario');
        setGoal(data.goal);
        setMissionTitle(data.missionTitle ?? '');
        setMissionInfo(data.missionInfo ?? null);
        setPlayerRole(data.playerRole ?? '');
        setCompanionRole(data.companionRole ?? '');
        setParticipants(data.participants);
        const avMap: Record<string, string> = {};
        for (const p of data.participants) {
          if (p.avatar) avMap[p.name] = p.avatar;
        }
        setAvatarByName(avMap);
        setLoading(false);

        // 如果没有任何角色消息（只有旁白或空），自动触发 continue 让 NPC 开口
        const hasCharacterMsg = msgs.some(m => m.kind === 'character');
        if (!hasCharacterMsg && !data.ended) {
          setShowTyping(true);
          try {
            const done = await api.sceneScenarioContinueStream(scenarioSessionId, (b) => appendBeat(b));
            if (done) {
              setStatsState(done.stats ?? {});
              if (done.goalAchieved) setGoalAchieved(true);
            }
          } catch {
            // 自动开场失败不报错，玩家可手动继续
          } finally {
            if (!cancelled) setShowTyping(false);
          }
        }
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? '加载失败');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scenarioSessionId]);

  // 发送消息
  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    setError('');
    setShowTyping(true);

    // 玩家气泡先上屏
    setLines(prev => [...prev, { id: nextId(), kind: 'player', speaker: '我', content: text, time: Date.now() }]);

    try {
      const done = await api.sceneScenarioAdvanceStream(scenarioSessionId, text, (b) => appendBeat(b));
      if (done) {
        setStatsState(done.stats ?? {});
        if (done.statsChanges?.length) {
          setStatsChanges(done.statsChanges.map((c, i) => ({
            ...c,
            reason: done.statsChangeReasons?.[i]?.reason,
          })));
          setTimeout(() => setStatsChanges([]), 3000);
        }
        if (done.goalAchieved) setGoalAchieved(true);
      }
    } catch (e: any) {
      setError(e?.message ?? '发送失败');
    } finally {
      setSending(false);
      setShowTyping(false);
    }
  };

  // 重试
  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setError('');
    setShowTyping(true);
    // 对齐约会：有玩家消息 → 保留到玩家最后一条；无玩家消息 → 保留 round 0 开场白，删最后一轮
    setLines(prev => {
      const lastPlayerIdx = [...prev].reverse().findIndex(l => l.kind === 'player');
      if (lastPlayerIdx >= 0) {
        // 有玩家消息：保留到玩家最后一条（含）
        const cutIdx = prev.length - lastPlayerIdx;
        return prev.slice(0, cutIdx);
      }
      // 无玩家消息：保留 round 0（开场白+greeting），删 round 1+ 的内容
      // 找到最后一条 round 0 的位置（旁白或角色消息，在第一条 round 1 之前）
      // 简单处理：保留到第一条 narration 之后的所有 round 0 内容
      const firstRound1Idx = prev.findIndex((l, i) => i > 0 && l.kind === 'narration');
      if (firstRound1Idx > 0) return prev.slice(0, firstRound1Idx);
      return prev; // 兜底：不清空，让后端重试
    });
    try {
      const done = await api.sceneScenarioRetryStream(scenarioSessionId, (b) => appendBeat(b));
      if (done) {
        setStatsState(done.stats ?? {});
        if (done.statsChanges?.length) {
          setStatsChanges(done.statsChanges.map((c, i) => ({
            ...c,
            reason: done.statsChangeReasons?.[i]?.reason,
          })));
          setTimeout(() => setStatsChanges([]), 3000);
        }
        if (done.goalAchieved) setGoalAchieved(true);
      }
    } catch (e: any) {
      setError(e?.message ?? '重试失败');
    } finally {
      setRetrying(false);
      setShowTyping(false);
    }
  };

  // 撤回
  const handleUndo = async () => {
    try {
      const res = await api.sceneScenarioUndo(scenarioSessionId);
      if (res.ok) {
        const data = await api.sceneScenarioGet(scenarioSessionId);
        setLines(data.messages.map(toLine));
        setStatsState(data.statsState);
      }
    } catch (e: any) {
      setError(e?.message ?? '撤回失败');
    }
  };

  // 结束剧本
  const handleEnd = async () => {
    setEnding(true);
    try {
      if (sceneType === 'mission') {
        await api.endMission(scenarioSessionId);
      } else {
        await api.sceneScenarioEnd(scenarioSessionId);
      }
      setEnded(true);
      setShowEndModal(false);
    } catch (e: any) {
      setError(e?.message ?? '结束失败');
    } finally {
      setEnding(false);
    }
  };

  // 继续（无玩家输入）
  const handleContinue = async () => {
    if (sending) return;
    setSending(true);
    setError('');
    setShowTyping(true);
    try {
      const done = await api.sceneScenarioContinueStream(scenarioSessionId, (b) => appendBeat(b));
      if (done) {
        setStatsState(done.stats ?? {});
        if (done.goalAchieved) setGoalAchieved(true);
      }
    } catch (e: any) {
      setError(e?.message ?? '推进失败');
    } finally {
      setSending(false);
      setShowTyping(false);
    }
  };

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

  const lastLine = lines[lines.length - 1];
  const canRetry = !sending && lines.length > 0;
  const canUndo = lines.some(l => l.kind === 'player') && !sending;

  if (loading) return <div className="id-app"><div className="id-loading">加载中…</div></div>;
  if (error && !lines.length) return <div className="id-app"><div className="id-error-text">{error}</div></div>;

  return (
    <div className="id-chat-view">
      {/* 顶栏 */}
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">{title}</span>
        {sceneType === 'mission' && missionTitle ? (
          <span
            className="id-appbar-location"
            style={{ cursor: 'pointer', color: goalAchieved ? 'var(--success)' : undefined }}
            onClick={() => setShowMissionInfo(true)}
            title="点击查看任务信息"
          >
            {goalAchieved ? '✓ ' : ''}{missionTitle.replace(/^世界任务：/, '')}
          </span>
        ) : goal ? (
          <span className="id-appbar-location" style={{ color: goalAchieved ? 'var(--success)' : undefined }}>
            {goalAchieved ? '✓ 达成' : goal.length > 12 ? goal.slice(0, 12) + '…' : goal}
          </span>
        ) : null}
        {!ended && (
          <button className="id-appbar-action id-appbar-action-danger" onClick={() => setShowEndModal(true)} disabled={ending}>
            {ending ? '…' : '结束'}
          </button>
        )}
      </div>

      {/* 数值面板 */}
      {statsConfig.length > 0 && (
        <div style={{
          flexShrink: 0,
          padding: '0.4rem 0.8rem',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border-soft)',
          display: 'flex',
          gap: '0.8rem',
          overflowX: 'auto',
          fontSize: '0.75rem',
          position: 'relative',
          zIndex: 1,
        }}>
          {statsConfig.map(s => {
            const val = statsState[s.name] ?? s.initial;
            const change = statsChanges.find(c => c.name === s.name);
            const changed = !!change;
            const target = s.target;
            return (
              <div key={s.name} style={{
                flexShrink: 0,
                padding: '0.2rem 0.5rem',
                borderRadius: '6px',
                background: changed ? 'var(--overlay-bg)' : 'transparent',
                transition: 'background 0.3s',
              }}>
                <span style={{ color: 'var(--text-mute)' }}>{s.name}：</span>
                <span style={{ fontWeight: 700, color: changed ? (change.after > change.before ? 'var(--success)' : 'var(--danger)') : 'var(--text)' }}>
                  {val}
                </span>
                {target != null && <span style={{ color: 'var(--text-mute)', fontSize: '0.65rem' }}>/ {target}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* 消息区 */}
      <div className="id-chat-messages" ref={messagesRef}>
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : lines.length === 0 ? (
          <div className="id-empty"><span>🎬</span><span>剧本开始</span></div>
        ) : (
          lines.map((l, idx) => (
            <div key={l.id}>
              {/* 气氛组：淡色小字居中 */}
              {l.kind === 'ambient' && (
                <div style={{
                  textAlign: 'center',
                  padding: '0.15rem 0.8rem',
                  fontSize: '0.72rem',
                  color: 'var(--text-dim)',
                  fontStyle: 'italic',
                  opacity: 0.7,
                }}>
                  {l.content}
                </div>
              )}

              {/* 旁白：居中，和约会一样的 id-narration 样式 */}
              {l.kind === 'narration' && (
                <div>
                  <div className="id-narration">
                    <div className="id-narration-line" />
                    <div className="id-narration-text">{renderTextWithActions(l.content)}</div>
                    <div className="id-narration-line" />
                  </div>
                  {idx === lines.length - 1 && !sending && !retrying && !ended && (
                    <div className="id-bubble-actions id-bubble-actions-narr">
                      <button className="id-bubble-action-btn" onClick={handleContinue} disabled={sending}>继续</button>
                      <button className="id-bubble-action-btn" onClick={handleRetry} disabled={retrying}>重试</button>
                    </div>
                  )}
                </div>
              )}

              {/* 玩家 / 角色：气泡，和约会统一 class */}
              {(l.kind === 'player' || l.kind === 'character') && (
                <>
                  <div className={`id-bubble-row ${l.kind === 'player' ? 'player' : 'npc'}`}>
                    {l.kind !== 'player' && (
                      <div className="id-bubble-avatar-col">
                        <div className="id-bubble-chat-avatar">
                          {l.speaker && avatarByName[l.speaker]
                            ? <img src={imageUrl(avatarByName[l.speaker]!)} alt="" className="id-bubble-chat-avatar-img" />
                            : (l.speaker ? l.speaker.charAt(0) : '?')
                          }
                        </div>
                      </div>
                    )}
                    <div className="id-bubble-main">
                      {l.kind !== 'player' && l.speaker && (
                        <div className="id-bubble-speaker">
                          <span className="id-speaker-name">{l.speaker}</span>
                        </div>
                      )}
                      <div
                        className={`id-bubble ${l.kind === 'player' ? 'player' : 'npc'}`}
                        onDoubleClick={() => {
                          navigator.clipboard?.writeText(l.content);
                          setCopiedId(l.id);
                          setTimeout(() => setCopiedId(null), 1500);
                        }}
                      >
                        {renderTextWithActions(l.content)}
                      </div>
                    </div>
                  </div>
                  <div className="id-bubble-actions">
                    <button className="id-bubble-action-btn" onClick={() => {
                      navigator.clipboard?.writeText(l.content);
                      setCopiedId(l.id);
                      setTimeout(() => setCopiedId(null), 1500);
                    }}>
                      {copiedId === l.id ? '✓ 已复制' : '复制'}
                    </button>
                    {idx === lines.length - 1 && !sending && !retrying && !ended && (
                      <>
                        <button className="id-bubble-action-btn" onClick={handleContinue} disabled={sending}>继续</button>
                        <button className="id-bubble-action-btn" onClick={handleRetry} disabled={retrying}>重试</button>
                      </>
                    )}
                    {l.kind === 'player' && !sending && !retrying && (
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

      {/* 底部操作栏 */}
      {!ended ? (
        <div className="id-chat-input-area">
          <button className="id-chat-bracket-btn" onClick={insertBrackets} disabled={sending} title="插入括号">
            （）
          </button>
          <input
            ref={inputRef}
            className="id-chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={sending ? '生成中…' : '输入消息…'}
            disabled={sending}
          />
          <button className="id-chat-send-btn" onClick={handleSend} disabled={sending || !input.trim()}>➤</button>
        </div>
      ) : (
        <div className="id-chat-input-area" style={{ flexDirection: 'column', alignItems: 'center', gap: '0.6rem', background: 'var(--surface)', padding: '1rem 0.8rem' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>
            {sceneType === 'mission' ? '任务已结束' : '剧本已结束'}{goalAchieved ? ' · 目标达成 ✓' : ''}
          </div>
          {sceneType !== 'mission' && dreamText && (
            <div style={{
              fontSize: '0.78rem', color: 'var(--text-dim)', fontStyle: 'italic',
              textAlign: 'center', maxWidth: '92%', lineHeight: 1.6,
              padding: '0.5rem 0.8rem', borderRadius: 'var(--radius-sm)',
              background: 'var(--overlay-bg)',
            }}>
              💭 {dreamText.slice(0, 80)}{dreamText.length > 80 ? '…' : ''}
            </div>
          )}
          <button className="id-btn" style={{ padding: '0.5rem 1.2rem' }} onClick={sceneType === 'mission' ? () => onNavigate({ type: 'missions' }) : onBack}>{sceneType === 'mission' ? '返回任务列表' : '返回剧本列表'}</button>
        </div>
      )}

      {/* 结束剧本弹窗 */}
      {showEndModal && (
        <div className="id-modal-overlay" onClick={() => setShowEndModal(false)}>
          <div className="id-modal" onClick={e => e.stopPropagation()}>
            <div className="id-modal-title">{sceneType === 'mission' ? '结束任务？' : '结束剧本？'}</div>
            <div className="id-modal-desc">
              {sceneType === 'mission'
                ? '结束后会结算任务，评级并发放奖励。'
                : '结束后 NPC 会做梦，梦里会记得你们在剧本里经历的事。'}
            </div>
            <div className="id-modal-actions">
              <button className="id-btn danger" onClick={() => handleEnd()} disabled={ending}>
                {ending ? '结束中…' : '确认结束'}
              </button>
              <button className="id-btn" onClick={() => setShowEndModal(false)} disabled={ending}>
                继续剧本
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 任务信息弹窗 */}
      {showMissionInfo && missionInfo && (
        <div className="id-modal-overlay" onClick={() => setShowMissionInfo(false)}>
          <div className="id-modal" onClick={e => e.stopPropagation()}>
            <div className="id-modal-title">{missionTitle || '任务信息'}</div>
            <div className="id-modal-desc" style={{ textAlign: 'left', maxHeight: '60vh', overflowY: 'auto' }}>
              {playerRole ? (
                <div style={{ marginBottom: '0.8rem' }}><strong>🧭 玩家身份</strong><br />{playerRole}</div>
              ) : null}
              {companionRole ? (
                <div style={{ marginBottom: '0.8rem' }}><strong>💞 同行者身份</strong><br />{companionRole}</div>
              ) : null}
              {missionInfo.briefing ? (
                <div style={{ marginBottom: '0.8rem' }}><strong>任务简报</strong><br />{missionInfo.briefing}</div>
              ) : null}
              {missionInfo.worldTension ? (
                <div style={{ marginBottom: '0.8rem' }}><strong>⚡ 世界困境</strong><br />{missionInfo.worldTension}</div>
              ) : null}
              {missionInfo.targetState ? (
                <div style={{ marginBottom: '0.8rem' }}><strong>🎯 目标态</strong><br />{missionInfo.targetState}</div>
              ) : null}
              {(missionInfo.landmarks ?? []).length > 0 ? (
                <div style={{ marginBottom: '0.8rem' }}>
                  <strong>📍 地标</strong>
                  {missionInfo.landmarks!.map((l, i) => (
                    <div key={i}>{l.name}：{l.feature}</div>
                  ))}
                </div>
              ) : null}
              {(missionInfo.coreNpcs ?? []).length > 0 ? (
                <div style={{ marginBottom: '0.8rem' }}>
                  <strong>👤 核心对象</strong>
                  {missionInfo.coreNpcs!.map((n, i) => (
                    <div key={i}>{n.name}：{n.persona}</div>
                  ))}
                </div>
              ) : null}
              {missionInfo.missionGoal ? (
                <div style={{ marginBottom: '0.8rem' }}><strong>玩法目标</strong><br />{missionInfo.missionGoal}</div>
              ) : null}
            </div>
            <div className="id-modal-actions">
              <button className="id-btn" onClick={() => setShowMissionInfo(false)}>知道了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
