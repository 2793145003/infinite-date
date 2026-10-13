# 衍生世界（修仙程序化世界演化）—— ⏸️ 已冻结

> 内部代号：`infinite-derivative-world`（代码、表名 `derivative_worlds` 沿用此名）。
> **状态：功能完整可用、测试全绿，但作者试用后判定不好玩，2026-09-25 起冻结，不再迭代。**
> 入口保留在「设置 → 更多功能 → 实验功能 → ⛰️ 衍生世界」，代码与存档都不删（玩家已开的世界继续可读）。
> 冻结结论原话：「衍生世界没我想象中好玩」。

---

## 一、一句话

把「一个世界自己在动、玩家只遇到并选择其中少数人」做成主线恋爱之外的另一种玩法：
**世界由程序规则（五行生克 + 六爻六亲）演化，只有玩家遇见并选中的 NPC 才动用 LLM**（懒加载人设卡 + 对话）。

## 二、设计基石：成本

40 个 NPC 的世界，如果每个都让 LLM 建档 + 自由对话，成本与延迟都不可接受。折中是三层：

1. **背景层（0 token）**：NPC 先只是「数值 + 履历」——五行、境界、资质/悟性/魅力/气运、寿元、门派、九宫格阵营、MBTI、好感表。`liveliness=0`。
2. **世界演化（0 token）**：每月一次 `tick`，由纯函数 + 五行生克决定谁和谁发生什么（争执/夺宝/生死斗/提携/赠宝/结缘/切磋/竞争机缘/突破/渡劫/陨落/制造），写成事件日志（`public`/`private` 两档可见性）。
3. **升格后才用 LLM**：玩家走格子遇到 NPC → 该 NPC `liveliness=1`（「遇见的才活过来」）→ 才用 LLM 读「基础属性 + 已积累履历」生成人设卡；此后对话也走 LLM。

对话回复带 `fact` 字段（一句谁/何事/结果的事实），由程序层写回履历 `desc` —— **NPC 说过的话进入世界事实**，保证后续人设卡与事件有据可依、可追溯。

## 三、玩法闭环

| 步骤 | 说明 |
|---|---|
| 开一界 | 命名 + 规模（默认 40 NPC / 2×2 区域 / 每区 8×8 = 256 格）+ 种子；种子决定全部生成，可复现 |
| 走格子 | 移动消耗行动点/精力，同格 NPC 触发「相遇」升格 |
| 对话 | 与已升格 NPC 多轮对话（LLM，历史落 `chat_history`） |
| 介入 | 世界事件在「生成」与「结算」之间留窗口，玩家可 帮A / 帮B / 劝架 / 旁观，改变结局与双方好感 |
| 炼制 | 二消盘面（金木水火土 + 灵石/仙晶/丹炉，交换→消去→连锁）+ 配方（材料/门派/成功率）出丹药/法宝/秘籍 |
| 时间推进 | 休息/闭关跳月（`advance N 月`），精力耗尽自动结算；岁月会推进寿元与突破 |

## 四、代码索引

### 1. 引擎 `apps/server/src/world/`（16 文件 / 2202 行）

| 文件 | 行数 | 作用 | 关键导出 |
|---|---|---|---|
| `types.ts` | 236 | 类型与常量：五行/六亲/九宫格/MBTI/境界/事件类型与可见性/存档结构/人设卡与对话回复 | `REALMS`、`REALM_LIFESPAN`、`REBIRTH_REALM`、`EVENT_VISIBILITY` |
| `world.ts` | 551 | **WorldEngine**：构造/`serialize()`/`buildWorldFromSave()`；`advance()` 推进一月（事件生成与结算分离，介入插中间）；`playerMove()` 相遇升格 | `WorldEngine` |
| `rng.ts` | 66 | mulberry32 + 可序列化 RNG 状态（存档后继续同一条确定性序列） | `makeRng`、`makeRngState`、`pick`、`chance` |
| `map.ts` | 123 | 走格子地图（大方格套小方格） | `WorldMap` |
| `npc.ts` | 116 | 按五行/门派/阵营/MBTI 生成 NPC 与初始背包 | `generateNpc`、`generateNpcs` |
| `player.ts` | 35 | 玩家修士（默认女修；精力/行动点） | `createPlayer` |
| `items.ts` / `recipes.ts` | 54 / 43 | 物品与配方（含门派限定配方） | `generateItem`、`RECIPES`、`recipesForFaction` |
| `craft.ts` | 99 | 制造结算：材料校验、NPC 制造、玩家制造（吃二消分数定品质） | `hasMaterials`、`npcCraft`、`playerCraftResult` |
| `match2.ts` | 231 | **二消引擎**（纯函数）：十字匹配、连锁、可行步检测、自动游玩、分数→品质 | `findMatches`、`trySwap`、`autoPlay`、`scoreToQuality` |
| `wuxing.ts` | 55 | 五行生克判定 | `isXiangSheng`、`isXiangKe` |
| `intervene.ts` | 116 | 可介入事件判定 + 介入结算（含结局文案） | `isIntervenable`、`applyIntervention` |
| `llm.ts` / `llm-prompt.ts` / `llm-schema.ts` | 49 / 107 / 86 | 懒加载人设卡 + 对话：prompt 组装（履历→时间轴、女修手札式生平）、guidedJson schema、输出归一化 | `generateCharacterCard`、`chatTurn`、`buildCardMessages`、`buildChatMessages`、`normalizeCard`、`normalizeChat` |
| `runner.ts` | 235 | **离线 runner CLI**（无 DB、无 web，直接在终端看世界怎么动） | — |

### 2. 路由 `apps/server/src/routes/world.ts`（357 行，已在 `index.ts` 注册）

| Method | Path | 功能 |
|---|---|---|
| POST | `/world` | 创建衍生世界（可传 name/seed/npcCount/regions/cells） |
| GET | `/world` | 我的世界列表 |
| GET | `/world/:id/state` | 世界状态（地图/玩家/NPC/事件） |
| POST | `/world/:id/advance` | 推进 N 月（休息跳月/闭关） |
| POST | `/world/:id/move` | 走格子（移动 + 相遇升格） |
| POST | `/world/:id/talk` | 与 NPC 对话（LLM） |
| POST | `/world/:id/craft/start` | 开始炼制（生成二消盘面） |
| POST | `/world/:id/craft/swap` | 二消交换（纯函数，无状态） |
| POST | `/world/:id/craft/finish` | 炼制结算（出成品） |
| DELETE | `/world/:id` | 删除世界 |

### 3. 数据表 `derivative_worlds`（`db/schema.ts`）

每玩家一档；**整个 WorldEngine 状态序列化进 `save_data`（JSON）**，每次请求「恢复 → 操作 → 落库」：

- `seed` 世界种子 / `save_data` 快照（tick、npcs、events、map、player、rngState）
- `chat_history` 对话历史（`{ [npcId]: [{speaker,text}] }`，与快照分开存）
- `tick` 当前月（冗余列，列表页展示）/ `status` / `created_at` / `updated_at`

### 4. 前端 `apps/web-v4/`

- `components/DerivativeWorldApp.tsx`（493 行）：世界列表 + 世界页（地图/玩家/NPC/事件流）+ 对话弹窗 + 炼制弹窗 + 时间推进
- `components/ExperimentalApp.tsx`：实验功能门（副标题「修仙界演化，遇见的才活过来」）
- `lib/api.ts`：`worldCreate/worldList/worldState/worldAdvance/worldMove/worldTalk/worldCraftStart/worldCraftSwap/worldCraftFinish/worldDelete` + `World*` 类型

### 5. 单测（8 文件 / 75 例，全绿）

`world-craft`(13)、`world-engine`(9)、`world-llm`(16)、`world-map`(6)、`world-match2`(8)、`world-player`(8)、`world-serialize`(3)、`world-wuxing`(12)。
（`src/test/world-state.test.ts` 是**互动小说**的世界状态抽取单测，与本文档无关。）

## 五、怎么跑 / 怎么验

```bash
# 单测（全量 207 例，含衍生世界 75 例）
cd apps/server && npm test

# 离线看世界自己动（纯演化，不连 DB / 不起 web）
cd apps/server && npx tsx src/world/runner.ts --months 36 --seed 42 --npc 16 --grid 8

# 离线跑玩家模式（走格子 + 介入 + 升格 + 炼制）
cd apps/server && npx tsx src/world/runner.ts --player --months 24 --seed 42 --npc 16 --regions 3 --cells 3

# UI：设置 → 更多功能 → 实验功能 → ⛰️ 衍生世界
```

## 六、冻结说明

- **为什么冻**：作者试用后判定不好玩（「没我想象中好玩」），停止迭代。世界是程序演化出来的、关系不是玩家的关系：走格子/介入/炼制给的是操作感，不是恋爱主线那种情感回报。
- **保留状态**：代码、路由、实验入口、数据表一律保留；已创建的世界存档不清理，随时能打开看。
- **不删的理由**：其中若干部件与主线无关且可独立复用（见下），删了要重写。

### 可复用资产（将来别的玩法可以直接拿）

1. **二消引擎** `match2.ts` —— 纯函数、有 8 例单测，可直接当小游戏内核。
2. **五行生克 + 六爻六亲关系模型** `wuxing.ts` / `types.ts`（六亲：父母/子孙/官鬼/妻财/兄弟）—— 一套「谁和谁会起什么关系」的判定表，比随机抽事件有质感。
3. **可序列化 RNG + 存档恢复模式** `rng.ts` + `WorldEngine.serialize()` —— 世界状态整体快照进一列 JSON，请求级「恢复→操作→落库」，适合任何长期演化的沙盒。
4. **成本控制范式**：**「背景层 0 token + 被选中的少数才 LLM」**。想让一个世界有几十上百个 NPC 又不想烧 token 时，这套懒加载人设卡（含「把履历串成生平」的 prompt）是可搬的。

### 已知缺口（冻结时未做）

- 与主线完全隔离：衍生世界里的人不是你的崽，不进 characters/行程/朋友圈/短信，也没有任何跨系统联动。
- 无长期目标与结局线：只有境界/寿元/好感的数值推进，没有「这一世要干什么」的收束。
- 「女修手札式」只落在人设卡的 `backstory` 文案里，**没有独立的回顾/手札界面**（想读这一世发生过什么，只能翻事件流）。
- 炼制只有玩家侧四配方，NPC 侧只走概率结算，没做市场/交易。
