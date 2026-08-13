import { useState, useEffect } from 'react';
import type { View } from '../App';
import { api } from '../lib/api';
import type { LocationInfo } from '../lib/api';
import { AutoTextarea } from '../components/AutoTextarea';

interface MapNpc {
  characterId: string;
  name: string;
  avatar: string;
  visibility: 'friend' | 'stranger' | 'unknown';
  activity: string;
}

// 系统地点的emoji映射
const SYSTEM_EMOJI: Record<string, string> = {
  plaza: '⛲',
  cafe: '☕',
  park: '🌳',
  market: '🏮',
};

const DEFAULT_EMOIJS = ['🌟', '🎪', '🎨', '🎵', '🌙', '🔥', '❄️', '🌸'];

export function MapApp({
  onBack,
  onNavigate,
}: {
  onBack: () => void;
  onNavigate: (view: View) => void;
}) {
  const [npcs, setNpcs] = useState<Record<string, MapNpc[]>>({});
  const [locations, setLocations] = useState<LocationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null);
  const [homesExpanded, setHomesExpanded] = useState(false);

  const loadData = async () => {
    try {
      const [npcData, locData] = await Promise.all([api.getMapNpcs(), api.getLocations()]);
      setNpcs(npcData.locations);
      setLocations(locData.locations);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  const handleVisit = (loc: LocationInfo) => {
    onNavigate({ type: 'location-detail', locationId: loc.id });
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">地图</span>
      </div>
      <div className="id-app-scroll">
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : (
          <div className="id-map-list">
            {(() => {
              const publicLocs = locations.filter(l => !l.isHome);
              const homeLocs = locations.filter(l => l.isHome);
              const renderCard = (loc: LocationInfo, i: number) => {
                const locNpcs = npcs[loc.id] ?? [];
                const emoji = SYSTEM_EMOJI[loc.id] ?? DEFAULT_EMOIJS[i % DEFAULT_EMOIJS.length];
                return (
                  <button
                    key={loc.id}
                    className="id-map-card unlocked"
                    onClick={() => handleVisit(loc)}
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
                                onClick={(e) => {
                                  if (n.visibility === 'friend') {
                                    e.stopPropagation();
                                    setScheduleCharId(n.characterId);
                                  }
                                }}
                              >
                                <span className="id-map-npc-avatar">{n.avatar}</span>
                                {displayName}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="id-map-action">前往</div>
                  </button>
                );
              };

              return (
                <>
                  {publicLocs.map((loc, i) => renderCard(loc, i))}
                  {homeLocs.length > 0 && (
                    <>
                      <button
                        className="id-map-card id-map-collapse-toggle"
                        onClick={() => setHomesExpanded(v => !v)}
                      >
                        <div className="id-map-emoji">🏠</div>
                        <div className="id-map-info">
                          <div className="id-map-name">住所（{homeLocs.length}）</div>
                          <div className="id-map-desc">
                            {homesExpanded ? '点击收起' : `${homeLocs.length}个住处`}
                          </div>
                        </div>
                        <div className="id-map-action">{homesExpanded ? '收起' : '展开'}</div>
                      </button>
                      {homesExpanded && homeLocs.map((loc, i) => renderCard(loc, i))}
                    </>
                  )}
                  <button className="id-map-card id-map-create" onClick={() => setShowCreate(true)}>
                    <div className="id-map-emoji">➕</div>
                    <div className="id-map-info">
                      <div className="id-map-name">创建地点</div>
                      <div className="id-map-desc">添加一个新地点</div>
                    </div>
                  </button>
                </>
              );
            })()}
          </div>
        )}
      </div>

      {showCreate && (
        <CreateLocationModal
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadData(); }}
        />
      )}

      {scheduleCharId && (
        <ScheduleModal
          characterId={scheduleCharId}
          onClose={() => setScheduleCharId(null)}
        />
      )}
    </div>
  );
}

function CreateLocationModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
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
      await api.createLocation({ name: name.trim(), summary: summary.trim() || undefined, isPublic });
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
        <div className="id-modal-title">创建地点</div>
        <div className="id-modal-desc">在主城中创建一个新地点，NPC会出现在这里</div>

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

function ScheduleModal({ characterId, onClose }: { characterId: string; onClose: () => void }) {
  const [data, setData] = useState<{
    characterName: string;
    current: { locationName: string; activity: string; startTime: number; duration: number } | null;
    upcoming: { locationName: string; activity: string; startTime: number; duration: number }[];
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getNpcSchedule(characterId).then(setData).catch((e) => {
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
