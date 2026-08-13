# v2 前端深度代码审查报告

**审查范围**：`apps/web/src/` 全部文件（React + TypeScript + CSS）
**审查日期**：2026-08-09
**审查重点**：bug、UX问题、性能问题、状态管理问题、类型安全、XSS风险、CSS兼容性

---

## P0 致命问题

### P0-1. `requestStream` 无超时保护，SSE 连接挂死会永久卡住用户
**文件**：`lib/api.ts:116`
```ts
const res = await fetch(`${API_BASE}${path}`, { ...opts, headers, signal: opts.signal });
```
**问题**：普通 `request()` 有 `AbortSignal.timeout(30_000)`，但 `requestStream()` 没有。如果服务端 SSE 连接建立后不发数据也不关闭（网络中间件 hang 住、后端线程阻塞），`reader.read()` 会永久挂起，前端 UI 永远停在"对方正在输入"，用户无法操作。
**修复建议**：给 `requestStream` 也加超时——可在外层包一个 `AbortController`，设置如 120s 超时（SSE 场景需更长），超时后 abort 并 throw。

### P0-2. `useChatMessages.handleSend` 异常后 `setSending(false)` 在 finally 中，但 catch 里 `throw err` 导致后续逻辑中断
**文件**：`hooks/useChatMessages.ts:247-253`
```ts
} catch (err) {
  setMessages(prev => prev.filter(m => m.id !== tempId));
  setInput(text);
  throw err;  // ← 重新抛出
} finally {
  setSending(false);
}
```
**问题**：`throw err` 会让错误冒泡到调用方（如 Conversation 组件的 onClick handler），React 事件处理器中的未捕获异常会导致 React 弹出错误边界（如果有）或控制台报错。如果上层没有 catch，`sending` 状态虽然被 finally 恢复了，但用户体验上会看到一个未处理的错误闪烁。
**修复建议**：在 catch 中处理错误（显示 toast/inline error），不要 `throw err`；或者确保所有调用方都 catch 并处理。

### P0-3. `imageUrl()` 把 token 暴露在 URL query string 中
**文件**：`lib/api.ts:22-25`
```ts
export function imageUrl(filename: string): string {
  const token = getToken();
  return `${API_BASE}/uploads/${filename}${token ? `?token=${token}` : ''}`;
}
```
**问题**：JWT token 出现在 URL 中会被：
1. 浏览器历史记录保存
2. 服务器 access log 记录
3. Referer header 泄漏给第三方（如果有外链图片）
4. 代理/CDN 缓存日志记录

这是 **token 泄漏漏洞**。如果 access log 被第三方获取，token 可被重放。
**修复建议**：改为用短期签名 URL（后端生成带过期时间的 presigned URL），或用 cookie 认证代替 query token，或用 `fetch` + `URL.createObjectURL` 加载图片（能带 Authorization header）。

---

## P1 严重问题

### P1-1. `MomentsApp` 30秒轮询 + 每次全量重拉，长列表性能差且无竞态保护
**文件**：`pages/MomentsApp.tsx:38-43`
```ts
useEffect(() => {
  loadMoments();
  const interval = setInterval(loadMoments, 30000);
  return () => clearInterval(interval);
}, [loadMoments]);
```
**问题**：
1. 每30秒全量拉取所有 moments，如果朋友圈内容多，每次返回大 JSON
2. `loadMoments` 是 async 但 setInterval 不等它完成——如果某次请求超过30秒，会并发多个请求，后完成的覆盖先完成的（竞态）
3. 用户离开页面后 interval 才清除，但如果在页面内做了其他操作（如发帖后 `await loadMoments()`），可能与 interval 的刷新冲突
**修复建议**：用 `useRef` 跟踪最新请求 ID 防竞态；或改用 `setTimeout` 递归调用（前一次完成后再排下一次）。

### P1-2. `SmsApp` 创建模式缓存恢复逻辑可能覆盖正常短信消息
**文件**：`pages/SmsApp.tsx:163-179`
```ts
useEffect(() => {
  if (restoredRef.current !== null) return;
  const cache = loadCreationCache();
  if (cache) {
    restoredRef.current = cache.sessionId;
    setCreationSession(cache.sessionId);
    setCreationDraft(cache.draft);
    setCreationReady(cache.ready);
    setMessages(cache.messages);  // ← 直接覆盖
    setLoading(false);
  }
}, []);
```
**问题**：如果用户在创建角色中途切到另一个角色的短信线程再切回来，缓存恢复会用旧的创建消息覆盖该线程的真实消息。`restoredRef` 只检查一次，但 `threadId` 变化时 `loadMessages` 的 effect 会跳过加载（line 197: `if (restoredRef.current && restoredRef.current.length > 0) return`），导致切换线程后看不到新线程的消息。
**修复建议**：缓存恢复应与 `threadId` 绑定——只有当当前 threadId 是创建会话时才恢复；切换到其他线程应正常加载。

### P1-3. `ScenarioDream` 轮询无最大重试次数，错误时无限重试
**文件**：`pages/ScenarioDream.tsx:20-47`
```ts
const poll = async () => {
  try {
    // ...
    if (dreamData.dreamText) { /* done */ }
    else { setTimeout(poll, 2000); }
  } catch {
    if (!cancelled) { setTimeout(poll, 2000); }  // ← 出错也无限重试
  }
};
```
**问题**：如果后端持续返回错误（如 session 已失效、服务端故障），会每2秒无限重试，消耗电量/流量，且用户永远卡在"正在做梦…"页面看不到错误。
**修复建议**：加最大重试次数（如5次）和错误提示；超过次数后显示"生成失败，请重试"并提供返回按钮。

### P1-4. `AutoTextarea` 的 ref 覆盖了外部传入的 ref
**文件**：`components/AutoTextarea.tsx:17-19`
```tsx
return (
  <textarea
    {...props}
    ref={ref}  // ← 内部 ref
```
**问题**：组件接收 `props: React.TextareaHTMLAttributes<HTMLTextAreaElement>`，如果外部也传了 `ref`（通过 `{...props}` 先展开），内部 `ref={ref}` 会覆盖外部 ref。更严重的是，外部无法获取 textarea 的 DOM 引用（如 `useChatMessages` 的 `inputRef` 需要操作光标位置）。
**修复建议**：用 `forwardRef` 包装组件，或用 `useImperativeHandle` 合并 ref。

### P1-5. `LiveConflictModal.handleEndAndRedo` 中 `redo` 请求的 body 是已序列化的 JSON 字符串，会被二次序列化
**文件**：`lib/api.ts:73-74` + `components/LiveConflictModal.tsx:53-56`
```ts
// api.ts 保存 redo
redo: { path, opts };
// LiveConflictModal 重做
await api.fetchRaw(req.redo.path, req.redo.opts);
```
**问题**：`opts.body` 是原始请求的 body（已经是 `JSON.stringify(...)` 后的字符串）。`request()` 函数会设置 `Content-Type: application/json` 但不会再序列化 body（因为 `opts.body` 不是 undefined）。这部分其实是对的。但如果原始请求的 headers 被丢失（`request` 重新构建 headers），可能导致 body 格式不匹配。需确认 `redo.opts` 包含完整的 body 和 method。

### P1-6. 大量组件 `useEffect(() => { load(); }, [])` 缺少依赖，eslint exhaustive-deps 被禁用
**文件**：`MySpaceApp.tsx:61,162`, `NpcPanel.tsx:22`, `LocationPanel.tsx:41`, `InviteCodesPanel.tsx:16`, `FactsApp.tsx:49`, `MapApp.tsx:48`, `SceneMapApp.tsx:38`
**问题**：这些 `load` 函数通常定义在组件内且引用了 `setState`（闭包），但 deps 为空数组。虽然目前 `load` 不依赖 props 所以能工作，但如果未来 `load` 需要依赖某个 prop（如 `characterId`），不会自动重新加载。`SceneLocation.tsx:54` 甚至显式禁用了 eslint 规则。
**修复建议**：用 `useCallback` 包装 `load` 并加入 deps，或用 react-query/SWR 等数据获取库管理缓存和重新获取。

### P1-7. `Conversation` / `SceneConversation` 等大组件未做 `React.memo`，父组件每次 render 都重新渲染整个对话
**文件**：`pages/Conversation.tsx`, `pages/SceneConversation.tsx`（各 490/592 行）
**问题**：`App.tsx` 的 `renderScreen()` 每次都会重新创建 `onBack` 等回调（`() => setView(...)`），导致所有子组件重新渲染。对话页面组件大、消息列表长，每次 App 状态变化（如 unread count 更新，每8秒一次）都会触发对话页面的 re-render。
**修复建议**：用 `useCallback` 稳定回调；对消息列表项用 `React.memo`；将对话组件用 `React.memo` 包装。

---

## P2 中等问题

### P2-1. `App.tsx` 未读数每8秒轮询4个 API，频率过高
**文件**：`App.tsx:148-170`
```ts
const interval = setInterval(refreshUnread, 8000);
```
**问题**：`refreshUnread` 并发请求4个接口（emails、sms、moments、suggestions），每8秒一轮。移动端环境下频繁网络请求耗电，且后端负载高。
**修复建议**：延长到 30-60 秒；或用 WebSocket/SSE 推送未读数变更；或只在用户返回桌面时刷新。

### P2-2. `usePresence` 心跳依赖 `ctx` 对象，每次 render 都重建 effect
**文件**：`lib/usePresence.ts:87`
```ts
}, [view, ctx.sessionId, ctx.threadId, ctx.characterId]);
```
**问题**：deps 用了 `ctx.sessionId` 等（正确），但如果调用方每次 render 传新的 `ctx` 对象引用，虽然这里用的是属性值不会重建。不过 `onProactive` 回调如果不是 stable 的，`onProactiveRef.current = onProactive` 每次赋值虽然不会重建 effect 但会执行赋值。这部分还好，但 `clearPresence` 在 cleanup 中调用——如果 `ctx.sessionId` 变化导致 effect 重建，会先 clearPresence 再重新开始心跳，可能在快速切换时丢失心跳。
**修复建议**：可接受，但建议 `clearPresence` 只在真正离开页面时调用（用 ref 区分 unmount 和 deps 变化）。

### P2-3. `AvatarCropModal` 的 `clamp` 函数在 `handleWheel` 中引用了旧的 `off` 状态
**文件**：`components/AvatarCropModal.tsx:56-65`
```ts
const handleWheel = (e: React.WheelEvent) => {
  // ...
  const cx = off.x + visW / 2, cy = off.y + visH / 2;  // ← off 是闭包里的旧值
  const nvisW = STAGE / ns, nvisH = STAGE / ns;
  setScale(ns);
  setOff(clamp({ x: cx - nvisW / 2, y: cy - nvisH / 2 }));
};
```
**问题**：`handleWheel` 不是 `useCallback`，每次 render 重新创建，但如果连续滚轮事件之间 React 还没来得及 re-render（事件冒泡快于 state 更新），`off` 和 `scale` 都是旧值，导致连续缩放时位置跳变。`clamp` 也依赖 `img`（闭包），如果 img 未加载完成会返回原值。
**修复建议**：用 `useRef` 跟踪最新的 `off` 和 `scale`，在 `handleWheel` 中读 ref 而非闭包变量。

### P2-4. `FactsApp` 删除记忆没有确认弹窗
**文件**：`pages/FactsApp.tsx:70-78`
```ts
const handleDelete = async (id: string) => {
  try {
    await api.deleteFact(id);
    // ...
```
**问题**：删除按钮直接调用 API，没有二次确认。用户误触会直接删除记忆，不可恢复。对比 `MySpaceApp` 的删除操作都有确认。
**修复建议**：加 `confirmDelete` 状态，点击删除先显示"确认/取消"按钮组。

### P2-5. `ImageUploadButton.doUpload` 创建的 Object URL 未 revoke
**文件**：`components/ImageUploadButton.tsx:62-63`
```ts
const localUrl = URL.createObjectURL(file);
setPreviewUrl(localUrl);
```
**问题**：上传成功后 `previewUrl` 被设为 `imageUrl(result.imagePath)`（服务端 URL），但之前的 `localUrl` 没有被 `URL.revokeObjectURL` 释放，造成内存泄漏。每次上传都泄漏一个 blob URL。
**修复建议**：在 `setPreviewUrl(imageUrl(...))` 之前 `URL.revokeObjectURL(localUrl)`。

### P2-6. `MomentsApp` 点赞图片用 `classList.toggle` 直接操作 DOM
**文件**：`pages/MomentsApp.tsx:152`
```ts
onClick={(e) => (e.target as HTMLImageElement).classList.toggle('id-moment-image-expanded')}
```
**问题**：直接操作 DOM class 违反 React 声明式 UI 原则。如果组件 re-render，React 不会知道 class 变化了，可能覆盖掉 toggle 的结果。而且 `(e.target as HTMLImageElement)` 如果点击事件冒泡到子元素，target 可能不是 img。
**修复建议**：用 state 管理展开状态（如 `expandedIds: Set<string>`），通过 className 条件渲染。

### P2-7. `ScenarioEditor.handleCreate` 创建后用 `window.location.hash = ''` 硬操作路由
**文件**：`pages/ScenarioEditor.tsx:69`
```ts
window.location.hash = '';
```
**问题**：直接操作 URL hash，与 React 的 view 状态管理（sessionStorage + setView）不一致。如果 hash 路由和 view 状态不同步，可能导致刷新后恢复到错误页面。
**修复建议**：通过 `onNavigate` 回调更新 view 状态，不要直接操作 URL。

### P2-8. `FeedbackApp.SuggestionCard` 默认全部展开（`expanded` 初始为 `true`）
**文件**：`pages/FeedbackApp.tsx:246`
```ts
const [expanded, setExpanded] = useState(true);
```
**问题**：每条建议默认展开，如果有几十条建议，页面会非常长，用户需要大量滚动才能看到后面的内容。通常列表项应该默认折叠。
**修复建议**：初始值改为 `false`，或只默认展开第一条。

### P2-9. `NpcPanel` / `CharacterEditModal` 用 `JSON.parse(JSON.stringify(draft))` 深拷贝，性能差
**文件**：`components/CharacterEditModal.tsx:87`, `components/admin/NpcPanel.tsx:67`
```ts
const next = JSON.parse(JSON.stringify(draft));
```
**问题**：每次编辑任意字段都深拷贝整个角色数据对象（可能包含大量嵌套结构），性能开销大。对于频繁编辑（如输入框 onChange）的场景，会造成卡顿。
**修复建议**：用 `structuredClone`（现代浏览器支持）或手动浅拷贝+修改路径。或更好：用 immer 或不可变更新工具。

### P2-10. `Boot.tsx` 将邀请码保存在 localStorage 中用于自动登录
**文件**：`pages/Boot.tsx:19`
```ts
localStorage.setItem('idate_last_code', code.trim());
```
**问题**：邀请码等于密码，保存在 localStorage 中。如果 XSS 攻击或设备共享，邀请码被泄漏后可被他人登录。
**修复建议**：登录后只保存 token（已有），不要保存原始邀请码。如果需要"记住登录"，用 refresh token 机制而非重放邀请码。

### P2-11. `SettingsApp` / `MySpaceApp` 等多处 `setTimeout(() => setMsg(''), 3000)` 未清理
**文件**：`pages/SettingsApp.tsx:41`, `pages/MySpaceApp.tsx:75`, `pages/FactsApp.tsx:51`, 多处
**问题**：`showMsg` 函数中的 `setTimeout` 没有在组件 unmount 时清除。如果用户快速进出页面，定时器回调可能在组件已卸载后执行 `setMsg`，导致 React 警告（虽然 React 18 已移除此警告，但仍是潜在问题）。
**修复建议**：用 `useRef` 存储定时器 ID，在 unmount 时 `clearTimeout`。

### P2-12. `App.tsx` 自动登录逻辑在 `useEffect` 中调用 `api.login`，但无竞态保护
**文件**：`App.tsx:118-128`
```ts
const savedCode = localStorage.getItem('idate_last_code');
if (savedCode) {
  api.login(savedCode).then(data => {
    setToken(data.token);
    setPlayer(data.player);
    setLoading(false);
  }).catch(() => { setLoading(false); });
  return;
}
```
**问题**：如果 effect 因任何原因执行两次（StrictMode 开发模式下会执行两次），会发起两次登录请求。两次请求的回调都可能执行，导致状态混乱。
**修复建议**：用 `useRef` 标记是否已发起自动登录。

---

## P3 建议改进

### P3-1. Scene* 系列与非 Scene* 系列页面大量代码重复
**文件**：`Conversation.tsx` vs `SceneConversation.tsx`、`MapApp.tsx` vs `SceneMapApp.tsx`、`LocationDetail.tsx` vs `SceneLocation.tsx`、`Explore.tsx` vs `SceneExplore.tsx`
**问题**：四组页面功能高度相似，存在大量重复代码。维护时需要同步修改两个版本，容易遗漏。
**修复建议**：抽取共享逻辑为 hooks 或高阶组件，Scene* 和非 Scene* 只传入不同的 API 和配置。

### P3-2. `useChatMessages` hook 的 `options` 参数未做稳定化处理
**文件**：`hooks/useChatMessages.ts:79-95`
**问题**：`options` 对象每次 render 都是新引用，导致 hook 内部所有 `useCallback` 的依赖（`loadMessages`, `sendMessage` 等）都变化，重建所有 callback。虽然不会导致 bug，但会丢失 `useCallback` 的优化效果。
**修复建议**：调用方应用 `useMemo` 稳定 options 对象，或 hook 内部用 `useRef` 缓存最新的 options。

### P3-3. 大量内联 style 对象，阻碍浏览器复用样式规则
**文件**：几乎全部组件，如 `MissionsApp.tsx`, `MySpaceApp.tsx`, `SettingsApp.tsx`, `NpcPanel.tsx`, `LocationPanel.tsx`
**问题**：大量 `style={{ display: 'flex', gap: '0.5rem', ... }}` 内联样式，每次 render 都创建新对象，且浏览器无法复用样式规则。
**修复建议**：将重复的样式抽取为 CSS class；对组件内不变的样式用 `useMemo` 稳定对象引用。

### P3-4. `index.css` 使用了 `inset: 0` 简写属性
**文件**：`index.css:683,688,915,1073,2222,2382`
**问题**：`inset` 是 `top/right/bottom/left` 的简写，QQ浏览器（基于较老 Chromium）可能不支持。
**修复建议**：展开为 `top: 0; right: 0; bottom: 0; left: 0;`。

### P3-5. `index.css` 使用了 `clamp()` 函数
**文件**：`index.css:322`
```css
.id-phone-device { max-width: clamp(432px, 60vw, 760px); }
```
**问题**：`clamp()` 在 QQ浏览器中可能不支持。
**修复建议**：用 `@media` 查询替代，或加 `max-width: 760px; width: 60vw;` fallback。

### P3-6. `Desktop.tsx` 时间显示只在组件挂载时计算一次
**文件**：`components/PhoneShell.tsx:18-19`
```ts
const now = new Date();
const time = `${now.getHours()...}`;
```
**问题**：状态栏时间在每次 `PhoneShell` re-render 时才更新，不是每分钟更新。如果用户长时间停留在同一页面（不触发 re-render），时间会停留在旧值。
**修复建议**：用 `useEffect` + `setInterval` 每分钟更新时间 state。

### P3-7. `ArchiveApp` 搜索无防抖，每次 Enter 触发全量重新加载
**文件**：`pages/ArchiveApp.tsx:94-96`
```ts
useEffect(() => { loadList(tab, search); }, [tab, search]);
```
**问题**：每次 `search` 变化都重新加载列表。虽然目前是按 Enter 才搜索（`handleSearch` 设置 `search`），但如果改为实时搜索会频繁请求。建议加防抖。
**修复建议**：如果保持 Enter 触发则无问题；如果改实时搜索，加 300ms 防抖。

### P3-8. `ScenarioEditor` 字段保存用 `onBlur`，但 Roll 操作后自动保存可能与 onBlur 冲突
**文件**：`pages/ScenarioEditor.tsx:100-102`
```ts
const data = await api.rollScenarioField(scenario.id, key);
setFields(prev => ({ ...prev, [key]: data.value }));
await handleSaveField(key, data.value);
```
**问题**：Roll 后立即 setFields + handleSaveField。但如果用户在 Roll 请求期间正在编辑该字段（onBlur 尚未触发），Roll 完成后 setFields 会覆盖用户正在输入的内容。
**修复建议**：Roll 时禁用对应输入框，或 Roll 前检查是否有未保存的修改。

### P3-9. `FeedbackApp` 管理员操作无 loading 指示
**文件**：`pages/FeedbackApp.tsx:275-281, 395-399`
**问题**：管理员更新状态、删除建议等操作没有 loading 状态，操作期间按钮无变化，用户可能重复点击。
**修复建议**：加 `busy` state，操作期间禁用按钮并显示 loading。

### P3-10. `FeedbackApp.ChangelogPanel` 未读取（truncated）
**文件**：`pages/FeedbackApp.tsx:501+`
**问题**：文件在622行处截断，未能审查 ChangelogPanel 的完整实现。需确认其加载状态、错误处理是否与 SuggestionsPanel 一致。

### P3-11. CSS 中使用 `flex` + `gap` 在旧浏览器中可能不支持
**文件**：`index.css` 多处（30+ 处使用 `gap`）
**问题**：`gap` 属性在 flexbox 中的支持需要 Chrome 84+ / Safari 14.1+。QQ浏览器如果基于更老版本 Chromium 可能不支持。
**修复建议**：确认 QQ浏览器 Chromium 版本；如果不支持，用 `margin` 替代或加 `@supports` fallback。

### P3-12. `vite.config.ts` 未配置 `build.target`，可能输出不兼容的语法
**文件**：`vite.config.ts`
**问题**：如果未指定 `build.target`，Vite 默认 target 为 `'modules'`（支持原生 ESM 的浏览器），可能输出 `optional chaining`、`nullish coalescing` 等较新语法。QQ浏览器如果版本较旧可能不支持。
**修复建议**：设置 `build.target: 'chrome70'` 或更低版本，或用 `@vitejs/plugin-legacy` 生成兼容代码。

### P3-13. `PhoneShell` 的 `getFishToggle()` 在 render 中直接调用，不是响应式的
**文件**：`components/PhoneShell.tsx:17`
```ts
const toggleVisible = getFishToggle();
```
**问题**：`getFishToggle()` 从 localStorage 读取，但 localStorage 变化不会触发 re-render。如果用户在设置页切换了摸鱼开关，回到桌面后 `PhoneShell` 不会自动更新（除非有其他状态变化触发了 re-render）。
**修复建议**：将 fishToggle 状态提升到 App 级别，通过 props 传递，或用 storage event 监听变化。

### P3-14. `text-render.tsx` 的正则可能误匹配嵌套括号
**文件**：`lib/text-render.tsx:9`
```ts
const parts = text.split(/(\*[^*]+\*|（[^）]+）|\([^)]+\))/);
```
**问题**：正则 `（[^）]+）` 不支持嵌套中文括号（如"（他说（好））"），遇到嵌套会提前截断。`*[^*]+*` 不支持嵌套星号。
**修复建议**：对于游戏文本通常可接受，但如果内容复杂需改用更健壮的解析器。

---

## 总结统计

| 严重程度 | 数量 | 关键项 |
|---------|------|--------|
| P0 致命 | 3 | SSE无超时、异常冒泡、token URL泄漏 |
| P1 严重 | 7 | 轮询竞态、缓存覆盖、无限重试、ref覆盖、大组件无memo |
| P2 中等 | 12 | Object URL泄漏、DOM直接操作、深拷贝性能、无确认弹窗 |
| P3 建议 | 14 | 代码重复、内联样式、CSS兼容性、时间不更新 |

**最优先修复**：P0-3（token泄漏安全漏洞）→ P0-1（SSE超时）→ P1-2（缓存覆盖）→ P1-1（轮询竞态）
