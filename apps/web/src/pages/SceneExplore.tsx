import { useState, useEffect, useRef } from 'react';
import { api, imageUrl, isLiveConflictError } from '../lib/api';
import type { SceneExploreStep } from '../lib/api';

interface Line {
  id: number;
  kind: 'narration' | 'item' | 'encounter' | 'player';
  text: string;
  meta?: string;
}

interface HerePerson {
  characterId: string;
  name: string;
  avatarType?: 'image' | 'initial';
  avatar: string;
  visibility: 'friend' | 'stranger' | 'unknown';
  activity: string; // 正在做什么（面对面可见，陌生人也有）
}

/**
 * 场景探索视图 —— 纯探索模式。
 * 界面：旁白区上移；下面一列"在这的人"（每位：名字+正在做什么+「过去看看」→对方注意到并主动打招呼进约会）；
 * 角色列表下面是「继续逛逛」；已去掉「描述你的行为」。
 * 每步 roll：30%偶遇角色 / 60%旁白 / 10%物品（点「继续逛逛」触发）。
 */
export function SceneExplore({
  locationId,
  locationName,
  onBack,
  onOpenScene,
}: {
  locationId: string;
  locationName: string;
  onBack: () => void;
  onOpenScene: (sessionId: string) => void;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<SceneExploreStep | null>(null); // 待确认的偶遇
  const [herePeople, setHerePeople] = useState<HerePerson[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  // 加载这个地点里确切在场的人（含正在做什么）
  useEffect(() => {
    (async () => {
      try {
        const npc = await api.sceneMapNpcs();
        setHerePeople((npc.locations[locationId] ?? []).map(n => ({
          characterId: n.characterId, name: n.name, avatarType: n.avatarType, avatar: n.avatar, visibility: n.visibility, activity: n.activity,
        })));
      } catch { /* ignore */ }
    })();
  }, [locationId]);

  // 开始探索：每次进入都新开一场（不恢复旧会话——探索是临时会话，离开探索页就结束）
  const startRef = useRef(false);
  useEffect(() => {
    if (startRef.current) return; // StrictMode 双挂载保护：只执行一次，避免并发建两个 session
    startRef.current = true;
    (async () => {
      try {
        const s = await api.sceneExploreStart(locationId);
        setSessionId(s.exploreSessionId);
        setLines([{ id: nextId(), kind: 'narration', text: s.narration }]);
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
    setBusy(true); setError('');
    try {
      const r = await api.sceneExploreStep(sessionId);
      if (r.type === 'encounter') {
        setPending(r);
      } else if (r.type === 'item') {
        setLines(prev => [...prev, {
          id: nextId(), kind: 'item',
          text: r.narration || '你发现了一样东西。',
          meta: r.itemDescription ? `🎁 拾获：${r.itemDescription}` : undefined,
        }]);
      } else if (r.type === 'caught') {
        // 被房主逮到：直接进入约会，没得选（进入后用户可正常退出）
        setLines(prev => [...prev, { id: nextId(), kind: 'narration', text: r.narration || '' }]);
        try {
          const d = await api.sceneStart({ locationId, characterIds: [r.characterId!], circumstance: 'caught' });
          await endCurrentExplore(); // 离开探索页 → 结束这次临时探索
          onOpenScene(d.sessionId);
          return;
        } catch (e) {
          if (isLiveConflictError(e)) { setBusy(false); return; } // 全局弹窗已接管；保留当前探索
          setError((e as Error).message);
        }
      } else {
        setLines(prev => [...prev, { id: nextId(), kind: 'narration', text: r.narration || '' }]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 直接与在场某人开始聊天（走过去 → 对方注意到你并主动打招呼 → 开正式约会）
  const talkTo = async (characterId: string, characterName: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const d = await api.sceneStart({ locationId, characterIds: [characterId], circumstance: 'approach' });
      await endCurrentExplore(); // 离开探索页 → 结束这次临时探索
      onOpenScene(d.sessionId);
    } catch (e) {
      if (isLiveConflictError(e)) { setBusy(false); return; } // 全局弹窗已接管；保留当前探索
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  // 偶遇确认 → 开完整 date（走近让对方注意到你并主动打招呼）
  const confirmMeet = async () => {
    if (!pending?.characterId || busy) return;
    setBusy(true); setError('');
    try {
      const d = await api.sceneStart({ locationId, characterIds: [pending.characterId], circumstance: 'approach' });
      await endCurrentExplore(); // 离开探索页 → 结束这次临时探索
      onOpenScene(d.sessionId);
    } catch (e) {
      if (isLiveConflictError(e)) { setBusy(false); return; } // 全局弹窗已接管；保留当前探索
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  // 偶遇离开 → 继续探索
  const declineMeet = () => {
    setPending(null);
  };

  // 结束当前这次探索会话（离开探索页的所有路径共用：返回/被逮到/走过去/偶遇确认进约会）
  const endCurrentExplore = async () => {
    if (sessionId) { try { await api.sceneExploreEnd(sessionId); } catch { /* ignore */ } }
  };

  const endExplore = async () => {
    await endCurrentExplore();
    onBack();
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={endExplore}>←</button>
        <span className="id-appbar-title">探索 · {locationName}</span>
      </div>
      <div className="id-app-scroll">
        {/* 旁白区（上移，占顶部） */}
        <div className="id-explore-log">
          {lines.map(l => {
            if (l.kind === 'player') {
              return (
                <div key={l.id} className="id-bubble-row player" style={{ justifyContent: 'flex-end' }}>
                  <div className="id-bubble player">{l.text}</div>
                </div>
              );
            }
            if (l.kind === 'item') {
              return (
                <div key={l.id} className="id-explore-item">
                  <div className="id-narration">
                    <div className="id-narration-line" />
                    <div className="id-narration-text">{l.text}</div>
                    <div className="id-narration-line" />
                  </div>
                  {l.meta && <div className="id-explore-item-tag">{l.meta}</div>}
                </div>
              );
            }
            return (
              <div key={l.id} className="id-narration">
                <div className="id-narration-line" />
                <div className="id-narration-text">{l.text}</div>
                <div className="id-narration-line" />
              </div>
            );
          })}
          {busy && <div className="id-typing-dots"><span /><span /><span /></div>}
          <div ref={endRef} />
        </div>

        {error && <div className="id-error-text">{error}</div>}

        {/* 偶遇确认框 */}
        {pending && !busy && (
          <div className="id-explore-encounter">
            <div className="id-explore-encounter-title">
              {pending.isKnown ? `${pending.characterName} 恰好在这里` : `一个陌生人：${pending.characterName}`}
            </div>
            <div className="id-explore-encounter-desc">
              过去看看{pending.characterName}那边，TA似乎注意到了你。走近可能会开启一段对话。
            </div>
            <div className="id-explore-encounter-actions">
              <button className="id-btn primary" onClick={confirmMeet}>过去看看</button>
              <button className="id-btn" onClick={declineMeet}>算了，继续逛</button>
            </div>
          </div>
        )}

        {/* 在这的人：一列 [名字+正在做什么+上前说话] */}
        {herePeople.length > 0 && (
          <div className="id-explore-here">
            <div className="id-explore-here-label">在这的人</div>
            {herePeople.map(c => (
              <div key={c.characterId} className="id-explore-person-row">
                <div className="id-explore-person-avatar">{c.avatarType === 'image' && c.avatar ? <img src={imageUrl(c.avatar)} alt="" className="id-explore-person-avatar-img" /> : (c.name?.charAt(0) ?? '?')}</div>
                <div className="id-explore-person-info">
                  <div className="id-explore-person-name">{c.name}</div>
                  {c.activity && <div className="id-explore-person-act">{c.activity}</div>}
                </div>
                <button className="id-btn primary sm" disabled={busy || !!pending} onClick={() => talkTo(c.characterId, c.name)}>
                  过去看看
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 操作区：继续逛逛 */}
        <div className="id-explore-actions">
          <button className="id-scene-action" disabled={busy || !!pending} onClick={doStep}>
            <span className="id-scene-action-emoji">🎲</span>
            <span className="id-scene-action-title">继续逛逛</span>
            <span className="id-scene-action-hint">四处走走，也许会有新的发现</span>
          </button>
        </div>
      </div>
    </div>
  );
}
