import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { MissionInfo } from '../lib/api';
import type { View } from '../App';

interface ActiveSessionInfo {
  id: string;
  characterName: string;
  locationName: string;
}

export function MissionsApp({
  onBack,
  onNavigate,
}: {
  onBack: () => void;
  onNavigate: (view: View) => void;
}) {
  const [activeSession, setActiveSession] = useState<ActiveSessionInfo | null>(null);
  const [missions, setMissions] = useState<MissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [showCompanionPicker, setShowCompanionPicker] = useState<string | null>(null);
  const [friends, setFriends] = useState<{ characterId: string; name: string }[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [sessionData, missionData] = await Promise.all([
        api.getActiveSession(),
        api.getMissions(),
      ]);
      if (sessionData.session) {
        setActiveSession({
          id: sessionData.session.id,
          characterName: sessionData.session.characterName,
          locationName: sessionData.session.locationName,
        });
      } else {
        setActiveSession(null);
      }
      setMissions(missionData.missions);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      await api.generateMission();
      await loadData();
    } catch (err) {
      alert((err as Error).message || '生成失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleAcceptClick = async (missionId: string) => {
    setFriendsLoading(true);
    setShowCompanionPicker(missionId);
    try {
      const data = await api.getMissionFriends();
      setFriends(data.friends);
      if (data.friends.length === 0) {
        alert('还没有好友NPC，先在主城认识一些角色吧');
        setShowCompanionPicker(null);
      }
    } catch {
      alert('获取好友列表失败');
      setShowCompanionPicker(null);
    } finally {
      setFriendsLoading(false);
    }
  };

  const handleAccept = async (missionId: string, companionId: string) => {
    try {
      const data = await api.acceptMission(missionId, companionId);
      setShowCompanionPicker(null);
      onNavigate({ type: 'conversation', sessionId: data.sessionId, characterId: '', locationId: '' });
    } catch (err) {
      alert((err as Error).message || '接受任务失败');
    }
  };

  const handleDecline = async (missionId: string) => {
    try {
      await api.declineMission(missionId);
      await loadData();
    } catch {
      alert('操作失败');
    }
  };

  const availableMissions = missions.filter(m => m.status === 'available');
  const activeMissions = missions.filter(m => m.status === 'active');
  const completedMissions = missions.filter(m => m.status === 'completed');
  const hasWorldMission = missions.some(m => m.questType === 'world' && (m.status === 'available' || m.status === 'active'));

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">待办</span>
      </div>
      <div className="id-app-scroll">
        {/* 约会进行中 */}
        {activeSession && (
          <>
            <div className="id-mission-section-title">💗 约会进行中</div>
            <div className="id-mission-list" style={{ marginBottom: '1rem' }}>
              <div className="id-mission-card active">
                <div className="id-mission-check">💗</div>
                <div className="id-mission-info">
                  <div className="id-mission-title">{activeSession.characterName}</div>
                  <div className="id-mission-hint">📍 {activeSession.locationName || '任务世界'}</div>
                </div>
                <button className="id-mission-go-btn" onClick={() => onNavigate({ type: 'conversation', sessionId: activeSession.id, characterId: '', locationId: '' })}>
                  继续
                </button>
              </div>
            </div>
          </>
        )}

        {/* 世界任务 */}
        <div className="id-mission-section-title">🌍 世界任务</div>
        {loading ? (
          <div className="id-empty"><span>加载中…</span></div>
        ) : (
          <>
            {/* 可接受的任务 */}
            {availableMissions.map(m => (
              <MissionCard
                key={m.id}
                mission={m}
                onAccept={() => handleAcceptClick(m.id)}
                onDecline={() => handleDecline(m.id)}
              />
            ))}

            {/* 进行中的任务 */}
            {activeMissions.map(m => (
              <div key={m.id} className="id-mission-card active" style={{ marginBottom: '0.5rem' }}>
                <div className="id-mission-check">⚡</div>
                <div className="id-mission-info">
                  <div className="id-mission-title">{m.title}</div>
                  <div className="id-mission-hint">{m.worldName} · 进行中</div>
                </div>
              </div>
            ))}

            {/* 生成新任务按钮 */}
            {!hasWorldMission && !activeSession && (
              <button
                className="id-mission-generate-btn"
                onClick={handleGenerate}
                disabled={generating}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '1px dashed var(--border)',
                  borderRadius: '0.75rem',
                  background: 'transparent',
                  color: 'var(--text-mute)',
                  cursor: generating ? 'wait' : 'pointer',
                  fontSize: '0.85rem',
                  marginBottom: '0.5rem',
                }}
              >
                {generating ? '生成中…' : '＋ 寻找任务'}
              </button>
            )}

            {/* 已完成的任务 */}
            {completedMissions.length > 0 && (
              <>
                <div className="id-mission-section-title" style={{ marginTop: '1rem', fontSize: '0.72rem', color: 'var(--text-mute)' }}>已完成</div>
                {completedMissions.slice(0, 5).map(m => (
                  <div key={m.id} className="id-mission-card done" style={{ marginBottom: '0.5rem' }}>
                    <div className="id-mission-check">
                      {m.ratingScore && m.ratingScore > 0 ? '★'.repeat(m.ratingScore) : '✗'}
                    </div>
                    <div className="id-mission-info">
                      <div className="id-mission-title" style={{ textDecoration: 'line-through', opacity: 0.6 }}>{m.title}</div>
                      <div className="id-mission-hint">
                        {m.evaluationResult ? m.evaluationResult.summary : '已完成'}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* 空状态 */}
            {!hasWorldMission && availableMissions.length === 0 && activeMissions.length === 0 && completedMissions.length === 0 && !generating && (
              <div className="id-empty">
                <span style={{ fontSize: '2.5rem' }}>🌍</span>
                <span>暂无世界任务</span>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-mute)' }}>点击「寻找任务」开始冒险</span>
              </div>
            )}
          </>
        )}

        {/* 同伴选择器 */}
        {showCompanionPicker && (
          <CompanionPicker
            friends={friends}
            loading={friendsLoading}
            onPick={(companionId) => handleAccept(showCompanionPicker, companionId)}
            onCancel={() => setShowCompanionPicker(null)}
          />
        )}
      </div>
    </div>
  );
}

// ─── 任务卡片 ─────────────────────────────────────────────

function MissionCard({ mission, onAccept, onDecline }: {
  mission: MissionInfo;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="id-mission-card active" style={{ marginBottom: '0.5rem', flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', width: '100%' }} onClick={() => setExpanded(!expanded)}>
        <div className="id-mission-check">🌍</div>
        <div className="id-mission-info" style={{ flex: 1 }}>
          <div className="id-mission-title">{mission.worldName || '未知世界'}</div>
          <div className="id-mission-hint">
            回收：{mission.item}
            {mission.reward > 0 && ` · 奖励${mission.reward}权限`}
          </div>
        </div>
        <span style={{ color: 'var(--text-mute)', fontSize: '0.7rem' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          <div style={{ marginBottom: '0.4rem' }}>{mission.briefing}</div>
          <div style={{ color: 'var(--text-mute)', fontSize: '0.72rem', marginBottom: '0.4rem' }}>
            📦 {mission.item}<br />
            💭 {mission.obsession}
          </div>
          {mission.worldTension && (
            <div style={{ color: 'var(--text-mute)', fontSize: '0.72rem', marginBottom: '0.4rem' }}>
              ⚡ {mission.worldTension}
            </div>
          )}
          {mission.landmarks.length > 0 && (
            <div style={{ color: 'var(--text-mute)', fontSize: '0.72rem', marginBottom: '0.4rem' }}>
              {mission.landmarks.map(l => `📍 ${l.name}：${l.feature}`).join('\n')}
            </div>
          )}
          {mission.minorCharacters.length > 0 && (
            <div style={{ color: 'var(--text-mute)', fontSize: '0.72rem', marginBottom: '0.6rem' }}>
              {mission.minorCharacters.map(c => `👤 ${c.name}：${c.trait}`).join('\n')}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={onAccept}
              style={{
                flex: 1, padding: '0.5rem', border: 'none', borderRadius: '0.5rem',
                background: 'var(--accent)', color: '#fff', fontSize: '0.8rem', cursor: 'pointer',
              }}
            >
              接受任务
            </button>
            <button
              onClick={onDecline}
              style={{
                flex: 1, padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '0.5rem',
                background: 'transparent', color: 'var(--text-mute)', fontSize: '0.8rem', cursor: 'pointer',
              }}
            >
              拒绝
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 同伴选择器 ───────────────────────────────────────────

function CompanionPicker({ friends, loading, onPick, onCancel }: {
  friends: { characterId: string; name: string }[];
  loading: boolean;
  onPick: (companionId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex',
      alignItems: 'flex-end', zIndex: 100,
    }} onClick={onCancel}>
      <div
        style={{
          background: 'var(--bg)', borderRadius: '1rem 1rem 0 0', padding: '1rem',
          width: '100%', maxHeight: '60vh', overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text)' }}>
          选择同行NPC
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-mute)', padding: '1rem' }}>加载中…</div>
        ) : friends.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-mute)', padding: '1rem' }}>还没有好友NPC</div>
        ) : (
          friends.map(f => (
            <button
              key={f.characterId}
              onClick={() => onPick(f.characterId)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem', width: '100%',
                padding: '0.7rem', border: '1px solid var(--border)', borderRadius: '0.6rem',
                background: 'transparent', marginBottom: '0.4rem', cursor: 'pointer',
              }}
            >
              <div style={{
                width: '2rem', height: '2rem', borderRadius: '50%',
                background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.85rem',
              }}>{f.name.charAt(0)}</div>
              <span style={{ color: 'var(--text)', fontSize: '0.85rem' }}>{f.name}</span>
            </button>
          ))
        )}
        <button
          onClick={onCancel}
          style={{
            width: '100%', padding: '0.6rem', marginTop: '0.5rem',
            border: 'none', background: 'transparent', color: 'var(--text-mute)',
            fontSize: '0.8rem', cursor: 'pointer',
          }}
        >
          取消
        </button>
      </div>
    </div>
  );
}

