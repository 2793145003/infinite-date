import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // QQ 浏览器基于较旧的 Chromium，target 设低一些确保兼容
    target: 'es2019',
  },
  server: {
    host: '0.0.0.0',
    port: 8080,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
      // dsh Web UI —— 认证反代监听 127.0.0.1:3090，它再转发到 dsh:3080。
      // '/dsh/api'、'/dsh/plugins' 保留前缀（dsh 后端已按 /dsh/… 注册路由）；
      // 其余 '/dsh/*'（静态资源）剥前缀，走 dsh 的 dist 根。
      '/dsh/api': {
        target: 'http://127.0.0.1:3090',
        changeOrigin: true,
        ws: true,
      },
      '/dsh/plugins': {
        target: 'http://127.0.0.1:3090',
        changeOrigin: true,
        ws: true,
      },
      '/dsh': {
        target: 'http://127.0.0.1:3090',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/dsh/, ''),
      },
      // v4 前端（心动终端）—— 保留前缀；web-v4 已按 base '/v4/' 注册静态资源，
      // 且其 server.ts 会把 '/v4/api' 剥成 '/api'。
      '/v4': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@idate/shared': '../../../packages/shared/src/index.ts',
    },
  },
});
