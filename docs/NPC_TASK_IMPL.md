# NPC 任务（邀请任务）实现方案

> 状态：**实现方案（待星落过目后开工）**
> 配套：设计 `NPC_TASK_DESIGN.md`；世界任务 `HEXAGRAM_MISSION_DESIGN.md`；数据模型 `DATA_MODEL.md`；任务总纲 `DESIGN.md` §2.4。
> 温馨向模板：`apps/server/src/prompt/templates/mission.worldgen-cozy.txt`（已定稿并跑通验证）。

---

## 〇、概览

把 `NPC_TASK_DESIGN.md` 的设计 + 已定稿的温馨向模板，落成生产链路：**系统按 NPC 种子摇卦 → 生成"锦上添花"小事 → NPC 发短信邀玩家 → 玩家接受（一起做）/ 拒绝（NPC 独自做）→ 收尾发权限**。

### 已定稿的核心决策（模板迭代产出，均已在模板/实验脚本固化验证）

1. **锦上添花定位**：小事非困境，去了很暖、不去没事，拒绝无心理负担。
2. **主神任务元叙事**：主神（系统）给 NPC 派任务，NPC 去平行世界帮"有心愿的人"办成小事 = NPC 上班挣权限；NPC 是接任务主角，玩家是受邀帮手的同伴。
3. **八卦类象层**（替代六亲层）：本/变/互卦的上下单卦各随机 roll 2 个意象喂 LLM，物象级、天然是生活小事量级。
4. **男主完整人设注入**：姓名 / 性别 / 性格三层 / 擅长与不擅长 / 过去经历（出身·经历·现状 + 故事里程碑）。
5. **玩家性别人设注入**：性别 + persona_notes。
6. **主题照随机任务 12 类全量**（不搞温馨白名单）：古风/仙侠/民国/都市/乡村/西幻/科幻/日式/灵异/末世/悬疑/二次元；温馨向模板的"不生成困境/危险/生死"约束会把灵异/末世等软化成温馨小事（已验证）。
7. **战斗玩法去暴力化**：`战斗 → 动手出力的小事（教人/陪练/锻炼/除虫害/驱赶捣乱小动物）`，不是打架/对抗敌人。
8. **世界 NPC role 二选一**：只有"有心愿的人 / 搭把手的人"，无"小麻烦"；被驱赶/被除的对象（小鸟/虫害/机械宠物）是环境，写进 `environmental_clues`/`world_tension`，不进 `world_npcs`。

---

## 一、数据模型变更（migration）

### 1.1 新增列

```sql
-- missions：玩家拒绝后 NPC 独自完成的时刻；接受分支为 NULL
ALTER TABLE missions ADD COLUMN solo_complete_at INTEGER;

-- relationships：该 NPC 今天已发过任务邀请的北京日 key，空=今天没发过
ALTER TABLE relationships ADD COLUMN last_task_invite_day TEXT;
```

### 1.2 枚举值对齐（纯值，无 CHECK 约束，不需改 schema）

| 字段 | 现有值 | 新增/修正 |
|---|---|---|
| `missions.quest_type` | `'character' / 'world' / 'npc'`（注释已含 npc） | 启用 `'npc'`（代码开始写入） |
| `missions.assignee_type` | `'player' / 'character'` | **修正设计文档 §四的笔误**：NPC 任务用 `'character'`（不是 `'npc'`），`assignee_id = 邀请 NPC 的 character_id` |
| `missions.status` | `available / active / completed / declined` | 新增 `'solo'` |
| `missions.character_id` | 世界任务=同行 NPC | NPC 任务=邀请 NPC 的 character_id（`DATA_MODEL.md` L406 注释已明确） |

状态流转：

```
available ──玩家接受──▶ active ──玩家结束──▶ completed
    └──────玩家拒绝──▶ solo ──到点──▶ completed
```

### 1.3 同步更新 `DATA_MODEL.md`

- `missions` 表注释补 `solo_complete_at` 列 + `status` 加 `'solo'`。
- `relationships` 表补 `last_task_invite_day` 列。
- 迁移历史章节（L1160 起）追加本次 migration 条目。

---

## 二、生成链路 `buildNpcMission`

新增函数 `buildNpcMission(playerId, npcCharacterId): Promise<BuiltMission>`，放 `routes/mission.ts`（或抽出 `lib/npc-mission.ts`），与世界任务的 `buildWorldMission` 并列。

### 2.1 起卦（NPC 种子，不占玩家灵）

```ts
const seq = COUNT(*) FROM missions WHERE player_id = ? AND quest_type = 'npc';
const div = castHexagram(npcCharacterId, 'npc', seq, { date: 今天 });
// seed = npcCharacterId + 时辰 + 'npc' + seq —— 确定性；玩家不掷爻，无 cast
```

### 2.2 roll（复用世界任务的确定性 roll，保证不收敛）

```ts
const theme = rollTheme(playerId, npcSeq);     // 12 类主题
const goal  = rollGoal(playerId, npcSeq);      // 5 种玩法
const cards = rollWorldCards(playerId, npcSeq, theme); // 命名卡
```

> 注意：`rollTheme/rollGoal` 的 seed 用 playerId（保证同一玩家任务不重复），起卦 seed 用 npcCharacterId（NPC 不占玩家灵）。两者分开。

### 2.3 渲染温馨向模板（`mission.worldgen-cozy.txt`）

注入变量：

| 变量 | 来源 |
|---|---|
| `hexagram_layer` | `cozyHexLayer(renderHexagramLayer(div))`（标签换温馨语：本卦=需要帮忙的小事 等） |
| `bagua_xiang_layer` | `renderBaguaXiangLayer(div)`（本/变/互卦上下单卦各 roll 2 意象） |
| `theme_guide` | `renderThemeGuide(theme)` |
| `world_cards` | `renderWorldCards(cards)` |
| `goal_guide` | 温馨化玩法引导（战斗→动手出力小事 等，见 §2.5） |
| `companion_name` | `char.name` |
| `companion_gender` | `char.gender`（male→男 / female→女） |
| `companion_persona` | `formatPersonality(char)`（表面/内核/极端三层） |
| `companion_skills` | `formatSkills(char)`（擅长 / 不擅长） |
| `companion_backstory` | `formatBackground(char)` + `formatBackstoryMilestones(char)`（出身/经历/现状 + 里程碑） |
| `player_gender` | `players.gender`（male→男 / female→女 / 未设定） |
| `player_persona` | `players.persona_notes`（空则留空） |

男主信息复用 `prompt/builder.ts` 现有 `formatPersonality/formatSkills/formatBackground/formatBackstoryMilestones`（都是 `formatCharacterCard` 的子函数），**不新写重复逻辑**；可加一个 `formatNpcMissionProfile(char)` 聚合上述五段，供 worldgen 单独用。

### 2.4 落库

```ts
INSERT INTO missions (id, player_id, quest_type, assignee_type, assignee_id,
                      character_id, world_id, title, description, status,
                      reward, metadata, created_at)
VALUES (?, ?, 'npc', 'character', npcCharacterId, npcCharacterId,
        worldId, world.name, world.summary, 'available', 0, ?, now);

INSERT INTO worlds (id, world_type, ...) VALUES (worldId, 'mission', ...);  -- 原创一次性世界
```

- `metadata` 存温馨向结构化数据（世界设定/地标/世界 NPC/小事表象/目标态/小插曲/降临身份/任务目标/卦象档案），结构对齐世界任务的 `meta`。
- `reward` 落库填 0，实际数额在收尾时从 `getCosts()` 读（见 §九）。

### 2.5 温馨化玩法引导（goal_guide）

5 种玩法温馨化映射（已定稿）：

| 玩法 | 温馨化 |
|---|---|
| 战斗 | 动手出力的小事：教人/陪练/锻炼/除虫害/驱赶捣乱小动物 |
| 寻物 | 找走丢的人或物 |
| 破案 | 小谜题/失物 |
| 和解 | 说和 |
| 守护 | 照看/陪伴 |

---

## 三、触发 `checkNpcTaskInvite`

新增 `checkNpcTaskInvite(playerId)`，挂进 `moment-scheduler.ts` 的 5 分钟 tick（与 `checkScheduleChange` 并列，每个 player 顺序执行）。

对每个好友 NPC 做 4 条廉价判定（全 DB 读 + 时间比对，**无 LLM**，不放进高频路径）：

1. **是好友**（`friendships` active）；
2. **空档段**：当前行程段为空档，且**不含约会中**（复用"约会中排除"）、**不含睡觉段**（睡着不触发）；
3. **玩家无进行中现场**（`getActiveLiveSlot` 为空，不打断话题）；
4. **该 NPC 今天没发过邀请**（`relationships.last_task_invite_day != 今天`）。

判定通过才调 `buildNpcMission`（一次 LLM 调用）。生成成功 → 落库 → 发短信邀请（§四）→ 记 `last_task_invite_day = 今天`。

---

## 四、邀请短信

- 走短信通道（`text_messages`），NPC 按人设生成邀请语（"我接了个活儿，要不要一起？"的轻松邀约调调）。
- 复用 `npc_invite` 的交互模式：短信里出「接受 / 拒绝」按钮。
- 前端 `SmsApp` 增加"任务邀请"类型标记（与"约会邀请"区分，见 §十）。
- 短信落库时记 `relationships.last_task_invite_day = 今天`，当日不再邀请。

---

## 五、接受 / 拒绝分流

### 5.1 接受（`POST /missions/:missionId/accept`）

对 `quest_type='npc'` 放开（现 WHERE 写死 `quest_type='world'`）：

- **不需要 `companionId`**：同行者就是邀请 NPC 本人（`assignee_id`），跳过"选同伴"校验。
- 其余复用世界任务 accept 链路：互斥校验 → `status='active'` + `started_at` → 建 `temp-{missionId}` 地图 + 世界 NPC 写入 + 子地点 → `scene_sessions` 建 `scene_type='mission'` 会话 → 开场旁白。
- `character_ids` 填邀请 NPC，`npc_roles` 写男主降临身份（复用世界任务的人称改写逻辑）。

### 5.2 拒绝（`POST /missions/:missionId/decline`）

`quest_type='npc'` 语义**不是作废，是转 solo**：

```
status = 'solo'
solo_complete_at = now + random(1h, 3h)
```

**完成时长统一 1~3 小时随机**（星落拍板，不分玩法）：太长了玩家等得无聊；若情节需要更长，用世界观兜底——「任务世界时间流速与主城不一样」，主城 1~3 小时在任务世界里可以是半天。

---

## 六、solo 到点回归

后台 tick（复用 moment-scheduler 或新建轻量扫表）扫 `status='solo' AND solo_complete_at <= now` 的任务：

1. `status → 'completed'` + `completed_at`；
2. NPC 回主城，发短信："抱歉，之前在任务世界，回来晚了" + 分享做成了什么（LLM 按人设 + 任务内容生成，不带遗憾），顺带回应任务期间玩家发来、未即时回的消息；
3. 权限：NPC 独自完成拿**极少**（见 §九，显著低于合作收益）。

---

## 七、在线状态 + 在场排除

### 7.1 在线状态 mission 态（补 TODO）

`lib/schedule.ts` `getNpcOnlineState` L155 的 TODO 占位，补一行 SQL：

```ts
const hasSoloMission = db.prepare(`
  SELECT 1 FROM missions
  WHERE player_id = ? AND quest_type = 'npc' AND assignee_id = ?
    AND status = 'solo' AND solo_complete_at > ?
  LIMIT 1
`).get(playerId, characterId, now);
if (hasSoloMission) return 'mission';
```

### 7.2 在场/行程/主动短信排除

所有查"NPC 在场/位置"的消费方加 `NOT EXISTS`（solo 进行中排除，与"约会中排除"同模式）：

- 地图在场（`/scene/map/npcs`）
- 行程（`getSceneSchedule` / `getCurrentSchedule`）
- 主动短信（`proactive.ts` `checkScheduleChange`）

---

## 八、结束链路（简单判断 + 宽松评分）

`POST /missions/end` 按 `quest_type` 分流：

- **`quest_type='world'`**：保持现状（`evaluateWorldMission` 严格数值判定 + LLM 评级）。
- **`quest_type='npc'`**：新增 `finishNpcMission`，**不跑数值判定、不搞严格评级**：
  - 评分 = 任务世界里的 NPC 给个好评：完成得差不多就是好评，不卡玩家（星落拍板「反正完成个差不多，就是好评」）；
  - 收尾：`endSceneSession` + 删 temp 地图 + 权限到账（双方，见 §九）；
  - 不更新玩家 `rating_score`（NPC 任务无评级）。

> 最简实现：收尾时让「有心愿的人」按人设给一句好评反馈（LLM 按人设 + 任务内容生成），作为任务结果呈现；好评不设门槛，办得差不多就发全款合作收益。

---

## 九、权限外置

`lib/permission-config.ts` `getCosts()` 追加 NPC 任务两档（与世界任务 `mission_base_reward`/`mission_coop_bonus` 同模式，全外置不硬编码）：

| 配置键 | 含义 |
|---|---|
| `npc_mission_coop_reward` | 玩家接受：玩家 + 邀请 NPC 双方各获（合作收益，显著高） |
| `npc_mission_solo_reward` | 玩家拒绝：仅 NPC 独获（极少，体现"跟玩家一起才赚得多"） |

> 权限消费数值体系（`permission_costs` 消耗）**维持全 0**（星落拍板），等礼物和物品系统做完再定值——不阻塞本链路。

---

## 十、前端

`apps/web/src/SmsApp.tsx` 增加"任务邀请"类型标记，与"约会邀请"区分（不同图标/文案），复用接受/拒绝按钮；点击接受走 `accept`（不带 companionId）、拒绝走 `decline`。

---

## 十一、实施顺序（建议）

1. **① migration**（§一）：加 2 列 + 同步 `DATA_MODEL.md`。
2. **② 生成**（§二）：`buildNpcMission` + 男主/玩家信息注入，先照实验脚本 `experiment-worldgen-cozy.ts` 的组装逻辑落生产，跑通落库。
3. **③ 触发 + 邀请短信**（§三、§四）。
4. **④ 接受/拒绝/solo/结束分流**（§五、§六、§八）。
5. **⑤ 在线状态 + 在场排除**（§七）。
6. **⑥ 权限外置**（§九）。
7. **⑦ 前端**（§十）。

每步一个小 commit，逐步验证（先建任务→看生成质量→再接邀请→再走完拒绝/接受两条分支）。

---

## 附录：与设计文档的一处不一致（已在本方案修正）

`NPC_TASK_DESIGN.md` §四 写 `assignee_type='npc'`，但 `DATA_MODEL.md` L404 注释为 `'player' | 'character'`。本方案统一为 **`assignee_type='character'`**（任务承担者是角色），`assignee_id = 邀请 NPC 的 character_id`。设计文档 §四 后续应同步改一处。
