# Infinite-Date 会话统一迁移设计（场景引擎化）

> 状态：已定案（Open Questions 已讨论完毕，可动工）— 2026-08-05 定案
> 日期：2026-08-05
> 目标：把约会/群聊/探索/任务/副本/多人副本——一切会话——统一迁移到「场景引擎」（导演编排 + 逐拍演员 + 三层记忆 + stats 结算）上，通过**新 app 并行 + 旧 app 保留**的方式渐进替代。

---

## 0. 一句话共识

**新 app 走新路由 + 新表；旧 app 原样保留走旧路由 + 旧表。玩家在入口自主选择进哪个**：想试新旁白/新功能、不介意 bug 的进新 app；求稳的留旧 app。**旧表在任何情况下都不改写。**

---

## 1. 三个新 app（产品归组）

| App | 覆盖的会话形态 | 技术底座 |
|---|---|---|
| **地图 app** | 约会 · 群聊 · 探索 | 场景引擎（导演+演员）|
| **待办 app** | 任务 | 任务 = 一个 scene（同引擎）|
| **剧本 app** | 副本 / 多人副本 | 场景引擎（同引擎，**不用 `scenario_sessions`**）|

> 关键决策：**约会、群聊、探索、任务、副本、多人副本在场景引擎里是同一个东西**——都是「导演编排 + 多角色逐拍推进」的一场 scene。不区分专用会话表。

---

## 2. 数据分层：哪些共享 / 哪些独立

### 🟢 共享 —— 新 app **只读**，旧表**零写入**
| 表 | 内容 | 新 app 用途 |
|---|---|---|
| `players` | 玩家身份 | 身份绑定 |
| `characters` / `character_instances` | 角色卡 | 用同一个角色，延续人设 |
| `worlds` | 世界观 | 地图背景 |
| `player_permissions` / `character_permissions` | 钱包/权限 | 约会消费、权限流转 |
| `memory_embeddings` | 记忆向量池 | 检索通道（可写新 source_type，见 §7）|
| `chronicles` | 旧约会/短信折叠摘要 | **仅搜索**：只读旧记忆 |

> **relationships 的归属说明**：旧 `relationships` 与新 `scene_relationships` 是"旧只读 + 新写入"的关系——旧 `relationships` **仅搜索**（读历史关系状态），新 app 的关系写入只进 `scene_relationships`（§4）。二者不互写（§5-9：能迁移的旧关系首次迁移进新表后，新 app 读新表）。

### 🟡 共享 개념 —— 同概念，新 app 写**新表**承接
| 概念 | 旧表（只读）| 新表（新 app 写入）| 状态 |
|---|---|---|---|
| 玩家事实 | `player_facts` | `turn_player_facts`（带 player_id）| ✅ 已拉入 v2 |
| 场景记忆 | `chronicles` | `turn_memory_fold`（带 player_id）| ✅ 已拉入 v2 |
| 关系进度 | `relationships` | **新 `scene_relationships`**（待建）| ⏳ |
| 地点 | `locations` | **`scene_locations`**（全量复制 + 路人字段）| ✅ 已建 |

> **地点迁移的关键共识**：新地图表**全量复制**旧 `locations`（公共+私有都要），每条带 `npcs` 空数组，玩家在新地图添加的路人落新表。**旧表等完全替代后才删**，新表自足成为唯一事实源。

### 🟢 剧本（scenarios）——⛔ 已归档（2026-08-10）
- **现状**：旧剧本系统（`scenarios`/`scenario_sessions`/`scenario_messages`）已被场景剧本（`scene-scenario`，走 `scene_sessions` 表 `scene_type='scenario'`）替代。
- **归档措施**：
  - 桌面 🎭 剧本入口移至回收站 🗑️（ArchivedApps），标注「只读」
  - 后端 `scenario.ts` 所有写操作（POST/PATCH/DELETE）返回 403「旧剧本已归档」
  - GET 路由保留，历史数据可读
  - 回忆页新增 🎬 场景剧本页签（与 🧭 场景约会并列），旧剧本仍在「旧记录」折叠区
- **数据**：scene_sessions 表中 scene_type='scenario' 的记录通过回忆页场景剧本页签查看

### 🔴 各 app 独立 —— 会话过程数据，绝不共享
| 旧表（保留不动） | 所属 | 新表 |
|---|---|---|
| `conversation_sessions` + `messages` + `session_participants` | 地图 app | `scene_sessions` + `scene_messages` |
| `explore_sessions` + `explore_messages` | 地图 app（探索）| 同上（场景化）|
| `missions` | 待办 app | 任务场景化后走 `scene_sessions`（mission 元数据仍在 `missions`）|
| `scenario_sessions` + `scenarios` | 剧本 app | **弃用**，走 `scene_sessions` |

---

## 3. 会话记忆检索闭环（已确认）

```
新 app 场景轮        →  foldTurnSegment / foldOverview   →  turn_memory_fold（写）
新 app 玩家事实      →  foldTurnPlayerFact               →  turn_player_facts（写）
                                              │
新记忆（turn_*）     →  向量化 storeEmbedding            →  memory_embeddings（写新 source_type）
旧约会/短信折叠      →  chronicles（旧引擎写，新app不碰）→  memory_embeddings（旧 source_type，只读）
                                              │
检索 retrieveMemories(player_id, character_id) ←──────────────┘（不区分 source_type，一起搜）


- **写入侧**：新 app 只写 `turn_memory_fold` / `turn_player_facts` + 它们的向量化 embedding（新 source_type）。**不写** `chronicles` / `player_facts` / `relationships` 这些旧表。
- **搜索侧**：`retrieveMemories` 不带 source_type 过滤，一次同时召回旧记忆(chronicle) + 新记忆(turn_*)。天然的双保险——新旧并行期玩家时间线完整。
```
---

## 4. 新 scene 表（部分已建）

### ✅ `scene_locations`（已建）— 新地图表，全量复制 locations + 路人字段
实现于 `src/lib/scene-map.ts`（不动旧 schema.ts）。`ensureSceneMap()` 惰性建表 + 首启全量复制。
```sql
CREATE TABLE scene_locations (        -- 复制自旧 locations 全部列
  id, world_id, name, summary, creator_type, creator_id, character_instance_id,
  is_public, created_at, home_of, parent_id,
  npcs  TEXT NOT NULL DEFAULT '[]',   -- ⭐ 路人（地点的公共属性）：[{"id":"...","role":"服务生","name":"小周","persona":"..."}]
  updated_at INTEGER NOT NULL
);
```
- **全量复制 46 条**（公共 33 + 私有 13——私有地点作者也有添加路人的需求）
- **`npcs` 初始空数组**，`upsertNpc(locationId, npc)` 按 role 去重添加
- **路人是地点的公共属性**（非玩家私有），所有玩家打开该地点看到同样的路人（工具人配角）
- **id 与名字分离**：复制时沿用旧 `locations` 的语义化 id（如 `cafe`）以保证新旧对照；**新增地点自动生成 uuid id**（不手填简称、不与名字合并），名字可随时改不影响引用。
- **旧表最终要删**：但只在新地图 app 完全替代、验收通过后才删（不是现在）——新表自足，届时成为唯一事实源
- 已验证：46=46 复制一致、私有地点 13 条、路人增删覆盖正确、路人带独立 id

### `scene_sessions`（场景会话头）
```
id            TEXT PK
player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE
scene_type    TEXT NOT NULL   -- 会话来源归组标签。当前只有 'date'；随 app 开展按需加（§5-1）。非"分专用表"。
root_location_id TEXT REFERENCES scene_locations(id) ON DELETE SET NULL  -- 起始地点（指向新地图表，非旧 locations）
character_ids TEXT NOT NULL DEFAULT '[]'   -- 参与角色（JSON 数组，single/multi 均适用）
round_no      INTEGER NOT NULL DEFAULT 0   -- 当前轮号（导演/演员推进）
stats_state   TEXT NOT NULL DEFAULT '{}'   -- 导演数值状态（stats-functions 结算）
ended         INTEGER NOT NULL DEFAULT 0
created_at    INTEGER NOT NULL
updated_at    INTEGER NOT NULL
```
索引：`(player_id, ended)`、`(player_id, scene_type, ended)`

> **澄清**：`scene_type` 是会话**来源归组**的元数据标签，不是专用表——约会/群聊/探索共用这一张 `scene_sessions`。字段里原 draft 的 `level_label` 已随关系纯文本定案移除（见 §4 scene_relationships 修正）。

### `scene_messages`（场景消息明细）
```
id            TEXT PK
scene_session_id TEXT NOT NULL REFERENCES scene_sessions(id) ON DELETE CASCADE
round_no      INTEGER NOT NULL             -- 归属轮次
role          TEXT NOT NULL   -- 'player' | 'npc' | 'narration' 旁白 | 'director_note' 导演场记(内部)
character_id  TEXT NULL       -- 发言角色：玩家/角色用实例 id，路人用其 npc id；旁白 null
character_name TEXT NOT NULL  -- 角色名（时间线/回忆用）：旁白='旁白'，路人=路人名
text          TEXT NOT NULL
stats_delta   TEXT NOT NULL DEFAULT '{}'   -- 本轮 stats 变化（供回溯/结算）
created_at    INTEGER NOT NULL
```
索引：`(scene_session_id, round_no)`、`(scene_session_id, created_at)`

> **路人归属约定**：`scene_locations.npcs` 里的路人 `{id, role, name, persona}`——**每个路人自带唯一 `id`**（新建或读取旧路人时自动生成）。路人发言时 `character_id` 引用该路人 **id**（而非 character_name 兜底），用 name 显示名字。这样每个路人可被场景稳定引用、归属发言，无需为路人凭空造角色卡。

> **新建子地点约束（隐患2）**：玩家在新地图 app 新增子地点时，其 `parent_id` 必须指向 `scene_locations` 内已存在的父节点——保证新表内部父链完整、无悬空（绝不能指向旧 `locations` 里的 id）。


> 设计意图：
> - `scene_messages.role` 含 `narration`（旁白）和 `director_note`（导演场记，内部不展示）——这是场景引擎相对旧 `messages`（只有 player/assistant）的**本质新增**。
> - 一轮可能含多个角色多句，`round_no` 做轮次锚点，配合 `turn_memory_fold.round_min/max` 按轮折记忆。
> - `stats_delta` 每轮记录，支持「导演定值→stats-functions 算值→旁白照述」的闭环，并可在事后重算/回溯。

### `scene_relationships`（新关系表，承接 relationships 的写侧）
```
id            TEXT PK
player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE
character_id  TEXT NOT NULL
scene_session_id TEXT NULL    -- 最后一次写入关系的会话（追溯）
player_description TEXT NOT NULL DEFAULT '刚认识的陌生人'  -- 对齐旧 relationships.player_description（自由文本）
updated_at    INTEGER NOT NULL
```
索引：`(player_id, character_id)`、`(player_id, scene_session_id)`

> **机制对齐旧系统**：旧 `relationships.player_description` 不是等级阶梯，而是**每次 AI 回复时自由生成的文本**（`updatePlayerDescription` 原样覆盖，无递增/等级门槛）。"刚认识的陌生人"只是初始化默认值。
>
> **设计修正**：~~初版 `level_label`（阶段标签）~~ → **去掉**；~~`favor_index`（数值）~~ → **去掉**。还原为**与旧表一致的纯自由文本 `player_description`**，无等级、无升级、无触发。新 app 的关系写入同样是一次次覆盖 AI 生成的文本。

### ✅ 行程引擎统一（v2 起，旧 npc_schedules 退役）
- **旧行程引擎**（`getBaseSchedule` / `getOverriddenSchedule`，基于旧 `locations`/`location_homes`/`npc_schedules`）**已退役**：`npc_schedules` 表 0 行、无任何写入点、旧行程函数无调用者。
- **行程数据源统一**到 `getCurrentSchedule` → 新 `getSceneSchedule`（读 `scene_schedule_entries`），与地图 `/scene/map/npcs`、场景约会引擎**同一套数据**（避免"短信说在A、地图说在B"的两套行程割裂）。
- **朋友圈/主动短信的行程来源**随之切换到新源：`proactive.ts` 的 `checkScheduleChange` 用的是 `getCurrentSchedule`（新源），不再绑定旧地图。
- **约会中禁止主动短信/朋友圈（2026-08-07）**：`proactive.ts` 的 `checkScheduleChange`（行程变更→30%短信/20%圈）与 `getEligibleNpcs`（eligible 主动短信 + 离线积压）都新增**新老约会引擎双重排除**——旧 `conversation_sessions` + 新 `scene_sessions`（`json_each(character_ids)` 匹配 + `ended=0`）。约会中（无论新老）角色不主动发短信/朋友圈。




---

## 5. 待讨论的开放问题（Open Questions）

1. **(已定案) scene_type**：**随用随加**，不预设固定枚举。当前只需 `date`（地图 app 约会/群聊/探索同源）；`mission`/`dungeon` 等待待办/剧本 app 开展时再按其需求加入。现在纠结枚举名无意义。

2. **(已定案) 关系的表达**：**纯自由文本**。对齐旧 `relationships.player_description`——每次 AI 回复时自由生成一段关系描述，直接覆盖，**无等级、无升级、无触发、无数值**。`scene_relationships.player_description` 承接同一机制。

3. **(已废弃) ~~关系的升级触发~~**：概念不成立——旧系统不存在"升级阶梯"，关系就是文本一次次覆盖，无 level 状态机，故"何时升级/触发"无意义。此问题作废。


4. **(已定案) 场末整场收尾摘要**：**要**。在任务/副本这类有明确结束节点（乃至所有场景）结束时，额外生成一条**整场收尾摘要**（对齐旧 `foldChronicle` 的 session 收尾），写进 `turn_memory_fold`，供玩家跨场回忆整体印象，而非只有零散轮摘要。

5. **(搁置) 任务系统**：任务（`missions`，`available/in_progress/completed` + reward）目前**很鸡肋，要大改甚至可能去掉/重建任务模式**。因此任务迁移**暂不设计**——`missions.status` 落旧表还是新表，等任务系统重做定案后再说，现在纠结落哪无意义。

6. **(已定案) 群聊形态**：**场景回放，有旁白**。群聊统一进「场景回放」视图，由导演编排、含环境旁白，不是旧式并列消息列表。

7. **(已定案) 探索的「发现物」**：**先纯旁白**（导演编排的一拍，无独立事件标记）。物品系统尚未做——等做了物品系统，再像数值系统一样把物品作为可调用资源**注入旁白**。当前只需叙事性发现物。

8. **(已定案) 切换/验收标准**：**由星落定**。旧 app 入口保留到新 app 完全覆盖功能；验收标准（feature parity checklist）由星落亲自定，不进代码自动判定。

9. **(已定案) 旧关系/记忆的迁移**：**A——能迁移就迁移，不能迁移就只读**。新 app 首次进入时，旧 `relationships` 里能映射到 `scene_relationships` 的（关系状态/亲密度描述）**迁移过去**；无法结构化迁移的（如 `chronicles` 折叠摘要，无干净关系字段）**保持只读**，靠 `retrieveMemories` 搜索沿用。


10. **(搁置) 任务状态耦合**：随问题 5 一起搁置——任务系统重做前，`missions.status` 与 scene 目标达成的关系不讨论。


11. **(搁置) 剧本 app 重做需求**：搁置的剧本迁移，重做时需定——剧本模板结构（含旁白/路人需求）、单人/多人玩法、与场景引擎的映射、旧 9 条剧本资产如何承接。

12. **(已定案) `scene_locations` 与旧 `locations` 的同步**：**两表各自独立演进，不做自动实时同步**。旧地图的新地点只写旧 `locations`；新地图 app 的新地点只写 `scene_locations`。一致性由**维护者手动/定期维护**（背景比对补齐），不进代码自动同步。`scene_locations` 是一次性复制快照后独立。

13. **(已定案) 新 app 的开放形态**：**开放入口，明确标注施工中/测试中**。不设硬性内测门槛——新 app 在入口图标和名字上注明「施工中/测试中」，让求稳的玩家避开；求新的玩家可进，接受半成品 bug。符合 §0「玩家自主选择」本意。

14. **(已定案) 新旧 app 的感情连续性**：**靠记忆检索，非字段同步**。`retrieveMemories` 不带 source_type 过滤，一次同时召回旧记忆（chronicle）+ 新记忆（turn_*）。因此新 app 能拿到旧 app 的全部折叠摘要，感情天然连贯——**无需"每次进入对旧表"**。旧 app 读不到新记忆，是渐进替代下可接受的单向代价（新 app 是方向）。§9 的"迁移"即此含义：不是搬一次断，而是检索天然贯通。


---

## 6. 实施路径（草案）

```
Phase 0  出本文档，讨论并定案 Open Questions
Phase 1  建新 scene 表
         ├─ scene_locations（✅ 已建：全量复制 locations + 路人字段）
         ├─ scene_sessions / scene_messages / scene_relationships（✅ 已建：src/lib/scene-session.ts）
Phase 2  场景引擎接入新表：写 scene_messages、按轮折 turn_memory_fold、结算写 scene_relationships
Phase 3  地图 app 首个试点（约会最简形态）→ 真 LLM 端到端验证
Phase 4  群聊 → 探索 → 任务 → 副本/多人副本，逐个场景化
         └─ 剧本 app：【搁置】等旁白/路人等需求定案、重做后再设计迁移
Phase 5  每形态与旧 app 做 feature parity 验收，达标后下线旧表/旧入口
```

---

## 7. 不变式（红线）

- **旧表零改写**：`conversation_sessions` / `messages` / `chronicles` / `player_facts` / `relationships` / `locations` / `scenario_sessions` 等旧表，新 app 一律**只读或完全不碰**，绝无写入。
- **memory_embeddings 是可写的**：它是统一的向量池，新记忆（turn_*）**向量化后写入**它（以 `turn_segment` / `turn_player_fact` / `turn_overview` 等新 source_type 落库），供 `retrieveMemories` 一起检索。**"不写入"仅指旧记忆条目（chronicle/fact 那种旧 source_type），不是禁止新向量入库。**
- **新路由全走新表**：新 app 的任何会话/记忆数据，只写 `scene_*` + `turn_*`（含它们的向量化 embedding）。
- **渐进替代**：旧 app 保留，直到新 app 完全覆盖其功能并验收通过（验收标准由星落定）。

