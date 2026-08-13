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
    },
  },
  resolve: {
    alias: {
      '@idate/shared': '../../../packages/shared/src/index.ts',
    },
  },
});
