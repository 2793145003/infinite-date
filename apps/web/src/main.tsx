import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AppV2 from './AppV2';
import './index.css';
import { initTheme, applyTheme, applyHomeBg } from './lib/themes';

// 新 UI（v3）走 /v3 子路径，旧 UI 留 /，新旧并存
const isV3 = window.location.pathname.startsWith('/v3');

// 清理 v3 早期版本误写入 localStorage 的专属主题/背景（旧 UI 不支持水彩/蝴蝶，读到会乱套）
if (!isV3) {
  if (localStorage.getItem('idate_theme') === 'watercolor') localStorage.removeItem('idate_theme');
  const bg = localStorage.getItem('idate_home_bg');
  if (bg && bg.includes('butterfly')) localStorage.removeItem('idate_home_bg');
}

initTheme();

// v3 默认皮肤：只改 DOM（不写 localStorage），避免污染旧 UI 共享的主题/背景偏好
if (isV3) {
  if (!localStorage.getItem('idate_theme')) applyTheme('watercolor');
  if (!localStorage.getItem('idate_home_bg')) applyHomeBg({ type: 'preset', value: 'butterfly' });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isV3 ? <AppV2 /> : <App />}
  </React.StrictMode>,
);
