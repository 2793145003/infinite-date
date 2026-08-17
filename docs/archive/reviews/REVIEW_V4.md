# v2 代码与文档审查报告（第四轮）

> 审查时间：2026-08-13
> 审查范围：全项目源码 + 设计文档 + 迁移逻辑 + 配置
> 方法：逐文件读源码验证 + 实测探针（新库首启）+ 文档与代码交叉比对，不依赖旧报告结论

---

## 摘要

两个 🔴 致命问题都指向同一个系统性根因：**「退役表 / 惰性建表」的引用缺少存在性保护**。其后果是——开源后任何新用户 `git clone` 下来**首次启动必然失败**，且「删档/删好友/删NPC」三条删除链路在新库上也会因同一个原因挂掉。

**本轮（2026-08-13）已按用户拍板的决策修复**：两个 🔴 + 外键 + requireAdmin + image_blobs + COOKIE_SECRET 均已修复并经实测验证（详见「修复记录」章节）。文档漂移（🟡-6/7/8/9）按用户决策留到代码稳定后单独一轮统一更新。

---

## 修复记录（2026-08-13 本轮，已实测验证）

按用户拍板的决策执行，逐项如下：

| 项 | 修复内容 | 验证 |
|---|---|---|
| 🔴-1 首启失败 | 新建 `lib/scene-schema.ts`（10 张 scene/turn 表统一建表，含全字段 + FK）；`db/index.ts` 把 `SCHEMA_SQL`+`SCENE_SCHEMA_SQL` 移到所有 migration 之前；`scene_schedule_entries` 的 migration 上移；4 个 `ensureX` 函数改为 `db.exec(SCENE_SCHEMA_SQL)` 幂等空转 | ✅ 新库首启无 throw；10 张表全建；scene_sessions 23 字段（stats_config 在建表位） |
| 🔴-2 退役表清理 | 删三处 `DELETE FROM npc_schedules`（player.ts/me.ts/admin.ts） | ✅ `rg npc_schedules` 仅剩注释，无 DELETE 语句 |
| 🟡 外键缺失 | `scene_relationships.scene_session_id`→`ON DELETE SET NULL`；`turn_memory_fold`/`turn_player_facts.scene_session_id`→`ON DELETE CASCADE`；`scene_schedule_entries` 保持无 FK（行程弱关联，删角色不级联删行程） | ✅ 探针正则验证 FK 全部生效 |
| 🟡 requireAdmin 重复 | 抽到 `lib/auth.ts` 导出，三处（admin/scene-named/feedback）改 import | ✅ typecheck 通过 |
| 🟡 image_blobs LIKE | 两处（admin.ts/player.ts）加 `ESCAPE '\'` | ✅ typecheck 通过 |
| 🟡 COOKIE_SECRET | `.env.example` 补 `COOKIE_SECRET` 段 + 生成说明 | ✅ 已写入 |
| 🟡 LLM key | **未改值**：key 被 Hermes 脱敏无法看到原文，且 adapter 把它作为 `Authorization` 头传给本地 vLLM（llm/adapter.ts:172），改值可能破坏本地鉴权。仅在 `.env.example` 加了注释说明 | ⏳ 待星落确认（本地 vLLM 是否配了 `--api-key`） |

**验证方式**：`IDATE_DATA_DIR=/tmp/fresh-db-probe-v4 npx tsx` 跑临时探针（全新库首启）+ `npx tsc --noEmit`（typecheck）。探针脚本已删。

> 调试插曲：首版探针在脚本内写 `process.env.IDATE_DATA_DIR`，但 ESM `import` 会被 hoisted，导致该设置在 `db/index.ts` 执行后才生效，探针实际读到 `data/` 生产库（302MB），一度误判 FK 未生效。改用命令行环境变量（进程启动前生效）后正确。

---

## 🔴 严重问题

### 🔴-1：全新库首次启动必然失败（迁移顺序 + 惰性表迁移双 bug）✅ 已修

**实证**：写探针指向全新临时库，`import db/index.ts` 即抛：

```
[migration locations_home_of] FAILED (will retry next startup): no such table: locations
THREW: no such table: locations
```

**根因 A — migration 跑在 `SCHEMA_SQL` 之前**：
`db/index.ts` 里，`migration('locations_home_of')`（第 38 行）和 `migration('locations_parent_id')`（第 41 行）都执行 `ALTER TABLE locations ...`，但建表的 `db.exec(SCHEMA_SQL)` 在第 48 行才执行。首次启动时 locations 表还不存在，`ALTER TABLE` 直接抛 `no such table`，migration 函数 `throw err`（第 32 行），模块加载失败，服务器进程退出。

**根因 B — scene 表迁移依赖惰性建表**：
即使把 `SCHEMA_SQL` 挪到 migration 之前，还有 4 个 migration 依然会挂：

| migration | 语句 | 依赖表 |
|---|---|---|
| `scene_sessions_circumstance` | `ALTER TABLE scene_sessions ADD COLUMN circumstance` | scene_sessions |
| `scene_sessions_current_location_id` | `ALTER TABLE scene_sessions ...` | scene_sessions |
| `scene_messages_quote` | `ALTER TABLE scene_messages ADD COLUMN quote` | scene_messages |
| `scene_sessions_scenario_fields` | `ALTER TABLE scene_sessions ...`（9 列） | scene_sessions |

`scene_sessions` / `scene_messages` **不在 schema.ts**（已 grep 确认，schema.ts 共 41 张表，无任何 `scene_*` / `turn_memory_*`），只在 `scene-session.ts` 的 `ensureSceneSession()` 里惰性建表，而 `ensureSceneSession()` 只在路由 handler 里被调用（scene.ts:45、scene-wiring.ts:473）。启动时表必不存在 → `ALTER TABLE` 抛 `no such table` → 同样 `throw`。

**影响**：开源后新用户首次 `npm run dev` 即崩溃，无法启动。生产库之所以没暴露，是因为表早已存在、`schema_migrations` 也已有记录（跳过）。

**修复建议**（两选一或结合）：
1. 把 `db.exec(SCHEMA_SQL)` 移到**所有** migration 之前（第 37 行之前）。
2. 把 scene 引擎表（scene_sessions/scene_messages/scene_relationships/scene_locations/scene_schedule_entries/turn_memory_fold/turn_player_facts）的建表语句**纳入 SCHEMA_SQL 或单独一个 `ensureSceneTables()` 在 migration 前调用**，让 `ALTER TABLE` 有表可改。

---

### 🔴-2：退役表 `npc_schedules` 的清理代码在新库上抛错，三条删除链路失效 ✅ 已修

**位置**（三处，都是 `DELETE FROM npc_schedules`）：

| 文件 | 行 | 触发路径 |
|---|---|---|
| `routes/player.ts` | 87 | 玩家删档 `DELETE /player` |
| `routes/me.ts` | 163 | 删好友 `DELETE /me/friend/:characterId` |
| `routes/admin.ts` | 387 | 管理员删NPC |

**根因**：`npc_schedules` 表的建表语句已从 `schema.ts` 移除（schema.ts:299 注释「已退役，建表语句已移除」），但三处删除代码仍在 `DELETE FROM npc_schedules`。全新库上这张表**永远不存在**，`DELETE FROM` 抛 `no such table: npc_schedules`。

**影响**：
- 删档流程有事务包裹（player.ts:72–141 `BEGIN`/`ROLLBACK`），抛错后整体回滚并返回 500 —— **删档功能在新库 100% 失效**。
- 删好友、删NPC 同理中断（依赖各自是否有 catch，但无论如何都会失败或留下孤儿数据）。

**同类隐患**：`player.ts` 删档的 `tables` 数组还包含 `scene_sessions` / `scene_relationships` / `scene_schedule_entries` / `turn_memory_fold` / `turn_player_facts`（第 107–111 行）——这些都是惰性建表。若玩家**从未玩过场景约会**，这些表同样不存在，删档同样抛错。

**修复建议**：
1. 直接删掉三处 `DELETE FROM npc_schedules`（表已退役，无数据可清）。
2. 对惰性表：删档前先调用 `ensureSceneSession()` / `ensureSceneMap()` / turn-memory 的 `ensureTable()` 建表，或对每个表名做 `sqlite_master` 存在性检查后再 DELETE。

---

## 🟡 中等问题

### 🟡-3：外键缺失（REVIEW_V3 P1-NEW-1 / P1-NEW-2 / P2-NEW-2 均未修）✅ 已修（scene_session_id 三处）

- `scene_relationships.scene_session_id`（scene-session.ts:61）无 `REFERENCES`
- `turn_memory_fold.scene_session_id`（turn-memory.ts:34）、`turn_player_facts.scene_session_id`（turn-memory.ts:51）无 `REFERENCES`
- `scene_schedule_entries` 整表无任何 FK（db/index.ts:134–146）

影响：删除 scene_session 后，以上表留孤儿数据。同表内 `player_id` 都有 `REFERENCES players(id) ON DELETE CASCADE`，唯独 `scene_session_id` 漏了。

### 🟡-4：`requireAdmin` 三处重复定义（P2-NEW-1 未修）✅ 已修（抽 lib/auth.ts）

`admin.ts:17`、`scene-named.ts:23`、`feedback.ts:14` 三处完全相同的实现。建议抽到 `lib/auth.ts` 导出。

### 🟡-5：`image_blobs` LIKE 删除未转义（P2-NEW-3 未修，且新增一处）✅ 已修（加 ESCAPE）

- `admin.ts:412` + `player.ts:117`（本轮发现 player.ts 新增了同款代码）：`DELETE FROM image_blobs WHERE id LIKE '${playerId}_%'`
- `_` 在 SQL LIKE 里是单字符通配符，语义不精确。UUID 不含 `_` 所以实际风险低，但应加 `ESCAPE` 或改前缀匹配。

### 🟡-6：CODE_MAP.md 行数漂移

旧导演引擎移除后未更新：

| 文件 | 宣称 | 实际 | 漂移 |
|---|---|---|---|
| run-scene-turn.ts | 1564 | 1198 | **-366** |
| scene-wiring.ts | 1246 | 1276 | +30 |
| ScenarioEditor.tsx | 388 | 424 | +36 |
| ScenarioSceneList.tsx | 198 | 115 | -83 |
| ScenarioSceneApp.tsx | 591 | 536 | -55 |

### 🟡-7：CODE_MAP.md 索引不全

- 漏列 `lib/explore-store.ts`（探索会话纯内存存储，2026-08-06 新增）
- 「脚本」章节只列了 1 个（migrate-scene-message-embeddings.ts），实际 `scripts/` 下有 **40+ 个**脚本（`ab-*.ts` 等 AB 测试脚本、`ps-*.ts`、`repro-*.ts`、`h2h2.ts` 等）。开源准备时这些调试脚本需决定去留（git 历史已保留，工作区是否继续保留可再议）。

### 🟡-8：DATA_MODEL.md `scene_sessions` DDL 缺 9 个剧本字段

DDL（829–843 行）缺 `scenario_id` / `worldview` / `player_role` / `npc_roles` / `goal` / `opening_scene` / `dream_text` / `dream_custom` / `ambient_config` / `goal_achieved`（代码 migration `scene_sessions_scenario_fields` 已加）。且 `scene_type` 注释仍写「当前 'date'」，未提 `'scenario'`。

### 🟡-9：DATA_MODEL.md Migration 记录缺 scene 引擎迁移

Migration 记录章节（1089–1193）只覆盖了旧系统表，**完全没记**：`scene_sessions_circumstance`、`scene_sessions_current_location_id`、`scene_messages_quote`、`scene_sessions_scenario_fields`、`scene_schedule_entries` 建表、`scenarios_ambient_config`、`scenarios_greetings`。

### 🟡-10：`.env.example` 缺 `COOKIE_SECRET` ✅ 已修

`index.ts:53` 用 `process.env.COOKIE_SECRET || crypto.randomUUID()`。不设则每次重启生成新密钥，所有已登录用户的 httpOnly cookie 签名验证失败 → **重启即全站登出**。开源前应加入 `.env.example` 并在 README 说明。

### 🟡-11：`config.ts` 硬编码 LLM_API_KEY fallback ⏳ 待确认（未改值，仅加注释）

`config.ts:22` 和 `.env.example` 都写了一个 `sk-` 开头的默认值（读文件时被 Hermes 脱敏，无法看到具体值）。开源前必须确认这是 dummy 还是真实 key：若是真实 key，务必移除并改用环境变量 + 占位符。

---

## 🟢 轻微问题

- **🟢-12**：CODE_MAP 写 DB 路径 `data/idate.sqlite`，实际 config.ts 是 `infinite-date.sqlite`（DATA_MODEL 写对了）。
- **🟢-13**：`apps/server/src/systems/` 有 6 个空子目录（city/creator/deity/missions/permission/social），无任何文件，git 不追踪空目录，属磁盘残留。
- **🟢-14**：废弃列残留——`schema.ts:294` relationships 仍建 `next_message_eligible_at`（已被 `sms_urge`/`moment_urge` 替代）；`scene_locations.home_of` 遗留列（scene-map.ts:36，实际用 `scene_homes` 表）。
- **🟢-15**：`permission_costs.json` 所有消耗仍为 0（P3-NEW-3），开发阶段可接受，开源前应设值或加启动警告。

---

## ✅ 本轮验证已修复 / 通过

- **P1-NEW-3**（turn-memory `void Promise.all` 无 catch）→ 已加 `.catch(err => log(...))`（turn-memory.ts:490、503）✅
- **P3-NEW-1**（`current_activity` 引用需确认）→ 已确认充分使用：scene-rollback.ts、run-scene-turn.ts、scene.actor.txt 都在读写，非死字段 ✅
- **P3-NEW-2**（旧导演模板 scene.director.txt）→ 已删除 ✅

## ✅ 安全审查通过

- **SQL 注入**：所有动态拼接标识符都有白名单/硬编码保护——`scene-scenario.ts` 的 `${field}` 有 `SCENARIO_FIELDS.includes()`、`${setClauses}` 有 `ALLOWED_PATCH_FIELDS`、player.ts 的 `${updates}`/`${t}` 都是硬编码数组。无注入漏洞。
- **fire-and-forget**：scene-wiring.ts:853 的 `void runTurnMemoryUpdate(...)` 已带 `.catch` 兜底。
- **无 TODO/FIXME** 残留；图片上传有魔数校验 + 10MB 限制（上轮已确认）。

---

## 做得好的部分（延续上轮，无需重列细节）

事务安全、migration 框架幂等 + duplicate-column 安全跳过、prompt 模板外部化、SSE 超时 + AbortController——这些上轮已确认，本轮无回退。

---

## 附：REVIEW_V3 问题状态对照表

| 编号 | 问题 | 本轮状态 |
|---|---|---|
| P1-NEW-1 | scene_relationships.scene_session_id 无 FK | ✅ 已修（SET NULL） |
| P1-NEW-2 | turn_memory 两表 scene_session_id 无 FK | ✅ 已修（CASCADE） |
| P1-NEW-3 | void Promise.all 无 catch | ✅ 已修 |
| P2-NEW-1 | requireAdmin 三处重复 | ✅ 已修（抽 lib/auth.ts） |
| P2-NEW-2 | scene_schedule_entries 无 FK | ⏳ 保持无 FK（弱关联设计，已加注释说明） |
| P2-NEW-3 | image_blobs LIKE 未转义 | ✅ 已修（加 ESCAPE） |
| P2-NEW-4 | PROMPTS.md 字段名易混淆 | ⏳ 未复检（本轮聚焦迁移/数据层） |
| P3-NEW-1 | current_activity 引用需确认 | ✅ 已确认使用 |
| P3-NEW-2 | 旧导演模板保留 | ✅ 已删除 |
| P3-NEW-3 | 权限消耗全 0 | ⏳ 仍在（开发阶段） |

---

*报告已写入 `/output/infinite-date-v2/REVIEW_V4.md`。本轮前段为只读审查，后段按用户拍板的决策执行修复（见「修复记录」章节），已实测验证。剩余待办：🟡-6/7/8/9 文档漂移留待代码稳定后统一更新；🟡-11 LLM key 待星落确认本地 vLLM 是否配 `--api-key`。*
