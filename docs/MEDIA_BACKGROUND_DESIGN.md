# 两级媒体系统（背景图 + 头像）设计

> 2026-08-07 评估并定案；同日实现并更新成本实施后的契约。目标：给 v2 新地图加"每个地点一张背景图"，用作约会聊天背景，地点切换背景跟着换；同时把角色头像纳入同一套「公共版 / 玩家版 / 回退」系统。

## 需求（星落原话收敛）

1. 每个地点一张背景图，用作约会聊天的聊天背景；地点换了背景也跟着换。
2. 和角色头像同一套系统：公共版（管理员维护）+ 玩家版（玩家上传本地覆盖），空着就回退公共版。
3. 管理员可编辑公共版本。
4. 角色头像也要用这套系统，并补一条：玩家自己的版本（或某字段）为空时，用公共版本。
    - 例如：玩家只改了角色性格没动头像 → 不应丢公共头像，应回退。

## 数据模型（已落地）

### 地点背景（公共地点：玩家提交 + 管理员裁决）

```
scene_locations.background_image      TEXT      -- 管理员挑中的公共版（uploads/ 文件名；NULL/空 = 未挑）
scene_locations.background_submitted  TEXT JSON -- 玩家提交池 [{"uploaderId","image","at"}...]，默认 '[]'
```

**读取规则（`getLocationBackground`）= COALESCE(管理员公共版, 最早提交)：**
```
有 background_image（管理员挑过）  → 用它
否则                               → 取 background_submitted 里 at 最小（最早提交）的那张
无 → 返回空字符串（前端回退默认样式）
```

**写入规则（`POST /scene/locations/:id/background`，玩家）：**
- **私有地点**（is_public=0）：只有创建者（creator_id === 玩家）能设 → 直接写 `background_image`。别人传 → 403「只能设置自己创建的私有地点背景」。
- **公共地点**（is_public=1）：任何登录玩家可提交 → 写入 `background_submitted` 池（同人同图幂等去重，`addBackgroundSubmission`）。未挑中时 first-wins 由读取侧决定（最早 at 的那张生效）。

**管理员裁决**：`PUT /admin/scene-locations/:id/background`（`adminSetSceneBackground`）把某张设为公共版 `background_image`。挑中后立即优先于提交池。

> 设计决策（星落拍板）：公共地点背景 = "先到先得（first-wins），管理员可纠正"。玩家主动给喜欢的地点配图，最先传的自动生效；有多个玩家传了，管理员在管理后台从提交池里挑一张设为公共版。玩家说"有人说图片不合适了我再改就好了"。

### 角色头像（fork 回退，已修复）

- 现状与读取：`getCharacterAvatar(playerId, characterId)` = 玩家 fork 头像优先，**fork 头像为空 → 回退查公共角色模板头像**（`characters.character_data.avatar`）。
- 只改头像读取这一处，**不动 `loadCharacterData` 全局行为**（其他字段仍 fork 优先整体覆盖）。
- 私有角色没有公共版，不回退；没有 / 未设 → 返回空字符串（前端用名字首字占位）。

## 前端入口

| 场景 | 位置 | 能力 |
|---|---|---|
| 玩家·场景设置弹层 | `SceneLocation.tsx` → `SceneSettingsModal` | 背景图上传（私有=自己地盘直写；公共=加入提交池） |
| 管理员·地图活动 | `admin/SceneActivityPanel.tsx` | 设公共版 + 玩家提交池缩略图列表，点哪张即设为公共版 |
| 角色/NPC 头像 | `CharacterEditModal` / `admin/NpcPanel` / `SmsApp` 创建 | 方形裁剪器（`AvatarCropModal`） |

## 头像方形裁剪器（AvatarCropModal）

**需求**（星落）："头像就裁成方的""给个前端遮罩啥的，让用户裁"。经典头像裁剪器，**只对头像用途**生效。

- `ImageUploadButton` 新增 `square` 布尔 prop：true 时选图后弹出裁剪器，先裁成方形再上传；false（聊天/朋友圈/背景）直接上传原图。
- 裁剪器：方形遮罩（居中），用户**拖动**（平移）+ **滚轮缩放**（1x~4x，以中心为锚）；「确认」→ 前端 canvas 按框裁成方形 JPG（0.92 质量）→ 上传；「取消」→ 不改。
- 存储的是**方形 JPG + CSS 圆角（border-radius:50%）** 显示，不存圆图（方便将来改圆角大小，边缘交 CSS 裁）。符合"别过度设计"。
- 启用 square 的地方：`CharacterEditModal`（角色编辑）、`admin/NpcPanel`（NPC 管理）、`SmsApp`（角色创建）。聊天传图（Conversation/SmsApp）/朋友圈（MomentsApp）**不启用**。

**背景图不裁剪**：背景走 `background-size: cover`（铺满容器、超出自动裁、居中），原始比例无关紧要，无需用户裁剪器。背景图若担心大图卡顿，是"压分辨率"问题，本期未做（见 OPEN_QUESTIONS / 后续）。

## 阶段划分（历史，已全部落地）

### 阶段一：系统本身 ✅
| # | 改动 | 文件 |
|---|---|---|
| 1 | `ALTER TABLE scene_locations ADD background_image`（幂等迁移，照抄 activities 写法） | `lib/scene-map.ts` |
| 2 | GET `/scene/locations` 返回 `background`；`scene-wiring.ts` 透出背景 | `routes/scene.ts` |
| 3 | **头像回退修复**：fork 头像为空 → 回退公共角色头像 | `lib/character.ts` |
| 4 | 管理员设公共版背景接口 + 后台入口 | `routes/admin.ts` + `SceneActivityPanel.tsx` |
| 5 | 上传复用 `upload.ts` + `ImageUploadButton`，零新增基建 | — |
| 6 | 前端渲染：地图卡片（`SceneMapApp.tsx` 已含 bg）+ 地点详情/决策页 hero（`SceneLocation.tsx`）cover 背景 | 页面 + `index.css` |
| 7 | 统一媒体读取 helper `getLocationBackground`（激活玩家版口子） | `lib/scene-map.ts` |

### 阶段二：约会聊天背景落地 ✅
| # | 改动 | 文件 |
|---|---|---|
| 8 | `SceneConversation.tsx` 的 `id-chat-view` 加背景层，随 `current_location_id`（effLocId）联动换背景 | `SceneConversation.tsx` |
| 9 | SSE done / `sceneGet` 带出当前背景 URL（对齐 `scene-wiring.ts` effLocId 逻辑） | `scene.ts` / `run-scene-turn.ts` / `scene-wiring.ts` |
| 10 | CSS：`id-chat-view` cover 背景 + 遮罩 | `index.css` |

### 阶段三：公共背景玩家提交 + 管理员裁决 ✅（本次新增）
| # | 改动 | 文件 |
|---|---|---|
| 11 | `ALTER TABLE scene_locations ADD background_submitted`（幂等）+ 读写 helper（`getBackgroundSubmissions` / `addBackgroundSubmission`） | `lib/scene-map.ts` |
| 12 | 玩家提交背景接口 `POST /scene/locations/:id/background`（私有直写 / 公共入池 first-wins） | `routes/scene.ts` |
| 13 | `getLocationBackground` 改为 COALESCE(公共版, 最早提交) | `lib/scene-map.ts` |
| 14 | admin 列表返回 submissions + 管理员挑中（复用 `adminSetSceneBackground` PUT） | `routes/admin.ts` |
| 15 | 玩家端场景设置弹层加背景上传（私有/公共分流） | `SceneLocation.tsx` |
| 16 | admin 背景卡升级为公共版 + 提交池缩略图 + 挑中 | `SceneActivityPanel.tsx` |

### 阶段四：方形头像裁剪器 ✅（本次新增）
| # | 改动 | 文件 |
|---|---|---|
| 17 | `AvatarCropModal`（方形遮罩 + 拖动 + 滚轮缩放 + canvas 裁方） | 新组件 |
| 18 | `ImageUploadButton` 加 `square` prop，为 true 时先裁后传 | `ImageUploadButton.tsx` |
| 19 | 头像三处启用 square（角色编辑 / NPC / 角色创建），聊天/朋友圈/背景不启用 | 3 页面 |
| 20 | 裁剪器 CSS | `index.css` |

## 关键风险点 / 决策记录

- **头像回退容易做一半**：只改 `getCharacterAvatar` 一处，别动 `loadCharacterData` 全局。
- **背景跟 `current_location_id`（effLocId）走，别跟 `locationName`**：背景 URL 从 SSE done / sceneGet 一起推下来，否则移动地点时背景比顶栏慢半拍。
- **公共背景 first-wins 是故意设计**：玩家主动配图免管理员操心；管理员只需在"有争议 / 不合适"时挑一张纠正。
- **背景图不裁方**（cover 自带裁）；若大图卡顿将来做"等比压分辨率"，不动头像裁剪器。
- **传图防超大**：后台手机 QQ 场景大图 cover 会卡。设计建议背景图前端压到 ~1MB 内再传（对照 upload.ts 10MB 上限）。本期背景图分辨率压缩未做，待定。

## 关键代码定位（2026-08-07 实测核查）
- `lib/scene-map.ts`：`ensureSceneMap` 幂等迁移（background_image 66-70 行、background_submitted 之后）+ `getLocationBackground` / `getBackgroundSubmissions` / `addBackgroundSubmission`（145-190 行附近）。
- `routes/scene.ts`：`POST /scene/locations`（158 行）后接 `POST /scene/locations/:id/background`（公共/私有分流）；GET `/scene/locations` 126 行返回 `background`。
- `lib/character.ts`：`getCharacterAvatar`（68 行，fork 空回退公共）。
- `lib/scene-wiring.ts`：`effLocId = current_location_id || root_location_id`（背景联动钩子）；第 61 行 `locationBackground` 字段、603 行带入。
- `routes/upload.ts` + `routes/image.ts` + `web/components/ImageUploadButton.tsx`：上传零新增基建复用。
- `routes/admin.ts`：`GET /admin/scene-locations` 返回 submissions；`PUT /admin/scene-locations/:id/background` 管理员挑中。
- `web/pages/SceneLocation.tsx`：`SceneSettingsModal` 背景上传；hero/子地点卡片 cover 背景。
- `web/pages/SceneConversation.tsx`：`id-chat-view` 背景层随 `locationBackground` 联动（setBackground 多处）。
- `web/components/AvatarCropModal.tsx`：方形裁剪器。
