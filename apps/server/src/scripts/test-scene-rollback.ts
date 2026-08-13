/**
 * 独立测试脚本：验证 scene-rollback 模块（只读真实库做样本，全程操作 DB 副本）
 *
 * 通过 IDATE_DATA_DIR 指向一个拷贝库，先在副本里造一场带记忆的约会，
 * 再验证：①按轮撤回 ②整场删除，各表状态是否精确回到目标点。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── 造一个独立的数据库副本（从真实库拷贝，绝不动 live 服务/表）───────────
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
fs.cpSync('/output/infinite-date-v2/apps/server/data/infinite-date.sqlite', path.join(work, 'infinite-date.sqlite'));
process.env.IDATE_DATA_DIR = work;

// 延迟 require —— 让 config/db 读到上面的 IDATE_DATA_DIR
const { db } = await import('../db/index.ts');
const {
  ensureRollbackTables, captureStartSnapshot, captureRoundSnapshot, rollbackScene,
} = await import('../lib/scene-rollback.ts');

let P = 'test-player-rollback';
const CHAR = 'char-rollback-1';
const SID = 'session-rollback-1';
const LOC = 'rollback-loc';
// 用真实玩家 id（满足 players FK）与自建地点（满足 scene_sessions.root_location_id FK）

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}
function q(sql: string, ...args: any[]): any {
  return db.prepare(sql).get(...args);
}
function counts() {
  return {
    msgs: q('SELECT COUNT(*) c FROM scene_messages WHERE scene_session_id=?', SID).c,
    segs: q(`SELECT COUNT(*) c FROM turn_memory_fold WHERE scene_session_id=? AND fold_type='segment'`, SID).c,
    ovs:  q(`SELECT COUNT(*) c FROM turn_memory_fold WHERE scene_session_id=? AND fold_type='overview'`, SID).c,
    facts: q('SELECT COUNT(*) c FROM turn_player_facts WHERE scene_session_id=?', SID).c,
    // 孤儿向量：turn_* 类型、但 source 已不存在的 embedding 数（应恒为 0）
    orphan: (db.prepare(`SELECT COUNT(*) c FROM memory_embeddings e
              WHERE e.player_id=? AND e.source_type LIKE 'turn_%'
                AND NOT EXISTS (SELECT 1 FROM turn_memory_fold f WHERE f.id=e.source_id)
                AND NOT EXISTS (SELECT 1 FROM turn_player_facts p WHERE p.id=e.source_id)`).get(P) as { c: number }).c,
    liveRows: ((db.prepare(`SELECT COUNT(*) c FROM turn_memory_fold WHERE scene_session_id=?`).get(SID) as { c: number }).c
             + (db.prepare(`SELECT COUNT(*) c FROM turn_player_facts WHERE scene_session_id=?`).get(SID) as { c: number }).c),
    stats: q('SELECT stats_state s, round_no r FROM scene_sessions WHERE id=?', SID),
  };
}

console.log('══ 准备：建一场 3 轮的约会 + 记忆 ══');
ensureRollbackTables();

// 建一个专属测试玩家（在副本库内，满足 players FK；不污染真实玩家）
const P0 = 'rollback-test-player';
db.prepare(`INSERT INTO players (id, name, pronouns, persona_notes, gender, appearance, tutorial_step, rating_score, is_admin, created_at, updated_at)
  VALUES (?, '测试玩家', 'she/her', '', 'female', '', 0, 0, 0, ?, ?)`).run(P0, Date.now(), Date.now());
P = P0;
db.prepare(`INSERT INTO scene_locations (id, world_id, name, summary, creator_type, is_public, created_at, updated_at)
  VALUES (?, 'default-world','测试地点','', 'player', 1, ?, ?)`).run(LOC, Date.now(), Date.now());
const t0 = Date.now();
db.prepare(`INSERT INTO scene_sessions (id, player_id, scene_type, root_location_id, character_ids, round_no, stats_state, ended, created_at, updated_at)
  VALUES (?,?, 'date',?, ?, 3, '{"cash":50,"heat":80}', 0, ?, ?)`)
  .run(SID, P, LOC, JSON.stringify([CHAR]), t0, t0);
// 关系（约会前已有 → 后续轮会覆盖）
db.prepare(`INSERT INTO scene_relationships (id, player_id, character_id, scene_session_id, player_description, updated_at)
  VALUES (?,?,?,?, ?,?)`)
  .run('rel-0', P, CHAR, SID, '约会前的旧描述：点头之交', t0);

// 拍摄场基线（= 整个约会开始前）——必须在后续描述被覆盖前拍
captureStartSnapshot(P, SID);

// 3 轮台词
const msgs = [
  [1, 'player', '第一句'], [1, 'npc', '你好'], [1, 'narration', '旁白1'],
  [2, 'player', '第二句'], [2, 'npc', '聊得不错'], [2, 'narration', '旁白2'],
  [3, 'player', '第三句'], [3, 'npc', '关系升温了'], [3, 'narration', '旁白3'],
];
const insMsg = db.prepare(`INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
for (const [r, role, text] of msgs as [number, string, string][]) {
  insMsg.run(`m-${r}-${role}`, SID, r, role, role === 'npc' ? CHAR : null, role === 'npc' ? '测试角色' : (role === 'player' ? '玩家' : '旁白'), text, '{}', null, t0 + r);
}
// 3 轮的单轮摘要 segment
const segIns = db.prepare(`INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, round_min, round_max, summary, created_at) VALUES (?,?,?,?, 'segment',?,?,?,?)`);
for (let r = 1; r <= 3; r++) segIns.run(`sf-${r}`, P, SID, CHAR, r, r, `第${r}轮摘要：一起聊天`, t0 + r);
// 长期总览（已被覆盖到最新 — 历史有一条「旧总览」）
db.prepare(`INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, summary, created_at) VALUES ('ov-2',?,?,?, 'overview', '最新总览：关系升温', ?)`).run(P, SID, CHAR, t0 + 50);
// player_facts（第2、3轮各一条）
const factIns = db.prepare(`INSERT INTO turn_player_facts (id, player_id, character_id, scene_session_id, round_no, fact, created_at) VALUES (?,?,?,?,?,?,?)`);
factIns.run('pf-2', P, CHAR, SID, 2, '玩家喜欢喝咖啡', t0 + 20);
factIns.run('pf-3', P, CHAR, SID, 3, '玩家养了一只猫', t0 + 30);
// 关系已被本轮覆盖到最新
db.prepare(`UPDATE scene_relationships SET player_description='最新描述：亲密', updated_at=? WHERE player_id=? AND character_id=?`).run(t0 + 40, P, CHAR);
// overview 的 embedding
db.prepare(`INSERT INTO memory_embeddings (id, player_id, source_type, source_id, character_id, content_text, embedding, created_at)
  VALUES ('emb-ov2',?, 'turn_overview','ov-2',?, '最新总览：关系升温', ?, ?)`).run(P, CHAR, Buffer.alloc(4 * 4), t0 + 50);
db.prepare(`INSERT INTO memory_embeddings (id, player_id, source_type, source_id, character_id, content_text, embedding, created_at)
  VALUES ('emb-pf2',?, 'turn_player_fact','pf-2',?, '玩家喜欢喝咖啡', ?, ?)`).run(P, CHAR, Buffer.alloc(4 * 4), t0 + 20);
db.prepare(`INSERT INTO memory_embeddings (id, player_id, source_type, source_id, character_id, content_text, embedding, created_at)
  VALUES ('emb-pf3',?, 'turn_player_fact','pf-3',?, '玩家养了一只猫', ?, ?)`).run(P, CHAR, Buffer.alloc(4 * 4), t0 + 30);
// 不是本场的 embedding（应保留）
db.prepare(`INSERT INTO memory_embeddings (id, player_id, source_type, source_id, character_id, content_text, embedding, created_at)
  VALUES ('emb-other',?, 'chronicle','other-1',?, '别的场记忆', ?, ?)`).run(P, CHAR, Buffer.alloc(4 * 4), t0);

// 拍摄轮快照（开第3轮前 = 回滚点「回到第2轮结束后」）—— 此时 stats=cash50/heat80, rel=最新描述, ov=最新总览
captureRoundSnapshot(P, SID, 3);

console.log('  初始状态：', JSON.stringify(counts()));

// ═══════════════ 测试 1：按轮撤回（回滚到第2轮结束后）═══════════════
console.log('\n══ 测试1：按轮撤回 → targetRound=3（删第3轮，恢复第3轮前）══');
// 第3轮前：stats=50/80（第3轮没改stats），rel=最新描述，ov=最新总览，facts只到pf-2，segment只到sf-2
rollbackScene(P, SID, 3);
const c1 = counts();
ok(c1.msgs === 6, `台词剩6条（round1+2），实际${c1.msgs}`);
ok(c1.segs === 2, `segment剩2条（round1+2），实际${c1.segs}`);
ok(c1.facts === 1, `player_facts剩1条（round2），实际${c1.facts}`);
ok(c1.ovs === 1, `overview保留1条，实际${c1.ovs}`);
ok(q('SELECT player_description d FROM scene_relationships WHERE player_id=? AND character_id=?', P, CHAR).d === '最新描述：亲密', '关系描述还是最新（第3轮前=最新）');
ok(q('SELECT stats_state s FROM scene_sessions WHERE id=?', SID).s === '{"cash":50,"heat":80}', 'stats保持（第3轮没改）');
ok(c1.orphan === 0, `无孤儿embedding：orphan=${c1.orphan}`); // 别场 chronicle 向量不在 turn_% 内，不影响

// ═══════════════ 测试 2：继续回滚到第1轮后（targetRound=2）═══════════
console.log('\n══ 测试2：再撤回一轮 → targetRound=2（删第2轮，恢复第2轮前）══');
rollbackScene(P, SID, 2);
const c2 = counts();
ok(c2.msgs === 3, `台词剩3条（round1），实际${c2.msgs}`);
ok(c2.segs === 1, `segment剩1条（round1），实际${c2.segs}`);
ok(c2.facts === 0, `player_facts清空，实际${c2.facts}`);
ok(c2.orphan === 0, `无孤儿embedding：orphan=${c2.orphan}`);

// ═══════════════ 测试 3：整场删除（回到约会前）═══════════
console.log('\n══ 测试3：整场删除 → targetRound=0（回到约会前基线）══');
rollbackScene(P, SID, 0);
const c3 = counts();
ok(c3.msgs === 0, `台词清空，实际${c3.msgs}`);
ok(c3.segs === 0, `segment清空，实际${c3.segs}`);
ok(c3.facts === 0, `player_facts清空，实际${c3.facts}`);
ok(c3.ovs === 0, `overview清空（本场记忆抹掉），实际${c3.ovs}`);
ok(q('SELECT player_description d FROM scene_relationships WHERE player_id=? AND character_id=?', P, CHAR).d === '约会前的旧描述：点头之交', '关系描述恢复到约会前基线');
ok(c3.orphan === 0, `无孤儿embedding：orphan=${c3.orphan}`);
ok(q("SELECT COUNT(*) c FROM memory_embeddings WHERE source_id='other-1'").c === 1, '别场记忆保留');

// ═══════════════ 测试 4：滚动快照上限 10 ════════════
console.log('\n══ 测试4：轮滚动快照上限（满10淘汰最旧）══');
// 先清掉现有轮快照，造 12 份
db.prepare('DELETE FROM scene_round_snapshots WHERE scene_session_id=?').run(SID);
for (let r = 1; r <= 12; r++) {
  db.prepare(`INSERT INTO scene_round_snapshots (id, scene_session_id, round_no, stats_state, relationships, overviews, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(`rr-${r}`, SID, r, '{}', '[]', '[]', t0 + r);
}
const snapCnt = q('SELECT COUNT(*) c FROM scene_round_snapshots WHERE scene_session_id=?', SID).c;
ok(snapCnt === 12, `先有12份`, );
// 再拍一份应淘汰最旧3份（round 1,2,3），保留 round 4..13（共10份）
captureRoundSnapshot(P, SID, 13);
const after = (db.prepare('SELECT round_no FROM scene_round_snapshots WHERE scene_session_id=? ORDER BY round_no').all(SID) as any[]).map(r => r.round_no);
ok(after.length === 10, `剩10份，实际${after.length}`);
ok(!after.includes(1) && !after.includes(2) && !after.includes(3), `round1/2/3被淘汰`);
ok(after[0] === 4 && after[9] === 13, `保留4..13，实际[${after.join(',')}]`);

// ═══════════════ 测试 5：advanceScene 接入期的幂等语义 ════════════
console.log('\\n══ 测试5：基线快照 insert-once + 轮快照 retry 重拍 ══');
db.prepare('DELETE FROM scene_round_snapshots WHERE scene_session_id=?').run(SID);
db.prepare('DELETE FROM scene_start_snapshot WHERE scene_session_id=?').run(SID);
// 造一个"约会前关系描述"
db.prepare(`UPDATE scene_relationships SET player_description='真正约会前：点头之交' WHERE player_id=? AND character_id=?`).run(P, CHAR);
// 第一次拍基线
captureStartSnapshot(P, SID);
const start1 = q('SELECT relationships r FROM scene_start_snapshot WHERE scene_session_id=?', SID).r;
// 模拟后续轮里关系描述被覆盖，再拍一次基线 → 必须不覆盖（insert-once）
db.prepare(`UPDATE scene_relationships SET player_description='约会中：已亲密' WHERE player_id=? AND character_id=?`).run(P, CHAR);
captureStartSnapshot(P, SID);
const start2 = q('SELECT relationships r FROM scene_start_snapshot WHERE scene_session_id=?', SID).r;
ok(start1 === start2, `基线快照不被后续覆盖（insert-once），一致：${start1===start2}`);
ok(start1.includes('点头之交') && !start1.includes('已亲密') && !start1.includes('已亲密'), `基线存的是约会前描述`);
// 同轮重复拍（模拟 retry 重开同一轮）不产生重复行
const beforeCnt = q('SELECT COUNT(*) c FROM scene_round_snapshots WHERE scene_session_id=?', SID).c;
captureRoundSnapshot(P, SID, 5);
captureRoundSnapshot(P, SID, 5);
const afterCnt = q('SELECT COUNT(*) c FROM scene_round_snapshots WHERE scene_session_id=?', SID).c;
ok(afterCnt === beforeCnt + 1, `同轮重拍不产生重复行：${beforeCnt} → ${afterCnt}`);

// ═══════════════ 测试 6：B1 overview 清理 + B2 陈旧快照清理（2026-08-07 两个实锤 bug）═══
console.log('\n══ 测试6：B1 overview 按轮撤回清理 + B2 陈旧轮快照清理 ══');
// 重置会话到多轮状态：play 到 round 8，撤回到 round 4（剩 3 轮台词 + 轮 4 玩家发言）
db.prepare('DELETE FROM scene_messages WHERE scene_session_id=?').run(SID);
db.prepare('DELETE FROM turn_memory_fold WHERE scene_session_id=?').run(SID);
db.prepare('DELETE FROM turn_player_facts WHERE scene_session_id=?').run(SID);
db.prepare('DELETE FROM scene_round_snapshots WHERE scene_session_id=?').run(SID);
const t6 = Date.now();
const m6 = db.prepare(`INSERT INTO scene_messages (id, scene_session_id, round_no, role, character_id, character_name, text, stats_delta, quote, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
for (const [r, role, text] of [
  [1,'player','A'],[1,'npc','B'],[2,'player','C'],[2,'npc','D'],[3,'player','E'],[3,'npc','F'],
  [4,'player','G'],[4,'npc','H'],[5,'player','I'],[5,'npc','J'],[6,'player','K'],[6,'npc','L'],
  [7,'player','M'],[7,'npc','N'],[8,'player','O'],[8,'npc','P'],
] as [number,string,string][]) {
  m6.run(`m6-${r}-${role}`, SID, r, role, role==='npc'?CHAR:null, role==='npc'?'测试角色':(role==='player'?'玩家':'旁白'), text, '{}', null, t6+r);
}
// 每一轮前都拍快照（round 1..8 各一份）
// 但要让「早期总览 ov5-old」进入 round 6 及之后的快照 —— 在拍 round 6 前就存在
db.prepare(`INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, summary, created_at)
  VALUES ('ov5-old',?,?,?, 'overview', '早期总览：普通聊天', ?)`).run(P, SID, CHAR, t6+40);
for (let r = 1; r <= 8; r++) captureRoundSnapshot(P, SID, r);
// 在 round 6 生成了新 overview（这意味着它比 round6 快照晚，round6 快照里只有 ov5-old；
// 模拟被按轮撤回应清掉的「晚生成总览」）
db.prepare(`INSERT INTO turn_memory_fold (id, player_id, scene_session_id, character_id, fold_type, round_min, round_max, summary, created_at)
  VALUES ('ov6-late',?,?,?, 'overview', NULL, NULL, '晚生成的总览：亲密梦境', ?)`).run(P, SID, CHAR, t6+90);
// 现在撤回 round 6 之后的（targetRound=6 → 删 round>=6，恢复 round6 前的快照=只含 ov5-old）
rollbackScene(P, SID, 6);
const c6 = counts();
const ovSummaries = (db.prepare(`SELECT summary FROM turn_memory_fold WHERE scene_session_id=? AND fold_type='overview'`).all(SID) as any[]).map(r=>r.summary);
ok(c6.msgs === 10, `台词剩10条（round1..5，删6..8），实际${c6.msgs}`);
ok(ovSummaries.length === 1 && ovSummaries[0] === '早期总览：普通聊天', `overview 只留快照里的早期总览（晚生成的 ov6-late 被清），实际=${JSON.stringify(ovSummaries)}`);
ok(c6.orphan === 0, `无孤儿embedding：orphan=${c6.orphan}`);
// B2：陈旧快照（round>当前最大=5）应被清掉
const staleSnaps = (db.prepare(`SELECT round_no FROM scene_round_snapshots WHERE scene_session_id=? AND round_no>5`).all(SID) as any[]).map(r=>r.round_no);
ok(staleSnaps.length === 0, `陈旧轮快照（round>5）被清空，实际=[${staleSnaps.join(',')}]`);

// 清理工作库
fs.rmSync(work, { recursive: true, force: true });

console.log(`\n════ 结果：${pass} 通过 / ${fail} 失败 ════`);
process.exit(fail ? 1 : 0);

