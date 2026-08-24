import { useState, useEffect, useCallback } from 'react';
import { api, type ScenarioInfo } from '../lib/api';

export function ScenarioSceneDetail({
  scenarioId,
  onBack,
  onOpenScene,
}: {
  scenarioId: string;
  onBack: () => void;
  onOpenScene: (sessionId: string) => void;
}) {
  const [scenario, setScenario] = useState<ScenarioInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [friends, setFriends] = useState<{ characterId: string; name: string }[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [showEnter, setShowEnter] = useState(false);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    try {
      const data = await api.getScenario(scenarioId);
      setScenario(data.scenario);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [scenarioId]);

  useEffect(() => { loadData(); }, [loadData]);

  const loadFriends = async () => {
    setFriendsLoading(true);
    try {
      const data = await api.getMissionFriends();
      setFriends(data.friends);
    } catch { /* ignore */ } finally {
      setFriendsLoading(false);
    }
  };

  const isMulti = (scenario?.npcRoles?.length ?? 0) >= 2;

  const handleEnterSingle = async (characterId: string) => {
    if (!scenario) return;
    setEntering(true);
    setError('');
    try {
      const result = await api.sceneScenarioEnter(scenario.id, characterId);
      onOpenScene(result.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '进入失败');
    } finally {
      setEntering(false);
    }
  };

  const handleEnterMulti = async () => {
    if (!scenario) return;
    const need = scenario.npcRoles?.length ?? 2;
    if (selectedIds.length !== need) {
      setError(`请选择 ${need} 个NPC`);
      return;
    }
    setEntering(true);
    setError('');
    try {
      const result = await api.sceneScenarioEnter(scenario.id, '', selectedIds);
      onOpenScene(result.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '进入失败');
    } finally {
      setEntering(false);
    }
  };

  const toggleSelect = (characterId: string) => {
    const max = scenario?.npcRoles?.length ?? 2;
    setSelectedIds(prev => {
      if (prev.includes(characterId)) return prev.filter(id => id !== characterId);
      if (prev.length >= max) return prev;
      return [...prev, characterId];
    });
  };

  const closeEnter = () => { setShowEnter(false); setSelectedIds([]); setError(''); };

  if (loading) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
          <button className="text-ink-soft" onClick={onBack}>←</button>
          <span className="font-semibold text-ink">剧本详情</span>
        </div>
        <div className="py-8 text-center text-sm text-ink-soft">加载中...</div>
      </div>
    );
  }

  if (!scenario) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
          <button className="text-ink-soft" onClick={onBack}>←</button>
          <span className="font-semibold text-ink">剧本详情</span>
        </div>
        <div className="py-8 text-center text-sm text-ink-soft">剧本不存在或已删除</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
        <button className="text-ink-soft" onClick={onBack}>←</button>
        <span className="truncate font-semibold text-ink">{scenario.title}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-[81px]">
        {/* 摘要 */}
        <div className="mb-4 rounded-2xl border border-border frosted-glass p-4">
          <p className="text-sm text-ink-soft" style={{ lineHeight: 1.6 }}>{scenario.description}</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-ink-faint">
            <span>游玩{scenario.playCount}次</span>
            <span className={`rounded-full px-2 py-0.5 ${isMulti ? 'bg-bg-rose-soft/60 text-rose' : 'bg-bg-muted/60 text-ink-soft'}`}>
              {isMulti ? '多人' : '单人'}
            </span>
          </div>
        </div>

        {scenario.worldview?.trim() && <Field title="世界观" text={scenario.worldview} />}
        {scenario.playerRole?.trim() && <Field title="玩家身份" text={scenario.playerRole} />}

        {/* NPC角色 */}
        <div className="mb-4">
          <h4 className="mb-1.5 text-sm font-semibold text-ink">NPC角色列表</h4>
          {isMulti ? (
            <div className="flex flex-col gap-2">
              {scenario.npcRoles.map((role, i) => (
                <div key={i} className="rounded-xl border border-border frosted-glass p-3">
                  <div className="text-sm font-semibold text-ink">角色 {i + 1}{role.identity ? ` · ${role.identity}` : ''}</div>
                  {role.description?.trim() ? <p className="mt-1 text-sm text-ink-soft" style={{ lineHeight: 1.6 }}>{role.description}</p> : <p className="mt-1 text-sm text-ink-faint">（未填写身份描述）</p>}
                  {scenario.greetings?.[i]?.trim() && (
                    <p className="mt-1 text-sm text-ink-soft"><span className="text-ink-faint">开场白：</span>{scenario.greetings[i]}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-faint">未设置角色槽位</p>
          )}
        </div>

        {scenario.openingScene?.trim() && <Field title="开局情境" text={scenario.openingScene} />}
        {!isMulti && scenario.greeting?.trim() && <Field title="开场白" text={scenario.greeting} />}
        {scenario.goal?.trim() && <Field title="目标" text={scenario.goal} />}

        {/* 数值系统 */}
        {scenario.statsConfig.length > 0 && (
          <div className="mb-4">
            <h4 className="mb-1.5 text-sm font-semibold text-ink">数值系统</h4>
            <div className="flex flex-col gap-2">
              {scenario.statsConfig.map((s, i) => (
                <div key={i} className="rounded-xl border border-border frosted-glass p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <strong className="text-ink">{s.name}</strong>
                    {s.target !== null && <span className="text-xs text-ink-faint">目标 {s.target}</span>}
                    <span className="text-xs text-ink-faint">初始 {s.initial}</span>
                  </div>
                  {s.rules && <p className="mt-1 text-sm text-ink-soft" style={{ lineHeight: 1.6 }}>{s.rules}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <button className="w-full rounded-xl bg-rose py-3 text-sm font-semibold text-ink-on" onClick={() => { setShowEnter(true); loadFriends(); }}>
          进入剧本
        </button>
      </div>

      {/* 选好友弹窗 */}
      {showEnter && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-6" onClick={closeEnter}>
          <div className="max-h-[80vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-panel p-5" onClick={e => e.stopPropagation()}>
            <h3 className="mb-1 text-base font-semibold text-ink">{isMulti ? '选择NPC分配' : '选择NPC'}</h3>
            <p className="mb-3 text-sm text-ink-soft">
              {isMulti ? `选择 ${scenario.npcRoles.length} 个好友NPC进入「${scenario.title}」` : `选择一个好友NPC进入「${scenario.title}」`}
            </p>
            {isMulti && (
              <div className="mb-3 flex flex-col gap-2">
                {scenario.npcRoles.map((role, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg bg-bg-muted/60 px-3 py-2">
                    <div>
                      <div className="text-sm font-semibold text-ink">角色 {i + 1}{role.identity ? ` · ${role.identity}` : ''}</div>
                      {role.description?.trim() && <div className="text-xs text-ink-faint">{role.description}</div>}
                    </div>
                    <span className="text-sm text-ink-soft">{selectedIds[i] ? friends.find(f => f.characterId === selectedIds[i])?.name ?? '？' : '未选择'}</span>
                  </div>
                ))}
              </div>
            )}
            {friendsLoading ? (
              <div className="py-4 text-center text-sm text-ink-soft">加载好友...</div>
            ) : friends.length === 0 ? (
              <div className="py-4 text-center text-sm text-ink-soft">暂无好友NPC</div>
            ) : (
              <div className="flex flex-col gap-2">
                {friends.map(f => {
                  const selected = selectedIds.includes(f.characterId);
                  return (
                    <button
                      key={f.characterId}
                      className={`rounded-lg border px-4 py-2.5 text-left text-sm ${selected ? 'border-rose bg-bg-rose-soft/60 text-rose' : 'border-border text-ink'}`}
                      disabled={entering}
                      onClick={() => isMulti ? toggleSelect(f.characterId) : handleEnterSingle(f.characterId)}
                    >
                      {f.name}{selected ? ' ✓' : ''}
                    </button>
                  );
                })}
              </div>
            )}
            {error && <div className="mt-2 text-xs text-rose">{error}</div>}
            {isMulti && (
              <button className="mt-3 w-full rounded-xl bg-rose py-2.5 text-sm font-semibold text-ink-on" disabled={entering || selectedIds.length !== (scenario.npcRoles?.length ?? 0)} onClick={handleEnterMulti}>
                {entering ? '进入中...' : '确认进入'}
              </button>
            )}
            <button className="mt-2 w-full py-2 text-sm text-ink-soft" onClick={closeEnter}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ title, text }: { title: string; text: string }) {
  return (
    <div className="mb-4">
      <h4 className="mb-1.5 text-sm font-semibold text-ink">{title}</h4>
      <p className="rounded-xl border border-border frosted-glass p-3 text-sm text-ink-soft" style={{ lineHeight: 1.6 }}>{text}</p>
    </div>
  );
}
