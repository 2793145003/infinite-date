import { useState, useEffect, useRef, useCallback } from 'react';
import { api, imageUrl, type StatsConfigItem } from '../lib/api';
import { renderTextWithActions } from '../lib/text-render';

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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
  sessionId,
  onBack,
  onBackToMissions,
}: {
  sessionId: string;
  onBack: () => void;
  onBackToMissions: () => void;
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
  const [ended, setEnded] = useState(false);
  const [sceneType, setSceneType] = useState<string>('scenario');

  const [participants, setParticipants] = useState<Array<{ characterId: string; name: string; avatar: string; isFriend: boolean }>>([]);
  const [avatarByName, setAvatarByName] = useState<Record<string, string>>({});

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

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, sending, showTyping]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.sceneScenarioGet(sessionId);
        if (cancelled) return;
        const msgs = data.messages.map(toLine);
        setLines(msgs);
        setStatsConfig(data.statsConfig);
        setStatsState(data.statsState);
        setGoalAchieved(data.goalAchieved);
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

        const hasCharacterMsg = msgs.some(m => m.kind === 'character');
        if (!hasCharacterMsg && !data.ended) {
          setShowTyping(true);
          try {
            const done = await api.sceneScenarioContinueStream(sessionId, (b) => appendBeat(b));
            if (done) {
              setStatsState(done.stats ?? {});
              if (done.goalAchieved) setGoalAchieved(true);
            }
          } catch {
            // 自动开场失败不报错
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
  }, [sessionId, appendBeat]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    setError('');
    setShowTyping(true);
    setLines(prev => [...prev, { id: nextId(), kind: 'player', speaker: '我', content: text, time: Date.now() }]);
    try {
      const done = await api.sceneScenarioAdvanceStream(sessionId, text, (b) => appendBeat(b));
      if (done) {
        setStatsState(done.stats ?? {});
        if (done.statsChanges?.length) {
          setStatsChanges(done.statsChanges.map((c, i) => ({ ...c, reason: done.statsChangeReasons?.[i]?.reason })));
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

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    setError('');
    setShowTyping(true);
    setLines(prev => {
      const lastPlayerIdx = [...prev].reverse().findIndex(l => l.kind === 'player');
      if (lastPlayerIdx >= 0) {
        const cutIdx = prev.length - lastPlayerIdx;
        return prev.slice(0, cutIdx);
      }
      const firstRound1Idx = prev.findIndex((l, i) => i > 0 && l.kind === 'narration');
      if (firstRound1Idx > 0) return prev.slice(0, firstRound1Idx);
      return prev;
    });
    try {
      const done = await api.sceneScenarioRetryStream(sessionId, (b) => appendBeat(b));
      if (done) {
        setStatsState(done.stats ?? {});
        if (done.statsChanges?.length) {
          setStatsChanges(done.statsChanges.map((c, i) => ({ ...c, reason: done.statsChangeReasons?.[i]?.reason })));
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

  const handleUndo = async () => {
    try {
      const res = await api.sceneScenarioUndo(sessionId);
      if (res.ok) {
        const data = await api.sceneScenarioGet(sessionId);
        setLines(data.messages.map(toLine));
        setStatsState(data.statsState);
      }
    } catch (e: any) {
      setError(e?.message ?? '撤回失败');
    }
  };

  const handleEnd = async () => {
    setEnding(true);
    try {
      if (sceneType === 'mission') {
        await api.endMission(sessionId);
      } else {
        await api.sceneScenarioEnd(sessionId);
      }
      setEnded(true);
      setShowEndModal(false);
    } catch (e: any) {
      setError(e?.message ?? '结束失败');
    } finally {
      setEnding(false);
    }
  };

  const handleContinue = async () => {
    if (sending) return;
    setSending(true);
    setError('');
    setShowTyping(true);
    try {
      const done = await api.sceneScenarioContinueStream(sessionId, (b) => appendBeat(b));
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
  const canUndo = lines.some(l => l.kind === 'player') && !sending;

  if (loading) return <div className="flex h-full items-center justify-center text-ink-soft">加载中…</div>;
  if (error && !lines.length) return <div className="flex h-full items-center justify-center text-ink-soft">{error}</div>;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-border frosted-glass px-3 py-3">
        <button className="text-ink-soft" onClick={onBack}>←</button>
        <span className="font-semibold text-ink">{title}</span>
        {sceneType === 'mission' && missionTitle ? (
          <span className="flex-1 truncate text-xs text-rose" style={{ cursor: 'pointer' }} onClick={() => setShowMissionInfo(true)} title="点击查看任务信息">
            {goalAchieved ? '✓ ' : ''}{missionTitle.replace(/^世界任务：/, '')}
          </span>
        ) : goal ? (
          <span className="flex-1 truncate text-xs text-ink-faint">{goalAchieved ? '✓ 达成' : goal.length > 12 ? goal.slice(0, 12) + '…' : goal}</span>
        ) : <span className="flex-1" />}
        {!ended && (
          <button className="rounded px-2 py-1 text-xs text-rose" onClick={() => setShowEndModal(true)} disabled={ending}>
            {ending ? '…' : '结束'}
          </button>
        )}
      </div>

      {/* 数值面板 */}
      {statsConfig.length > 0 && (
        <div className="flex shrink-0 gap-3 overflow-x-auto border-b border-border frosted-glass px-3 py-2 text-xs">
          {statsConfig.map(s => {
            const val = statsState[s.name] ?? s.initial;
            const change = statsChanges.find(c => c.name === s.name);
            const changed = !!change;
            const target = s.target;
            return (
              <div key={s.name} className="shrink-0 rounded-md px-2 py-0.5" style={{ background: changed ? 'var(--color-bg-muted)' : 'transparent', transition: 'background 0.3s' }}>
                <span className="text-ink-faint">{s.name}：</span>
                <span className="font-bold" style={{ color: changed ? (change.after > change.before ? 'var(--color-rose)' : 'var(--color-sage)') : 'var(--color-ink)' }}>
                  {val}
                </span>
                {target != null && <span className="text-ink-faint" style={{ fontSize: '0.65rem' }}>/ {target}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto px-3 py-3" ref={messagesRef}>
        {lines.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-ink-faint">
            <span className="text-3xl">🎬</span>
            <span>剧本开始</span>
          </div>
        ) : (
          lines.map((l, idx) => (
            <div key={l.id}>
              {l.kind === 'ambient' && (
                <div className="py-0.5 text-center text-xs italic text-ink-faint" style={{ opacity: 0.7 }}>{l.content}</div>
              )}

              {l.kind === 'narration' && (
                <div>
                  <div className="my-2 flex items-center gap-2">
                    <div className="h-px flex-1 bg-bg-muted-2/50" />
                    <div className="max-w-[80%] text-center text-sm text-ink-soft">{renderTextWithActions(l.content)}</div>
                    <div className="h-px flex-1 bg-bg-muted-2/50" />
                  </div>
                  {idx === lines.length - 1 && !sending && !retrying && !ended && (
                    <div className="mb-1 flex justify-center gap-2 text-xs text-rose">
                      <button onClick={handleContinue} disabled={sending}>继续</button>
                      <button onClick={handleRetry} disabled={retrying}>重试</button>
                    </div>
                  )}
                </div>
              )}

              {(l.kind === 'player' || l.kind === 'character') && (
                <>
                  <div className={`my-1 flex ${l.kind === 'player' ? 'justify-end' : 'justify-start'}`}>
                    {l.kind !== 'player' && (
                      <div className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-bg-muted-2/50 text-sm text-ink-soft">
                        {l.speaker && avatarByName[l.speaker]
                          ? <img src={imageUrl(avatarByName[l.speaker]!)} alt="" className="h-full w-full object-cover" />
                          : (l.speaker ? l.speaker.charAt(0) : '?')}
                      </div>
                    )}
                    <div className={`max-w-[75%] ${l.kind === 'player' ? 'items-end' : 'items-start'}`}>
                      {l.kind !== 'player' && l.speaker && (
                        <div className="mb-0.5 text-xs text-ink-faint">{l.speaker}</div>
                      )}
                      <div
                        className={`rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                          l.kind === 'player'
                            ? 'rounded-br-sm bg-bg-rose-soft/70 text-ink'
                            : 'rounded-bl-sm frosted-glass text-ink border border-border'
                        }`}
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
                  <div className={`mb-1 flex gap-2 text-xs text-ink-faint ${l.kind === 'player' ? 'justify-end' : 'justify-start ml-10'}`}>
                    <button onClick={() => { navigator.clipboard?.writeText(l.content); setCopiedId(l.id); setTimeout(() => setCopiedId(null), 1500); }}>
                      {copiedId === l.id ? '✓ 已复制' : '复制'}
                    </button>
                    {idx === lines.length - 1 && !sending && !retrying && !ended && (
                      <>
                        <button onClick={handleContinue} disabled={sending}>继续</button>
                        <button onClick={handleRetry} disabled={retrying}>重试</button>
                      </>
                    )}
                    {l.kind === 'player' && !sending && !retrying && (
                      <button onClick={handleUndo} disabled={sending}>撤回</button>
                    )}
                  </div>
                  {l.kind !== 'player' && l.internal && l.internalNotable && (
                    <div className="mb-1 ml-10">
                      <button className="text-xs text-rose" onClick={() => setShowInternal(showInternal === l.id ? null : l.id)}>
                        ⚡ {showInternal === l.id ? '收起心声' : '心声'}
                      </button>
                      {showInternal === l.id && (
                        <div className="mt-1 rounded-lg bg-bg-rose-soft/60 px-3 py-2 text-sm text-ink-soft">{renderTextWithActions(l.internal)}</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          ))
        )}
        {showTyping && (
          <div className="flex gap-1 py-1">
            {[0, 1, 2].map(i => <span key={i} className="fish-typing-dot" />)}
          </div>
        )}
      </div>

      {error && <div className="px-3 pb-1 text-xs text-rose">{error}</div>}

      {/* 底部操作栏 */}
      {!ended ? (
        <div className="flex items-center gap-2 border-t border-border frosted-glass px-3 pt-2 pb-[81px]">
          <button className="rounded border border-border px-2 py-2 text-sm text-ink-soft" onClick={insertBrackets} disabled={sending} title="插入括号">（）</button>
          <input
            ref={inputRef}
            className="flex-1 rounded-full border border-border frosted-glass/70 px-3 py-2 text-sm text-ink outline-none"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={sending ? '生成中…' : '输入消息…'}
            disabled={sending}
          />
          <button className="rounded-full bg-rose px-4 py-2 text-sm font-semibold text-ink-on" onClick={handleSend} disabled={sending || !input.trim()}>➤</button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 border-t border-border frosted-glass px-4 pt-4 pb-[81px]">
          <div className="text-sm font-semibold text-ink">
            {sceneType === 'mission' ? '任务已结束' : '剧本已结束'}{goalAchieved ? ' · 目标达成 ✓' : ''}
          </div>
          <button className="rounded-lg bg-rose px-5 py-2 text-sm text-ink-on" onClick={sceneType === 'mission' ? onBackToMissions : onBack}>
            {sceneType === 'mission' ? '返回任务列表' : '返回剧本列表'}
          </button>
        </div>
      )}

      {/* 结束弹窗 */}
      {showEndModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-6" onClick={() => setShowEndModal(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-panel p-5" onClick={e => e.stopPropagation()}>
            <div className="mb-2 text-base font-semibold text-ink">{sceneType === 'mission' ? '结束任务？' : '结束剧本？'}</div>
            <div className="mb-4 text-sm text-ink-soft" style={{ lineHeight: 1.5 }}>
              {sceneType === 'mission' ? '结束后会结算任务，评级并发放奖励。' : '结束后 NPC 会做梦，梦里会记得你们在剧本里经历的事。'}
            </div>
            <div className="flex flex-col gap-2">
              <button className="rounded-lg bg-rose py-2 text-sm text-ink-on" onClick={handleEnd} disabled={ending}>
                {ending ? '结束中…' : '确认结束'}
              </button>
              <button className="rounded-lg border border-border py-2 text-sm text-ink-soft" onClick={() => setShowEndModal(false)} disabled={ending}>继续剧本</button>
            </div>
          </div>
        </div>
      )}

      {/* 任务信息弹窗 */}
      {showMissionInfo && missionInfo && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-6" onClick={() => setShowMissionInfo(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-panel p-5" onClick={e => e.stopPropagation()}>
            <div className="mb-2 text-base font-semibold text-ink">{missionTitle || '任务信息'}</div>
            <div className="max-h-[60vh] overflow-y-auto text-left text-sm text-ink-soft" style={{ lineHeight: 1.6 }}>
              {playerRole && <div className="mb-2"><strong className="text-ink">🧭 玩家身份</strong><br />{playerRole}</div>}
              {companionRole && <div className="mb-2"><strong className="text-ink">💞 同行者身份</strong><br />{companionRole}</div>}
              {missionInfo.briefing && <div className="mb-2"><strong className="text-ink">任务简报</strong><br />{missionInfo.briefing}</div>}
              {missionInfo.worldTension && <div className="mb-2"><strong className="text-ink">⚡ 世界困境</strong><br />{missionInfo.worldTension}</div>}
              {missionInfo.targetState && <div className="mb-2"><strong className="text-ink">🎯 目标态</strong><br />{missionInfo.targetState}</div>}
              {(missionInfo.landmarks ?? []).length > 0 && (
                <div className="mb-2"><strong className="text-ink">📍 地标</strong>{missionInfo.landmarks!.map((l, i) => <div key={i}>{l.name}：{l.feature}</div>)}</div>
              )}
              {(missionInfo.coreNpcs ?? []).length > 0 && (
                <div className="mb-2"><strong className="text-ink">👤 核心对象</strong>{missionInfo.coreNpcs!.map((n, i) => <div key={i}>{n.name}：{n.persona}</div>)}</div>
              )}
              {missionInfo.missionGoal && <div className="mb-2"><strong className="text-ink">玩法目标</strong><br />{missionInfo.missionGoal}</div>}
            </div>
            <button className="mt-3 w-full rounded-lg bg-rose py-2 text-sm text-ink-on" onClick={() => setShowMissionInfo(false)}>知道了</button>
          </div>
        </div>
      )}
    </div>
  );
}
