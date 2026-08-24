import React from 'react';
import { Home, MessageCircle, BookOpen, Users, Settings } from 'lucide-react';
import { ActiveTab } from '../types';

interface NavigationProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  unreadCount?: number;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  setActiveTab,
  unreadCount = 0,
}) => {
  const navItems = [
    { id: 'home' as ActiveTab, label: '首页', icon: Home },
    { id: 'chat' as ActiveTab, label: '聊天', icon: MessageCircle, badge: unreadCount },
    { id: 'diary' as ActiveTab, label: '日记', icon: BookOpen },
    { id: 'archive' as ActiveTab, label: '角色', icon: Users },
    { id: 'settings' as ActiveTab, label: '设置', icon: Settings },
  ];

  return (
    <nav
      id="bottom-dock-navigation"
      aria-label="主底部导航"
      className="absolute bottom-3 left-1/2 -translate-x-1/2 z-40 w-[90%] max-w-sm"
    >
      <div className="frosted-dock rounded-full px-2 py-1.5 flex items-center justify-around">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              id={`nav-btn-${item.id}`}
              onClick={() => setActiveTab(item.id)}
              className={`relative flex flex-col items-center justify-center py-1 px-2.5 rounded-full transition-all duration-150 ${
                isActive
                  ? 'text-ink font-semibold'
                  : 'text-ink hover:text-ink'
              }`}
            >
              {isActive && (
                <div className="absolute inset-0 bg-bg-muted rounded-full -z-10" />
              )}
              <div className="relative">
                <Icon className="w-4 h-4" />
                {Boolean(item.badge && item.badge > 0) && (
                  <span className="absolute -top-1 -right-2 bg-solid text-solid-contrast text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center font-bold">
                    {item.badge}
                  </span>
                )}
              </div>
              <span className="text-[10px] mt-0.5 tracking-tight">{item.label}</span>
              {isActive && (
                <span className="w-1 h-1 bg-solid rounded-full mt-0.5" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};
