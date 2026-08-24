# v4 统一视觉风格（memory 指针指向本文件）

## 核心基调
- **蝴蝶水彩壁纸背景**：App 根容器 `bg-ripple-pattern`
- **半透明毛玻璃卡片**：`frosted-glass`（透出蝴蝶背景）

## 页面/组件规则
- 页面根容器：`bg-transparent`（透明，透出 App 蝴蝶背景），**不要设 `bg-bg-soft`/`bg-white` 实底**
- 卡片：`frosted-glass rounded-2xl border border-zinc-200 shadow-xs`
- 文字：`text-zinc-900`（主）/ `text-zinc-600`（次）/ `text-zinc-400`（弱）
- 强调：`bg-rose-500` / `text-rose-600`
- 玩家气泡：`bg-rose-100/70`

## 主题颜色约定（2026-08-23 全量随主题化后）
- 一切语义色**禁写死 hex/rgba**，统一走主题变量：文字/图标/浅底/边框用 `rose/amber/sage/cyan/ember/plum`。
- **实底按钮：底用 `bg-solid`（`--solid`），字用 `text-solid-contrast`，hover 用 `bg-solid-soft`**（不用白字，不用压暗）。`--solid` 每主题各定义一色（watercolor=蓝紫 #5b7fd6、蓝=#5dade2、暖黄=#e8a838、绿=#7dcf9f），未定义回退 `var(--text)`；`--solid-contrast` 回退 `var(--ink-on)`（亮主题深字/暗主题浅字，保证鲜艳底可读）。**语义色底**（`bg-rose`/`bg-cyan`/`bg-amber` 原色，如摸鱼按钮/心声卡片）的字仍用 `text-ink-on`。
- 选中态/高亮：用 `var(--accent)`（每主题有自己的强调色，随主题明暗）。
- 映射关系：`text-rose`/`bg-rose` 等 → `var(--rose)`；`text-ink-on` → `var(--ink-on)`。
- **状态小圆点（未读/在线/任务）用固定鲜艳功能色，勿用柔和语义色**：红点 `bg-status-red`(#e11d48)、绿点 `bg-status-green`(#16a34a)、任务 `bg-status-amber`(#d97706)、离线灰 `bg-zinc-400`。
- **弹层/模态卡片用实底 `bg-panel`（`--panel`，不透明），勿用 `frosted-glass`**：弹层叠在页面内容上，半透明毛玻璃会让背后文字透出叠字（照 v2 `id-modal` 实底 `var(--panel)`）。普通卡片才用 `frosted-glass`。
- 旧 `brand-*`（#e11d48 等）、旧 `*-solid`（压暗变体）已全量删除，勿再用。
- **solid 语义色映射**（index.css 顶部）：`--color-solid: var(--solid, var(--text))`、`--color-solid-contrast: var(--solid-contrast, var(--ink-on))`、`--color-solid-soft: var(--solid-soft, var(--text-dim))`。实底按钮/实底元素统一走 `bg-solid`/`text-solid-contrast`/`hover:bg-solid-soft`，勿再用 `bg-ink`/`text-ink-contrast` 当实底。

## 禁项
- 禁 `bg-white` / `bg-bg-soft` 实底（会挡住蝴蝶背景）
- 禁硬编码 hex/rgba（颜色外置 `@theme`，用 `var(--color-*)`）

## 布局约定（2026-08-24 去手机壳全屏化后）
- **无手机壳/无顶部状态栏，全屏布局**：App 根容器 `h-dvh flex flex-col`，`main` 区 `flex-1 min-h-0 overflow-y-auto`；不再包 402px 手机壳、不再渲染 `StatusBar`（文件保留但已不被引用）。
- 登录页/摸鱼界面同样去壳：`LoginScreen` 用 `min-h-screen`、`FishMode` 根 `h-dvh`（`pb-[81px]`→`pb-3`，因为不再有 dock）。
- **摸鱼入口改为右下角悬浮按钮**：`fishToggle` 开启时显示 🐟「摸鱼」浮窗按钮（`App.tsx` 内），点击进 FishMode；原来挂在 StatusBar 的开关随状态栏一并移除。
- **水彩主题（watercolor）面板色**：`--panel` 白 `#ffffff`→蓝灰 `#dfe7f5`、`--accent` 蓝 `#5b7fd6`→暖金 `#d9a63a`，`--npc-bubble-bg`/`--card-bg` 等同步从白调成蓝灰，适配全屏下蝴蝶水彩背景。

## 其他 v4 约定
- 聊天 = 短信（SmsScreen）；约会对话随地图/场景；视频通话抠
- scene-named = 点名版

## 头像（踩过的坑）
- 后端 `avatar` 字段是**文件名**，前端必须 `imageUrl()` 拼 `/v4/api/uploads/`
- `<img>` 标签不带 Authorization，靠登录时的 httpOnly cookie（`auth`）认证
