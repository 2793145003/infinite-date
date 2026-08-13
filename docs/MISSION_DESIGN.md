# Phase 4 任务系统设计文档

> 三种任务的设计梳理。世界任务已实现，角色任务和NPC任务待实现。

---

## 现状总览

| 任务类型 | 状态 | quest_type | 已有数据 |
|----------|------|------------|----------|
| 世界任务 | ✅ 已实现 | `world` | 13条记录 |
| 角色任务 | ❌ 未实现 | `role`（待定） | 5个NPC有里程碑 |
| NPC任务 | ❌ 未实现 | `npc`（待定） | 8个NPC有skills字段 |

### 已有基础设施
- `missions` 表：`quest_type` / `assignee_type` / `assignee_id` / `character_id` / `world_id` / `status` / `reward` / `evaluation_result` / `rating_score` / `metadata`
- `worlds` 表：`world_type='mission'` 标记任务世界
- `backstory_milestones`：角色卡字段，含 `label` / `time_description` / `summary` / `diff` / `dramatic_potential`
- `skills` / `ineptitudes`：角色卡字段，自由文本描述角色擅长/不擅长的事
- 世界任务完整链路：生成→接受→约会→评级（`mission.ts`）
- `formatCharacterCard()`：角色卡注入prompt
- `foldChronicle()`：记忆折叠
- 短信系统：`sms.ts` 可发NPC短信
- 邮件系统：`email.ts` 可发系统邮件

---

## 一、角色任务：填补意难平

### 核心概念
进入NPC过去的某个时间切片，遇到那个时期的镜像NPC，经历/改写一段意难平。回到现在后NPC"做梦"——记忆没被真正改写，但对自己的看法变了。

### 设计文档已确定
1. 从 `backstory_milestones` 选一个里程碑（优先 `dramatic_potential: high`）
2. 镜像NPC = 当前角色卡 + 里程碑 `diff` 覆盖
3. 任务世界基于里程碑 `summary` + `time_description` 生成
4. 角色任务不判断完成——经历就行
5. 玩家可以选择不去
6. 任务结束后NPC"做梦"：根据镜像期间记忆摘要，更新一次 `player_description`（source_type='dream'）
7. 临时Chronicle：任务session生成Chronicle用于做梦，dream后丢弃
8. 可重复进入（之前讨论方向）

### 待讨论问题

#### ① diff 全是空的怎么办？
所有NPC的 `backstory_milestones[].diff` 都是 `{}`。镜像NPC和现在一模一样。

- **方案A**：不强制要diff。用 `time_description` + `summary` 在prompt里描述"这是你XXX时期"，靠LLM自己理解那个时期的NPC状态。简单，但镜像感弱。
- **方案B**：触发时调LLM补生成diff。根据当前角色卡+里程碑summary，让LLM输出"那个时期的NPC和现在有什么不同"。多一次LLM调用，但镜像感强。
- **方案C**：创建/编辑角色卡时就让LLM生成diff。改创建流程，影响已有数据需要回补。

#### ② 触发方式
设计说"随机触发"，但之前讨论过"有邀请触发"。

- **方案A**：NPC主动发短信。"我最近总梦见过去的事……" → 玩家回复触发
- **方案B**：系统邮件通知。"检测到XXX的记忆共鸣，可进入过去的时间切片"
- **方案C**：玩家主动触发。在NPC详情页看到"意难平"入口
- **方案D**：约会结束时概率触发。约会结束→系统判断关系深度→if达标→NPC发短信邀请

#### ③ 关系门槛
之前讨论用 `foldChronicle` 判断关系深度。

- 角色任务要求Chronicle折叠次数≥1（至少经历过一段完整关系阶段）
- 还是另设标准？如好友时长、约会次数、player_description长度？

#### ④ 做梦机制流程
- 什么时候触发？约会结束时自动触发？
- 梦的内容：NPC发一条短信？还是只静默更新player_description？
- 临时Chronicle怎么清理？删除Chronicle行+对应的memory_embeddings？

#### ⑤ 技术实现要点
- 镜像NPC怎么注入？新建一个prompt模板 `role-mission.system.txt`？
- `conversation_sessions` 的 `mode` 字段加 `'role_mission'`？
- `missions.metadata` 存什么？里程碑ID？镜像diff？
- 可重复进入：每次进入生成新mission？还是复用同一个mission记录？

---

## 二、NPC任务：角色特长，温馨向

### 核心概念
系统发给NPC，NPC根据关系主动邀请玩家。任务和角色的 `skills` 相关——展示角色好的一面。NPC没有玩家也能完成，但玩家在会更好。

### 设计文档已确定
1. 系统发给NPC，NPC主动邀请玩家（玩家可拒绝）
2. 任务和角色 `skills` / `ineptitudes` 相关
3. NPC没有玩家也能完成——玩家是帮手不是主角
4. 玩家拒绝 → NPC独自完成 → 发短信分享喜悦，不带遗憾
5. 玩家接受 → 一起经历 → 更丰富互动 → 权限到账
6. 不判断完成——经历就行
7. player_description 自然累积

### 与角色任务的差异
| | 角色任务 | NPC任务 |
|---|---|---|
| **主角** | 玩家 | NPC |
| **世界** | NPC的过去（重建） | LLM生成的温馨世界 |
| **NPC** | 镜像NPC（过去的版本） | 当前的NPC本人 |
| **情绪** | 意难平、遗憾、改写 | 温馨、特长展示、善意 |
| **可重复** | 讨论中 | 讨论中 |
| **判断完成** | 不判断 | 不判断 |
| **触发** | 讨论中 | NPC邀请 |

### 待讨论问题

#### ① 世界怎么生成？
角色卡有 `skills` 字段（自由文本）。世界任务已有 `mission.worldgen.txt` 模板。

- **方案A**：复用世界任务的worldgen模板，加一段"根据角色skills生成温馨场景"的上下文
- **方案B**：新建 `npc-mission.worldgen.txt`，专门针对温馨向优化——世界小而温暖，不需要复杂的地标和势力

#### ② NPC邀请怎么实现？
- NPC发短信？"我想去做一件事，你要一起来吗？"
- 短信内容怎么生成？调LLM？还是模板？
- 玩家在短信里回复"好"/"不去"触发接受/拒绝？

#### ③ NPC独自完成怎么表现？
玩家拒绝后，NPC"去做任务"了（一段时间后），然后发短信分享。

- 需要一个延迟机制？多久后发短信？
- 短信内容调LLM生成？
- NPC"去做任务"期间要不要在主城消失？

#### ④ 权限奖励
- 玩家接受并参与：权限到账（多少？）
- 玩家拒绝：NPC独自完成，玩家无权限？还是少量权限？
- NPC自己获得权限吗？（设定上NPC也有权限动机）

#### ⑤ 技术实现要点
- `quest_type = 'npc'`，`assignee_type = 'npc'`，`assignee_id = NPC的character_id`
- `missions.metadata` 存世界生成结果 + skills上下文
- 约会session的 `mode = 'npc_mission'`
- 接受后和世界任务一样创建 `conversation_sessions`
- 拒绝后需要一个定时任务发短信？还是用现有的 `proactive.ts` 机制？

---

## 三、世界任务：已实现 ✅

完整链路已在 `mission.ts` 中实现：
1. `POST /missions/generate` — LLM生成世界+执念物品
2. `GET /missions` — 任务列表
3. `POST /missions/:missionId/accept` — 接受+选同伴+开始约会
4. `POST /missions/:missionId/decline` — 拒绝
5. `GET /missions/friends` — 好友列表（选同伴）
6. `evaluateWorldMission()` — 约会结束时评级

评级维度：物品到手（客观）+ 执念了却（LLM判断）+ 合作质量（LLM判断）

---

## 实现优先级建议

1. **NPC任务** — 依赖少，世界任务链路可复用，主要是加邀请机制和温馨世界生成
2. **角色任务** — 依赖多（diff问题、镜像NPC、做梦机制），需要先讨论清楚

---

## 已有skills的NPC

| NPC | skills摘要 |
|-----|-----------|
| 沈星回 | 光元素掌控、极快速度、感知力、暗处保护 |
| 林溯 | 财务法律、社交主导、洞察情绪 |
| 穆昭 | 机车滑板、网络安全、张扬随性 |
| 冷惊尘 | 深不可测的能力、解剖标本技术 |
| 方知衡 | 天文学、建筑速写、外语翻译、音乐书法摄影 |
| 彭少殊 | 数字数据、金融管理、心理学书籍 |
| 顾砚 | 近身防御、烹饪、心理学、深度谈心 |
| 白景安 | 龙族秘术、历史知识、强大力量 |
| 谢放 | 格斗柔术、调酒、急救、酒类法规 |
| 顾珩 | 独处消磨时间、书本研读 |

## 已有里程碑的NPC

| NPC | 里程碑数 | 内容摘要 |
|-----|---------|---------|
| 沈星回 | 1 | 光之觉醒（遥远的过去）|
| 林溯 | 1 | 家族继承权争夺（25岁至今）|
| 冷惊尘 | 1 | 觉醒之夜（少年时代）|
| 方知衡 | 1 | 哥哥失踪（14岁时）|
| 白景安 | 2 | 契约之始（千年前）+ 阵营变迁（数十年前）|

> 注：所有里程碑的 `diff` 均为 `{}`（空对象）
