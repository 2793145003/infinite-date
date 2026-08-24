# CODE_MAP — 代码地图（索引文件）

> 目的：找东西先看这里。不解释"为什么这样设计"（去看对应设计文档），只告诉你"在哪个文件里"。
>
> 更新原则：移动/新增/删除文件时顺手改这里。不必记每次 commit，保持"当前代码长什么样"准确即可。

---

## 项目结构

```
infinite-date-v2/
├── apps/
│   ├── server/              # 后端（Fastify + SQLite，tsx 直跑无编译）
│   │   └── src/
│   │       ├── index.ts         # 入口：注册路由 + 启动服务 + moment-scheduler
│   │       ├── config.ts        # 配置（端口/路径/CORS）
│   │       ├── db/
│   │       │   ├── index.ts     # DB 连接 + migration runner
│   │       │   └── schema.ts    # 全部建表 SQL（SCHEMA_SQL 常量）
│   │       ├── routes/          # API 路由（每个文件导出 xxxRoutes(app)）
│   │       ├── lib/             # 后端业务逻辑
│   │       ├── llm/
│   │       │   └── adapter.ts   # vLLM 调用 + chatJson + JSON 解析
│   │       └── prompt/
│   │           ├── builder.ts   # 旧系统 prompt 构建（短信/老约会/剧本）
│   │           └── templates/   # 所有 prompt 模板（.txt）
│   ├── web/                 # 前端（Vite + React，无 Router 用 setView 状态机）
│   │   └── src/
│   │       ├── App.tsx          # 路由状态机（View 类型 → 页面组件）
│   │       ├── lib/
│   │       │   ├── api.ts       # 后端 API 客户端（fetch + SSE stream）
│   │       │   ├── themes.ts    # 主题（QQ浏览器不支持 color-mix → 用 CSS 变量）
│   │       │   ├── usePresence.ts  # 玩家在线心跳（15s）
│   │       │   ├── text-render.tsx # 文本渲染（@提及等）
│   │       │   └── live-conflict.ts # 会话冲突检测
│   │       ├── components/      # 共享 UI 组件
│   │       └── pages/           # 页面组件（一个 view type 对应一个页面）
│   └── web-v4/             # v4 前端（心动终端：虚拟伴侣骨架 + 心动终端皮，挂 8080/v4）
│       ├── server.ts          # Express + Vite middleware + 反代 /api→后端3000（multipart 直通，JSON 序列化会破坏 boundary）
│       ├── vite.config.ts     # base: '/v4/'
│       └── src/
│           ├── main.tsx          # 入口
│           ├── App.tsx           # activeTab 状态机 + 全屏布局 + 「当前行程」四态（scene-date/dating/mission/scenario）+ 摸鱼浮窗
│           ├── index.css         # @theme zinc→blue 映射 + bg-ripple-pattern（蝴蝶水彩壁纸）
│           ├── types.ts          # 类型定义
│           ├── data/             # mockData.ts（假数据）+ animeAvatars.ts
│           └── components/       # 42 个页面/弹窗组件（HomeScreen/SceneConversationScreen/角色档案/朋友圈等）+ admin/
├── packages/
│   └── shared/              # 前后端共享类型（CharacterData / DEITY_ID 等）
└── docs/                    # 文档（设计文档 + 变更记录）
```

---

## 一、后端 lib 模块（apps/server/src/lib/）

| 文件 | 行数 | 职责 | 关键导出 |
|---|---|---|---|
| `run-scene-turn.ts` | 1236 | **场景引擎内核**（点名版）。逐拍点名→演员→旁白。不碰 DB。跨轮复述检测逻辑抽到 repeat-detect.ts | `runSceneTurnNamed`, `runSceneTurn`(旧), `pickNextSpeaker`, `runActor`, `runNarration`, `validateBeats` |
| `scene-wiring.ts` | 1502 | **场景引擎接线层**。读 DB 上下文 → 组装 SceneTurnInput → 调内核 → 落库。含剧本分支 + 数值&气氛判定 + 做梦 + 对话原文 embedding | `advanceScene`, `getSceneEngine`, `judgeStatsAndAmbient`, `generateScenarioDream` |
| `scene-schema.ts` | 179 | **场景引擎统一建表 SQL**（scene_* + turn_memory_* 全部表，含全字段+FK）。db/index.ts 启动时执行，各 ensureX 幂等空转 | `SCENE_SCHEMA_SQL` |
| `scene-session.ts` | 26 | 场景会话建表入口（幂等空转，SQL 收拢到 scene-schema.ts） | `ensureSceneSession` |
| `scene-rollback.ts` | 362 | **场景约会回滚**。基线快照 + 轮快照滚动窗口 | `rollbackScene`, `captureStartSnapshot`, `captureRoundSnapshot` |
| `scene-end.ts` | 178 | 场景约会结束收尾（折叠记忆 + 清零意愿 + 60%发朋友圈） | `endSceneSession` |
| `scene-map.ts` | 195 | 新地图地点表（scene_locations / scene_homes）+ npcs 批量解析 | `ensureSceneMap`, `getNpcs`, `upsertNpc`, `getLocationBackground`, `parseSceneNpcs` |
| `explore-store.ts` | 75 | **探索会话纯内存存储**（不落库，一次性临时场景，30min TTL） | `createExploreSession`, `getExploreSession`, `endExploreSession` |
| `memory-wiring.ts` | 106 | **记忆接线**。从 DB 读记忆 → 组装 actor 上下文（chronicle + 三路检索） | `buildActorMemories`, `buildAllActorMemories` |
| `turn-memory.ts` | 546 | **三层记忆折叠**。热窗(N=5) → 中期折叠(I=12,M=15) → 长期总览 | `foldTurnSegment`, `retrieveTurnMemory`, `runTurnMemoryUpdate`, `foldDateSummary` |
| `memory.ts` | 955 | **旧记忆系统**。Chronicle 折叠 + Player Facts（短信/老约会/群聊用） | `foldChronicle`, `retrieveRelevantMemories`, `maybeFoldIncremental` |
| `embedding.ts` | 247 | **向量检索**。bge-base-zh-v1.5（8001端口），cosine sim。三路分开搜（约会摘要/玩家事实/对话原文），排除 turn_overview | `embed`, `retrieveMemories`, `retrieveMemoriesMultiChannel`, `storeEmbedding` |
| `schedule.ts` | 908 | **NPC行程系统**。deterministic hash 生成，按性格分模板池 | `getSceneSchedule`, `getCurrentSchedule`, `classifyPersonality` |
| `moment-scheduler.ts` | 46 | **后台行程驱动**。5min 扫一次，不依赖玩家在线 | `startMomentScheduler` |
| `proactive.ts` | 414 | **NPC主动消息**。意愿累积机制（sms_urge/moment_urge）+ 行程变更检测 | `checkScheduleChange`, `resetSmsUrge`, `resetMomentUrge`, `clearUrgeAfterDate`, `initUrge`, `getUnansweredProactiveCount` |
| `presence.ts` | 257 | **玩家在线状态 + 旧系统NPC主动消息**。15s 心跳 | `updatePresence`, `checkProactive` |
| `character.ts` | 114 | 角色数据加载（fork 优先级：玩家fork > 公共模板 > 私有） | `loadCharacterData`, `getCharacterName`, `safeAvatar` |
| `character-card.ts` | 100 | 角色卡构建（精选字段，信息密度优先） | `buildCharacterCard` |
| `conversation-helpers.ts` | 245 | 旧系统对话操作（undo/retry/保存回复/搜索增强） | `undoLastPlayerMessage`, `saveNpcReply`, `maybeRetrieveSearchResults` |
| `permission.ts` | 81 | 权限系统（创建NPC/地点/撤回/独白窥探） | `spendPlayerPermission`, `grantPlayerPermission`, `getPlayerBalance` |
| `permission-config.ts` | 66 | 权限数值配置（读 JSON 文件，改文件重启即可） | `getCosts` |
| `stats-functions.ts` | 89 | 数值结算函数注册表（导演定值 → 函数算值 → 旁白报结果） | `statsFns`, `resolveStatsConfig` |
| `session-mutex.ts` | 91 | 会话互斥检查（explore/conversation/mission 三选一） | `getActiveLiveSlot`, `hasActiveConversationSession` |
| `clean-text.ts` | 45 | 清洗游离右闭符号（Gemma 偶发多出 `）`/`"`） | `cleanStraySymbols` |
| `repeat-detect.ts` | 24 | 复述检测纯函数（无 DB/LLM 依赖，独立成文件供测试直接 import） | `extractLastPlayerLine` |
| `divination.ts` | 594 | **摇卦起卦**。纳甲筮法排盘（铜钱法/yaoGua/六亲映射/旺衰生克/空亡） | `loadHexagrams`, `yaoGua`, `linesToGua`, `ganZhiOfDay`, `yueJianOfDay`, `kongWangOfDay` |
| `hexagram-prompt.ts` | 217 | **卦象 → prompt 文本**。起卦种子 + 卦象四层渲染（本卦/互卦/变卦/错卦 + 纳甲人物关系层） | `buildDivinationSeed`, `castHexagram`, `renderHexagramLayer`, `renderNajiaLayer` |
| `world-theme.ts` | 193 | **世界任务主题**。主题/目标列表 + 随机掷取（确定性种子） | `THEME_LIST`, `rollTheme`, `rollGoal`, `renderThemeGuide`, `renderGoalGuide` |
| `theme-name-pools.ts` | 33 | 各主题的地名/人名池 | `THEME_NAME_POOLS` |
| `theme-world-pools.ts` | 57 | 各主题的地点池/角色池 | `THEME_PLACE_POOLS`, `THEME_ROLE_POOLS` |
| `name-pool.ts` | 128 | 世界卡牌掷取（地名/人名/困境/物品等） | `rollWorldCards`, `renderWorldCards` |
| `name-pool-data.ts` | 5 | 中文人名池数据（男女各数百个） | `MALE_NAMES`, `FEMALE_NAMES` |
| `auth.ts` | 96 | 认证（邀请码 → player_id → session token）+ 管理员校验 | `requireAuth`, `requireAdmin`, `issueToken`, `validateInviteCode` |
| `wiki-search.ts` | 137 | IP角色搜索（MediaWiki API，免key免Docker） | `searchCharacter` |
| `util.ts` | 20 | 通用工具 | `genId`, `now`, `jsonParse` |

---

## 二、后端 API 路由（apps/server/src/routes/）

> 所有路由挂在 `/api` 前缀下（index.ts L55: `app.register` prefix）。下表省略 `/api`。

### 核心系统

| 文件 | Method | Path | 功能 |
|---|---|---|---|
| **scene.ts** | GET | `/scene/locations` | 场景地图地点树（内存索引消除 N+1，hasChildren 按可见性过滤，npcs 已解析） |
| | POST | `/scene/locations` | 创建地点 |
| | GET | `/scene/map/npcs` | 地图角色头像（谁在哪） |
| | GET | `/scene/npcs/:cid/schedule` | NPC行程（好友可见完整） |
| | GET | `/scene/active` | 当前进行中的场景约会 |
| | POST | `/scene/start` | 开一场约会 |
| | POST | `/scene/:sid/advance` | 推进一轮（带玩家消息，SSE） |
| | POST | `/scene/:sid/continue` | 无消息推进（玩家点"继续"，SSE） |
| | POST | `/scene/:sid/retry` | 重试上一轮（SSE） |
| | POST | `/scene/:sid/undo` | 撤回上一轮 |
| | POST | `/scene/:sid/end` | 结束约会 |
| | GET | `/scene/:sid` | 读场景时间线 |
| | POST | `/scene/character/:cid/add-friend` | 加好友 |
| **scene-named.ts** | GET | `/scene/engine` | 读引擎选择（DB开关） |
| | PUT | `/scene/engine` | 切换引擎（点名版/旧导演） |
| | POST | `/scene-named/:sid/advance` | 点名版推进（SSE） |
| | POST | `/scene-named/:sid/continue` | 点名版继续（SSE） |
| | POST | `/scene-named/:sid/retry` | 点名版重试（SSE） |
| | POST | `/scene-named/:sid/undo` | 点名版撤回 |
| | POST | `/scene-named/:sid/end` | 点名版结束 |
| | GET | `/scene-named/:sid` | 点名版读时间线 |
| **scene-explore.ts** | POST | `/scene/explore` | 开始探索 |
| | POST | `/scene/explore/:sid/step` | 探索一步（逛逛/上前） |
| | POST | `/scene/explore/:sid/end` | 结束探索 |
| **sms.ts** | GET | `/sms/threads` | 短信列表 |
| | GET | `/sms/threads/:tid/messages` | 短信消息 |
| | POST | `/sms/threads/:tid/send` | 发短信 |
| | DELETE | `/sms/threads/:tid/undo` | 撤回 |
| | POST | `/sms/threads/:tid/retry` | 重试 |
| | POST | `/sms/threads/:tid/regenerate-greeting` | 重新生成greeting |
| | POST | `/sms/deity/thread` | 主神短信 |

### 旧约会系统

| 文件 | Method | Path | 功能 |
|---|---|---|---|
| **conversation.ts** | POST | `/sessions` | 开旧约会 |
| | GET | `/sessions/:sid/messages` | 旧约会消息 |
| | POST | `/sessions/:sid/send` | 旧约会发消息 |
| | POST | `/sessions/:sid/end` | 结束旧约会 |
| | DELETE | `/sessions/:sid/undo` | 旧约会撤回 |
| | POST | `/sessions/:sid/retry` | 旧约会重试 |
| | POST | `/sessions/group` | 旧群聊约会 |
| **explore.ts** | POST | `/explore` | 旧探索 |
| | POST | `/explore/:sid/act` | 旧探索行动 |
| | GET | `/explore/active` | 旧探索状态 |

### 旧剧本系统（⛔ 已归档，写操作全部 403）

> 旧剧本已下线，桌面入口移至回收站。GET 路由保留用于查看历史数据，POST/PATCH/DELETE 返回 403。
> 新剧本走场景剧本系统（见下方）。

| 文件 | Method | Path | 功能 |
|---|---|---|---|
| **scenario.ts** | POST | `/scenarios` | ⛔ 创建剧本（403） |
| | GET | `/scenarios` | 剧本列表（只读） |
| | GET | `/scenarios/:sid` | 剧本详情（只读） |
| | PATCH | `/scenarios/:sid` | ⛔ 编辑剧本（403） |
| | POST | `/scenarios/:sid/roll` | ⛔ 掷骰（403） |
| | POST | `/scenarios/:sid/roll-roles` | ⛔ 掷骰角色（403） |
| | POST | `/scenarios/:sid/roll-stats` | ⛔ 掷骰数值（403） |
| | DELETE | `/scenarios/:sid` | ⛔ 删除剧本（403） |
| | POST | `/scenarios/:sid/enter` | ⛔ 进入剧本（403） |
| | POST | `/scenarios/:sid/send` | ⛔ 剧本内发消息（403） |
| | POST | `/scenarios/:sid/end` | ⛔ 结束剧本（403） |
| | GET | `/scenarios/:sid/messages` | 剧本消息（只读） |
| | GET | `/scenarios/active` | 进行中剧本（只读） |
| | GET | `/scenarios/:sid/dream` | 做梦（只读） |
| | DELETE | `/scenarios/:sid/undo` | ⛔ 撤回（403） |
| | POST | `/scenarios/:sid/retry` | ⛔ 重试（403） |
| | POST | `/scenarios/:sid/nudge` | ⛔ 戳一下（403） |

### 场景剧本系统（scene 引擎版，独立于旧剧本）

| 文件 | Method | Path | 功能 |
|---|---|---|---|
| **scene-scenario.ts** | POST | `/scene-scenario/:scenarioId/enter` | 进入剧本（创建 scene_session） |
| | POST | `/scene-scenario/:sessionId/advance` | 推进一轮（SSE 流式） |
| | POST | `/scene-scenario/:sessionId/continue` | 无消息推进（玩家点"继续"，SSE） |
| | POST | `/scene-scenario/:sessionId/retry` | 重试上一轮（SSE） |
| | POST | `/scene-scenario/:sessionId/undo` | 撤回 |
| | POST | `/scene-scenario/:sessionId/end` | 结束剧本 + 触发做梦 |
| | GET | `/scene-scenario/:sessionId` | 读会话详情 |
| | GET | `/scene-scenario/active` | 进行中的场景剧本 |

### 其他

| 文件 | Method | Path | 功能 |
|---|---|---|---|
| **auth.ts** | POST | `/auth/login` | 登录（邀请码/body字段名看auth.ts） |
| | GET | `/auth/me` | 当前用户 |
| **player.ts** | GET | `/player` | 玩家信息 |
| | PATCH | `/player` | 更新玩家 |
| | GET | `/map/npcs` | 旧地图NPC |
| | POST | `/presence` | 在线心跳 |
| **me.ts** | GET | `/me/characters` | 我的角色 |
| | DELETE | `/me/friend/:cid` | 删好友（级联清理） |
| | DELETE | `/me/memory/:cid` | 删除角色记忆 |
| **moments.ts** | GET | `/moments` | 朋友圈 |
| | POST | `/moments` | 发朋友圈 |
| | POST | `/moments/:mid/comment` | 评论 |
| | POST | `/moments/:mid/like` | 点赞 |
| **mission.ts** | POST | `/missions/divine` | 摇卦起卦（纳甲筮法，种子=玩家+时辰+序号） |
| | POST | `/missions/generate` | 生成世界任务（卦象驱动 worldgen） |
| | GET | `/missions` | 任务列表 |
| | POST | `/missions/:mid/accept` | 接任务（选同行 NPC） |
| | POST | `/missions/:mid/decline` | 拒绝任务 |
| | GET | `/missions/friends` | 可同行好友列表 |
| | POST | `/missions/end` | 结束任务（评级发权限） |
| **creation.ts** | POST | `/creation/start` | 角色创建对话 |
| | POST | `/creation/:sid/chat` | 创建中对话 |
| | POST | `/creation/:sid/finalize` | 完成创建 |
| **character.ts** | GET | `/characters/:cid/edit` | 编辑角色 |
| | POST | `/characters/:cid/fork` | Fork角色 |
| **location.ts** | GET | `/locations` | 旧地点列表 |
| | POST | `/locations` | 创建旧地点 |
| **facts.ts** | GET | `/facts` | 玩家事实 |
| | POST | `/facts` | 添加事实 |
| | PATCH | `/facts/:id` | 编辑事实 |
| **upload.ts** | POST | `/upload/image` | 上传图片（→image_blobs表） |
| **image.ts** | GET | `/uploads/:filename` | 读图片（从image_blobs表） |
| **admin.ts** | GET | `/admin/characters` | 管理角色 |
| | POST | `/admin/invite-codes` | 生成邀请码 |
| | GET | `/admin/scene-locations` | 管理场景地点 |
| | POST | `/admin/scene-map/locations` | 创建场景地点 |
| | PUT | `/admin/scene-map/locations/:id/parent` | 设置父地点 |
| | PUT | `/admin/scene-map/locations/:id/home` | 设置谁的家 |
| **archive.ts** | GET | `/archive/dates` | 旧约会归档 |
| | GET | `/archive/scene-dates` | 场景约会归档（scene_type='date'） |
| | GET | `/archive/scene-scenarios` | 场景剧本归档（scene_type='scenario'） |
| | GET | `/archive/scene-scenarios/:id` | 场景剧本归档详情 |
| | GET | `/archive/sms` | 短信归档 |
| | GET | `/archive/scenarios` | 旧剧本归档 |
| | POST | `/archive/export` | 导出（支持 date/sms/scenario/scene/scene-scenario） |
| **feedback.ts** | GET | `/suggestions` | 反馈列表 |
| | POST | `/suggestions` | 提交反馈 |
| | GET | `/changelog` | 更新日志 |
| **email.ts** | GET | `/emails` | 邮件列表 |
| | POST | `/emails/:emailId/read` | 标记已读 |
| | GET | `/emails/unread-count` | 未读数 |
| **settings.ts** | GET | `/settings` | 设置 |
| **fish.ts** | POST | `/fish/chat` | 钓鱼模式 |
| **tutorial.ts** | POST | `/tutorial/init` | 初始化教程 |

---

## 三、前端页面（apps/web/src/pages/）—— ⚠️ 已归档（源码 → archive/web-v2/）

> 前端无 React Router。`App.tsx` 用 `View` 类型状态机导航：`setView({ type: 'xxx' })`。

| 文件 | 行数 | View type | 功能 |
|---|---|---|---|
| `Desktop.tsx` | 325 | `desktop` | 手机桌面（widget 网格 4 列 + 图标分页翻页 + 手机外壳收窄对齐真机比例，旧剧本已移至回收站） |
| `SmsApp.tsx` | 935 | `sms` / `sms-thread` | 短信（列表+对话，头像带在线状态点） |
| `SceneMapApp.tsx` | 156 | `scenemap` | 地图页面（列表地图：上图下列表，人物并入地点卡片按「好友→见过→陌生」排序，含图形/列表切换） |
| `SceneMapViz.tsx` | 1133 | —（`scenemap` 图形子视图） | **图形地图可视化**（Voronoi 分层分割 + d3-delaunay，选中高亮/下钻/场景设置入口/背景图蒙版）；导出 `SceneScheduleModal` 行程弹窗 |
| `SceneLocation.tsx` | 596 | `scene-location` | 地点详情（NPC列表+邀请+探索入口）；导出 `SceneSettingsModal` 场景设置弹窗复用 |
| `SceneConversation.tsx` | 611 | `scene-conversation` | **场景约会对话**（SSE气泡+心声+撤回+重试） |
| `SceneExplore.tsx` | 249 | `scene-explore` | 场景探索（逛逛/偶遇/上前） |
| `MapApp.tsx` | 315 | `map` | 旧地图 |
| `LocationDetail.tsx` | 565 | `location-detail` | 旧地点详情 |
| `Conversation.tsx` | 449 | `conversation` / `group-conversation` | 旧约会对话 |
| `Explore.tsx` | 152 | `explore` | 旧探索 |
| `MissionsApp.tsx` | 579 | `missions` | 任务系统（含摇卦生成世界任务） |
| `ScenarioList.tsx` | 144 | `scenarios` | 剧本列表 |
| `ScenarioDetail.tsx` | 276 | `scenario-detail` | 剧本详情 |
| `ScenarioEditor.tsx` | 424 | `scenario-editor` | 剧本编辑器 |
| `ScenarioConversation.tsx` | 327 | `scenario-conversation` | 剧本对话 |
| `ScenarioDream.tsx` | 99 | `scenario-dream` | 剧本做梦 |
| `ScenarioSceneList.tsx` | 115 | `scenario-scene-list` | **场景剧本列表**（选NPC→enter→跳场景版） |
| `ScenarioSceneDetail.tsx` | 288 | `scenario-scene-detail` | 场景剧本详情（参数配置页） |
| `ScenarioSceneApp.tsx` | 610 | `scenario-scene` | **场景剧本对话**（SSE气泡+数值面板+气氛组+做梦） |
| `MomentsApp.tsx` | 232 | `moments` | 朋友圈 |
| `FactsApp.tsx` | 256 | `facts` | 玩家事实 |
| `MySpaceApp.tsx` | 307 | `myspace` | 我的空间 |
| `SettingsApp.tsx` | 488 | `settings` | 设置（含主题皮肤自选色 + 主页背景图预设/上传） |
| `FeedbackApp.tsx` | 622 | `feedback` | 反馈+更新日志 |
| `MailApp.tsx` | 97 | `mail` / `mail-detail` | 邮件 |
| `ArchiveApp.tsx` | 566 | `archive` | 回忆（场景约会+场景剧本页签，旧记录折叠） |
| `ArchivedApps.tsx` | 63 | `archived` | 回收站（旧地图+旧剧本，只读） |
| `AdminApp.tsx` | 38 | `admin` | 管理后台 |
| `Boot.tsx` | 100 | — | 启动页（登录检查） |
| `Login.tsx` | 43 | — | 登录页 |
| `FishMode.tsx` | 144 | — | 钓鱼模式 |

### 前端 lib

| 文件 | 行数 | 功能 |
|---|---|---|
| `api.ts` | 1648 | 后端 API 客户端（fetch + SSE stream + token 管理） |
| `themes.ts` | 515 | 主题（自选皮肤整套变量生成 + 主页背景预设/上传；QQ浏览器不支持 color-mix → CSS 变量） |
| `usePresence.ts` | 88 | 玩家在线心跳（15s POST /presence） |
| `text-render.tsx` | 36 | 文本渲染（@提及等） |
| `live-conflict.ts` | 72 | 会话冲突检测（异地登录/多设备） |

### 前端 components

| 文件 | 行数 | 功能 |
|---|---|---|
| `PhoneShell.tsx` | 66 | 手机外壳布局 |
| `AvatarCropModal.tsx` | 135 | 头像裁剪（只裁头像，不过度推广） |
| `CharacterEditModal.tsx` | 365 | 角色编辑弹窗 |
| `ImageUploadButton.tsx` | 142 | 图片上传按钮 |
| `AutoTextarea.tsx` | 25 | 自动高度文本框 |
| `LiveConflictModal.tsx` | 127 | 会话冲突弹窗 |
| `DivinationCard.tsx` | 238 | 摇卦卡（未成卦铜钱/成卦卦象占满，动爻标记） |

---

## 三·五、v4 前端（apps/web-v4/，心动终端）

> 独立 Vite+React 应用，base `/v4/`，本地监听 3001（部署外层反代挂 8080/v4），反代 `/api`→后端 3000。无 React Router，`App.tsx` 用 `activeTab` 状态机导航。**全屏布局（无手机壳/无状态栏）**。

### 顶层 & 核心

| 文件 | 行数 | 职责 |
|---|---|---|
| `server.ts` | — | Express + Vite middleware + 反代 `/api`→后端 3000（multipart 直通，避免 JSON 序列化破坏 boundary） |
| `vite.config.ts` | — | base `/v4/` |
| `src/main.tsx` | 17 | 入口 |
| `src/App.tsx` | 724 | activeTab 状态机 + 全屏布局 + **「当前行程」四态**（地图约会 `scene-date`/短信约会 `dating`/任务 `mission`/剧本 `scenario`，优先级场景约会 > 剧本 > 任务 > 短信约会）+ 摸鱼浮窗 |
| `src/index.css` | 857 | `@theme` 语义色 + **solid 变量**（`--solid`/`--solid-soft`）+ `bg-ripple-pattern` 蝴蝶水彩壁纸 |
| `src/types.ts` | 262 | 类型（`ActivityState` 含 scene-date/dating/mission/scenario 四态） |

### lib / data / utils / constants

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/api.ts` | 1065 | 后端 API 客户端（fetch + SSE + token；`getActiveScene` 场景约会待办） |
| `lib/themes.ts` | 556 | 主题（皮肤整套变量生成 + 主页背景预设/上传） |
| `lib/sceneMapGeometry.ts` | 820 | 地图几何（Voronoi 分层分割） |
| `lib/text-render.tsx` | 36 | 文本渲染（@提及） |
| `data/mockData.ts` | 627 | 假数据 |
| `data/animeAvatars.ts` | 45 | 动画头像 |
| `utils/audio.ts` | 226 | 音频 |
| `utils/imageUpload.ts` | 50 | 图片上传 |
| `constants/colors.ts` | 6 | 颜色常量 |

### components（42 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `Navigation.tsx` | 66 | 底部导航 |
| `StatusBar.tsx` | 84 | 顶部状态栏（⚠️ 去手机壳后已不被引用，文件保留） |
| `HomeScreen.tsx` | 445 | 首页（约会中锁角色禁切换 + 行程待办「继续」入口） |
| `LoginScreen.tsx` | 130 | 登录页 |
| `SmsScreen.tsx` | 722 | 短信（聊天，主对话入口） |
| `SceneConversationScreen.tsx` | 930 | **场景约会对话**（SSE 气泡 + 心声 + 软键盘适配 kbH + 连续气泡头像留空） |
| `MapDatingModal.tsx` | 185 | 地图约会弹窗 |
| `VideoCallScreen.tsx` | 479 | 视频通话 |
| `SceneMapScreen.tsx` | 463 | 图形地图（Voronoi 分层） |
| `SceneLocationDetail.tsx` | 482 | 地点详情 |
| `SceneExploreScreen.tsx` | 351 | 场景探索（逛逛/偶遇/上前） |
| `SceneryViewScreen.tsx` | 103 | 场景查看页 |
| `SceneryViewModal.tsx` | 45 | 场景查看弹窗 |
| `ScenarioEditor.tsx` | 421 | 剧本编辑器 |
| `ScenarioSceneApp.tsx` | 497 | 场景剧本对话（SSE 气泡 + 数值面板 + 气氛组 + 做梦） |
| `ScenarioSceneDetail.tsx` | 249 | 场景剧本详情（参数配置） |
| `ScenarioSceneList.tsx` | 118 | 场景剧本列表 |
| `ScenarioScriptModal.tsx` | 179 | 剧本弹窗 |
| `ScriptPlaySessionScreen.tsx` | 426 | 剧本播放会话 |
| `MissionsApp.tsx` | 532 | 任务 |
| `MissionRecords.tsx` | 91 | 任务记录 |
| `TaskWorldModal.tsx` | 218 | 任务世界弹窗 |
| `MomentsScreen.tsx` | 795 | 朋友圈（头像 fallback：角色 > authorAvatar > 首字） |
| `DiaryScreen.tsx` | 145 | 日记 |
| `FactsScreen.tsx` | 334 | 玩家事实（可嵌入日记页，跟随上方角色同步筛选） |
| `CharacterArchiveScreen.tsx` | 334 | 角色档案 |
| `CharacterEditScreen.tsx` | 879 | 角色编辑页 |
| `CharacterEditModal.tsx` | 618 | 角色编辑弹窗 |
| `EditCharacterModal.tsx` | 23 | 编辑角色小弹窗 |
| `CreatorApp.tsx` | 212 | 角色创建 |
| `CreationCardPanel.tsx` | 372 | 创建卡片面板 |
| `AvatarCropModal.tsx` | 135 | 头像裁剪 |
| `ImageUploadButton.tsx` | 142 | 图片上传按钮 |
| `ArchiveView.tsx` | 456 | 回忆（场景约会/剧本归档） |
| `MailboxScreen.tsx` | 742 | 邮件 |
| `SettingsApp.tsx` | 584 | 设置 |
| `SettingsModal.tsx` | 23 | 设置弹窗 |
| `PersonalSettingsScreen.tsx` | 592 | 个人设置（含摸鱼开关） |
| `FeedbackScreen.tsx` | 693 | 反馈 + 更新日志 |
| `AdminApp.tsx` | 38 | 管理后台入口 |
| `FishMode.tsx` | 185 | 摸鱼（伪装 AI 助手） |
| `AutoTextarea.tsx` | 25 | 自动高度文本框 |

### components/admin/

| 文件 | 行数 | 职责 |
|---|---|---|
| `InviteCodesPanel.tsx` | 204 | 邀请码管理 |
| `LocationPanel.tsx` | 589 | 地点管理 |
| `NpcPanel.tsx` | 645 | NPC 管理 |
| `diffUtils.ts` | 133 | diff 工具 |
| `types.ts` | 60 | 类型 |

---

## 四、Prompt 模板（apps/server/src/prompt/templates/）

| 文件 | 行数 | 用途 | 调用方 |
|---|---|---|---|
| `scene.actor.txt` | 65 | **场景引擎演员**（点名版，核心）。含【不重复】原则 | run-scene-turn.ts runActor |
| `scene.namer.txt` | 15 | **点名版选人**（生产默认） | run-scene-turn.ts pickNextSpeaker |
| `scene.namer.v2.txt` | 9 | 点名版选人 v2（AB 实验备选，经 templates.namer 覆盖启用） | run-scene-turn.ts |
| `scene.namer.v1.bak.txt` | 9 | v1 备份（不参与生产） | — |
| `scene.greeting.txt` | 32 | 场景开场（按circumstance分节） | scene-wiring.ts |
| `roleplay.system.txt` | 65 | 旧系统角色扮演（短信/老约会）。含【不重复、不模仿】原则 | builder.ts buildSystemPrompt |
| `character-card.txt` | 26 | 角色卡模板 | character-card.ts |
| `group.system.txt` | 68 | 旧群聊约会 | builder.ts buildGroupSystemPrompt |
| `scenario.dream.txt` | 22 | 剧本做梦 | scene-wiring.ts |
| `scenario.roll.txt` | 22 | 剧本掷骰 | scene-scenario.ts |
| `scenario.stats-roll.txt` | 28 | 剧本数值生成 | scene-scenario.ts |
| `scenario.stats-judge.txt` | 42 | 剧本数值判定+气氛组生成（合并调用） | scene-wiring.ts judgeStatsAndAmbient |
| `explore.system.txt` | 28 | 旧探索系统 | explore.ts |
| `explore.continue.txt` | 40 | 旧探索继续 | explore.ts |
| `mission.evaluator.txt` | 27 | 任务评级 | mission.ts |
| `mission.worldgen.txt` | 73 | 原创世界生成（生产默认） | mission.ts |
| `mission.worldgen-goal.txt` | 71 | 世界生成 goal 版（AB 实验备选） | scripts/ab-worldgen-goal.ts |
| `mission.worldgen-grounded.txt` | 71 | 世界生成 grounded 版（AB 实验备选） | scripts/ab-worldgen-grounded.ts |
| `deity.system.txt` | 48 | 主神系统 | builder.ts |
| `deity.creation.system.txt` | 107 | 主神创建角色 | creation.ts |

> **改任何 .txt 后需重启后端**（loadPrompt 有 Map 缓存）。

---

## 五、关键数据流

### 场景约会 advance（点名版，核心链路）

```
前端 SceneConversation.tsx
  → api.sceneAdvanceStream(sid, playerMessage, { onBeat })
    → POST /scene/:sid/advance (SSE)
      → scene.ts 路由
        → scene-wiring.ts advanceScene(playerId, sid, playerMessage)
          ├─ 读 DB: scene_locations / scene_relationships / characters / schedule
          ├─ memory-wiring.ts buildAllActorMemories() — 从 DB 读记忆+三路检索
          │    ├─ assembleRoleMemory (热窗+中期+长期总览)
          │    └─ retrieveTurnMemory → embedding.ts retrieveMemoriesMultiChannel
          │         ├─ 【约会摘要】chronicle + turn_date_summary (top-5)
          │         ├─ 【玩家事实】fact + turn_player_fact (top-5)
          │         └─ 【对话原文】scene_message (top-5, 跨全部session)
          │         （turn_overview 排除，不进搜索）
          ├─ run-scene-turn.ts runSceneTurnNamed(input)
          │    ├─ 开场旁白（首次，主动插入）
          │    ├─ 循环: pickNextSpeaker(namer) → runActor → runNarration
          │    │    └─ llm/adapter.ts chatJson() — 调 vLLM
          │    ├─ 复述检测 + LLM改写
          │    └─ 转场旁白（move后，末尾非旁白时）
          ├─ 落库: scene_messages / scene_relationships / turn_memory_fold
          │    └─ insertMsg 后 fire-and-forget embed → memory_embeddings (source_type='scene_message')
          ├─ turn-memory.ts runTurnMemoryUpdate() — 异步折叠
          └─ SSE onBeat 逐拍推前端
```

### 场景约会撤回

```
前端 → POST /scene/:sid/undo
  → scene.ts
    → scene-rollback.ts rollbackScene(playerId, sid, targetRound)
      ├─ targetRound=0: 整场删除（恢复基线快照 + 删光追加型记忆）
      └─ targetRound>0: 按轮撤回（恢复轮快照累积值 + 删该轮起追加型记忆）
      ├─ scene_messages: DELETE round_no >= target
      ├─ turn_memory_fold: DELETE segment/date_summary round_no >= target
      ├─ turn_player_facts: DELETE round_no >= target
      ├─ scene_relationships: 恢复快照 player_description + current_activity
      ├─ stats_state: 恢复快照
      └─ memory_embeddings: 按 source_id 删孤儿向量
```

### NPC 行程 → 短信/朋友圈（后台驱动）

```
moment-scheduler.ts (5min tick)
  → proactive.ts checkScheduleChange(playerId)
    ├─ 读 scene_schedule_entries 检测行程变化
    ├─ 30% → 生成主动短信（排除约会中NPC）
    ├─ 20% → 生成朋友圈（排除约会中NPC）
    └─ 排除: scene_sessions ended=0 的角色
```

### 旧短信对话

```
前端 SmsApp.tsx
  → api.smsSend(tid, text)
    → POST /sms/threads/:tid/send
      → sms.ts
        → builder.ts buildSystemPrompt() + buildMessages()
          → prompt/templates/roleplay.system.txt
        → adapter.ts chat() — 调 vLLM
        → conversation-helpers.ts saveNpcReply()
        → memory.ts maybeFoldSmsIncremental() — 异步折叠
```

---

## 六、LLM 调用

| 模块 | 函数 | 用途 |
|---|---|---|
| `llm/adapter.ts` | `chat(messages, opts)` | 基础调用（支持 guidedJson） |
| | `chatJson<T>(messages, {schema,normalize,retryHint})` | 结构化输出（parse→normalize→重试→兜底null） |
| | `tryParseJsonReply(text)` | 剥 ```json 围栏 + parse |
| `prompt/builder.ts` | `generateReply()` | 旧系统回复生成（短信/老约会）。含 `_isEchoingPlayer` 复述检测 |
| | `generateGroupReply()` | 旧群聊回复生成 |

**vLLM 配置**：Gemma-4-26B，max_len 16384（原生256K），端口 8000。bge-base-zh-v1.5 端口 8001。

---

## 七、数据库

- **DB 文件**：`data/infinite-date.sqlite`（`IDATE_DATA_DIR` 环境变量可覆盖）
- **建表 SQL**：`db/schema.ts` → `SCHEMA_SQL`（旧系统 44 张表）；`lib/scene-schema.ts` → `SCENE_SCHEMA_SQL`（场景引擎 11 张表，含全字段+FK）。两者都在所有 migration 之前执行
- **Migration**：`db/index.ts` → `migration()` 函数（ALTER TABLE 增量，幂等 + duplicate-column 安全跳过）
- **操作铁律**：不停服务，用独立 node 进程操作 DB（见 skill `db-operations-without-downtime`）
- **只读查询**：`sqlite3 data/infinite-date.sqlite "SELECT ..."`

### 主要表分组

| 分组 | 表 | 说明 |
|---|---|---|
| **场景引擎** | `scene_sessions` / `scene_messages` / `scene_relationships` / `scene_round_snapshots` / `scene_start_snapshot` | 场景约会（点名版）。scene_sessions 含剧本列（scenario_id/worldview/player_role/npc_roles/goal/opening_scene/ambient_config/dream_text/dream_custom/character_ids/goal_achieved） |
| | `scene_locations` / `scene_homes` | 新地图地点 |
| | `scene_schedule_entries` | NPC行程 |
| | （探索会话纯内存，无表） | 探索是一次性临时场景，全过程存内存 Map（见 lib/explore-store.ts），仅持久结果（捡到物品）写 player_facts |
| **旧系统** | `sessions` / `messages` / `relationships` / `chronicles` / `player_facts` | 旧约会/短信 |
| | `text_messages` / `sms_threads` | 短信 |
| | `locations` / `location_homes` | 旧地点 |
| | `npc_schedules` | 旧行程（已退役，0行） |
| **记忆** | `memory_embeddings` | 向量检索（跨场累积） |
| | `turn_memory_fold` / `turn_player_facts` | 场景引擎按轮记忆 |
| **通用** | `players` / `friendships` / `characters` / `character_player_data` / `character_permissions` | 玩家/角色/关系 |
| | `moments` / `moment_interactions` | 朋友圈 |
| | `emails` | 邮件（系统通知 + 男主来信） |
| | `missions` | 卦象世界任务（quest_type='world'，含评级/奖励） |
| | `scenarios` / `scenario_sessions` / `scenario_messages` | 旧剧本 |
| | `image_blobs` | 图片二进制 |
| | `llm_call_log` | LLM调用日志（24h自动清理） |
| | `permissions` / `invite_codes` | 权限/邀请 |
| | `player_llm_configs` | per-player LLM 配置（base_url/api_key/model，未填回落 env） |

---

## 八、脚本（apps/server/src/scripts/）

> 共 49 个脚本，绝大多数是开发期调试/A/B 实验脚本（git 历史已完整保留，开源发布前需决定去留）。下表按用途分组，只列有复用价值的。

| 类型 | 文件 | 用途 |
|---|---|---|
| **AB 实验**（34 个 `ab-*.ts`） | `ab-v7-*` ~ `ab-v25-*`、`ab-checker-proto.ts`、`ab-groupchat.ts`、`ab-namer-move.ts` 等 | 点名版引擎逐版 A/B 对照实验（复述/否定/引用位置/命名/去重等），历史存档 |
| **数据迁移** | `migrate-scene-message-embeddings.ts` | 批量 embed 历史 scene_messages → memory_embeddings (source_type='scene_message')。幂等 |
| | `migrate-images-to-db.ts` | 图片文件 → image_blobs 表 |
| **回放/压测** | `ps-named-batch.ts`、`ps-replay-3538d55f-round2.ts` | 批量回放 llm_call_log 复现引擎行为 |
| | `repro-fixed-round20.ts` | 复现固定轮次问题 |
| **调试/工具** | `test-scene-rollback.ts` | 回滚逻辑测试 |
| | `full.ts`、`h2h2.ts`、`ctl.ts` | 开发期手动驱动 |
| | `build-move-gold.cjs`、`dump-move-samples.ts` | 移动/样本数据集构建 |

---

## 九、文档索引

| 文档 | 内容 |
|---|---|
| **CODE_MAP.md**（本文件） | 代码地图：文件→功能索引 |
| **V4_STYLE.md** | v4 统一视觉风格：语义色/solid 实底按钮/全屏布局约定 |
| **MEMORY_NOTES.md** | 变更记录：每次修复/功能的设计决策+踩坑 |
| **DATA_MODEL.md** | 数据模型：全部表结构+字段说明 |
| **PROMPTS.md** | Prompt 模板说明 |
| **OPEN_QUESTIONS.md** | 未解决设计问题 |
| **MIGRATION_DESIGN.md** | v3→v2 迁移设计（新表逐步替代旧表） |
| **MISSION_DESIGN.md** | 任务系统设计 |
| **GROUP_CHAT_DESIGN.md** | 群聊设计 |
| **MEDIA_BACKGROUND_DESIGN.md** | 媒体/背景图系统 |
| **scene-director-rename-design.md** | 点名版引擎设计（已投产） |
| **scene-scenario-design.md** | 场景剧本设计（scene 引擎版剧本，数值+气氛组+做梦） |
| **该死-prompt-修复记录.md** | 心声"该死"修复全过程 |
| **session-2026-08-07-*.md** | 气泡节奏/时间戳/改角色名/LLM日志 会话记录 |
| **v3-archive/** | v3 设计文档归档（已删 v3 代码，仅留文档） |
