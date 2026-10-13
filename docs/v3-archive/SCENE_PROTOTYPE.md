# 场景引擎原型副本 — 交接/续接说明

> 位置：`/Users/ltl/infinite-date-v2-scene`
> 这是从 `~/infinite-date-v2`（无限心动主 repo）**复制出来的独立原型环境**，用于放心做实景引擎（Scene Engine）的原型，不碰主 repo。
> 本文件是给"换环境（飞书）继续"时的交接说明。

---

## 一、这个副本是什么

- 是主 repo 的完整源码副本，排除了 `node_modules/.git/data`。
- 已 `git init` 并提交存档（首个存档点 `11c27c8`）。
- 改了两处并提交：
  1. `apps/server/src/db/index.ts` — 修复空库启动迁移顺序 bug（`locations_home_of`/`locations_parent_id` 的 migration 移到 `db.exec(SCHEMA_SQL)` 之后，否则新建空库时 `no such table: locations` 崩溃）。
  2. `apps/server/scripts/validate-templates.ts` — 新增 scene.director 模板真 LLM 验证脚本。

## 二、怎么连 LLM & 怎么跑

- **LLM 连接**：`apps/server/config.ts` 走环境变量，副本没有 DB，所以用 `.env` 撑起连接（gitignore 已排除 `.env`，含 key 不会进 git）：
  ```
  LLM_BASE_URL=https://magnesium-litellm.gear-c1.xiaosuan.com/v1
  LLM_API_KEY=<xiaosuan key>
  LLM_MODEL=xiaosuan-8
  ```
- **跑验证脚本**（模板载入路径依赖 cwd，必须从 `apps/server/` 下跑）：
  ```bash
  cd apps/server
  set -a && source ../../.env && set +a
  CI=true npx tsx scripts/validate-templates.ts date    # 普通约会
  CI=true npx tsx scripts/validate-templates.ts live    # 直播剧本(数值)
  ```
- **typecheck**（从 repo 根）：
  ```bash
  CI=true pnpm run typecheck
  ```

## 三、方案文档在哪

`docs/scene-engine.md` — 全部"已决"项已定稿：
- §3.0 新写干净内核，逐个接入替换（不重开 v3）
- §3.2 beat 契约（导演版 intent / 演员版 content 两态）
- §3.3 两阶段：导演编排 + 逐拍演员；**导演是自由编排者（默认从简/按触发加料/无固定顺序）**
- §3.3.1 节奏（自然收口，不硬加收口拍）
- §3.3.5 内心戏（角色自我驱动，与导演 intent 解耦）
- §3.3.6 记忆分层（热窗/近期段/全摘要；场摘要给玩家看，导演只看本场角色记忆）
- **§3.3.7 数值 = 建剧本注册的结算函数，导演调用，旁白照述**（治"5万 vs 20"）
- §3.4 落库原子性（同一事务）
- §3.6 当前地点+场景规则合并为 Scene

## 四、已验证

- typecheck 全绿（server/web/shared）。
- `scene.director` 模板真 LLM 验证：
  - `date`（普通约会）：5 拍，克制，星回/商贩自然，末拍自然收口回玩家。
  - `live`（直播剧本）：旁白建场 + 助理起哄 + 收口，导演自由编排成立。
  - **尚未验证**：直播场景让导演真正"调用数值函数 + 旁白照述负债"的完整闭环。

## 五、下一步（建议）

1. **数值函数机制原型**：在副本定义 2-3 个结算函数（debt/cash/heat），改 `validate-templates.ts` 或新脚本，驱动直播场景让导演"调用函数 → 函数算值 → 旁白照述"，真 LLM 验证"刷礼物→负债-xxx"闭环 + 治"5万 vs 20"。
2. **打磨 scene.director / scene.actor 模板第二版**（针对近期约束调优）。
3. 之后再看是否把内核 `runSceneTurn` 接回主 repo。

## 六、重要提醒（副本与主 repo 的边界）

- **副本 `data/` 为空库**（复制时排除了主库数据）。所以副本只能跑"不依赖真实角色数据"的验证（如 validate-templates 手写场景上下文）。若要对接主库真实角色数据（星回/玩家），需在主 repo 跑，或把主库拷进副本。
- **主 repo `/Users/ltl/infinite-date-v2` 未提交**：P0 修复、proactive 重写、方案文档等改动还在磁盘上，未 commit。是否提交由用户回来定。
- 场景引擎相关资产（模板 scene.director/scene.actor、方案 docs/scene-engine.md、spike scripts）在主 repo 和副本**都有一份**。
