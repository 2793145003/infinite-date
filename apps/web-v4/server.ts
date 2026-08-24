import express from 'express';
import http from 'node:http';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3001;

  app.use(express.json({ limit: '10mb' }));

  // 兼容 '/v4/api' 前缀：经 8080/v4 反代或前端直接 fetch '/v4/api/...' 时剥成 '/api'
  app.use((req, _res, next) => {
    if (req.url.startsWith('/v4/api')) {
      req.url = req.url.replace('/v4/api', '/api');
    }
    next();
  });

  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // 代理中间件：把 /api/* 请求转发到 v2 真实后端（3000 端口）
  // 注意：express.json() 已消费 body，必须从 req.body 重新序列化转发，
  // 否则 req.pipe 转发空 body + 旧 Content-Length 会让后端一直等 body 而挂起
  app.use((req, res, next) => {
    if (!req.url.startsWith('/api/')) return next();

    // multipart 上传（图片等）：express.json 不消费它，body 仍是原始流。
    // 必须直接 pipe 给后端、保留 content-type（含 boundary）——若走下面的 JSON 序列化，
    // 文件二进制会被替换成 '{}'，后端 @fastify/multipart 报 "Unexpected end of multipart data"。
    const contentType = req.headers['content-type'] || '';
    if (contentType.startsWith('multipart/form-data')) {
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: 3000,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: '127.0.0.1:3000' },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', (err) => {
        console.error('代理到 v2 后端失败:', err.message);
        if (!res.headersSent) res.status(502).json({ error: '后端服务不可用' });
      });
      req.pipe(proxyReq);
      return;
    }

    // 判断原始请求是否真的带了 body。不能只看 req.body —— express.json()
    // 会把无 body 请求的 req.body 初始化为 {}，导致误判 hasBody=true，
    // 转发时补了 content-length 却没补 Content-Type，后端 fastify 报 415。
    const rawContentLength = req.headers['content-length'];
    const rawTransferEncoding = req.headers['transfer-encoding'];
    const hasRawBody =
      rawTransferEncoding !== undefined ||
      (rawContentLength !== undefined && rawContentLength !== '' && rawContentLength !== '0');

    const bodyBuf = hasRawBody ? Buffer.from(JSON.stringify(req.body ?? {})) : null;
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: '127.0.0.1:3000',
    };
    if (bodyBuf) {
      headers['content-length'] = String(bodyBuf.length);
      delete headers['content-encoding'];
    } else {
      // 无 body：清掉可能残留的 content-length/transfer-encoding，避免后端误判有 body
      delete headers['content-length'];
      delete headers['transfer-encoding'];
    }

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', (err) => {
      console.error('代理到 v2 后端失败:', err.message);
      if (!res.headersSent) res.status(502).json({ error: '后端服务不可用' });
    });
    if (bodyBuf) {
      proxyReq.write(bodyBuf);
    }
    proxyReq.end();
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`无限心动 v4 前端运行在 http://0.0.0.0:${PORT}`);
  });
}

startServer();
