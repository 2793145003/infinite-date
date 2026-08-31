# 地点背景 + 主页背景生成（Krea 2）

## 需求（用户拍板）
1. 地点背景：点加号 → 上传 / 生成（自己输入提示词，预填「地点名 + 简介」但可编辑）
2. 主页背景（壁纸）：点加号 → 上传 / 生成（提示词空白）
3. 不禁人（forbidPeople = false，背景可含人物）
4. 壁纸入库（后端持久化，之前 localStorage 被误删过）
5. 不新增单独入口：都是点现有的加号，把「上传图片」扩展成「上传 / 生成」菜单（和角色头像一致）

## 现状
- 头像交互（加号→上传/生成菜单）已实现：CreationCardPanel / CharacterEditModal，可直接对齐
- 后端 API 齐全：`generateImage(prompt, opts)`（`opts.scene` 区分头像/场景，`opts.appearance` 锚定角色外貌）、`uploadImage(file)`、`POST /scene/locations/:id/background`
- 地点背景：SceneLocationDetail「环境概览」卡片有背景展示，无编辑入口
- 主页背景：SettingsApp「自定义」用 `ImageUploadButton`（加号→上传），`HomeBg` 存 localStorage（`idate_home_bg`）

## 改动

### 后端（apps/server）
1. `players` 表加 `home_bg TEXT NOT NULL DEFAULT ''`（存 HomeBg JSON）
2. `routes/player.ts`：GET `/player` 返回 `home_bg`；PATCH `/player` 接受 `home_bg`
3. `POST /scene/locations/:id/background` 已存在，不改（私有地点直写、公共地点进提交池 first-wins）

### 前端（apps/web-v4）
1. `lib/api.ts`：`PlayerInfo` + `home_bg`；`updatePlayer` + `home_bg`；新增 `setLocationBackground(locationId, background)`
2. `lib/themes.ts`：`setHomeBg` 时同步 `api.updatePlayer({ home_bg })`（后端持久化 + localStorage 缓存）
3. 新建 `BackgroundPicker.tsx`（加号 → 上传/生成菜单 + 内嵌生成提示词弹窗），复用 `api.uploadImage` + `api.generateImage`
4. `SceneLocationDetail.tsx`：环境概览卡片加 `BackgroundPicker`，生成预填 name+summary，结果写 `setLocationBackground`
5. `SettingsApp.tsx`：「自定义」用 `BackgroundPicker` 替换 `ImageUploadButton`，生成提示词空白，结果 `setHomeBg`

## 决策记录
- forbidPeople = false（不禁人）
- 壁纸入库 = players.home_bg
- 地点背景生成预填 name+summary 可编辑；壁纸生成空白
- 不动 ImageUploadButton（短信/约会/朋友圈共用），新建 BackgroundPicker 隔离

## 验证
- typecheck 后端 + 前端
- 生成一张地点背景、一张壁纸，确认写回正确
