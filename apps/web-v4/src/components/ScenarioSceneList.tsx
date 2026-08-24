import { useState, useEffect, useCallback } from 'react';
import { api, type ScenarioInfo } from '../lib/api';

type ScenarioFilter = 'all' | 'single' | 'multi';

const isMultiScenario = (s: ScenarioInfo) => (s.npcRoles?.length ?? 0) >= 2;

const FILTER_LABELS: Record<ScenarioFilter, string> = {
  all: '全部',
  single: '单人',
  multi: '多人',
};

export function ScenarioSceneList({
  onBack,
  onOpenDetail,
  onOpenScene,
  onOpenEditor,
}: {
  onBack: () => void;
  onOpenDetail: (scenarioId: string) => void;
  onOpenScene: (sessionId: string) => void;
  onOpenEditor: () => void;
}) {
  const [filter, setFilter] = useState<ScenarioFilter>('all');
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeScene, setActiveScene] = useState<{ active: boolean; sessionId?: string; title?: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [scenarioData, activeData] = await Promise.all([
        api.getScenarios({ mine: false }),
        api.getActiveSceneScenario(),
      ]);
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
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
        <button className="text-ink-soft" onClick={onBack}>←</button>
        <span className="font-semibold text-ink">场景剧本</span>
        <button
          className="ml-auto rounded-lg bg-rose px-3 py-1.5 text-sm text-ink-on"
          onClick={onOpenEditor}
        >＋ 创建</button>
      </div>

      {/* 进行中 */}
      {activeScene?.active && activeScene.sessionId && (
        <div className="mx-4 mt-3 cursor-pointer rounded-xl bg-bg-rose-soft/60 px-4 py-3 text-sm text-rose" onClick={() => onOpenScene(activeScene.sessionId!)}>
          <span>进行中：{activeScene.title ?? '场景剧本'}</span>
          <span className="float-right">点击继续 →</span>
        </div>
      )}

      {/* 筛选 */}
      <div className="flex gap-2 px-4 py-3">
        {(['all', 'single', 'multi'] as ScenarioFilter[]).map(f => (
          <button
            key={f}
            className={`rounded-full px-4 py-1.5 text-sm ${filter === f ? 'bg-rose text-ink-on' : 'frosted-glass text-ink-soft border border-border'}`}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABELS[f]}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-[81px]">
        {loading ? (
          <div className="py-8 text-center text-sm text-ink-soft">加载中...</div>
        ) : filteredScenarios.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-soft">
            {scenarios.length === 0 ? '暂无已发布剧本' : '没有符合筛选条件的剧本'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filteredScenarios.map(s => (
              <div
                key={s.id}
                className="cursor-pointer rounded-2xl border border-border frosted-glass p-4 transition hover:shadow-sm"
                onClick={() => onOpenDetail(s.id)}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-ink">{s.title}</h3>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${isMultiScenario(s) ? 'bg-bg-rose-soft/60 text-rose' : 'bg-bg-muted/60 text-ink-soft'}`}>
                    {isMultiScenario(s) ? '多人' : '单人'}
                  </span>
                </div>
                <p className="mt-1.5 text-sm text-ink-soft" style={{ lineHeight: 1.5 }}>{s.description}</p>
                <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
                  <span>游玩{s.playCount}次</span>
                  <span>›</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
