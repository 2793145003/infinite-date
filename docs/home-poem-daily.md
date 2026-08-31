# 首页每日情诗（Home Daily Poem）

> 状态：设计定稿待实现（2026-08-26）
> 范围：后端 + 前端（web-v4 首页）。替代现在写死的占位诗句。

---

## 0. 一句话

每天第一次打开首页，让当前固定在主页的男主，结合"你们俩最近的事 + 他这个人"，现场写一句情诗，替换掉现在那句写死的"那些共度的静谧时光，最为震耳欲聋。"。当天落库复用，换角色换诗。

---

## 1. 拍板结论（用户逐条确认）

| # | 点 | 结论 |
|---|---|---|
| 1 | 上下文 | **复用现有统一记忆管线**（最近短信/约会/朋友圈 + 记忆三折叠），不另造四层 |
| 2 | 多角色 | 换人重新生成：每 player×character 一天一句，切到谁生成谁 |
| 3 | 缓存 | 落库，当天复用，当天不重写 |
| 4 | 模型 | **gemma**（无限唯一文字模型，vLLM 本地 `chat()`）。此前"主线对话 deepseek"是误记——那是 Hermes agent 自己的模型，与 infinite-date 项目无关 |
| 5 | 兜底 | 生成失败/为空 → 回退现有这句"那些共度的静谧时光，最为震耳欲聋。" |

---

## 2. 关键澄清：首页取不到"场次级"三层，取的是跨场层

"记忆三折叠"= 三层记忆（热窗 → 中期折叠 → 长期总览）+ 跨场语义检索（bge-base-zh）。

但**三层记忆按"场"存**（`turn_memory_fold` 表挂 `scene_session_id`）——热窗/中期/总览都是"某一场约会内"的记忆。首页没有进行中的场景会话，所以这三层的原文在首页是空的。

首页真正能取到的是**跨场**两层（这两层正是"统一上下文"）：

1. **跨场时间线** `getUnifiedTimeline(playerId, characterId, limit)`（`memory.ts`）—— 最近短信 + 约会折叠摘要 + 朋友圈，按时间混排、带来源标签。
2. **语义检索** `retrieveMemories` / `retrieveRelevantMemories` —— 三层折叠的持久化产物（date_summary / overview / segment / player_facts / chronicle）都向量化进了 `memory_embeddings`，检索按 player×character 跨场累积，能捞回。

所以情诗的"记忆三折叠"落地 = 跨场时间线 + 语义检索，这两样正好覆盖"最近几条短信和约会/朋友圈 + 记忆"。**直接复用 `proactive.ts` 的 `generateProactiveSms` 那套成熟管线，不另造。**

---

## 3. 数据模型

新表（走 `scene-schema.ts` 或独立 migration，与现有建表方式一致）：

```sql
CREATE TABLE IF NOT EXISTS home_poems (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL,
  character_id TEXT NOT NULL,
  poem         TEXT NOT NULL,        -- 情诗正文（一句/一行，允许换行）
  date_key     TEXT NOT NULL,        -- 北京时区日期 YYYY-MM-DD（见 §4 时区）
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_home_poems
  ON home_poems(player_id, character_id, date_key);
```

- 当天复用判定 = `WHERE player_id=? AND character_id=? AND date_key=?`。
- 每 player×character 每天最多一条（幂等：生成前先查，查到即返回）。

---

## 4. 时区（关键，别踩 UTC 坑）

`created_at` 是 UTC（既有约定），但"每天"的边界必须按**北京时区**算，否则凌晨 0:00–8:00 会被算进前一天。

`date_key` 用北京时区生成：

```ts
const dateKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());  // → YYYY-MM-DD
```

判定"今天有没有"、写库时都用这个 `date_key`，不依赖 `created_at` 的 UTC 值。

---

## 5. 后端 API

新端点（鉴权同现有 `/api/*`，playerId 从 token 取）：

```
GET /api/home-poem?characterId=xxx
```

流程：

1. 校验 characterId 归属当前 player。
2. 算 `dateKey`（北京时区今天）。
3. 查 `home_poems`：命中 → 直接返回 `{ poem, generatedAt }`。
4. 未命中 → 组装上下文 → 调 gemma 生成 → 落库 → 返回。
5. 生成失败/返回空 → 不落库，返回 `{ poem: null }`（前端回退默认句）。

**上下文组装**（仿 `generateProactiveSms`）：

- 角色卡：`loadCharacterData(playerId, characterId)`
- 玩家描述：`relationships.player_description`
- 跨场时间线：`getUnifiedTimeline(playerId, characterId)`（含最近短信/约会/朋友圈）
- 记忆检索：`retrieveRelevantMemories(...)` / `retrieveMemories(...)`（query 用"想对对方说的话 / 此刻想写的情诗"这类意图 + 当前时间地点，参照"检索 query 加场景上下文防失忆"的做法）
- 关系时长：`relationships.created_at` → `formatRelationshipDuration`

生成参数：`temperature 0.9`（对齐主动短信创作类，见 `proactive.ts:316`），`maxTokens 256`（一句诗不长）。

---

## 6. 生成 prompt（正面引导，红线内置）

system 里给足角色卡 + 记忆，user 是写诗指令。**全部正面表述，不写否定式框定**：

- 定位：这是男主**内心的独白**，写给玩家的、只有一句的情诗。第一人称"我"（男主）对"你"（玩家）。
- 贴人：诗要像"他"写的——性格内向外向、说话口吻、他的底线与分寸，从角色卡里长出来，不能千人一面。
- 贴事：允许呼应交集里最近的事（时间线里有的），但点到为止，不写成流水账。
- 浓度：真实、克制的深情，**不堆砌辞藻、不油腻、不占有**。
- 形式：一句（可带一个逗号/分句），不要多句、不要标题、不要引号包裹。

玩家名/指代：用真实昵称（`players.name`），不用"玩家/男主"元标签；人称视角对齐（我=男主、你=玩家），防代词污染（同 `scene-prompt-assembly` 的教训）。

---

## 7. 前端改动（`apps/web-v4/src/components/HomeScreen.tsx`）

- 把 `quotes` 数组 + `useState(0)` 死代码删掉，换成：
  ```ts
  const [poem, setPoem] = useState<string | null>(null);
  useEffect(() => {
    if (!activeCharacter?.id) return;
    let cancelled = false;
    api.getHomePoem(activeCharacter.id)
      .then(res => { if (!cancelled) setPoem(res.poem); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeCharacter.id]);
  ```
- 渲染处：`poem ?? '那些共度的静谧时光，最为震耳欲聋。'`。
- **切角色即重新请求**（依赖 `activeCharacter.id` 变化）——天然满足"换人重新生成"。
- 首次进首页若后端在生成（异步），先显示默认句，返回后替换；不做前端 spinner。

---

## 8. 兜底链

生成失败 / LLM 空返回 / 接口异常 → 前端落到默认句"那些共度的静谧时光，最为震耳欲聋。"。不落库、不缓存失败态，下次进入仍会重试生成。

---

## 9. 实现清单

- [ ] 后端：`home_poems` 建表（migration）
- [ ] 后端：`GET /api/home-poem` 路由 + 生成逻辑（仿 `generateProactiveSms`，抽取复用或新写 `generateHomePoem`）
- [ ] 后端：情诗 prompt 模板（正面引导 + 人称对齐）
- [ ] 前端：`HomeScreen.tsx` 删死代码、接 API、切角色重拉、默认句兜底
- [ ] 验证：当天复用（第二次进不重写）、换角色换诗、UTC 凌晨边界、失败兜底
