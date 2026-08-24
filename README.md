# 无限心动（infinite-date）

无限流世界观驱动的多人联机 AI 约会模拟器。玩家通过引导式对话创建想攻略的角色，并与角色进行短信、约会、朋友圈互动与剧本角色扮演等。角色可以是全局共享的（公共态）、个人魔改的（override 私有态）、或完全私密的（完全私有态）。

灵感来自 [Heartmorrow](https://github.com/HMDSimDev/heartmorrow)——一个本地优先的 AI 约会模拟器。本项目借鉴了其「本地运行 + 角色驱动 + 模型即声音」的核心理念，在设计方向和技术实现上独立演进。

项目代码由 [Hermes Agent](https://hermes-agent.nousresearch.com)（Nous Research 的 AI 编程助手）完成，人类负责设计决策、需求定义和质量验收。

新版前端由群友 [@骨](https://github.com/1159522696kugu-rgb) 提供。

详细设计见 [DESIGN.md](./DESIGN.md)。

手机端截图：

| 约会 | 首页 | 地图 | 短信 | 朋友圈 |
|---|---|---|---|---|
| ![约会](./screenshot/约会0824.PNG) | ![首页](./screenshot/首页0824.PNG) | ![地图](./screenshot/地图0824.PNG) | ![短信](./screenshot/短信0824.PNG) | ![朋友圈](./screenshot/朋友圈0824.PNG) |

---

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Fastify 5 + TypeScript + tsx | Node 22+，tsx watch 热重载 |
| 数据库 | node:sqlite（内置） | 零原生依赖，WAL 模式，FK 级联删除 |
| 前端 | React 19 + Vite 6 + Tailwind 4 | 心动终端全屏 UI（web-v4），蝴蝶水彩壁纸，反代 /api→后端 |
| LLM | vLLM（OpenAI 兼容 API） | Gemma-4-26B-A4B-it，guided_json 结构化输出，多模态图文 |
| 向量检索 | bge-base-zh-v1.5 | 768 维语义检索，跨场记忆累积 |
| 包管理 | pnpm workspace | monorepo: server / web-v4 / shared |

---

## 核心特性

- **引导式角色创建**：多轮 AI 对话 + MediaWiki 联网搜索真实角色资料，不用 LLM 训练知识填充
- **多角色场景引擎**：逐拍点名 → 演员生成台词/旁白 → 数值结算
- **三层记忆系统**：热窗（近 N 轮原文）→ 中期折叠（LLM 总结）→ 长期总览 + 跨场语义检索（bge-base-zh）
- **卦象任务系统**：纳甲筮法起卦 → 卦象驱动生成原创世界任务（困境→目标态）→ 玩家带好友同行 → 通关评级发权限
- **角色主动消息**：意愿累积机制（sms_urge / moment_urge），行程变更时摇骰子触发，不依赖玩家在线
- **角色行程系统**：确定性 hash + 性格模板池，LLM 可覆盖调整，落库保证一致性
- **剧本系统**：场景剧本（玩家自创 + roll 字段 + 数值系统 + 梦境回写记忆）
- **男主来信**：连发短信未回时角色写信寄托思念（邮件系统）
- **三种角色形态**：公共态 / override 私有态（fork 完整角色卡）/ 完全私有态
- **per-player LLM 配置**：每个玩家可配置自己的 LLM endpoint，未填回落环境变量默认值
- **多模态**：图片发送（短信/约会/朋友圈），角色通过 vLLM 多模态能力「看到」图片
- **心动终端全屏 UI**：蝴蝶水彩壁纸、打字机动画、摸鱼浮窗（伪装 AI 助手）

---

## 快速开始

### 前置条件

- Node.js 22+（内置 `node:sqlite`）
- pnpm 9+
- 一个 OpenAI 兼容的 LLM endpoint（vLLM / Ollama / LM Studio 等）

### 安装

```bash
git clone <repo-url>
cd infinite-date
pnpm install
```

### 配置

```bash
cp .env.example .env
# 编辑 .env 填写你的 LLM endpoint 和 API key
```

### 启动

```bash
# 后端（3000 端口，热重载）
cd apps/server && pnpm dev

# 前端（3001 端口，反代 /api→后端 3000）
cd apps/web-v4 && pnpm dev

# 或一起启动
pnpm dev
```

打开 `http://localhost:3001/v4/`。

### 创建第一个账号（管理员）

登录采用**邀请码制**，邀请码必须预先存在 `invite_codes` 表里——没有"任意邀请码"、也没有首次运行自动建号。部署后需要手动创建第一个账号：

```bash
# 1. 生成第一个玩家（CLI 建号，会在控制台打印邀请码）
cd apps/server
npx tsx src/lib/auth.ts <你的名字>
# 输出示例：邀请码: ID-A4BE3648

# 2. 把这个玩家提为管理员（CLI 建号默认 is_admin=0）
sqlite3 data/infinite-date.sqlite "UPDATE players SET is_admin=1 WHERE name='<你的名字>';"
```

用上面打印的邀请码在登录页登录，你就是管理员了。之后可以在**管理后台 → 邀请码**里批量生成新的邀请码发给别人（`POST /admin/invite-codes`）。

> 说明：`COOKIE_SECRET` 若不设，每次重启随机生成，所有已登录用户会被登出。生产环境务必在 `.env` 里设一个固定值（`openssl rand -hex 32`）。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 后端监听地址 |
| `PORT` | `3000` | 后端端口 |
| `LLM_BASE_URL` | `http://127.0.0.1:8000/v1` | LLM endpoint |
| `LLM_API_KEY` | — | LLM API key |
| `LLM_MODEL` | `gemma-4-26b` | 模型名 |
| `CORS_ORIGINS` | `localhost:8080,5173` | CORS 白名单 |
| `IDATE_DATA_DIR` | `./data` | 数据目录 |
| `COOKIE_SECRET` | 随机 | Cookie 签名密钥（生产必设，否则重启全员登出） |
| `EMBEDDING_URL` | `http://127.0.0.1:8001` | 向量检索服务地址（bge-base-zh） |
| `EMBEDDING_MODEL` | `Qwen3-Embedding-8B` | OpenAI 兼容 embedding 形态下的模型名 |
| `VLLM_MAX_MODEL_LEN` | `16384` | vLLM 最大模型长度（与 vLLM 启动参数一致） |

---

## 项目结构

```
infinite-date/
├── DESIGN.md                 # 设计文档（完整设计决策）
├── LICENSE                   # The Unlicense（公共领域）
├── .env.example              # 环境变量模板
├── docs/
│   ├── CODE_MAP.md           # 代码地图（文件→职责→导出函数）
│   ├── DATA_MODEL.md         # 数据模型（全表定义 + migration 日志）
│   ├── PROMPTS.md            # Prompt 模板设计说明
│   └── OPEN_QUESTIONS.md     # 未解决设计问题
├── packages/
│   └── shared/               # 前后端共享类型
├── apps/
│   ├── server/               # 后端
│   │   └── src/
│   │       ├── index.ts      # Fastify 入口
│   │       ├── config.ts     # 配置
│   │       ├── db/           # schema + migration
│   │       ├── routes/       # API 路由
│   │       ├── lib/          # 核心逻辑（场景引擎/记忆/行程/主动消息…）
│   │       ├── llm/          # LLM 适配器
│   │       └── prompt/       # Prompt 模板（.txt 文件，改文件即改 prompt）
│   └── web-v4/               # 前端（心动终端，全屏 UI）
│       ├── server.ts         # Express + Vite middleware + 反代 /api→3000（multipart 直通）
│       └── src/
│           ├── App.tsx       # activeTab 状态机 + 全屏布局 + 行程四态
│           ├── components/   # 42 个页面/弹窗组件
│           └── lib/          # API 客户端 + 主题 + 地图几何
└── pnpm-workspace.yaml
```

---

## 架构概览

```
玩家浏览器（3001/v4）
    │
    ├── web-v4 Express + Vite ──proxy /api──▶ Fastify（3000）
    │                                      │
    │                                      ├── SQLite（node:sqlite，WAL，FK 级联）
    │                                      │
    │                                      ├── 场景引擎（点名版）
    │                                      │   ├── 逐拍点名 → 演员生成台词/旁白
    │                                      │   ├── 数值 & 气氛判定
    │                                      │   └── 跨轮复述检测
    │                                      │
    │                                      ├── 卦象任务系统
    │                                      │   ├── 纳甲筮法起卦（种子=玩家+时辰+序号）
    │                                      │   ├── 卦象驱动 worldgen（困境→目标态）
    │                                      │   └── 通关评级 → 权限奖励
    │                                      │
    │                                      ├── 三层记忆
    │                                      │   ├── 热窗（近 N 轮原文）
    │                                      │   ├── 中期折叠（LLM 总结 + 玩家事实提取）
    │                                      │   ├── 长期总览（跨场累积）
    │                                      │   └── 语义检索（bge-base-zh，三路分开搜）
    │                                      │
    │                                      ├── 角色行程（hash + 性格模板池 + LLM 覆盖）
    │                                      ├── 角色主动消息（意愿累积 + 行程变更触发）
    │                                      ├── 邮件（系统通知 + 男主来信）
    │                                      └── Prompt 模板（.txt 文件外部化，改文件即改 prompt）
    │
    ├── Embedding 服务（8001）
    │   └── bge-base-zh-v1.5（768 维）
    │
    └── vLLM（8000）
        └── Gemma-4-26B-A4B-it
```

---

## 许可证

[The Unlicense](./LICENSE)——可修改、可商用、可二次发布，无需署名。

---

## Roadmap

以下功能在 DESIGN.md 中有设计，尚未实现：

- **角色任务**：基于角色里程碑生成过去场景，玩家与镜像版角色互动，结束后梦境回写记忆
- **NPC 任务**：角色主动邀请，基于角色特长的温馨向任务
- **角色放逐**：per-instance 删除（区别于删好友的 per-character 删除），设计已有，实现待定

已实现的核心循环：角色创建 → 约会 → 短信 → 记忆 → 主动消息 → 朋友圈 → 场景剧本 → 卦象世界任务（含评级发权限）。

---

## 致谢

- [Heartmorrow](https://github.com/HMDSimDev/heartmorrow)——灵感来源，本地优先的 AI 约会模拟器
- [Hermes Agent](https://hermes-agent.nousresearch.com)（Nous Research）——全部代码由 Hermes 编写
- [Gemma](https://ai.google.dev/gemma)——Google 的开源大语言模型，本项目的默认 LLM
- [bge-base-zh](https://huggingface.co/BAAI/bge-base-zh-v1.5)——中文语义检索嵌入模型
- 测试群的小姐妹们——在联机测试过程中提供了许多非常好的建议
