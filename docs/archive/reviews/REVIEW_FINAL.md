# v2 全量审查报告 · REVIEW_FINAL.md

> 审查时间：2026-08-09  
> 审查范围：全量代码（server 25,581行 + web 15,715行 ≈ 53K行）+ 全量文档  
> 审查方法：4路并行审查（后端核心库 / 路由+DB+配置 / 前端 / 主审文档一致性）  
> 前置审查：REVIEW.md / REVIEW_DRAFT.md / REVIEW_FOLLOWUP.md（大量问题已修复）

---

## 总体评价

项目整体质量**良好**。核心引擎设计清晰，TypeScript 核心代码零错误，关键安全项（SQL 注入、XSS、5xx 信息泄露）已正确处理。但仍存在**若干必须修复的数据一致性和安全问题**。

---

## P0 — 致命（必须修复）

### P0-1. 多表删除操作无事务保护（3处）
**文件**：`player.ts` L67-132, `admin.ts` L342-395, `admin.ts` L191-217

三个删除操作跨 12-25 张表逐条 DELETE，**全部没有包在事务中**。任何一条失败（磁盘满、DB锁）会导致半删除状态——部分表已清空、部分残留，且无法重试（主记录可能已删）。

- `DELETE /player`（删档）：跨 25+ 张表
- `DELETE /admin/invite-codes/:code`（管理员删账号）：跨 20+ 张表，且**遗漏了 8 张场景引擎表**（scene_sessions/scene_relationships/scene_schedule_entries/turn_memory_fold/turn_player_facts/character_permissions/description_changes/image_blobs）
- `DELETE /admin/characters/:id`（删公共NPC）：跨 12 张表

对比 `me.ts` 的 `DELETE /me/friend/:characterId` 已正确使用 BEGIN/COMMIT/ROLLBACK。

**修复**：全部包裹事务 + 补全遗漏的表。

### P0-2. 前端 `imageUrl()` 把 JWT token 暴露在 URL query string
**文件**：`lib/api.ts` L22-25

```ts
return `${API_BASE}/uploads/${filename}${token ? `?token=${token}` : ''}`;
```

Token 会泄漏到浏览器历史、服务器日志、Referer header。如果 access log 被获取，token 可被重放。

**修复**：改用 fetch + URL.createObjectURL（能带 Authorization header），或后端生成短期签名 URL。

### P0-3. 前端 `requestStream()` 无超时保护
**文件**：`lib/api.ts` L116

普通 `request()` 有 30s 超时，但 SSE 流式 `requestStream()` 没有。如果服务端 hang 住，`reader.read()` 永久挂起，UI 永远卡在"对方正在输入"。

**修复**：外层包 AbortController，设 120s 超时。

---

## P1 — 严重

### P1-1. `action:search` 是死代码
**文件**：`run-scene-turn.ts` L945-948, `scene-wiring.ts` L635

导演 prompt 定义了 search 拍、validateBeats 校验通过，但 runSceneTurn 的 action 分支只 log + continue，不调任何检索函数。scene-wiring 也只处理 move。**不影响角色记忆**（buildActorMemories 有独立自动检索），但浪费导演 token、意图被静默丢弃。

**修复**：从导演 prompt 和 validateBeats 中移除 search 定义。

### P1-2. `db/index.ts` migration 失败后静默标记完成
**文件**：`db/index.ts` L24-32

`migration()` 的 catch 块无论什么错误都 INSERT OR IGNORE 标记为已完成（仅对 "duplicate column" 不打日志）。数据损坏、约束冲突等真实失败被掩盖，后续启动不再重试，数据结构永久不一致。

**修复**：仅对 "duplicate column" / "already exists" 类安全错误跳过+标记；其他错误 re-throw 阻止启动。

### P1-3. `embedding.ts` storeEmbedding 主键碰撞
**文件**：`embedding.ts` L111

主键 `${sourceType}_${sourceId}`，重复存储（如回滚后重折叠）时 INSERT 失败。`doRefreshOverview` 先删旧再插新，但 `doFoldTurnSegment` 没有先删旧 segment。

**修复**：改 INSERT OR REPLACE，或 doFoldTurnSegment 中先删同 round_no 的旧 segment。

### P1-4. `turn-memory.ts` 异步折叠的未处理 Promise
**文件**：`turn-memory.ts` L472-473, L484

`void Promise.all(foldPromises)` 和 `void ov` 直接丢弃 Promise。LLM 调用网络错误会触发 unhandledRejection。

**修复**：加 `.catch(err => log(...))`。

### P1-5. `upload.ts` 文件类型仅校验 mimetype，未校验魔数
**文件**：`upload.ts` L27-29

`file.mimetype` 来自客户端 header，可伪造。攻击者可上传任意二进制文件。

**修复**：读 buffer 前几字节校验 magic bytes（JPEG: FF D8 FF, PNG: 89 50 4E 47 等）。

### P1-6. `me.ts` 删好友用 LIKE 匹配 character_ids，存在误删风险
**文件**：`me.ts` L122-123

`LIKE '%char-abc%'` 会匹配 `char-abcdef` 等超集 ID。且 `%` / `_` 会被当通配符。

**修复**：JS 中解析 JSON 数组后精确匹配，或用 `json_each()`。

### P1-7. `conversation.ts` 创建约会无事务，greeting 失败后 relationship 残留
**文件**：`conversation.ts` L28-94

greeting 失败时只删 session，不回滚新创建的 relationship。导致首次约会失败后 isFirstMeeting 为 false，NPC 不再主动打招呼。

**修复**：事务包裹，或回滚时同步删 relationship。

### P1-8. `scene.ts` 私有角色无所有权校验
**文件**：`scene.ts` L324-328

查 `character_player_data WHERE id = ?` 不校验 `player_id`。玩家 A 可用玩家 B 的私有角色 ID 开启场景，留下孤儿 session。

**修复**：加 `AND player_id = ?`。

### P1-9. 默认 namer 模板缺少候选人设信息
**文件**：`run-scene-turn.ts` L1056, `prompt/templates/scene.namer.txt`

`pickNextSpeaker` 传了 `candidate_profiles` 但默认模板不用它，namer 只看到裸名字列表。点名质量受限。

**修复**：升级默认 namer 模板使用 `{{candidate_profiles}}`。

### P1-10. 前端 `SmsApp` 缓存恢复覆盖正常消息
**文件**：`pages/SmsApp.tsx` L163-179

创建角色中途切到其他短信线程再切回来，缓存恢复会用旧创建消息覆盖真实消息。

**修复**：缓存恢复与 threadId 绑定。

### P1-11. 前端 `ScenarioDream` 轮询出错时无限重试
**文件**：`pages/ScenarioDream.tsx` L20-47

后端持续错误时每 2 秒无限重试，用户永远卡在"正在做梦"。

**修复**：加最大重试次数 + 错误提示。

### P1-12. 前端 `MomentsApp` 30秒轮询无竞态保护
**文件**：`pages/MomentsApp.tsx` L38-43

setInterval 不等前一次完成，并发请求互相覆盖。

**修复**：用 useRef 跟踪最新请求 ID，或改 setTimeout 递归。

---

## P2 — 中等

### P2-1. 大量 `.catch(() => {})` 静默吞错
**位置**：跨多文件（scene-end.ts 4处、conversation.ts 5处、presence.ts 2处等）

`maybeFoldIncremental` / `generateNpcMoment` / `generateSmsGreeting` 等完全静默。失败时无日志可排查。

### P2-2. `memory-wiring.ts` buildAllActorMemories 串行 N+1
**文件**：`memory-wiring.ts` L76-85

每个 actor 串行 await（含 embedding API 调用）。4 个角色 = 16 次串行操作。

**修复**：用 Promise.all 并行。

### P2-3. `run-scene-turn.ts` 正则双重转义不一致
**文件**：`run-scene-turn.ts` L966 vs L855

兜底路径用 `\\([^()]*\\)`（双反斜杠，匹配字面反斜杠+括号），无法去除半角动作括号。其他路径用 `\([^()]*\)`（正确）。

**修复**：统一用 `\([^()]*\)`。

### P2-4. `scene-rollback.ts` 异步 embed 未 await
**文件**：`scene-rollback.ts` L272-274

`restoreCumulativeFromSnapshot` 是同步函数但内部 embed 是异步。回滚后立即开始新一轮可能数据竞争。

### P2-5. `presence.ts` 内存泄漏（2处）
**文件**：`presence.ts` L34, L381

`presenceStore` 和 `lastMomentAt` 两个 Map 无定期清理。玩家断线不退出时 entry 永留。

**修复**：加定期清理（每5分钟扫超过30分钟的 entry）。

### P2-6. `explore-store.ts` 内存泄漏
玩家关页不调 /end 时 session 永留 Map。无 TTL、无定期清理。

### P2-7. `permission_costs.json` 所有权限消耗均为 0
权限系统形同虚设。如果是开发配置，部署前必须设值。

### P2-8. `archive.ts` LIKE 搜索未转义通配符
用户搜 `%` 时匹配所有记录。非注入但影响准确性。

### P2-9. `image_blobs` 表无限增长
无清理机制。删账号/删消息时 blob 永远残留。

### P2-10. 前端 `App.tsx` 未读数每 8 秒轮询 4 个 API
**文件**：`App.tsx` L148-170

频率过高，移动端耗电。建议延长到 30-60 秒。

### P2-11. 前端 `ImageUploadButton` Object URL 未 revoke
**文件**：`components/ImageUploadButton.tsx` L62-63

每次上传泄漏一个 blob URL。

### P2-12. 前端 `Boot.tsx` 邀请码存 localStorage
**文件**：`pages/Boot.tsx` L19

邀请码等于密码，存 localStorage 有泄漏风险。

### P2-13. 前端 `AvatarCropModal` handleWheel 闭包陈旧
**文件**：`components/AvatarCropModal.tsx` L56-65

连续滚轮事件间 React 未 re-render 时，off/scale 是旧值，导致缩放跳变。

### P2-14. 前端 `FactsApp` 删除记忆无确认弹窗
**文件**：`pages/FactsApp.tsx` L70-78

### P2-15. 前端 `JSON.parse(JSON.stringify())` 深拷贝性能差
**文件**：`CharacterEditModal.tsx` L87, `NpcPanel.tsx` L67

每次编辑都深拷贝整个角色对象。

### P2-16. 前端 `useChatMessages.handleSend` catch 中 throw err
**文件**：`hooks/useChatMessages.ts` L247-253

异常冒泡到 React 事件处理器，可能导致未处理错误。

### P2-17. `scene-rollback.ts` 整场删除双重 UPDATE round_no=0
**文件**：`scene-rollback.ts` L314-317

冗余但无逻辑错误。

### P2-18. `adapter.ts` tryParseJsonReply 被调用两次
**文件**：`adapter.ts` L225

浪费 CPU（对长输出）。

---

## P3 — 建议改进

| 编号 | 问题 | 文件 |
|------|------|------|
| P3-1 | `getOverriddenSchedule` 死函数（注释已写"不再使用"） | schedule.ts L594 |
| P3-2 | `npc_schedules` 表残留 DELETE 语句 | admin.ts, me.ts |
| P3-3 | scripts 目录 ~20 个 TS 错误（不影响运行） | src/scripts/ |
| P3-4 | README 路由数写 22 实际 25 | README.md L39 |
| P3-5 | 无全局 `process.on('unhandledRejection')` | index.ts |
| P3-6 | SSE 无心跳保活 | scene.ts, scene-named.ts |
| P3-7 | config.ts API Key 硬编码默认值 | config.ts L22 |
| P3-8 | 无速率限制 | 全局 |
| P3-9 | llm_call_log 无清理机制 | 全局 |
| P3-10 | `attempts: 0` 未使用（runSceneTurnNamed） | run-scene-turn.ts L1134 |
| P3-11 | `parseJsonLoose` 与 `tryParseJsonReply` 重复 | run-scene-turn.ts L201 |
| P3-12 | `inflight` Map 无超时保护 | turn-memory.ts L62 |
| P3-13 | `requireAdmin` 函数重复定义 3 份 | admin.ts, feedback.ts, scene-named.ts |
| P3-14 | `combatKeywords` 数组 '战斗' 重复 | schedule.ts L59 |
| P3-15 | 前端 Scene* 与非 Scene* 四组页面大量代码重复 | 多文件 |
| P3-16 | 前端 CSS `inset: 0`/`clamp()`/`gap` 可能不兼容 QQ浏览器 | index.css |
| P3-17 | 前端 vite.config.ts 未配置 build.target | vite.config.ts |
| P3-18 | 前端大量内联 style 对象 | 多文件 |
| P3-19 | 前端 PhoneShell 时间不实时更新 | PhoneShell.tsx |
| P3-20 | 前端 `AutoTextarea` ref 覆盖外部 ref | AutoTextarea.tsx |
| P3-21 | 前端 `MomentsApp` classList.toggle 直接操作 DOM | MomentsApp.tsx L152 |

---

## 已确认修复的旧问题

| 问题 | 状态 |
|------|------|
| wiki-search.ts fetchJson 无超时 | ✅ 15s |
| adapter.ts fetch 无超时 | ✅ 120s |
| MAX_MODEL_LEN 值不正确 | ✅ 16384 |
| scenario.ts foldChronicle 静默吞错 | ✅ 加了日志 |
| 前端 color-mix() 不兼容 | ✅ 无残留 |
| DATA_MODEL.md 缺 scene_*/turn_* 表 | ✅ 已补齐 |
| DESIGN.md 未提 npc_schedules 退役 | ✅ 已标注 |
| is_llm_edited 保护逻辑 | ✅ 正确 |
| 前端 dangerouslySetInnerHTML XSS | ✅ 无使用 |
| SQL 注入风险 | ✅ 参数化绑定 |

---

## 优先级排序

| 优先级 | 编号 | 问题 | 工作量 |
|--------|------|------|--------|
| **P0** | P0-1 | 多表删除无事务（3处） | 中 |
| **P0** | P0-2 | 前端 token URL 泄漏 | 中 |
| **P0** | P0-3 | 前端 SSE 无超时 | 小 |
| **P1** | P1-1 | action:search 死代码 | 小 |
| **P1** | P1-2 | migration 静默失败 | 小 |
| **P1** | P1-3 | embedding 主键碰撞 | 小 |
| **P1** | P1-4 | turn-memory 未处理 Promise | 小 |
| **P1** | P1-5 | upload 无魔数校验 | 小 |
| **P1** | P1-6 | LIKE 误删 scene_sessions | 小 |
| **P1** | P1-7 | greeting 失败 relationship 残留 | 小 |
| **P1** | P1-8 | 私有角色无所有权校验 | 小 |
| **P1** | P1-9 | namer 模板缺人设 | 小 |
| **P1** | P1-10 | SmsApp 缓存覆盖 | 中 |
| **P1** | P1-11 | ScenarioDream 无限重试 | 小 |
| **P1** | P1-12 | MomentsApp 竞态 | 小 |
| P2-P3 | — | 见上表 | — |

---

## 架构亮点

1. **单进程 + 单 DB 连接 + node:sqlite 同步串行化**——在这个规模下正确，彻底避免并发写问题
2. **记忆三层架构**（热窗→中期摘要→长期总览）+ 语义检索——设计完整
3. **点名版导演**——代码强制白名单 + 极简 namer，比导演一次排整轮更可控
4. **多级兜底**——玩家发言后必有角色回应
5. **"X个字"字数修正 + 复述检测**——程序检测 + LLM 改写混合模式，零开销
6. **is_llm_edited 保护**——重新生成不覆盖 LLM 编辑

---

## OPEN_QUESTIONS.md（5个未关闭的设计决策，非 bug）

1. NPC 放逐机制未实现
2. 记忆检索 query 构造策略（当前用最后1轮）
3. 剧本数值系统平衡性（LLM 生成无人工校准）
4. 短信 greeting 触发时机（异步 fire-and-forget）
5. 搜索增强 token 消耗（need_search 双倍 LLM 调用）
