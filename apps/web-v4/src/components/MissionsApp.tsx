import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DivineResult, type MissionInfo } from '../lib/api';

interface YaoCast {
  coins: boolean[]; // 三枚铜钱正反（true=背）
  backs: number;    // 背数 0-3
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 任务世界（/missions）：完整世界危机任务流程。
 * 世界任务（world，雪中送炭）+ 邀请任务（npc，轻松可拒绝）。
 * 摇卦 → 生成 → 接受（选同伴）→ 跳转场景对话。
 */
export function MissionsApp({
  onBack,
  onOpenScene,
}: {
  onBack: () => void;
  onOpenScene: (sessionId: string) => void;
}) {
  const [missions, setMissions] = useState<MissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [activeSession, setActiveSession] = useState<{ id: string; characterName: string; locationName: string } | null>(null);

  const [showDivine, setShowDivine] = useState(false);
  const [showCompanionPicker, setShowCompanionPicker] = useState<string | null>(null);
  const [friends, setFriends] = useState<{ characterId: string; name: string }[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [mData, sData] = await Promise.all([api.getMissions(), api.getActiveSession()]);
      setMissions(mData.missions);
      if (sData.session) {
        setActiveSession({ id: sData.session.id, characterName: sData.session.characterName, locationName: sData.session.locationName });
      } else {
        setActiveSession(null);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleGenerate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      await api.generateMission();
      await loadData();
    } catch (err) {
      alert((err as Error).message || '生成任务失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleDivineConfirm = async (cast: number[]) => {
    setShowDivine(false);
    setGenerating(true);
    try {
      await api.prepareMission(cast);
      await loadData();
    } catch (err) {
      alert((err as Error).message || '生成任务失败');
    } finally {
      setGenerating(false);
    }
  };

  const handleAcceptClick = async (missionId: string) => {
    // 世界任务需要选同伴
    setFriendsLoading(true);
    try {
      const data = await api.getMissionFriends();
      setFriends(data.friends);
      setShowCompanionPicker(missionId);
    } catch {
      alert('获取好友列表失败');
    } finally {
      setFriendsLoading(false);
    }
  };

  const handleAccept = async (missionId: string, companionId: string) => {
    try {
      const data = await api.acceptMission(missionId, companionId);
      setShowCompanionPicker(null);
      onOpenScene(data.sessionId);
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

  const npcAvailable = availableMissions.filter(m => m.questType === 'npc');
  const worldAvailable = availableMissions.filter(m => m.questType === 'world');
  const npcActive = activeMissions.filter(m => m.questType === 'npc');
  const worldActive = activeMissions.filter(m => m.questType === 'world');

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent text-ink">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button className="text-ink-soft hover:text-rose" onClick={onBack}>←</button>
        <span className="font-semibold text-ink">任务世界</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-[81px]">
        {/* 约会进行中 */}
        {activeSession && (
          <div className="mb-4">
            <div className="mb-2 text-sm font-semibold text-rose">💗 约会进行中</div>
            <div className="flex items-center gap-3 rounded-xl border border-border frosted-glass p-3">
              <span className="text-lg">💗</span>
              <div className="flex-1">
                <div className="text-sm font-semibold text-ink">{activeSession.characterName}</div>
                <div className="text-xs text-ink-soft">📍 {activeSession.locationName || '任务世界'}</div>
              </div>
              <button
                className="rounded-lg bg-rose px-3 py-1.5 text-xs font-semibold text-ink-on"
                onClick={() => onOpenScene(activeSession.id)}
              >
                继续
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-8 text-center text-sm text-ink-soft">加载中…</div>
        ) : (
          <>
            {/* 邀请任务（npc） */}
            {(npcAvailable.length > 0 || npcActive.length > 0) && (
              <div className="mb-4">
                <div className="mb-2 text-sm font-semibold text-rose">💌 邀请</div>
                {npcAvailable.map(m => (
                  <NpcMissionCard key={m.id} mission={m} onAccept={() => handleAccept(m.id, '')} onDecline={() => handleDecline(m.id)} />
                ))}
                {npcActive.map(m => (
                  <ActiveMissionRow key={m.id} mission={m} onOpenScene={onOpenScene} />
                ))}
              </div>
            )}

            {/* 世界任务（world） */}
            <div className="mb-2 text-sm font-semibold text-rose">🌍 世界任务</div>
            {worldAvailable.map(m => (
              <MissionCard key={m.id} mission={m} onAccept={() => handleAcceptClick(m.id)} onDecline={() => handleDecline(m.id)} />
            ))}
            {worldActive.map(m => (
              <ActiveMissionRow key={m.id} mission={m} onOpenScene={onOpenScene} />
            ))}

            {/* 生成新任务按钮 */}
            {!hasWorldMission && !activeSession && (
              <button
                className="mb-2 w-full rounded-xl border border-dashed border-border bg-transparent py-3 text-sm text-ink-soft"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? '生成中…' : '＋ 寻找任务'}
              </button>
            )}

            {/* 已完成 */}
            {completedMissions.length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-xs text-ink-soft">已完成</div>
                {completedMissions.slice(0, 5).map(m => (
                  <div key={m.id} className="mb-2 flex items-center gap-3 rounded-xl border border-border frosted-glass p-3">
                    <div className="text-xs text-ink-soft">
                      {m.ratingScore && m.ratingScore > 0 ? '★'.repeat(m.ratingScore) : '✗'}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm line-through text-ink">{m.worldName || m.title}</div>
                      <div className="text-xs text-ink-soft">{m.evaluationResult ? m.evaluationResult.summary : '已完成'}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 空状态 */}
            {!hasWorldMission && availableMissions.length === 0 && activeMissions.length === 0 && completedMissions.length === 0 && !generating && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <span className="text-4xl">🌍</span>
                <span className="text-sm text-ink">暂无世界任务</span>
                <span className="text-xs text-ink-soft">点击「寻找任务」开始冒险</span>
              </div>
            )}
          </>
        )}
      </div>

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
        <DivinationOverlay onConfirm={handleDivineConfirm} onCancel={() => setShowDivine(false)} />
      )}
    </div>
  );
}

// ─── 邀请任务卡片（npc） ─────────────────────────────────────

function NpcMissionCard({ mission, onAccept, onDecline }: {
  mission: MissionInfo;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const title = mission.title.replace(/^邀请任务：/, '');
  return (
    <div className="mb-2 rounded-xl border border-border frosted-glass p-3">
      <div className="flex items-start">
        <span className="mr-2">💌</span>
        <div className="flex-1">
          <div className="text-sm font-semibold text-ink">{title}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-ink-soft">{mission.description}</div>
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <button className="flex-1 rounded-lg bg-rose py-2 text-xs font-semibold text-ink-on" onClick={onAccept}>接受邀请</button>
        <button className="flex-1 rounded-lg border border-border bg-transparent py-2 text-xs text-ink-soft" onClick={onDecline}>婉拒</button>
      </div>
    </div>
  );
}

// ─── 进行中任务行 ───────────────────────────────────────────

function ActiveMissionRow({ mission, onOpenScene }: {
  mission: MissionInfo;
  onOpenScene: (sessionId: string) => void;
}) {
  const title = mission.title.replace(/^邀请任务：/, '');
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-border frosted-glass p-3">
      <span className="text-sm">⚡</span>
      <div className="flex-1">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="text-xs text-ink-soft">{mission.worldName || '任务世界'} · 进行中</div>
      </div>
      {mission.sessionId && (
        <button className="rounded-lg bg-rose px-3 py-1.5 text-xs font-semibold text-ink-on" onClick={() => onOpenScene(mission.sessionId as string)}>
          继续
        </button>
      )}
    </div>
  );
}

// ─── 世界任务卡片 ───────────────────────────────────────────

function MissionCard({ mission, onAccept, onDecline }: {
  mission: MissionInfo;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const coreNpcs = (mission.worldNpcs || []).filter(n => n.role === '任务核心对象');

  return (
    <div className="mb-2 rounded-xl border border-border frosted-glass p-3">
      <div className="flex cursor-pointer items-center" onClick={() => setExpanded(!expanded)}>
        <span className="mr-2">🌍</span>
        <div className="flex-1">
          <div className="text-sm font-semibold text-ink">{mission.worldName || '未知世界'}</div>
          <div className="text-xs text-ink-soft">
            {mission.briefing || mission.description}
            {mission.reward > 0 && ` · 奖励${mission.reward}权限`}
          </div>
        </div>
        <span className="text-xs text-ink-soft">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="px-1 pt-2 text-xs leading-relaxed text-ink">
          {mission.worldTension && <div className="mb-1">⚡ {mission.worldTension}</div>}
          {mission.targetState && <div className="mb-1">🎯 {mission.targetState}</div>}
          {(mission.landmarks || []).length > 0 && (
            <div className="mb-1">
              {mission.landmarks.map(l => <div key={l.name}>📍 {l.name}：{l.feature}</div>)}
            </div>
          )}
          {mission.descendIdentity && (mission.descendIdentity.player || mission.descendIdentity.maleLead) && (
            <div className="mb-2">
              {mission.descendIdentity.player && <div>🧭 玩家身份：{mission.descendIdentity.player}</div>}
              {mission.descendIdentity.maleLead && <div>💞 同行者身份：{mission.descendIdentity.maleLead}</div>}
            </div>
          )}
          {coreNpcs.length > 0 && (
            <div className="mb-2">
              <div className="mb-0.5">核心对象</div>
              {coreNpcs.map(n => <div key={n.name}>👤 {n.name}：{n.persona}</div>)}
            </div>
          )}
          <div className="flex gap-2">
            <button className="flex-1 rounded-lg bg-rose py-2 text-xs font-semibold text-ink-on" onClick={onAccept}>接受任务</button>
            <button className="flex-1 rounded-lg border border-border bg-transparent py-2 text-xs text-ink-soft" onClick={onDecline}>拒绝</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 同伴选择器 ─────────────────────────────────────────────

function CompanionPicker({ friends, loading, onPick, onCancel }: {
  friends: { characterId: string; name: string }[];
  loading: boolean;
  onPick: (companionId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-end bg-black/50" onClick={onCancel}>
      <div className="max-h-[60vh] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-panel p-4" onClick={e => e.stopPropagation()}>
        <div className="mb-3 text-sm font-semibold text-ink">选择同行NPC</div>
        {loading ? (
          <div className="py-4 text-center text-sm text-ink-soft">加载中…</div>
        ) : friends.length === 0 ? (
          <div className="py-4 text-center text-sm text-ink-soft">还没有好友NPC</div>
        ) : (
          friends.map(f => (
            <button
              key={f.characterId}
              className="mb-2 flex w-full items-center gap-2 rounded-lg border border-border bg-transparent p-3 text-left"
              onClick={() => onPick(f.characterId)}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-muted/60 text-sm text-rose">{f.name.charAt(0)}</div>
              <span className="text-sm text-ink">{f.name}</span>
            </button>
          ))
        )}
        <button className="mt-2 w-full py-2 text-sm text-ink-soft" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

// ─── 摇卦界面 ───────────────────────────────────────────────

/** 背数(0-3) → 阴阳 + 是否动爻。背=阳、字=阴。3老阳○动 / 2少阴 / 1少阳 / 0老阴×动 */
function backsToYao(backs: number): { yang: boolean; dong: boolean } {
  if (backs === 3) return { yang: true, dong: true };
  if (backs === 2) return { yang: false, dong: false };
  if (backs === 1) return { yang: true, dong: false };
  return { yang: false, dong: true };
}

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

  useEffect(() => {
    if (done && !divine && !divining) {
      setDivining(true);
      api.divine(yaos.map(y => y.backs))
        .then(setDivine)
        .catch(() => setDivineError('起卦失败，请重试'))
        .finally(() => setDivining(false));
    }
  }, [done, divine, divining, yaos]);

  async function rollOne(delayMs: number) {
    const coins = [Math.random() < 0.5, Math.random() < 0.5, Math.random() < 0.5];
    const backs = coins.filter(Boolean).length;
    setFlip({ coins, dur: delayMs });
    setFlipKey(k => k + 1);
    await sleep(delayMs);
    setYaos(prev => [...prev, { coins, backs }]);
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
    for (let i = 0; i < remaining; i++) await rollOne(230);
    setRolling(false);
  }

  async function handleConfirm() {
    if (!done || confirming || !divine) return;
    setConfirming(true);
    await onConfirm(yaos.map(y => y.backs));
    setConfirming(false);
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-sm rounded-2xl border border-rose bg-panel p-5 text-ink">
        <div className="mb-4 text-center">
          <div className="text-lg font-semibold text-ink">决定你的命运</div>
          <div className="mt-1 text-xs text-ink-soft">三枚铜钱，掷出你在这个世界的命数</div>
        </div>

        {/* 六爻（从下往上） */}
        <div className="mb-4 flex justify-center">
          {total === 0 && !rolling ? (
            <div className="py-4 text-sm text-ink-soft">卦象未成</div>
          ) : (
            <div className="flex flex-col gap-1">
              {yaos.map((y, i) => {
                const { yang, dong } = backsToYao(y.backs);
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className={`w-3 text-xs ${dong ? 'text-rose' : 'text-ink-soft'}`}>{dong ? '○' : '·'}</span>
                    <div className={`flex h-1.5 w-16 gap-1 ${yang ? 'justify-center' : ''}`}>
                      {yang ? (
                        <span className="h-full flex-1 rounded bg-rose" />
                      ) : (
                        <><span className="h-full w-7 rounded bg-rose" /><span className="h-full w-7 rounded bg-rose" /></>
                      )}
                    </div>
                    <span className="flex gap-0.5">
                      {y.coins.map((c, ci) => <i key={ci} className={`h-2 w-2 rounded-full ${c ? 'bg-rose' : 'bg-bg-muted-2/50'}`} />)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 三枚铜钱 */}
        <div className="mb-4 flex justify-center gap-4">
          {[0, 1, 2].map(i => {
            const coins = flip ? flip.coins : lastCoins;
            const isBack = coins ? !!coins[i] : false;
            const dur = flip ? flip.dur : 720;
            return (
              <div key={`${flipKey}-${i}`} className="flex h-10 w-10 items-center justify-center rounded-full border border-rose text-sm"
                style={{ transform: flip ? 'rotateY(360deg)' : 'none', transition: `transform ${dur}ms`, background: isBack ? 'var(--color-rose)' : 'var(--color-bg-muted-2)' }}>
                {isBack ? '背' : '字'}
              </div>
            );
          })}
        </div>

        {/* 成卦结果 */}
        <div className="mb-4 text-center">
          {done && (
            <>
              {divining && <span className="text-sm text-ink-soft">起卦中…</span>}
              {divineError && <span className="text-sm text-ink-soft">{divineError}</span>}
              {divine && !divining && !divineError && (
                <>
                  <div className="text-2xl font-semibold text-rose">{divine.guaXiang}</div>
                  <div className="mt-1 text-xs text-ink-soft">{divine.shichen}时 · 卦成，天命已定</div>
                </>
              )}
            </>
          )}
        </div>

        {/* 操作 */}
        {!done ? (
          <div className="flex gap-2">
            <button className="flex-1 rounded-lg bg-rose py-2 text-sm font-semibold text-ink-on" onClick={handleRollOnce} disabled={rolling}>
              {rolling ? '掷…' : '掷一次'}
            </button>
            <button className="flex-1 rounded-lg border border-border py-2 text-sm text-ink-soft" onClick={handleRollAll} disabled={rolling || total === 0}>
              剩余全掷{total > 0 && total < 6 ? `（剩${6 - total}）` : ''}
            </button>
          </div>
        ) : (
          <button className="w-full rounded-lg bg-rose py-2 text-sm font-semibold text-ink-on" onClick={handleConfirm} disabled={confirming || !divine}>
            {confirming ? '命运落定中…' : '接受命运'}
          </button>
        )}

        {!done && (
          <button className="mt-2 w-full py-2 text-sm text-ink-soft" onClick={onCancel}>收起</button>
        )}
      </div>
    </div>
  );
}
