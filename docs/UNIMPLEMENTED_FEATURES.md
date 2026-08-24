# 待补功能清单（UNIMPLEMENTED FEATURES）

> 本文档记录 v4 前端**从 UI 上撤掉的「假功能」**——这些功能曾经有按钮/入口，但点击后不落库、刷新即消失，或整条数据链路在后端不存在。2026-08-22 已从界面撤下，待后续补全后端后再恢复 UI。

## 背景

朋友圈改造时发现多处 UI 摆设：按钮存在但只改本地 state，从不调用后端。经排查，以下功能**后端没有对应路由/字段**，属于「画了按钮但没实现」。按「先撤掉、记文档、之后补」的决策，UI 已撤下，功能清单记录于此。

## 待补功能

### 1. 邮箱 · 回信（Reply）

- **位置**：`apps/web-v4/src/components/MailboxScreen.tsx`（`handleSendReply` + 回信抽屉「回复信件 / 投递回信」）
- **现状**：只弹 toast「已投递回信」，回信内容不落库，NPC 收不到。
- **待补**：后端 `email.ts` 加 `POST /emails/:id/reply` 路由；设计「NPC 收到回信后的反应」（是否 LLM 生成回信、是否影响亲密度）。

### 2. 邮箱 · 写新信 / 发送（Compose）

- **位置**：`MailboxScreen.tsx`（`handleSendCompose` + 「写新信」入口 + 撰写新信件整页）
- **现状**：只往本地数组塞一条，刷新消失。后端无 `POST /emails`（发信）路由。
- **待补**：后端加 `POST /emails` 发信路由；定义收件人（NPC）与信件内容如何进入对方的收件箱。

### 3. 邮箱 · 收藏 / 星标（Star）

- **位置**：`MailboxScreen.tsx`（`handleToggleStar` + 详情页星标按钮）
- **现状**：只改本地 `isStarred`，无持久化。后端 `emails` 表无 `is_starred` 字段。
- **待补**：后端 `emails` 表加 `is_starred` 字段 + `POST /emails/:id/star`（或 toggle）路由。

### 4. 邮箱 · 删除信件（Delete）

- **位置**：`MailboxScreen.tsx`（`handleDeleteEmail` + 详情页删除按钮）
- **现状**：只本地 `filter` 移除，重进又回来。后端无 `DELETE /emails/:id`。
- **待补**：后端加 `DELETE /emails/:id` 路由。

### 5. 邮箱 · 随信礼物（Gift Attachment）

- **位置**：`MailboxScreen.tsx`（`handleClaimGift` + 详情页「随信附赠 / 领取礼物」+ 列表页礼物 badge）
- **现状**：礼物数据来自 `INITIAL_EMAILS`（L30-154）这个**从未被引用的死数组**；实际邮件从后端 `/emails` 加载，后端 `ApiEmail` 无 `giftAttachment` 字段、`mapEmailToEmailItem` 不映射 → 整条链路永不渲染。
- **待补**：后端 `emails` 表加礼物字段（`gift_name`/`gift_description`/`gift_icon`/`gift_claimed`）+ 领取路由；前端映射真实字段。`INITIAL_EMAILS` 死数组可一并清理。

### 6. 短信 · 心动拥抱（Heart Burst）

- **位置**：`apps/web-v4/src/components/SmsScreen.tsx`（`handleHeartBurst` + 加号菜单「心动拥抱」按钮）
- **现状**：只放 confetti 彩带 + toast「心动信号已送达」，不产生任何短信/互动落库。
- **待补**：后端加心动拥抱逻辑（是否生成一条互动短信 / 影响亲密度），或明确降级为纯情绪反馈（若保留为纯反馈则无需后端，恢复按钮即可）。

### 7. 设置页 · 声音开关持久化 ✅ 已修（非待补）

- **位置**：`utils/audio.ts`（`SoundManager.setMuted`）
- **原状**：静音状态只存内存，刷新丢失。
- **已修复**：2026-08-22 改为读写 `localStorage['idate_sound_muted']`，跨会话持久化。

## 修复记录

- 2026-08-22：撤下上述 6 处假功能 UI（邮箱 5 处 + 短信 1 处），记录待补；声音开关持久化已修复。
- 2026-08-22：短信页加号（+）菜单整体替换为「上传图片」按钮（短信支持发图片，后端 `text_messages.image_asset_id` 本就支持）。原加号菜单里的「心动骰子」（随机话题提示，纯本地）与「互动剧本」（跳转场景剧本入口）一并移除——**非假功能，属功能调整**；场景剧本仍可从首页「场景剧本 互动演绎」卡片进入。

## 附：其他已知降级（设计决策，非待补）

- `App.tsx` L44-51：乙女数值字段（亲密度/相伴天数/关系状态/身份/标签/状态签名）在后端无对应概念，映射时降级为空值/中性占位。属 v4 与后端模型差异的设计决策，**不视为待补功能**。
