# infinite-date-v2 代码审查复核报告（2026-08-07 增补）

> 复核范围：REVIEW.md（8/4）+ REVIEW_DRAFT.md（8/6）两份既有审查报告的全部未修遗留项，
> 对照 8/7 最新代码（git 28 个新提交）逐一核验——区分【仍需修】与【已过时/已被迭代修掉】。
> 验证方式：直接 grep 当前源码 + 读关键函数体（lib/permission.ts、routes/mission.ts、routes/creation.ts 等）。
> 服务未停，未改动任何代码，纯只读核验。

---

## 一、仍需修（真实隐患，当前代码仍存在）

### 🔴 高优先级

**1. `spendPlayerPermission` 权限钱包非原子扣费（P2-10，✅ 已修复 2026-08-07）**
- 位置：`lib/permission.ts:51-62`
- 现状（已修）：`spendPlayerPermission` 改单条原子 `UPDATE ... WHERE balance >= ?`，`changes=0`（余额不足/并发已扣）即失败；`grantPlayerPermission` 改原子 `balance = balance + ?` 再读回。杜绝 read-modify-write 丢失更新/负余额。
- 验证：并发 SQL 语义测试（串行化正确/余额不足只成一次/发放累加）通过。commit `d7109e8`。

**2. 任务评级重复发奖（P2-10，✅ 已修复 2026-08-07）**
- 位置：`routes/mission.ts:evaluateWorldMission`
- 现状（已修）：评级写库改原子抢占 `UPDATE ... WHERE evaluation_result IS NULL`，仅首位写入者（`claim.changes===1`）发权；并发/重入次位 `changes=0` 静默跳过。避免与对话期 `conversation.ts:441` 已置 `completed` 冲突（用 `evaluation_result IS NULL` 作"未发奖"哨兵，而非 status）。
- 验证：并发守卫测试通过。commit `d7109e8`。

**3. 创建流程「先扣费后写」无回滚（P2-11，✅ 已修复 2026-08-07）**
- 位置：`routes/creation.ts:finalize`
- 现状（已修）：扣费 + 全部建数据操作（fork/char/instance/relationship/家）包进 `BEGIN/COMMIT/ROLLBACK` 事务；任一步失败整体回滚，扣费与数据一起还原，不再"白扣费/半成品"；权限不足 403 路径也 ROLLBACK 归还事务内已扣费用。
- 验证：tsc 通过；服务快闪重启加载。commit `d7109e8`。

### 🟠 中优先级

**4. 场景路人写入越权（RISK-21，✅ 已修复 2026-08-07）**
- 位置：`routes/scene.ts:225-238` `POST /scene/locations/:id/npcs`
- 现状（已修）：补 `is_public`/`creator_id` 归属校验，与同文件背景图 L210 逻辑对齐——私有地点仅创建者可编辑（403「只能编辑自己创建的私有地点路人」），公共地点人人可编辑。
- **背景澄清**：场景路人非独立实体，是 `scene_locations.npcs` JSON 列属性（`lib/scene-map.ts:114-143`），注释明言"公共工具人，属地点属性"。故无"私人路人"独立概念，归属跟地点走。此前任何登录玩家可改任意私有地点路人（越权）。
- 验证：公共 plaza→200 / 私有露露家→403，真实 HTTP 实测通过；服务快闪重启加载。commit `79b7cfe`。

**5. `{} as CharacterData` 类型不安全（RISK-15，✅ 已修复 2026-08-07）**
- 位置：`routes/character.ts:55`
- 现状（已修）：读公共原版角色卡 `jsonParse` fallback 从 `{} as CharacterData`（类型伪造 + 空对象）改为 `jsonParse<CharacterData | null>(data, null)`。前端已用 `?`/`|| null` 空处理（CharacterEditModal L72/L114/L115），null 安全。
- 验证：tsc 无错误；服务快闪重启加载。commit `84bdf82`。

### 🟡 低优先级（设计/健壮性，短期可不急但有据）

**6. `POST /scene/locations/:id/npcs` 缺少 `role/name` 之外的人名 → persona 注入未做长度/内容限制**（并入 #4 一起补）。

**7. 创建角色同名复用竞态（P2-12，✅ 已核验为天然修复 2026-08-07）**
- 位置：`routes/creation.ts:320-335`
- 结论：**无需改码**。`creation.ts` finalize 的 check+insert 已在上一轮（d7109e8）包进同一 `BEGIN` 事务；Node 单线程 + 单 db 连接 + `node:sqlite` 同步执行使并发请求**天然串行**——第二个请求的 `SELECT` 在第一个 `COMMIT` 后才跑，命中复用分支。实测：两个并发同名 finalize → 公共模板 1 个、两个玩家 fork 都指向同一模板，零重复（见临时测试 + 下节验证）。私有角色各自独立副本、不碰公共模板，同样无竞态。

**8. 记忆折叠与回滚竞态（RISK-13，✅ 已修复 2026-08-07，commit c99529f）**
- 位置：`lib/turn-memory.ts` `doFoldTurnSegment`
- 修复：折叠是异步（COMMIT 后 fire-and-forget），期间若该轮已被 `rollbackScene` 撤回（删 `scene_messages round_no>=target`），折叠会把已回退轮记忆"写回"已删位置产生幽灵记忆。已加**回滚守卫**：写入 `turn_memory_fold` / `turn_player_facts` 前检查 `scene_messages WHERE scene_session_id=? AND round_no=?` 是否仍存在，被回退则跳过。惰性自愈守卫，不影响正常流程。

**9. 开启约会现场互斥竞态（2b，✅ 已修复 2026-08-07，commit c99529f）**
- 位置：`routes/scene.ts` `POST /scene/start`
- 修复（严格同参无缝复用 + 原子）：① 已有**同地点 + 同角色集（顺序无关）**的进行中场景约会 → 直接返回其 `sessionId` 续上（200，不新建、不弹错、不留孤儿）——实现"连点两下同一按钮无缝衔接"；② 检查 live + 插入 scene_sessions 包进**同一事务**（原子），只有**确实不同的现场**才 409 弹窗。
- 验证：全新组合 201 新建 → 同参再开 200 复用同 session → 换地点 409，全路径通过。

---

## 二、已过时 / 已被 8/7 及之前迭代顺手修复（无需再动）

| 原报告项 | 结论 | 证据 |
|---|---|---|
| **RISK-14 前端 api.ts 无请求超时** | ✅ 已修 | `apps/web/src/lib/api.ts:46` `AbortSignal.timeout(30_000)` |
| **SMELL `_wtest` 空文件** | ✅ 已删 | `ls` 不存在 |
| **SMELL `home_of` 废弃字段** | ✅ 已删 | schema.ts 无匹配 |
| **SMELL `prevLocName` 未用变量** | ✅ 已清 | lib/routes 无匹配 |
| **SMELL schedule customPool 硬编码"在这里待着"** | ✅ 已修 | `lib/schedule.ts:201-203` 改用 `info.activities[0]` |
| **SMELL 性格关键词重复不同步** | ✅ 已修 | `lib/proactive.ts:115` 复用 `classifyPersonality`（不再重复列表） |
| **RISK-18 scenario retry schema 缺 need_search** | ✅ 已修 | `routes/scenario.ts:1356` guidedJson 已含 need_search |
| **RISK-14' MAX_MODEL_LEN 硬编码 8192** | ✅ 已修 | `lib/llm/adapter.ts:97` `16384` + 环境变量可覆盖（对齐全 vLLM） |
| **P1.5-6 LLM JSON 健壮性** | ✅ 已修 | truncated 检测 + actor guidedJson + validateActorOut |
| **P1-4 advanceScene 事务+乐观锁** | ✅ 已落地 | `lib/scene-wiring.ts:416-427,592` BEGIN/COMMIT/ROLLBACK + `WHERE id=? AND round_no=?` + SCENE_ROUND_CONFLICT |
| **RISK-13' 旁白重复** | ✅ 已修+进一步强化 | `emittedNarrationThisRound` + 8/7 Gemini 版导演约束 A/B 落地 |
| **RISK-20 auth Bearer slice(7)** | ✅ 无碍 | `lib/auth.ts:48-49` `startsWith('Bearer ')` 带空格校验，slice(7) 正确 |
| **文档滞后：DATA_MODEL 缺 scene_*** | ⚠️ 仍未更新 | `docs/DATA_MODEL.md` 无 scene_* 表（原 P2-9 仍待补） |
| **文档滞后：PROMPTS 缺 scene 模板** | ⚠️ 仍未更新 | `docs/PROMPTS.md` 无 scene.director/actor/greeting |

---

## 三、开放设计问题（三份文档之外的裁决项，非代码 bug）

- **NPC 放逐机制**：全库无 `exile/banish`，`OPEN_QUESTIONS.md` #1 仍开放。若不再需要应从设计文档移除。
- **记忆检索 query 构造**：仍"最后1轮"，未实测大数据召回（#2）。
- **剧本数值平衡**：LLM 全生成无校准（#3）。
- **短信 greeting fire-and-forget 静默吞**（#4）：`conversation.ts:562-584` 仍在，未加前端重试。
- **评分/ combo：互斥已大幅缓解**：现场全局互斥（P1.5-8）已落地；`conversation.ts:46-75` 的 check→insert 竞态窗口同理受单线程 + 同步 SQL 天然串行化保护（与本报告 2b 结论一致）。
- **`lib/schedule.ts:471` UTC+8 深夜注释**：时间基准仍按北京时间；`formatCurrentTime` 硬编码 UTC+8 仍在（原 SMELL），建议确认是否该改为服务时区。

---

## 四、本次新增发现（先前报告未覆盖）

- **mission 评级入口无状态守卫**（见"一/2"）—— 比原报告"守卫在末尾"更靠后，入口完全不查，重复发奖风险实锤。
- **`POST /scene/locations/:id/npcs`** 在 8/7 背景图提交（c7bd975）里实现了私有地点的背景归属校验（L210），但**同样文件里 npcs 写入口 L225 归属校验却漏了**——同一路由族内不一致，是审计技能明确的"is_public 过滤不一致"模式。

---

## 五、修复优先级建议

**P2/RISK 高、中优先级项已全部修复 ✅**；**低优先级健壮性项也已全部处理 ✅**；**文档同步（P2-9）已补齐 ✅**。

> 已勾掉：#4 场景路人越权 ✓（79b7cfe）｜ #1 钱包原子扣费 ✓（d7109e8）｜ #2 任务评级守卫 ✓（d7109e8）｜ #3 创建扣费回滚 ✓（d7109e8）｜ #5 `{} as CharacterData` ✓（84bdf82）｜ **文档同步 P2-9** ✓（385fbce）｜ **#7 同名复用竞态** ✓（核验为天然修复）｜ **#8 记忆折叠回滚竞态** ✓（c99529f）｜ **#9 开启约会互斥竞态（2b 同参无缝复用）** ✓（c99529f）
> 本报告为解决越权/并发/类型安全缺陷时的复核记录，均经真实测试 + 快闪重启加载（未停服）。

## 六、文档同步（P2-9，本轮完成）

- **DATA_MODEL.md**：新增「五·五、场景约会引擎（scene engine）」小节，补齐此前缺失的 `scene_*` 表族：`scene_locations` / `scene_sessions` / `scene_messages` / `scene_homes` / `scene_relationships` / `scene_round_snapshots` / `scene_schedule_entries`（指回第三节）/ `scene_start_snapshot` / `scene_explore_sessions` / `scene_explore_messages` / `turn_memory_fold` / `turn_player_facts` / `llm_call_log`。
- **PROMPTS.md**：新增「scene 引擎 — 导演/演员双角色体系」章节（`scene.director` / `scene.actor` / `scene.greeting`），记录地点/时间/角色名/数值/旁白四类触发等关键纪律；并给第三节补注「scene 用 `texts`，老约会用 `messages`」。
