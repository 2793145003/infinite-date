import { useState, type ReactNode } from 'react';
import { FishMode } from '../pages/FishMode';
import { getFishToggle, getHomeBg } from '../lib/themes';

export function PhoneShell({
  children,
  permissions,
  showStatusbar,
  onHome,
}: {
  children: ReactNode;
  permissions: number;
  showStatusbar: boolean;
  onHome: () => void;
}) {
  const [fishMode, setFishMode] = useState(false);
  const [homeBg] = useState(getHomeBg);
  const toggleVisible = getFishToggle();
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  // 工作 = AI助手（摸鱼），灵感 = 游戏
  const showFish = fishMode;

  return (
    <div className="id-phone-wrap">
      <div className="id-phone-device">
        {showStatusbar && (
          <div className="id-statusbar">
            <div className="id-statusbar-left">
              <span className="id-statusbar-time">{time}</span>
              <span className="id-statusbar-phase">{showFish ? 'AI助手' : '无限心动'}</span>
            </div>
            <div className="id-statusbar-right">
              {toggleVisible && (
                <button
                  className="id-mode-toggle"
                  onClick={() => setFishMode(v => !v)}
                  aria-label={showFish ? '切换到灵感模式' : '切换到工作模式'}
                  title={showFish ? '切换到灵感模式' : '切换到工作模式'}
                >
                  <span className={`id-mode-opt ${showFish ? 'is-active' : ''}`}>工作</span>
                  <span className={`id-mode-opt ${!showFish ? 'is-active' : ''}`}>灵感</span>
                </button>
              )}
              {!showFish && (
                <>
                  <span className="id-perm-pill">⚡{permissions}</span>
                  <span className="id-signal" aria-hidden="true"><i /><i /><i /><i /></span>
                  <span className="id-batt" aria-hidden="true">
                    <span className="id-batt-body"><span className="id-batt-fill" /></span>
                    <span className="id-batt-cap" />
                  </span>
                </>
              )}
            </div>
          </div>
        )}
        <div className={`id-screen${homeBg.type !== 'none' ? ' has-home-bg' : ''}`}>
          {showFish ? <FishMode /> : children}
        </div>
        {!showFish && <button className="id-homebtn" onClick={onHome} aria-label="返回桌面" />}
      </div>
    </div>
  );
}
