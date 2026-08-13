# 剧本系统 v2 设计文档 — Scene 引擎版

> 2026-08-10 初稿。基于现有剧本系统（`scenario.ts` + 旧 `generateReply`）迁移到场景引擎（`scene-wiring.ts` + `runSceneTurnNamed`）。

---

## 一、动机

现有剧本系统用旧 `generateReply` / `generateGroupReply` 一轮一次 LLM，整段返回。缺少：
- 逐拍流式推送（玩家等全部生成完才看到内容）
- 旁白系统（只有开场一条 narration，之后全靠 NPC 台词推进）
- 角色心声（旧系统有但不走 scene_messages）
- 地点移动（剧本全程固定场景，不能换地方）
- current_activity（NPC 无活动感知，容易停滞）

场景引擎已经解决了以上所有问题，且 `scene_sessions` 表已预留 `scene_type`、`stats_config`、`stats_state` 字段。新剧本直接复用引擎，不重造轮子。

---

## 二、设计原则

1. **新建路由 `/scene-scenario/*`，不改普通约会路由**
   - 剧本 enter/start/end 参数差异大（scenarioId + 多NPC + 数值），混在一起全是 if
   - 剧本特有逻辑（做梦 / 数值判定 / worldview 注入）不污染普通约会
   - **核心引擎完全复用**：advanceScene / rollback / SSE / namer / actor / narration 都 import 现有模块

2. **复用 `scene_sessions` 表，加几列存剧本上下文**
   - `scenario_id` / `worldview` / `player_role` / `npc_roles` / `goal` / `opening_scene`
   - 普通约会这些列为 NULL，零影响
   - `scene_type = 'scenario'` 区分

3. **剧本上下文注入到 SceneContext**
   - `buildSceneContext` 加分支：有剧本字段 → worldview/player_role/npc_roles/goal 注入到 tone/rules
   - actor/namer/narration 全部通过 SceneContext 感知剧本设定

4. **数值系统两条路径并存**
   - **旧路径**：`judgeStats` 每轮调 LLM 判增减（现有剧本方式）
   - **新路径**：导演在编排时定值 → `statsFns` 结算 → 旁白报结果（场景引擎已有）
   - **决策：用新路径**。导演编排时可以直接在 beat 里带 `fn` + `args`，statsFns 执行后旁白引用真实结果。不再额外调 LLM 判数值——省一次 LLM 调用，且数值和旁白天然一致
   - 但保留 `stats_config` 在 scenarios 表里（建剧本时定义数值规则），注入到 SceneContext.rules 让导演知道有哪些数值、怎么判断增减

5. **不做复制人设，用 prompt 注入身份**
   - 现有剧本注释说"复制 NPC 副本"但 `copy_id` 已废弃为 NULL——实际做法是 prompt 注入 npc_role
   - 新版延续这个路线：NPC 用原角色卡 + 剧本身份注入到 SceneContext.rules
   - **隔离机制**：剧本期间的 `scene_relationships`（player_description / current_activity）是独立的表，不写旧 `relationships` 表。剧本结束后做梦机制把记忆存回原 NPC 的 chronicle + memory_embeddings

---

## 三、数据模型

### 3.1 `scene_sessions` 新增列

```sql
ALTER TABLE scene_sessions ADD COLUMN scenario_id    TEXT REFERENCES scenarios(id) ON DELETE SET NULL;
ALTER TABLE scene_sessions ADD COLUMN worldview      TEXT NOT NULL DEFAULT '';
ALTER TABLE scene_sessions ADD COLUMN player_role   TEXT NOT NULL DEFAULT '';
ALTER TABLE scene_sessions ADD COLUMN npc_roles     TEXT NOT NULL DEFAULT '[]';   -- JSON 数组，每个角色一个身份描述
ALTER TABLE scene_sessions ADD COLUMN goal          TEXT NOT NULL DEFAULT '';
ALTER TABLE scene_sessions ADD COLUMN opening_scene TEXT NOT NULL DEFAULT '';
ALTER TABLE scene_sessions ADD COLUMN dream_text    TEXT;                          -- 梦的内容
ALTER TABLE scene_sessions ADD COLUMN dream_custom  INTEGER NOT NULL DEFAULT 0;    -- 0=roll生成, 1=玩家手写
ALTER TABLE scene_sessions ADD COLUMN ambient_config TEXT NOT NULL DEFAULT '';    -- 气氛组配置快照
```

> 普通约会：这些列全为 NULL / 默认值，`scene_type = 'date'`，完全不受影响。
> 剧本约会：`scene_type = 'scenario'`，这些列填入剧本设定。

### 3.2 `scenarios` 表不变

现有 `scenarios` 表结构完全复用，新增一列：
- `ambient_config TEXT NOT NULL DEFAULT ''` — 气氛组配置（类型+风格描述，空=不配气氛组）

其余字段不变：
- `title` / `description` / `worldview` / `player_role` / `npc_role`（单人）/ `npc_roles`（多人 JSON 数组）
- `opening_scene` / `greeting` / `goal` / `stats_config`
- `status`（draft / published）/ `play_count`

### 3.3 剧本编辑器不变

现有 `ScenarioEditor.tsx` 和相关 roll 路由（`/scenarios/:id/roll` / `roll-roles` / `roll-stats`）完全复用。编辑器产出的 scenarios 行供新剧本 APP 读取。

---

## 四、API 路由

### 4.1 路由清单

| Method | Path | 功能 | 复用 |
|--------|------|------|------|
| POST | `/scene-scenario/:scenarioId/enter` | 进入剧本，创建 scene_session | 新写 |
| POST | `/scene-scenario/:sessionId/advance` | 推进一轮（SSE 流式） | 调 advanceScene |
| POST | `/scene-scenario/:sessionId/continue` | 无玩家输入推进 | 调 advanceScene |
| POST | `/scene-scenario/:sessionId/retry` | 重试（SSE 流式） | 调 advanceScene(regenerate) |
| POST | `/scene-scenario/:sessionId/undo` | 撤回玩家消息 | 调 scene-rollback |
| POST | `/scene-scenario/:sessionId/end` | 结束剧本 + 触发做梦 | 新写 |
| GET  | `/scene-scenario/:sessionId/dream` | 获取梦内容 | 新写 |
| POST | `/scene-scenario/:sessionId/dream` | 手写梦内容 | 新写 |
| GET  | `/scene-scenario/active` | 获取进行中的剧本 | 新写 |
| GET  | `/scene-scenario/:sessionId` | 获取剧本会话详情 | 新写 |

> 剧本编辑器路由（`/scenarios` CRUD + roll）**完全复用现有**，不改。

### 4.2 enter 路由详细设计

```
POST /scene-scenario/:scenarioId/enter
Body: { characterIds: string[] }
```

流程：
1. 校验 scenario 已发布
2. 校验 characterIds 全部是好友 NPC
3. 全局现场互斥（`getActiveLiveSlot`）
4. 创建 `scene_session`：
   - `scene_type = 'scenario'`
   - `scenario_id` / `worldview` / `player_role` / `npc_roles` / `goal` / `opening_scene` 从 scenario 行拷贝（快照，不后续 scenario 编辑影响进行中的剧本）
   - `character_ids` = 选的 NPC
   - `root_location_id` = NULL（剧本不依赖 scene_locations 地点系统，场景由世界观描述驱动）
   - `stats_state` = 从 stats_config 初始化
   - `stats_config` = 从 scenario 拷贝
5. 为每个 NPC 确保 `scene_relationships` 记录存在
6. 返回 sessionId

**开场**：
- 如果有 `opening_scene`：advanceScene 第一轮不带玩家消息，引擎自动排旁白开场
- 如果有 `greeting`：作为 NPC 第一句台词注入（开场旁白后）
- 两都没有：advanceScene 第一轮空消息推进，引擎自动生成开场

### 4.3 advance 路由详细设计

完全复用 `advanceScene`，SSE 模式同 `/scene/:sessionId/advance`：
- `onDirector` → 推导演分镜
- `onBeat` → 推每拍内容（npc / narration / stats）
- `done` → 推最终状态（round / stats / location）

唯一差异：剧本不需要 `locationId` / `locationName` / `locationBackground`（地点由世界观描述驱动，不依赖 scene_locations）。`done` 事件中这些字段为空。

### 4.4 end 路由详细设计

```
POST /scene-scenario/:sessionId/end
```

流程：
1. 标记 `scene_sessions.ended = 1`
2. per-character 收尾：
   - `endSceneSession(sessionId, playerId)` —— 复用场景引擎的收尾逻辑（补折记忆 + resetEligibleTimer）
3. **做梦**（异步，不阻塞响应）：
   - 每个参与 NPC 各做一个梦
   - 复用现有 `generateAndStoreDream` 逻辑（改为读 scene_messages 而非旧 messages 表）
   - 梦存入 `scene_sessions.dream_text`（单人）或 per-character 存储待定（多人）
   - 存 chronicle（source='dream'）+ 向量化 + NPC 发梦短信

### 4.5 dream 路由

```
GET  /scene-scenario/:sessionId/dream       → 获取梦内容
POST /scene-scenario/:sessionId/dream       → 玩家手写梦内容
     Body: { dreamText: string }
```

- 手写梦覆盖自动生成的梦
- 手写梦也走 chronicle 存储 + 向量化 + NPC 发短信

---

## 五、剧本上下文注入

### 5.1 buildSceneContext 改动

在 `buildSceneContext` 开头加分支：

```typescript
// 剧本模式：从 session 读取剧本字段
const isScenario = session.scene_type === 'scenario';
if (isScenario) {
  // 剧本不依赖 scene_locations，用世界观描述替代地点信息
  const worldview = session.worldview || '';
  const playerRole = session.player_role || '';
  const npcRoles = jsonParse<string[]>(session.npc_roles, []);
  const goal = session.goal || '';
  const openingScene = session.opening_scene || '';

  // 地点信息用世界观描述替代
  locationName = '剧本场景';
  summary = worldview;

  // tone 注入剧本基调
  tone = `剧本世界观：${worldview}`;
  if (playerRole) tone += `\n玩家身份：${playerRole}`;
  if (goal) tone += `\n剧本目标：${goal}`;

  // rules 注入角色身份分配
  rules = '';
  if (npcRoles.length > 0) {
    const charIds = jsonParse<string[]>(session.character_ids, []);
    rules = '角色身份分配：\n' + npcRoles.map((role, i) => {
      const name = getCharacterName(charIds[i] ?? charIds[0]);
      return `· ${name}：${role}`;
    }).join('\n');
  }

  // 数值系统规则
  const statsConfig = jsonParse(session.stats_config, '[]');
  if (statsConfig.length > 0) {
    rules += '\n数值系统：\n' + statsConfig.map(s =>
      `· ${s.name}（目标：${s.target ?? '无'}）：${s.rules}`
    ).join('\n');
  }

  // 跳过 scene_locations 查询、circumstance 逻辑
  // 剧本不需要地点路人、不需要 circumstance
}
```

### 5.2 开场情境

剧本的 `opening_scene` 替代普通约会的 circumstance 机制：
- 第一轮 advanceScene 不带玩家消息
- 引擎自动排旁白 → 旁白引用 opening_scene 作为场景描述
- 之后 NPC 各自按性格 + 剧本身份反应

如果 scenario 有 `greeting` 字段（NPC 的第一句话），可以作为第一轮的"导演指令"注入——但更简单的做法是让引擎自己生成开场，greeting 只作为 fallback（引擎生成失败时用）。

### 5.3 地点移动

剧本模式不依赖 `scene_locations` 地点系统。但场景引擎的 move 机制仍然可用——导演可以在 beat 里排 move，只是 `to` 指向的不是 scene_locations ID，而是剧本内的场景描述。

**决策**：剧本模式禁用 move。原因：
- move 依赖 `scene_locations` 表查地点名/背景/路人
- 剧本场景由世界观描述驱动，没有 scene_locations 记录
- 避免引入"虚拟地点"的复杂度

实现：在 `buildSceneContext` 剧本分支里，`availableLocations` 设为空字符串，导演/namer 看不到可移动地点自然不会排 move。

---

## 六、数值系统 + 气氛组（合并 LLM 调用）

数值判定和气氛组都是"本轮对话的副作用"，合并到同一次 LLM 调用，省一次 round-trip。

### 6.1 方案

每轮 advanceScene 完成后，用一次独立的轻量 LLM 调用，同时做两件事：
- **数值判定**：哪些数值该变、变多少
- **气氛组**：生成 0~N 条简短环境反应（弹幕、围观群众议论等）

两者都由 LLM 根据本轮对话内容判断——该变才变、该有才有，日常闲聊返回空。

### 6.2 数值系统

1. **建剧本时**：`stats_config` 定义数值规则（名称/初始值/规则/目标），存入 scenarios 表
2. **进入剧本时**：`stats_config` 拷贝到 `scene_sessions.stats_config`，`stats_state` 从初始值初始化
3. **每轮推进时**：
   - advanceScene 正常执行（SSE 逐拍推送 NPC 台词 / 旁白 / 心声），引擎不碰数值
   - 引擎完成后，拿玩家消息 + NPC 回复 + 当前 stats_state + stats_config 规则 + ambient_config，调一次 LLM 判定（temperature 0.3, maxTokens 512）
   - LLM 返回 `{ changes, ambient, goal_achieved, goal_reason }`
   - 应用 changes 到 stats_state，更新 `scene_sessions.stats_state` 和 `goal_achieved`
   - 把 statsChanges + ambient 随 `done` 事件推前端
4. **前端渲染**：前端拿到结构化的 statsChanges，自己渲染数值跳动 / 进度条 / 简短提示条。不插旁白拍，不污染对话流

**不做的事**：
- 不走 statsFns（那是旧导演模式的，点名版不需要）
- 不自动插旁白拍报数字（旁白不碰数字，数值变动是纯 UI 反馈）
- 不在 actor/namer prompt 里教数值判断（独立调用更简单、更可控）

### 6.3 气氛组

**概念**：简短但高频的背景旁白——直播间弹幕刷屏、酒馆食客议论、拍卖场竞价声。本质是"系统生成的环境描写"，和玩家写的 `（xxx）` 环境描写同构。

**剧本配置**：scenarios 表加 `ambient_config` 字段，作者描述气氛组类型和风格：
- "直播间：弹幕风格活泼，会刷礼物、发弹幕、起哄"
- "酒馆：食客窃窃私语，偶尔有人大声议论"
- 空 = 不配气氛组

**生成**：跟数值判定合并到同一次 LLM 调用，输出 `ambient: ["弹幕1", "弹幕2", ...]`。LLM 判断该不该出——日常闲聊返回空数组。

**存入对话上下文**：气氛组内容作为独立的 narration 消息存入 `scene_messages`（role='narration', character_name='气氛组'），进入 `conversation_so_far`。NPC 在下一轮点名时能看到并自然反应（被弹幕逗笑、回应围观群众）。和玩家写的环境描写完全同构，引擎现有逻辑不用改。

**前端渲染**：比正式旁白更淡的样式（更小字号 / 更浅颜色 / 淡入淡出），区分"系统气氛组"和"正式旁白"。

### 6.4 合并 LLM 调用

复用现有 `scenario.stats-judge` 模板（扩展加 ambient），输入：
- stats_rules：从 stats_config 格式化
- stats_before：当前 stats_state
- player_message：本轮玩家消息
- npc_reply：本轮 NPC 回复（拼接所有 npc 拍）
- ambient_config：气氛组配置（类型 + 风格）

输出 guidedJson：
```json
{
  "changes": [{ "name": "string", "delta": "integer", "reason": "string" }],
  "ambient": ["弹幕1", "弹幕2"],
  "goal_achieved": "boolean",
  "goal_reason": "string"
}
```

### 6.5 测试验证（2026-08-10）

数值判定用真实剧本数据跑了三轮测试：

| 测试 | 剧本 | 场景 | 结果 |
|------|------|------|------|
| 1 | 催眠诊所之催眠师 | 玩家成功催眠，NPC 说"我都听" | ✅ 心理防线 -25、顺从度 +20，人格崩坏值不动 |
| 2 | 异常生物管理局 | 玩家安抚生物 + 判断准确 + NPC 认可 | ✅ 三个数值全涨（+15/+15/+10），goal_achieved=true |
| 3 | 异常生物管理局 | 日常闲聊"报告写了吗" | ✅ changes=[] 空数组 |

结论：LLM 判断质量稳定，知道哪些该动哪些不该动，delta 幅度合理，日常闲聊正确返回空。气氛组复用同一调用，预期行为一致。

### 6.6 性能

每轮多一次 LLM 调用（temperature 0.3, maxTokens 512，输入约 1000 token）。与旧 `judgeStats` 完全一致——旧剧本就是这么做的，只是换了张表 + 加了 ambient 字段。

### 6.7 与旧系统的兼容

旧剧本（`scenario_sessions` 表）的数据不迁移。旧路由 `/scenarios/*` 保留可用，但不再维护。新剧本走 `/scene-scenario/*`。

---

## 七、做梦机制

### 7.1 触发

剧本结束（`POST /scene-scenario/:sessionId/end`）时异步触发，不阻塞响应。

### 7.2 流程（复用现有 `generateAndStoreDream` 逻辑，适配 scene_messages）

1. **获取对话总结**：
   - 优先读 `turn_memory_fold`（场景引擎的折叠记忆）
   - 回退读 `scene_messages`（原始消息）

2. **生成梦内容**：
   - prompt 模板复用 `scenario.dream`
   - LLM 生成梦文本（temperature 0.85, maxTokens 512）

3. **存储**：
   - `scene_sessions.dream_text` = 梦文本
   - 存 chronicle（`source='dream'`, `summary_type='dream'`）到原 NPC 的 chronicle 表
   - 向量化存入 `memory_embeddings`（source='dream'）

4. **NPC 发梦短信**：
   - 如果 NPC 已加好友（有 `message_threads`）
   - 用旧 `generateReply` 生成一条梦短信（"我刚做了个奇怪的梦…"）
   - 存入 `text_messages`

### 7.3 多人剧本的做梦

每个参与 NPC 各做一个梦。梦的内容基于：
- 该 NPC 视角的对话总结
- 该 NPC 的角色卡 + 剧本身份

存储：`scene_sessions.dream_text` 存 JSON 数组（每个角色一个梦），或新增 `scene_dreams` 表。

**决策**：先用 JSON 数组存在 `dream_text` 字段里（`[{ characterId, name, dream }]`），简单够用。如果后续需要更复杂的查询再建表。

### 7.4 手写梦

玩家可以手写梦内容覆盖自动生成的：
- `POST /scene-scenario/:sessionId/dream` `{ dreamText: string }`
- 手写梦也走 chronicle 存储 + 向量化 + NPC 发短信
- `dream_custom = 1` 标记

### 7.5 隔离保证

- 剧本期间的 `scene_relationships`（player_description / current_activity）是独立表，不写旧 `relationships`
- 做梦存回的是 `chronicles` + `memory_embeddings`（原 NPC 的记忆系统），这是**唯一**的跨系统写入
- `relationships.player_description` 不被剧本修改（剧本用 `scene_relationships.player_description`）
- NPC 发梦短信走旧 `text_messages` + `message_threads`——这是故意的，让剧本外的短信系统能感知到梦

---

## 八、前端

### 8.1 新建 `ScenarioSceneApp.tsx`

替代现有 `ScenarioConversation.tsx`。基于 `SceneConversation.tsx`（普通约会的对话页面）改造：

**复用**：
- SSE 逐拍渲染（director → beats → done）
- 打字机效果
- 心声显示
- 撤回/重试/继续按钮
- 引用消息
- 旁白样式

**剧本特有**：
- 顶栏显示剧本标题（替代地点名）
- 数值面板（stats_state 实时显示 + 目标进度）
- 结束按钮 → 触发做梦 → 显示梦内容 / 手写梦入口
- 开场情境展示（opening_scene 作为第一条旁白）

### 8.2 页面入口

场景剧本有独立的桌面 app 入口，与旧剧本 app 并存：

```
Desktop → 🎬 场景剧本 (scenario-scene-list)
  → ScenarioSceneList（剧本列表 + 筛选 + 选好友弹窗）
    → sceneScenarioEnter(scenarioId, characterId/characterIds)
      → ScenarioSceneApp（scenario-scene，对话+数值+气氛+做梦）
```

- 桌面 APP_DEFS 里 `🎬 场景剧本` 独立于 `🎭 剧本`
- 旧剧本入口（ScenarioList → ScenarioDetail → ScenarioConversation）完全不动
- 进行中的场景剧本在列表顶部显示"点击继续"

### 8.3 API client

`api.ts` 新增：
- `api.enterScenario(scenarioId, characterIds)` → POST /scene-scenario/:id/enter
- `api.advanceScenario(sessionId, message, quote?)` → POST /scene-scenario/:id/advance (SSE)
- `api.continueScenario(sessionId)` → POST /scene-scenario/:id/continue (SSE)
- `api.retryScenario(sessionId)` → POST /scene-scenario/:id/retry (SSE)
- `api.undoScenario(sessionId)` → POST /scene-scenario/:id/undo
- `api.endScenario(sessionId)` → POST /scene-scenario/:id/end
- `api.getScenarioDream(sessionId)` → GET /scene-scenario/:id/dream
- `api.setScenarioDream(sessionId, text)` → POST /scene-scenario/:id/dream
- `api.getActiveScenario()` → GET /scene-scenario/active
- `api.getScenarioSession(sessionId)` → GET /scene-scenario/:id

---

## 九、Prompt 模板

### 9.1 不新建模板

剧本上下文通过 `buildSceneContext` 注入到 `SceneContext.tone` / `SceneContext.rules`，现有的 `scene.actor.txt` / `scene.namer.txt` / `scene.narration.txt` **不改**——它们已经会读 tone / rules 字段。

### 9.2 剧本编辑器模板复用

- `scenario.roll` — roll 剧本字段
- `scenario.stats-roll` — roll 数值系统
- `scenario.dream` — 生成梦内容

这些模板**完全复用**，不改。

---

## 十、实现状态

> 全部完成，已测试通过。以下为实际实现记录。

| 步骤 | 状态 | 说明 |
|---|---|---|
| 1. DB migration：scene_sessions 加列 + scenarios 加 ambient_config | ✅ | db/index.ts migration `scenario_sessions_character_ids` + 10 列 |
| 2. buildSceneContext 剧本分支 | ✅ | scene-wiring.ts，scene_type='scenario' 时用世界观替代地点 |
| 3. 数值+气氛组合并 LLM 判定函数 | ✅ | scene-wiring.ts `judgeStatsAndAmbient()`，prompt 模板 `scenario.stats-judge.txt` |
| 4. routes/scene-scenario.ts | ✅ | 493 行，enter/advance/continue/retry/undo/end/active/session |
| 5. 做梦机制适配 | ✅ | scene-wiring.ts `generateScenarioDream()`，读 scene_messages 写回 chronicle + memory_embeddings + 梦短信 |
| 6. ScenarioSceneApp.tsx | ✅ | 591 行，SSE 逐拍气泡 + 数值面板(高亮3秒) + 气氛组淡色斜体 + 做梦弹窗 |
| 7. api.ts + App.tsx 路由入口 | ✅ | 8 个 sceneScenario* API 方法 + scenario-scene view |
| 8. ScenarioSceneList.tsx 桌面入口 | ✅ | 独立 app 图标 🎬，列表→选好友→enter |
| 9. 手动测试 | ✅ | enter→advance SSE 完整流程通过，旁白/台词/心声/数值/气氛组全正常 |

### 关键修复记录

1. **scene_locations NOT NULL 约束**：剧本模式无 location_id，advanceScene 的 move 逻辑会 INSERT scene_locations 缺 updated_at。修：剧本模式跳过 getNpcs + move + 转场旁白（`isScenario` 守卫）

2. **ambient_config 为空时 LLM 仍出弹幕**：prompt 约束"配置为无则返回空"拦不住 LLM。修：`judgeStatsAndAmbient` 返回处代码层硬拦 `hasAmbient ? ... : []`

3. **旁白脑补天色**：runNarration 的 build 参数不含当前时间，旁白靠地点联想脑补（餐厅→晚霞）。修：开场旁白 + 自动旁白(前/后) 三处 build 都加 `当前时间` + "环境描写必须与当前时间吻合"

---

## 十一、不做的事

1. **不迁移旧剧本数据** — 旧 `scenario_sessions` 数据保留，旧路由保留可用
2. **不做剧本地点移动** — 剧本场景由世界观驱动，不用 scene_locations（`isScenario` 守卫跳过 move 逻辑）
3. **不复制 NPC 人设** — 用 prompt 注入剧本身份，NPC 用原角色卡
4. **不改剧本编辑器** — 编辑器产出的 scenarios 行供新 APP 读取
5. **不改普通约会路由** — `/scene/*` 完全不动
6. **不做数值系统导演驱动** — 用独立 LLM 判定 + 前端渲染，不走 statsFns / 导演 beat

---

## 十二、多 NPC 支持

场景剧本完整支持多人剧本（npc_roles ≥ 2）：

- **enter**：`characterIds: string[]` 传入多个 NPC，存入 `scene_sessions.character_ids`（JSON 数组）
- **buildSceneContext**：根据 `character_ids` 为每个 NPC 构建独立 actor 上下文，注入对应的 npc_role 身份
- **advanceScene**：所有 NPC 都进入候选池，namer 按 scene 引擎逻辑点名（同一角色不连续发言等规则照常生效）
- **做梦**：每个参与 NPC 各做一个梦，基于各自视角的对话总结
- **前端**：ScenarioSceneList 多人剧本显示角色槽位（角色1/角色2...），选满后确认进入
