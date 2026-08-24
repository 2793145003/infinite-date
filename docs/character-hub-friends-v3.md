# 好友页 v3 改版（原「角色页」）

## 目标

把原来的「角色 hub」（档案/记忆/空间三段式）改成**好友列表页**，卡片式展示，并把「新建」「导入」「日记」拆成独立功能。

## 页面结构

```
←好友                        导入
[搜索/筛选框]            [新建]
─────────────────────────────
┌─────────────────────────────┐
│ [头像]  名字  性别(小字)      │
│         年龄 · 外貌(三行简介) │
│        [编辑] [删除] [聊天]   │
└─────────────────────────────┘
```

## 关键决策（已确认）

1. **好友页 = 好友列表**，和短信列表同源（`GET /sms/threads`，好友都有 message_threads）。
2. **删除 = 删好友**（复用 `DELETE /me/friend/:id`，抹除一切痕迹；公共角色模板不删，保护别人 fork）。
3. **界面文案「角色」→「好友」**。
4. **新建 = 聊天式创建**，从短信（主神「召唤NPC」）抽出来，做成单独页面（CreatorApp）。
5. **导入 = JSON**（输入框粘贴 + 上传文件），带校验。
6. **日记 = 独立页面**，收纳「玩家事实」「回忆」「归档」等记忆类功能；桌面加一个「日记」图标。
7. **卡片字段**：名字 + 性别(小字) + 头像 + 年龄·外貌(三行简介)。

## 数据层改动

### 1. 好友列表字段扩展（后端 `sms.ts` / `getThreads`）
`ThreadInfo` 增加 `gender` / `age` / `appearance`（从 `character_data` 提取）。
- 现有 `getThreads` 已返回 `character_name` / `avatar` / `online_state`。
- 缺 gender/age/appearance → 补上。

### 2. JSON 导入角色（新后端 API）
`POST /characters/import`，body `{ json: string }`：
- 校验：JSON 可解析 + `name` 非空 + gender/age/appearance 字段类型合法。
- 复用 `creation.ts` finalize 的建角色逻辑（不建 friendship/thread，创建后角色在世界=中央广场，需约会加好友）。
- 返回 `{ characterId, characterName }`。

## 前端改动

### 1. CharacterHub.tsx 重构 → 好友页
- 顶栏 `←好友` + `导入`。
- 搜索/筛选框 + `新建`。
- 好友卡片列表（复用 `getThreads` 数据 + 新增字段）。
- 编辑 → `CharacterEditModal`（已有）；删除 → `deleteFriend`（已有）；聊天 → 进入短信线程。

### 2. CreatorApp.tsx（新）— 聊天式创建单独页面
- 从 `SmsApp` 抽出 `creationSession` + 创建卡片面板逻辑。
- 复用 `api.startCreation / creationChat / finalizeCreation / cancelCreation`。

### 3. DiaryApp.tsx（新）— 日记
- 收纳 FactsApp（玩家事实）+ ArchiveApp（回忆）+ ArchivedApps（归档）。
- 桌面加「日记」图标（DesktopV2 APP_DEFS +1）。

### 4. DesktopV2.tsx — 加「日记」图标
- APP_DEFS 加 `{ id: 'diary', icon: ..., label: '日记' }`。

## 实施顺序

1. 后端 getThreads 加 gender/age/appearance。
2. 后端 JSON 导入 API。
3. 前端 CharacterHub 重构（好友页）。
4. 前端 CreatorApp（聊天式创建）。
5. 前端 DiaryApp（日记）+ 桌面图标。
6. 全部 typecheck + browser 实测。

## 注意

- 共享类 `id-friend-card` / `id-friend-rail` 覆盖须 `[data-theme="watercolor"]` 前缀。
- 好友列表毛玻璃：卡片沿用现有白色毛玻璃模式（`rgba(255,255,255,0.62)` + `blur(18px)`）。
- 删好友是敏感操作（memory 已记：星落曾因级联删角色伤心）——确认弹窗措辞要小心。
