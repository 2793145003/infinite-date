/**
 * 发送类重复提交抑制 —— 用「真实清理出来的重复数据」做离线验证
 *
 * 样本来源：2026-09-18 全库排查后删掉的 28 行重复写入，
 * 回滚快照 data/rollback-old-duplicates-*.sql 里保留了整行原样数据。
 * 这里把它们插进内存库回放：若判重逻辑当时已在，这些行都会被拦下；
 * 同时验证「不同文本 / 不同会话 / 超出窗口 / NPC 自己的回复」不会被误伤。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  findRecentDuplicateMessage,
  findRecentDuplicateMoment,
  loadRepliesAfter,
  SEND_DEDUP_WINDOW_MS,
  type MsgRef,
} from '../lib/send-dedupe';

const DDL = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT, role TEXT, text TEXT, metadata TEXT DEFAULT '{}',
  image_path TEXT, internal TEXT DEFAULT '', internal_notable INTEGER DEFAULT 0,
  internal_viewed INTEGER DEFAULT 0, speaker TEXT, created_at INTEGER
);
CREATE TABLE text_messages (
  id TEXT PRIMARY KEY, thread_id TEXT, sender TEXT, body TEXT, status TEXT DEFAULT 'delivered',
  attachment TEXT, image_asset_id TEXT, delivered_at INTEGER, created_at INTEGER,
  internal TEXT DEFAULT '', internal_notable INTEGER DEFAULT 0, internal_viewed INTEGER DEFAULT 0, metadata TEXT
);
CREATE TABLE moments (
  id TEXT PRIMARY KEY, player_id TEXT, author_type TEXT, author_id TEXT, content TEXT,
  mood TEXT, location_name TEXT, trigger_type TEXT, image_path TEXT, visibility TEXT,
  visible_to TEXT, created_at INTEGER
);
CREATE TABLE scene_messages (
  id TEXT PRIMARY KEY, scene_session_id TEXT, round_no INTEGER, role TEXT, character_id TEXT,
  character_name TEXT, text TEXT, stats_delta TEXT, quote TEXT, internal TEXT DEFAULT '',
  internal_notable INTEGER DEFAULT 0, created_at INTEGER
);`;

/** 解析回滚快照里的 INSERT 语句，还原出整行数据 */
function loadRollbackRows(): Array<{ table: string; cols: string[]; vals: string[] }> {
  const dir = path.resolve(process.cwd(), 'data');
  const file = fs.readdirSync(dir).filter((f) => f.startsWith('rollback-old-duplicates-')).sort().pop();
  assert.ok(file, '未找到 data/rollback-old-duplicates-*.sql 回滚快照');
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  const out: Array<{ table: string; cols: string[]; vals: string[] }> = [];
  for (const line of sql.split('\n')) {
    const m = line.match(/^INSERT OR IGNORE INTO (\w+) \((.*?)\) VALUES \((.*)\);$/);
    if (!m) continue;
    const cols = m[2]!.split(',');
    // 值里只有一个字节流字符串出现逗号的情况：这些表没有 blob，直接按顶层逗号切
    const vals: string[] = [];
    let cur = '';
    let inStr = false;
    for (let i = 0; i < m[3]!.length; i++) {
      const ch = m[3]![i];
      if (ch === "'") inStr = !inStr;
      if (ch === ',' && !inStr) { vals.push(cur); cur = ''; } else cur += ch;
    }
    vals.push(cur);
    out.push({ table: m[1]!, cols, vals: vals.map((v) => v.trim()) });
  }
  return out;
}

function unquote(v: string): string | number | null {
  if (v === 'NULL') return null;
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return Number(v);
}

function seededDb(): { db: DatabaseSync; rows: ReturnType<typeof loadRollbackRows> } {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  const rows = loadRollbackRows();
  for (const r of rows) {
    const placeholders = r.cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${r.table} (${r.cols.join(',')}) VALUES (${placeholders})`)
      .run(...(r.vals.map(unquote) as never[]));
  }
  return { db, rows };
}

/** 各表对应的判重参数 */
function refOf(table: string, row: Record<string, string | number | null>): MsgRef {
  if (table === 'messages') {
    return { table: 'messages', idColumn: 'session_id', idValue: String(row['session_id']), authorColumn: 'role', authorValue: String(row['role']), textColumn: 'text' };
  }
  return { table: 'text_messages', idColumn: 'thread_id', idValue: String(row['thread_id']), authorColumn: 'sender', authorValue: String(row['sender']), textColumn: 'body' };
}

describe('发送类重复提交抑制（真实数据回放）', () => {
  it('回滚快照里的 28 行真实重复：判重逻辑当时都能拦下', () => {
    const { db, rows } = seededDb();
    const msgRows = rows.filter((r) => r.table === 'messages' || r.table === 'text_messages');
    assert.ok(msgRows.length >= 18, `消息类样本应 >=18，实际 ${msgRows.length}`);
    let checked = 0;
    for (const r of msgRows) {
      const row: Record<string, string | number | null> = {};
      r.cols.forEach((c, i) => { row[c] = unquote(r.vals[i]!); });
      const ref = refOf(r.table, row);
      const text = String(row[ref.textColumn] ?? '');
      const ts = Number(row['created_at']);
      const dup = findRecentDuplicateMessage(db, ref, text, ts);
      assert.ok(dup, `应判为重复：${r.table} ${text.slice(0, 20)}`);
      assert.equal(dup!.id, row['id'], '判重应命中的就是这一行本身');
      checked++;
    }
    assert.equal(checked, msgRows.length);
    console.log(`    回放样本：${checked} 行（messages ${rows.filter(r=>r.table==='messages').length} / text_messages ${rows.filter(r=>r.table==='text_messages').length}）`);
  });

  it('窗口内不同文本 / 不同会话 / 超出窗口：都不判重', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    const t0 = 1_700_000_000_000;
    db.prepare('INSERT INTO messages (id, session_id, role, text, created_at) VALUES (?,?,?,?,?)')
      .run('m1', 's1', 'player', '原话', t0);

    const ref: MsgRef = { table: 'messages', idColumn: 'session_id', idValue: 's1', authorColumn: 'role', authorValue: 'player', textColumn: 'text' };
    assert.ok(findRecentDuplicateMessage(db, ref, '原话', t0 + 2_000), '2 秒后同文 → 判重');
    assert.equal(findRecentDuplicateMessage(db, ref, '另一句', t0 + 2_000), undefined, '不同文本放行');
    assert.equal(findRecentDuplicateMessage(db, ref, '原话', t0 + SEND_DEDUP_WINDOW_MS + 1), undefined, '超出窗口放行');
    assert.equal(
      findRecentDuplicateMessage(db, { ...ref, idValue: 's2' }, '原话', t0 + 2_000), undefined, '不同会话放行',
    );
    assert.equal(
      findRecentDuplicateMessage(db, { ...ref, authorValue: 'assistant' }, '原话', t0 + 2_000), undefined, '换作者放行',
    );
  });

  it('重复提交时能取回「第一次已生成的 NPC 回复」（客户端表现与正常发送一致）', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    const t0 = 1_700_000_000_000;
    const ins = db.prepare('INSERT INTO messages (id, session_id, role, text, internal, internal_notable, created_at) VALUES (?,?,?,?,?,?,?)');
    ins.run('p1', 's1', 'player', '想你了', '', 0, t0);
    ins.run('a1', 's1', 'assistant', '我也想你。', '心里一暖', 1, t0 + 300);
    ins.run('a2', 's1', 'assistant', '（伸手抱住你）', '', 0, t0 + 320);
    ins.run('p2', 's1', 'player', '下一句玩家消息', '', 0, t0 + 60_000);   // 之后的玩家消息，不应被算作回复
    ins.run('a3', 's1', 'assistant', '这句是回复 p2 的', '', 0, t0 + 60_300);

    const ref: MsgRef = { table: 'messages', idColumn: 'session_id', idValue: 's1', authorColumn: 'role', authorValue: 'player', textColumn: 'text' };
    const replies = loadRepliesAfter(db, ref, { id: 'p1', created_at: t0 });
    assert.deepEqual(replies.map((r) => r.text), ['我也想你。', '（伸手抱住你）']);
    assert.equal(replies[0]!.internal, '心里一暖');
    assert.equal(replies[0]!.internal_notable, true);
  });

  it('场景发言（scene_messages）：回滚快照里的真实重复行同样会被判重', () => {
    const { db, rows } = seededDb();
    const sceneRows = rows.filter((r) => r.table === 'scene_messages');
    assert.ok(sceneRows.length >= 7, `场景类样本应 >=7，实际 ${sceneRows.length}`);
    for (const r of sceneRows) {
      const row: Record<string, string | number | null> = {};
      r.cols.forEach((c, i) => { row[c] = unquote(r.vals[i]!); });
      const ref: MsgRef = {
        table: 'scene_messages', idColumn: 'scene_session_id', idValue: String(row['scene_session_id']),
        authorColumn: 'role', authorValue: String(row['role']), textColumn: 'text',
      };
      const text = String(row['text'] ?? '');
      if (!text.trim()) continue; // 空台词属另一类问题（JSON 片段），不在发送判重范围
      const dup = findRecentDuplicateMessage(db, ref, text, Number(row['created_at']));
      assert.ok(dup, `场景重复发言应判重：${text.slice(0, 20)}`);
      assert.equal(dup!.id, row['id']);
    }
  });

  it('朋友圈重复发帖：窗口内同玩家同内容判重，换文本/超窗口放行', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(DDL);
    const t0 = 1_700_000_000_000;
    db.prepare("INSERT INTO moments (id, player_id, author_type, content, created_at) VALUES (?,?,?,?,?)")
      .run('mo1', 'pl1', 'player', '今天天气不错', t0);
    assert.ok(findRecentDuplicateMoment(db, 'pl1', '今天天气不错', t0 + 3_000), '同文 3 秒后 → 判重');
    assert.equal(findRecentDuplicateMoment(db, 'pl1', '今天天气不错', t0 + 61_000), undefined, '超窗口放行');
    assert.equal(findRecentDuplicateMoment(db, 'pl1', '换了内容', t0 + 3_000), undefined, '不同内容放行');
    assert.equal(findRecentDuplicateMoment(db, 'pl2', '今天天气不错', t0 + 3_000), undefined, '不同玩家放行');
  });
});
