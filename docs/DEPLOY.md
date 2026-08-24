# DEPLOY — 服务部署与重启手册

> 目的：服务挂了照着这里重启。只记"怎么起、怎么杀、怎么验证"，不解释业务。
>
> 最后更新：2026-08-20（web-v4 挂载 8080/v4 当天）

---

## 服务清单

| 服务 | 端口 | 监听 | 目录 | 启动命令 | 说明 |
|---|---|---|---|---|---|
| v2 后端 | 3000 | 0.0.0.0 | `apps/server` | `npm run start` | Fastify + SQLite，`tsx src/index.ts` 直跑 |
| 外层前端 | 8080 | 0.0.0.0 | `apps/web` | `pnpm dev` | Vite，**反代入口**：`/api`→3000、`/dsh`→3090、`/v4`→3001 |
| web-v4（心动终端） | 3001 | 0.0.0.0 | `apps/web-v4` | `npm run dev` | Express + Vite middleware，挂 8080 `/v4` |
| dsh 后端 | 3080 | 127.0.0.1 | `deepseek-harness/repo` | 见下 | DeepSeek Harness |
| dsh 认证反代 | 3090 | 127.0.0.1 | `deepseek-harness/proxy` | `node proxy.js` | Basic Auth + Cookie 会话 |

> dsh 完整启动见 skill `dsh-subpath-mount`。简记：后端 `cd /output/deepseek-harness/repo && DSH_HOME=/output/deepseek-harness/home DSH_TELEMETRY_DISABLED=1 node apps/cli/lib/bin.js web`，反代 `cd /output/deepseek-harness/proxy && node proxy.js`。

---

## 重启步骤

### 1. 杀进程（杀到底层！npm→sh→node 三层）

```bash
ss -tlnp | grep -E ':(3000|8080|3001)\b'   # 找 pid
# 关键：npm 启动的进程是 npm → sh -c → node 三层。
# 只 kill 顶层 npm 或只 kill node，都会留 sh 占着端口 → 起不来。
# 用 pkill 按命令匹配杀干净，再确认端口释放：
pkill -f 'tsx src/index.ts'; pkill -f 'vite --host 0.0.0.0 --port 8080'; pkill -f 'tsx server.ts'
sleep 1
ss -tlnp | grep -E ':(3000|8080|3001)\b' || echo "已释放"
```

### 2. 重启（background 必须显式 cd，workdir 参数会失效）

```bash
cd /output/infinite-date-v2/apps/server && npm run start    # 3000
cd /output/infinite-date-v2/apps/web    && pnpm dev         # 8080
cd /output/infinite-date-v2/apps/web-v4 && npm run dev      # 3001
```

### 3. 验证

```bash
ss -tlnp | grep -E ':(3000|8080|3001)\b'
curl -s http://127.0.0.1:8080/v4/api/health                    # {"status":"ok"}
curl -s http://127.0.0.1:8080/ | grep -o '<title>.*</title>'   # 无限心动
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/dsh/   # 401（认证正常）
```

---

## 关键陷阱（都是踩过的）

1. **`pnpm dev` 会触发依赖检查（verify-deps-before-run）**：workspace 里若有 npm 装的依赖，pnpm 会把它们转成 pnpm 结构（实体包移入 `node_modules/.ignored`）。web-v4 早期用 `npm install`，已被 pnpm 接管。**以后 monorepo 装依赖统一用 `pnpm`，别用 `npm install`**（否则又打架）。

2. **`pnpm-workspace.yaml` 的 `allowBuilds`**：`@google/genai`/`esbuild`/`protobufjs` 三个值必须是 `true`（早期是占位符 `set this to true or false`，导致 `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`）。别改回占位符。

3. **Hermes `terminal(background=true)` 的 `workdir` 参数不生效**：必须在命令里显式 `cd /path && ...`，否则 npm/pnpm 在错误目录找 `package.json`（报 ENOENT）。

4. **杀进程杀到底层**：只杀 node 会留 `sh -c` 占端口（历史"3000 占满"就是这原因）。

---

## web-v4 挂载到 8080/v4 的方案

（改这四个地方；原理见 skill `reverse-proxy-subpath-mounting`）

| 文件 | 改动 |
|---|---|
| `apps/web-v4/vite.config.ts` | `base: '/v4/'`（静态资源带前缀） |
| `apps/web-v4/server.ts` | 加 `/v4/api` → `/api` 剥前缀中间件 |
| `apps/web-v4/src/App.tsx`、`DatingNarrativeChatScreen.tsx` | `fetch('/api/…')` → `fetch('/v4/api/…')`（共 4 处） |
| `apps/web/vite.config.ts` | proxy 加 `'/v4'` → `http://127.0.0.1:3001`（**保留前缀**，`ws:true`） |

要点：静态资源保留前缀（web-v4 按 base 注册），API 由 server.ts 剥前缀，两者方向相反，别统一 strip。

---

## v2/v3 归档，主入口 `/` → `/v4`（2026-08-23）

功能齐备后，把 v2 UI（`App`）和 v3（`AppV2`）归档，主入口统一为 v4。做法：`apps/web/index.html` 的 `<head>` 加一段重定向——所有非反代路径（`/`、`/v3`、旧 UI 内部路由等）都转接 `/v4`：

```html
<script>
  (function () {
    var p = window.location.pathname;
    if (!p.startsWith('/v4') && !p.startsWith('/api') && !p.startsWith('/dsh')) {
      window.location.replace('/v4');
    }
  })();
</script>
```

- `/v4`、`/api`、`/dsh` 是反代路径，放行；其余一律转接 v4。
- v4 的 `base: '/v4/'` 不变，静态资源/API 前缀照旧。
- v2/v3 源码**保留原位未删**（`apps/web/src/App.tsx`、`AppV2.tsx`、`pages/*` 等，均在 git 历史），只是不再渲染。要恢复只需删掉这段 script。
