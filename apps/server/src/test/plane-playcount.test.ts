/**
 * 位面委托次数（play_count）计数逻辑单测 —— :memory: 库，不碰生产库。
 *
 * 规则：玩家真正说过话（非空消息）才 +1；进房 / 开场白自动推进（空消息）不计；
 *       每个会话只计一次。
 *
 * 运行：node --import tsx --test src/test/plane-playcount.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bumpPlanePlayCountIfFirstTalk } from '../lib/plane-playcount';

let db: DatabaseSync;
let charId: string;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE plane_characters (id TEXT PRIMARY KEY, play_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE scene_sessions (id TEXT PRIMARY KEY, plane_character_id TEXT);
    CREATE TABLE scene_messages (scene_session_id TEXT, role TEXT);
  `);
  charId = 'char-1';
  db.prepare('INSERT INTO plane_characters (id, play_count) VALUES (?, 0)').run(charId);
});

const playCount = (): number =>
  (db.prepare('SELECT play_count FROM plane_characters WHERE id = ?').get(charId) as { play_count: number }).play_count;

const addPlayerMsg = (sessionId: string) =>
  db.prepare("INSERT INTO scene_messages (scene_session_id, role) VALUES (?, 'player')").run(sessionId);

describe('bumpPlanePlayCountIfFirstTalk', () => {
  it('空消息（开场白自动推进）不计', () => {
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, undefined);
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, '');
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, '   ');
    assert.equal(playCount(), 0);
  });

  it('进房不说话（无 player 消息）不计', () => {
    // 模拟：会话已建，但从未有 player 消息，玩家直接退出 → 不应计
    db.prepare('INSERT INTO scene_sessions (id, plane_character_id) VALUES (?, ?)').run('s1', charId);
    db.prepare("INSERT INTO scene_messages (scene_session_id, role) VALUES ('s1', 'character')").run();
    assert.equal(playCount(), 0, '进房未说话不应计次数');
  });

  it('第一条非空消息 +1', () => {
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, '你好');
    assert.equal(playCount(), 1);
  });

  it('同一会话第二条消息不重复计（每会话只计一次）', () => {
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, '你好');
    assert.equal(playCount(), 1);
    addPlayerMsg('s1'); // 模拟第一条已落库
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, '在吗');
    assert.equal(playCount(), 1, '第二条消息不应重复 +1');
  });

  it('多个会话各自第一条消息各 +1', () => {
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, '你好');
    addPlayerMsg('s1');
    bumpPlanePlayCountIfFirstTalk(db, 's2', charId, '在吗');
    assert.equal(playCount(), 2, '两个会话各说话应 +2');
  });

  it('同一会话空消息在前、非空在后：只 +1', () => {
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, ''); // 开场自动推进
    bumpPlanePlayCountIfFirstTalk(db, 's1', charId, '你好'); // 真正第一句
    assert.equal(playCount(), 1);
  });
});
