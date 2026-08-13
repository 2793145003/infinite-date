import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import type { LocationInfo } from '../lib/api';
import { AutoTextarea } from '../components/AutoTextarea';

const SYSTEM_EMOJI: Record<string, string> = {
  plaza: '⛲',
  cafe: '☕',
  park: '🌳',
  market: '🏮',
};
const DEFAULT_EMOIJS = ['🌟', '🎪', '🎨', '🎵', '🌙', '🔥', '❄️', '🌸'];

interface MapNpc {
  characterId: string;
  name: string;
  avatar: string;
  visibility: 'friend' | 'stranger' | 'unknown';
  activity: string;
}

export function LocationDetail({
  locationId,
  onBack,
  onNavigate,
}: {
  locationId: string;
  onBack: () => void;
  onNavigate: (view: { type: 'location-detail'; locationId: string } | { type: 'conversation'; sessionId: string; characterId: string; locationId: string; greeting?: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null } | { type: 'group-conversation'; sessionId: string; locationId: string; greeting?: { messages: { speaker: string; text: string }[]; internals: Record<string, string>; internals_notable: Record<string, boolean> }; participants: { characterId: string; name: string }[] } | { type: 'explore'; sessionId: string; locationId: string; locationName: string; narration: string }) => void;
}) {
  const [npcs, setNpcs] = useState<MapNpc[]>([]);
  const [allNpcsMap, setAllNpcsMap] = useState<Record<string, MapNpc[]>>({});
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [childLocations, setChildLocations] = useState<LocationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [activeSession, setActiveSession] = useState<{ sessionId: string; characterId: string; characterName: string; locationId: string | null; locationName: string } | null>(null);
  const [pendingCharacterId, setPendingCharacterId] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [showGroupInvite, setShowGroupInvite] = useState(false);

  // 返回逻辑：有父地点→回父地点，否则→回地图
  const handleBack = () => {
    if (location?.parentId) {
      onNavigate({ type: 'location-detail', locationId: location.parentId });
    } else {
      onBack();
    }
  };

  const loadData = async () => {
    try {
      const [npcData, locData, childData] = await Promise.all([
        api.getMapNpcs(),
        api.getLocation(locationId),
        api.getLocations(locationId),
      ]);
      setAllNpcsMap(npcData.locations);
      setNpcs(npcData.locations[locationId] ?? []);
      setLocation(locData.location);
      setChildLocations(childData.locations);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [locationId]);

  const meta = location
    ? { name: location.name, emoji: SYSTEM_EMOJI[locationId] ?? DEFAULT_EMOIJS[0], desc: location.summary, path: location.path }
    : { name: '未知地点', emoji: '❓', desc: '', path: '' };

  // 面包屑：把path拆成可点击的层级
  const breadcrumbs = location?.path?.split(' › ') ?? [];

  // 好友NPC列表（用于邀请约会——不限当前地点，可以从别处叫来）
  const friendNpcs = Object.values(allNpcsMap)
    .flat()
    .filter(n => n.visibility === 'friend')
    .filter((n, i, arr) => arr.findIndex(x => x.characterId === n.characterId) === i);

  const handleTalk = async (characterId: string) => {
    if (starting) return;
    setPendingCharacterId(characterId);
    setStarting(true);
    try {
      const data = await api.startConversation(characterId, locationId);
      onNavigate({
        type: 'conversation',
        sessionId: data.sessionId,
        characterId,
        locationId,
        greeting: data.greeting,
      });
    } catch (err) {
      const e = err as Error & { status?: number; body?: { sessionId?: string; characterId?: string; characterName?: string; locationId?: string | null; locationName?: string } };
      if (e.status === 409 && e.body?.sessionId) {
        setActiveSession({
          sessionId: e.body.sessionId,
          characterId: e.body.characterId ?? characterId,
          characterName: e.body.characterName ?? '未知角色',
          locationId: e.body.locationId ?? null,
          locationName: e.body.locationName ?? '未知地点',
        });
      } else {
        alert(e.message);
      }
    } finally {
      setStarting(false);
    }
  };

  const handleExplore = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const data = await api.startExplore(locationId);
      if (data.type === 'encounter' && data.sessionId && data.characterId && data.greeting) {
        // 偶遇 → 跳转对话
        onNavigate({
          type: 'conversation',
          sessionId: data.sessionId,
          characterId: data.characterId,
          locationId,
          greeting: {
            environment: data.narration,
            messages: data.greeting.messages,
            internal: data.greeting.internal,
            internal_notable: data.greeting.internal_notable,
          },
        });
      } else if (data.type === 'explore' && data.exploreSessionId) {
        // 纯探索 → 跳转探索页
        onNavigate({
          type: 'explore',
          sessionId: data.exploreSessionId,
          locationId,
          locationName: data.locationName ?? meta.name,
          narration: data.narration,
        });
      }
    } catch (err) {
      const e = err as Error & { status?: number; body?: { error?: string } };
      if (e.status === 409 && e.body?.error) {
        alert(e.body.error);
      } else {
        alert(e.message);
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={handleBack}>←</button>
        <span className="id-appbar-title">{meta.name}</span>
      </div>
      <div className="id-app-scroll">
        {/* 面包屑导航 */}
        {breadcrumbs.length > 1 && (
          <div className="id-loc-breadcrumb">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="id-loc-breadcrumb-item">
                {i > 0 && <span className="id-loc-breadcrumb-sep"> › </span>}
                {crumb}
              </span>
            ))}
          </div>
        )}

        <div className="id-loc-header">
          <div className="id-loc-emoji">{meta.emoji}</div>
          <div className="id-loc-info">
            <div className="id-loc-name">{meta.name}</div>
            <div className="id-loc-desc">{meta.desc || '一个地方'}</div>
          </div>
        </div>

        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : (
          <>
            {/* 子地点区域 */}
            {childLocations.length > 0 && (
              <div className="id-loc-section">
                <div className="id-loc-section-title">区域</div>
                <div className="id-map-list">
                  {childLocations.map((loc, i) => {
                    const emoji = DEFAULT_EMOIJS[i % DEFAULT_EMOIJS.length];
                    const locNpcs = allNpcsMap[loc.id] ?? [];
                    return (
                      <button
                        key={loc.id}
                        className="id-map-card unlocked"
                        onClick={() => onNavigate({ type: 'location-detail', locationId: loc.id })}
                      >
                        <div className="id-map-emoji">{emoji}</div>
                        <div className="id-map-info">
                          <div className="id-map-name">
                            {loc.name}
                            {loc.creatorType === 'player' && (
                              <span className="id-map-tag">{loc.isPublic ? '公开' : '私有'}</span>
                            )}
                          </div>
                          <div className="id-map-desc">{loc.summary || '一个地方'}</div>
                          {locNpcs.length > 0 && (
                            <div className="id-map-npcs">
                              {locNpcs.map(n => {
                                const displayName = n.visibility === 'unknown' ? '?' : n.name;
                                const cls = n.visibility === 'friend' ? 'friend'
                                  : n.visibility === 'stranger' ? 'stranger'
                                  : 'unknown';
                                return (
                                  <span
                                    key={n.characterId}
                                    className={`id-map-npc-tag ${cls}`}
                                  >
                                    <span className="id-map-npc-avatar">{n.avatar}</span>
                                    {displayName}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="id-map-action">{loc.hasChildren ? '进入' : '前往'}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 当前地点的NPC（无论有没有子地点都显示） */}
            {npcs.length > 0 && (
              <div className="id-loc-section">
                <div className="id-loc-section-title">在这里的人</div>
                <div className="id-loc-npc-list">
                  {npcs.map(n => {
                    const displayName = n.visibility === 'unknown' ? '?' : n.name;
                    const displayAvatar = n.visibility === 'unknown' ? '?' : n.avatar;
                    const isDimmed = n.visibility !== 'friend';

                    return (
                      <button
                        key={n.characterId}
                        className={`id-loc-npc-card ${isDimmed ? 'dimmed' : ''}`}
                        onClick={() => handleTalk(n.characterId)}
                        disabled={starting}
                      >
                        <div className="id-loc-npc-avatar">{displayAvatar}</div>
                        <div className="id-loc-npc-info">
                          <div className="id-loc-npc-name">{displayName}</div>
                          {n.visibility === 'friend' && n.activity && (
                            <div className="id-loc-npc-activity">{n.activity}</div>
                          )}
                          {n.visibility === 'stranger' && (
                            <div className="id-loc-npc-activity">面熟，但不太认识</div>
                          )}
                          {n.visibility === 'unknown' && (
                            <div className="id-loc-npc-activity">一个不认识的人</div>
                          )}
                        </div>
                        <div className="id-loc-npc-action">搭话</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 没有子地点且没有NPC时显示空状态 */}
            {childLocations.length === 0 && npcs.length === 0 && (
              <div className="id-empty"><span>🍃</span><span>这里暂时没有人</span></div>
            )}

            {/* 创建子地点 */}
            <button className="id-map-card id-map-create" onClick={() => setShowCreate(true)}>
              <div className="id-map-emoji">➕</div>
              <div className="id-map-info">
                <div className="id-map-name">在此创建子地点</div>
                <div className="id-map-desc">在{meta.name}下新建一个地点</div>
              </div>
            </button>

            {/* 约会邀请 — 有好友时就能邀请（从别处叫来） */}
            {friendNpcs.length >= 1 && (
              <button
                className="id-map-card id-map-create"
                onClick={() => setShowGroupInvite(true)}
                disabled={starting}
              >
                <div className="id-map-emoji">👫</div>
                <div className="id-map-info">
                  <div className="id-map-name">邀请约会</div>
                  <div className="id-map-desc">邀请好友来这里约会</div>
                </div>
              </button>
            )}

            {/* 探索地点 */}
            <button
              className="id-map-card id-map-create"
              onClick={handleExplore}
              disabled={starting}
            >
              <div className="id-map-emoji">🚶</div>
              <div className="id-map-info">
                <div className="id-map-name">四处逛逛</div>
                <div className="id-map-desc">在{meta.name}自由探索，也许会有偶遇</div>
              </div>
            </button>
          </>
        )}
      </div>

      {showCreate && (
        <CreateChildLocationModal
          parentId={locationId}
          parentName={meta.name}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadData(); }}
        />
      )}

      {activeSession && (
        <div className="id-modal-overlay" onClick={() => setActiveSession(null)}>
          <div className="id-modal" onClick={e => e.stopPropagation()}>
            <div className="id-modal-title">已有进行中的约会</div>
            <div className="id-modal-desc">
              你正在和<strong>{activeSession.characterName}</strong>约会
              {activeSession.locationName && <>（{activeSession.locationName}）</>}
              <br />要继续之前的对话，还是结束它重新搭话？
            </div>
            <div className="id-modal-actions">
              <button className="id-btn" onClick={() => {
                onNavigate({
                  type: 'conversation',
                  sessionId: activeSession.sessionId,
                  characterId: activeSession.characterId,
                  locationId: activeSession.locationId ?? locationId,
                });
                setActiveSession(null);
              }}>继续对话</button>
              <button className="id-btn primary" onClick={async () => {
                try { await api.endConversation(activeSession.sessionId); } catch { /* ignore */ }
                setActiveSession(null);
                handleTalk(pendingCharacterId);
              }}>结束并重新搭话</button>
            </div>
          </div>
        </div>
      )}

      {showGroupInvite && (
        <GroupInviteModal
          friendNpcs={friendNpcs}
          locationId={locationId}
          onClose={() => setShowGroupInvite(false)}
          onStart={(view) => {
            setShowGroupInvite(false);
            onNavigate(view);
          }}
        />
      )}
    </div>
  );
}

function GroupInviteModal({ friendNpcs, locationId, onClose, onStart }: {
  friendNpcs: MapNpc[];
  locationId: string;
  onClose: () => void;
  onStart: (view:
    | { type: 'conversation'; sessionId: string; characterId: string; locationId: string; greeting?: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null }
    | { type: 'group-conversation'; sessionId: string; locationId: string; greeting?: { messages: { speaker: string; text: string }[]; internals: Record<string, string>; internals_notable: Record<string, boolean> }; participants: { characterId: string; name: string }[] }
  ) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [deityPick, setDeityPick] = useState(false);

  const toggleSelect = (id: string) => {
    setError('');
    if (selected.includes(id)) {
      setSelected(selected.filter(s => s !== id));
    } else {
      if (selected.length >= 2) return;
      setSelected([...selected, id]);
    }
  };

  const handleStart = async () => {
    if (selected.length === 0 || selected.length > 2 || starting) return;
    setStarting(true);
    setError('');
    try {
      const trigger = deityPick ? 'deity_pick' : 'invite';
      if (selected.length === 1) {
        // 选1个 → 单聊
        const charId = selected[0]!;
        const data = await api.startConversation(charId, locationId, { trigger });
        onStart({
          type: 'conversation',
          sessionId: data.sessionId,
          characterId: charId,
          locationId,
          greeting: data.greeting,
        });
      } else {
        // 选2个 → 群聊
        const data = await api.startGroupSession(selected, locationId, { trigger });
        onStart({
          type: 'group-conversation',
          sessionId: data.sessionId,
          locationId,
          greeting: data.greeting,
          participants: data.participants,
        });
      }
    } catch (err) {
      const e = err as Error & { status?: number; body?: { error?: string } };
      setError(e.body?.error ?? e.message);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" onClick={e => e.stopPropagation()}>
        <div className="id-modal-title">{deityPick ? '主神抽选' : '邀请约会'}</div>
        <div className="id-modal-desc">{deityPick ? `主神随机抽选NPC来到这里（已选${selected.length}/2）` : `选择1-2位好友一起约会（已选${selected.length}/2）`}</div>

        <div className="id-loc-npc-list" style={{ maxHeight: '40vh', overflowY: 'auto' }}>
          {friendNpcs.map(n => {
            const isSelected = selected.includes(n.characterId);
            return (
              <button
                key={n.characterId}
                className={`id-loc-npc-card ${isSelected ? 'selected' : ''}`}
                onClick={() => toggleSelect(n.characterId)}
                style={isSelected ? { borderColor: 'var(--id-accent, #e89020)', background: 'rgba(232,144,32,0.1)' } : {}}
              >
                <div className="id-loc-npc-avatar">{n.avatar}</div>
                <div className="id-loc-npc-info">
                  <div className="id-loc-npc-name">{n.name}</div>
                  {n.activity && <div className="id-loc-npc-activity">{n.activity}</div>}
                </div>
                <div className="id-loc-npc-action">{isSelected ? '已选' : '选择'}</div>
              </button>
            );
          })}
        </div>

        {/* 主神抽选开关 */}
        <label className="id-deity-pick-toggle" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={deityPick}
            onChange={e => { setDeityPick(e.target.checked); setError(''); }}
          />
          <span className="id-deity-pick-label">主神抽选模式</span>
          <span className="id-deity-pick-hint">{deityPick ? 'NPC被主神随机选中送来，不是主动邀请' : '关闭时为玩家主动邀请'}</span>
        </label>

        {error && <div className="id-modal-error">{error}</div>}

        <div className="id-modal-actions">
          <button className="id-btn" onClick={onClose} disabled={starting}>取消</button>
          <button className="id-btn primary" onClick={handleStart} disabled={starting || selected.length === 0}>
            {starting ? '发起中…' : deityPick ? '确定抽选' : '确定邀请'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateChildLocationModal({ parentId, parentName, onClose, onCreated }: {
  parentId: string;
  parentName: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      await api.createLocation({ name: name.trim(), summary: summary.trim() || undefined, isPublic, parentId });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" onClick={e => e.stopPropagation()}>
        <div className="id-modal-title">在{parentName}创建子地点</div>
        <div className="id-modal-desc">在当前地点下新建一个子区域</div>

        <div className="id-card-section">
          <div className="id-card-row">
            <label>名称</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="给这个地方起个名字"
              maxLength={30}
            />
          </div>
          <div className="id-card-row">
            <label>描述</label>
            <AutoTextarea
              value={summary}
              onChange={e => setSummary(e.target.value)}
              placeholder="这是个什么样的地方？"
              maxLength={200}
            />
          </div>
        </div>

        <div className="id-card-section">
          <div className="id-card-row">
            <label>类型</label>
            <div className="id-toggle-group">
              <button
                className={`id-toggle-btn ${isPublic ? 'active' : ''}`}
                onClick={() => setIsPublic(true)}
              >公开</button>
              <button
                className={`id-toggle-btn ${!isPublic ? 'active' : ''}`}
                onClick={() => setIsPublic(false)}
              >私有</button>
            </div>
          </div>
          <div className="id-card-hint">
            {isPublic ? '所有人可见，不归你所有' : '仅自己可见'}
          </div>
        </div>

        {error && <div className="id-modal-error">{error}</div>}

        <div className="id-modal-actions">
          <button className="id-btn" onClick={onClose} disabled={creating}>取消</button>
          <button className="id-btn primary" onClick={handleCreate} disabled={creating || !name.trim()}>
            {creating ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
