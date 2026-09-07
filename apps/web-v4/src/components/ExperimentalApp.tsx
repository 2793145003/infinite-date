import React from 'react';

/** 实验功能列表页：互动小说，从设置-更多功能-实验功能进入 */
export const ExperimentalApp: React.FC<{
  onBack: () => void;
  onOpenNovels: () => void;
}> = ({ onBack, onOpenNovels }) => {
  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">🧪 实验功能</span>
      </div>
      <div className="id-app-scroll">
        <div className="id-card">
          <div className="id-card-title">正在实验的功能，随时可能调整</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.4rem' }}>
            <button
              className="id-btn sm"
              style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={onOpenNovels}
            >
              📖 互动小说
              <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: 'var(--text-mute)' }}>穿越位面，书写无限流故事 ›</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
