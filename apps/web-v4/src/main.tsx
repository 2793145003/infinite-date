import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installFetchAuth, installImageAuthRecovery } from './lib/api';
import { initTheme } from './lib/themes';

// 全局 fetch 拦截：自动带 token + 401 处理（须在渲染前装）
installFetchAuth();
// 图片 401 自愈：img 标签不走 fetch 拦截器，单独捕获 error 触发探测重登（须在渲染前装）
installImageAuthRecovery();
// 主题初始化：应用已存主题（默认水彩），避免闪烁
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
