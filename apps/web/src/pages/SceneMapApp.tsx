import { useState, useEffect } from 'react';
import { api, imageUrl } from '../lib/api';
import type { SceneLocationInfo } from '../lib/api';

const SYSTEM_EMOJI: Record<string, string> = {
  plaza: '⛲',
  cafe: '☕',
  park: '🌳',
  market: '🏮',
};
const DEFAULT_EMOJIS = ['🌟', '🎪', '🎨', '🎵', '🌙', '🔥', '❄️', '🌸'];

/**
 * 新场景地图列表页 —— 只显示顶层地点入口，点进地点后再逐层往下。
 * 子地点在对应地点的决策页里作为"区域"进入。
 */
export function SceneMapApp({
  onBack,
  onOpenLocation,
}: {
  onBack: () => void;
  onOpenLocation: (locationId: string) => void;
}) {
  const [locations, setLocations] = useState<SceneLocationInfo[]>([]);
  const [npcs, setNpcs] = useState<Record<string, { characterId: string; name: string; avatarType?: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown'; activity: string }[]>>({});
  const [loading, setLoading] = useState(true);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null); // 点头像看行程

  const loadData = async () => {
    try {
      const [locData, npcData] = await Promise.all([api.sceneLocations(), api.sceneMapNpcs()]);
      setLocations(locData.locations);
      setNpcs(npcData.locations);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  // 只保留顶层地点：没有父节点，或父节点不在列表中
  const inList = new Set(locations.map(l => l.id));
  const roots = locations.filter(l => !l.parentId || !inList.has(l.parentId));

  // 卡片头像聚合：给定地点id，返回它自己 + 所有后代地点里的确切在场角色。
  // 顶层是区域入口，但玩家要通过顶层卡片的头像找到每个角色。
  const collectChars = (rootId: string) => {
    const seen = new Map<string, { characterId: string; name: string; avatarType?: 'image' | 'initial'; avatar: string; visibility: 'friend' | 'stranger' | 'unknown' }>();
    const walk = (id: string) => {
      for (const n of npcs[id] ?? []) {
        if (!seen.has(n.characterId)) seen.set(n.characterId, n);
      }
      for (const l of locations) {
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
        <span className="id-appbar-title">地图</span>
        <span className="id-map-tag" style={{ position: 'static' }}>实验</span>
      </div>
      <div className="id-app-scroll">
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : (
          <div className="id-map-list">
            {roots.map((loc, i) => {
              const emoji = SYSTEM_EMOJI[loc.id] ?? DEFAULT_EMOJIS[i % DEFAULT_EMOJIS.length];
              const locChars = collectChars(loc.id);
              return (
                <button
                  key={loc.id}
                  className="id-map-card unlocked"
                  onClick={() => onOpenLocation(loc.id)}
                >
                  {loc.background && (
                    <div className="id-map-card-bg" style={{ backgroundImage: `url(${imageUrl(loc.background)})` }} aria-hidden />
                  )}
                  <div className="id-map-emoji">{emoji}</div>
                  <div className="id-map-info">
                    <div className="id-map-name">
                      {loc.name}
                      {loc.creatorType === 'player' && (
                        <span className="id-map-tag">{loc.isPublic ? '公开' : '私有'}</span>
                      )}
                    </div>
                    <div className="id-map-desc">{loc.summary || '一个地方'}</div>
                    {(locChars.length > 0 || loc.npcs.length > 0) && (
                      <div className="id-map-npcs">
                        {locChars.map(n => {
                          const displayName = n.visibility === 'unknown' ? '?' : n.name;
                          return (
                            <button
                              key={n.characterId}
                              className="id-map-npc-tag"
                              title={`查看${n.name}的行程`}
                              onClick={e => { e.stopPropagation(); setScheduleCharId(n.characterId); }}
                            >
                              <span className="id-map-npc-avatar">{n.avatarType === 'image' && n.avatar ? <img src={imageUrl(n.avatar)} alt="" className="id-map-npc-avatar-img" /> : (n.name?.charAt(0) ?? '?')}</span>
                              {displayName}
                            </button>
                          );
                        })}
                        {loc.npcs.map(n => (
                          <span key={n.id} className="id-map-npc-tag">
                            <span className="id-map-npc-avatar">{n.name.charAt(0)}</span>
                            {n.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="id-map-action">进入</div>
                </button>
              );
            })}
            {roots.length === 0 && (
              <div className="id-empty"><span>🍃</span><span>还没有地点</span></div>
            )}
          </div>
        )}
      </div>

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
