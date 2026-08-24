import React, { useState, useEffect } from 'react';
import { Wifi } from 'lucide-react';

/**
 * 手机顶部状态栏：左侧时间，右侧 蜂窝信号 / WiFi / 电量。
 * 深蓝系，画在浅色水彩蝴蝶壁纸上。
 * 设置页开启「工作模式」开关后，右上角出现「工作｜灵感」双段式按钮（默认隐藏）。
 */
export const StatusBar: React.FC<{
  showWorkToggle?: boolean;
  workMode?: boolean;
  onSetWorkMode?: (mode: boolean) => void;
}> = ({ showWorkToggle = false, workMode = false, onSetWorkMode }) => {
  const [currentTime, setCurrentTime] = useState('00:00');

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setCurrentTime(
        `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      );
    };
    update();
    const t = setInterval(update, 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      id="phone-status-bar"
      className="relative z-50 flex items-center justify-between px-7 pt-3.5 pb-1 text-ink pointer-events-none shrink-0"
    >
      {/* 左侧：时间 */}
      <span className="text-[13px] font-semibold tracking-tight">{currentTime}</span>

      {/* 右侧：工作/灵感开关 + 蜂窝信号 / WiFi / 电量 */}
      <div className="flex items-center gap-2">
        {/* 工作｜灵感 双段式开关（设置页开启后显示） */}
        {showWorkToggle && (
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-bg-soft border border-ink/25 px-0.5 py-0.5">
            <button
              onClick={() => onSetWorkMode?.(true)}
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold leading-none transition-colors cursor-pointer ${
                workMode ? 'bg-cyan text-ink-on' : 'text-ink'
              }`}
            >
              工作
            </button>
            <button
              onClick={() => onSetWorkMode?.(false)}
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold leading-none transition-colors cursor-pointer ${
                !workMode ? 'bg-cyan text-ink-on' : 'text-ink'
              }`}
            >
              灵感
            </button>
          </div>
        )}

        {/* 蜂窝信号条 */}
        <div className="flex items-end gap-[1.5px] h-3 pb-0.5">
          <span className="w-[2px] h-[3px] bg-solid rounded-[0.5px] opacity-90" />
          <span className="w-[2px] h-[5px] bg-solid rounded-[0.5px] opacity-90" />
          <span className="w-[2px] h-[7px] bg-solid rounded-[0.5px] opacity-90" />
          <span className="w-[2px] h-[9px] bg-solid rounded-[0.5px] opacity-90" />
        </div>

        {/* WiFi */}
        <Wifi className="w-3.5 h-3.5 stroke-[2] text-ink" />

        {/* 电量百分比 */}
        <span className="text-[12.5px] font-semibold tracking-tight">100%</span>

        {/* 电池图标 */}
        <div className="flex items-center">
          <div className="w-[19px] h-[10px] rounded-[3px] border-[1.2px] border-ink p-[1px] flex items-center">
            <div className="w-full h-full bg-solid rounded-[1px]" />
          </div>
          <div className="w-[1.5px] h-[4px] bg-solid rounded-r-[1px]" />
        </div>
      </div>
    </div>
  );
};
