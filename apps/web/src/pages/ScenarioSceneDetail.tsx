import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { ScenarioInfo } from '../lib/api';
import type { View } from '../App';

export function ScenarioSceneDetail({
  scenarioId,
  onBack,
  onNavigate,
}: {
  scenarioId: string;
  onBack: () => void;
  onNavigate: (view: View) => void;
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
      onNavigate({ type: 'scenario-scene', scenarioSessionId: result.sessionId });
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
      onNavigate({ type: 'scenario-scene', scenarioSessionId: result.sessionId });
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

  if (loading) {
    return (
      <div className="id-app id-scenarios">
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">剧本详情</span>
        </div>
        <div className="id-empty">加载中...</div>
      </div>
    );
  }

  if (!scenario) {
    return (
      <div className="id-app id-scenarios">
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">剧本详情</span>
        </div>
        <div className="id-empty">剧本不存在或已删除</div>
      </div>
    );
  }

  return (
    <div className="id-app id-scenario-detail">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">{scenario.title}</span>
      </div>

      <div className="id-scenario-detail-body">
        {/* 摘要 */}
        <div className="id-scenario-detail-section">
          <p className="id-scenario-detail-desc">{scenario.description}</p>
          <div className="id-scenario-detail-meta">
            <span>游玩{scenario.playCount}次</span>
            <span className={`id-scenario-badge ${isMulti ? 'multi' : 'single'}`}>
              {isMulti ? '多人' : '单人'}
            </span>
          </div>
        </div>

        {/* 世界观 */}
        {scenario.worldview?.trim() && (
          <div className="id-scenario-detail-field">
            <h4>世界观</h4>
            <p>{scenario.worldview}</p>
          </div>
        )}

        {/* 玩家身份 */}
        {scenario.playerRole?.trim() && (
          <div className="id-scenario-detail-field">
            <h4>玩家身份</h4>
            <p>{scenario.playerRole}</p>
          </div>
        )}

        {/* NPC角色 */}
        {isMulti ? (
          <div className="id-scenario-detail-field">
            <h4>NPC角色列表</h4>
            <div className="id-scenario-detail-stats">
              {scenario.npcRoles.map((role, i) => (
                <div key={i} className="id-scenario-detail-stat-item">
                  <div className="id-stat-item-header">
                    <strong>角色 {i + 1}{role.identity ? ` · ${role.identity}` : ''}</strong>
                  </div>
                  {role.description?.trim() && <p>{role.description}</p>}
                  {!role.description?.trim() && <p style={{ opacity: 0.5 }}>（未填写身份描述）</p>}
                  {scenario.greetings?.[i]?.trim() && (
                    <p className="id-scenario-detail-greeting"><span style={{ opacity: 0.6 }}>开场白：</span>{scenario.greetings[i]}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="id-scenario-detail-field">
            <h4>NPC角色列表</h4>
            <p style={{ opacity: 0.5 }}>未设置角色槽位</p>
          </div>
        )}

        {/* 开局情境 */}
        {scenario.openingScene?.trim() && (
          <div className="id-scenario-detail-field">
            <h4>开局情境</h4>
            <p>{scenario.openingScene}</p>
          </div>
        )}

        {/* 开场白（仅单人剧本显示在这里，多人剧本开场白跟在角色列表里） */}
        {!isMulti && scenario.greeting?.trim() && (
          <div className="id-scenario-detail-field">
            <h4>开场白</h4>
            <p>{scenario.greeting}</p>
          </div>
        )}

        {/* 目标 */}
        {scenario.goal?.trim() && (
          <div className="id-scenario-detail-field">
            <h4>目标</h4>
            <p>{scenario.goal}</p>
          </div>
        )}

        {/* 数值系统 */}
        {scenario.statsConfig.length > 0 && (
          <div className="id-scenario-detail-field">
            <h4>数值系统</h4>
            <div className="id-scenario-detail-stats">
              {scenario.statsConfig.map((s, i) => (
                <div key={i} className="id-scenario-detail-stat-item">
                  <div className="id-stat-item-header">
                    <strong>{s.name}</strong>
                    {s.target !== null && <span>目标 {s.target}</span>}
                    <span>初始 {s.initial}</span>
                  </div>
                  {s.rules && <p>{s.rules}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="id-scenario-detail-actions">
          <button
            className="id-scenario-detail-enter"
            onClick={() => { setShowEnter(true); loadFriends(); }}
          >进入剧本</button>
        </div>
      </div>

      {/* 选好友弹窗 */}
      {showEnter && (
        <div className="id-modal-overlay" onClick={() => { setShowEnter(false); setSelectedIds([]); setError(''); }}>
          <div className="id-modal" onClick={e => e.stopPropagation()}>
            <h3>{isMulti ? '选择NPC分配' : '选择NPC'}</h3>
            <p className="id-modal-hint">
              {isMulti
                ? `选择 ${scenario.npcRoles.length} 个好友NPC进入「${scenario.title}」`
                : `选择一个好友NPC进入「${scenario.title}」`}
            </p>
            {isMulti && (
              <div className="id-npc-role-slots">
                {scenario.npcRoles.map((role, i) => (
                  <div key={i} className="id-npc-role-slot">
                    <div className="id-npc-role-slot-label">
                      <strong>角色 {i + 1}{role.identity ? ` · ${role.identity}` : ''}</strong>
                      {role.description?.trim() && <span className="id-npc-role-slot-desc">{role.description}</span>}
                    </div>
                    <span>{selectedIds[i]
                      ? friends.find(f => f.characterId === selectedIds[i])?.name ?? '？'
                      : '未选择'}</span>
                  </div>
                ))}
              </div>
            )}
            {friendsLoading ? (
              <div className="id-empty">加载好友...</div>
            ) : friends.length === 0 ? (
              <div className="id-empty">暂无好友NPC</div>
            ) : (
              <div className="id-friend-picker">
                {friends.map(f => {
                  const selected = selectedIds.includes(f.characterId);
                  return (
                    <button
                      key={f.characterId}
                      className={'id-friend-option' + (selected ? ' selected' : '')}
                      disabled={entering}
                      onClick={() => isMulti ? toggleSelect(f.characterId) : handleEnterSingle(f.characterId)}
                    >
                      {f.name}{selected ? ' ✓' : ''}
                    </button>
                  );
                })}
              </div>
            )}
            {error && <div className="id-error-text">{error}</div>}
            {isMulti && (
              <button
                className="id-scenario-detail-enter"
                disabled={entering || selectedIds.length !== (scenario.npcRoles?.length ?? 0)}
                onClick={handleEnterMulti}
              >{entering ? '进入中...' : '确认进入'}</button>
            )}
            <button className="id-modal-close" onClick={() => { setShowEnter(false); setSelectedIds([]); setError(''); }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
