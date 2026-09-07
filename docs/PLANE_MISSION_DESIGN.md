# 位面任务系统（Plane Mission）设计方案

> 状态：**已上线**（2026-09-06）。位面任务系统已实现并投产，替代旧世界任务 / NPC 任务入口（卦象纯函数保留待用）。
> 目标：替换旧「世界任务（`quest_type='world'`）+ NPC 邀请任务（`quest_type='npc'`）」两套重机制。
> v3 变更：位面崽独立数据模型；**聊天引擎复用「场景剧本」那套（结构化动描 + 数值 + 目标）**，不再独立写轻量聊天。

---

## 一、定位

玩家去其他位面做委托，遇到「崽」（恋爱智能体）。崽是玩家（崽妈）创建的，发布进公共池。玩家左右滑动刷池、直接聊天，完成委托（达成目标 / 好感加满）后，**玩家**获得权限奖励。崽不进主城。

三页签：

- **任务大厅**：公共池卡片流，左右滑动，直接点进聊天。
- **任务列表**：正在聊的崽（继续 / 重玩）。
- **我的**：新建、管理自己的崽。

---

## 二、核心决策（星落已定）

1. **位面崽独立**，不复用主城 `characters` 角色卡。
2. **好感满值固定 100**，不可自定义。
3. **崽妈只定义任务（目标）**；不填任务 = 默认好感度完成方式（好感到 100 完成）。
4. **聊天要带动描**，复用「约会 / 剧本」那套现有聊天实现，不自造干巴巴的纯文字聊天。
5. 完成后发权限给**玩家**（复用 `grantPlayerPermission`）。
6. 卦象驱动纯函数保留，只停 world/npc 任务里 LLM 世界生成流程与入口。

---

## 三、数据模型（独立）

### 3.1 `plane_characters`（位面崽，新建）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | TEXT PK | |
| creator_id | TEXT | 崽妈 player_id |
| name | TEXT | 名称 |
| gender | TEXT | 性别 |
| summary | TEXT | 对外简介（大厅展示，**不进 prompt**） |
| persona | TEXT | 对内人设（进 prompt 给 LLM 扮演；**空则复制 summary**） |
| greeting | TEXT | 开场白（可空，可 roll 生成） |
| avatar | TEXT | 头像（image_blobs 文件名，可空） |
| goal | TEXT | 任务/目标描述（**空 = 默认好感度型**） |
| published | INT | 是否发布进池 |
| play_count | INT | 被攻略次数 |
| created_at / updated_at | INT | |

> 简介/人设是一份设定的内外两面：`summary` 对外展示、不进提示词；`persona` 对内进提示词，为空自动复制 `summary`。

> 好感满值固定 100，**不存字段**，代码写死。
> 完成方式只有两种，由 `goal` 是否为空决定：空 → 好感度型（好感 100 完成）；非空 → 目标型（达成目标完成）。

### 3.2 会话与消息

位面聊天复用场景剧本引擎，**会话/消息直接复用 `scene_sessions` / `scene_messages` 表**（引擎内核 `advanceScene`/`judgeStatsAndAmbient`/`rollback` 硬编码读写 scene 表，复用表才能零改表名），用两个标记区分：

- `scene_sessions.scene_type = 'plane'`：标记位面会话。
- `scene_sessions.plane_character_id`：绑定位面崽（普通剧本为 NULL）。

好感度存 `stats_state`（当前值）、`goal` / `goal_achieved` 复用剧本字段；动描是结构化的「拍」（演员拍带动作 + 旁白拍），存 `scene_messages`。

> 位面崽独立（`plane_characters`），会话/消息复用场景引擎表——这是「聊天用剧本那套」的直接结果。

---

## 四、聊天引擎（复用「场景剧本」）

复用 `scene-wiring.ts` 的内核，不改动它已有的逻辑：

- **拍推进**：`runSceneTurnNamed` / `advanceScene`（逐拍点名 → 演员台词+动作 / 旁白环境描写），SSE 流式。
- **数值判定**：`judgeStatsAndAmbient`（LLM 每轮定 `changes` 的 delta，clamp 到 [0, 100]）→ 落 `stats_state`。
- **完成判定**：目标型看 `goal_achieved`；好感度型看 `stats_state['好感度'] >= 100`。
- **动描 prompt**：沿用现有「玩家能看见你，每条回复都要有身体语言」的叙事规则（`prompt/builder.ts`）。

**需要改造的一点（引擎适配，第 2 步 ✅ 已完成并离线验证）**：场景引擎当前从 `characters` 表读角色卡当 NPC 身份（`scene-wiring` 读 `characters / scene_relationships / scene_homes`）。位面崽独立后，在 `scene-wiring.ts` 加 `scene_type='plane'` 分支——**纯增量加分支，plane 分支只在 `scene_type='plane'` 触发，现有 scenario/mission/date 剧本行为完全不变**。具体 4 个改造点：

1. **`buildSceneContext` 加 plane 分支**：`if (scene_type === 'plane') return buildPlaneSceneContext(session)` —— 读 `plane_characters` 的 summary 当场景基调，无地点 / 地图 / 路人（仿现有 scenario 分支）。
2. **`advanceScene` actor 组装加 plane 分支**：`characterIds = [session.plane_character_id]`；actor 名字读 `plane_characters.name`；`character_card` 用 `persona`（空则 `summary`）拼简卡；`player_description` 用 `summary`（对外简介当第一印象，不查 scene_relationships）。
3. **路人跳过**：`rNpcs = (isScenario || isPlane) ? [] : ...`。
4. **move 跳过**：`if (!isScenario && !isPlane)`。

好感度满值 100 的实现：`stats_config` 配 `{ name:'好感度', initial:0, target:100 }`，`judgeStatsAndAmbient` 每轮判 delta，`applyStatsChanges`（scene-scenario.ts）clamp 到 [0, target]。这是「独立」的正确落地——身份来源可注入，不是复用 characters。

---

## 五、三页签 + 接口（`/plane/*` 新建）

- 任务大厅：`GET /plane/pool`（公开池卡片流，含 summary / avatar / 完成方式预览）、`GET /plane/pool?swipe=`（刷下一张）。
- 聊天：`POST /plane/sessions`（进崽开会话，快照 goal）、`POST /plane/sessions/:id/advance`（SSE，复用引擎）、`/retry`、`/undo`、`/end`。
- 完成与奖励：`/end` 时判完成 → `grantPlayerPermission` 发奖励（完成发一次，重玩不发）。
- 任务列表：`GET /plane/sessions/active`、`GET /plane/sessions`（历史）。
- 我的：`POST /plane/characters`、`PATCH /plane/characters/:id`、`DELETE`、`GET /plane/characters?mine=1`、`POST /plane/characters/:id/publish`。

---

## 六、复用点清单

**直接复用**：
- `runSceneTurnNamed` / `advanceScene`（拍推进 + 动描 + SSE）
- `judgeStatsAndAmbient`（好感度数值判定 + 目标判定）
- 动描叙事规则（`prompt/builder.ts`）
- `grantPlayerPermission` / `getCosts`（发权限）
- `permission-costs.json`（奖励配置）
- 卦象纯函数（保留待用）

**需改造（适配独立）**：
- 场景引擎 NPC 身份来源抽象，支持从 `plane_characters` 注入。

**不复用**：
- `characters` 角色卡、`creation.ts` 建卡、`conversation` 约会引擎、旧 `scenario.ts`（已归档）、`messages` 表（动描非结构化）。

---

## 七、已确定

- **聊天引擎**：A —— 完整复用场景剧本引擎（演员拍/旁白拍 + `judgeStatsAndAmbient` + SSE）。
- **重玩**：完成发一次权限，重玩不发（防刷）。
- **开场白**：可 roll（崽妈填了用 / 空则 roll 生成）。

## 八、实现顺序（拆解）

1. **数据层**：建 `plane_characters` 表 + `scene_sessions` 加 `plane_character_id` 列（migration）。✅ 已完成并验证（typecheck + 内存库 SQL 跑通）。
2. **引擎适配**：`scene-wiring.ts` 加 `scene_type='plane'` 分支（4 个加分支点）+ `stats-functions.ts` 补 `applyAffection`。纯增量，不影响现有剧本。🔨 进行中。
3. **建卡**：`/plane/characters` 独立建卡表单（name / summary / persona / greeting / avatar / goal）。
4. **聊天**：`/plane/sessions` 开会话 + `/advance`（SSE）复用引擎。
5. **完成与奖励**：`/end` 判完成 → `grantPlayerPermission`。
6. **三页签接口**：大厅池、任务列表、我的。
7. **下线旧任务**：停 `world` / `npc` 任务入口与 LLM 世界生成（卦象函数保留）。
8. **前端**：三页签 UI + swipe 卡片流。
9. **离线验证**：全链路用真实历史数据跑样本，通过才上线。
