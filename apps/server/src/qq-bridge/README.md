# QQ 桥（PoC）

把无限的**短信**接到 QQ 机器人：男主的短信推到你手机 QQ 的锁屏通知，你在 QQ 里回一句，
落到同一条 thread 上 —— 和网页端完全同一个会话。

> 状态：**已上线（2026-10-13）**。离线验证全通过 + 端到端实测通：三个绑定同时在线、
> 文字与图片双向都跑过。生产库里隔离性也验证成立 —— 两个玩家绑了**同一个男主**，
> 各自的机器人只收到各自的短信，零串线。

## 设计取舍（为什么长这样）

| 决定 | 原因 |
|---|---|
| 出站**不挂钩子**，只读轮询 `text_messages` | 星落的规矩：生产改动必须先离线验证。轮询让桥跑挂/跑错/重跑都不碰线上写入路径，而且同一套逻辑能拿真实历史数据回放 |
| 桥**不 import 服务端 `src/db`**，自己开库 | 桥挂了不影响主服务，也不会在桥启动时顺带跑服务端 migration |
| 表全部是**新增**的 `qq_*`，且由桥自己建 | `git status` 可验证：**零改动已有文件**，主服务不感知这些表 |
| 入站走**已有的** `POST /sms/threads/:threadId/send` | 心绪（角色级 `saveEmotionState`）、记忆、未读、行程全部自动共用，不会出现「短信一个世界、QQ 一个世界」 |
| 幂等靠 outbox 主键（= `text_messages.id`） | 网关重放、进程多开、崩溃重启都不会重复推送（同朋友圈重复事故的防御） |

## 三条内容规则

1. **只连短信**：只读 `text_messages`，约会 / 场景 / 朋友圈 / 邮件天然不在范围内。
2. **不发约会邀请**：邀请是短信接口 **HTTP 响应里的 `invite` 字段**，不是库里的行 ——
   桥从库里读消息，结构上就看不到它。`replay.ts` 里的断言 B 会盯着这一点，
   万一哪天有人把 invite 写进 `metadata`，回放立刻失败（因为那意味着它会经 QQ 外发）。
   注意：邀请卡不外发，但角色正文里自然说一句「想见你」是正常台词，照发。
3. **心声不外发**：`internal`（内心独白，网页端花权限解锁才看得到）**不进入 payload 类型** ——
   是类型层面的保证，不是「记得别拼进去」。网页端该看到的照旧看到。

## 跑法

```bash
cd apps/server

# ── 1. 出站规则离线回放（只读生产库，不写任何东西）──
npx tsx src/qq-bridge/replay.ts --db ./data/infinite-date.sqlite --limit 300 --samples 4

# ── 2. 绑定接口离线验证（不占端口、不碰生产库，用 fastify inject 直接打接口）──
npx tsx src/qq-bridge/verify-routes.ts

# ── 3. 端到端离线演练（写的是演示库，不是生产库）──
npx tsx src/qq-bridge/make-demo-db.ts ./data/infinite-date.sqlite /tmp/qqb/demo.sqlite
export IDATE_QQ_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npx tsx src/qq-bridge/main.ts --db /tmp/qqb/demo.sqlite --mock --once \
  --player <playerId> --character <characterId>

# ── 4. 并发重入（两轮追尾时不重复投递）──
npx tsx src/qq-bridge/verify-concurrency.ts

# ── 5. 角色卡时段锚点（示例里不许写死时段）──
npx tsx src/qq-bridge/verify-card-anchors.ts

# ── 6. 真接：跑常驻桥（绑定接口在主服务里，跟着主服务一起起）──
npx tsx src/qq-bridge/main.ts
```

### 常驻运维（上线后的日常）

```bash
bash /output/infinite-date-v2/start-all.sh   # 已纳入托管，幂等（在跑就识别为「已在运行」）
cat /tmp/idate_qqbridge.pid                  # 桥进程 pid
tail -f /tmp/idate_qqbridge.log              # 日志
kill $(cat /tmp/idate_qqbridge.pid)          # 停（重启后端不会停它）
```

起停细节与「日志对照表」见 `docs/DEPLOY.md` 的「QQ 桥」一节。两个要点：
**判活用 pid 文件，别用 `pgrep -f`**（会误匹配调用方 shell，明明没跑却报在跑）；
启动必须 `setsid`（`nohup` 不够，会随调用方退出）。

环境变量：

| 变量 | 用途 |
|---|---|
| `IDATE_QQ_SECRET_KEY` | AppSecret 加密密钥（32 字节 hex）。**必填**，没配就拒绝启动加密路径。生成：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `IDATE_API_BASE` | 无限的地址，默认 `http://127.0.0.1:3000` |
| `IDATE_DATA_DIR` | 数据目录（默认 `apps/server/data`） |
| `QQ_API_BASE` | QQ 开放平台 API 域名，默认 `https://api.sgroup.qq.com` |

## 绑定接口（在主服务里，src/routes/qq-bridge.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/qq/bindings` | 该玩家所有绑定（**不含密钥**），给角色卡片显示状态 |
| POST | `/qq/bind/qr/start` | 开扫码会话，返回 `{sessionId, qrDataUrl}`（服务端用 qrcode 生成 PNG data URL，前端直接 `<img src>`） |
| GET | `/qq/bind/qr/:sessionId` | 轮询扫码状态，同时拿最新二维码 |
| POST | `/qq/bind/manual` | 手填 `{characterId, appId, appSecret}` |
| DELETE | `/qq/bind/:characterId` | 解绑 |

鉴权沿用无限现有的 Bearer token。收发长连接**不在主服务里** —— 那些在独立的桥进程，
主服务只管 UI 需要的这几个接口。

⚠️ 扫码接口会真的去腾讯建绑定任务（`create_bind_task`），所以它需要能出网。

## 前端入口（apps/web-v4）

- `src/components/CharacterArchiveScreen.tsx` —— 每个角色卡片**右上角**的二维码按钮
  （原来那儿只有一个 hover 才显示的「编辑 →」，是空的，正好塞进来）；
  已接入的角色会有一个小圆点标记
- `src/components/QqBindModal.tsx` —— 弹窗：创建机器人引导 / 扫码 / 手填 / 已绑定状态 / 解绑 / 主动消息开关提醒
- 二维码**放在白底容器里**（`bg-white`）—— 深色主题下二维码扫不出来，这不是审美问题

## 隔离性（不同用户 / 不同男主之间）

四层各管一段，任何一段单独失守都不会串：

| 层 | 保障 |
|---|---|
| 库 | `qq_bot_bindings` 上 `UNIQUE(player_id, character_id)` + **`UNIQUE(app_id)`** —— 一个机器人（AppID）在库里只可能属于一个 (玩家, 角色)，不是靠代码判断 |
| 出站 | 每轮按 `binding.playerId + binding.characterId` 单独读那条 thread，用**该 binding 自己的** bot 发；并且**只发 `since_ts` 之后的短信** |
| 入站 | 按事件的 `app_id` 反查 binding（唯一），落到那个玩家的 thread；**openid 不匹配的陌生人消息直接丢弃**，既不入库也不覆盖 `user_openid` |
| 向下游 | 走 `POST /sms/threads/:threadId/send`，那条路由本身还有 `WHERE id = ? AND player_id = ?` 的归属校验 |

另外：限流额度按 binding 分桶（一个玩家被限流不影响别人）；入站去重键带 `appId`，不同 bot 的同名 `msg_id` 不会互相顶掉。

验证：
```bash
npx tsx src/qq-bridge/verify-isolation.ts
```
它建两个玩家、两个男主（**两个玩家聊同一个男主**）、四个独立机器人，跑 22 项断言 ——
包括「同一男主不同玩家不互串」「陌生人拿已绑定的 bot 发消息被丢弃且顶不掉 openid」「跨玩家抢同一个机器人被拒」「P1 被限流时 P2 一点不受影响」。

## 并发与重复投递（重要）

出站是个 `setInterval(20s)` 的循环，而**一轮可能跑超过 20 秒**（图片要先上传 1MB 再发，秒级起步）。
没有防护时 setInterval 会让下一轮**追尾并发跑**，同一批消息被发两遍 ——
表现就是「网页端只有一条/一张，QQ 上却有两条/两张」，而且**偶发**（只在那一轮超时时触发，
所以含图的回合最容易中）。实测复现：12 条消息两轮并发 → 投递 18 次、重复 9 条。

两层防护：

1. **claim 原子化**（`bridge.ts`）——新行直接写 `status='sending'`，并发的另一轮拿到
   `changes=0` 后看到「有人正在发」就 `busy` 让开；只有 `last_try_at` 超过 5 分钟（进程被杀）
   才接管。早期版本新行写 `queued`，于是并发那轮把它当成「上次失败待重试」，同一条发两次。
2. **循环重入锁**（`main.ts` 的 `outboundRunning`）——和 `lib/moment-scheduler.ts` 里的
   `ticking` 是同一套做法（那个坑项目里已经踩过一次，注释还在）。

另外限流检查必须**先抢占、再扣名额**：反过来的话并发两轮会为同一条消息各扣一次额度；
被限流时把这条**归还**成 `queued`，不要 `DELETE`（那会留下没有状态的僵尸行）。

验证：

```bash
npx tsx src/qq-bridge/verify-concurrency.ts
# 期望：投递次数 12 / 不同消息 12 / 重复 0
```

## 排查过的坑（两个都是「静默失败」，值得记住）

### ① 事件名取错 → 玩家消息永远收不到（根因级）

原来写的是 `const t = pkt.d?.t` —— 永远 `undefined`。用 `probe-gateway.ts` 打出网关原始帧才看清：

```json
{"op":0,"s":1,"t":"READY","d":{"user":{"username":"方知衡",...}}}
```

**`t` 在顶层**（不在 `d` 里）。于是所有事件（含 `READY`、`C2C_MESSAGE_CREATE`）都被判「不成立」而
静默丢弃：`qq_inbound_seen` 0 条、线程里最后一句玩家话停在两周前、**日志里一个字都没有**。
教训：文档/SDK 与现象对不上时，去看线路上真实跑的字节，别在代码里猜。

修：`const t = pkt.t; const d = pkt.d ?? {};`

### ② `msg_seq` 写死 1 → 同一个 `msg_id` 只能回一条

官方规则：`msg_id + msg_seq` 相同会被判重失败。被动回复窗口是 **60 分钟、最多 4 次**
（C2C 是 60 分钟/4 次；**群聊才是 5 分钟** —— 抄文档时别看错那一页）。
早期 seq 写死 1、而且只记在内存里，进程一重启又从 1 开始。
修：seq 存库推进，撞了自动抬序号。月亮那张照片就是靠这个发出去的（`attempts 2`）。

---

## 时间与时段（和桥有关，但不是桥的问题）

桥只搬运 `text_messages`，**不注入时间** —— 时间由服务端模板的 `【当前场景】时间：…` 提供。

但「大白天写月亮/写星空」这类漂移，来源之一是**角色卡示例里的时段锚点**：
`speechStyle.examples[].context` 写死「深夜」时，小模型会把示例的**语域和意象**一起搬走。
已清掉 9 处（3 张公共卡 + 6 份玩家 fork —— 有 fork 用 fork，两份都得改）。
规则与实测数据见 **`docs/PROMPTS.md` →「角色卡示例的时段锚点」**，校验脚本在本目录：

```bash
npx tsx src/qq-bridge/verify-card-anchors.ts
```

---

## 时间切流（`since_ts`）

绑定那一刻把这个角色的历史短信一刀切掉：**只外发 `since_ts` 之后的短信**。

为什么必须有：桥是靠轮询 `text_messages` 工作的，没有起点的话，第一次跑就会把
这个角色的**全部历史对话**倒进玩家的 QQ。实测踩到过 —— 绑完 20 秒内就往外发了 18 条
两个月前的旧消息，还有 494 条在排队（按 18/分钟要倒 27 分钟）。

- `bindManual` 在（重新）绑定时把 `since_ts` 设为当前时刻
- 边界用 `>=`：正好同一毫秒的消息会发出去。宁可边界上多一条无伤大雅的，也不要在绑定瞬间漏掉话
- 已有绑定补列时，迁移会把 `since_ts` 填成 `created_at`（绑定时刻），不会因为加列而重放历史

想改成「回填最近 N 条」也容易 —— 把 `since_ts` 往前推 N 条消息的时间即可。

## 已知欠账

- **入站取巧**：PoC 从 `sessions` 表拿玩家最新的有效 token 去调接口。正式版要加 service token
  （或内部鉴权通道），不要复用玩家会话。
- **「主动消息」开关：实测不需要，别当前置条件**。官方文档说 C2C 主动消息要用户在机器人资料卡手动打开
  「主动消息」推送开关，否则会被拒；但实测**机器人创建者（管理员）默认就能收** —— 首次接入时 18 条
  纯主动推送（手上没有可用 `msg_id`，走的就是主动消息）全部成功送达并返回真实 `qq_msg_id`。
  所以：`proactive_enabled = 0` 本身**不是问题**，UI 不该因此提示"去开开关"。
  只有平台真的以主动消息为由拒收（`proactiveBlocked`）时才需要提示用户去开。
  `C2C_MSG_RECEIVE` / `C2C_MSG_REJECT` 事件已接好，开着就能同步状态。
  （教训：文档写"需要"不等于实践里真的拦，先按实测结果做，别拿文档结论当硬前置去制造假待办。）
- **图片**：出站支持发图（从 `image_blobs` 读二进制 → 官方富媒体上传 → `msg_type:7`），
  **已在真机验证通过**（月亮那张照片实发成功，`attempts 2` —— 第一次撞 `msg_seq` 去重，抬序号后送达）。
  注意图片消息的出站 key 是 `<text_messages.id>:img`，和文字那条分开记账。
  `image_blobs` 是大头，演示库故意没拷。
- **机器人头像/昵称**：官方开放平台**没有**改机器人资料的接口
  （`setQQAvatar` / `modifySelfProfile` 是 NapCat 协议端的 NTQQ 内部 API，不是官方的）。
  所以只能创建者自己在 q.qq.com 管理端改 —— 引导文案必须写这一步，否则一排默认头像。
- **扫码页显示名**：官方 SDK 默认把接入方显示成「第三方机器人」。想显示「无限心动」，
  发邮件给 `qq_bot_api@tencent.com` 申请商务合作。

## 频控

| 维度 | 官方额度 | 桥里的设置 |
|---|---|---|
| 单关系（一个玩家） | 20/qpm | 18/qpm |
| bot（未认证） | 30/qpm | 25/qpm |

限流时**不抢占**：直接结束该绑定的本轮，剩下的消息留到下一轮，
避免「抢了名额却没发出去、然后永远卡在 queued」。
