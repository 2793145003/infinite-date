# infinite-date-v2 整体代码审查报告

> 审查范围：全部76个源文件（db/schema、db/index、config、index、llm/adapter、prompt/builder+loader、lib/全部、routes/全部14个、前端全部页面+组件+CSS）
> 方式：4个子agent并行审查 + 交叉验证 + 实际DB查询确认
> 日期：2026-08-04
> 复核日期：2026-08-04（代码核对后标记修复状态）

---

## P0 — 阻断性 Bug（新部署直接不能跑）

### 1. ✅ 已修复：chronicles 表缺少 `source` 和 `summary_type` 列

- **位置**：`db/schema.ts` L195-204 + `db/index.ts` L39-40
- **修复确认**：schema.ts L202-203 建表已含 `source TEXT NOT NULL DEFAULT 'conversation'` + `summary_type TEXT`；db/index.ts L67-71 migration `chronicles_source` 追加列

### 2. ✅ 已修复：location_npc_access 每次重启被 DROP 重建

- **位置**：`db/index.ts` L21
- **修复确认**：index.ts L44 注释"旧版曾在此处 DROP 重建，会导致每次重启丢失数据，已移除"。无 DROP 语句

---

## P1 — 功能性 Bug

### 3. ✅ 已修复：archive.ts 约会搜索完全失效

- **位置**：`archive.ts` L48 + L63
- **修复确认**：L47 改为 `LIKE '%' || ? || '%'`（参数化搜索），L60 `name.includes(search)` 无 `|| true`。短信搜索（L208）和剧本搜索（L311-313）也已修正

### 4. ✅ 已修复：archive.ts 约会详情缺 scenario_session_id 过滤

- **位置**：`archive.ts` L128
- **修复确认**：L124 `WHERE id = ? AND player_id = ? AND ended = 1 AND scenario_session_id IS NULL`。所有5处 archive 查询均有 scenario_session_id IS NULL

### 5. ✅ 已修复：sms.ts internal 赋值给所有消息

- **位置**：`sms.ts` L259-263 (send) + L432-437 (retry)
- **修复确认**：sms.ts send（L246）和 retry（L400）均为 `internal: i === 0 ? reply_data.internal : ''`

### 6. ✅ 已修复：builder.ts item_obtained schema 与类型不一致

- **位置**：`builder.ts` L23 (schema) vs L349 (normalize) vs 类型定义
- **修复确认**：L23 `item_obtained: { anyOf: [{ type: 'boolean' }, { type: 'null' }] }`，L349 `raw.item_obtained == null ? null : Boolean(raw.item_obtained)`

### 7. ✅ 已修复：builder.ts join('\\\\n') 产生字面 \\n 而非换行

- **位置**：`builder.ts` L580
- **修复确认**：搜索 `join('\\\\n')` 无匹配，所有 join 均为 `'\n'`（正常换行符）

### 8. ✅ 已修复：presence.ts maybeNpcRandomMoment 在 proactive 成功时不执行

- **位置**：`presence.ts` L90-108
- **修复确认**：将 `maybeNpcRandomMoment` 调用移到 proactive try 块之前，无论是否生成主动消息都会执行

---

## P2 — 设计/文档矛盾

### 9. ✅ 已修复：deleteFriend 行为与 DESIGN.md 矛盾

- **修复确认**：DESIGN.md L298 已改为"彻底抹除与该角色的一切痕迹"，与代码行为一致

### 10. ✅ 已修复：deleteFriend 级联删除遗漏

- **事务**：✅ 已修复。me.ts L113 已有 `BEGIN/COMMIT/ROLLBACK`
- **遗漏表**：✅ 已修复。补充删除 `character_permissions` 和 `permission_transactions`

### 11. ✅ 已修复：maybeFoldSmsIncremental 不支持 skipPlayerFacts

- **修复确认**：memory.ts L241 `maybeFoldSmsIncremental` 已有 `skipPlayerFacts: boolean = false` 参数，L283 传给 `_foldChronicleImpl`

---

## RISK — 中等风险

| # | 文件 | 问题 | 状态 |
|---|------|------|------|
| 12 | schema.ts | 大量表引用 players(id) 但无 `ON DELETE` 级联策略（18张表缺失） | 未修复（设计权衡：靠应用层清理） |
| 13 | db/index.ts | 无 migration 版本管理，全靠 `try { ALTER } catch {}` | ✅ 已修复：改为 `schema_migrations` 表 + `migration()` 函数 |
| 14 | llm/adapter.ts | fetch 无默认超时，vLLM hang 住时请求无限等待 | ✅ 已修复：120s 超时 |
| 15 | character.ts | `{} as CharacterData` 类型不安全 | 未修复 |
| 16 | index.ts | 错误处理直接返回 `err.message` 给客户端 | ✅ 已修复：5xx 不泄露 message |
| 17 | memory.ts | 并发 foldChronicle 无锁机制 | 未修复 |
| 18 | scenario.ts | retry 的 replySchema 不含 need_search/search_query | 未修复 |
| 19 | conversation.ts | 群聊 speaker 名→ID 映射无容错 | 未修复 |
| 20 | wiki-search.ts | fetchJson 无超时控制 | 未修复 |
| 21 | lib/api.ts (前端) | fetch 无请求超时 | 未修复 |

---

## SMELL — 代码异味（不紧急）

| 文件 | 问题 |
|------|------|
| schema.ts | `home_of` 字段已废弃但仍在建表语句中 |
| schedule.ts | `customPool` 忽略数据库活动描述，硬编码 `'在这里待着'` |
| proactive.ts | `prevLocName` 声明但未使用（未完成实现） |
| proactive.ts | 性格关键词列表与 schedule.ts 重复不同步 |
| conversation.ts | `/send` 与 `/retry` ~250行代码重复 |
| sms.ts | `/send` 与 `/retry` ~130行代码重复 |
| ScenarioConversation.tsx | 与 Conversation.tsx ~60%代码重复，应提取 `useChatMessages` hook |
| AdminApp.tsx | 1360行过长，应拆分为3个面板文件 |
| embedding.ts | 大簇/小簇分支代码完全重复，注释与实现不符 |
| memory.ts | `getUnifiedTimeline` ORDER BY 导致 segment 被 session 截断 |
| permission-config.ts | `loadCosts` 不处理文件缺失/解析错误 |
| builder.ts | `formatCurrentTime` 硬编码 UTC+8 |
| adapter.ts | `MAX_MODEL_LEN = 8192` 硬编码 |
| conversation.ts | retry 返回 500 vs send 返回 502，不统一 |
| conversation.ts | need_search 仅 ≤5 字符触发 |
| scenario.ts | 4处 `foldChronicle().catch(() => {})` 静默吞错 |

---

## 文档过时

| 文档 | 过时内容 | 状态 |
|------|----------|------|
| README.md | 说"10个路由模块"，实际22个 | ✅ 已修复 |
| README.md | `max_model_len=8192`，实际应该是 16384 | ✅ 已修复 |
| README.md | Phase 4 标记"❌ 未开始"，但剧本系统已实现 | ✅ 已修复 |
| README.md / DESIGN.md | 未提及回忆录(Archive)、need_search机制、主神抽选(deity_pick)、删除好友功能 | 部分修复（DESIGN.md 已加摸鱼模式，其余待补） |
| DESIGN.md L300 | 删好友"记忆还在"与代码行为矛盾 | ✅ 已修复 |
| DESIGN.md / DATA_MODEL.md | 未记录 location_homes 多对多迁移 | ✅ 已修复（DATA_MODEL.md 已有 location_homes 定义 + Migration 记录） |
| OPEN_QUESTIONS.md | 孤儿数据清理表清单缺少新增表 | 待更新 |

---

## 铁律对照

| 铁律 | 状态 | 说明 |
|------|------|------|
| ① JSON必传guidedJson | ✅ 通过 | 所有结构化JSON调用都传了guidedJson |
| ② prompt与schema对齐 | ✅ 通过 | item_obtained schema 已修复为 boolean |
| ③ fallback+空重试 | ✅ 通过 | generateReply 三层防御链完整 |
| ④ 纯文本检测 maxTokens≥512 | ✅ 通过 | 所有JSON调用maxTokens≥512 |
| ⑤ 群聊speaker存character_id | ✅ 通过 | DB存储正确；但名→ID映射无容错 |
| ⑧ 非剧本查询加scenario_session_id IS NULL | ✅ 通过 | archive.ts 所有5处查询均已加 |

---

## 残留待修复项

1. ~~P1: presence.ts maybeNpcRandomMoment~~ ✅ 已修复
2. ~~P2: deleteFriend 遗漏清理 character_permissions / permission_transactions~~ ✅ 已修复
3. **RISK**: character.ts 类型不安全、memory.ts 并发无锁、scenario.ts retry schema 不全、conversation.ts 群聊名→ID无容错、wiki-search.ts/api.ts 无超时（#15/17/18/19/20/21）
