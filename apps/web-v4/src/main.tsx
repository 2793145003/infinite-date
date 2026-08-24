import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installFetchAuth } from './lib/api';
import { initTheme } from './lib/themes';

// 全局 fetch 拦截：自动带 token + 401 处理（须在渲染前装）
installFetchAuth();
// 主题初始化：应用已存主题（默认水彩），避免闪烁
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
