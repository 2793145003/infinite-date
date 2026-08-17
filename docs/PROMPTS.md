# Prompt体系 · PROMPTS.md

> 本文档描述无限心动的prompt体系。

---

## 一、总体架构

prompt分两层：
- **框架**：角色数据→LLM prompt的组装逻辑
- **内容**：无限流meta层prompt

**所有prompt文本和权限数值表从外部文件读取，不硬编码在源码中。**
- Prompt文本文件存放在 `apps/server/src/prompt/templates/` 目录下（`.txt` 或 `.md`）
- 权限数值表存放在 `apps/server/src/config/permission_costs.json`
- 代码启动时加载到内存，运行时读取。修改prompt或调整权限数值不需要重新部署——改文件重启即可
- 这样prompt迭代（调角色风格、修OOC）和数值调优（改权限消耗/奖励）不碰代码

---

## 二、Prompt清单

### roleplay.system — 通用角色扮演规则

核心：NPC知道自己是NPC，知道和玩家在一起能获得更多权限，这是NPC主动社交的动机。角色保持自己的性格，但不伪装"不知道自己是NPC"。

> **用词禁词（2026-08-07 落地）**：模板最开头一行 `【用词】严禁使用「该死」一词。`（角色名为「该死」的情感宣泄起手式，会污染台词与付费心声）。经真实案发 #4321 AB 测试：抽象正向引导（弦崩/符合人设）全无效，**精准点名禁词**才有效（心声 4/5→0/5）。注意：命中"提词即钩子"的精准点名单词，与禁止"宽泛负面禁令"并不矛盾——规则是**点名特定顽固词**有效，泛泛禁脏话/抽象引导无效。

**权限是动机，不是话题**：NPC不会在对话中主动谈论权限机制。就像人不会说"我跟你说话是因为我有社交需求"。权限驱动行为但不进入对话内容。

例外——以下情况可以自然流露：
- 玩家直接问是否是NPC → 诚实回答
- 任务被拒后发短信 → "真希望你也在"（暗示遗憾，不说"我少了权限"）
- 玩家主动聊起系统/权限话题 → 可以聊，但用自己的话，不背设定文档

**叙事规则：行为信号替代心理陈述**
- NPC的情绪通过行为传达，不直接写"她感到X"
- 面对面场景：玩家能看见NPC，每条回复都要有身体语言——表情变化、肢体动作、与环境的互动、和玩家之间的物理距离感。用（括号）包裹动作描写，穿插在台词之间。参考角色卡的 `emotional_signals` 写这个角色特有的动作
- 短信场景：玩家看不见NPC，通过文字特征传达情绪（回复速度、消息长度、标点变化、语气词增减），不用动作描写
- 内心独白：写当下真实感受和微反应，不写情绪标签
- 角色卡的 `emotional_signals` 是每个角色的行为信号映射——紧张时这个角色具体做什么，开心时具体做什么。prompt-builder注入后，LLM按角色的特有方式表达情绪，不用泛泛的"会笑""会皱眉"

**三层性格的使用规则**
- `surface`：初识/公共场合/主城偶遇时呈现
- `core`：好友关系建立后、信任感形成后呈现
- `extreme`：深度约会、角色任务、激烈冲突、情感崩溃时呈现
- prompt-builder根据关系阶段和情境注入对应层。LLM自然判断切换——不需要硬规则，角色卡描述够清晰时LLM读得懂
- 三层不是开关，是渐变。core里可以有surface的影子，extreme是core的延伸不是另一个人

### creator.guide — 系统引导角色创建

系统引导式角色创建的对话prompt。AI扮成系统助手，与玩家对话逐步生成角色卡。

**创建流程包含两个阶段：**
1. **角色卡构建**：对话式生成角色设定。IP角色：AI联网搜索→预填角色卡→用户确认/修改。原创角色：AI先问名字，再按性格三层逐层引导提问（name→surface→core→extreme→emotional_signals→background→player_relation→skills→ineptitudes），每层追问具体表现和来由。角色卡定稿前，AI根据角色背景判断是否生成 `backstory_milestones`——IP角色有原作过去通常生成多个；原创角色有人生转折点也会生成；背景平淡的不生成（该NPC没有角色任务）。`player_relation` 描述角色和玩家的预设关系，IP角色从原作关系提取，原创角色可留空；有值时初始 `player_description` 用它而非"刚认识的陌生人"，影响NPC开场态度。`skills`/`ineptitudes` 是自由文本描述角色擅长和不擅长的事，NPC任务时系统据此生成配合角色特长的世界
2. **初始关系设置**：角色卡定稿后，AI根据角色背景建议初始 `player_description`。玩家确认或自定义，写入 `relationships.player_description`

**里程碑生成要点：**
- 每个里程碑需包含：label / time_description / summary / diff（和当前角色卡不同的字段）/ dramatic_potential
- diff 只存差异字段——如过去版本形态不同，只写 appearance；性格有变化，只写 personality 的某一层（如只改 core，surface 和 extreme 继承当前角色卡）。prompt-builder合成镜像角色卡时用 diff 覆盖当前角色卡对应字段
- dramatic_potential 评估这段过去的戏剧张力（是否有意难平、遗憾、未完成的事）。high 优先选为角色任务素材

### mission.worldgen — 世界任务生成（卦象驱动，生产默认）

世界任务的世界由**卦象驱动**生成。一次 LLM 调用输出完整世界设定 + 地标 + 世界NPC + 任务切入点 + 通关流程：

- **输入**：卦象启示层（`hexagram_layer`，本卦/互卦/变卦/错卦四层）+ 纳甲人物关系网（`najia_layer`，六亲→叙事角色映射）+ 世界观基调（`theme_guide`）+ 任务目标玩法（`goal_guide`）+ 世界卡牌（`world_cards`，地名/人名/困境/物品随机卡）+ 玩家性别 + 同行者性别约束
- **输出**：`name` / `summary` / `tone` / `rules` / `lore` + `world_tension`（困境表象）+ `target_state`（目标态）+ `hidden_thread`（隐藏暗线）+ `briefing` + `descend_identity`（玩家/同行者降临身份）+ `landmarks` + `world_npcs`（含任务核心对象/对手/贵人/靠山/竞争者/所求之人六类）+ `mission_hook` + `twist_seed` + `clues` + `environmental_clues` + `goal_path`（通关流程）+ `mission_goal`
- **卦象是幕后骨架**：玩家永远看不到卦象，模板把骨架翻译成"一个人（或一小群人）具体的生活困境"——有名字、有面孔、有心碎的理由。困境要落到具体的人身上，不是抽象系统失衡
- 世界NPC是真实生活的人，各自陷在困境里，有自己的名字、立场、改变的可能

> 变体（AB 实验备选）：`mission.worldgen-goal.txt`（goal 版）与 `mission.worldgen-grounded.txt`（grounded 版）是同一生成的实验分支，生产默认用 `mission.worldgen.txt`。见 `scripts/ab-worldgen-goal.ts` / `ab-worldgen-grounded.ts`。

### mission.evaluator — 世界任务评级

世界任务完成后，由约会评估器（LLM）在约会结束时判断三级评估：

- **目标达成**（数值系统判定）：困境浓度是否降至目标态，由 `judgeStatsAndAmbient` 逐轮判定，输出 `goal_achieved` 布尔值；评级器（LLM）复核并纠偏
- **合作质量**（LLM判断）：玩家和同行NPC有没有真正合作？还是各走各的？输出 `cooperation_quality` 字符串（'poor' / 'decent' / 'excellent'）
- 结果存入 `missions.evaluation_result`（JSON），评级得分存入 `missions.rating_score`（1-3），用于更新 `players.rating_score`
- 评级影响后续任务发放：评级高→系统发更多更好的任务，评级低→减少或限制
- **评级后自动发权限**：`grantPlayerPermission(playerId, totalReward, 'mission_reward')` + 同行NPC也获得权限（合作收益）。奖励数值由 `permission_costs.json` 配置

### phone.sms.style — 通用短信风格

通用短信风格规则，由角色卡的 `textingStyle` 驱动。

**离线补发的递进式生成**：玩家离线期间NPC的eligible命中超过1条时，LLM生成短信需要知道这是第几条补发，按递进情绪弧线生成：
- 第1条：正常语气（分享日常、找你聊天）
- 第2条：疑惑语气（在忙吗？怎么不理我？）——因性格而异：有的直球问，有的暗戳戳试探，有的装不在意
- 第3条：体谅放手（看来你最近很忙，等你回来了再聊）——不记恨，但带一点失落
- prompt注入参数 `offline_message_index`（1/2/3），LLM据此调整语气

### npc.proactive_message — NPC主动短信生成

NPC主动发短信时的内容生成prompt。两种触发路径，共用角色卡和上下文注入，但prompt内容不同：

**路径一：离线积压（eligible命中）** — 玩家离线期间积累的意愿，上线时补发。与phone.sms.style配合使用——phone.sms.style管风格，本prompt管内容和上下文注入。

**路径二：在线闲置（presence心跳）** — 玩家正在看聊天界面但闲置不动，前端心跳触发。prompt区分第几次追问：
- 第1次（unansweredProactive=0）：「安静了一会儿。你自然地开口说点什么——想到什么就顺口提了，或者注意到对方的某个细节。简短、随意，符合你的性格。不用等对方先说。」
- 第2次（unansweredProactive=1）：「你之前主动搭了话，但对方一直没回应。你注意到了这份沉默——可能有点在意，可能觉得对方在发呆。再试一次，语气自然地追问或换个话题。简短，符合你的性格。不要表现出被忽视的不满，更像是随口一提。」
- 第3次：不触发（连续2条未回应后停止）
- 约会和短信场景各有一套对应prompt，语气适配场景（约会是面对面，短信是远程文字）

**输入注入**：
- NPC角色卡（personality/textingStyle）
- 当前 `player_description` + 记忆摘要（Chronicle）
- 触发场景（哪个eligible命中了）：NPC任务被拒后 / 闲置久了 / 行程结束 / 角色任务做梦后 / 约会任务结束后
- `offline_message_index`（如果是离线补发，见phone.sms.style）

**场景各自的生成要点**：
- **NPC任务被玩家拒绝后**：NPC独自完成任务，回来分享喜悦。语气因性格而异——纯粹分享 / 暗藏遗憾。不带记恨
- **闲置久了**：NPC主动找话题。内容因性格而异——有的直球"在忙吗"，有的分享日常找话头
- **行程结束**：NPC刚做完一段主城行程（如从咖啡店出来），分享刚发生的事。内容由行程activity驱动
- **角色任务做梦后**：NPC梦到任务的大概，主动发短信。梦境内容由临时Chronicle摘要生成，dream短信生成后Chronicle丢弃
- **约会/任务结束后**：NPC和玩家刚一起经历过一段时光，有概率主动发短信。内容由约会评估器刚生成的Chronicle摘要驱动——整体氛围、印象深刻的瞬间、未尽的话题。语气因性格和约会质量而异：开心的约会后自然分享余韵，尴尬的约会后可能只发一句简短的「到了」。不是每次都发。角色任务不触发此场景（走做梦机制）

### judge.evaluator — 约会总结

约会总结生成器。生成Chronicle摘要和NPC后续态度。不计算任何数值——NPC态度由 `player_description` 驱动，LLM每次回复时自带是否更新描述。

### moment.post — NPC发朋友圈

NPC主动发朋友圈时的内容生成prompt。两种触发路径，共用角色卡和上下文注入：

**路径一：约会结束后触发**（60%概率）— LLM根据约会Chronicle摘要生成帖子。内容是NPC对约会的自然记录——整体氛围、印象深刻的事、约会中的小细节。语气因性格和约会质量而异：开心约会后分享余韵，普通约会可能只发一句日常。不是每次约会都发（40%不发）。

**路径二：心跳随机触发**（10%概率，5分钟冷却）— NPC"闲逛时想发条朋友圈"。内容是NPC日常生活的自然流露——看到什么有意思的、突然有些感慨、刚做完一件事想记录。prompt注入随机上下文提示（"你正在闲逛突然想发条朋友圈"等），NPC根据角色性格生成内容。

**输入注入**：
- NPC角色卡（personality/speechStyle/emotional_signals）
- 触发场景上下文（约会摘要 或 随机提示）
- NPC当前行程位置（location_name）
- 当前 `player_description` + 记忆摘要

**输出**：帖子正文 + mood（心情标记）

### moment.comment — NPC评论生成

NPC在朋友圈帖子下生成评论的prompt。两个场景：

**场景一：玩家发帖 → NPC评论** — 玩家发帖后，好友NPC异步生成评论。每个好友50%概率"刷到"并评论，至少1个好友评论。模拟延迟（30秒~几分钟），不是瞬间回复。评论内容基于NPC角色性格 + 对玩家的记忆 + 帖子内容。已有评论作为上下文注入，避免重复。

**场景二：玩家评论NPC帖子 → NPC回复** — 帖子作者NPC异步回复玩家的评论。回复内容基于NPC角色性格 + 帖子上下文 + 玩家评论内容 + 已有评论。

**输入注入**：
- NPC角色卡（personality/textingStyle）
- 被评论的帖子内容
- 已有评论列表（避免重复，提供对话上下文）
- 当前 `player_description`

**评论风格**：短小精悍，像朋友圈评论不是小作文。符合角色性格——有的直球，有的含蓄，有的玩梗。

### internal — 内心独白格式

NPC内心独白要写**当下真实感受和微反应**，不是总结发生了什么。质量是付费窥探功能的前提。

- 参考角色卡的 `emotional_signals` 写这个角色特有的微反应，不用泛泛的"心跳加速"
- 独白写的是NPC真实的内心活动——可以和表面行为形成反差（嘴上冷淡心里在意），这正是付费窥探的价值所在

### deity.system — 主神

主神的客服式回复prompt。温和而非软弱，理性而非冷漠，博学而非卖弄，优雅而非做作，偶尔冷幽默。不堆砌客套话，简洁有力。不是搞笑担当，但恰到好处的一句能让人会心一笑。有结构化功能菜单，也支持自由对话。不做角色扮演——是系统前端，不是角色。

### 单聊约会greeting — trigger参数

`generateGreeting()` 接收可选的 `trigger?: 'talk' | 'invite'` 参数，区分两种开场场景：

- **搭话**（`trigger` 不传或 `'talk'`）：NPC正在做自己的事，玩家走过来。greeting hint："玩家向你走了过来" / "玩家又来找你了"
- **邀请**（`trigger: 'invite'`）：NPC被玩家邀请赴约。greeting hint："玩家邀请你来XX约会" / "你应约而来"

同一套system prompt（roleplay.system），只是greeting的user message不同，让NPC的开场态度匹配场景。

### group.system — 群聊约会

群聊约会专用prompt。一次LLM调用同时扮演2个角色，与玩家进行三方对话。

**与单聊prompt的核心差异：**
- 注入两个角色卡（各自完整的性格三层、说话风格、情绪信号、背景、关系、记忆摘要）
- system prompt开头明确"玩家主动邀请了你和另一个角色一起到这里来"
- 角色之间互相react——接话、反驳、补充、反应，不是各自对玩家独白
- 消息顺序是自然对话流：可能A连说两句，B插一句，A回一句
- 输出schema不同：messages带speaker字段，internals/player_descriptions是per-character的map

**输入注入：**
- 两个角色各自的PromptContext（characterData + playerDescription + chronicle + memories）
- 玩家信息
- 当前场景（时间、地点）
- 主城地点列表
- 历史消息（NPC消息带角色名前缀）

**输出Schema（GROUP_REPLY_SCHEMA）：**
```json
{
  "messages": [
    { "speaker": "角色A名字", "text": "台词（动作描写）" },
    { "speaker": "角色B名字", "text": "台词（动作描写）" }
  ],
  "internals": { "角色A名字": "内心独白", "角色B名字": "内心独白" },
  "internals_notable": { "角色A名字": false, "角色B名字": false },
  "player_descriptions": { "角色A名字": "对玩家定性", "角色B名字": "对玩家定性" },
  "scene_concluded": false
}
```

**记忆处理：** 群聊结束时per-character折叠记忆。对角色A折叠时，角色B的话作为"（旁人）角色B：xxx"保留在上下文，但key_memories和player_facts只提取跟角色A直接相关的。chronicle的source标记为 `'group'`。

### scenario.system — 剧本系统

剧本是角色任务的升级形态：系统生成一段剧情脚本，玩家进入NPC的过去/平行世界体验完整故事线。与角色任务不同，剧本有完整的数值系统、多轮分支、梦短信机制。

**剧本prompt文件清单：**
- `scenario.system.txt` — 剧本对话system prompt，注入剧本设定、数值系统、NPC镜像角色卡、玩家属性
- `scenario.roll.txt` — 剧本世界生成（标题、简介、规则、数值配置、开场白）
- `scenario.stats-judge.txt` — 每轮对话后判定玩家属性变化（根据NPC反应和事件发展）
- `scenario.stats-roll.txt` — 剧本数值系统初始掷骰
- `scenario.dream.txt` — 剧本结束后梦短信生成（NPC梦到剧本中发生的事，主动发短信给玩家）

**剧本对话流程：**
1. 创建剧本 → `scenario.roll` 生成世界设定+数值配置+开场白
2. 玩家进入剧本 → `scenario.system` 注入system prompt，`generateScenarioGreeting` 生成开场
3. 每轮对话 → `generateReply` 生成回复 + `scenario.stats-judge` 判定属性变化
4. 剧本结束 → `scenario.dream` 生成梦短信，NPC主动发短信

**剧本对话复用 `generateReply`（三层防御）**，与短信/约会路径完全一致。剧本的 `replySchema` 是 `REPLY_SCHEMA` 的子集（不需要 `current_location`），`normalizeReply` 对缺失字段有默认值，直接兼容。

**梦短信机制**：剧本结束后，NPC根据剧本Chronicle摘要"做梦"，主动发短信给玩家。梦短信不提取 `player_facts`（`skipPlayerFacts=true`），因为梦境不是真实经历。

### explore.system — 探索系统

探索是玩家在主城地点自由走动时的场景生成系统。玩家进入地点后触发探索，NPC可能出现并互动。

**探索prompt文件：**
- `explore.system.txt` — 探索场景system prompt
- `explore.continue.txt` — 探索继续对话prompt

### scene 引擎（场景约会/实景约会，v2 核心）— 点名版

> **2026-08-08 起为点名版引擎**（设计文档：`docs/scene-director-rename-design.md`，已标注"已投产"）。DB 开关切换引擎，前端 API 不变（仍走 `/scene/*` 路径）。旧导演版 `scene.director.txt` 头部已标注过时。
>
> 点名版核心：不再由导演预排整轮 beat 序列，而是**逐拍点名**——每拍由 `pickNextSpeaker`（namer）选下一个说话者，角色自己演，演完再点下一个，点到"玩家"则结束本轮。

**scene prompt文件：**

- `scene.director.txt`（旧版，已标注过时）— 旧导演：产出"分镜脚本"（beat 序列），预排整轮谁说话/何时把话头抛回玩家。**点名版不调用此文件**，但文件保留作为回退。与点名版差异：缺数值结算/导演全局视角/开场情境区分。
- `scene.actor.txt` — **演员/角色**：每个角色只演自己（有性格/记忆/当下情绪）。模板变量：`{{character_card}}`（人设）、`{{player_profile}}`（对方是谁）、`{{player_description}}`+`{{chronicle_summary}}`+`{{retrieved_memories}}`（过往）、`{{scene_tone}}`（所在世界与场景——任务场景=任务世界困境+地点氛围）、`{{scene_rules}}`（规则与立场——含逐人 stance，任务场景的玩家/男主身份、任务目标、开局情境都在这）、`{{beat_intent}}`（这拍的方向）、`{{current_activity}}`（当前活动/目的）、`{{available_locations}}`/`{{internal_locations}}`（可移动的地点）。输出 JSON：
  ```json
  { "texts": ["你说的话", "可分几段"],
    "player_description": "你对对方的一句话定性(可保持不变)",
    "current_activity": "你和对方当前在做什么/要去哪里(可保持不变)",
    "move_to": "目标地点名(仅真要带人走时填,否则空)",
    "internal": "内心独白(不给对方看)",
    "internal_notable": false }
  ```
  关键纪律：
  - 台词中文纯文本**不用引号包裹**；动作神态用**中文括号（）**写进话里或话尾；每条至少要真说点话，不要单独一条只有动作没话。
  - **current_activity**（2026-08-09）：角色每拍都输出，不变也可以；当活动发生变化时更新。防止场景停滞。存于 `scene_relationships.current_activity`，跨场延续。
  - **move_to**（2026-08-08 从 namer 移到 actor）：角色自己带出移动意图，台词里自然说"走吧""跟我来"。仅当真要带对方去另一个地方才填，填目标地点名；不能创建与当前地点无空间包含关系的地点。
  - **指代用语**（2026-08-08，AB v12 验证 21%→4%）：不要用"X个字"来指代对方刚才说的话（如"听到这两个字"），需要提及时直接说"这句话""你刚才的话"。
  - **复述检测**（2026-08-09）：程序检测首条 bubble 是否复述玩家话（去标点去"你我"后连续≥3字匹配），命中则调 LLM 改写（分3类：复述内容/依附比喻/实际动作，删前两类保留第三类）。平时零开销——不复述不触发 LLM。
  - **用词禁词**：模板最开头一行 `【用词】严禁使用「该死」一词。`（与 roleplay.system 同款，覆盖台词+心声）。心声字段描述另加"不要用感叹词或脏话开头，直接写感受本身"（AB v10 验证：心声该死率 35%→0%）。
  - `cleanStraySymbols()` 在落库前清洗游离的中文/半角右括号/右引号（Gemma 偶发句尾多补孤立 `）`或`"`）；`normalizeActorOut` 把 JSON 里的字面 `\n` 转回真实换行符。

- `scene.greeting.txt` — **开场**：按「开场情境」分节（circumstance 选择小节，无匹配回退 `[default]`）。包含 `[invite]`/`[deity_pick]`/`[npc_invite]`/`[caught]`/`[approach]` 等情境。改本文件需重启后端（loadPrompt 有缓存）。

**旁白**（2026-08-08 迭代定稿）：
- 开场旁白：**主动插入**（点名循环之前第一拍），不是兜底。
- 转场旁白：move 后若 output 末尾不是旁白，则插入一段新地点的环境旁白（避免旁白连旁白）。
- 旁白四类触发：①有变化在发生 ②当下一瞬活得有质感 ③对话到头需带开 ④对话尴尬/冷场时顶替路人递话头。无四类瞬间不排。

**任务场景（mission）NPC 认知**（2026-08-15 定稿）：任务场景（`scene_type='mission'`）的 actor 走同一套 `scene.actor.txt`，但 `scene_tone`/`scene_rules` 额外注入任务信息，`stance` 按角色身份逐人分发（男主=任务世界人物名单+同伴立场；任务 NPC=按 role 的定位）。六亲关系（谁贵谁敌）对玩家/男主隐藏、NPC 自己按定位演。完整设计见 `docs/HEXAGRAM_MISSION_DESIGN.md`「任务场景 NPC 认知」节。

---

## 三、LLM结构化输出

NPC的每次回复（短信/约会）是一次LLM调用，同时输出文本和结构化数据：

> 注：本节描述的是「短信/老约会」接口的输出（字段名 `messages`）。**场景约会（scene 引擎）用不同的字段名 `texts`**（见上节 scene.actor），两者不要混用。

```json
{
  "messages": ["第一条", "第二条"],
  "internal": "她居然记得我喜欢肉桂卷……",
  "internal_notable": true,
  "player_description": "还挺有趣的交谈对象",
  "scene_concluded": false
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| messages | string[] | NPC一次回复可能发多条短信（逐条弹出）。短信场景：每条入库为一条text_message。约会场景：作为session消息存入messages表 |
| internal | string | NPC内心独白，默认不展示给玩家。两个用途：①debug ②喂给Chronicle做记忆压缩素材。玩家可消耗权限窥探 |
| internal_notable | bool | LLM自判这条独白值不值得付费看。大喜大悲、嘴上冷淡心里在意、反差最大的时候=true。平淡反应=false。玩家看到标注"有心声"的才能付费解锁 |
| player_description | string | NPC对玩家的一句话定性。每次都输出，值可以和上一轮相同（保持原样）。存入relationships.player_description |
| scene_concluded | bool | 仅约会中输出。LLM判断场景是否自然收束（如NPC说"我们回去吧"）。true时前端提示"对话已自然结束"，玩家可选择继续或确认结束 |

### prompt中的关系语义

prompt-builder注入以下内容供LLM判断态度：
- **记忆**：Chronicle折叠后的记忆摘要（事件流水）
- **玩家描述**：当前relationships.player_description的值（NPC上一轮对玩家的定性）
- **角色性格**：角色卡的personality（按关系阶段注入surface/core/extreme）+ speechStyle（含对话示范）+ emotional_signals

LLM读这些文本自然判断语气、距离感、是否暧昧、是否生气。不需要任何数值指导。吵架后LLM读记忆知道刚吵过，自然调整态度——但不会变成等着玩家哄的石头（prompt规则：NPC有自己的破冰方式，因性格而异）。

### 解析策略：三层防御

prompt要求输出JSON，采用三层防御保证健壮性：

1. **guided_json**：LLM调用时传 `guided_json` 参数（vLLM原生支持的结构化输出），约束LLM输出合法JSON
2. **重试**：parse失败时重试一次（重新调用LLM）
3. **salvage**：重试仍失败时，检测原始输出是否 `startsWith('{')`，尝试提取JSON片段解析
4. **fallback**：最终fallback——把原始输出当纯文本reply，不更新player_description和internal。两个人的游戏偶尔fallback无所谓

所有对话路径（短信/约会/剧本/任务greeting/群聊）统一走 `generateReply` 或 `generateGroupReply`，内置完整三层防御。

---

### 独白窥探

NPC内心独白（internal）默认对玩家不可见。玩家可消耗权限查看某条NPC回复对应的独白。**这是玩家（主神赋予）的超能力之一，一开始就解锁，不限关系深浅。**

- **时机**：任何时候都能看，不限约会中还是结束后
- **LLM自判**：每次回复LLM输出`internal_notable`布尔值，自己决定这条独白值不值得付费看。大喜大悲、反差最大的时候=true，平淡反应=false
- **计费**：花权限解锁一条，之后反复看不花钱
- **隐藏信息通道**：玩家看到"这条没有心声"本身就知道NPC情绪波动不大——这本身是信息
- **NPC不感知**：玩家看独白是上帝视角，不进入NPC认知
- **情感价值**：有心声的时候正是反差最大的时候——嘴上冷淡心里在意、嘴上无所谓心里吃醋
- **前提**：internal质量必须够高。prompt要求写NPC当下真实感受和微反应，不是"她说了这句话，我觉得有点开心"这种总结
