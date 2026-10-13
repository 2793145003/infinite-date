import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 诊断用：把每个经前端代理转发的请求打一行日志到 stdout（→ /tmp/idate_web.log）
 * 目的：出现「一次操作变成 N 次请求」时，能判断是浏览器真的发了 N 次，还是上游网关重放的。
 * 记录：utc 时间 / 方法 / url / user-agent / x-forwarded-for / referer
 */
function logProxy(tag: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (proxy: any) => {
    proxy.on('proxyReq', (_proxyReq: unknown, req: { method?: string; url?: string; headers: Record<string, unknown> }) => {
      const h = req.headers || {};
      const s = (v: unknown, n = 60) => String(v ?? '').slice(0, n);
      // eslint-disable-next-line no-console
      console.log(`[proxy:${tag}] ${new Date().toISOString()} ${req.method} ${req.url} ua="${s(h['user-agent'])}" xff="${s(h['x-forwarded-for'], 40)}" ref="${s(h['referer'], 80)}"`);
    });
  };
}

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
        configure: logProxy('8080->3000'),
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
        configure: logProxy('8080->3001(v4)'),
      },
    },
  },
  resolve: {
    alias: {
      '@idate/shared': '../../../packages/shared/src/index.ts',
    },
  },
});
