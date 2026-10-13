/**
 * 用「线上真实库」校验新增的发送判重逻辑（只读连接，不写任何数据）
 * 覆盖：会话消息 / 短信 / 朋友圈发帖 + 「重复时取回已生成回复」。
 * 用法：cd apps/server && npx tsx verify_send_dedupe_live.ts
 */
import { DatabaseSync } from 'node:sqlite';
import {
  findRecentDuplicateMessage,
  findRecentDuplicateMoment,
  loadRepliesAfter,
  type MsgRef,
} from './src/lib/send-dedupe';

const db = new DatabaseSync('/output/infinite-date-v2/apps/server/data/infinite-date.sqlite', { readOnly: true });
let fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

// 1) 会话消息：取一条真实的玩家消息，验证「2 秒后同文」会被判重、61 秒后放行
const m = db.prepare(`
  SELECT session_id, text, created_at FROM messages
  WHERE role = 'player' AND TRIM(text) <> '' ORDER BY created_at DESC LIMIT 1
`).get() as { session_id: string; text: string; created_at: number };
const mRef: MsgRef = { table: 'messages', idColumn: 'session_id', idValue: m.session_id, authorColumn: 'role', authorValue: 'player', textColumn: 'text' };
check('会话消息：窗口内同文判重（真实数据）', !!findRecentDuplicateMessage(db, mRef, m.text, m.created_at + 2_000), m.text.slice(0, 18));
check('会话消息：超出 60s 放行', !findRecentDuplicateMessage(db, mRef, m.text, m.created_at + 61_000));
check('会话消息：不同文本放行', !findRecentDuplicateMessage(db, mRef, m.text + '（改过）', m.created_at + 2_000));

// 2) 取回该玩家消息之后已生成的 NPC 回复
const replies = loadRepliesAfter(db, mRef, { id: 'x', created_at: m.created_at });
check('会话消息：能取回已生成的 NPC 回复', replies.length > 0, `${replies.length} 条`);

// 3) 短信：同线程、同发送者、同文本
const sm = db.prepare(`
  SELECT thread_id, sender, body, created_at FROM text_messages
  WHERE TRIM(body) <> '' ORDER BY created_at DESC LIMIT 1
`).get() as { thread_id: string; sender: string; body: string; created_at: number };
const sRef: MsgRef = { table: 'text_messages', idColumn: 'thread_id', idValue: sm.thread_id, authorColumn: 'sender', authorValue: sm.sender, textColumn: 'body' };
check('短信：窗口内同文判重（真实数据）', !!findRecentDuplicateMessage(db, sRef, sm.body, sm.created_at + 1_000), sm.body.slice(0, 18));
check('短信：超出 60s 放行', !findRecentDuplicateMessage(db, sRef, sm.body, sm.created_at + 61_000));

// 4) 朋友圈：真实玩家动态
const mo = db.prepare(`
  SELECT player_id, content, created_at FROM moments
  WHERE author_type = 'player' AND TRIM(content) <> '' ORDER BY created_at DESC LIMIT 1
`).get() as { player_id: string; content: string; created_at: number };
check('朋友圈：窗口内同文判重（真实数据）', !!findRecentDuplicateMoment(db, mo.player_id, mo.content, mo.created_at + 3_000), mo.content.slice(0, 18));
check('朋友圈：超出 60s 放行', !findRecentDuplicateMoment(db, mo.player_id, mo.content, mo.created_at + 61_000));
check('朋友圈：不同玩家放行', !findRecentDuplicateMoment(db, 'another-player-id', mo.content, mo.created_at + 3_000));

// 7) 场景发言：同场景、同作者、同文本
const sc = db.prepare(`
  SELECT scene_session_id, role, text, created_at FROM scene_messages
  WHERE role = 'player' AND TRIM(text) <> '' ORDER BY created_at DESC LIMIT 1
`).get() as { scene_session_id: string; role: string; text: string; created_at: number };
const scRef: MsgRef = {
  table: 'scene_messages', idColumn: 'scene_session_id', idValue: sc.scene_session_id,
  authorColumn: 'role', authorValue: sc.role, textColumn: 'text',
};
check('场景发言：窗口内同文判重（真实数据）', !!findRecentDuplicateMessage(db, scRef, sc.text, sc.created_at + 3_000), sc.text.slice(0, 18));
check('场景发言：超出 60s 放行', !findRecentDuplicateMessage(db, scRef, sc.text, sc.created_at + 61_000));
check('场景发言：不同文本放行', !findRecentDuplicateMessage(db, scRef, sc.text + '（改过）', sc.created_at + 3_000));

// 5) 回归：库里已无「同会话 + 同作者 + 同文 ≤5s」的重复（空文本属另一类问题，见 6）
const dupLeft = db.prepare(`
  SELECT COUNT(*) n FROM (
    SELECT session_id sk, role ak, text tx, MIN(created_at) a, MAX(created_at) b, COUNT(*) c
    FROM messages WHERE TRIM(text) <> ''
    GROUP BY session_id, role, text HAVING c >= 2 AND (b - a) <= 5000)
`).get() as { n: number };
check('回归：messages 无 ≤5s 重复残留', dupLeft.n === 0, `剩 ${dupLeft.n} 组`);

// 6) 独立问题（非重复写入）：LLM JSON 解析失败时，原始 JSON 片段被当成台词存库。
//    这里只报数，不判失败——修的是解析侧，不属于本次「重复提交」范围。
const garbage = db.prepare(`
  SELECT COUNT(*) n FROM messages
  WHERE role = 'assistant' AND (
    TRIM(text) = ''
    OR TRIM(text) IN ('internal_notable','player_description','item_obtained','scene_concluded','environment','quest_npc_line','internal')
    OR TRIM(text) LIKE '%],[%' OR TRIM(text) LIKE '%":%'
  )
`).get() as { n: number };
console.log(`ℹ 另发现 ${garbage.n} 条「JSON 解析失败被当成台词存库」的垃圾消息（不属于重复提交，建议单独立项修解析侧）`);

console.log(fail === 0 ? '\n全部通过（真实库只读校验）' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
