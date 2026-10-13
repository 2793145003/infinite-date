# 未解决设计问题 · OPEN_QUESTIONS.md

> 实现到对应功能时需要先定的问题。已解决的问题已从此文件移除（见底部归档）。

---

## 1. NPC 放逐机制未实现

**背景**：原设计（已关闭问题3）规划了放逐NPC的清理逻辑——删除该instance及其per-instance数据（relationships/chronicles/character_permissions/description_changes/player_facts/memory_embeddings），保留friendships和npc_schedules。

**现状**：全代码库无 exile/banish/放逐 相关实现。目前删除NPC只有两条路径：
- 管理员删除公共NPC（admin.ts）—— 清理公共NPC专属数据
- 玩家删除好友（me.ts `DELETE /me/friend/:characterId`）—— 清理该玩家与该NPC的全部关联数据

**待确认**：
- 是否还需要独立的"放逐"功能（区别于删好友）？如果需要，instance级别的清理逻辑要补
- 如果不再需要，应从设计文档中移除放逐相关描述，避免设计与实现脱节

---

## 2. 记忆检索的query构造

**背景**：记忆检索架构已实现（embedding.ts + memory.ts），阈值已从设计文档的0.45-0.5校准到0.35（bge-base-zh问句vs叙事句相似度天然偏低）。

**仍未定**：query用什么构造？当前实现是用最后1轮对话上下文做query。设计文档原列了三个选项：
- 最后1轮（当前实现）
- 最后3轮
- LLM提取检索关键词

**待确认**：当前"最后1轮"的检索质量是否够用？需要实测数据规模增大后（几百条facts + 几十条chronicle）的召回情况再决定是否升级。

---

## 3. 剧本数值系统的平衡性

**背景**：剧本系统已实现（scenario.ts），数值系统由LLM生成（roll-stats）+ LLM判定增减（judgeStats）。数值规则、初始值、目标值全部由LLM产出，无人工校准。

**待确认**：
- LLM生成的数值规则是否可玩？可能出现初始值离目标太近（秒通关）或太远（不可能完成）
- judgeStats每轮调用一次LLM判定，数值增减幅度由LLM自由发挥，是否会出现刷数值/数值爆炸
- 是否需要对数值范围做硬约束（如delta上限、数值上下限）

---

## 4. 短信greeting的触发时机

**背景**：短信greeting已实现（sms.ts `generateSmsGreeting`），触发条件是"约会结束 + 已加好友 + 短信线程为空"。

**待确认**：
- greeting生成挂在约会结束流程里（conversation.ts line 562-584），是异步fire-and-forget。如果LLM生成慢，玩家切到短信页可能看到空线程
- 只在"线程为空"时触发，意味着玩家删光短信后重新约会结束也不会再收到greeting——这是有意为之还是漏洞
- greeting失败时静默吞掉（catch空），玩家无感知。是否需要前端轮询/重试

---

## 5. 搜索增强的token消耗

**背景**：搜索增强已实现（conversation-helpers.ts `maybeRetrieveSearchResults`）。NPC回复标记 `need_search=true` 时，检索记忆后重新生成回复——等于一轮对话产生两次LLM调用。

**待确认**：
- need_search触发频率多高？如果频繁触发，token消耗翻倍
- 重新生成时把检索结果拼进systemPrompt重跑，第二次生成的回复质量和第一次差异多大？是否值得双重消耗
- 是否需要限制单次会话内的search次数上限

---

## 归档：已关闭的问题

以下问题已通过代码实现解决，详情见git历史：

1. **副本切换后的体验设计** —— 权限钱包per-instance、好友继承机制、转场淡入淡出，均已实现（schema.ts + character.ts）
2. **角色任务做梦机制** —— 梦境生成、chronicle存储、向量化、梦短信，已实现（scenario.ts line 961-1095）
3. **孤儿数据清理：删除设计** —— 公共NPC删除、玩家删除、删好友的清理链已实现（admin.ts / player.ts / me.ts）。注：放逐机制未实现，见上方问题1
4. **任务评级与发放机制** —— 三级评估、rating_score加权、LLM评级，已实现（mission.ts line 474-629）
5. **NPC创建地点的权限归属** —— 酒馆模式下各玩家独立实例，已关闭
6. **"少量公共NPC"的选择规则** —— 行程hash seed含player_id，已关闭
7. **撤回与NPC主动消息的交互** —— 撤回只看最后一条role=player消息，已实现（conversation-helpers.ts `undoLastPlayerMessage`）
