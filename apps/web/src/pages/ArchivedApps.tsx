import type { View } from '../App';

/**
 * 已归档 / 回收站 —— 保存已被新功能替代、但历史数据仍需可读的旧 app。
 * 当前收纳：旧地图（只读）、旧剧本（只读）。新建/删除/进入的 API 已在后端下线（403），
 * 这里只是保留旧的查看入口，不让历史数据读不到。
 */
export function ArchivedApps({
  onBack,
  onNavigate,
  embedded,
}: {
  onBack: () => void;
  onNavigate: (view: View) => void;
  embedded?: boolean;
}) {
  return (
    <div className="id-app">
      {!embedded && (
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">已归档</span>
        </div>
      )}
      <div className="id-app-scroll">
        <div className="id-empty" style={{ padding: '1rem', flexDirection: 'row', justifyContent: 'center', gap: '0.5rem' }}>
          📦 这里存放已下线、但历史数据仍可查看的旧功能。
        </div>
        <div className="id-map-list">
          <button
            className="id-map-card unlocked"
            onClick={() => onNavigate({ type: 'map' })}
          >
            <div className="id-map-emoji">🗺️</div>
            <div className="id-map-info">
              <div className="id-map-name">
                旧地图
                <span className="id-map-tag">只读</span>
              </div>
              <div className="id-map-desc">
                已被新地图替代。此处仅可查看旧地点，不能再新建或删除。
              </div>
            </div>
            <div className="id-map-action">进入</div>
          </button>

          <button
            className="id-map-card unlocked"
            onClick={() => onNavigate({ type: 'scenarios' })}
          >
            <div className="id-map-emoji">🎭</div>
            <div className="id-map-info">
              <div className="id-map-name">
                旧剧本
                <span className="id-map-tag">只读</span>
              </div>
              <div className="id-map-desc">
                已被场景剧本替代。此处可查看已有剧本，不能新建或进入。
              </div>
            </div>
            <div className="id-map-action">进入</div>
          </button>
        </div>
      </div>
    </div>
  );
}
