# DEPLOY — 服务部署与重启手册

> 目的：服务挂了照着这里重启。只记"怎么起、怎么杀、怎么验证"，不解释业务。
>
> 最后更新：2026-10-13（新增 QQ 桥常驻进程的起停与排查）

---

## 服务清单

| 服务 | 端口 | 监听 | 目录 | 启动命令 | 说明 |
|---|---|---|---|---|---|
| v2 后端 | 3000 | 0.0.0.0 | `apps/server` | `npm run start` | Fastify + SQLite，`tsx src/index.ts` 直跑 |
| 外层前端 | 8080 | 0.0.0.0 | `apps/web` | `pnpm dev` | Vite，**反代入口**：`/api`→3000、`/dsh`→3090、`/v4`→3001 |
| web-v4（心动终端） | 3001 | 0.0.0.0 | `apps/web-v4` | `npm run dev` | Express + Vite middleware，挂 8080 `/v4` |
| dsh 后端 | 3080 | 127.0.0.1 | `deepseek-harness/repo` | 见下 | DeepSeek Harness |
| dsh 认证反代 | 3090 | 127.0.0.1 | `deepseek-harness/proxy` | `node proxy.js` | Basic Auth + Cookie 会话 |
| QQ 桥 | 无 | — | `apps/server` | `npx tsx src/qq-bridge/main.ts` | 把男主短信推到玩家手机 QQ；**独立进程**，由 `start-all.sh` 托管 |

> dsh 完整启动见 skill `dsh-subpath-mount`。简记：后端 `cd /output/deepseek-harness/repo && DSH_HOME=/output/deepseek-harness/home DSH_TELEMETRY_DISABLED=1 node apps/cli/lib/bin.js web`，反代 `cd /output/deepseek-harness/proxy && node proxy.js`。

---

## 一键重启（restart.sh，推荐）

手动杀进程太容易漏（npm→sh→node 三层），现已内置 `restart.sh` 一键脚本，只重启**后端**（3000），不碰 8080/3001：

```bash
# 方式 A：手动执行
bash /output/infinite-date-v2/restart.sh

# 方式 B：API 触发（需管理员 token）
curl -X POST http://127.0.0.1:3000/api/admin/restart -H "Authorization: Bearer <admin token>"
```

脚本流程：`sleep 2`（等 HTTP 响应先返回）→ 杀监听 3000 的 node（父链级联退出）→ 等端口释放（最多 10s）→ **从项目根同步 `idate_env.sh` 到 `/tmp`** → `setsid nohup npm run start` 启动新后端。

> 环境变量真源约定：**项目根的 `idate_env.sh` 是唯一真源**，`/tmp/idate_env.sh` 只是运行时镜像（容器重启会被清空）。
> `restart.sh` 与 `start-all.sh` 每次启动都会把项目根同步到 `/tmp`，然后 source。
> 如果 `/tmp` 里存在项目根没有的变量，脚本会打印警告并**跳过覆盖**（避免丢掉只写在 `/tmp` 的临时配置）——
> 看到那条警告就把缺的变量补进项目根。

- 日志：重启日志 `/tmp/idate_restart.log`，后端输出 `/tmp/idate_backend.log`。
- 只重启后端，前端（8080/3001）不受影响，无需重启。
- 仍要等 **40~60s** 后端才就绪（见下方陷阱 5），别急。

---

## QQ 桥（常驻进程，不占端口）

把男主的短信推到玩家手机 QQ 的锁屏通知，玩家在 QQ 里回一句会落到同一条 thread 上。
**独立进程**：桥挂了不影响后端与网页（出站只读库、入站走 HTTP 接口），只重启后端也不影响桥。

```bash
# 启动：已纳入 start-all.sh（幂等，已在跑就识别为「已在运行」）
bash /output/infinite-date-v2/start-all.sh

# 看状态
cat /tmp/idate_qqbridge.pid              # 桥进程 pid
kill -0 $(cat /tmp/idate_qqbridge.pid)   # 判活：0=活着
tail -f /tmp/idate_qqbridge.log          # 日志

# 停（重启后端不会停它，要单独停）
kill $(cat /tmp/idate_qqbridge.pid)
```

| 项 | 值 |
|---|---|
| 日志 | `/tmp/idate_qqbridge.log` |
| pid 文件 | `/tmp/idate_qqbridge.pid` |
| 启动方式 | `setsid`（必须脱离终端；`nohup` 不够，会随调用方退出） |
| 环境变量 | 与后端同一套约定：真源是项目根 `idate_env.sh`，其中 `IDATE_QQ_SECRET_KEY` 是 AppSecret 加密密钥 |
| 节奏 | 出站每 20s 一轮；每 60s 扫一次新绑定并接网关（别人扫码后最多 60s 自动生效，无需手动起桥） |

**日志对照表**（排查先看这里）：

| 日志 | 含义 |
|---|---|
| `已连网关: <appId>（角色 …）` + `✅ 网关握手成功（READY…）` | 这个机器人连上了，能收能发 |
| `出站：扫到 N / 发出 N / 跳过 N / 失败 N` | 有消息在推。"扫到 >0 但发出 0" 说明都是发过的（幂等生效，正常） |
| `上一轮出站还在跑，跳过本轮` | 重入锁生效（一轮超 20s 的正常表现，**不是故障**） |
| `限流中断 N` | 触到 QQ 频控（单关系 20/qpm、bot 30/qpm），剩下留到下一轮 |
| `机器人不存在` / 状态被判 `invalid` | AppID/AppSecret 失效，让玩家在角色卡上重新扫码 |

**判活的坑**：不要用 `pgrep -f "qq-bridge/main.ts"` —— 它会误匹配调用方的 shell 命令，
明明没跑却报「已在运行」。一律用 pid 文件 + `kill -0`。

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

5. **启动慢，别误判卡死**：672MB 大库 + 十几 MB 的 WAL，重启后 tsx 从启动到端口监听要 **40~60 秒**。期间 `ss -tlnp` 看不到 3000/3001、preflight 进程状态在 D（不可中断 I/O，恢复 WAL）和 S（ep_poll 就绪）之间波动、日志停在「SQLite experimental warning」后无输出——这些都是正常现象，不是卡死。耐心等到 `curl -s http://127.0.0.1:3000/api/health` 返回 `{"status":"ok"}` 再验收。web-v4（3001）不用 sqlite，但首次 vite 扫描依赖同样慢，一并等。

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
