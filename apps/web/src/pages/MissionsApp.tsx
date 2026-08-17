import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { MissionInfo, DivineResult } from '../lib/api';
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
  const [showDivine, setShowDivine] = useState(false);
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

  const handleGenerate = () => {
    setShowDivine(true);
  };

  const handleDivineConfirm = async (cast: number[]) => {
    setGenerating(true);
    try {
      await api.generateMission(cast);
      await loadData();
      setShowDivine(false);
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
      onNavigate({ type: 'scenario-scene', scenarioSessionId: data.sessionId });
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
                <button className="id-mission-go-btn" onClick={() => onNavigate({ type: 'scenario-scene', scenarioSessionId: activeSession.id })}>
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
                {m.sessionId ? (
                  <button className="id-mission-go-btn" onClick={() => onNavigate({ type: 'scenario-scene', scenarioSessionId: m.sessionId as string })}>
                    继续
                  </button>
                ) : null}
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
                      <div className="id-mission-title" style={{ textDecoration: 'line-through', opacity: 0.6 }}>{m.worldName || m.title}</div>
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

        {/* 摇卦界面 */}
        {showDivine && (
          <DivinationOverlay
            onConfirm={handleDivineConfirm}
            onCancel={() => setShowDivine(false)}
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
  const coreNpcs = (mission.worldNpcs || []).filter(n => n.role === '任务核心对象');

  return (
    <div className="id-mission-card active" style={{ marginBottom: '0.5rem', flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', width: '100%' }} onClick={() => setExpanded(!expanded)}>
        <div className="id-mission-check">🌍</div>
        <div className="id-mission-info" style={{ flex: 1 }}>
          <div className="id-mission-title">{mission.worldName || '未知世界'}</div>
          <div className="id-mission-hint">
            {mission.briefing || mission.description}
            {mission.reward > 0 && ` · 奖励${mission.reward}权限`}
          </div>
        </div>
        <span style={{ color: 'var(--text-mute)', fontSize: '0.7rem' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ padding: '0.5rem 0.75rem', fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.6 }}>
          {mission.worldTension && (
            <div style={{ color: 'var(--text)', fontSize: '0.72rem', marginBottom: '0.4rem' }}>
              ⚡ {mission.worldTension}
            </div>
          )}
          {mission.targetState && (
            <div style={{ color: 'var(--text)', fontSize: '0.72rem', marginBottom: '0.4rem' }}>
              🎯 {mission.targetState}
            </div>
          )}
          {(mission.landmarks || []).length > 0 && (
            <div style={{ color: 'var(--text)', fontSize: '0.72rem', marginBottom: '0.4rem' }}>
              {mission.landmarks.map(l => (
                <div key={l.name}>📍 {l.name}：{l.feature}</div>
              ))}
            </div>
          )}
          {mission.descendIdentity && (mission.descendIdentity.player || mission.descendIdentity.maleLead) && (
            <div style={{ color: 'var(--text)', fontSize: '0.72rem', marginBottom: '0.5rem', lineHeight: 1.7 }}>
              {mission.descendIdentity.player && (
                <div>🧭 玩家身份：{mission.descendIdentity.player}</div>
              )}
              {mission.descendIdentity.maleLead && (
                <div>💞 同行者身份：{mission.descendIdentity.maleLead}</div>
              )}
            </div>
          )}
          {coreNpcs.length > 0 && (
            <div style={{ color: 'var(--text)', fontSize: '0.72rem', marginBottom: '0.6rem' }}>
              <div style={{ marginBottom: '0.15rem' }}>核心对象</div>
              {coreNpcs.map(n => (
                <div key={n.name}>👤 {n.name}：{n.persona}</div>
              ))}
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
          background: 'var(--panel)', borderRadius: '1rem 1rem 0 0', padding: '1rem',
          width: '100%', maxHeight: '60vh', overflow: 'auto', borderTop: '1px solid var(--border-bright)',
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
                background: 'var(--panel-2)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
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

// ─── 摇卦界面 ───────────────────────────────────────────

interface YaoCast {
  coins: boolean[]; // 三枚铜钱正反（true=背）
  backs: number;    // 背数 0-3
}

/** 背数(0-3) → 阴阳 + 是否动爻。背=阳、字=阴。3老阳○动 / 2少阴 / 1少阳 / 0老阴×动 */
function backsToYao(backs: number): { yang: boolean; dong: boolean } {
  if (backs === 3) return { yang: true, dong: true };
  if (backs === 2) return { yang: false, dong: false };
  if (backs === 1) return { yang: true, dong: false };
  return { yang: false, dong: true };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function DivinationOverlay({
  onConfirm,
  onCancel,
}: {
  onConfirm: (cast: number[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [yaos, setYaos] = useState<YaoCast[]>([]);
  const [flipKey, setFlipKey] = useState(0);
  const [flip, setFlip] = useState<{ coins: boolean[]; dur: number } | null>(null);
  const [rolling, setRolling] = useState(false);
  const [divine, setDivine] = useState<DivineResult | null>(null);
  const [divining, setDivining] = useState(false);
  const [divineError, setDivineError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const total = yaos.length;
  const done = total >= 6;
  const lastCoins = yaos.length > 0 ? (yaos[yaos.length - 1]?.coins ?? null) : null;

  // 成卦后自动起卦取卦名
  useEffect(() => {
    if (done && !divine && !divining) {
      setDivining(true);
      api.divine(yaos.map((y) => y.backs))
        .then(setDivine)
        .catch(() => setDivineError('起卦失败，请重试'))
        .finally(() => setDivining(false));
    }
  }, [done, divine, divining, yaos]);

  async function rollOne(delayMs: number) {
    // 结果提前生成，铜钱翻转动画直接落到目标面（金/银），避免「停下后才变色」
    const coins = [Math.random() < 0.5, Math.random() < 0.5, Math.random() < 0.5];
    const backs = coins.filter(Boolean).length;
    setFlip({ coins, dur: delayMs });
    setFlipKey((k) => k + 1);
    await sleep(delayMs);
    setYaos((prev) => [...prev, { coins, backs }]);
    setFlip(null);
  }

  async function handleRollOnce() {
    if (rolling || done) return;
    setRolling(true);
    await rollOne(820);
    setRolling(false);
  }

  async function handleRollAll() {
    if (rolling || done) return;
    setRolling(true);
    const remaining = 6 - yaos.length;
    for (let i = 0; i < remaining; i++) {
      await rollOne(230); // 加速
    }
    setRolling(false);
  }

  async function handleConfirm() {
    if (!done || confirming || !divine) return;
    setConfirming(true);
    await onConfirm(yaos.map((y) => y.backs));
    setConfirming(false);
  }

  return (
    <div className="id-divine-overlay">
      <div className="id-divine-panel">
        <div className="id-divine-title">
          <div className="id-divine-title-main">决定你的命运</div>
          <div className="id-divine-title-sub">三枚铜钱，掷出你在这个世界的命数</div>
        </div>

        {/* 六爻（从下往上） */}
        <div className="id-divine-hexagram">
          {total === 0 && !rolling ? (
            <div className="id-divine-empty">卦象未成</div>
          ) : (
            <div className="id-divine-yaos">
              {yaos.map((y, i) => {
                const { yang, dong } = backsToYao(y.backs);
                return (
                  <div className="id-yao" key={i}>
                    <span className={`id-yao-mark${dong ? ' is-dong' : ''}`}>
                      {dong && <i className={`id-yao-dong-mark${yang ? ' is-yang' : ' is-yin'}`} />}
                    </span>
                    <div className={`id-yao-bar${yang ? ' is-yang' : ' is-yin'}`}>
                      {yang
                        ? <span className="id-yao-seg" />
                        : <><span className="id-yao-seg" /><span className="id-yao-seg" /></>}
                    </div>
                    <span className="id-yao-coins">
                      {y.coins.map((c, ci) => <i key={ci} className={c ? 'is-back' : 'is-front'} />)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 三枚铜钱（金=字面 / 银=背面，真双面翻转） */}
        <div className="id-divine-coins">
          {[0, 1, 2].map((i) => {
            const coins = flip ? flip.coins : lastCoins;
            const isBack = coins ? !!coins[i] : false;
            const dur = flip ? flip.dur : 720;
            return (
              <div className="id-coin" key={`${flipKey}-${i}`}>
                <div
                  className={`id-coin-inner ${isBack ? 'is-back' : 'is-front'}${flip ? ' is-rolling' : ''}`}
                  style={{ '--flip-end': isBack ? '900deg' : '720deg', '--flip-dur': `${dur}ms` } as any}
                >
                  <div className="id-coin-face is-front" />
                  <div className="id-coin-face is-back" />
                </div>
                <span className="id-coin-hole" />
              </div>
            );
          })}
        </div>

        {/* 成卦结果 */}
        <div className="id-divine-result">
          {done && (
            <>
              {divining && <span className="id-divine-result-name">起卦中…</span>}
              {divineError && <span className="id-divine-result-name is-err">{divineError}</span>}
              {divine && !divining && !divineError && (
                <>
                  <span className="id-divine-result-gua">{divine.guaXiang}</span>
                  <span className="id-divine-result-sub">{divine.shichen}时 · 卦成，天命已定</span>
                </>
              )}
            </>
          )}
        </div>

        {/* 操作 */}
        {!done ? (
          <div className="id-divine-actions">
            <button className="id-divine-btn" onClick={handleRollOnce} disabled={rolling}>
              {rolling ? '掷…' : '掷一次'}
            </button>
            <button className="id-divine-btn is-alt" onClick={handleRollAll} disabled={rolling || total === 0}>
              剩余全掷{total > 0 && total < 6 ? `（剩${6 - total}）` : ''}
            </button>
          </div>
        ) : (
          <div className="id-divine-actions">
            <button className="id-divine-btn" onClick={handleConfirm} disabled={confirming || !divine}>
              {confirming ? '命运落定中…' : '接受命运'}
            </button>
          </div>
        )}

        {!done && (
          <button className="id-divine-cancel" onClick={onCancel}>
            收起
          </button>
        )}
      </div>
    </div>
  );
}

