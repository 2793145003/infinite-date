# v2 代码与文档审查报告（第三轮）

> 审查时间：2026-08-12  
> 审查范围：全项目源码 + 设计文档 + Prompt模板  
> 方法：逐文件读取源码验证，不依赖旧报告结论

---

## 一、旧报告问题验证

### REVIEW.md / REVIEW_FINAL.md 中已修复的问题

| 编号 | 问题 | 验证结果 |
|------|------|----------|
| P0-1 | 多表删除无事务 | ✅ 已修复。`admin.ts:201` 和 `admin.ts:373` 均已用 `BEGIN`/`COMMIT`/`ROLLBACK` 包裹 |
| P0-2 | me.ts LIKE 子串误删 | ✅ 已修复。`me.ts:124` 改用 `json_each` 精确匹配 |
| P0-3 | requireAdmin 重复定义 | ⚠️ 仍存在3处重复（`admin.ts:17`, `scene-named.ts:23`, `feedback.ts:14`）。功能正确但违反 DRY |
| P1-1 | turn-memory void Promise 无 .catch | ⚠️ 仍存在。`turn-memory.ts:490` `void Promise.all(foldPromises)` 和 `:501` `void ov` 均无 catch |
| P1-2 | image_blobs LIKE 删除 | ⚠️ 仍存在。`admin.ts:412` `DELETE FROM image_blobs WHERE id LIKE ?` 用 `${playerId}_%` 匹配，理论上 playerId 含 `_` 会误匹配（但 UUID 不含 `_`，实际风险低） |

### 旧报告未提及但已正确实现的部分

- `upload.ts`：图片上传有魔数校验（防止伪造 mimetype 上传 XSS），10MB 大小限制，写入数据库而非裸文件
- `db/index.ts`：migration 框架完善，有 `schema_migrations` 表追踪、重复列安全跳过、真实错误不标记完成
- `index.ts:131-135`：有 `unhandledRejection` / `uncaughtException` 全局处理器
- `api.ts`：SSE 流式有 120s 超时 + AbortController，401 自动清 token
- 主动消息机制（`proactive.ts`）：意愿累积替代定时器，设计文档与代码一致

---

## 二、新发现的问题

### P1 — 高严重性

#### P1-NEW-1：`scene_relationships.scene_session_id` 无外键约束

**位置**：`scene-session.ts:61`

```sql
scene_session_id  TEXT,   -- 无 REFERENCES，无 ON DELETE
```

`scene_relationships` 表的 `scene_session_id` 列没有外键约束指向 `scene_sessions(id)`。当 scene_session 被删除时，关联的 scene_relationships 记录会变成孤儿数据。

**影响**：删除 scene_session 后 scene_relationships 残留，`player_description` / `current_activity` 可能指向已不存在的会话。

**对比**：同表的 `player_id` 有 `REFERENCES players(id) ON DELETE CASCADE`，`scene_messages.scene_session_id` 也有 `REFERENCES scene_sessions(id) ON DELETE CASCADE`。唯独 `scene_relationships.scene_session_id` 漏了。

**建议**：这是有意设计（scene_relationships 跨场延续，不绑死单个 session）还是遗漏？从 PROMPTS.md 看 `current_activity` "存于 scene_relationships，跨场延续"——如果是有意设计则正确，但应加注释说明。如果 scene_session_id 只是"最近一次关联"的弱引用，考虑设为 NULL 或用应用层清理。

---

#### P1-NEW-2：`turn_memory_fold` / `turn_player_facts` 的 `scene_session_id` 无外键

**位置**：`turn-memory.ts:34, 51`

```sql
scene_session_id  TEXT NOT NULL,   -- 无 REFERENCES
```

两张表都有 `player_id REFERENCES players(id) ON DELETE CASCADE`，但 `scene_session_id` 没有外键指向 `scene_sessions(id)`。删除 scene_session 时记忆折叠数据不会被级联清理。

**影响**：与 P1-NEW-1 同类问题。admin.ts 删除玩家时手动清理了这两张表（`admin.ts:408-409`），但删除单个 scene_session 时不会清理（`scene-session.ts` 无相关清理逻辑）。

**建议**：加 `REFERENCES scene_sessions(id) ON DELETE CASCADE`，或在删除 scene_session 的代码路径中手动清理。

---

#### P1-NEW-3：`void Promise.all(foldPromises)` 无错误兜底

**位置**：`turn-memory.ts:490, 501`

```typescript
if (opts?.sync) await Promise.all(foldPromises);
else void Promise.all(foldPromises);   // ← fire-and-forget，无 .catch

// ...
if (opts?.sync) await ov; else void ov; // ← 同上
```

异步折叠失败时错误被静默吞掉，无日志、无重试。`index.ts` 的 `unhandledRejection` 处理器会记录到 stderr，但不会知道是哪个 scene/character 的折叠失败了。

**影响**：记忆折叠静默失败 → 角色可能丢失中期记忆/长期总览，但玩家和系统都无感知。

**建议**：加 `.catch(err => log(...))`：
```typescript
else void Promise.all(foldPromises).catch(err => 
  log(`[折叠失败] scene=${sceneSessionId}: ${err instanceof Error ? err.message : err}`)
);
```

---

### P2 — 中严重性

#### P2-NEW-1：`requireAdmin` 三处重复定义

**位置**：`admin.ts:17`, `scene-named.ts:23`, `feedback.ts:14`

三处完全相同的函数签名和实现。虽然功能正确，但修改时容易漏改（如改变 admin 判定逻辑时只改了一处）。

**建议**：抽到 `lib/auth.ts` 中导出。

---

#### P2-NEW-2：`scene_schedule_entries` 缺少外键约束

**位置**：`db/index.ts:134-146`

```sql
CREATE TABLE IF NOT EXISTS scene_schedule_entries (
  player_id     TEXT NOT NULL,        -- 无 REFERENCES
  character_id  TEXT NOT NULL,        -- 无 REFERENCES
  location_id   TEXT NOT NULL,        -- 无 REFERENCES
  ...
);
```

整张表没有任何外键约束。虽然 `admin.ts` 删除玩家时手动清理了（`:407`），但删除 character 或 location 时不会级联清理行程数据。

**影响**：删除公共 NPC 后，`scene_schedule_entries` 中该角色的行程残留。

**建议**：如果是有意设计（schedule 数据不依赖 character/location 存在），加注释说明。否则加外键。

---

#### P2-NEW-3：`image_blobs` 删除用 LIKE 模式匹配

**位置**：`admin.ts:412`

```typescript
db.prepare('DELETE FROM image_blobs WHERE id LIKE ?').run(`${playerId}_%`);
```

用 `playerId_%` 做 LIKE 匹配。UUID 不含 `_`（用 `-` 分隔），所以实际不会误匹配。但：
1. `_` 在 SQL LIKE 中是通配符（匹配单个字符），所以 `playerId_` 实际匹配 `playerId` + 任意一个字符 + `%`，语义上不精确
2. 如果 playerId 被篡改含 `_` 或 `%`，会有安全问题

**建议**：用 `ESCAPE` 子句或改为精确前缀匹配：
```sql
DELETE FROM image_blobs WHERE id LIKE ? ESCAPE '\'
```
传入 `${playerId}\_%`。

---

#### P2-NEW-4：PROMPTS.md 与代码的字段名不一致

**位置**：`PROMPTS.md:284` vs `scene.actor.txt`

PROMPTS.md 第284行明确标注：
> 注：本节描述的是「短信/老约会」接口的输出（字段名 `messages`）。**场景约会（scene 引擎）用不同的字段名 `texts`**

但 `scenario.system.txt` 使用的 `REPLY_SCHEMA`（`builder.ts:16-32`）字段名是 `messages` 而非 `texts`。剧本路径调用的是 `generateReply`（返回 `messages`），场景引擎调用的是 actor（返回 `texts`），两者确实不同——但 PROMPTS.md 第232行说"剧本对话复用 `generateReply`"，意味着剧本场景实际用 `messages` 字段名，与场景引擎的 `texts` 不同。这一点文档描述正确但容易混淆，建议在 PROMPTS.md 中加一个对照表。

---

### P3 — 低严重性

#### P3-NEW-1：`scene_relationships.current_activity` 在搜索中未找到引用

**位置**：`scene-session.ts:63` 定义了 `current_activity TEXT NOT NULL DEFAULT ''`

在 `apps/server/src` 下搜索 `current_activity` 返回 0 个结果（搜索引擎可能未覆盖所有文件）。PROMPTS.md 提到"存于 `scene_relationships.current_activity`，跨场延续"，但需要确认代码实际读写该字段。

**状态**：需进一步确认（可能是搜索引擎限制）。

---

#### P3-NEW-2：旧导演模板 `scene.director.txt` 仍保留

**位置**：`apps/server/src/prompt/templates/scene.director.txt`

文件头部已标注"旧版，已标注过时"，PROMPTS.md 也说明"点名版不调用此文件"。但 107 行的模板仍然保留在代码库中。

**影响**：无功能影响（loadPrompt 不加载未被调用的模板）。仅是代码卫生问题。

**建议**：可保留作回退参考。当前处理方式（头部注释标注过时）已足够。

---

#### P3-NEW-3：`permission_costs.json` 所有消耗为 0

**位置**：`config/permission_costs.json`

文件自身注释说明"所有权限消耗当前为 0（开发阶段）。生产部署前必须设值"。

**影响**：开发阶段无影响。生产环境如果忘记设值，所有操作免费，经济系统失效。

**建议**：已标注提醒，当前可接受。建议加一个启动时的检查日志（如果所有 cost=0 且非 dev 模式则 warn）。

---

## 三、交叉一致性分析

### 3.1 数据模型 ↔ 设计意图

| 检查项 | 结果 |
|--------|------|
| 意愿累积机制（sms_urge/moment_urge） | ✅ migration 正确添加列，proactive.ts 读写一致 |
| 主动消息替代定时器 | ✅ proactive.ts 注释"消息时机由NPC状态决定，不由定时器决定"，代码与 DESIGN.md 一致 |
| 场景引擎表（scene_sessions/messages/relationships） | ✅ 惰性建表，FK 基本完整（除 scene_relationships.scene_session_id） |
| turn_memory_fold 三层记忆 | ✅ 参数 N=5/I=12/M=15 与设计文档一致，折叠逻辑正确 |
| NPC行程落库 | ✅ scene_schedule_entries 有 is_llm_edited 字段，与设计要求"重新生成不得覆盖LLM编辑"一致 |
| 玩家性别注入 | ✅ players 表有 gender/appearance 列，migration 正确 |
| 图片上传安全 | ✅ 魔数校验 + 大小限制 + 写入数据库 |
| 事务包裹删除 | ✅ admin.ts 两处删除（角色/玩家）均有事务 |

### 3.2 术语一致性

| 术语 | 使用情况 |
|------|----------|
| 旁白 = narration beat (SSE) | ✅ PROMPTS.md 和代码一致使用 |
| internal = 内心独白（付费窥探） | ✅ builder.ts + PROMPTS.md 一致 |
| 点名版 vs 旧导演 | ✅ 文档和模板头部注释一致标注 |
| texts（场景引擎） vs messages（短信/老约会） | ✅ 已在 PROMPTS.md 中显式区分 |
| sms_urge / moment_urge | ✅ 代码与文档一致 |

### 3.3 外键链完整性

```
players (PK: id)
  ├─ invite_codes.player_id          → CASCADE ✅
  ├─ sessions.player_id              → CASCADE ✅
  ├─ conversation_sessions.player_id → (无FK) ⚠️
  ├─ scene_sessions.player_id        → CASCADE ✅
  ├─ scene_relationships.player_id   → CASCADE ✅
  ├─ scene_schedule_entries.player_id→ (无FK) ⚠️
  ├─ turn_memory_fold.player_id      → CASCADE ✅
  ├─ turn_player_facts.player_id     → CASCADE ✅
  ├─ relationships.player_id         → (无FK) ⚠️
  └─ ... (其他表)

scene_sessions (PK: id)
  ├─ scene_messages.scene_session_id     → CASCADE ✅
  ├─ scene_relationships.scene_session_id→ (无FK) ⚠️ P1-NEW-1
  ├─ turn_memory_fold.scene_session_id   → (无FK) ⚠️ P1-NEW-2
  └─ turn_player_facts.scene_session_id  → (无FK) ⚠️ P1-NEW-2

characters (PK: id)
  ├─ relationships.character_id          → (无FK) ⚠️
  ├─ scene_relationships.character_id    → (无FK) ⚠️
  └─ scene_schedule_entries.character_id → (无FK) ⚠️
```

**总结**：核心实体（players）的 FK 基本完整。scene_sessions 的子表有两处 FK 缺失。characters 表的所有引用都无 FK——这可能是有意设计（characters 是公共 NPC，与玩家数据是弱关联），但应统一文档说明。

---

## 四、架构评价

### 做得好的部分

1. **事务安全**：删除流程全部事务包裹，有回滚和错误日志
2. **Migration 框架**：幂等执行、版本追踪、安全跳过重复列、真实错误重试
3. **Prompt 体系**：模板外部化 + loadPrompt 缓存 + 改文件重启即生效，三层防御（guided_json → 重试 → salvage → fallback）
4. **主动消息机制**：意愿累积替代定时器，设计优雅，代码与文档高度一致
5. **上传安全**：魔数校验是正确的防御措施
6. **SSE 流式**：120s 超时 + AbortController，防止 hang 住

### 需要改进的部分

1. **外键一致性**：新引擎表的 FK 有遗漏（P1-NEW-1, P1-NEW-2）
2. **fire-and-forget 错误处理**：`void Promise.all` 模式需加 catch（P1-NEW-3）
3. **requireAdmin DRY 违反**：三处重复（P2-NEW-1）
4. **LIKE 模式安全**：image_blobs 删除应转义 `_`（P2-NEW-3）

---

## 五、严重性汇总

| 级别 | 编号 | 问题 | 状态 |
|------|------|------|------|
| **P1** | P1-NEW-1 | scene_relationships.scene_session_id 无 FK | 新发现 |
| **P1** | P1-NEW-2 | turn_memory_fold/turn_player_facts scene_session_id 无 FK | 新发现 |
| **P1** | P1-NEW-3 | void Promise.all 无 .catch（旧报告已提，仍未修） | 未修复 |
| **P2** | P2-NEW-1 | requireAdmin 三处重复 | 未修复 |
| **P2** | P2-NEW-2 | scene_schedule_entries 无任何 FK | 新发现 |
| **P2** | P2-NEW-3 | image_blobs LIKE 删除未转义 `_` | 未修复 |
| **P2** | P2-NEW-4 | PROMPTS.md 字段名易混淆 | 新发现 |
| **P3** | P3-NEW-1 | current_activity 引用需确认 | 待确认 |
| **P3** | P3-NEW-2 | 旧导演模板保留 | 可接受 |
| **P3** | P3-NEW-3 | 权限消耗全为 0 | 开发阶段可接受 |

---

*报告已写入 `/output/infinite-date-v2/REVIEW_V3.md`*
