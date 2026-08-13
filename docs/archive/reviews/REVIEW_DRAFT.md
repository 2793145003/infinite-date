# infinite-date-v2 代码与文档全面审查报告（最终版）

> 日期：2026-08-06 ｜ 审查方式：核心场景引擎深度细读 + 三路并行子审查 + 直接查线上库实证 + 关键发现亲自复核
> 覆盖：server（约18K行TS，全部路由+lib）+ web（约12K行TS，SSE协议+页面）+ 全部设计文档 + 未提交改动（约1300行场景引擎）
> 验证基础：`tsc --noEmit` 干净 ｜ rollback 测试 25/25 通过 ｜ 服务全程未停
> 修复进度：P1 全部四项目已修复并验证 ✅（孤儿/越权×2/事务）｜旁白去重 + LLM JSON 健壮性已修复 ✅｜新地图约会前端体验 ×3 已修复 ✅｜现场全局互斥「人只有一个」已修复 ✅｜详见下方

---

## ✅ 已实证的通过项

| 项 | 结论 |
|---|---|
| **场景引擎核心质量** | 三层记忆折叠（热窗/中期/长期总览）、回滚时「场景消息+segment折叠+玩家事实+对应向量」全链联删、快照恢复累积值、undo/retry round 语义——逻辑自洽，设计严谨 |
| **SQL 注入** | 全部参数化或白名单控制，**无可用注入点**（三路委派一致确认） |
| **场景路由权限** | `scene_locations` is_public/owner 过滤、约会归属校验、加好友须角色在场，均完备 |
| **前后端 SSE 协议** | beat/director/done 事件流匹配 |
| **prompt 模板** | loadPrompt 缓存、greeting 分节、时间纪律 — 严谨 |

---

## 🔴 P1 — 必须修（数据正确性/越权）｜✅ 全部已修复

### 1. 三条删除路径全部遗漏新场景引擎表 → 孤儿数据（✅实证已定位，✅已根治）
线上库 `scene_relationships` **曾存在1条孤儿**（character_id=810daa07"小周"，角色及所属 session 均已不存在，**已清理、当前孤儿=0**）。

**精确机制（已核清，避免误判）：**
- **作者创作的角色有解绑保护**：`characters.creator_player_id`（schema.ts:96）、`character_player_data.source_character_id`（schema.ts:266）均为 `ON DELETE SET NULL` → 作者删号时角色**保留并解绑**，不会被连坐删除。用户记忆中的"解绑"真实存在。
- **真孤儿来源是场景引擎的临场路人**：常驻路人存在 `scene_locations.npcs` JSON，不占 characters 表；`scene-wiring.ts` 关系写入不区分角色类型，会把路人的 character_id 也写进 `scene_relationships`（`player_description="常驻在此的熟面孔"` 即路人固定文案）。而 `scene_relationships.character_id` 是**无外键裸 TEXT**（scene-session.ts:58），删除流程（admin.ts:188-206 只清旧表）**完全没有 scene_* 清理** → 路人/会话消失后该行成孤儿。

**✅ 已修复（2026-08-06）：`scene-wiring.ts` 关系写入新增 `!npcById.has(actor.characterId)` 判断——跳过常驻路人，只给正式角色写关系。从写入源头根治路人孤儿。**

**✅ 三条删除路径已全部补齐清理（2026-08-06）：**
- **玩家自删** `player.ts:103-108`：tables 清单追加 scene_sessions / scene_relationships / scene_schedule_entries / turn_memory_fold / turn_player_facts（scene_messages/snapshots 随 scene_sessions 级联清）
- **admin 删公共NPC** `admin.ts:206-210`：补 scene_relationships / scene_schedule_entries / turn_memory_fold / turn_player_facts（不动玩家的 scene_sessions 约会记录——历史回忆保留）
- **admin 删玩家** `admin.ts:387`：补 scene_schedule_entries（其 player_id 无FK；其余新表经 `DELETE FROM players` 的 FK CASCADE 自动清）
- **删好友** `me.ts:125`：原本就完整覆盖 scene_relationships（玩家日常路径，本就干净）

**P1-1 判定：✅ 彻底清零。** 当前孤儿=0；写入侧不产生新路人孤儿；四条删除路径（自删/删NPC/删玩家/删好友）全部覆盖新场景表。

### 2. explore.ts 探索地点未过滤 is_public（越权，✅已修复）
`explore.ts` 探索地点查询 L147-153 **已加** `AND (is_public = 1 OR (creator_type = 'player' AND creator_id = ?))`。之前只查 `character_instance_id IS NULL`，漏 is_public，玩家可凭 locationId 进入他人私有地点；现只允许公开地点或自己创建的地点，他人私有地点 404。

### 3. 私有角色 IDOR 越权读取（✅已修复）
`character.ts` `/characters/:id/edit` **已加归属校验**：公共角色（在 characters 表）任何人可读；私有角色必须是当前玩家自己的（`AND player_id = ?`），否则 403「无权访问该角色」。之前只鉴权「登录」，拿到 UUID 可读他人完整角色卡。

### 4. 场景推进无事务 + 无乐观锁（✅已修复）
`scene-wiring.ts` `advanceScene` **已包事务+乐观锁**：
- 整段同步落库（玩家消息/NPC消息/move+location/stats/关系写入）用 `db.exec('BEGIN')`+`COMMIT` 包裹，任何一步失败 `ROLLBACK` 整体回退——根治"半落库"（消息已写、round_no 未+1 的中间态）
- 事务开头乐观锁 `UPDATE scene_sessions SET round_no=? WHERE id=? AND round_no=?`：并发回合已推进（changes=0）→ ROLLBACK 抛 `SCENE_ROUND_CONFLICT`——杜绝两批写同一起跑线
- 删除原散落冗余的第二个 round_no UPDATE，统一由乐观锁推进
- 记忆折叠（sync:false fire-and-forget）在同步单线程下晚于 COMMIT 写库，不污染事务
- rollback 测试 25/25 通过，既有行为无破坏

---

## 🔵 P1.5 — 本轮新增修复（2026-08-06，均✅已验证）

### 5. 旁白重复（✅已修复）
**根因**：`run-scene-turn.ts` 角色台词（character）有完整三重去重（去动作/本轮去重/相邻去重），但**旁白（narration）拍无任何代码层去重**，只靠 prompt 软约束 → LLM 对同一地点反复用同一句环境印象脑补，代码不拦。
**修复**：
- 新增 `emittedNarrationThisRound` 集合，**预提取历史已出现旁白**（防跨轮，兼容 `（旁白）X`/`（旁白：X）`/`（一段环境旁白：“X”）` 三种落库格式，归一化去动作/去标点）＋ 本轮内查重（防同轮多旁白拍互重）
- 命中历史/本轮已用 → 丢弃该旁白拍（`continue`，不产出不推送）
- **边界（用户确认）**：重试场景 rollback 已删旧旁白 → 旧的不会"同时出现"；本轮内重复被 `emittedNarrationThisRound` 拦 → 满足"不能同时出现"诉求。**验证**：retry 后同轮两同句旁白 → 第2个被拦，仅展示1句。

### 6. LLM JSON 健壮性（✅已修复）
- **B-1 长度对齐**：`adapter.ts` `MAX_MODEL_LEN` 默认 8192 → **16384**（对齐 vLLM gemma-4-26b 实际 `max_model_len`）。此前代码按 8192 算输出预算，只用了模型一半能力，长对话过早压缩输出 → 截断。
- **B-2 截断检测**：`chat()` 返回新增 `truncated`（= `finish_reason==='length'`）；导演截断→带"大幅精简"提示重试；演员/旁白截断→丢弃该拍，**不再把残缺 JSON 当台词吐乱码**（旧行为罪魁）。
- **生成约束**：演员 `runActor` 加 `guidedJson: ACTOR_JSON_SCHEMA`（vLLM `response_format: json_schema` 强制合法 JSON），**实测**返回干净可 parse 对象（finish=stop）。
- **JSON 校验**：新增 `validateActorOut` 结构校验（parse 后 defensive 处置字段类型）；导演已有 `validateBeats`（kind/speaker/玩家禁止/action字段/fn/args.delta/intent 完整校验 + 带错重试）。
- **导演不加 guidedJson（有据）**：实测可辨识联合 schema 在 vLLM 诱导内容堆砌、`finish: length` 高频截断，负收益；导演保持自由 JSON + validateBeats 强校验 + 截断重试。
- 验证：编译干净；actor guidedJson real 调用成功；**rollback 测试 25/25 通过**（未破坏既有行为）。

### 7. 新地图约会前端体验 ×3（✅已修复）
`SceneConversation.tsx`（新地图约会聊天界面）：
- **① 刷新定位最新**：原 `scrollIntoView({behavior:'smooth'})` 平滑滚动 → 视觉上"从头往下滚"；改为直接操作消息容器 `scrollTop = scrollHeight`（瞬时钉到底），刷新/进页面立即显示最新，无滚动动画。
- **② 输入栏缓存**：每次输入即写 `localStorage`（key=`sc-conv-draft-{sessionId}` 按会话隔离）；挂载时从 storage 恢复草稿；发送成功清空。切页/刷新回来自动恢复输入，不必重打。
- **③ 发送失败不丢输入**：原失败只删玩家行、输入框已清空 → 玩家重打；改为失败时移除上屏玩家行 + `setInput(text)` 把消息放回输入框，玩家直接重发。采用"消息留输入框直发"方案（备选"红叹号点击重发"未选）。
- 验证：`tsc --noEmit` 干净；vite(8080) HMR 自动热更新即时生效；服务全程未停。

### 8. 现场全局互斥「人只有一个」（✅已修复）
设计哲学：玩家同一时刻只能"在场"于一个玩法现场——新约会/群约/旧约会/群聊/剧本/旧探索/任务互斥；短信/朋友圈/邮件是异步渠道不参与；**新探索（scene-explore 纯内存一次性临时场景）不算现场**。
- **问题**：原各入口互斥检查各自为政且不一致（场景约会 `/scene/start` 甚至完全无检查、剧本伤不了新约会、新旧约会可分身），并发下能同时开多场。这是"打补丁不可持续"的典型——5 套引擎各写各的互斥。
- **统一工具**：`session-mutex.ts` 新增 `getActiveLiveSlot(playerId)`（按优先级查 scene_sessions / conversation_sessions / explore_sessions / scenario_sessions / missions 五类现场，返回 `LiveSlot{type,id}`）+ `endLiveSlot()`。新探索纯内存不落库，天然在此列之外。
- **接入 5 个创建入口**：`/scene/start`（新约会）、`/sessions`（旧约会）、`/sessions/group`（群聊）、`/explore`（旧探索）、`/scenarios/:id/enter`（剧本）、mission —— 全部返回 `409 + { error:'已有进行中的现场', live }`。
- **前端全局弹窗**：`api.ts` `request` 捕获 409+live → 触发全局 `LiveConflictModal`（App 顶层挂载）→ 弹「已有进行中的[类型]」：**继续**（`navigateToLive` 按 live.type 导航到对应界面，复用桌面小组件/剧本进入逻辑）/ **结束并进入新的**（调对应 `end*` 后端接口结束原现场，再用 `api.fetchRaw` 重试原创建请求）。调用方 catch 到 `LIVE_CONFLICT` 静默（`isLiveConflictError`），不显示红条。
- 新组件：`components/LiveConflictModal.tsx`、`lib/live-conflict.ts`（事件总线）。
- 验证：后端 409+live 实测通过（scene/start、sessions/group 均正确返回）；前后端 `tsc --noEmit` 干净；服务重启加载（pid 121376）健康。

### 8a. 决策页缺「常驻路人」名单（✅已修复）
- **问题**：新地图的地点决策页（SceneLocation）不渲染地点的常驻 NPC（`loc.npcs`），只显示"确切在场"角色（sceneMapNpcs，仅 character 表主角）。沈砚等登记在 `scene_locations.npcs` 的地点路口人，在地图列表页只对顶层地点、决策页完全不显示 → 玩家看不到异能局等的常驻人员。
- **修复**：SceneLocation 决策页在环境概览（hero）下方新增「常驻人员」区块，列出 `loc.npcs`（职位·名字，如「副队·沈砚」），npcs 为空则不显示。
- 验证：`tsc --noEmit` 干净；vite HMR 热更新生效。

### 8b. 导演临时地点污染地图（✅已修复：B1 过滤 + 引导用已有地点）
- **问题**：导演 move 拍到不存在的地点时，scene-wiring 会 `INSERT` 一条 `temp-<uuid>` 的 `scene_locations`（is_public=0, creator_id=playerId）。`GET /scene/locations` 的过滤 `is_public=1 OR creator_id=?` 把玩家创建的私有地点全返回 → 这些约会内临时位移混进玩家可逛地图，把地图弄乱。共 6 个历史 temp（湖边幽静小径/舞池中心/湖岸边/林间小径/私人电影院包间门口×2）。
- **修复（B1）**：所有地图/子地点/路径/在场映射查询排除 `id LIKE 'temp-%'`：
  - `GET /scene/locations`（WHERE 加 `AND id NOT LIKE 'temp-%'`）
  - `sceneHasChildren`（排除 temp 子地点，避免"含子区域"误标）
  - `GET /scene/map/npcs` visibleLocs（排除 temp）
  - 历史 temp 记录仍保留在 DB（供进行中的约会引用/行程对齐），仅从玩家可逛地图隐藏。
- **引导导演用已有地点**：给导演传入「地图上可前往的地点」列表（`available_locations`，排除 temp），并在 scene.director 模板约束「move 只能用列表内地点名，不要即兴编造列表外新地点」。改动：`SceneTurnInput.scene.available_locations` + runDirector 渲染 + scene-wiring buildSceneContext 查询注入 + 模板。
- 验证：后端 tsc 干净；服务重启（pid 124103）；DB 确认 temp 6 条仍在但被过滤，过滤后可见地点不再含这些名。

### 8c. 改名后角色失声 / retry 说旧名（✅已修复）
- **根因**：角色身份两条名字来源撕裂——①actor 表 key = `getCharacterName(cid)`（实时读 `characters.character_data.$.name`，改名立即新名）；②`scene_messages.character_name` = 导演当时输出的 speaker **落库快照**（改名前的旧轮永久留旧名），且 `conversationSoFar` / `hotWindowRounds` 都用它重组喂 LLM。改名后导演看满屏旧名历史 → 抄旧名当 speaker → `runActor` 在新名 key 表双向 includes 找旧名（全不同名则失配）→「未找到演员上下文，跳过该拍」→ 角色失声；retry 复用含旧名历史 → 延续旧名。
- **修复（用 character_id 统一映射到当前名）**：
  - `conversationSoFar`（scene-wiring）：NPC 行若带 `character_id`，用 `getCharacterName(character_id)` 取实时当前名；无 id（narration）保留旁白。
  - `hotWindowRounds` 主角块：`role: r.character_name` → 当前名 `name`；路人块 → `n.name`。行过滤本身已用 `character_id === cid`，改名行也匹配。
  - scene.director 模板加护栏：「角色名以同行者/常驻路人列表为准，历史称谓可能是旧名，不要当成另一个人或另立新角色；speaker 用当前名」。
- 验证：后端 tsc 干净；服务重启（pid 125659）；npc_invite 等模板加载正常。

---

## 🟠 P2 — 应修

### 9. 文档严重滞后
DATA_MODEL.md 无任何 scene_*/turn_* 表；PROMPTS.md 无 scene.director/actor/greeting 三个模板；OPEN_QUESTIONS.md 归档问题3 自认"清理链已实现"但只覆盖旧表。

### 10. 并发系统性问题（多处）
- **权限钱包非原子扣费** `permission.ts:54-60`：SELECT→UPDATE 覆盖写，无事务无 `WHERE balance>=?` → 并发双扣/丢失更新
- **诱导评级重复发奖** `mission.ts:476`+`conversation.ts:544`：异步 fire-and-forget 无状态守卫 → 可重复发权限
- **约会/群聊 session 创建非原子** `conversation.ts:46-75`：检查与插入间隔 LLM 调用 → 并发突破互斥（⚠️ 现场全局互斥已大幅缓解：现在并发会返回 409+live 由弹窗接管；但 check→insert 之间仍有极小竞态窗口，未做 DB 层唯一约束）
- **NPC 主动消息非原子** `proactive.ts:443-492`：可绕每日上限
- **ensureSceneDay 无互斥** `schedule.ts:292-335`

### 11. 创建流程「先扣费后写」无回滚 `creation.ts:310-409`
finalize 先扣权限，后续任一步抛错则权限已扣、数据半成品、不退款。

### 12. 角色名重名复用竞态 `creation.ts:317-327`
并发创建同名角色 → 重复记录；且可"劫持"他人同名公共角色并清其 fork/关系。

---

## 🟡 RISK — 中低风险

| # | 问题 | 位置 |
|---|---|---|
| 13 | 异步记忆折叠与回滚竞态：runTurnMemoryUpdate 默认 fire-and-forget，fold 在 rollback 前 in-flight 可能写回已回退轮 | scene-wiring.ts:477 |
| 14 | 探索会话内存泄漏：纯内存 Map 无 TTL，关页/断连永久驻留 | explore-store.ts |
| 15 | presenceStore / lastMomentAt 只增不清 | presence.ts:34,66,381 |
| 16 | checkScheduleChange 用 charCodeAt 哈希存 INTEGER 列 → 碰撞漏触发 | proactive.ts:385-407 |
| 17 | 记忆折叠错误静默吞 + 失败无限重试同批 | memory.ts 多处 |
| 18 | **无自动化测试**：18K+12K 行仅 1 个手工脚本 | — |
| 19 | 导演 delta 无数值上限（clamp），可污染 stats_state | run-scene-turn.ts:425-456 |
| 20 | auth `startsWith('Bearer')` 后 slice(7) 无校验，大小写/多空格 401 | auth.ts:46-54 |
| 21 | 场景路人写入 `/scene/locations/:id/npcs` 不校验地点归属 → 越权改他人地点 NPC | scene.ts:188-202 |

---

## SMELL — 代码异味
- `_wtest` 空文件（未追踪，0字节，应删）
- api.ts 保留非流式 sceneRetry 死代码
- character-card.ts `as any`，likes 元素 null → 向 prompt 注入"null"文本
- 多处 fire-and-forget `.catch(()=>{})` 无日志
- 会话地狱：`getBaseSchedule` / `walkSceneTimeline` / `getSceneSchedule` 双份行程生成逻辑漂移风险
- 动态表名拼接（conversation-helpers.ts，当前不可利用）

---

## 修复优先级建议
1. **P1-1 删除路径 & 孤儿** — ✅ 彻底清零（写入侧跳过路人 + 四条删除路径全部覆盖新场景表）
2. **P1-2/3 越权** — ✅ 已完成（explore is_public、私有角色 IDOR）
3. **P1-4 advance 原子性** — ✅ 已完成（整轮落库包事务 + `WHERE id=? AND round_no=?` 乐观锁）
4. **P1.5 旁白重复 + LLM JSON 健壮性** — ✅ 已完成（旁白去重 + 长度对齐16384 + 截断检测 + actor 生成约束/结构校验）
5. **新地图约会前端体验 ×3** — ✅ 已完成（刷新定位最新 / 输入缓存 / 失败留输入）
6. **现场全局互斥「人只有一个」** — ✅ 已完成（统一 getActiveLiveSlot/endLiveSlot + 5 入口 409+live + 前端全局弹窗，新旧/群聊/剧本/旧探索/任务全互斥，新探索不算现场）
7. **P2**（待处理）：权限钱包原子扣费、任务评级互斥、create 先写后扣、角色名重名复用竞态
8. **RISK**（待处理）：文档同步（DATA_MODEL/PROMPTS）、补自动测试

---

**报告归档**：本文件 `/output/infinite-date-v2/REVIEW_DRAFT.md`。
**遗留 P1**：无。当前孤儿=0，删除路径全覆盖，写入侧不再产生新孤儿。
**待处理 P2/RISK**：见「修复优先级建议」第 4/5 项。
