# v2 代码与文档审查报告（第五轮）

> 审查时间：2026-08-14
> 审查范围：全项目源码 + 文档 + 配置 + 测试 + 仓库卫生
> 方法：5 路并行子代理逐文件审查（核心逻辑 / 路由安全 / 前端 / 文档 / 工具与卫生）+ 主代理逐条复验关键发现，不依赖旧报告结论

---

## 摘要

本轮为开源发布前的第五轮全面审查。使用 5 个并行子代理分头深读代码与文档，再由主代理对**每条关键/严重发现逐一复验**（读源码确认而非仅信子代理转述）。结果：

- **3 个 🔴 严重问题**，其中 1 个（记忆折叠死循环）为主代理亲自读源码确认的**必然发生**的 bug，会在每次约会结束时重复写库 + 重复调 LLM + 永远不生成整体摘要。
- **8 个 🟠 中等问题**（跨安全、并发、前端、工程），
- **一批 🟢 轻微/文档问题**。

上一轮（V4）遗留的文档漂移大部分已由 `9800e26` 修正；仍遗留的有 🟡-11（LLM key 值待确认）与 P3-NEW-3（权限消耗全 0）。本轮不再重复已被 V4 修复的问题，聚焦**新发现**与**未解决遗留**。

---

## 🔴 严重问题

### 🔴-1：约会结束时的记忆折叠死循环 + 永远不生成整体摘要（核心逻辑，已复验）

- **文件**：`lib/memory.ts` — 写 `foldMessages` **118–124**；读 `_foldChronicleImpl` **322–324** 与 **358–362**
- **触发**：`conversation.ts:548`（约会结束调 `foldChronicle`）

**根因（已亲自读源码确认）**：
- `foldMessages`（memory.ts:44）在 **118–124** 插入 `chronicles` 时**列名单里没有 `summary_type`** → 该列落库为 `NULL`（schema 无默认值）。
- 而 `_foldChronicleImpl` 的进度查询 **322–324** 过滤 `summary_type = 'segment'`；`for(;;)` 循环每轮 `lastFolded` 恒为 `undefined` → `foldedUpTo` 恒为 `0` → 每次都重选同一批最前 `FOLD_INTERVAL` 条消息（**330–334** `rowid > 0`）→ **每轮重复折叠同一批消息**：

  实际后果：循环每次迭代都写入一条**重复的 chronicle**、**重复调用 LLM**、重复入库 embedding 与 player facts。每一次约会结束都会在库里堆出一串一模一样（或随时间漂移）的重复记忆碎片，长期记忆与语义检索被污染，且产生无谓的 LLM 开销。`messages.length < 2` 才会跳出（只有整场 <2 条消息的约会才幸免）。

- **358–362**：聚合片段同样过滤 `summary_type = 'segment'` → `segments` 恒为空 → **364** `return` 提前返回，**整体摘要（session overview）永远不会生成**。也就是说第三层记忆（整场约会总览，写入 `'session'` 的那条）实际上从未产出。

**修复**：二选一
1. 让 `foldMessages` 在写入片段时带上 `summary_type = 'segment'`（用与 429 行相同的写法补上该列）；
2. 或让 `_foldChronicleImpl` 的进度/聚合查询去掉 `summary_type = 'segment'` 过滤，改用 `msg_end` 进度。

> 注意 `maybeFoldIncremental`（预约进行中滚动折叠）用的是 rowid 进度、与 `foldMessages` 各自独立，本轮未发现该路径同类问题；需确认它与 `foldChronicle` 用同一 `foldMessages` 时是否会互相污染 `msg_end` 进度。

---

### 🔴-2：任意登录玩家可改写**全局共享** LLM 配置（数据泄露 + 全场 DoS）

- **文件**：`routes/settings.ts:29-51`（PATCH `/settings`）；`llm/adapter.ts:44-50`（读取优先级）
- **前端**：`pages/SettingsApp.tsx`（对所有登录玩家可见的可编辑表单）

`PATCH /settings` 只有 `requireAuth`，却把 `baseUrl` / `apiKey` / `model` 写进**全局共享**的 `app_settings.llm_config` 行；`adapter.ts:44-50` 确认该值**优先级高于环境变量**且作用于**服务器全部** LLM 调用。

**影响**（多人联机、任意邀请码可注册的部署形态下）：
- 攻击者把 `baseUrl` 指向自己的服务器 → 每个玩家发给 LLM 的 prompt、私密角色卡、对话内容，连同共享 `apiKey` 一起被转发采集；
- 可把 `model`/`baseUrl` 指向坏端点 → **全服 AI 瘫痪/拒绝服务**；
- 可注入诱导/改写系统提示，污染每个玩家的角色。

**修复**：
- 变更共享配置需 `requireAdmin`；或把共享凭据移除、改为仅服务端环境变量；
- 若确实要支持「每人自己的 LLM」，则按 `player_id` 隔离存配置，且只作用于该玩家自己的调用。

> 说明：个人自托管单用户场景下风险低；但项目正走向开源多人联机，故定为 🔴。已复验：SettingsApp 是通用设置页，`adapter` 全局读取，无 per-player 作用域。

---

### 🔴-3：`@idate/shared` 未声明为依赖，仅靠 tsconfig `paths` 解析

- **文件**：`apps/server/package.json`、`apps/web/package.json`、`packages/shared/package.json`
- **证据**：server/web 的 dependencies **都不含** `@idate/shared`，而 server 有 ~17 个文件 `import` 它；`pnpm-lock.yaml` 无任何 `@idate`/`workspace:` 条目，无从安装。目前只靠根 `tsconfig.base.json` 的 `paths` 映射在**纯 TS/tsx 运行环境**下解析。

**影响**：
- 当前 `pnpm dev`（tsx）与 `tsc --noEmit` 能用（paths 兜底），但**任何需要真正打包/独立安装 server 的场景（`tsup`/`esbuild`/发布 npm/生产部署脚本）都会因找不到模块而失败**；
- monorepo 依赖本应声明为 `workspace:*`，否则 `pnpm install --prod`、CI 缓存、独立构建全部踩坑。

**修复**：在 server 与 web 的 `dependencies` 中加入 `"@idate/shared": "workspace:*"`（shared 的 exports 已指向 `./src/index.ts`，可源码直供）。

---

## 🟠 中等问题

### M-1：玩家消息在事务外提前提交，冲突回滚时泄漏孤儿消息（并发）
- `lib/scene-wiring.ts` — 早插入 **651–673**（事务外）vs 乐观锁 **685–698**
- 玩家消息在 `db.exec('BEGIN')` 之前已 COMMIT；若乐观锁失败（`changes===0` → `ROLLBACK` + `SCENE_ROUND_CONFLICT`），这条带 `round_no = session.round_no+1` 的消息已落库，可能与并发的另一请求已占用的轮号重复 → 泄漏重复/孤儿消息（及其 embedding）。
- **修复**：把玩家消息插入移进事务内，或在冲突路径显式删除。

### M-2：整体摘要刷新与片段折叠竞态 → 内存丢失
- `lib/turn-memory.ts` — fire-and-forget 折叠 **466–469** vs M-boundary 总览+删除 **471–484 / 213–227**
- `foldTurnSegment` 的 promise 在 `sync:false` 调用下不被 await（调用方即用 `sync:false`）；`atMBoundary` 分支先读库（可能还没写入刚触发的片段），随后 `doRefreshOverview` **无条件删除全部 `turn_segment` 行 + embedding**（**213–227**），新刚产生的片段可能被删除而从未折叠进总览。
- **修复**：在总览刷新/删除步之前无条件 `await Promise.all(foldPromises)`。

### M-3：私有角色数据/图片按裸 ID 可被其他用户读取（IDOR，纵深防御缺口）
- `lib/character.ts:19-41` `loadCharacterData`（35 行 `FROM character_player_data WHERE id = ?` 无 `player_id` 过滤）、`:46-58` `getCharacterName`、`:68+` `getCharacterAvatar`
- `routes/image.ts:19-69`（GET `/uploads/:filename` 只按裸 `id` 鉴权后即输出，无属主校验；文件名带 `{playerId}_` 前缀但 UUID 可被部分推断）
- 现状：路由层多处已做属主校验，私有角色 id 是 UUID 难猜，实际利用门槛高；但**共享 helper 无属主过滤**，一旦某条新路由漏做前置校验即泄露。属纵深防御缺口。
- **修复**：在 `loadCharacterData`/`getCharacterName`/`getCharacterAvatar` 的私有查找加 `player_id` 条件（需跨用户读时显式 opt-in）；`image.ts` 校验 `id LIKE playerId||'\_%'` 或加 owner 列。

### M-4：完全无速率限制（LLM 资源耗尽 / 邀请码爆破 / DoS）
- `index.ts:50-86` 未注册任何 rate-limit 插件；`auth/login` 无节流（邀请码仅 8 位 hex），所有 LLM 生成端点（`/sessions/:id/send`、`/sms/threads/:id/send`、`/scene/*/advance`、`/creation/*/chat`、`/scene/explore/*/step`、`/fish/chat`）可被刷爆 GPU。
- **修复**：注册 `@fastify/rate-limit`，对 auth 与 LLM 端点严格限流。

### M-5：`request()` 覆盖调用方 signal，长请求无法取消
- `web/src/lib/api.ts:47`：`request()` 总是用 `AbortSignal.timeout(30_000)` 覆写 `opts.signal`，非流式端点全部不可取消。`LiveConflictModal` 的「结束并重做」路径 `await api.fetchRaw` 在 `catch {}` 内静默吞错，redo 超时/失败时用户零反馈。`requestStream` 却正确尊重外部 signal —— 契约不一致。
- **修复**：`request()` 在调用方传入 `signal` 时与之合并（先到先取消），并让 redo 失败给出提示。

### M-6：`scene.ts` 先校验存在性再过滤字符集，数组可能变空后非空断言
- `routes/scene.ts:326-333`：`chars` 在**存在性校验之后**才过滤 `^[a-zA-Z0-9_-]+$`，被过滤后可能为空，随后 **337** `chars!` 非空断言 → 潜在 500。
- **修复**：先过滤再校验，并在空集时显式拒绝。

### M-7：`setInterval` 清日志时对 `player_id` 过滤 + `embedding` 生态缺口（文档/运维）
- `index.ts:118-124` 每 6h `DELETE FROM llm_call_log`；这本身合理，但 `adapter.ts:213` **每次 LLM 调用都全表 DELETE 一遍**（重复 O(n) 扫描 24h 表），高并发下浪费。且 embedding 依赖的 `embedding_server.py`（8001）在 README/环境变量表里**完全没记录**——后端硬依赖它却无启动说明。
- **修复**：把 LLM 调用内的 DELETE 改为周期性清理或批量；在 README 补 embedding 服务的安装/启动/依赖（`bge-base-zh-v1.5` 768 维）说明与 `EMBEDDING_URL`/`EMBEDDING_MODEL`/`VLLM_MAX_MODEL_LEN` 环境变量。

### M-8：`hasPlayerInput` 兜底解引用未保护的 `maleNames[0]`
- `lib/run-scene-turn.ts:1150-1167`：当 `hasPlayerInput` 为真、无男主开口、且 `maleNames` 为空（全员路人）时，`maleNames[0]` 为 `undefined`，`runActor(input, undefined, …)` 因 `actor.character_name` 出错；兄弟分支（1171）正确守卫 `maleNames.length > 0`。
- **修复**：兜底前先判断 `maleNames.length === 0`。

---

## 🟢 轻微问题

- **G-1** `schedule.ts:864-869` `overrideSceneScheduleToLocation` 用 `id = ${playerId}:${characterId}:llm:${now}`，同毫秒两次移动会 `INSERT OR REPLACE` 互相覆盖，且从不清理旧的 `is_llm_edited=1` 行。建议 UUID/counter + 删除重叠行。
- **G-2** `schedule.ts` 时间处理不一致（243/456 用 `new Date().getHours()`，138-147/126 用显式 `+8*3600*1000`）；若 config 的 `TZ` 未生效，昼夜/日key 边界漂移。建议统一为同一显式偏移计算。
- **G-3** `schedule.ts:449-588` `getBaseSchedule` 读已退役的 `locations/location_homes/location_npc_access`，而当前调用方走 `getSceneSchedule`（`scene_schedule_entries`）。若不可达应删除，避免返回与统一数据源不一致的行程。
- **G-4** `embedding.ts:48-49` `embedBatch([])` 返回 `[]` 而非 `null`，与 `embed()` 的失败哨兵不对称，未来调用方是坑。
- **G-5** 后端 `build: tsc` 是空操作（`tsconfig` `noEmit:true`，且 CODE_MAP 明言「tsx 直跑无编译」——build 脚本与之矛盾）；根 `test` 脚本 `pnpm -r run test` 会在 web/shared（无 test 脚本）上报错中断（应加 `--if-present` 或 `--filter @idate/server`）。根 `typecheck`（`pnpm -r run typecheck`，三包都有该脚本）是连贯的。
- **G-5b** `packages/shared` 的 `build: tsc` 输出 `dist/` 但 `main`/`types`/`exports` 都指向 `./src/*`，消费方也从 `src/` 引入——`dist/` 是无效产出；且 `apps/server/package-lock.json`（421 行 npm lockfile）+ 内部 `node_modules` 是混入 pnpm 工作区的残留 npm `install` 产物，应删除并统一由 pnpm 接管。
- **G-6** `lib/auth.ts:39` `issueToken` 会删除玩家所有旧 session（同一账号仅能单设备在线），UX 限制（如愿则忽略）。
- **G-7** image route 同时支持 `?token=` query（`image.ts:22-36`）→ token 进访问日志/浏览器历史/Referer；adapter 已有 httpOnly cookie + Bearer，建议下掉 query 通道。
- **G-8** `admin.ts:68` 角色编辑日志 `editor_id` 取客户端 `x-player-id` 头，可伪造审计身份；应用 `requireAdmin` 返回的 `playerId`。
- **G-9** 前端 presence 处理：`usePresence.ts:85` `clearPresence()` 在每次 ctx 变化时触发（非仅卸载），会在合法重渲染时拆除 presence；`Conversation.tsx:266` 把群聊按单人 chat 心跳，回调虽早退但 15s 心跳仍对群会话 /presence 空转；`useChatMessages.ts:247` 发送失败恢复文本但静默丢弃 pending 图片/引用（`pendingImage` 在 202 行已置空未恢复，SmsApp.tsx:309-311 有同款缺口）；`ImageUploadButton.tsx:68` 上传失败/卸载时 `URL.createObjectURL` 不 revoke；`AvatarCropModal.tsx:96` 拖拽 window 监听在模态中途卸载时泄漏；`api.ts:125` `requestStream` 外部 abort 监听从不移除。
- **G-10** 前端一致性与健壮性：`SmsApp.tsx` 8+ 处阻塞式 `alert()`（270/312/339/374/415/443/470/512/534/542）；Desktop 挂载时 4 个未守卫并发 fetch（无 abort/race 守卫）；合成 `Date.now()` 消息 id 冲突（`player-${Date.now()}`、`npc-${Date.now()}`，同毫秒并发会撞）；`request`（api.ts）对 409 只有一条路径设 `.code`，`requestStream` 的流错误不带 `status/code`，调用方无法统一识别 LIVE_CONFLICT；`LiveConflictModal.tsx:90-94` 续群聊以空 `participants`/`locationId` 导航，重入群约会头部名丢失；`SceneConversation.tsx:172-175` 直接 `mainCharIds.add()` 就地改 Set 后再拷贝，缓存+网络两路 `applyData` 会携带陈旧条目；`SceneConversation.tsx:434` 用 `key={locationName}` 强制重挂载来触发 CSS 过渡（hack）。
- **G-10b** 前端轻微：App.tsx 把 `view` 持久化到 sessionStorage（87-89），刷新可能恢复指向已结束 session 的深路由；`PhoneShell.tsx:18-19` 状态栏时钟是静态 `new Date()` 不跳动；`CharacterEditModal.tsx:82` `setTimeout` 未在卸载时清除；`ScenarioEditor.tsx:64` `window.location.hash=''` 无意义；`requestStream` 的 `onEvent` 回调异常被当坏帧吞掉（api.ts:165-169）；`CharacterEditModal.tsx:196-237`/`SmsApp.tsx:635-669` 用数组下标作受控列表 key，增删时焦点/光标跳错；死代码/重复：`LiveConflictModal.tsx:20` 未用 `ready` prop、SmsApp 多处近似重复的「逐条 reveal + sleep」循环（可用 `useChatMessages` 合并）、`imageUrl` 把认证 token 放 URL query（过渡方案，注意泄漏）。
- **G-11** 根 `spike_group_chat.py`、`apps/server/embedding_server.py` 留在仓库且无文档（Python 依赖 `sentence_transformers/numpy/requests` 未声明、`embedding_server.py:22` 硬编码 `/output/huggingface/hub/...` 模型路径）——应移入带 `requirements.txt` 的 tools 目录或归档 spike。
- **G-12** `scripts/` 约 50 个 A/B/迁移脚本，含**硬编码绝对路径** `/output/infinite-date-v2/...`，其中 `ctl/full/h2h2/test-scene-rollback/migrate-*.ts` 会写生产库/发真实 LLM 调用，且不都被 `.gitignore` 覆盖（`ab-*/ps-*/repro-*/fn-*` 被忽略但 `migrate-*`、`ctl` 等漏网），会随源码发布——与 V4「git 历史已完整保留」的说法不符。
- **G-13** `/output/infinite-date-v2/.agent-admin-credentials` 明文存有**有效 admin session token**（虽已 ignore，但属残留的高危凭据文件，发布/交接前应删除）。
- **G-14** 测试较弱：`scene-engine.test.ts:95` `assert.ok(true)` 恒真（且注释承认两种矛盾结果都接受）；`scene-rollback.test.ts:129-161` 断言字面量对自身、`:187-211` 遗留「TDD 红灯」脚手架、且 `determineRetryTarget`/`simulateDelete`/`buildOpeningNarration`/`buildFallbackIntent` 都被测试本地重实现而非导入真实函数（逻辑漂移时测试仍过）；`apps/server/node_modules/.vite/vitest/...` 有陈旧 vitest 缓存记录 4 个测试曾 failed（项目已迁 node:test，应清理）。`clean-stray.test.ts` 与 `scene-engine.test.ts` 的 validateBeats/renderPrompt/loadGreetingSection 部分是有效断言。另：`scene.ts` 与 `scene-named.ts` 双场景引擎并存是**有意技术债**（`scene.director.txt` 已标「旧导演保留回退」），建议给旧路径定个日落时间。
- **G-15** DB 散落多处：根 `data/`（app.db / idate.db / idate.sqlite / infinite-date.sqlite 空文件）+ `apps/server/data/`（infinite-date.sqlite + `.bak.*`/WAL/SHM + idate.db/game.db/app.db + ~30 张上传图）+ `docs/image_blobs_backup_*.sqlite`（63MB）+ `db-backups/`。真库是 `config.dbPath` = `data/infinite-date.sqlite`，其余为冗余/遗留，建议合并到单一数据目录并清理。迁移脚本有 `.ts`/`.mjs` 重复实现（`.mjs` 用未声明的 `better-sqlite3`，为陈旧副本应删）。
- **G-15b** 仓库卫生杂项：根目录无 README（仅 CODE_MAP 充当索引）；`docs/archive/reviews/*` 用 ad-hoc 命名（REVIEW/REVIEW_DRAFT/REVIEW_FOLLOWUP/REVIEW_FINAL/REVIEW_V3/V4）且 V4 末尾引用的根级 `REVIEW_V4.md` 已不在根，无单一规范文档；`config.ts` 的 `noUncheckedIndexedAccess` 已开但 `ctl/full/h2h2` 大量用 `as any` 绕开；`full.ts`/`ctl.ts`/`h2h2.ts` 回放脚本依赖 `llm_call_log` 24h TTL 数据，超过 24h 就静默失效（再次印证是一次性开发工具）。
- **G-16** `session-mutex.ts:48-70` `getActiveLiveSlot` 单个存活槽由硬编码优先级决定，多个并存时静默择一（异常老数据），建议注释或去重不变量。

---

## 🟡 文档漂移 / 代码-文档不一致

- **D-1** 三个 prompt 模板在文档中列为存活但已从磁盘删除且无代码引用：`scene.director.txt`（CODE_MAP L293 / PROMPTS L252,L507）、`scenario.system.txt`（CODE_MAP L299 / PROMPTS L215–234 整个「剧本系统」小节描述已删除系统）、`scenario-group.system.txt`（CODE_MAP L304）。PROMPTS.md 应整体更新（已复验磁盘与代码均无引用）。
- **D-2** `MEDIA_BACKGROUND_DESIGN.md` L48/70/90 指向不存在的 `admin/SceneActivityPanel.tsx`，实际是 `admin/LocationPanel.tsx`。
- **D-3** README 环境变量表与 config.ts 不一致：CORS 默认写 `localhost:8080,5173`，实际 `http://localhost:8080,http://localhost:5173`；未列 `COOKIE_SECRET`、`EMBEDDING_URL`/`EMBEDDING_MODEL`、`VLLM_MAX_MODEL_LEN`；`LLM_API_KEY` 默认显示为「—」但 config 有 `sk-placeholder`。README「pnpm 9+」与 pinned `pnpm@11.7.0`（DESIGN 也写 pnpm>=11）不一致。
- **D-4** CODE_MAP 漏列 `lib/repeat-detect.ts`（被 run-scene-turn 的 `fixRepeatEcho`/`extractLastPlayerLine` 引用）、`pages/ScenarioSceneDetail.tsx`（App.tsx 在用的真实页面），且 admin 路由表明显不完整：漏 `/admin/invite-codes/:code/revoke`、`DELETE /admin/invite-codes/:code`、`/admin/grant-permission`、`/admin/permissions/:playerId`、整个 `/admin/locations*` 族、`/admin/scene-locations/:id/background`+`/:id/activities`+`generate-activities`、`/admin/characters/:id`（edit/overrides/regenerate-milestones）。另 nit：`scene.namer.v2.txt`/`scene.namer.v1.bak.txt` 存在但未文档化。
- **D-7** `OPEN_QUESTIONS.md` 行动性很强（5 项均带 file+commit+status），但 nit：#4 引 `conversation.ts line 562-584`（行号会漂移）、#2 标题仍写「query构造」实为已解决（2026-08-10）的变更记录，建议把已解决部分归档。文档重叠健康（scene_schedule_entries 在 DESIGN/DATA_MODEL/CODE_MAP 三处一致，非矛盾）。
- **D-5** DESIGN §4.3 仍把 `scenario.ts` 列为活跃子系统，未注明其已被 403-stub 归档；README 的「剧本系统」表述也含糊。
- **D-6** 无任何文档覆盖 embedding 服务（8001）的运行/配置——后端硬依赖。

> 上轮遗留：🟡-11（LLM key 值，V4 未改值，仅加注释）、P3-NEW-3（权限消耗全 0）仍开放。

---

## ✅ 已复验为良好 / 无问题的部分

- **SQL 注入**：所有用户输入均走 `?` 参数绑定；动态拼接的列名/标识符都有白名单（`SCENARIO_FIELDS`、`ALLOWED_PATCH_FIELDS`、硬编码数组）。本轮未发现注入。
- **管理端授权**：`admin.ts` 全线 `requireAdmin`；`PATCH /player` 无法设置 `is_admin`；无提权路径。
- **文件上传**：10MB 双次校验 + 魔数白名单嗅探 + 用嗅探到的真实扩展名（不信客户端 mimetype）+ blob 存库按库内 mimetype 用 basename 输出（无路径穿越）。
- **COOKIE_SECRET** 已补进 `.env.example`（V4 修复，本轮复验仍在）。
- **私有地点 `is_public` 过滤**已修复（`ce79c58`）。
- **伟大面**：事务/migration 幂等、prompt 外部化、SSE 超时 + AbortController、前端多处无 setState-in-render / 无无限循环、request-id 防重复提交（MomentsApp）、CAREFUL 状态更新（SceneConversation）。

---

## 建议的优先级修复顺序

1. 🔴-1 记忆折叠死循环（`foldMessages` 补 `summary_type='segment'`）——数据正确性，最快见效、风险最低。
2. 🔴-2 `/settings` 全局 LLM 配置鉴权（加 `requireAdmin` 或 per-player 隔离）。
3. 🔴-3 声明 `@idate/shared` 为 `workspace:*` 依赖。
4. 🟠-1/2 并发竞态（scene-wiring 早插入、turn-memory 折叠-删除竞态）。
5. 🟠-3/4 IDOR 纵深防御 + 速率限制。
6. 文档漂移（D-1…D-6）与脚本/凭据清理（G-11/12/13）。

---

*本报告已写入 `/output/infinite-date-v2/docs/archive/reviews/REVIEW_V5.md`。方法：5 路并行子代理全量深读 + 主代理对每条 🔴 与关键 🟠 亲自读源码复验。未经运行验证的并发/时序结论（M-1/M-2）已按「静态强证据」标注。*
