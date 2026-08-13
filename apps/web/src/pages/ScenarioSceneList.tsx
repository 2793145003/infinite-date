import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { ScenarioInfo } from '../lib/api';
import type { View } from '../App';

type ScenarioFilter = 'all' | 'single' | 'multi';

const isMultiScenario = (s: ScenarioInfo) => (s.npcRoles?.length ?? 0) >= 2;

const FILTER_LABELS: Record<ScenarioFilter, string> = {
  all: '全部',
  single: '单人',
  multi: '多人',
};

export function ScenarioSceneList({
  onBack,
  onNavigate,
}: {
  onBack: () => void;
  onNavigate: (view: View) => void;
}) {
  const [filter, setFilter] = useState<ScenarioFilter>('all');
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [loading, setLoading] = useState(true);

  // 进行中的场景剧本
  const [activeScene, setActiveScene] = useState<{ active: boolean; sessionId?: string; title?: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [scenarioData, activeData] = await Promise.all([
        api.getScenarios({ mine: false }),
        api.getActiveSceneScenario(),
      ]);
      // 只显示已发布的
      setScenarios(scenarioData.scenarios.filter(s => s.status === 'published'));
      setActiveScene(activeData);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

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
        <span className="id-appbar-title">场景剧本</span>
      </div>

      {/* 进行中 */}
      {activeScene?.active && activeScene.sessionId && (
        <div className="id-scenario-active-banner" onClick={() => onNavigate({ type: 'scenario-scene', scenarioSessionId: activeScene.sessionId! })}>
          <span>进行中：{activeScene.title ?? '场景剧本'}</span>
          <span>点击继续 →</span>
        </div>
      )}

      {/* 筛选 */}
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

      {loading ? (
        <div className="id-empty">加载中...</div>
      ) : filteredScenarios.length === 0 ? (
        <div className="id-empty">
          {scenarios.length === 0 ? '暂无已发布剧本' : '没有符合筛选条件的剧本'}
        </div>
      ) : (
        <div className="id-scenario-list">
          {filteredScenarios.map(s => (
            <div
              key={s.id}
              className={`id-scenario-card id-scenario-card-clickable ${isMultiScenario(s) ? 'is-multi' : 'is-single'}`}
              onClick={() => onNavigate({ type: 'scenario-scene-detail', scenarioId: s.id })}
            >
              <div className="id-scenario-card-header">
                <h3>{s.title}</h3>
                <div className="id-scenario-card-badges">
                  <span className={`id-scenario-badge ${isMultiScenario(s) ? 'multi' : 'single'}`}>
                    {isMultiScenario(s) ? '多人' : '单人'}
                  </span>
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
