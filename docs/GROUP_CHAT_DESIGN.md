# 约会邀请设计文档

## 概述

在地点页增加"邀请约会"入口，玩家可邀请1-2个好友NPC来当前地点约会。

- **选1个**：走单聊路径（`POST /sessions` + `trigger: 'invite'`），NPC知道自己是被邀请来的
- **选2个**：走群聊路径（`POST /sessions/group`），一次LLM调用输出所有参与角色的回复，角色之间互相react

**核心原则：现有单聊功能完全不动。** 群聊通过 `is_group=1` 标记分流，使用独立的API端点（`/sessions/group`、`/sessions/:id/group-send`）。单聊邀请通过可选的 `trigger` 参数区分"搭话"和"邀请"，不传时默认"搭话"。

## 设计决策

- 可邀请1-2个NPC（选2个走群聊，选1个走单聊）
- 邀请对象不限当前地点——可从别处叫好友来当前地点
- 群聊最多2个NPC（spike测试验证Gemma-26B在2角色下声音区分度良好）
- 群聊角色之间互相react（非轮流独白）
- 群聊记忆/关系更新 per-character
- 群聊不支持任务模式（mission）、地点移动、图片发送、nudge/undo/retry
- 群聊结束后每个角色独立折叠记忆、独立发朋友圈
- 独立入口：地点页"邀请约会"按钮，与"搭话"并列

## 一、数据库改动

### 1.1 新表：session_participants

```sql
CREATE TABLE IF NOT EXISTS session_participants (
  session_id   TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  join_order   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_session_participants ON session_participants(session_id);
```

### 1.2 messages表加列

```sql
ALTER TABLE messages ADD COLUMN speaker TEXT;
```

- `speaker`：NPC的character_id。玩家消息为NULL，NPC消息填对应的character_id
- 单聊场景：speaker为NULL（完全兼容，现有查询不受影响）

### 1.3 conversation_sessions加列

```sql
ALTER TABLE conversation_sessions ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0;
```

- `is_group=0`：普通单聊（现有逻辑不变）
- `is_group=1`：群聊（走群聊prompt和独立端点）

### 1.4 迁移策略

- `db/schema.ts` 追加新表定义
- `db/index.ts` 追加ALTER语句（幂等try-catch模式，列已存在则跳过）
- 现有session默认is_group=0，speaker=NULL

## 二、Prompt设计

### 2.1 模板：group.system.txt

`apps/server/src/prompt/templates/group.system.txt`

开头明确"玩家主动邀请了你和另一个角色一起到这里来"。注入两个角色卡（性格三层、说话风格、情绪信号、背景、关系、记忆摘要），要求：
- 两个角色在同一场景，能听见彼此说话
- 互相react——接话、反驳、补充、反应
- 消息顺序是自然对话流，不是轮流发言
- 动作描写用中文括号（）
- 每个角色至少发言一次

### 2.2 输出Schema（GROUP_REPLY_SCHEMA）

`apps/server/src/prompt/builder.ts`

```typescript
export const GROUP_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['speaker', 'text'],
      },
    },
    internals: { type: 'object', additionalProperties: { type: 'string' } },
    internals_notable: { type: 'object', additionalProperties: { type: 'boolean' } },
    player_descriptions: { type: 'object', additionalProperties: { type: 'string' } },
    scene_concluded: { type: 'boolean' },
  },
  required: ['messages', 'internals', 'player_descriptions', 'scene_concluded'],
};
```

### 2.3 builder.ts 新增函数

- `GroupCharContext` 接口：角色数据、玩家描述、时间线摘要、检索记忆、关系时长
- `buildGroupSystemPrompt(charA, charB, playerProfile, locationName, hubLocations)`：渲染group.system.txt
- `buildGroupMessages(systemPrompt, recentMessages, playerText)`：组装历史消息（NPC消息前缀角色名）+ 玩家新消息
- `generateGroupReply(messages, charNames, opts)`：调用LLM with GROUP_REPLY_SCHEMA，解析per-character的internals和player_descriptions

### 2.4 单聊邀请的greeting差异

`generateGreeting()` 新增可选参数 `trigger?: 'talk' | 'invite'`：

- **搭话**（`trigger` 不传或 `'talk'`，现有行为不变）：NPC正在做自己的事，玩家走过来 → "玩家向你走了过来" / "玩家又来找你了"
- **邀请**（`trigger: 'invite'`）：NPC被邀请赴约 → "玩家邀请你来XX约会" / "你应约而来"

两种场景的greeting语气不同——搭话是"被打断"的感觉，邀请是"应约赴会"的感觉。

### 2.5 群聊greeting

`generateGroupGreeting()` 的 greetingHint："玩家邀请了你们两个一起来XX。你们刚到，玩家也在。两个角色对被邀请这件事、对和对方一起出来这件事，各有各的反应。"

### 2.6 历史消息格式

群聊历史消息注入时，NPC消息带speaker名前缀：
```
玩家：今天天气真好
沈星回：太晒了……
林溯：是个适合外出的一天。
```

## 三、后端路由改动

### 3.1 创建单聊session：POST /sessions（加 trigger 参数）

请求体新增可选字段：
```json
{
  "characterId": "xxx",
  "locationId": "plaza",
  "mode": "chat",
  "trigger": "invite"
}
```

`trigger` 不传或 `'talk'`：走现有逻辑（搭话greeting），完全不变。
`trigger: 'invite'`：greeting使用邀请语气（见2.4）。

### 3.2 创建群聊session：POST /sessions/group

请求体：
```json
{
  "characterIds": ["char_a", "char_b"],
  "locationId": "plaza"
}
```

逻辑：
1. 校验：characterIds长度=2，不含DEITY_ID
2. 检查无进行中的session和mission
3. 检查两个角色都是好友（friendship status=active）
4. 创建conversation_sessions（character_id=characterIds[0]作为primary，is_group=1, mode='group'）
5. 创建session_participants两条记录（join_order 0和1）
6. 为每个角色创建/更新relationship
7. 调用 `generateGroupGreeting()` 生成开场白
8. 存greeting消息（每条带speaker=character_id）
9. 返回sessionId + greeting + participants

失败时回滚：删除已创建的session。

### 3.3 群聊发消息：POST /sessions/:sessionId/group-send

**独立端点，不复用现有send端点。**

请求体：`{ "text": "消息内容" }`

逻辑：
1. 校验session存在且 is_group=1 且未结束
2. 存玩家消息（role=player, speaker=NULL）
3. 获取participants，加载两个角色的characterData
4. 获取位置名、关系、记忆（per-character并行检索）
5. 获取最近20条消息（带speaker）
6. 构建群聊system prompt + 历史消息
7. 调用 `generateGroupReply()`
8. 存NPC消息：每条message的speaker填对应character_id
9. 更新两个角色的player_description（含description_changes记录）
10. 滚动折叠记忆 `maybeFoldGroupIncremental()` per-character（异步）
11. 返回带speaker标识的消息列表

### 3.4 获取消息：GET /sessions/:sessionId/messages

session.is_group=1时走群聊分支：
- 返回messages带speaker列
- 返回participants（characterId + name + joinOrder）
- 返回 `isGroup: true`

### 3.5 获取进行中约会：GET /sessions/active

群聊session返回：
- `isGroup: true`
- `participants: [{characterId, name}]`
- 不返回characterName（单聊才有）

### 3.6 结束约会：POST /sessions/:sessionId/end

群聊结束时（通过session.is_group判断）：
- 遍历session_participants
- 对每个角色执行 `foldGroupChronicle()`
- 每个角色独立 `resetEligibleTimer()`
- 每个角色独立60%概率发朋友圈

单聊路径完全不变（包括evaluateWorldMission等）。

### 3.7 nudge端点

群聊session返回400（不支持nudge）。

### 3.8 群聊不支持的功能

群聊场景不支持的端点（前端隐藏入口，后端不调用）：
- 撤回（undo）
- 重试（retry）
- 主动消息（nudge/proactive）
- 加好友（群聊只邀请已有好友）
- 编辑角色
- 图片发送
- 地点移动
- 任务模式

## 四、记忆系统改动

`apps/server/src/lib/memory.ts` 新增两个函数，不影响现有 `foldChronicle` / `maybeFoldIncremental`。

### 4.1 滚动折叠 maybeFoldGroupIncremental()

```
maybeFoldGroupIncremental(sessionId, playerId, characterId)
```

- 消息数达到FOLD_INTERVAL(10)时触发
- 从messages中取未折叠的批次
- 组装对话流时，该角色的话标为角色名，其他NPC标为"（旁人）角色名"，玩家标为"玩家"
- 只保留该角色的内心独白
- 调用LLM（CHRONICLE_SCHEMA）生成summary + key_memories + player_facts
- 写入chronicle（source='group'）+ embedding
- player_facts去重写入（cosine相似度≥0.85跳过）

### 4.2 收尾折叠 foldGroupChronicle()

```
foldGroupChronicle(sessionId, playerId, characterId)
```

- 群聊结束时调用
- 循环折叠所有剩余未总结的消息（每批FOLD_INTERVAL条）
- 逻辑与maybeFoldGroupIncremental相同，但不提取player_facts（收尾只写chronicle）

### 4.3 记忆检索

群聊send时，对每个角色独立调用 `retrieveRelevantMemories()`，分别注入prompt的对应角色段落。

## 五、前端改动

### 5.1 LocationDetail.tsx

- 好友列表从**所有地点**收集（`allNpcsMap`），去重后只要玩家有1个以上好友就显示"邀请约会"按钮
- 不限当前地点——可从别处叫好友来当前地点
- 点击弹出 `GroupInviteModal`：
  - 列出所有好友NPC，点击切换选中
  - 最多选2个（选满后不可再选）
  - 选1个：调用 `api.startConversation(id, locationId, { trigger: 'invite' })` → 单聊
  - 选2个：调用 `api.startGroupSession(ids, locationId)` → 群聊
  - 确认按钮统一显示"确定邀请"
  - 成功后 `onNavigate(view)`（单聊或群聊view）

### 5.2 Conversation.tsx

新增 `isGroup` 和 `participants` props，通过分支处理：

**群聊时隐藏**：编辑角色按钮、加好友按钮、nudge/undo/retry按钮、图片上传按钮、usePresence

**群聊时显示**：
- NPC消息上方的角色名标签（`.id-bubble-speaker`）
- 标题栏显示"角色A & 角色B"

**群聊greeting格式**：`{ messages: [{speaker, text}][], internals: Record<string, string>, internals_notable: Record<string, boolean> }`

### 5.3 App.tsx 导航

View类型包含两种约会视图：
```typescript
// 单聊（含邀请）
| { type: 'conversation'; sessionId: string; characterId: string; locationId: string; greeting?: {...} | null }
// 群聊
| { type: 'group-conversation'; sessionId: string; locationId: string; greeting?: {...}; participants: { characterId: string; name: string }[] }
```

### 5.4 api.ts

- `startConversation(characterId, locationId, opts?: { trigger?: 'talk' | 'invite' })` → POST /sessions（加 trigger 字段）
- `startGroupSession(characterIds, locationId)` → POST /sessions/group
- `getGroupMessages(sessionId)` → GET /sessions/:id/messages（群聊分支）
- `sendGroupMessage(sessionId, text)` → POST /sessions/:id/group-send

### 5.5 CSS

新增 `.id-bubble-speaker` 样式（小字号、灰色、气泡上方）。

## 六、约束与边界

1. **人数**：选1个走单聊，选2个走群聊，硬编码上限2
2. **好友限制**：只能邀请好友NPC（friendship status=active）
3. **不限地点**：可从任意地点邀请好友来当前地点
4. **任务互斥**：有进行中的任务时不能发起约会
5. **session互斥**：有进行中的约会（单聊或群聊）时不能发起新的
6. **主神排除**：不能邀请DEITY_ID参加群聊
7. **群聊不支持图片**：群聊场景不发送图片
8. **群聊不支持地点移动**：群聊固定地点
9. **单聊零改动**：群聊逻辑通过 is_group 分流或独立端点；单聊搭话路径完全不变

## 七、实现状态

全部完成，端到端测试通过。

测试验证（沈星回 + 林溯，中央广场）：
- 创建群聊 → 4条greeting消息，两角色交替说话+互相react
- 发消息 → 4条NPC回复，角色互相react（林溯评价沈星回"散漫"→沈星回反问"你每天绷这么紧？"）
- 声音区分度清晰（沈星回：慵懒短句 vs 林溯：严谨长句）
- 内心独白per-character，各自视角不同
- 结束约会 → 两个角色各自生成独立chronicle（source='group'）
- speaker列正确，单聊消息speaker=NULL完全兼容

## 八、涉及的文件

**新增文件：**
- `apps/server/src/prompt/templates/group.system.txt` — 群聊系统提示模板

**修改文件：**
- `apps/server/src/db/schema.ts` — session_participants表定义
- `apps/server/src/db/index.ts` — ALTER迁移
- `apps/server/src/prompt/builder.ts` — GroupCharContext, buildGroupSystemPrompt, buildGroupMessages, generateGroupReply, GROUP_REPLY_SCHEMA
- `apps/server/src/routes/conversation.ts` — 群聊端点 + trigger参数 + end/messages/active/nudge适配
- `apps/server/src/lib/memory.ts` — maybeFoldGroupIncremental, foldGroupChronicle
- `apps/web/src/lib/api.ts` — startConversation加trigger + 三个群聊API方法
- `apps/web/src/pages/LocationDetail.tsx` — 邀请按钮（全地图好友）+ GroupInviteModal（选1-2个）
- `apps/web/src/pages/Conversation.tsx` — isGroup分支
- `apps/web/src/App.tsx` — group-conversation视图类型
- `apps/web/src/index.css` — .id-bubble-speaker样式
