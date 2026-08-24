import { useState, type ReactNode } from 'react';
import { Home, MessageCircle, Map, Settings, Wifi } from 'lucide-react';
import { FishMode } from '../pages/FishMode';
import { hasHomeBgImage } from '../lib/themes';
import type { View } from '../AppV2';

const DOCK_ITEMS = [
  { id: 'desktop', label: '主页', icon: Home },
  { id: 'sms', label: '短信', icon: MessageCircle },
  { id: 'scenemap', label: '地图', icon: Map },
  { id: 'settings', label: '设置', icon: Settings },
] as const;

// 沉浸页（进行中的会话/对话）不显示 dock，避免打断沉浸与互斥冲突
const IMMERSIVE_VIEWS = new Set([
  'conversation', 'group-conversation', 'explore',
  'scene-conversation', 'scene-explore',
  'scenario-conversation', 'scenario-scene', 'scenario-dream',
  'sms-thread',
]);

function dockActive(viewType: string): string {
  switch (viewType) {
    case 'sms':
    case 'sms-thread':
      return 'sms';
    case 'scenemap':
    case 'scene-location':
      return 'scenemap';
    case 'settings':
      return 'settings';
    default:
      return 'desktop';
  }
}

export function PhoneShellV2({
  children,
  permissions,
  showStatusbar,
  currentView,
  onNavigate,
}: {
  children: ReactNode;
  permissions: number;
  showStatusbar: boolean;
  currentView: string;
  onNavigate: (view: View) => void;
}) {
  const hasHomeBg = hasHomeBgImage();
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  // 未登录（登录页）与沉浸页都不显示 dock
  const showDock = showStatusbar && !IMMERSIVE_VIEWS.has(currentView);
  const active = dockActive(currentView);

  return (
    <div className="id-phone-wrap">
      <div className={`id-phone-device${hasHomeBg ? ' has-home-bg' : ''}`}>
        {/* 顶部白色到透明渐变（照抄心动终端 PhoneFrame 顶部高光） */}
        <div className="id-statusbar-fade" aria-hidden="true" />

        {/* 状态栏（照抄心动终端：左时间，右信号条 + Wifi + 100% + 电池，深灰 #2d3139） */}
        {showStatusbar && (
          <div className="id-statusbar">
            <span className="id-statusbar-time">{time}</span>
            <div className="id-statusbar-right">
              <span className="id-signal" aria-hidden="true"><i /><i /><i /><i /></span>
              <Wifi className="id-wifi" size={14} strokeWidth={2} />
              <span className="id-batt-pct">100%</span>
              <span className="id-batt" aria-hidden="true">
                <span className="id-batt-body"><span className="id-batt-fill" /></span>
                <span className="id-batt-cap" />
              </span>
            </div>
          </div>
        )}

        <div className={`id-screen${hasHomeBg ? ' has-home-bg' : ''}`}>
          {children}
        </div>

        {showDock && (
          <div className="id-dock">
            {DOCK_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = active === item.id;
              return (
                <button
                  key={item.id}
                  className={`id-dock-item${isActive ? ' is-active' : ''}`}
                  onClick={() => onNavigate({ type: item.id } as View)}
                  aria-label={item.label}
                >
                  <Icon size={22} strokeWidth={isActive ? 2.4 : 1.8} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
