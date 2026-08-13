import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { ScenarioInfo, ActiveScenarioSession } from '../lib/api';
import type { View } from '../App';

const FIELD_LABELS: { key: keyof ScenarioInfo; label: string }[] = [
  { key: 'worldview', label: '世界观' },
  { key: 'playerRole', label: '玩家身份' },
  { key: 'openingScene', label: '开局情境' },
  { key: 'goal', label: '目标' },
];

export function ScenarioDetail({
  scenarioId,
  isMine,
  onBack,
  onNavigate,
}: {
  scenarioId: string;
  isMine: boolean;
  onBack: () => void;
  onNavigate: (view: View) => void;
}) {
  const [scenario, setScenario] = useState<ScenarioInfo | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveScenarioSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [friends, setFriends] = useState<{ characterId: string; name: string }[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [showEnter, setShowEnter] = useState(false);
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [scenarioData, activeData] = await Promise.all([
        api.getScenario(scenarioId),
        api.getActiveScenario(),
      ]);
      setScenario(scenarioData.scenario);
      setActiveSession(activeData.session);
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

  const handleEnter = async () => {
    if (!scenario) return;
    if (isMulti) {
      if (selectedIds.length !== (scenario.npcRoles?.length ?? 0)) {
        setError('请选择 ' + (scenario.npcRoles?.length ?? 0) + ' 个NPC');
        return;
      }
      setEntering(true);
      setError('');
      try {
        const result = await api.enterScenario(scenario.id, '', selectedIds);
        onNavigate({ type: 'scenario-conversation', scenarioSessionId: result.scenarioSessionId });
      } catch (err) {
        setError(err instanceof Error ? err.message : '进入失败');
      } finally {
        setEntering(false);
      }
    } else {
      // 单人：直接用第一个选中的（兼容旧逻辑：点选即进入）
      // handleEnterSingle 在按钮 onClick 中直接调用
    }
  };

  const handleEnterSingle = async (characterId: string) => {
    if (!scenario) return;
    setEntering(true);
    setError('');
    try {
      const result = await api.enterScenario(scenario.id, characterId);
      onNavigate({ type: 'scenario-conversation', scenarioSessionId: result.scenarioSessionId });
    } catch (err) {
      setError(err instanceof Error ? err.message : '进入失败');
    } finally {
      setEntering(false);
    }
  };

  const toggleSelect = (characterId: string) => {
    setSelectedIds(prev => {
      if (prev.includes(characterId)) return prev.filter(id => id !== characterId);
      if (prev.length >= (scenario?.npcRoles?.length ?? 2)) return prev;
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
            <span className={`id-scenario-badge ${scenario.status}`}>
              {scenario.status === 'published' ? '已发布' : '草稿'}
            </span>
          </div>
        </div>

        {/* 各字段完整展示 */}
        {FIELD_LABELS.map(({ key, label }) => {
          const value = scenario[key] as string;
          if (!value?.trim()) return null;
          return (
            <div key={key} className="id-scenario-detail-field">
              <h4>{label}</h4>
              <p>{value}</p>
            </div>
          );
        })}

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
          {isMine ? (
            <button
              className="id-scenario-detail-edit"
              onClick={() => onNavigate({ type: 'scenario-editor', scenarioId: scenario.id })}
            >编辑</button>
          ) : (
            <button
              className="id-scenario-detail-enter"
              disabled={!!activeSession}
              onClick={() => { setShowEnter(true); loadFriends(); }}
            >{activeSession ? '已有进行中剧本' : '进入剧本'}</button>
          )}
        </div>
      </div>

      {/* 选好友弹窗 */}
      {showEnter && (
        <div className="id-modal-overlay" onClick={() => { setShowEnter(false); setSelectedIds([]); }}>
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
                    <strong>角色 {i + 1}{role.identity ? ` · ${role.identity}` : ''}</strong>
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
                onClick={handleEnter}
              >{entering ? '进入中...' : '确认进入'}</button>
            )}
            <button className="id-modal-close" onClick={() => { setShowEnter(false); setSelectedIds([]); }}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
