# 2026-08-07 会话记录（分气泡 / 气泡节奏 / 时间戳 / 改名加固 / LLM 调用日志）

## 一、一拍多气泡「分不分」真因与方案 A（已落地 pid 已重启）

**真因**：演员 JSON schema 同时允许 `text`（单条字符串）+ `texts`（string 数组），
Gemma 偷懒走 `text` 单字段、用空行假装分段（"（动作）\n\n话\n\n（动作）\n\n话"存成 1 条 message）
→ 后端落库 1 条 → 前端 1 个气泡不分。

- 排查链：白景安不分=旧模板存量会话（bdfc 4395 r31 早于新代码生效）；A/B 模板、A/B maxTokens 都稳定能拆 → 得出结论不是模板/maxTokens，是 schema 给了单字段退路。
- 方案 A（治本，对齐旧版约会：messages 数组唯一通道，模型只能拆多元素）：**删 `text` 字段，只留 `texts` 必填**。
- 改动：run-scene-turn.ts（ActorOut 接口 / ACTOR_JSON_SCHEMA / normalizeActorOut / 气泡 rawBubbles 去掉 `[out.text]` 兜底 / 清理残留 `text` 返回值）。
- 用户实测"分气泡了" ✅。

## 二、气泡节奏均匀（后几个气泡一下子冒出来）真因与修复

**真因**：SSE 流解析 requestStream（apps/web/src/lib/api.ts）用 `while` 循环把**同批到达的事件一次性派发**，
且没 await 每个 onBeat。同一拍多气泡在同一网络 chunk 到达 → appendBeat 被**并发**触发，
各自 sleep(300ms) **并行重叠**，睡完同时 setLines → 第 2/3 个气泡"啪"一起冒出。

**修复**：
1. requestStream 的 `onEvent` 改为**逐条 `await`**，三个 stream 闭包（advance/continue/retry）`return onBeat?.(...)` 透传 Promise → 气泡串行上屏。
2. appendBeat 最短节拍 300ms → **600ms**（BEAT_MS），稳定逐条、像真人打字呼吸感。

## 三、前端视觉（同一拍多气泡）

- **只有第一个气泡显示名字**：新增 `isGroupContinuation(idx,l)`（上一个非旁白的字符气泡 speaker 相同）= true 时不渲染 `id-bubble-speaker`。
- **同拍间距收紧**：CSS `.id-bubble-row-grouped`（margin-bottom 0.12rem + 圆角处理），视觉归成一组。

## 四、时间戳（每轮最上面小小显示）

- 需求澄清：时间戳=「气泡冒出来的时间」；历史消息用后端存的 created_at，新生成用上屏时间。
- 后端 scene.ts L595 messages select 加 `created_at` 传回。
- 前端 Line 加 `time`（toLine 从 created_at 映射，appendBeat/玩家行用 Date.now()）；`formatTime` HH:MM。
- `showRoundTime`：与上一条带 time 的气泡相差 ≥60s（TIME_DIVIDER_MS）才显示 `.id-bubble-time`。
  - 坑：一开始依赖 round_no，但**新实时生成的气泡没有 round_no** → 实时约会根本不出时间戳（用户"没看到时间"）；改成依赖真实时间差，历史/实时都适用。

## 五、改角色名健壮性审查（结论：几乎全安全）

排查全链路：核心数据层用 `character_id`（稳定）→ 记忆(memory.ts 按 id 挂)、scene actor 每次动态取当前名、
档案/剧本 getCharacterName 动态读、scene_messages 同时存 id+当时名 —— 改名都不会失声/记忆错乱/角色消失。

**唯一薄弱点**（已加固）：进行中约会中途改名后，前端 `idByName`（名字→id 映射）是页面加载时建的旧名，
新气泡用新名 → 点名字打开人设编辑失效。
**加固**：SSE beat 事件全程带 `characterId`（稳定 id），前端 appendBeat 直接用 id，不再靠名字反查。
- run-scene-turn 的 onBeat 带 characterId；scene.ts 三处 SSE（advance/continue/retry）beat 带 characterId；
  api.ts beat 类型 + appendBeat 接收 characterId。前端不再依赖 idByName 反查新气泡。

## 六、LLM 调用记录（用户要求：先存一小时，完整，type 靠用户 debug 时说）

- **不可用 vLLM 侧**：/tmp/vllm-gemma.log 只记 access log（URL+状态码）+吞吐，不含 prompt/response 正文；
  要看正文要开 `--enable-prompt-logging` 但需重启 vLLM 进程（违反"服务不能停"铁律）。
- **做应用侧**：新表 `llm_call_log`（schema.ts 加，重启自动建）：
  存完整 messages_json + raw_response + parsed_json + tokens + finish_reason + created_at + 可选 call_type/session_id。
- **在 chat() 统一收敛点打点**（adapter.ts）：所有 LLM 调用（导演/演员/旁白/探索/旧约会）自动进表，一处包完。
- **1 小时滑动窗口**：插入时顺手 `DELETE FROM llm_call_log WHERE created_at < now-3600s`。
- **call_type 标记**：chat() 加可选 opts.callType，runActor→'actor'、runDirector→'director'、runNarration→'narration'、scene-explore→'explore'。
  也加在 chatJson 的 opts 透传。写入失败 try/catch 不阻断主流程。
- **回查方式**：`SELECT call_type, created_at, substr(raw_response,1,200) FROM llm_call_log WHERE call_type='actor' ORDER BY created_at DESC`；
  或用户说 type + 时间点/搜索词定位。type 由用户 debug 时口头告知（用户已知是导演/演员/旁白）。

## 存档状态（重启后）

- server 当前 pid 141612（已加载：maxTokens 4096 全量 + chatJson + normalizeActorOut + scene-explore 迁移 +
  演员生成重构 + 删 nudge + 旁白定位重构 + missions.updated_at 修复 + **方案A去text只留texts** +
  **SSE逐条await节奏均匀** + **改名characterId加固** + **llm_call_log表与打点**）。
- vite pid 270476（8080 HMR）。
- vLLM 8000 未变。
