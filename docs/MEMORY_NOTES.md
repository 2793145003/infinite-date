# MEMORY_NOTES — 从常驻记忆移出的项目细节索引

> 本文件收拢从 Hermes 常驻记忆（MEMORY.md）移出的项目细节。
> 遵循 Opus 5 记忆设计：常驻只留"指向+连接"（见 MEMORY.md），正文放这里按需 `read_file` 读取。
> 备份：完整原文在 /output/hermes-memory-backup/20260805_142653/MEMORY.md

---

## 最新（2026-08-10：旧剧本归档 + 回忆页加场景剧本页签）

### 1. 回忆页新增场景剧本页签

**问题**：回忆页场景约会列表把 `scene_type='date'` 和 `scene_type='scenario'` 的记录混在一起（库中 59 条 date + 7 条 scenario）。

**改动**：
- **后端 `archive.ts`**：场景约会列表/详情/导出 5 处加 `scene_type='date'` 过滤；新增 `GET /archive/scene-scenarios`（列表）、`GET /archive/scene-scenarios/:id`（详情）、导出 `type='scene-scenario'` 分支
- **前端 `api.ts`**：新增 `ArchiveSceneScenarioItem`/`ArchiveSceneScenarioDetail` 类型 + `getArchiveSceneScenarios`/`getArchiveSceneScenario` 方法
- **前端 `ArchiveApp.tsx`**：Tab 从「场景约会（新）」独占一行改为 🧭场景约会 / 🎬场景剧本 并排两个按钮；二级列表、三级详情、导出、空态全部加 scene-scenario 分支

### 2. 旧剧本归档到回收站

**需求**：旧剧本系统（scenario.ts）已被场景剧本（scene-scenario）替代，桌面入口移至回收站，关闭写操作 API。

**改动**：
- **桌面 `Desktop.tsx`**：去掉 🎭 剧本图标
- **回收站 `ArchivedApps.tsx`**：加旧剧本入口（🎭 只读），和旧地图并排
- **后端 `scenario.ts`**：12 个写操作路由（POST/PATCH/DELETE）函数体全部替换为 403 stub，GET 路由保留

### ⚠️ 踩坑：Fastify addHook 泄漏

第一版用 `app.addHook('preHandler')` 拦截非 GET 请求——**Fastify 的 hook 会泄漏到同一作用域下所有路由**，导致约会 `POST /scene/start` 和场景剧本 `POST /scene-scenario/:id/enter` 也被 403。用户报告「约会不能约会了，说旧剧本已归档」。

中间试了 `api.register()` 子作用域隔离也没生效（实际是端口冲突导致旧进程没杀干净，一直在跑旧代码）。

**最终方案**：去掉 addHook，逐个替换写操作路由的函数体为 `return reply.code(403).send(...)` stub。GET 路由不受影响。

### 验证

- 前端 `tsc --noEmit` 0 错误
- 旧剧本 POST/PATCH/DELETE → 403 ✓
- 约会 POST /scene/start → 正常业务逻辑（「地点不存在」）✓
- 场景剧本 POST /scene-scenario/:id/enter → 正常业务逻辑（「剧本不存在」）✓
- 回忆页场景剧本 API 返回正确数据（测试账号 16 条 date + 3 条 scenario，之前混在一起 19 条）

---

## 2026-08-10：记忆搜索三路分开 + 对话原文索引 + turn_overview 移出搜索

### 问题

玩家问"我喜欢什么味的沐浴露？"时角色答不上来。根因：`memory_embeddings` 表里 ~600 条 `turn_overview`（每轮覆盖写的累积总览）泛滥，它们提到"气味""洗漱"等泛词，和 query 语义距离比具体提到"白茶""蜜桃"的事实更近，把 top-5 全占满了。真正包含具体味道的 chronicle 排名 81-268，根本进不了上下文。

### 设计（星落拍板）

- **turn_overview 不进搜索**——它的历史版本存在 `scene_round_snapshots.overviews` 供撤回用，和搜索无关
- **搜索分三路**：约会摘要（chronicle + turn_date_summary）/ 玩家事实（fact + turn_player_fact）/ 对话原文（scene_message），分开搜分开返回，各 top-5
- **对话原文跨全部 session**，不限于当前对话
- **原文去掉旁白**——narration 不嵌入，只嵌 player + npc 消息（格式 `角色名：文本`）
- **每条结果带相对时间**——让 Gemma 能分辨"之前喜欢后来不喜欢了"等时间演进
- **player_facts 不再全量注入**——走搜索通道按相关性返回，不再整批堆进上下文

### 改动

**`embedding.ts`**：新增 `retrieveMemoriesMultiChannel`，SQL 加 `WHERE source_type != 'turn_overview'`，按 source_type 分三路各取 top-5，每条带 `formatRelativeTime`。旧 `retrieveMemories` 委托给它。

**`memory-wiring.ts`**：`buildActorMemories` 删掉 `getTurnPlayerFacts` 批量注入（事实现在走搜索通道），`retrieveTurnMemory` 调用不变（内部已委托三路搜索）。

**`scene-wiring.ts`**：`insertMsg` 后 fire-and-forget 调 `indexSceneMessage`——embed 消息文本存入 `memory_embeddings`（`source_type='scene_message'`）。player 消息归属当前约会主角色，npc 消息归属该角色。narration 不索引。embedding 不可用时静默降级不影响主流程。

**迁移脚本**（`src/scripts/migrate-scene-message-embeddings.ts`）：批量 embed 现有 scene_messages，幂等（`INSERT OR REPLACE`）。已跑完，9948 条历史对话原文全部嵌入。

**数据清理**：删除 897 条 `turn_overview` 历史向量（只留每对 player×character 最新1份）。注：删的是 `memory_embeddings` 里的向量，不是 overview 文本——overview 原文在 `scene_round_snapshots.overviews`（351条有内容）和 `turn_memory_fold`，撤回功能不受影响。

### 验证

搜"我喜欢什么味的沐浴露？"，三路结果：
- **玩家事实** #2：沐禾偏好白茶加蜜桃味的沐浴露（score=0.572, 08-10 19:49）
- **约会摘要** #2：玩家询问冷惊尘是否购买了沐浴露，得知其购买了檀香味…（score=0.533, 08-07 19:03）
- **对话原文** #2：沐浴露？（score=0.650, 08-10 20:25）

之前 700 条混搜 top-5 全是 turn_overview 抽象概述，具体味道排名 81-268。现在三路分开，每路都命中。

### source_type 分布（沐禾×冷惊尘）

| source_type | 数量 | 进搜索 |
|---|---|---|
| scene_message | 2111 | ✅ |
| chronicle | 302 | ✅ |
| turn_player_fact | 150 | ✅ |
| fact | 38 | ✅ |
| turn_overview | 1 | ❌ |
| moment | 19 | ❌ |
| turn_date_summary | 4 | ✅ |

### 文件索引
- `apps/server/src/lib/embedding.ts` — `retrieveMemoriesMultiChannel`
- `apps/server/src/lib/memory-wiring.ts` — `buildActorMemories`
- `apps/server/src/lib/scene-wiring.ts` — `indexSceneMessage` + `insertMsg` 调用
- `apps/server/src/scripts/migrate-scene-message-embeddings.ts` — 迁移脚本

---

## 2026-08-10：speechBubbles 过滤删除 + 跨轮复述检测 + 事实提取区分NPC指控 + 短信路径复述检测

### 1. speechBubbles 过滤删除（run-scene-turn.ts）

**问题**：DeepSeek 在 commit `fcc14db` 加了 `speechBubbles` 过滤——把"括号外无文本"的纯动作气泡当空气泡删掉。导致角色纯动作回复（如"（靠过来，摩挲手背）"）被过滤成空→丢弃→玩家看不到回复。星落明确："纯动作描写是合法回复，不是我的设计"。

**修复**：4处全部删除（导演版主循环~903、导演版兜底~976、点名版主循环~1322、点名版兜底~1441）。去重逻辑保留但 key 改用原文（raw-text dedup），两处兜底 intent 里"不要只是动作或沉默"去掉。

### 2. 跨轮复述检测（run-scene-turn.ts runActor）

**问题**：Gemma 在玩家连续发"嗯""好"等相似短消息时，逐字复述上一轮回复（一字不差）。`emittedThisRound` 去重只管同一轮内，不拦跨轮。

**修复**：`runActor` 返回前加跨轮检测——从 `conversationSoFar` 提取该角色最近3条发言，和本轮 `texts` 逐条比对（归一化后去标点空格括号，相似度≥0.8 判定复述）。命中则把重复的具体内容贴给模型重试2次（temperature 0.95→1.0），仍复述则保留原始输出。

### 3. prompt 加"不重复"原则（scene.actor.txt L58）

**问题**：prompt 里完全没有"不要重复之前说过的话"这条原则。

**修复**：scene.actor.txt 加 `【不重复】每次回应都是此刻新的反应——不要重复你之前说过的台词或动作描写，哪怕对方的话很相似。人不会两次做一模一样的事。`

### 4. 事实提取区分NPC指控（turn-memory.ts doFoldTurnSegment）

**问题**：事实提取器不区分"NPC说了什么"和"玩家做了什么"。冷惊尘（病娇偏执人设）指控沐禾"社交场合划清界限"→ 提取器存成关于沐禾的事实（6条）。Gemma 幻觉编造的沐浴露味道（柑橘/雨后森林）也被存成事实，形成"幻觉→持久化→再引用"闭环。

**修复**：
- **数据清洗**：删9条错误 `turn_player_facts`（3条幻觉味道+6条NPC指控当玩家事实）+ 对应8条 `memory_embeddings`。补1条正确事实：沐禾喜欢白茶加蜜桃味的沐浴露。
- **逻辑修改**：`turn-memory.ts` 事实提取 system prompt 加【关键区分】段："只提取玩家实际说出或做出的事实。角色对玩家的指控、猜测、误解不算玩家事实——例如${characterName}说'你在疏远我'不等于玩家真的在疏远。"

### 5. 短信路径复述检测（builder.ts generateReply + roleplay.system.txt）

**问题**：林溯在短信里逐字复述玩家的话（露露发"好不好嘛~"，林溯回复"好不好嘛~"）。场景路径有 `fixRepeatEcho` + 跨轮复述检测，但短信路径（`generateReply`）完全没有。

**修复**：
- **prompt**（roleplay.system.txt）：加【不重复、不模仿】原则——"不要逐字复述玩家的话，你可以回应对方的内容，但不要把对方的话原样或近义地说回去"
- **代码**（builder.ts generateReply）：加 `_isEchoingPlayer` 检测——NPC回复后检查是否逐字复述了玩家输入，是的话带提示重试一次（temperature 0.95），重试不再复述才采用

### 踩坑
- `loadPrompt` 有 Map 缓存，改 prompt 模板必须重启服务才生效
- 探索路径（SceneExplore）已改成纯选项模式（只有"继续逛逛"按钮，无文本输入），"好不好嘛~"是短信路径不是探索

---

## 2026-08-10：moment-scheduler 后台行程驱动

**需求**：NPC 行程变化触发的短信/朋友圈原来只在玩家打开短信列表时才触发（`checkEligibleOnline → checkScheduleChange`），玩家不在线时 NPC 的"生活感"消失。

**实现**：新增 `lib/moment-scheduler.ts`——后台定时器（5min 扫一次），遍历所有有好友关系的玩家，调 `checkScheduleChange`，让 NPC 行程短信/朋友圈不再依赖玩家在线。启动后延迟 30s 首次扫描（避免和在线检查撞车），`setInterval.unref()` 不阻止进程退出。
- 调用方：`index.ts` 启动时 `startMomentScheduler()`
- 约会结束后 60% 朋友圈（`scene-end.ts` 既有逻辑不变）
- 约会中的 NPC 仍被排除（`proactive.ts` 两处排除 SQL 不变）

**顺带修复**：清理已删除角色的孤儿朋友圈数据。

---

## 2026-08-09：P0-P3 全量审查修复（15+ commits）

来源：`1c1d0d2 review: 全量审查报告`。按优先级分四批落地：

**P0（数据安全）**：
- `d4f6e12` 多表删除操作加事务保护 + 补全遗漏表（删玩家时漏删 scene_* 系列表）
- `64dc70b` token 不再暴露在 URL query string（改 header）
- `fe588d2` requestStream 加 120s 超时保护（`AbortController`，防服务端 hang 时 `reader.read()` 永久挂起）

**P1（功能正确性）**：
- `8a4758d` migration 静默失败（`runMigrations` 没 catch → 失败无报错）+ embedding 主键碰撞 + fire-and-forget 未处理 Promise
- `78de124` upload 魔数校验（防非图片上传）+ LIKE 误删（DELETE 用了 LIKE 通配）+ greeting 回滚 + 私有角色所有权 + namer 人设
- `c77e68b` SmsApp 缓存覆盖 + ScenarioDream 无限重试 + MomentsApp 竞态

**P2（内存/资源）**：
- `122b930` 后端 P2 批量（内存泄漏、image_blobs 清理等）
- `7dae6f5` 前端 P2 批量

**P3（代码质量）**：
- `f992429` 删死函数 + 全局兜底 + 重复修复 + vite target
- `c86d709` scripts 目录 TS 零错误 + llm_call_log 24h 自动清理
- `967d1a7` requestStream 收到 SSE error 事件时正确 throw

---

## 2026-08-09：场景引擎测试套件

`114109d test: 场景引擎测试套件（65 tests, 1 expected red）`
- 覆盖点名版引擎核心路径：runSceneTurnNamed / namer / actor / narration / move / rollback
- 1 个 expected red = 已知待修的边界 case

---

## 2026-08-09：search 死代码清理 + 旧导演标注过时

`6dc5271 feat: 清理 search 死代码 + 旧导演标注过时 + 点名版注入 circumstance`

- **search 是死代码**：`action:search` 在点名版中无任何执行路径（记忆检索已由 `buildActorMemories` 每轮自动执行），删除：validateBeats 的 search 合法 type、SceneBeat.query 字段、run-scene-turn.ts 的 search 执行日志、scene.director.txt 的 search 定义和示例、scene.ts SSE director 预览的 query 字段。
- **旧导演标注过时**：`scene.director.txt` 头部加声明 + 与点名版功能差异说明（缺数值结算/导演全局视角/开场情境区分）。
- **点名版开场注入 circumstance**：开场旁白 build 注入 `loadGreetingSection(circumstance)` 情境描述（caught→被逮到 / approach→路过 / invite→赴约 等）。

---

## 2026-08-09：namer 多轮修复

namer（`pickNextSpeaker`）经历多次迭代，最终状态：

1. **`7e4793e` namer 不再用 convWithPlayer 追加玩家消息到末尾**——根因：每拍末尾都是玩家消息导致 namer 误判"玩家刚说完该角色回应"。改为：namer 传原始 `conversationSoFar`（纯历史，不含玩家最新话），只有 narration 传 `convWithPlayer`（需要看到玩家刚说了什么才能写旁白）。
2. **namer 候选去掉旁白**（`01cbfbc` → revert → `49aeffd` reapply）——防止旁白洗 lastSpeaker 导致角色循环不选玩家。最终保留：旁白不作为候选 speaker。
3. **spokenThisRound 替代 lastSpeaker**（`7d81285` → revert → 最终去掉）——角色本轮说完不再进候选，兜底直接结束还玩家。经历了 revert+reapply 波动，最终方案以当前代码为准。

> 注：这三条修复互相耦合，经历了多次 revert/reapply。核心原则：namer 只在角色中选下一个说话者，旁白和玩家都不进候选；兜底直接结束还玩家。

---

## 2026-08-09：复述开场检测 + LLM 改写

`60a11b8 feat: 复述开场检测+LLM改写`

**问题**：角色回复的首条气泡有时逐字复述玩家的话（如玩家说"我喜欢你"，角色回"（重复着'我喜欢你'这三个字）"）。

**方案**：程序检测 + LLM 改写（与 `fixXGeZi` 同模式，平时零开销——不复述不触发 LLM）：
- 检测：首条 bubble 括号前文本去标点、去"你我"后，连续 ≥3 字在玩家话中出现 → 命中
- 改写：调 LLM 用思维链分3类（复述内容 / 依附比喻 / 实际动作），删前两类保留第三类重新表述
- 位置：`run-scene-turn.ts` L580-591 + L670-693

---

## 2026-08-09：记忆检索 query 加入场景上下文

`9615e89 fix: 记忆检索 query 加入场景上下文（地点+活动），防止角色失忆`

- 原 query = 最后1轮对话上下文。加入当前地点名 + current_activity 后，检索召回更贴合当前场景。
- 对应 OPEN_QUESTIONS Q2（记忆检索 query 构造）：当前实现已从"最后1轮"升级为"最后1轮 + 场景上下文"。

---

## 2026-08-09：current_activity 字段

`09b9c70 feat: 新增 current_activity 字段` + `34e15a3 fix: current_activity 补全所有遗漏点`

**目的**：角色感知当前活动/目的，防止场景停滞（不知道在干什么）。

**位置**：`scene_relationships.current_activity`（不是 scene_sessions）——每个角色对玩家的关系记录里存当前活动，跨场延续。

**链路**：
- `scene.actor.txt`：【当前活动】节注入 `{{current_activity}}`，演员每拍可更新（不变也可以）
- `scene-wiring.ts`：读取 `scene_relationships.current_activity` 注入 actor context；落库时写回 `current_activity`（ON CONFLICT DO UPDATE）
- `scene-rollback.ts`：快照/恢复包含 current_activity（基线快照 + 轮快照都存）
- `run-scene-turn.ts`：ActorOut schema 加 `current_activity` 字段，normalize 校验

---

## 2026-08-09：半角括号混入全角 + sessionStorage 缓存

- `ab38401` 半角括号 `)` 混入全角 `）` 导致 `cleanStraySymbols` 游离右闭括号漏网——清洗逻辑扩展覆盖半角
- `3f67f49` 聊天页 sessionStorage 缓存（`sceneCacheKey(sessionId)`）——进入约会时即时恢复上次消息，不等网络；`cleanStraySymbols` 提取为独立模块 `apps/web/src/lib/clean-stray-symbols.ts`

---

## 2026-08-08：点名版引擎正式上线 + move 移到 actor + 转场旁白

### 点名版引擎上线

`fcc14db feat: 点名版引擎 + 代码审查修复 + 层级化地点移动` + `d7e490e docs: 点名版引擎设计文档`

- 设计文档：`docs/scene-director-rename-design.md`（已标注"已投产"）
- 核心变更：DB 开关切换引擎，前端 API 不变（仍走 `/scene/*` 路径，内部走快照选引擎）
- 层级化地点移动：地点有父子关系，move 只能在同层或子层中移动

### move 从 namer 移到 actor

`884a7c2 feat: move 从 namer 移到 actor` + `c4d3820 refactor: 地点导航从 namer 移到 actor`

- 原设计：namer（选人）决定是否 move → 角色只是执行
- 改后：actor（角色）自己带出移动意图（`move_to` 字段）→ 角色在台词里自然说"走吧""跟我来"
- `scene.actor.txt`：【地点导航】节 + `move_to` 字段说明。约束：仅当真的要带对方去另一个地方才填，填目标地点名；不能创建与当前地点无空间包含关系的地点。

### 转场旁白（三次迭代）

1. `79c1e1f` move 后转场旁白 + 开场环境旁白（初始版）
2. `88bce5a` 旁白改为主动插入而非兜底——开场旁白从兜底分支移到点名循环之前，作为第一拍主动插入
3. `5dfa0c9` 转场旁白加约束——本轮已有旁白则不追加
4. `d5a8a35` 约束改为——末尾是旁白就不追加（而非整轮有旁白就不追加）。避免旁白连旁白。

最终状态：move 后若 output 末尾不是旁白，则插入一段新地点的环境旁白。

### 字数指代约束

`e6e0b60 feat(prompt): 落地'X个字'字数指代约束(AB v12 验证 21%→4%)`

- 问题：角色用"这两个字""几个字"指代玩家刚说的话（如"重复着这两个字"），生硬不自然
- AB v12 验证：现状 21% → 加约束后 4%
- `scene.actor.txt` L57：【指代用语】不要用"X个字"来指代对方刚才说的话，需要提及时直接说"这句话""你刚才的话"
- 经历了一次 revert（`4ea7608` 撤回套话清洗与指代约束）后重新落地（`e6e0b60`）

---

## 2026-08-08：管理端地点切换到新地图

`e0c9c18` 管理端「地点」页签切换到新地图 `scene_locations`（原旧 `locations` 表不再用于管理端）
`9ca2ee7` 补回"隐藏私有地点"过滤开关
`3751d36` 前端"新地图"改名"地图"

---

## 次新（2026-08-08：点名版 player_message double-append 修复）

**现象**：LLM log id=10556（顾砚 actor 调用）中，玩家消息「露露：（笑着看着他们）首先你们一人喝一杯酒是少不了的，其次，一人脱一件衣服吧～」在输入末尾出现两次。排除重试（/retry 不传 playerMessage）和撤回（/undo 不触发 LLM 调用）后，确认是同一轮第二个角色拍。

**根因**：点名版 `runSceneTurnNamed`（run-scene-turn.ts）初始化 `conversationSoFar` 时把 `player_message` 追加到末尾（第 1052-1061 行旧代码），然后 `conversationSoFar` 被传给 `runActor`，而 `runActor` 内部（第 531-534 行）**又追加了一次** `player_message` → 同一条玩家话出现两次。

导演版（`runSceneTurn`）无此问题——它的 `conversationSoFar` 不追加 `player_message`。

**修复**：
- `conversationSoFar` 不再追加 `player_message`，保持纯历史
- 新增 `convWithPlayer(base)` 辅助函数，仅在传给 namer（`pickNextSpeaker`）和 narration（`runNarration`）时拼上玩家最新话——它们需要看到玩家刚说了什么才能正确选人/写旁白
- `runActor` 传原始 `conversationSoFar`——它自己会在 dialogTurns 末尾追加 `player_message`，不会重复

---

## 次新（2026-08-07：约会中禁止主动短信/朋友圈 —— 新老引擎排除）

**背景**：核查"旧地图是否还在生成行程、主动发短信/朋友圈"。结论——旧行程引擎已退役（`npc_schedules` 0 行、无写入点；`getBaseSchedule`/`getOverriddenSchedule` 无调用者），`getCurrentSchedule` 已统一委托新 `getSceneSchedule`（读 `scene_schedule_entries`）。主动行为引擎 `proactive.ts` 仍在跑（触发=玩家开短信列表轮询 GET threads），但其数据源已是新 scene 行程。

**修复**：约会中（无论新旧引擎）角色不得主动发短信/朋友圈。在 `lib/proactive.ts` 两处查询各加新场景约会排除（原只排除旧 `conversation_sessions`）：
- `checkScheduleChange`（行程变更→30%主动短信/20%发圈）
- `getEligibleNpcs`（eligible 意愿到点主动短信；`checkEligibleOfflineBacklog` 走它，离线积压自动受益）

排除 SQL 用 `json_each(scene_sessions.character_ids)` 匹配角色 + `ended=0`：
```sql
AND NOT EXISTS (
  SELECT 1 FROM scene_sessions ss, json_each(ss.character_ids) j
  WHERE ss.player_id = r.player_id AND j.value = r.character_id AND ss.ended = 0
)
```
已实测：test-p 玩家 2 个进行中约会 NPC 全被正确排除；server typecheck 过；后端已重启加载。注意：DB 里残留 21 个 `ended=0` 的场景会话（含 test-p/agent 测试数据），非当前活跃玩家，无影响。

---

## 次新（2026-08-07：玩家输入「（无语）被覆盖/重试跳句」根因与修复）

**现象**：用户报告在场景对话里输入「（无语）」被吞、"原本有被下一句替代"、按重试跳到上一句。

**排查（llm_call_log + scene_messages + 前端 SceneConversation.tsx）**：
- **DB/LLM 层干净**：所有「（无语）」输入都完整落库、LLM 正常回应（finish_reason=stop，SCENE_ROUND_CONFLICT 触发 0 次，无孤儿玩家消息）。字**没**被后端吞。
- **排除 handleRetry 裁剪数学 bug**：`slice(0, prev.length - lastPlayerIdx)` 在各类 line 结构下都正确保留到最后玩家句（已 python 模拟验证）。

**根因**：`SceneConversation.tsx` 的 `handleSend` catch 分支在 **SSE 流中断**（网络抖动/reader.read() reject/连接断开）时**盲目 `setLines(filter)` 删掉刚上屏的玩家行** + 把文字回填输入框。但**后端往往已成功落库**这句玩家发言 → UI 与 DB 失同步 → 玩家看到"原本有被移除"（=被覆盖）；此时点重试，`handleRetry` 靠 `reverse().findIndex(kind==='player')` 在 UI 里找不到这句（已被删）→ 裁到**上一条**玩家句 → "跳到上一句"。

**修复**：`handleSend` 的 catch 改为**先用 `api.sceneGet` 与后端对账**（学 `handleUndo` 的既有 sceneGet 模式）：若后端已落库则保留、未落库则自然消失并回填输入框，不再盲目删行。已过 web typecheck + HMR 200。

---

## 上一轮（2026-08-07：一拍多气泡方案A / 气泡节奏均匀 / 时间戳 / 改角色名加固 / LLM 调用日志）

完整记录 → `session-2026-08-07-bubbles-timing-rename-llmlog.md`（同目录），关键结论：
- **分气泡真因**：演员 schema 同时允许 `text`+`texts`，Gemma 偷懒走 `text` 单字段用空行假分段 → 方案 A **删 text 只留 texts 必填**（对齐旧版 messages 数组强制）。用户确认"分气泡了"✅
- **气泡节奏不均匀真因**：SSE requestStream 同一网络 chunk 的多个 beat 事件**并发派发没 await** → appendBeat 的 sleep 并行重叠睡完同时 setLines → 后几个气泡"啪"一起冒出。修复：`onEvent` 逐条 `await` + 节拍 300→600ms
- **时间戳**：=「气泡冒出来的时间」；历史用 created_at、新生成用上屏时间。`showRoundTime` 依赖 round_no 的坑=实时气泡没 round_no → 改依赖**真实时间差**（≥60s）
- **改角色名**：核心层全用 `character_id`（稳定）故不会失声/记忆错乱。唯一薄弱=前端 `idByName` 名字反查；已加固为 SSE beat 全程带 `characterId`
- **LLM 调用日志**：vLLM 侧不可行（需重启开 prompt logging 违反铁律）→ 应用侧 `llm_call_log` 表 + chat() 统一打点 + 1h 滑动清理 + call_type 标记

---

## v2 设计决策（源自记忆条目）

1. 邀请 1-2 好友：1 人走单聊，2 人走群聊
2. 掷骰不用 LLM
3. 偶遇概率 Math.random() < 0.3
4. 角色卡统一 character-card.txt
5. 动作描写省略主语
6. 剧本 NPC 不套角色、不复制副本，prompt 注入身份
7. location_homes 替代 home_of
8. 短信 greeting 异步
9. 多人剧本 = npc_roles 数组复用群聊
10. 剧本编辑器加多人勾选框；勾了多人隐藏 npc_role 字段；发布校验槽位 ≥2
11. speaker → 名字映射统一到 useChatMessages hook
12. NPC 只要不在任务中就一定在主城某个地点，不会随机消失。星落原话"他不在主城还能去哪"——世界一致性优先，删除了 5% 不在主城概率
13. 短信约会邀请条件 = 不在任务/约会中即可，不限地点

## v2 数据语义（源自记忆条目）

- v2 player_description = NPC 对玩家的感觉延续
- player_facts 表已存在但类型混在一起；星落反对加 category 字段
- 玩家行为："嗯" = 同意安排不是无聊；点"继续" = 还没轮到玩家反应

## v2 schema（源自记忆条目）

- 角色名在 character_data JSON 的 $.name（无独立 name 列）
- 消息表不对称：
  - messages: text / role / image_path / speaker
  - text_messages: body / sender / image_asset_id / 无 speaker
- 跨表函数必须按表选列名
- 详见 skill node-fullstack-app references/sqlite-column-alias-pitfall.md

## v2 DB 操作（源自记忆条目）

- 见 skill references/db-operations-without-downtime.md
- 速查：ESM 项目写 .mjs 到 /tmp/ 用 node 跑
- SQL 双引号是列标识符 → 用单引号或参数化
- 只读用 sqlite3 CLI

## v2 任务系统（源自记忆条目）

- 核心目的：打破单 NPC 聊到腻的循环
- 角色任务 = 可重复进入特殊约会，结束走 dream
- 设计文档：/output/infinite-date-v2/docs/MISSION_DESIGN.md
- v2 已上线多用户；线上 bug 说"急"时最高优先
- greeting prompt 始终让 NPC 做主动方（NPC 注意到玩家并开口，不是玩家走过来）；"搭话"是 UI 虚构叙事上 NPC 先开口
- recent fixes 见 skill references/

## v3 → v2 迁移设计（源自记忆条目）

- 设计文档：MIGRATION_DESIGN.md，细节见文档
- 三个新 app（地图=约会群聊探索 / 待办=任务 / 剧本=副本）独立并行渐进替代
- 能迁就迁，不能迁就只读；剧本/任务半成品→搁置
- 旧表完全替代后才删
- 两 app 地点各进各表，人工维护一致性
- 关系 = 纯自由文本，无数值无升级（对齐旧 relationships.player_description 每次 AI 覆盖）
- 路由 id/名字分离，新地点 uuid；路人带 id 归属发言人

## 新地图行程落库（源自 v2 星落"行程要存在数据库"）

- 需求：新地图(scene)行程生成完必须落库；LLM 改就改库，否则玩家问起对不上；按原生成逻辑，只是落库，随时可重新生成。仅新地图落库，旧 npc_schedules 不动。
- 表：scene_schedule_entries(player_id, character_id, day_key, location_id, location_name, activity, start_time, duration, is_llm_edited)。day_key=北京日期字符串，按 (player,char,day) 整删/整补。
- 机制：ensureSceneDay(player,cid,charData,dayKey) 用现有段推进逻辑生成当天 0:00→次日 0:00 完整段，INSERT OR IGNORE 落库（LLM 改的 is_llm_edited 段不覆盖）。getSceneSchedule/getSceneUpcomingSchedule 改为先 ensure 再读库。
- 作息：sleepWindowFor 接受 ptype 判定夜猫子（combat 15%/其他 5%）；夜猫子白天睡（基准6-13点加扰动），正常人晚上睡（21-1点睡 5-10点起）。hash 是 schedule.ts 的 murmur3 finalizer 版，复刻脚本要一模一样否则 hash 结果全错。

## 新地图探索 UI 重设计（星落 2026-08 要求）

- 进入探索后**不显示"这里的人"头像栏**。
- 界面：旁白区上移占顶部；下面是**一列"谁在这里做什么"**，每位在场角色一行，含：名字 + 正在做什么 + 「上前说话/靠近」按钮（点击进入这场正式约会）。
- 角色列表**下面**才是「继续逛逛」。
- **「描述你的行为」按钮去掉**（原探索输入框精简）。
- 语义：面对面能看到对方**正在做什么**（陌生人也能看，如"陌生人正在读书"），因为面对面了看得见才合理；但**不能看行程**（行程仍是好友专属）。
- 数据源：map/npcs 的 activity 字段即"正在做什么"；但当前代码对非好友把 activity 清空了（activity: friends ? schedule.activity : ''），需放开让陌生人也能拿到当前 activity。注意：不能因此泄露完整行程——getSceneUpcomingSchedule 仅好友可用，保持。

## "谁的家"探索语义（星落 2026-08 要求）

进入别人的家（`scene_homes` 有居民的 `scene_locations`）时，探索遵循以下约束：

- **谁的家，逛逛只能偶遇住在这里的人**——不会在别人家遇到无关路人。一址多居民都算（如顾家别墅=顾砚+顾珩）。`scene-explore.ts` 偶遇池从全角色收窄为该家所有居民。
- **家里不"捡东西"**（避免"跟偷东西一样"的违和）：家内探索只有旁白/偶遇两档，无物品档；即使 60% 旁白里 LLM 顺带标了物品，也一律按纯旁白呈现、不展示拾获、不落库。
- **被房主逮到 → 直接转特殊约会（没得选）**：
  - 在家逛久概率触发 `caught`（原 10% 物品档）。**直接自动进入约会**，不弹选择；进入后用户可正常退出。
  - `scene_start` body 带 `circumstance:'caught'`，存入 `scene_sessions.circumstance` 列（migration `scene_sessions_circumstance`）。
  - `buildSceneContext` 对 `circumstance==='caught'` 注入特殊 tone/rules + 情境旁白，开场白是"被房主逮到"的自然反应（惊讶/调侃/质问），不照搬普通约会寒暄。实测方知衡："在这个时间点出现在我的私人寓所，你应该有一份足以令我信服的解释。"
- 非家的人家附近探索保持正常（旁白/偶遇/物品三档）。

## 场景约会堆叠卷回（scene-date rollback，2026-08 星落要求）

**需求本质**：两种恢复级别共存——①撤回近期一两轮的垃圾（按轮回退），②整场约会删除（回到约会前）。用户验收线（星落原话）："只要保证记忆、玩家事实、一句话描述啥的都能回退就好了"（记忆=记忆、player_facts=玩家事实、描述=一句话描述）。用户原话"不需要存太多快照，就存五轮十轮的就好"。

**核心设计：基线 + 滚动窗口 两层快照，删行 vs 覆盖写分离。**

- **基线快照 `scene_start_snapshot`**：1 行 / 场，约会开始时（第一轮前）拍一次。只存会**跨场被覆盖写**的值 = 参与角色的 `scene_relationships.player_description`（唯一的跨场累积值）+ 起始 stats_state。`INSERT ... ON CONFLICT DO NOTHING`（只拍一次）。
- **轮快照 `scene_round_snapshots`**：每轮 LLM 开跑**前**拍一份本轮之前的累积态，保留最近 `MAX_ROUND_SNAPSHOTS=10` 份（滚动淘汰最旧）。存本轮前在约内**被覆盖写**的累积值 = stats_state + relationships + overviews（长期总览原文）。

**删行 vs 恢复（关键拆分）**：
- **追加型记忆 → 删行**：`scene_messages`（round_no）、`turn_memory_fold` 的 segment/date_summary（round_no）、`turn_player_facts`（round_no）都带轮号，`DELETE ... round_no >= targetRound` 或整场 `DELETE WHERE scene_session_id=？` 即可。
- **覆盖写累积值 → 从快照恢复**：stats_state、scene_relationships.player_description、`turn_memory_fold` 的 overview。

**统一入口**：`rollbackScene(playerId, sessionId, targetRound)`——`targetRound=0` 整场删除（恢复基线+删光本场一切）；`>0` 按轮撤回（恢复对应轮快照累积值+删该轮起追加型记忆）。调用方（undo/retry 路由）不用知道背后是删还是快照。

**路由接入**：
- 快照拍摄点在 `advanceScene`（scene-wiring.ts）：每轮 LLM 前 `captureRoundSnapshot(player, sid, session.round_no+1)`；首轮(round 0)额外 `captureStartSnapshot`。轮快照**幂等**（先删同轮再插，retry 重开同轮不重复）。
- `POST /scene/:id/undo`：找玩家最后发言所在轮 → `rollbackScene(targetRound=该轮)` → 记忆/事实/描述/统计一起回退。
- `POST /scene/:id/retry`：回退到最后一个非玩家回复轮开始前（`rollbackScene(targetRound=该轮)`）+ 重新 `advanceScene` 生成。保留该轮玩家发言作上下文。
- 两路由响应仍 `{ ok, round }`（兼容前端）。

**踩坑/必须知道**：
- `memory_embeddings` **无 `scene_session_id` 列** → 删向量必须走 `source_id IN (...)`（先收集本场所有 segment/fact/overview id）。
- **do NOT 每轮全量快照记忆**：记忆基本追加型（带轮号可删行），只有 overview 是覆盖写需快照；全量快照 = O(N²) 存储 + 吞掉异步迟到 fold。
- **孤儿向量 bug**：按轮恢复 overview 时，旧 overview fold 行删了但它的 embedding（按旧 id 存）会泄漏成孤儿向量 → 必须**先删旧 overview 的 embedding 再重建**。已修。
- **异步 fold 竞态**：`turn-memory.ts` 的 fold 是 `sync:false` + `inflight` map，可能晚于 rollback 落库再污染——设计上需 epoch 守卫（`rollback_epoch` 计数器；当前实现以"即时删除"为主，异步迟到 fold 仍是要注意的残留风险点）。
- 不碰旧表/旧服务（messages/chronicles/player_facts 老渠道不动）。

**实现文件**：`apps/server/src/lib/scene-rollback.ts`（新模块，纯新增）；测试 `apps/server/src/scripts/test-scene-rollback.ts`（跑在 DB 临时副本 `IDATE_DATA_DIR`，不污染线上；25 项断言覆盖 按轮/整场/滚动上限/幂等/孤儿向量）。DB 已备份 `/output/infinite-date-v2/db-backups/pre-rollback-*.sqlite`。



## 新地图邀请功能（2026-08-06）
- **后端基线**：`POST /scene/start` 已支持任意 `characterIds` 数组 + 任意 `circumstance`（scene-wiring/subscription 不限制人数）。新场景引擎的导演按「同行者列表」编排多角色群聊、角色可互相反应。
- **开场情境**：`scene.greeting.txt` 新增 `[invite]`（玩家主动邀请，对方知道是应邀而来）和 `[deity_pick]`（主神随机抽中传送来，对方莫名其妙）两节；`scene-wiring.ts` 的 `buildSceneContext` 为这两个 cite 加了 tone 定制。已验证真实 LLM 开场语义正确。
- **前端**：`apps/web/src/pages/SceneLocation.tsx` 新增 `InviteModal` 组件（替换了原先只取第一个好友的 stub）：
  - 不限人数好友列表：空列表 → 选择好友（可搜索）→ 加入列表 → 可删除 → 下一行继续挑。
  - 「伪装成随机抽选开场」勾选：不勾=invite（正常邀请），勾上=deity_pick（伪装主神抽选，与旧版一致）。
  - 样式类名 `id-invite-*` 在 `index.css`；复用了 `id-deity-pick-toggle` 开关样式。
- **注意**：改 `scene.greeting.txt` / `scene-wiring.ts` 后需重启后端（loadPrompt Map 缓存）。邀请数据源是 `friendships` 表(active)。

## 短信邀请迁移到新场景约会（2026-08-06）
- **问题**：短信里收到的约会邀请卡片（SmsApp `handleAcceptInvite`）点接受后走 `api.startConversation` → 旧 `conversation_sessions`，与新场景约会（scene_sessions）割裂。
- **语义澄清**：短信邀请卡片是**角色（NPC）主动邀请玩家**去ta的地点赴会（非玩家邀请角色）——所以不用现有 `invite`（玩家邀请角色）情境。
- **迁移**：`SmsApp.handleAcceptInvite` 改为调 `api.sceneStart({ locationId: invite.locationId, characterIds: [characterId], circumstance: 'npc_invite' })` + 导航 `{ type:'scene-conversation', sessionId }`。
- **新增 `[npc_invite]` 情境节**：`scene.greeting.txt` 新增 `[npc_invite]`（{{companions}}主动邀请玩家，玩家是被邀请方）；`scene-wiring.ts` `buildSceneContext` 为 `npc_invite` 加 tone 定制。改模板/scene-wiring 后需重启后端。
- 旧 `startConversation` 仍被旧地图 LocationDetail.tsx 使用，保留不动。

## 一拍多气泡（2026-08-06 星落纠正）
- **问题**：`scene.actor.txt` L53 把话说死成「默认一拍只给一个气泡」——把模型往单气泡上推，违背"一拍可多气泡"的既定设计（run-scene-turn L566-613 的 `texts[]` 本就支持逐条输出多气泡、前端 SSE 一拍多气泡也通）。
- **修复**：模板 L53 改为「**一拍可以输出多个气泡**」——这一拍回应可分几口气说出层次不同的内容，逐条放进 texts，各自承接递进；但仍要求每条都是真话了话、动作附在话里、禁止动作碎片气泡；多条须递进/不同不重复。
- **顺带**：演员 maxTokens 260→1200→**4096**（260 是初始提交写死的无注释值，远小于导演的 1200；旧仪式 conversation 角色也用 1024）。导演 maxTokens 1200→**4096**、旁白 200→**4096**。adapter 用 `MAX_MODEL_LEN(16384)-32-prompt` 的 budget 兜底防溢出（`min(req, budget)`），所以 4096 是"请求上限"，非流式下模型生到 EOS 提前停、按需取用。
- **JSON 泄漏修复（星落："先解析json确保字段对上，对不上就重新调用llm，所有带json的llm都要用，至少新版"，最优先防用户看到json）**：
  - adapter 新增通用 **`chatJson<T>(messages,{schema,temperature,maxTokens,maxRetries,normalize,retryHint})`**：调 chat(guidedJson) → tryParseJsonReply 剥围栏 parse → `normalize` 逐字段校验（返回 null 触发重试）→ 失败带「格式不对」提示重试（默认2次）→ 仍失败返回 null。**绝不把残缺 JSON/```json/字段名透传用户**。
  - **runActor** 改用 `chatJson` + `normalizeActorOut`（texts 非空 string 数组/text 非空 string + player_description/internal 须 string + internal_notable 须 boolean），maxRetries:2 共3次。
  ## 旁白定位收敛（2026-08-06，已A/B验证 + 写入）
- **旁白 = 电影里"这一下镜头想拍"的瞬间**，只在四类瞬间才排：①有变化在发生（世界动 / 角色心里动了没说出口→环境是内心镜子：不开心就落雨、光线变暗）②当下一瞬"活"得有质感（正在发生的贴着人的瞬间）③对话到头需带开（转场造新话题）④对话尴尬/冷场时**顶替路人递话头**（没有路人可接场的场景尤其——凭空冒一件当下小东西打破尴尬，不替角色说话）。**其余不排**，一整轮纯对话无旁白是正常且更好的。
- **无固定意象铁律已去掉**（星落判断：Gemma 分不清好赖话，越禁止越对着干→负面禁令反效果）。只留一句**正向**引导："景物由此刻此地现取，不雕琢成美文"。星落亲身经历 AI 乙游男主天天飘枫叶（固定特效病）——意象必须现取，但写进 prompt 用正向句而非"不许用X"。
- **UI 经验**：给 LLM 举具体意象例子（叶子/萤火虫/夜鸟）会被当模板反复用→只讲类型不举具体例子。
- 已写入：scene.director.txt（narration 四类定位）、run-scene-turn.ts runNarration system（四类+正向一句）。actor 模板不动（星落确认角色已"活过来"）。

## scene-explore genNarration 改用 `chatJson` + normalize 校验 narration 非空 string。
    - **待迁移**：turn-memory.ts（summary）；旧系统（explore.ts/scenario/moments/mission/creation/memory）。

  ## 角色"死了"根因 + 去导演化（2026-08-06 星落核心方向）
  - **现象**：白景安 r36→r37 连续两轮输出**逐字相同的整段台词**（玩家输入完全不同:一句长话 vs 一个"叹气"）。DB 确认是两条不同 round 的真实重复，非前端/非重试。
  - **根因（星落洞察："角色就像个蹩脚的演员""以前没导演时聊得很好"）**：新版 runActor 把**对话历史压成 system 里一段平铺文本**，最后一条 user 是"请输出你的这一句表演"而非玩家真实发言 → 模型失去"轮流对话"的结构感与"接住玩家刚说"的驱动力，变成"照着导演意图演一句"的提线木偶 → 机械复述、无灵性。
  - **旧版 generateReply（roleplay.system.txt）对比**：buildMessages 用**真实 user/assistant 交替轮次**喂历史 + 最后接玩家当前发言，角色作为 assistant 续写 → 有灵性、长动描、自然分段。
  - **修复（星落拍板："system 写人设+接下来你要做什么，别的都是真实对话"）**：
    - runActor: system 只渲染人设+beat_intent（去掉了 conversation_so_far 进 system）；对话历史按 `名字：话` **重建为真实的 user(玩家)/assistant(其余+旁白) 轮次**（连续同 role 合并），末尾注入"轮到你对玩家回应"nudge，模型作为下一位 assistant 续写。
    - SceneTurnInput.scene 新增 `player_name`（scene-wiring 传入），runActor 靠它区分玩家行。
    - scene.actor.txt 重写为轻 system：人设 + 【接下来这一下你可以朝这个方向走】(beat_intent, 明确"怎么说/分段/动描由你拿捏")，删掉"只演这一句"框子与大量"别做X"规则；保留一拍多气泡 + 长动描鼓励。
  - **NOTE**：改 scene.actor.txt / run-scene-turn.ts / scene-wiring.ts / scene-explore.ts 后须重启 server（loadPrompt Map 缓存）。
- 注意：改 `scene.actor.txt` / `run-scene-turn.ts` / `scene-explore.ts` 后需重启后端（loadPrompt Map 缓存）。

## 2026-08-07 新约会系统心声修复
- 背景：新约会(场景引擎v2)的 `scene_messages` 表建表时没有 `internal`/`internal_notable` 字段 → 生成侧(run-scene-turn ActorOut)有心声、但落库(scene-wiring insertMsg)和查询(GET /scene/:id)都丢，前端 ⚡心声 按钮不出现。
- 修复：
  1. scene_messages 加两列(ALTER + CREATE TABLE 定义)：internal TEXT DEFAULT ''、internal_notable BOOLEAN DEFAULT 0
  2. scene-wiring.ts insertMsg 写入 internal/internal_notable（player/narration 写空）
  3. scene.ts GET /scene/:id 的 SELECT 带出两列；SSE onBeat(advance/continue/retry 三处)透传 internal/internalNotable
  4. run-scene-turn.ts 一拍多气泡时心声只挂第一个气泡(bi===0，其余清空)——避免重复
  5. 前端 SceneConversation.tsx：Line 加 internal/internalNotable、toLine/appendBeat 映射、渲染 ⚡心声 按钮(css id-internal-btn 共享已有)
  6. api.ts 类型更新(sceneAdvanceStream/sceneContinueStream onBeat、sceneGet messages、SceneBeat)
- 验证：真实 LLM advance 后，SSE 流 + DB + GET 三条路都带回 internal；第一气泡 internal_notable=1，续气泡=0。全链路通。
- 历史旧数据(改前落库的)没存 internal，补不回来，只新生成的恢复。
- v1(/output/infinite-date)与v3(/output/infinite-date-v3+zip)已删；v3设计文档归档到 /output/infinite-date-v2/docs/v3-archive/。唯一在用 = v2。

## 2026-08-07 segments 结构化改造失败教训（模型兼容性测试必须贴生产）
- **目标**：治演员输出「游离括号」（模型偶发漏闭合 `）`）。方案：把 actor 输出的 texts（括号手写）改成结构化 segments（外层数组=一拍多气泡，内层 action/speech 有序交替），后端拼接回括号、括号由代码生成 → 结构可校验。
- **做法**：改 scene.actor.txt【输出】+ run-scene-turn.ts 的 ACTOR_JSON_SCHEMA（嵌套数组）+ normalizeActorOut（校验+拼回）。语义 100% 沿用 A（话为主体、动作神态穿插、每条至少真说话），只把「用中文括号」换成「用JSON字段」。
- **单元测试通过**（复用生产 normalize 7/7：一拍多气泡、动作-语言-动作、纯动作拒绝、空结构拒绝、括号由代码生成）。e2e 也通过（5/5 命中）。
- **上线翻车**：真实负载下 actor **6/9 finish=length（out=4096 撞满 maxTokens 截断）**，角色频繁收不到回复。根因：嵌套 segments schema + vLLM guided_json(json_schema) 约束下，Gemma 无法稳定闭合复杂嵌套 JSON，产生大量空白缩进填充→撑爆 4096→JSON 截断→parse 失败→重试→还是 length→无回复。对比旧扁平 texts schema：改造前 8/8 stop，改造后 6/9 length。
- **为什么测试没发现（关键盲区，复盘）**：
  1. **maxTokens 不一致**：测试设 600/900/1024，生产 actor 写死 **4096**。截断发生在 out=4096，测试根本没到那个边界。
  2. **输入规模差量级**：测试用单轮短输入，生产真实输入 5445~10932 token 长上下文 + 一拍多气泡。长上下文 + 引导连续输出多个嵌套气泡数组，才是把 guided_json 逼到「无效缩进填充→撑爆 4096」的重负载条件。
  3. **次数少、概率性触发**：测试几十次 vs 生产一次会话上百次。6/9 的截断率在量大时才必然撞上。
- **结论/铁律**：模型兼容性测试必须**贴着生产跑**——同样的 maxTokens(4096)、同样的真实长输入（不缩水/不伪造）、同样的多气泡结构 + 足够次数（几十次）。低压路测通过 ≠ 满载可跑；低压通过→高压翻车是反向假阳性。呼应原有铁律「AB测试须真跑给证据、别自造样本」——这次用了真实输入但缩水了 maxTokens 和输入长度，等于没贴住工况。
- **处置**：已回滚（git checkout 复原 scene.actor.txt + run-scene-turn.ts 到旧 texts schema），重启后 actor 恢复 stop 正常输出。游离括号仍是偶发问题，后续若要再治，务必避开「嵌套JSON+guided_json」这条对 Gemma 不兼容的路（考虑：压平 schema、或引导模型不手写括号而用简单标记位、或在适配层清洗），且必须先贴生产满载测。
- 备份：改造期间的文件在 /output/infinite-date-v2/docs/segments_rollback_20260807_131447/（含 scene.actor.txt / run-scene-turn.ts / ab-struct-action.ts），已 git 回滚不需要了，可删。

## 2026-08-07 图片迁库（image_blobs）审查 → 发现并修复 adapter 读取遗漏
- **本次新修改**：图片二进制从 `data/uploads/` 磁盘迁入 `image_blobs` 表（防文件散失）。改动：schema.ts 建表、upload.ts 写 DB、image.ts 从 DB 读给 `<img>`、character.ts 加 `safeAvatar()` 兜底、admin NpcPanel 头像从 DB 读、scene 地图头像经 safeAvatar。
- **审查发现 🔴**：`llm/adapter.ts buildApiMessages()`（把带 `imagePath` 的消息转 base64 喂给 vLLM 的统一通道，聊天/朋友圈评论都走它）**仍在从磁盘 `config.uploadsDir` readFileSync**。但 upload.ts 已只写 DB 不写磁盘 → 新上传的图磁盘上不存在 → 降级为"图片加载失败"纯文本，**聊天/朋友圈发图给 LLM 理解的功能整体损坏**。迁移改了读展示路径（image.ts）却漏了读 LLM 路径（adapter.ts）。
- **修复**：adapter.ts `buildApiMessages` 改从 `image_blobs` 表 SELECT data+mimetype，保留失败降级。主线 tsc 0 错。**需重启后端才生效**（服务是 `tsx src/index.ts` 非 watch）。
- **存量裂图**：迁移前就有 5 个角色头像（a95543.../6efacc... 等 5 个 png）在 DB 被引用但磁盘+DB 都无——是迁移前文件已散失的历史遗留，`safeAvatar` 兜底为首字头像，非本次引入。
- **铁律沉淀**：迁移存储位置（磁盘→DB）时，务必 grep 所有读取点，不只改展示路径——LLM 喂图路径（adapter.buildApiMessages）是与展示路径（image.ts）并列的第二个读取点，漏改一处=半套系统坏。
- **快闪重启实录（8/7）**：后端进程树 = bash(启动wrapper)→npm run start→sh tsx→tsx loader→node(监听3000)。杀后端的正确姿势：`kill <tsx主pid> <实际监听node pid> <npm pid>`（SIGTERM 给 bash wrapper 无效）。重启用 `cd apps/server && npm run start`（Hermes background=true 托管）；健康检查 `curl 127.0.0.1:3000/health`。前端 vite(8080/8081) 独立不要动。别动 8000(vLLM)/8001。

## 2026-08-07 心声「该死」复发 → AB v10 根治（含小样本骗人教训）
- **现象**：重启后生产 5 条 actor 记录 3 条心声(internal)以「该死的/该死，」起手（4485/4489/4501，同一约会连崩）。台词 0 处该死（禁令管住了），心声全中。
- **查历史心声**：模型看得到吗？→ 看不到。`scene-wiring.ts:234` 历史拼接 SQL 只取 `role, character_name, character_id, text`，**不取 internal 列**。历史心声从不进 prompt。且全 35 条 messages 里唯一含「该死」的就是禁令本身。
- **早期误判**：一度怀疑「提词即钩子」（禁令点名该死反而勾出心声该死）。**AB 证明错**：删禁令(B)心声该死率反而升到 3/6，点名禁令是有效的，不是钩子。
- **小样本骗人教训（关键方法论）**：v9 用 4501 完整原始 messages 重放 6 次，A 现状 0/6 干净 → 误判"现状没事"。v10 大样本 20 次才看清：**A 现状心声该死率其实是 35%（7/20）**。之前 5-6 次抽到干净区纯属样本太小。**单拍小样本总会骗人，必须贴生产输入 + 够大样本（≥20）再下结论**。v8 还因 buildSystem 重造 system 丢失 chronicle/记忆强刺激复现不出。
- **根治（C 方案落地，commit cda7d2d）**：双管 = 保留开头点名禁令 + internal 字段描述加「不要用感叹词或脏话开头，直接写感受本身」。AB v10 决定性：A 心声该死 7/20 → C **0/20**（台词也 1/20→0/20）。scene.actor + roleplay.system 两处 internal 描述同步加（覆盖实景约会+短信路径）。已重启生效。
- **复现方法沉淀**：`llm_call_log` 存了完整 `messages_json`（原始输入）+ `raw_response`，可直接贴生产重放。AB 脚本：`src/scripts/ab-v10-internal.ts`。
