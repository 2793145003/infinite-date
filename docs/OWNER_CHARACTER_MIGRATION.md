# 行程池「角色领地」归属修复（owner_character_id）

## 背景

NPC 每日行程由后端 `walkSceneTimeline`（`apps/server/src/lib/schedule.ts`）确定性生成，地点池来自 `scene_locations` 表。

原排除逻辑只排除了 `scene_homes` 表里记着的 14 个「家」，漏了两类角色领地：

1. **家的子地点**（卧室、书房、浴室、镜子前、床上、客厅、上层卧室……）—— parent 链指向某个「家」，但它们自己不在 scene_homes 里，漏网。
2. **角色的专属场所**（林溯办公室、云枢资本集团总部、穆昭个人工作室、许墨生命科学研究所、厉氏集团、顾氏集团总部……）—— 不在 scene_homes，`home_of` 也为空，漏网。

结果：所有 NPC 都会随机「闲逛」进别人的家/办公室/卧室。用户反馈「沈星回跑林溯家去了」即其表现（沈星回在「林溯办公室」78 次、「林溯家」21 次）。

## 方案

给 `scene_locations` 加「归属角色」字段 `owner_character_id`，行程池只纳入「公共地点 + 自己的领地」，排除「归属别人的地点」。

### 1. 字段

`scene_locations.owner_character_id TEXT`（NULL = 公共地点，非空 = 归属某角色）。

### 2. 数据迁移（一次性，migration `scene_locations_owner_backfill`）

分三类标记 owner_character_id：

**A. 家本身**（scene_homes 记录的 14 个家）→ owner = 家的角色。

**B. 家的子树**（递归）—— 从每个家出发递归标记所有子地点 → owner = 家的角色。共 29 个子地点（卧室/书房/浴室/镜子前/床上/客厅等）。

**C. 角色专属场所**（名字含角色名，或手动清单）→ owner = 对应角色：

| 地点 | owner |
|---|---|
| 林溯办公室 | 林溯 |
| 云枢资本集团总部 | 林溯（名字不含，手动） |
| 穆昭个人工作室 | 穆昭 |
| 许墨生命科学研究所 / 许墨独立办公室 / 许墨教授专属办公室 / 许墨教授讲课专属教室 | 许墨 |
| 厉承渊的顶楼办公室 | 厉承渊 |
| 厉氏集团 / 厉氏集团地下车库 | 厉承渊（名字只含「厉」，手动） |
| 顾氏集团总部 | 顾珩（名字只含「顾」，手动） |
| 异能局专属外勤驻馆（烬戍馆） | 苏烬（名字只含「烬」，手动） |

名字匹配规则：地点名 `includes(角色全名)`，角色全名（冷惊尘/厉承渊/彭少殊/方知衡/林溯/沈星回/白景安/秦彻/穆昭/苏烬/许墨/谢放/顾珩/顾砚）均为 2-3 字独特词，不会误伤公共地点。

### 3. 行程池查询改动（schedule.ts `customRows`）

排除条件由：

```sql
AND (NOT EXISTS (SELECT 1 FROM scene_homes h WHERE h.location_id = l.id) OR is_my_home = 1)
```

改为：

```sql
AND (l.owner_character_id IS NULL OR l.owner_character_id = ?)
```

`is_my_home` 保持原 scene_homes 判断（只用于「待在家里」活动词），不动。

### 4. 重新生成行程

改完代码后，旧行程记录（含「林溯办公室」等）不会自动消失（`ensureSceneDay` 见到无重叠的干净数据即 return）。需删除 `is_llm_edited = 0` 的行程记录触发重新生成。

## 验证

1. `npx tsc --noEmit` 通过。
2. 重新生成行程后，沈星回的行程里不再出现「林溯办公室 / 林溯家 / 许墨家卧室」等别人的领地，只保留公共地点 + 沈星回家。
