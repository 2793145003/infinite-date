import { useState, useEffect } from 'react';
import { api, imageUrl, isLiveConflictError } from '../lib/api';
import type { SceneLocationInfo, SceneNpcInfo } from '../lib/api';
import { AutoTextarea } from '../components/AutoTextarea';
import { ImageUploadButton } from '../components/ImageUploadButton';

/**
 * 场景决策页 —— 进入地点后先看“这儿是什么样 / 有谁”，再选行动。
 * 全新 UI，替代旧的杂乱 LocationDetail。
 */
export function SceneLocation({
  locationId,
  onBack,
  onOpenScene,
  onExplore,
  onOpenLocation,
}: {
  locationId: string;
  onBack: () => void;
  onOpenScene: (sessionId: string) => void;
  onExplore: (locationId: string, locationName: string) => void;
  onOpenLocation: (locationId: string) => void;
}) {
  const [loc, setLoc] = useState<SceneLocationInfo | null>(null);
  const [childLocs, setChildLocs] = useState<SceneLocationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showInvite, setShowInvite] = useState(false); // 邀请弹层开关
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null); // 点头像看行程
  const [allLocs, setAllLocs] = useState<SceneLocationInfo[]>([]);
  const [allNpcs, setAllNpcs] = useState<Record<string, { characterId: string; name: string; avatarType?: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown'; activity: string }[]>>({});

  const loadData = async () => {
    try {
      const allData = await api.sceneLocations();
      const [locData, childData, npcData] = await Promise.all([
        Promise.resolve(allData.locations.find(l => l.id === locationId) ?? null),
        api.sceneLocations(locationId),
        api.sceneMapNpcs(),
      ]);
      setAllLocs(allData.locations);
      setLoc(locData);
      setChildLocs(childData.locations);
      // sceneMapNpcs 返回每个地点的"确切在场"角色（不含父链传播）。
      // 决策页不含"在这里的人"区块（点"进入"后在探索页才显示），
      // 但子地点卡片的聚合头像需要全量 npcs map。
      setAllNpcs(npcData.locations);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [locationId]);

  // 自己逛逛 —— 进入纯探索模式（roll 偶遇/旁白/物品）
  const handleExplore = () => {
    if (!loc) return;
    onExplore(loc.id, loc.name);
  };

  // 邀请别人过来 —— 打开邀请弹层（非阻塞选择）
  const handleInvite = () => {
    if (starting || !loc) return;
    setError('');
    setShowInvite(true);
  };

  const breadcrumbs = loc?.path?.split(' › ') ?? [];

  // 卡片头像聚合：给定地点id，返回它自己 + 所有后代地点里的确切在场角色。
  // 让玩家通过父节点卡片就能看到并找到每个角色（"我能通过头像找到每一个人"）。
  const collectChars = (rootId: string): { characterId: string; name: string; avatarType?: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown' }[] => {
    const seen = new Map<string, { characterId: string; name: string; avatarType?: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown' }>();
    const walk = (id: string) => {
      for (const n of allNpcs[id] ?? []) {
        if (!seen.has(n.characterId)) seen.set(n.characterId, { characterId: n.characterId, name: n.name, avatarType: n.avatarType, avatar: n.avatar, visibility: n.visibility });
      }
      for (const l of allLocs) {
        if (l.parentId === id) walk(l.id);
      }
    };
    walk(rootId);
    return [...seen.values()];
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">{loc?.name ?? '…'}</span>
      </div>
      <div className="id-app-scroll">
        {/* 面包屑 */}
        {breadcrumbs.length > 1 && (
          <div className="id-loc-breadcrumb">
            {breadcrumbs.map((c, i) => (
              <span key={i} className="id-loc-breadcrumb-item">
                {i > 0 && <span className="id-loc-breadcrumb-sep"> › </span>}
                {c}
              </span>
            ))}
          </div>
        )}

        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : !loc ? (
          <div className="id-empty"><span>❓</span><span>地点不存在</span></div>
        ) : (
          <>
            {/* 环境概览 + 场景设置按钮（放在描述旁边） */}
            <div
              className="id-scene-hero"
              style={loc.background ? { backgroundImage: `url(${imageUrl(loc.background)})` } : undefined}
            >
              {loc.background && <div className="id-scene-hero-bg-shade" aria-hidden />}
              <div className="id-scene-hero-emoji">🌆</div>
              <div className="id-scene-hero-body">
                <div className="id-scene-hero-name">{loc.name}</div>
                <div className="id-scene-hero-desc">{loc.summary || '一个安静的地方。'}</div>
                <button className="id-scene-settings-btn" onClick={() => setShowSettings(true)}>
                  场景设置
                </button>
              </div>
            </div>

            {/* 常驻路人名单：职位·名字 */}
            {loc.npcs.length > 0 && (
              <div className="id-loc-section">
                <div className="id-loc-section-title">常驻人员</div>
                <div className="id-map-npcs">
                  {loc.npcs.map(n => (
                    <span key={n.id} className="id-map-npc-tag">
                      <span className="id-map-npc-avatar">{n.name.charAt(0)}</span>
                      {(n.role ? `${n.role}·` : '') + n.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 进入 / 探索 主行动：点进去才会看到里面是谁 */}
            <div className="id-loc-section">
              <button className="id-scene-enter" disabled={starting} onClick={handleExplore}>
                <span className="id-scene-enter-emoji">🚶</span>
                <span className="id-scene-enter-title">进入{loc.name}</span>
                <span className="id-scene-enter-hint">四处走走，也许会偶遇谁</span>
                {/* 这个地点确切在场的角色头像（不含子地点） */}
                {(allNpcs[loc.id] ?? []).length > 0 && (
                  <span className="id-scene-enter-npcs" onClick={e => e.stopPropagation()}>
                    {(allNpcs[loc.id] ?? []).map(n => (
                      <button
                        key={n.characterId}
                        className="id-map-npc-tag"
                        title={`查看${n.name}的行程`}
                        onClick={e => { e.stopPropagation(); setScheduleCharId(n.characterId); }}
                      >
                        <span className="id-map-npc-avatar">{n.avatarType === 'image' && n.avatar ? <img src={imageUrl(n.avatar)} alt="" className="id-map-npc-avatar-img" /> : (n.name?.charAt(0) ?? '?')}</span>
                      </button>
                    ))}
                  </span>
                )}
              </button>
            </div>

            {/* 子地点 */}
            {childLocs.length > 0 && (
              <div className="id-loc-section">
                <div className="id-loc-section-title">区域</div>
                <div className="id-map-list">
                  {childLocs.map(l => {
                    const childChars = collectChars(l.id);
                    return (
                      <button key={l.id} className="id-map-card unlocked" onClick={() => onOpenLocation(l.id)}>
                        {l.background && (
                          <div className="id-map-card-bg" style={{ backgroundImage: `url(${imageUrl(l.background)})` }} aria-hidden />
                        )}
                        <div className="id-map-emoji">📍</div>
                        <div className="id-map-info">
                          <div className="id-map-name">
                            {l.name}
                            {l.hasChildren && <span className="id-map-tag">含子区域</span>}
                          </div>
                          <div className="id-map-desc">{l.summary || '一个地方'}</div>
                          {childChars.length > 0 && (
                            <div className="id-map-npcs">
                              {childChars.map(n => (
                                <button
                                  key={n.characterId}
                                  className="id-map-npc-tag"
                                  title={`查看${n.name}的行程`}
                                  onClick={e => { e.stopPropagation(); setScheduleCharId(n.characterId); }}
                                >
                                  <span className="id-map-npc-avatar">{n.avatarType === 'image' && n.avatar ? <img src={imageUrl(n.avatar)} alt="" className="id-map-npc-avatar-img" /> : (n.name?.charAt(0) ?? '?')}</span>
                                  {n.name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="id-map-action">进入</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 其他行动 */}
            <div className="id-loc-section">
              <div className="id-loc-section-title">你还可以</div>
              <div className="id-scene-actions">
                <button className="id-scene-action" disabled={starting} onClick={handleInvite}>
                  <span className="id-scene-action-emoji">👋</span>
                  <span className="id-scene-action-title">邀请别人过来</span>
                  <span className="id-scene-action-hint">叫好友来这里见面（可多选）</span>
                </button>
              </div>
            </div>

            {error && <div className="id-error-text">{error}</div>}
          </>
        )}
      </div>

      {showSettings && loc && (
        <SceneSettingsModal
          loc={loc}
          onClose={() => setShowSettings(false)}
          onChanged={loadData}
        />
      )}

      {showInvite && loc && (
        <InviteModal
          locationId={loc.id}
          locationName={loc.name}
          onClose={() => setShowInvite(false)}
          onStart={(sessionId) => onOpenScene(sessionId)}
        />
      )}

      {scheduleCharId && (
        <SceneScheduleModal
          characterId={scheduleCharId}
          onClose={() => setScheduleCharId(null)}
        />
      )}
    </div>
  );
}

function SceneScheduleModal({ characterId, onClose }: { characterId: string; onClose: () => void }) {
  const [data, setData] = useState<{
    characterName: string;
    current: { locationName: string; activity: string; startTime: number; duration: number } | null;
    upcoming: { locationName: string; activity: string; startTime: number; duration: number }[];
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getSceneNpcSchedule(characterId).then(setData).catch((e) => {
      setError((e as Error).message);
    });
  }, [characterId]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" onClick={e => e.stopPropagation()}>
        {error ? (
          <>
            <div className="id-modal-title">查看失败</div>
            <div className="id-modal-error">{error}</div>
            <div className="id-modal-actions">
              <button className="id-btn primary" onClick={onClose}>关闭</button>
            </div>
          </>
        ) : !data ? (
          <div className="id-loading">加载中…</div>
        ) : (
          <>
            <div className="id-modal-title">{data.characterName}的行程</div>
            {data.current ? (
              <div className="id-schedule-current">
                <div className="id-schedule-now">现在</div>
                <div className="id-schedule-loc">{data.current.locationName}</div>
                <div className="id-schedule-act">{data.current.activity}</div>
              </div>
            ) : (
              <div className="id-schedule-current">
                <div className="id-schedule-now">不在主城</div>
              </div>
            )}
            {data.upcoming.length > 0 && (
              <div className="id-schedule-upcoming">
                <div className="id-schedule-section-title">接下来</div>
                {data.upcoming.map((u, i) => (
                  <div key={i} className="id-schedule-row">
                    <span className="id-schedule-time">{formatTime(u.startTime)}</span>
                    <span className="id-schedule-loc">{u.locationName}</span>
                    <span className="id-schedule-act">{u.activity}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="id-modal-actions">
              <button className="id-btn primary" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SceneSettingsModal({ loc, onClose, onChanged }: {
  loc: SceneLocationInfo | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [npRole, setNpRole] = useState('');
  const [npName, setNpName] = useState('');
  const [npPersona, setNpPersona] = useState('');
  const [isPublic, setIsPublic] = useState(loc?.isPublic ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const createLoc = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await api.sceneCreateLocation({ name: name.trim(), summary: summary.trim() || undefined, parentId: loc?.id ?? null, isPublic });
      setName(''); setSummary('');
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const addNpc = async () => {
    if (!loc || !npRole.trim() || !npName.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await api.sceneAddNpc(loc.id, { role: npRole.trim(), name: npName.trim(), persona: npPersona.trim() || undefined });
      setNpRole(''); setNpName(''); setNpPersona('');
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" onClick={e => e.stopPropagation()}>
        <div className="id-modal-title">场景设置</div>
        <div className="id-modal-desc">{loc ? `在「${loc.name}」里添加子地点或路人` : '在主城里添加一个新地点'}</div>

        {loc && (
        <div className="id-card-section">
          <div className="id-card-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.3rem' }}>
            <label>{loc.isPublic ? '背景图（参赛/公开）' : '背景图'}</label>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)' }}>
              {loc.isPublic
                ? '公开地点：你传的背景会加入候选池，最先传的自动生效，管理员可挑选。用于约会的聊天背景。'
                : '私有地点：只有你能设置，用作约会的聊天背景。'}
            </div>
            <ImageUploadButton
              value={loc.background}
              onUploaded={async (imagePath) => {
                try {
                  await api.sceneSetBackground(loc.id, imagePath);
                  onChanged();
                } catch (e) { setError((e as Error).message || '设置背景失败'); }
              }}
              onClear={async () => {
                try {
                  await api.sceneSetBackground(loc.id, '');
                  onChanged();
                } catch (e) { setError((e as Error).message || '移除背景失败'); }
              }}
            />
          </div>
        </div>
        )}

        <div className="id-card-section">
          <div className="id-card-row">
            <label>子地点</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="地点名称" maxLength={30} />
          </div>
          <div className="id-card-row">
            <label>描述</label>
            <AutoTextarea value={summary} onChange={e => setSummary(e.target.value)} placeholder="这是什么地方？（可选）" maxLength={200} />
          </div>
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
            {isPublic ? '所有人可见，NPC可能出现在这里' : '仅自己可见'}
          </div>
          <div className="id-card-actions-end">
            <button className="id-btn primary" onClick={createLoc} disabled={busy || !name.trim()}>添加子地点</button>
          </div>
        </div>

        {loc && (
        <div className="id-card-section">
          <div className="id-card-row">
            <label>路人身份</label>
            <input value={npRole} onChange={e => setNpRole(e.target.value)} placeholder="如：服务生、摊主" maxLength={20} />
          </div>
          <div className="id-card-row">
            <label>路人名字</label>
            <input value={npName} onChange={e => setNpName(e.target.value)} placeholder="如：小周" maxLength={20} />
          </div>
          <div className="id-card-row">
            <label>路人设定</label>
            <AutoTextarea value={npPersona} onChange={e => setNpPersona(e.target.value)} placeholder="这个人的性格/来历（可选）" maxLength={200} />
          </div>
          <div className="id-card-actions-end">
            <button className="id-btn primary" onClick={addNpc} disabled={busy || !npRole.trim() || !npName.trim()}>添加路人</button>
          </div>
        </div>
        )}

        {error && <div className="id-modal-error">{error}</div>}

        <div className="id-modal-actions">
          <button className="id-btn" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 邀请别人过来 —— 不限人数的好友选择弹层。
 * 空列表 → 从好友里（可搜索）挑一个加入列表 → 可删除 → 下一行再继续挑。
 * 一个勾选控制开场方式：勾上=伪装成主神随机抽选(deity_pick)，不勾=正常邀请(invite)。
 */
function InviteModal({
  locationId,
  locationName,
  onClose,
  onStart,
}: {
  locationId: string;
  locationName: string;
  onClose: () => void;
  onStart: (sessionId: string) => void;
}) {
  const [friends, setFriends] = useState<{ characterId: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]); // 已加入列表的好友 id（有序）
  const [query, setQuery] = useState(''); // 搜索词
  const [deityPick, setDeityPick] = useState(false); // 开场模式：false=邀请，true=伪装主神抽选
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false); // 正在挑选下拉

  useEffect(() => {
    api.getMissionFriends().then((d) => {
      setFriends(d.friends);
      if (d.friends.length === 0) setError('还没有好友可以邀请');
    }).catch(() => setError('加载好友失败'));
  }, []);

  const selectedSet = new Set(selected);
  // 已加入列表的好友对象（保持加入顺序）
  const selectedFriends = selected
    .map((id) => friends.find((f) => f.characterId === id))
    .filter((f): f is { characterId: string; name: string } => !!f);

  // 可挑选的候选项：还没被加入的朋友，且匹配搜索
  const candidates = friends.filter((f) => {
    if (selectedSet.has(f.characterId)) return false;
    if (!query.trim()) return true;
    return f.name.toLowerCase().includes(query.trim().toLowerCase());
  });

  const addFriend = (id: string) => {
    if (selectedSet.has(id)) return;
    setSelected((prev) => [...prev, id]);
    setQuery('');
    setPicking(false);
    setError('');
  };

  const removeFriend = (id: string) => {
    setSelected((prev) => prev.filter((x) => x !== id));
  };

  const start = async () => {
    if (busy) return;
    if (selected.length === 0) { setError('请至少选择一位好友'); return; }
    setBusy(true); setError('');
    try {
      const data = await api.sceneStart({
        locationId,
        characterIds: selected,
        circumstance: deityPick ? 'deity_pick' : 'invite',
      });
      onStart(data.sessionId);
    } catch (e) {
      if (isLiveConflictError(e)) { setBusy(false); return; } // 全局弹窗已接管
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" onClick={e => e.stopPropagation()}>
        <div className="id-modal-title">邀请约会</div>
        <div className="id-modal-desc">在「{locationName}」邀请好友见面（已选 {selected.length} 位，不限人数）</div>

        {/* 已加入列表 —— 一行一个，可删除 */}
        <div className="id-invite-list">
          {selectedFriends.length === 0 ? (
            <div className="id-invite-empty">从下面选择好友加入</div>
          ) : (
            selectedFriends.map((f) => (
              <div key={f.characterId} className="id-invite-row">
                <span className="id-invite-name">{f.name}</span>
                <button className="id-invite-remove" onClick={() => removeFriend(f.characterId)}>✕</button>
              </div>
            ))
          )}
        </div>

        {/* 选择好友 —— 可搜索 */}
        <div className="id-invite-pick">
          <div className="id-invite-pick-head">
            <input
              className="id-invite-search"
              value={query}
              onChange={e => { setQuery(e.target.value); setPicking(true); }}
              onFocus={() => setPicking(true)}
              placeholder="搜索好友…"
            />
            {query.trim() && !picking && (
              <button className="id-btn" onClick={() => setPicking(true)}>选择</button>
            )}
          </div>
          {picking && candidates.length > 0 && (
            <div className="id-invite-candidates">
              {candidates.map((f) => (
                <button key={f.characterId} className="id-invite-candidate" onClick={() => addFriend(f.characterId)}>
                  {f.name}
                </button>
              ))}
            </div>
          )}
          {picking && candidates.length === 0 && query.trim() && (
            <div className="id-invite-nomatch">没有匹配的好友</div>
          )}
        </div>

        {/* 开场方式 */}
        <label className="id-deity-pick-toggle" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={deityPick}
            onChange={e => { setDeityPick(e.target.checked); setError(''); }}
          />
          <span className="id-deity-pick-label">伪装成随机抽选开场</span>
          <span className="id-deity-pick-hint">{deityPick ? '对方以为是主神随机选中，其实是你挑的' : '正常邀请（对方知道是应邀而来）'}</span>
        </label>

        {error && <div className="id-modal-error">{error}</div>}

        <div className="id-modal-actions">
          <button className="id-btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="id-btn primary" onClick={start} disabled={busy || selected.length === 0}>
            {busy ? '发起中…' : `确定邀请（${selected.length}人）`}
          </button>
        </div>
      </div>
    </div>
  );
}
