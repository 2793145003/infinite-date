/**
 * 朋友圈评论重复提交抑制 —— 离线样本验证
 *
 * 样本来源：2026-09-18 真实线上事故（玩家 a9554357「露露」在动态 aa2974ed 下，
 * 8 秒内被客户端重复提交 13 条完全相同的评论 "喜欢这里"，每条又各触发一次 NPC 回复）。
 * 这里用事故当时的真实 (id, created_at) 序列回放，验证服务端兜底能把它压成 1 条。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findRecentDuplicateComment, DUP_COMMENT_WINDOW_MS } from '../lib/comment-dedupe';

const DDL = `
CREATE TABLE moment_interactions (
  id            TEXT PRIMARY KEY,
  moment_id     TEXT NOT NULL,
  author_type   TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  interaction_type TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
)`;

const PLAYER = 'a9554357-b7ef-40de-9a46-6e46f4a7e14a';
const MOMENT = 'aa2974ed-23e1-43a8-8bcb-9f51c3b9f490';
const TEXT = '喜欢这里';

/** 事故真实数据：13 条重复评论的 (id, created_at)，按时间升序 */
const INCIDENT_ROWS: Array<[string, number]> = [
  ['1bf06328-2f50-468c-a425-20a1dc774d20', 1789745710643],
  ['5ea6210a-52d3-4006-b536-d7bc9d7af004', 1789745713362],
  ['b63de5ed-492f-4ce2-b308-1321533f64d9', 1789745714815],
  ['ba019dcd-c5b9-4393-8a77-d8b990af1801', 1789745715311],
  ['72f29725-f769-461a-b656-cea96e8d8836', 1789745715533],
  ['b29b7af4-a806-47c9-bf6d-9dcf36a08c48', 1789745715733],
  ['5ccacad6-1cb2-4820-bcda-34cbdc34279b', 1789745716873],
  ['0f106fb6-d85a-48ba-9aa4-86c16c7ba7b8', 1789745717076],
  ['6429ce2b-6939-4e76-b504-581790e55458', 1789745717249],
  ['f5ee548e-4d2e-48ca-ae84-2235d142ab36', 1789745717471],
  ['02745d24-5cc2-4cb1-9823-8c1cd85a6987', 1789745717713],
  ['93e843f1-d15a-4efb-8220-42a62ef45dac', 1789745717911],
  ['7745bf26-a83c-4ef3-8bce-03d86a60a15b', 1789745718512],
];

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  return db;
}

/** 复刻路由里的处理顺序：先查重，未命中才落库（返回是否真的写入） */
let seq = 0;
function submit(db: DatabaseSync, ts: number, body: string, playerId = PLAYER, momentId = MOMENT): boolean {
  const dup = findRecentDuplicateComment(db, playerId, momentId, body, ts);
  if (dup) return false;
  db.prepare(`
    INSERT INTO moment_interactions (id, moment_id, author_type, author_id, interaction_type, body, created_at)
    VALUES (?, ?, 'player', ?, 'comment', ?, ?)
  `).run(`row-${++seq}`, momentId, playerId, body, ts);
  return true;
}

describe('朋友圈评论重复提交抑制', () => {
  it('真实事故回放：13 条重复只落 1 条（原为 13 条 + 13 条 NPC 回复）', () => {
    const db = freshDb();
    let inserted = 0;
    let rejected = 0;
    for (const [, ts] of INCIDENT_ROWS) {
      if (submit(db, ts, TEXT)) inserted++; else rejected++;
    }
    const total = db.prepare('SELECT COUNT(*) n FROM moment_interactions').get() as { n: number };
    assert.equal(inserted, 1, '只应落库 1 条');
    assert.equal(rejected, 12, '其余 12 条应被判重拦下');
    assert.equal(total.n, 1, '库里最终只有 1 条');
  });

  it('拦下的那 12 条不会触发 NPC 回复（等价于 NPC 回复从 13 条降为 1 条）', () => {
    const db = freshDb();
    let replyTriggers = 0;
    for (const [, ts] of INCIDENT_ROWS) {
      if (submit(db, ts, TEXT)) replyTriggers++; // 路由里只有真落库才触发 NPC 回复
    }
    assert.equal(replyTriggers, 1);
  });

  it('窗口外再发同样的话：允许（不是永久屏蔽）', () => {
    const db = freshDb();
    const first = INCIDENT_ROWS[0]![1];
    assert.equal(submit(db, first, TEXT), true);
    assert.equal(submit(db, first + DUP_COMMENT_WINDOW_MS - 1, TEXT), false, '窗口内算重复');
    assert.equal(submit(db, first + DUP_COMMENT_WINDOW_MS + 1, TEXT), true, '超出窗口放行');
  });

  it('窗口内不同内容 / 不同动态 / 不同玩家：都不算重复', () => {
    const db = freshDb();
    const t0 = INCIDENT_ROWS[0]![1];
    assert.equal(submit(db, t0, TEXT), true);
    assert.equal(submit(db, t0 + 1000, '这里真好看'), true, '不同文本放行');
    assert.equal(submit(db, t0 + 1000, TEXT, PLAYER, 'other-moment-id'), true, '不同动态放行');
    assert.equal(submit(db, t0 + 1000, TEXT, 'other-player-id'), true, '不同玩家放行');
  });

  it('NPC 自己的回复不占用玩家判重额度', () => {
    const db = freshDb();
    const t0 = INCIDENT_ROWS[0]![1];
    db.prepare(`
      INSERT INTO moment_interactions (id, moment_id, author_type, author_id, interaction_type, body, created_at)
      VALUES ('npc-1', ?, 'character', 'char-1', 'comment', ?, ?)
    `).run(MOMENT, TEXT, t0);
    assert.equal(submit(db, t0 + 500, TEXT), true, '玩家同文评论仍可落库');
  });
});
