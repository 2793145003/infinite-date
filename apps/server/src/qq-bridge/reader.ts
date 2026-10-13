/**
 * 只读数据访问 —— 桥从无限库里读短信时**只读**打开。
 *
 * 离线回放（replay.ts）和生产运行都走这里，只读模式保证：
 * 无论回放脚本怎么跑，都不可能改到线上任何一张表。
 */
import { DatabaseSync } from 'node:sqlite';
import type { SmsRowForBridge } from './payload';

/** 以只读方式打开无限主库（用于回放 / 桥读取短信） */
export function openReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 以读写方式打开（桥进程写自己的 qq_* 表用） */
export function openReadWrite(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export interface ReadSmsOptions {
  playerId?: string;
  characterId?: string;
  sinceTs?: number;
  limit?: number;
  /** 只取还没进过 outbox 的（桥的生产模式）；回放模式不传，取最近 N 条 */
  onlyUnsent?: boolean;
}

/**
 * 读短信（text_messages）。注意 SELECT 里**故意带上 internal** ——
 * 不是为了外发，而是让上部（replay）能断言它确实存在却没被送进 payload。
 */
export function readSmsRows(db: DatabaseSync, opts: ReadSmsOptions = {}): SmsRowForBridge[] {
  const where: string[] = ["tm.sender = 'npc'"];
  const params: Array<string | number> = [];

  if (opts.playerId) {
    where.push('mt.player_id = ?');
    params.push(opts.playerId);
  }
  if (opts.characterId) {
    where.push('mt.character_id = ?');
    params.push(opts.characterId);
  }
  if (opts.sinceTs) {
    where.push('tm.created_at >= ?');
    params.push(opts.sinceTs);
  }
  if (opts.onlyUnsent) {
    // 「还没成功外发过」= outbox 里没有 sent/skipped 的记录，且重试次数没用完。
    // queued/failed 的行会被重新扫到并重试（claim 里判断次数），
    // 这样限流、网络抖动都不会让一条短信静默消失。
    where.push(
      `NOT EXISTS (
         SELECT 1 FROM qq_outbox o
          WHERE o.msg_id IN (tm.id, tm.id || ':img')
            AND (o.status IN ('sent', 'skipped') OR o.attempts >= 3))`,
    );
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
  // 桥的生产模式要**从旧到新**发，否则对话顺序在 QQ 里会颠倒；
  // 回放模式按时间倒序取最近 N 条更好看。
  const order = opts.onlyUnsent ? 'ASC' : 'DESC';
  const sql = `
    SELECT tm.id            AS msgId,
           tm.thread_id     AS threadId,
           mt.player_id     AS playerId,
           mt.character_id  AS characterId,
           tm.sender        AS sender,
           tm.body          AS body,
           tm.image_asset_id AS imageAssetId,
           tm.metadata      AS metadata,
           tm.internal      AS internal,
           tm.created_at    AS createdAt
      FROM text_messages tm
      JOIN message_threads mt ON mt.id = tm.thread_id
     WHERE ${where.join(' AND ')}
     ORDER BY tm.created_at ${order}
     LIMIT ${limit}
  `;

  const rows = db.prepare(sql).all(...params) as Array<{
    msgId: string;
    threadId: string;
    playerId: string;
    characterId: string;
    sender: string;
    body: string;
    imageAssetId: string | null;
    metadata: string;
    internal: string;
    createdAt: number;
  }>;

  return rows.map(r => ({
    msgId: r.msgId,
    threadId: r.threadId,
    playerId: r.playerId,
    characterId: r.characterId,
    sender: r.sender,
    body: r.body ?? '',
    imageAssetId: r.imageAssetId ?? null,
    metadata: r.metadata ?? '{}',
    internal: r.internal ?? '',
    createdAt: r.createdAt,
  }));
}

/** 找一个 (玩家, 角色) 的 thread id；没有就返回 null */
export function findThreadId(db: DatabaseSync, playerId: string, characterId: string): string | null {
  const row = db
    .prepare('SELECT id FROM message_threads WHERE player_id = ? AND character_id = ?')
    .get(playerId, characterId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** 取角色名（只读，用于外发时的日志/卡片前缀） */
export function readCharacterName(db: DatabaseSync, characterId: string): string {
  try {
    const pub = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as
      | { character_data: string }
      | undefined;
    if (pub?.character_data) {
      const data = JSON.parse(pub.character_data) as { name?: string };
      if (data?.name) return data.name;
    }
    const priv = db
      .prepare('SELECT character_data FROM character_player_data WHERE id = ?')
      .get(characterId) as { character_data: string } | undefined;
    if (priv?.character_data) {
      const data = JSON.parse(priv.character_data) as { name?: string };
      if (data?.name) return data.name;
    }
  } catch {
    /* 名字取不到不影响外发 */
  }
  return characterId;
}
