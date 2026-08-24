import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Dices } from 'lucide-react';
import { getAnimeMaleAvatar } from '../data/animeAvatars';

type SceneExploreStep = {
  type: 'narration' | 'encounter' | 'item' | 'caught';
  narration?: string;
  characterId?: string;
  characterName?: string;
  isKnown?: boolean;
  itemDescription?: string;
  itemOwnerName?: string;
};

interface HereNpc {
  characterId: string;
  name: string;
  avatarType?: 'image' | 'initial';
  avatar: string;
  visibility?: 'friend' | 'stranger' | 'unknown';
  activity: string;
}

interface ExploreLine {
  id: number;
  kind: 'narration' | 'item';
  text: string;
  meta?: string;
}

const API_BASE = '/v4/api';

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

/**
 * 场景探索视图（v4）—— 纯探索模式。
 * 在某地点闲逛，逐步推进；随机 roll 出旁白 / NPC 偶遇 / 拾物 / 被房主逮到。
 * 界面：旁白区上移；下面一列「在这的人」（名字 + 正在做什么 + 过去看看 → 进约会）；
 * 底部「继续逛逛」触发下一步。
 */
export const SceneExploreScreen: React.FC<{
  locationId: string;
  locationName: string;
  onBack: () => void;
  onOpenConversation: (sessionId: string) => void;
}> = ({ locationId, locationName, onBack, onOpenConversation }) => {
  const [lines, setLines] = useState<ExploreLine[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<SceneExploreStep | null>(null); // 待确认的偶遇
  const [herePeople, setHerePeople] = useState<HereNpc[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  // 加载这个地点里确切在场的人（含正在做什么）
  useEffect(() => {
    (async () => {
      try {
        const npc = await apiGet<{ locations: Record<string, HereNpc[]> }>('/scene/map/npcs');
        setHerePeople((npc.locations[locationId] ?? []).map((n) => ({
          characterId: n.characterId,
          name: n.name,
          avatarType: n.avatarType,
          avatar: n.avatar,
          visibility: n.visibility,
          activity: n.activity,
        })));
      } catch {
        /* ignore */
      }
    })();
  }, [locationId]);

  // 开始探索：每次进入都新开一场（不恢复旧会话——探索是临时会话，离开探索页就结束）
  const startRef = useRef(false);
  useEffect(() => {
    if (startRef.current) return; // StrictMode 双挂载保护：只执行一次
    startRef.current = true;
    (async () => {
      try {
        const s = await apiPost<{ exploreSessionId?: string; sessionId?: string; narration?: string }>(
          '/scene/explore',
          { locationId },
        );
        setSessionId(s.exploreSessionId ?? s.sessionId ?? '');
        setLines([{ id: nextId(), kind: 'narration', text: s.narration || '' }]);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // 执行一步（继续逛逛，无玩家输入）
  const doStep = async () => {
    if (busy || !sessionId) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiPost<SceneExploreStep>(`/scene/explore/${sessionId}/step`, {});
      if (r.type === 'encounter') {
        setPending(r);
      } else if (r.type === 'item') {
        setLines((prev) => [
          ...prev,
          {
            id: nextId(),
            kind: 'item',
            text: r.narration || '你发现了一样东西。',
            meta: r.itemDescription ? `拾获：${r.itemDescription}` : undefined,
          },
        ]);
      } else if (r.type === 'caught') {
        // 被房主逮到：直接进入约会，没得选
        setLines((prev) => [...prev, { id: nextId(), kind: 'narration', text: r.narration || '' }]);
        try {
          const d = await apiPost<{ sessionId: string }>('/scene/start', {
            locationId,
            characterIds: [r.characterId!],
            circumstance: 'caught',
          });
          await endCurrentExplore(); // 离开探索页 → 结束这次临时探索
          onOpenConversation(d.sessionId);
          return;
        } catch (e) {
          setError((e as Error).message);
        }
      } else {
        setLines((prev) => [...prev, { id: nextId(), kind: 'narration', text: r.narration || '' }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 直接与在场某人开始聊天（走过去 → 对方注意到你并主动打招呼 → 开正式约会）
  const talkTo = async (characterId: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const d = await apiPost<{ sessionId: string }>('/scene/start', {
        locationId,
        characterIds: [characterId],
        circumstance: 'approach',
      });
      await endCurrentExplore(); // 离开探索页 → 结束这次临时探索
      onOpenConversation(d.sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 偶遇确认 → 开完整 date
  const confirmMeet = async () => {
    if (!pending?.characterId || busy) return;
    setBusy(true);
    setError('');
    try {
      const d = await apiPost<{ sessionId: string }>('/scene/start', {
        locationId,
        characterIds: [pending.characterId],
        circumstance: 'approach',
      });
      await endCurrentExplore(); // 离开探索页 → 结束这次临时探索
      onOpenConversation(d.sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 偶遇离开 → 继续探索
  const declineMeet = () => {
    setPending(null);
  };

  // 结束当前这次探索会话（返回 / 被逮到 / 走过去 / 偶遇确认进约会 共用）
  const endCurrentExplore = async () => {
    if (sessionId) {
      try {
        await apiPost(`/scene/explore/${sessionId}/end`, {});
      } catch {
        /* ignore */
      }
    }
  };

  const endExplore = async () => {
    await endCurrentExplore();
    onBack();
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="px-3.5 py-2.5 flex items-center justify-between shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2.5">
          <button
            onClick={endExplore}
            className="p-1 -ml-1 text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
            aria-label="返回"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-[15px] font-bold text-ink tracking-tight">{locationName ? `探索 · ${locationName}` : '探索'}</h1>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pt-2 pb-[81px]">
        {/* 旁白区（上移，占顶部） */}
        <div className="flex flex-col">
          {lines.map((l) => {
            if (l.kind === 'item') {
              return (
                <div key={l.id} className="flex flex-col items-center my-2">
                  <div className="flex items-center gap-2 w-full">
                    <div className="flex-1 h-px bg-solid/10" />
                    <p className="text-[13px] text-ink-soft leading-relaxed text-center whitespace-pre-wrap max-w-[85%]">
                      {l.text}
                    </p>
                    <div className="flex-1 h-px bg-solid/10" />
                  </div>
                  {l.meta && (
                    <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-rose/10 px-2.5 py-1 text-[10px] font-medium text-rose">
                      🎁 {l.meta}
                    </span>
                  )}
                </div>
              );
            }
            return (
              <div key={l.id} className="flex items-center gap-2 my-2">
                <div className="flex-1 h-px bg-solid/10" />
                <p className="text-[13px] text-ink-soft leading-relaxed text-center whitespace-pre-wrap max-w-[85%]">
                  {l.text}
                </p>
                <div className="flex-1 h-px bg-solid/10" />
              </div>
            );
          })}
          {busy && (
            <div className="flex items-center justify-center gap-1 my-2">
              <span className="w-1.5 h-1.5 rounded-full bg-solid animate-pulse" />
              <span className="w-1.5 h-1.5 rounded-full bg-solid animate-pulse [animation-delay:0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-solid animate-pulse [animation-delay:0.3s]" />
            </div>
          )}
          <div ref={endRef} />
        </div>

        {error && <div className="text-center text-[11px] text-rose my-2">{error}</div>}

        {/* 偶遇确认框 */}
        {pending && !busy && (
          <div className="frosted-glass rounded-2xl p-3.5 my-2">
            <div className="text-[13px] font-bold text-ink">
              {pending.isKnown ? `${pending.characterName} 恰好在这里` : `一个陌生人：${pending.characterName}`}
            </div>
            <div className="text-xs text-ink-muted mt-1 leading-relaxed">
              过去看看{pending.characterName}那边，TA似乎注意到了你。走近可能会开启一段对话。
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={confirmMeet}
                className="flex-1 h-9 rounded-xl bg-rose text-ink-on text-[13px] font-bold active:scale-95 transition cursor-pointer"
              >
                过去看看
              </button>
              <button
                onClick={declineMeet}
                className="flex-1 h-9 rounded-xl frosted-glass text-ink text-[13px] font-medium active:scale-95 transition cursor-pointer"
              >
                算了，继续逛
              </button>
            </div>
          </div>
        )}

        {/* 在这的人：一列 [名字 + 正在做什么 + 过去看看] */}
        {herePeople.length > 0 && (
          <div className="mt-3 mb-2">
            <div className="text-[11px] font-bold text-ink-muted mb-1.5 px-0.5">在这的人</div>
            <div className="flex flex-col gap-1.5">
              {herePeople.map((c) => (
                <div key={c.characterId} className="frosted-glass rounded-2xl p-2.5 flex items-center gap-2.5">
                  <img
                    src={c.avatarType === 'image' && c.avatar ? `/v4/api/uploads/${c.avatar}` : getAnimeMaleAvatar(c.name)}
                    alt={c.name}
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 rounded-full object-cover border border-border shadow-2xs shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-bold text-ink truncate">{c.name}</div>
                    {c.activity && <div className="text-[11px] text-ink-muted truncate mt-0.5">{c.activity}</div>}
                  </div>
                  <button
                    onClick={() => talkTo(c.characterId)}
                    disabled={busy || !!pending}
                    className="shrink-0 px-3 h-8 rounded-xl bg-rose text-ink-on text-[12px] font-bold active:scale-95 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    过去看看
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 操作区：继续逛逛 */}
      <footer className="px-3 pt-1.5 pb-[81px] shrink-0 sticky bottom-0 z-20">
        <button
          onClick={doStep}
          disabled={busy || !!pending || !sessionId}
          className="w-full h-12 rounded-2xl frosted-glass flex items-center justify-center gap-2 active:scale-[0.98] transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_2px_10px_var(--color-shadow-black-04)]"
        >
          <Dices className="w-4 h-4 text-rose shrink-0" />
          <span className="text-[13px] font-bold text-ink">继续逛逛</span>
          <span className="text-[10px] text-ink-muted">四处走走，也许会有新的发现</span>
        </button>
      </footer>
    </div>
  );
};
