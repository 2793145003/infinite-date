/**
 * 用「线上真实库」校验判重 SQL（只读连接，不写任何数据）
 * 目的：证明 findRecentDuplicateComment 在真实 schema + 真实事故数据上按预期工作，
 *       而不只是在测试用的内存副本上工作。
 * 用法：cd apps/server && npx tsx verify_dedupe_live.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { findRecentDuplicateComment } from './src/lib/comment-dedupe';

const db = new DatabaseSync('/output/infinite-date-v2/apps/server/data/infinite-date.sqlite', { readOnly: true });
const PLAYER = 'a9554357-b7ef-40de-9a46-6e46f4a7e14a';
const MOMENT = 'aa2974ed-23e1-43a8-8bcb-9f51c3b9f490';
const TEXT = '喜欢这里';
const KEEP = '1bf06328-2f50-468c-a425-20a1dc774d20'; // 清理后保留的那条

const kept = db.prepare('SELECT created_at FROM moment_interactions WHERE id = ?').get(KEEP) as { created_at: number };

let fail = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}  got=${got} want=${want}`);
};

// 1) 事故时间点重放：窗口内的同文评论应被判重，且命中保留的那条
const dup = findRecentDuplicateComment(db, PLAYER, MOMENT, TEXT, kept.created_at + 1000);
check('窗口内同文评论判重（命中保留行）', dup?.id, KEEP);

// 2) 窗口外放行
check('超出 60s 窗口不判重', findRecentDuplicateComment(db, PLAYER, MOMENT, TEXT, kept.created_at + 61_000), undefined);

// 3) 不同文本放行
check('不同文本不判重', findRecentDuplicateComment(db, PLAYER, MOMENT, '这里真好看', kept.created_at + 1000), undefined);

// 4) 清理结果：库里只剩 1 条该评论 + 1 条 NPC 回复 + 1 条记忆
const nP = (db.prepare("SELECT COUNT(*) n FROM moment_interactions WHERE moment_id=? AND author_type='player' AND interaction_type='comment' AND body=?").get(MOMENT, TEXT) as { n: number }).n;
const nN = (db.prepare("SELECT COUNT(*) n FROM moment_interactions WHERE moment_id=? AND author_type='character' AND interaction_type='comment'").get(MOMENT) as { n: number }).n;
const nM = (db.prepare('SELECT COUNT(*) n FROM memory_embeddings WHERE source_id IN (SELECT id FROM moment_interactions WHERE moment_id=?)').get(MOMENT) as { n: number }).n;
check('玩家评论剩 1 条', nP, 1);
check('NPC 回复剩 1 条', nN, 1);
check('记忆剩 1 条', nM, 1);

console.log(fail === 0 ? '\n全部通过（真实库只读校验）' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
