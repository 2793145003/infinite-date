# v4 功能 × API 对照清单

> ⚠️ **本清单已过时**：阶段 3「接血」已于 2026-08 完成，所有页面已接真实后端 API（不再是 mock）。权威 API 索引见 `CODE_MAP.md` 第二节「后端 API 路由」。本文档仅留作接血期历史参考。
>
> 阶段 3「接血」的前置盘点：v4 有哪些功能，哪些已有 v2 真实后端 API，哪些还是假数据。
> 生成时间：2026-08-20

## 一、总览

- v4 前端：`apps/web-v4/`（React + Vite + Tailwind，端口 3001，挂载 8080 `/v4`）
- v2 后端：`apps/server/`（Fastify，26 个路由文件）
- **现状**：v4 阶段 1-2「拉骨架 + 改皮」用的是**假数据层**——4 个 server.ts 自写的 mock 端点 + 各页面硬编码 mock 数据。

---

## 二、v4 页面功能 × API 对照

| v4 页面 | 功能 | 现状 | 对应 v2 API |
|---|---|---|---|
| **HomeScreen 首页** | 角色展示、关系状态、相伴时长、当前位置、诗句、快捷入口（地图约会/任务世界/场景剧本/朋友圈/信箱） | mock | `player` GET `/player`、`me` GET `/me/characters`、`location` GET `/locations` |
| **ChatScreen 聊天** | 约会对话（发送/气泡/输入） | fetch 假 API `/api/chat` | `conversation` POST `/sessions`、POST `/sessions/:id/send`、GET `/sessions/:id/messages` |
| **DatingNarrativeChatScreen 约会叙事** | 沉浸式约会互动对话 | fetch 假 API `/api/dating-interact` | `conversation` POST `/sessions/:id/send` |
| **DiaryScreen 日记/回忆** | 心动约会回忆、情景互动剧本、我们的记忆（约会记录/记忆/剧本三栏目） | mock | `archive` GET `/archive/dates`、`facts` GET `/facts` |
| **MomentsScreen 朋友圈** | 动态 feed、发布动态、添加地点、点赞/评论 | mock | `moments` GET/POST `/moments`、POST `/moments/:id/comment`、`/moments/:id/like` |
| **MailboxScreen 信箱/邮箱** | 邮件列表（如往返机票行程单）、已读 | mock | `email` GET `/emails`、POST `/emails/:id/read`、GET `/emails/unread-count` |
| **MapDatingScreen 地图约会** | 地图、场景驻留、定制专属场景、拍风景存回忆 | mock | `scene` GET `/scene/locations`、`/scene/map/npcs`、`location` GET `/locations` |
| **TaskWorldScreen 任务世界** | 任务列表、寻找任务（起卦问命）、场景地点探索 | mock | `mission` POST `/missions/divine`、`/missions/generate`、`/missions/accept`、`/missions/decline` |
| **ScenarioScriptScreen 场景剧本** | 剧本列表、NPC 角色列表、进入剧本 | mock | `scenario` GET `/scenarios`、`scene-scenario` GET `/scene-scenario` |
| **ScriptPlaySessionScreen 剧本播放** | 剧本演绎对话（心动约会中） | mock | `scenario` POST `/scenarios/:id/enter`、POST `/scenarios/:id/send`、GET `/scenarios/:id/messages` |
| **SceneryViewScreen 风景查看** | 剧情长卷、场景特写、收录记忆 | mock | `scene` GET `/scene/:sessionId`、`archive` POST `/archive/export` |
| **LocationSelectScreen 地点选择** | 选择约会地点、可选场景列表 | mock | `location` GET `/locations`、`scene` GET `/scene/locations` |
| **CharacterEditScreen 角色编辑** | 编辑/新建伴侣人设档案（8↔4 两状态表单） | mock | `character` POST `/characters/:id/edit`、`creation` POST `/creation/start` |
| **CharacterArchiveScreen 角色档案** | 角色档案、导入角色数据、删除角色 | mock | `me` GET `/me/characters`、`creation` POST `/creation/import` |
| **VideoCallScreen 视频通话** | 视频通话、挂断 | mock | **无 API**（纯 UI 模拟，v2 无视频通话能力） |
| **PersonalSettingsScreen 个人设置** | 壁纸（上传/预设）、恋人信息、重置数据 | mock | `settings` GET/PATCH `/settings`、`upload` POST `/upload/image`、`player` GET/PATCH `/player` |
| **SettingsScreen 设置** | 通用设置 | mock | `settings` GET/PATCH `/settings` |

---

## 三、v4 的 4 个假 API（server.ts 自写 mock，接血时替换）

| 假 API | 用途 | 替换为 v2 真实 API |
|---|---|---|
| `/api/chat` | 聊天 | `conversation` POST `/sessions/:id/send` |
| `/api/dating-interact` | 约会互动 | `conversation` POST `/sessions/:id/send` |
| `/api/extract-memory` | 提取记忆 | `facts` POST `/facts` |
| `/api/generate-character` | 生成角色 | `creation` POST `/creation/start` |

---

## 四、v2 后端有、但 v4 暂未用到的 API（接血候选，非必需）

| 路由 | 端点 | 说明 |
|---|---|---|
| `explore` | `/explore`、`/explore/:id/act`、`/explore/active` | 旧探索玩法 |
| `scene-explore` | `/scene/explore`、`/scene/explore/:id/step` | 场景探索（新） |
| `scene-named` | `/scene/engine`、`/scene-named/:id/advance` | 场景命名引擎 |
| `fish` | `/fish/chat` | 摸鱼模式（伪装 AI 助手） |
| `feedback` | `/suggestions`、`/changelog` | 建议反馈 + 更新日志 |
| `tutorial` | `/tutorial/init` | 教程初始化 |
| `auth` | `/auth/login`、`/auth/me` | 认证（接血时必接） |
| `image` | `/uploads/:filename` | 图片获取 |
| `admin` | `/admin/*` | 管理端（前端玩家侧不用） |

---

## 五、无 API 的 v4 功能（接血缺口）

| 功能 | 说明 |
|---|---|
| **视频通话**（VideoCallScreen） | v2 后端无视频/语音通话能力，此页是纯 UI 演示。接血时保留 mock，或砍掉/降级为文字对话 |
| **拍摄风景保存回忆**（MapDatingScreen） | 需确认是否有独立保存接口，否则复用 `archive`/`facts` |
| **定制专属场景**（MapDatingScreen） | 对应 `scene` POST `/scene/locations/:id` 或 admin 能力，需确认玩家侧是否可写 |
