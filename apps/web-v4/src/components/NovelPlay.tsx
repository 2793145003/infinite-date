import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { api, imageUrl, type NovelSessionData, type NovelTurn } from '../lib/api';

// 段落块：memo 化，正文流式续写时只重渲染变化的那一段。
// 否则 200+ 段（20 万字）每收一个 delta 都全量重渲染 + 高频 scrollIntoView，手机主线程卡死。
const TurnBlock = memo(function TurnBlock({ turn, showDivider }: { turn: NovelTurn; showDivider: boolean }) {
  return (
    <div data-turn-id={turn.id}>
      {showDivider && (
        <div className="my-5 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs tracking-[0.4em] text-ink-muted">· · ·</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="space-y-3">
        {turn.text.split(/\n+/).filter(s => s.trim()).map((para, j) => (
          <p
            key={j}
            className="text-[15px] leading-relaxed text-ink whitespace-pre-wrap"
            style={{ textIndent: '2em' }}
          >
            {para}
          </p>
        ))}
      </div>
    </div>
  );
});

export function NovelPlay({
  sessionId,
  onBack,
  onEdit,
}: {
  sessionId: string;
  onBack: () => void;
  onEdit: (novelId: string) => void;
}) {
  const [data, setData] = useState<NovelSessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [polished, setPolished] = useState<string | null>(null);
  const [polishing, setPolishing] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevPolished = useRef<string | null>(null);
  const didInitialScroll = useRef(false);
  const lastScrollAt = useRef(0);

  const loadData = useCallback(async () => {
    try {
      const d = await api.getNovelSession(sessionId);
      setData(d);
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { loadData(); }, [loadData]);

  // 刷新/进入后回到正文底端（最新段落），只做一次，不干扰流式跟随
  useEffect(() => {
    if (!loading && data && !didInitialScroll.current) {
      didInitialScroll.current = true;
      requestAnimationFrame(() => {
        const el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }, [loading, data]);

  // 滚动到指定段（发送后半屏定位 / 流式跟随都用它）
  const scrollToTurn = (turnId: string, block: 'start' | 'center' | 'end' | 'nearest', smooth = true) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
    el?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block });
  };

  // 润色结果出现时滚到底部（露出最新段落，避免遮住）；采用/取消（消失）时不滚，让正文自然降回
  useEffect(() => {
    if (polished && !prevPolished.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevPolished.current = polished;
  }, [polished]);

  const excludedIds = data?.excludedCharIds ?? [];

  const handleToggleExcluded = async (charId: string) => {
    if (!data) return;
    const next = excludedIds.includes(charId)
      ? excludedIds.filter(id => id !== charId)
      : [...excludedIds, charId];
    // 乐观更新
    setData(prev => prev ? { ...prev, excludedCharIds: next } : prev);
    try {
      await api.updateNovelExcluded(sessionId, next);
    } catch (e: any) {
      window.alert(e?.message || '更新出场名单失败');
    }
  };

  const handlePolish = async () => {
    if (!draft.trim()) return window.alert('先写一段再润色');
    setPolishing(true);
    setPolished(null);
    try {
      const { polished: p } = await api.polishNovel(sessionId, draft.trim());
      setPolished(p);
    } catch (e: any) {
      window.alert(e?.message || '润色失败');
    } finally {
      setPolishing(false);
    }
  };

  const handleAdoptPolish = () => {
    if (polished) { setDraft(polished); setPolished(null); }
  };

  const handleContinue = async () => {
    if (continuing) return;
    setContinuing(true);
    setError(null);
    const playerText = draft.trim();

    // 玩家段即时上屏（写了才加）
    const playerTurnId = playerText ? `p-${Date.now()}` : '';
    if (playerTurnId) {
      setData(prev => prev ? { ...prev, turns: [...prev.turns, { id: playerTurnId, role: 'player', text: playerText, display: true, createdAt: Date.now() }] } : prev);
    }
    // AI 段先占位空，流式逐字填充
    const aiTurnId = `a-${Date.now()}`;
    setData(prev => prev ? { ...prev, turns: [...prev.turns, { id: aiTurnId, role: 'assistant', text: '', display: true, createdAt: Date.now() }] } : prev);

    setDraft('');
    setPolished(null);

    // 发送后滚到玩家段（半屏）；没写玩家段则滚到 AI 段
    const anchorId = playerTurnId || aiTurnId;
    setTimeout(() => scrollToTurn(anchorId, 'center'), 80);

    try {
      const done = await api.continueNovel(sessionId, playerText, (delta) => {
        setData(prev => prev ? {
          ...prev,
          turns: prev.turns.map(t => t.id === aiTurnId ? { ...t, text: t.text + delta } : t),
        } : prev);
        // 流式跟随：节流滚动（~5 次/秒），只有玩家在底部（没上滚读历史）才跟随到最新，否则不打断玩家滚动
        const now = Date.now();
        if (now - lastScrollAt.current > 200) {
          lastScrollAt.current = now;
          const el = bodyRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
            bottomRef.current?.scrollIntoView({ behavior: 'auto' });
          }
        }
      });
      // done 用清洗后的全文定稿（纠正 markdown 围栏 / 接力信号）
      if (done?.text) {
        setData(prev => prev ? {
          ...prev,
          turns: prev.turns.map(t => t.id === aiTurnId ? { ...t, text: done.text } : t),
        } : prev);
      } else {
        // 没收到内容（SSE 丢流 / 后端空）：按失败处理，走统一回滚
        throw new Error('续写没返回内容，请重试');
      }
    } catch (e: any) {
      setError(e?.message || '续写失败');
      // 失败回滚：撤掉乐观上屏的玩家段 + 空 AI 占位段，文本退回输入框，重新拉库对齐
      setData(prev => prev ? { ...prev, turns: prev.turns.filter(t => t.id !== aiTurnId && t.id !== playerTurnId) } : prev);
      if (playerText) setDraft(playerText);
      await loadData();
    } finally {
      setContinuing(false);
    }
  };

  const handleEnd = async () => {
    if (ending) return;
    if (!draft.trim()) return window.alert('把结尾写在输入框里，再点「写结尾」');
    setEnding(true);
    const endingText = draft.trim();
    try {
      await api.endNovel(sessionId, endingText);
      setData(prev => prev ? {
        ...prev,
        status: 'ended',
        turns: [...prev.turns, { id: `e-${Date.now()}`, role: 'player', text: endingText, display: true, createdAt: Date.now() }],
      } : prev);
      setDraft('');
    } catch (e: any) {
      window.alert(e?.message || '写结尾失败');
    } finally {
      setEnding(false);
    }
  };

  const handleRetract = async () => {
    if (continuing) return;
    setError(null);
    // 撤回前记录末尾显示段的文本，撤回后退回输入框（让玩家找回被撤回的内容）
    const turns = data?.turns ?? [];
    const lastDisplay = [...turns].reverse().find(t => t.display);
    const retractedText = lastDisplay?.text ?? '';
    try {
      await api.retractNovel(sessionId);
      await loadData();
      setDraft(retractedText);
    } catch (e: any) {
      setError(e?.message || '撤回失败');
    }
  };

  const handleRetry = async () => {
    if (continuing) return;
    setContinuing(true);
    setError(null);

    const turns = data?.turns ?? [];
    // 最后一段玩家段（锚点，用于滚动定位）
    const lastPlayer = [...turns].reverse().find(t => t.display && t.role === 'player');
    // 末尾 AI 段（重试要撤回的）
    const lastAi = [...turns].reverse().find(t => t.display && t.role === 'assistant');

    const aiTurnId = `a-${Date.now()}`;
    const anchorId = lastPlayer?.id || aiTurnId;

    try {
      await api.retractNovel(sessionId);

      // 乐观更新：撤掉末尾 AI 段，加空 AI 占位段（流式逐字填）
      setData(prev => prev ? {
        ...prev,
        turns: [
          ...prev.turns.filter(t => t.id !== (lastAi?.id ?? '')),
          { id: aiTurnId, role: 'assistant', text: '', display: true, createdAt: Date.now() },
        ],
      } : prev);

      setTimeout(() => scrollToTurn(anchorId, 'center'), 80);

      // 流式续写（空文本：玩家段已在正文流里，不重复落库）
      const done = await api.continueNovel(sessionId, '', (delta) => {
        setData(prev => prev ? {
          ...prev,
          turns: prev.turns.map(t => t.id === aiTurnId ? { ...t, text: t.text + delta } : t),
        } : prev);
        // 流式跟随：节流滚动，只有玩家在底部（没上滚读历史）才跟随到最新，否则不打断玩家滚动
        const now = Date.now();
        if (now - lastScrollAt.current > 200) {
          lastScrollAt.current = now;
          const el = bodyRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
            bottomRef.current?.scrollIntoView({ behavior: 'auto' });
          }
        }
      });

      // done 用清洗后的全文定稿
      if (done?.text) {
        setData(prev => prev ? {
          ...prev,
          turns: prev.turns.map(t => t.id === aiTurnId ? { ...t, text: done.text } : t),
        } : prev);
      } else {
        // 没收到内容（SSE 丢流 / 后端空）：按失败处理，走统一回滚
        throw new Error('重试没返回内容，请重试');
      }
    } catch (e: any) {
      setError(e?.message || '重试失败');
      setData(prev => prev ? { ...prev, turns: prev.turns.filter(t => t.id !== aiTurnId) } : prev);
      await loadData();
    } finally {
      setContinuing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
          <button className="text-ink-soft" onClick={onBack}>←</button>
          <span className="font-semibold text-ink">小说</span>
        </div>
        <div className="py-8 text-center text-sm text-ink-soft">加载中...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
          <button className="text-ink-soft" onClick={onBack}>←</button>
          <span className="font-semibold text-ink">小说</span>
        </div>
        <div className="py-8 text-center text-sm text-status-red">{error || '加载失败'}</div>
      </div>
    );
  }

  const isEnded = data.status === 'ended';
  const lastDisplayTurn = [...data.turns].reverse().find(t => t.display);
  const lastTurnIsAssistant = lastDisplayTurn?.role === 'assistant';
  // 重试 = 撤回 AI 段 + 重新续写，前提是玩家已写过（有玩家段）。
  // 否则只有开场段（assistant）时，重试会误删开场段、空文本续写导致 AI 拒绝。
  const hasPlayerTurn = data.turns.some(t => t.display && t.role === 'player');

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
        <button className="text-ink-soft" onClick={onBack}>←</button>
        <span className="font-semibold text-ink">{data.novel.title}</span>
        <div className="ml-auto flex items-center gap-2">
          {isEnded && <span className="rounded-full bg-bg-muted/60 px-2 py-0.5 text-xs text-ink-soft">已完结</span>}
          {data.isAuthor && (
            <button
              className="rounded-full border border-border px-3 py-1 text-xs text-ink-soft"
              onClick={() => onEdit(data.novelId)}
            >编辑</button>
          )}
        </div>
      </div>

      {/* 正文流（像读电子书） */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto px-5 py-4 bg-bg-soft backdrop-blur-lg">
        <div className="mx-auto max-w-xl">
          {data.turns.filter(t => t.display).map((t, i) => (
            <TurnBlock key={t.id} turn={t} showDivider={i > 0} />
          ))}
          {data.turns.filter(t => t.display).length === 0 && (
            <p className="py-8 text-center text-sm text-ink-soft">故事还没开始，写第一段吧</p>
          )}
          {/* 正文流末尾：分割线 + 撤回/重试（从底部输入区移上来，降低下方占比） */}
          {!isEnded && (
            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <div className="flex shrink-0 items-center gap-3">
                <button
                  className="text-xs text-ink-soft disabled:opacity-40"
                  onClick={handleRetract}
                  disabled={continuing}
                >
                  ↩ 撤回上段
                </button>
                {lastTurnIsAssistant && hasPlayerTurn && (
                  <button
                    className="text-xs text-ink-soft disabled:opacity-40"
                    onClick={handleRetry}
                    disabled={continuing}
                  >
                    ↻ 重试续写
                  </button>
                )}
              </div>
              <span className="h-px flex-1 bg-border" />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 底部：出场名单 + 输入区 */}
      <div className="border-t border-border frosted-glass px-4 pb-[88px] pt-3">
        {/* 出场名单 */}
        {data.characters.length > 0 && (
          <div className="mb-3 flex items-center gap-2 overflow-x-auto">
            <span className="shrink-0 text-xs text-ink-soft">出场：</span>
            {data.characters.map(c => {
              const dim = excludedIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => handleToggleExcluded(c.id)}
                  className={`flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-2 py-1 transition ${
                    dim ? 'opacity-40 grayscale' : ''
                  }`}
                  title={dim ? '已点暗（不在场），点击恢复' : '在场，点击点暗'}
                >
                  <span className={`flex h-8 w-8 items-center justify-center overflow-hidden rounded-full text-sm font-semibold ${dim ? 'bg-bg-muted text-ink-soft' : 'bg-solid text-solid-contrast'}`}>
                    {c.avatar ? (
                      <img src={imageUrl(c.avatar)} alt={c.name} className="h-full w-full object-cover" />
                    ) : (
                      c.name.slice(-1)
                    )}
                  </span>
                  <span className="text-[10px] text-ink">{c.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 润色结果预览 */}
        {polished && (
          <div className="mb-2 rounded-xl border border-border bg-bg-soft/70 p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold text-ink">润色结果</span>
              <div className="flex gap-2">
                <button className="text-xs text-rose" onClick={handleAdoptPolish}>采用</button>
                <button className="text-xs text-ink-soft" onClick={() => setPolished(null)}>放弃</button>
              </div>
            </div>
            <p className="max-h-40 overflow-y-auto pr-1 text-sm leading-relaxed text-ink whitespace-pre-wrap">{polished}</p>
          </div>
        )}

        {/* 输入框 */}
        {!isEnded && (
          <>
            <textarea
              className="max-h-40 w-full overflow-y-auto rounded-xl border border-border bg-bg-soft px-3 py-2.5 text-sm text-ink outline-none focus:border-border-strong"
              rows={3}
              placeholder="写一段主角的戏（动作 / 对白 / 叙述，粗糙没关系），AI 会接着写角色们的反应"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                className="rounded-lg frosted-glass border border-border px-3 py-2 text-xs text-ink-soft disabled:opacity-50"
                onClick={handlePolish}
                disabled={polishing || continuing}
              >
                {polishing ? '润色中...' : '润色'}
              </button>
              <button
                className="flex-1 rounded-lg bg-rose py-2 text-sm font-semibold text-ink-on disabled:opacity-50"
                onClick={handleContinue}
                disabled={continuing}
              >
                {continuing ? '续写中...' : '续写下一段'}
              </button>
              <button
                className="rounded-lg border border-border px-3 py-2 text-xs text-ink-soft disabled:opacity-50"
                onClick={handleEnd}
                disabled={ending || continuing}
              >
                {ending ? '结束中...' : '写结尾'}
              </button>
            </div>
          </>
        )}

        {isEnded && (
          <div className="py-3 text-center text-sm text-ink-soft">
            这一局已完结。返回列表可另开新局重写。
          </div>
        )}

        {error && <div className="mt-2 text-xs text-status-red">{error}</div>}
      </div>
    </div>
  );
}
