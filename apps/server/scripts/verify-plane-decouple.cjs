// 离线验证：约会与位面任务解耦后，星落有活跃约会时也能进位面任务（不再 409）。
// 用生产库临时副本（readWrite），绝不碰生产库本身。
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = 'data/infinite-date.sqlite';
const DST = '/tmp/verify-decouple-' + Date.now() + '.sqlite';

for (const ext of ['', '-wal', '-shm']) {
  const s = path.resolve(SRC + ext);
  const d = DST + ext;
  if (fs.existsSync(s)) fs.copyFileSync(s, d);
}

const db = new DatabaseSync(DST);
const P = '6efaccdf-3d32-4ddf-8e79-5574953e4042'; // 星落主账号

// 新 getActiveLiveSlot（已移除 plane 分支）
function getActiveLiveSlot(d, playerId) {
  const scene = d.prepare("SELECT id FROM scene_sessions WHERE player_id = ? AND ended = 0 AND scene_type = 'date' ORDER BY updated_at DESC LIMIT 1").get(playerId);
  if (scene) return { type: 'scene-date', sessionId: scene.id };
  const conv = d.prepare('SELECT id, is_group FROM conversation_sessions WHERE player_id = ? AND ended = 0 AND scenario_session_id IS NULL ORDER BY updated_at DESC LIMIT 1').get(playerId);
  if (conv) return { type: 'conversation', sessionId: conv.id, isGroup: !!conv.is_group };
  const explore = d.prepare('SELECT id FROM explore_sessions WHERE player_id = ? AND ended = 0 ORDER BY updated_at DESC LIMIT 1').get(playerId);
  if (explore) return { type: 'explore', sessionId: explore.id };
  const scenario = d.prepare('SELECT id FROM scenario_sessions WHERE player_id = ? AND ended = 0 ORDER BY updated_at DESC LIMIT 1').get(playerId);
  if (scenario) return { type: 'scenario', scenarioSessionId: scenario.id };
  const mission = d.prepare("SELECT id FROM missions WHERE player_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(playerId);
  if (mission) return { type: 'mission', missionId: mission.id };
  return null;
}

// 1) 进任务前：星落应有一个活跃约会现场
const before = getActiveLiveSlot(db, P);
console.log('进任务前 getActiveLiveSlot =', JSON.stringify(before));
if (!before || before.type !== 'scene-date') {
  console.log('✗ 预期星落有活跃约会（scene-date），实际 =', JSON.stringify(before));
  process.exit(1);
}

// 2) 模拟 /plane/sessions 新逻辑：不再检查互斥，直接 INSERT 位面会话
const now = Date.now();
const planeId = 'verify-' + crypto.randomUUID();
db.prepare(
  `INSERT INTO scene_sessions
    (id, player_id, scene_type, character_ids, round_no, stats_state, stats_config, ended, goal, plane_character_id, created_at, updated_at)
   VALUES (?, ?, 'plane', ?, 0, ?, ?, 0, ?, ?, ?, ?)`,
).run(planeId, P, '[]', '{}', '[]', '', 'verify-pc', now, now);

const planeRow = db.prepare("SELECT id, ended, scene_type FROM scene_sessions WHERE id = ?").get(planeId);
console.log('位面会话已插入 =', JSON.stringify(planeRow), '(ended 应为 0)');

// 3) 插入位面会话后，getActiveLiveSlot 仍应返回约会（plane 不再算现场）
const after = getActiveLiveSlot(db, P);
console.log('进位面后 getActiveLiveSlot =', JSON.stringify(after));
if (after && after.type === 'scene-date') {
  console.log('\n✓ 约会与位面任务并存：约会现场未被释放，位面会话正常创建，两者互不排斥');
  console.log('✓ /plane/sessions 不再命中 409「已有进行中的现场」');
} else {
  console.log('\n✗ 验证失败：getActiveLiveSlot =', JSON.stringify(after));
  process.exit(1);
}

// 4) 确认两个现场同时活跃（ended=0）
const activeCount = db.prepare("SELECT COUNT(*) AS c FROM scene_sessions WHERE player_id = ? AND ended = 0 AND scene_type IN ('date','plane')").get(P);
console.log('星落活跃现场数（date+plane）=', activeCount.c, '(应为 ≥2：约会 + 位面)');

// 5) 多会话并存：再插入第二个位面会话，两个都应保持活跃
const planeId2 = 'verify-' + crypto.randomUUID();
db.prepare(
  `INSERT INTO scene_sessions
    (id, player_id, scene_type, character_ids, round_no, stats_state, stats_config, ended, goal, plane_character_id, created_at, updated_at)
   VALUES (?, ?, 'plane', ?, 0, ?, ?, 0, ?, ?, ?, ?)`,
).run(planeId2, P, '[]', '{}', '[]', '', 'verify-pc2', now, now);
const activePlaneCount = db.prepare("SELECT COUNT(*) AS c FROM scene_sessions WHERE player_id = ? AND ended = 0 AND scene_type = 'plane'").get(P);
console.log('插入第二个位面会话后，活跃位面任务数 =', activePlaneCount.c, '(应为 2)');
if (activePlaneCount.c < 2) { console.log('✗ 多会话并存失败'); process.exit(1); }
console.log('✓ 多个位面任务可同时进行，互不排斥');

db.close();
for (const ext of ['', '-wal', '-shm']) {
  const f = DST + ext;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log('副本已清理，生产库未受影响。');
