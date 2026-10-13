/**
 * 心绪（emotion）单测
 *
 * 覆盖：模型输出归一化（缺键/脏值/越界）、天然衰减、最强维度、
 * 注入文本与门槛、落库（挂 metadata 且不动原有键）与最近若干轮读取。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { genId, now } from '../lib/util';
import { db } from '../db';
import {
  normalizeEmotions,
  decayEmotions,
  topEmotion,
  emotionInjectionNote,
  attachEmotionToMessage,
  readThreadEmotions,
  readLastEmotion,
  buildEmotionInjection,
  EMOTION_KEYS,
  EMOTION_SCHEMA,
  EMOTION_INJECT_MIN,
  saveEmotionState,
  readEmotionState,
  readCurrentEmotion,
} from '../lib/emotion';
import type { EmotionScores } from '@idate/shared';

const full: EmotionScores = {
  joy: 10, desire: 20, panic: 30, loss: 40,
  grievance: 50, anger: 60, possessiveness: 70, tenderness: 80,
} as EmotionScores;

describe('心绪 normalizeEmotions', () => {
  it('八键齐全的合法输入原样通过（四舍五入取整）', () => {
    const out = normalizeEmotions({ ...full, joy: 10.6 });
    assert.ok(out);
    assert.equal(out!.joy, 11);
    assert.equal(out!.tenderness, 80);
    assert.equal(Object.keys(out!).length, 8);
  });

  it('缺任一维度即视为无效（不保留半截数据）', () => {
    const partial = { ...full } as Record<string, unknown>;
    delete partial.anger;
    assert.equal(normalizeEmotions(partial), null);
  });

  it('非数字值视为无效', () => {
    assert.equal(normalizeEmotions({ ...full, anger: '90' }), null);
    assert.equal(normalizeEmotions({ ...full, anger: null }), null);
    assert.equal(normalizeEmotions({ ...full, anger: NaN }), null);
  });

  it('越界值夹取到 0-100（不因模型口胡而丢失整轮心绪）', () => {
    const out = normalizeEmotions({ ...full, anger: 140, panic: -20 });
    assert.ok(out);
    assert.equal(out!.anger, 100);
    assert.equal(out!.panic, 0);
  });

  it('结构不是对象时返回 null', () => {
    assert.equal(normalizeEmotions(null), null);
    assert.equal(normalizeEmotions('x'), null);
    assert.equal(normalizeEmotions([]), null);
    assert.equal(normalizeEmotions(undefined), null);
  });
});

describe('心绪 schema', () => {
  it('固定 8 键、全员 required、不允许额外键', () => {
    assert.deepEqual(Object.keys(EMOTION_SCHEMA.properties).sort(), [...EMOTION_KEYS].sort());
    assert.deepEqual([...EMOTION_SCHEMA.required].sort(), [...EMOTION_KEYS].sort());
    assert.equal(EMOTION_SCHEMA.additionalProperties, false);
  });
});

describe('心绪衰减与最强维度', () => {
  it('按系数衰减（默认 25%）', () => {
    const d = decayEmotions(full);
    assert.equal(d.tenderness, 60); // 80 * 0.75
    assert.equal(d.joy, 8); // 10 * 0.75 = 7.5 → 8
    assert.equal(d.anger, 45); // 60 * 0.75
  });

  it('衰减可自定义系数', () => {
    assert.equal(decayEmotions(full, 0).tenderness, 0);
    assert.equal(decayEmotions(full, 1).tenderness, 80);
  });

  it('最强维度取最大值那一维', () => {
    const t = topEmotion(full);
    assert.equal(t.key, 'tenderness');
    assert.equal(t.cn, '怜爱');
    assert.equal(t.value, 80);
  });

  it('全 0 时返回第一维而不是崩掉', () => {
    const zero = Object.fromEntries(EMOTION_KEYS.map((k) => [k, 0])) as unknown as EmotionScores;
    const t = topEmotion(zero);
    assert.equal(t.value, 0);
    assert.equal(t.key, EMOTION_KEYS[0]);
  });
});

describe('心绪注入文本', () => {
  it('列出全部维度并点明最强那一维（含数值）', () => {
    const note = emotionInjectionNote(decayEmotions(full));
    assert.match(note, /怜爱60/);
    assert.match(note, /「怜爱」（60）/);
    assert.match(note, /延续自上一刻/);
  });

  it('要求语气跟着心绪走，且不许回到若无其事', () => {
    const note = emotionInjectionNote(full);
    assert.match(note, /不能若无其事/);
  });
});

/** 建一个玩家 + 线程（返回 playerId/characterId，角色级状态测试也要用） */
function makeThread(): { playerId: string; characterId: string; threadId: string } {
  const playerId = genId();
  const threadId = genId();
  const characterId = 'c1';
  db.prepare('INSERT INTO players (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(playerId, 'p', now(), now());
  db.prepare('INSERT INTO message_threads (id, player_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(threadId, playerId, characterId, now(), now());
  return { playerId, characterId, threadId };
}
function addNpcMsg(threadId: string, createdAt: number, metadata: string): string {
  const id = genId();
  db.prepare(
    `INSERT INTO text_messages (id, thread_id, sender, body, status, metadata, created_at, delivered_at)
     VALUES (?, ?, 'npc', '嗯', 'delivered', ?, ?, ?)`,
  ).run(id, threadId, metadata, createdAt, createdAt);
  return id;
}

describe('心绪落库与读取', () => {

  it('挂心绪后能读回，且保留 metadata 原有键', () => {
    const { threadId } = makeThread();
    const msgId = addNpcMsg(threadId, now(), JSON.stringify({ proactive: true }));
    attachEmotionToMessage('text_messages', msgId, full);

    const row = db.prepare('SELECT metadata FROM text_messages WHERE id = ?').get(msgId) as { metadata: string };
    const meta = JSON.parse(row.metadata) as { proactive?: boolean; emotions?: EmotionScores };
    assert.equal(meta.proactive, true); // 原有键没被覆盖
    assert.equal(meta.emotions!.tenderness, 80);

    const last = readLastEmotion(threadId);
    assert.ok(last);
    assert.equal(last!.anger, 60);
  });

  it('坏数据不炸（metadata 非法 JSON / emotions 缺键都跳过）', () => {
    const { threadId } = makeThread();
    addNpcMsg(threadId, now(), '{不是合法json');
    const bad = addNpcMsg(threadId, now() + 1, JSON.stringify({ emotions: { joy: 1 } }));
    assert.equal(readThreadEmotions(threadId, 5).length, 0);
    attachEmotionToMessage('text_messages', bad, full);
    assert.equal(readThreadEmotions(threadId, 5).length, 1);
  });

  it('最近若干轮按新→旧返回，并带上最强维度', () => {
    const { threadId } = makeThread();
    const base = now();
    for (let i = 0; i < 3; i++) {
      const id = addNpcMsg(threadId, base + i * 1000, '{}');
      // 只抬高怜爱，确保它是最强维度（full 里占有欲 70 是最高的）
      attachEmotionToMessage('text_messages', id, { ...full, tenderness: 85 + i * 5 } as EmotionScores);
    }
    const turns = readThreadEmotions(threadId, 5);
    assert.equal(turns.length, 3);
    assert.equal(turns[0]!.emotions.tenderness, 95); // 最新一轮在前
    assert.equal(turns[0]!.top.cn, '怜爱');
    assert.equal(turns[2]!.emotions.tenderness, 85);
  });

  it('限制条数生效', () => {
    const { threadId } = makeThread();
    const base = now();
    for (let i = 0; i < 6; i++) {
      const id = addNpcMsg(threadId, base + i * 1000, '{}');
      attachEmotionToMessage('text_messages', id, full);
    }
    assert.equal(readThreadEmotions(threadId, 5).length, 5);
  });

  it('注入走角色级状态：无状态不注入，低于门槛不注入，够强则注入', () => {
    const { playerId, characterId } = makeThread();
    assert.equal(buildEmotionInjection(playerId, characterId), ''); // 无状态

    const weak = Object.fromEntries(EMOTION_KEYS.map((k) => [k, 5])) as unknown as EmotionScores;
    saveEmotionState(playerId, characterId, weak, 'sms', 't1');
    assert.ok(topEmotion(weak).value < EMOTION_INJECT_MIN);
    assert.equal(buildEmotionInjection(playerId, characterId), ''); // 低于门槛

    saveEmotionState(playerId, characterId, full, 'sms', 't1');
    const injection = buildEmotionInjection(playerId, characterId);
    assert.match(injection, /延续自上一刻/);
    assert.match(injection, /怜爱80/); // 刚写入，无时间衰减
  });

  it('attach 到不存在的消息时静默跳过', () => {
    assert.doesNotThrow(() => attachEmotionToMessage('text_messages', 'no-such-id', full));
  });
});

describe('角色级心绪状态（短信与约会共用）', () => {
  it('写入后可读回，同一角色重复写入只留一条', () => {
    const { playerId, characterId } = makeThread();
    saveEmotionState(playerId, characterId, full, 'sms', 'thread-1');
    const s1 = readEmotionState(playerId, characterId);
    assert.ok(s1);
    assert.equal(s1!.emotions.tenderness, 80);
    assert.equal(s1!.source, 'sms');
    assert.equal(s1!.sourceId, 'thread-1');

    saveEmotionState(playerId, characterId, { ...full, anger: 10 } as EmotionScores, 'scene', 'scene-9');
    const cnt = (db.prepare('SELECT count(*) AS c FROM character_emotion_state WHERE player_id = ?').get(playerId) as { c: number }).c;
    assert.equal(cnt, 1, '同一角色只应有一条状态');
    const s2 = readEmotionState(playerId, characterId);
    assert.equal(s2!.emotions.anger, 10);
    assert.equal(s2!.source, 'scene'); // 记录最后更新它的渠道
    assert.equal(s2!.sourceId, 'scene-9');
  });

  it('没有状态时返回 null（不报错）', () => {
    const { playerId, characterId } = makeThread();
    assert.equal(readEmotionState(playerId, characterId), null);
    assert.equal(readCurrentEmotion(playerId, characterId), null);
  });

  it('心绪保留到下次互动为止 —— 刻意不做任何时间衰减', () => {
    const { playerId, characterId } = makeThread();
    const angry = { joy: 0, desire: 5, panic: 10, loss: 30, grievance: 75, anger: 90, possessiveness: 55, tenderness: 0 } as EmotionScores;
    saveEmotionState(playerId, characterId, angry, 'scene', 'scene-1');

    // 把更新时间拨回 30 天前：玩家隔很久回来，仍应看到他上次的心绪（而不是一张空花瓣图）
    db.prepare('UPDATE character_emotion_state SET updated_at = ? WHERE player_id = ? AND character_id = ?')
      .run(now() - 30 * 24 * 3_600_000, playerId, characterId);

    const cur = readCurrentEmotion(playerId, characterId)!;
    assert.equal(cur.emotions.anger, 90, '隔多久都不衰减');
    assert.equal(topEmotion(cur.emotions).cn, '愤怒');
    // 也因此仍然会影响语气（注入门槛之上）
    assert.ok(topEmotion(cur.emotions).value >= EMOTION_INJECT_MIN);
  });

  it('跨渠道共用：短信写入的心绪，约会侧读到的是同一份', () => {
    const { playerId, characterId } = makeThread();
    saveEmotionState(playerId, characterId, full, 'sms', 'thread-1'); // 短信写的
    const forScene = readCurrentEmotion(playerId, characterId)!; // 约会读的
    assert.equal(forScene.emotions.tenderness, 80);
    assert.equal(forScene.source, 'sms');
    // 约会推进后写回，短信侧再读就是约会更新过的
    saveEmotionState(playerId, characterId, { ...full, tenderness: 20 } as EmotionScores, 'scene', 'scene-2');
    assert.equal(readCurrentEmotion(playerId, characterId)!.emotions.tenderness, 20);
  });
});
