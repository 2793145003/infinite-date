import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { ScenarioInfo, ActiveScenarioSession } from '../lib/api';
import type { View } from '../App';

type ScenarioFilter = 'all' | 'single' | 'multi';

const isMultiScenario = (s: ScenarioInfo) => (s.npcRoles?.length ?? 0) >= 2;

const FILTER_LABELS: Record<ScenarioFilter, string> = {
  all: '全部',
  single: '单人',
  multi: '多人',
};

export function ScenarioList({
  onBack,
  onNavigate,
}: {
  onBack: () => void;
  onNavigate: (view: View) => void;
}) {
  const [tab, setTab] = useState<'browse' | 'mine'>('browse');
  const [filter, setFilter] = useState<ScenarioFilter>('all');
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [activeSession, setActiveSession] = useState<ActiveScenarioSession | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [scenarioData, activeData] = await Promise.all([
        api.getScenarios({ mine: tab === 'mine' }),
        api.getActiveScenario(),
      ]);
      setScenarios(scenarioData.scenarios);
      setActiveSession(activeData.session);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { loadData(); }, [loadData]);

  const filteredScenarios = scenarios.filter(s => {
    if (filter === 'all') return true;
    if (filter === 'multi') return isMultiScenario(s);
    return !isMultiScenario(s);
  });

  return (
    <div className="id-app id-scenarios">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">剧本</span>
      </div>

      {activeSession && (
        <div className="id-scenario-active-banner" onClick={() => onNavigate({ type: 'scenario-conversation', scenarioSessionId: activeSession.scenarioSessionId })}>
          <span>进行中：{activeSession.scenarioTitle}</span>
          <span>与{activeSession.isGroup && activeSession.participants ? activeSession.participants.map(p => p.name).join(' & ') : activeSession.characterName} →</span>
        </div>
      )}

      <div className="id-tab-bar">
        <button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>剧本大厅</button>
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>我的剧本</button>
      </div>

      {/* 单人/多人筛选 */}
      <div className="id-feedback-filter-bar">
        {(['all', 'single', 'multi'] as ScenarioFilter[]).map(f => (
          <button
            key={f}
            className={`id-feedback-filter-chip is-${f} ${filter === f ? 'is-active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      {tab === 'mine' && (
        <button className="id-scenario-create-btn" onClick={() => onNavigate({ type: 'scenario-editor' })}>
          + 创建新剧本
        </button>
      )}

      {loading ? (
        <div className="id-empty">加载中...</div>
      ) : filteredScenarios.length === 0 ? (
        <div className="id-empty">
          {scenarios.length === 0
            ? (tab === 'browse' ? '暂无已发布剧本' : '你还没有创建剧本')
            : '没有符合筛选条件的剧本'}
        </div>
      ) : (
        <div className="id-scenario-list">
          {filteredScenarios.map(s => (
            <div
              key={s.id}
              className={`id-scenario-card id-scenario-card-clickable ${isMultiScenario(s) ? 'is-multi' : 'is-single'}`}
              onClick={() => onNavigate({ type: 'scenario-detail', scenarioId: s.id, isMine: tab === 'mine' })}
            >
              <div className="id-scenario-card-header">
                <h3>{s.title}</h3>
                <div className="id-scenario-card-badges">
                  <span className={`id-scenario-badge ${isMultiScenario(s) ? 'multi' : 'single'}`}>
                    {isMultiScenario(s) ? '多人' : '单人'}
                  </span>
                  {s.status === 'draft' && <span className="id-scenario-badge draft">草稿</span>}
                  {s.status === 'published' && <span className="id-scenario-badge published">已发布</span>}
                </div>
              </div>
              <p className="id-scenario-desc">{s.description}</p>
              <div className="id-scenario-card-footer">
                <span className="id-scenario-plays">游玩{s.playCount}次</span>
                <span className="id-scenario-card-arrow">›</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
