/**
 * 「共享菜园」纯函数单测（种植 / 偷菜 / 反应 / 临时上下文 / 料理编菜规则）。
 * 不连 DB、不连 LLM —— 这一层就是给"可以单独测试"用的。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CROPS, EXCLUSIVE_CROPS, STARTING_SEEDS, SEED_DROP_EXPLORE, SEED_KEEP_ON_HARVEST, SEED_FROM_STEAL, exclusiveCropFor, cropName } from '../farm/crops';
import { HOUR, harvest, isRipe, plant, progress, ripeAt, stageOf, water } from '../farm/growth';
import { canSteal, ledger, steal } from '../farm/steal';
import { FORBIDDEN_WORDS, fallbackLine, hasForbidden, shouldPostOnScheduleChange, stolenHint, temperamentOf } from '../farm/reaction';
import { freshNotes, isFresh, makeGiftNote, makeNote, makeRipeNote, makeStolenNote, noteInjection, NOTE_TTL } from '../farm/context';
import { KITCHEN_BOARD, KITCHEN_SET, KITCHEN_TILES, dishBrief, formOf, buildDishPrompt, bannedNameWords, pickImagery, DISH_SCHEMA } from '../farm/kitchen';
import { makeRng } from '../farm/rng';

const T0 = 1_700_000_000_000;

describe('作物表', () => {
  it('生活向作物时长阶梯完整（2h 起步、24h 封顶）', () => {
    assert.equal(CROPS.length, 10);
    assert.equal(CROPS[0]!.hours, 2);
    assert.equal(CROPS[CROPS.length - 1]!.hours, 24);
    for (let i = 1; i < CROPS.length; i++) {
      assert.ok(CROPS[i]!.hours >= CROPS[i - 1]!.hours, '时长必须单调不减');
    }
  });

  it('专属作物都是奇幻向、够稀有（≥18h）', () => {
    assert.ok(EXCLUSIVE_CROPS.length >= 4);
    for (const c of EXCLUSIVE_CROPS) {
      assert.equal(c.fantasy, true);
      assert.equal(c.exclusive, true);
      assert.ok(c.hours >= 18);
    }
  });

  it('初始赠送的种子都在作物表里', () => {
    for (const k of STARTING_SEEDS) assert.ok(CROPS.some((c) => c.key === k));
  });

  it('掉率是星落定的那三个数', () => {
    assert.equal(SEED_DROP_EXPLORE, 0.35);
    assert.equal(SEED_KEEP_ON_HARVEST, 0.3);
    assert.equal(SEED_FROM_STEAL, 0.25);
  });
});

describe('专属作物规则', () => {
  it('光/星 系人设 → 星光果', () => {
    const crop = exclusiveCropFor({ name: '某男主', skills: 'evol是光元素掌控', drive: '守在你身侧' });
    assert.equal(crop.name, '星光果');
  });

  it('雪/冷 系人设 → 霜凌莓', () => {
    const crop = exclusiveCropFor({ name: '某人', personality: { core: '冷静克制' }, drive: '雪夜里的等候' });
    assert.equal(crop.name, '霜凌莓');
  });

  it('无关键词时按名字确定性兜底（跑两遍一样）', () => {
    const a = exclusiveCropFor({ name: '张三' });
    const b = exclusiveCropFor({ name: '张三' });
    assert.equal(a.key, b.key);
    assert.ok(EXCLUSIVE_CROPS.some((c) => c.key === a.key));
  });
});

describe('生长', () => {
  it('成熟时刻 = 种植时刻 + 时长', () => {
    const p = plant('tomato', T0);
    assert.equal(ripeAt(p), T0 + 4 * HOUR);
  });

  it('浇水只加速 10%，且只能浇一次', () => {
    const p = plant('tomato', T0);
    const w1 = water(p, T0 + HOUR);
    assert.equal(ripeAt(w1), T0 + Math.round(4 * HOUR * 0.9));
    const w2 = water(w1, T0 + 2 * HOUR);
    assert.equal(ripeAt(w2), ripeAt(w1), '第二次浇水不叠加');
  });

  it('成熟后不理它没有任何损失：进度不掉、永远算熟', () => {
    const p = plant('scallion', T0);
    const later = T0 + 30 * 24 * HOUR;
    assert.equal(progress(p, later), 1);
    assert.equal(stageOf(p, later), 'ripe');
    assert.equal(isRipe(p, later), true);
  });

  it('未熟不能收；熟了才给产量', () => {
    const p = plant('strawberry', T0);
    const rng = makeRng(1);
    assert.equal(harvest(p, T0 + HOUR, rng).crops, 0);
    const r = harvest(p, T0 + 8 * HOUR, rng);
    assert.equal(r.crops, 4);
    assert.ok(r.seeds === 0 || r.seeds === 1);
  });

  it('阶段按进度划分', () => {
    const p = plant('ginseng', T0);
    assert.equal(stageOf(p, T0 + 1 * HOUR), 'seed');
    assert.equal(stageOf(p, T0 + 8 * HOUR), 'sprout');
    assert.equal(stageOf(p, T0 + 18 * HOUR), 'growing');
    assert.equal(stageOf(p, T0 + 24 * HOUR), 'ripe');
  });
});

describe('偷菜', () => {
  const base = { ripeCount: 6, atHome: false, stolenThisCycle: false, stolenTodayByPlayer: false };

  it('四种情况都会被拦下', () => {
    assert.equal(canSteal({ ...base, ripeCount: 0 }), '他这块地还没熟');
    assert.equal(canSteal({ ...base, atHome: true }), '他在院子里，今天不好下手');
    assert.equal(canSteal({ ...base, stolenThisCycle: true }), '这一茬已经偷过了');
    assert.equal(canSteal({ ...base, stolenTodayByPlayer: true }), '今天已经偷过他的了');
    assert.equal(canSteal(base), null);
  });

  it('拿走约 1/3，至少 1 个', () => {
    const rng = makeRng(7);
    assert.equal(steal('tomato', { ...base, ripeCount: 6 }, rng).taken, 2);
    assert.equal(steal('tomato', { ...base, ripeCount: 2 }, rng).taken, 1);
    assert.equal(steal('tomato', { ...base, ripeCount: 1 }, rng).taken, 1);
  });

  it('被拦下时什么都没拿走', () => {
    const r = steal('tomato', { ...base, atHome: true }, makeRng(3));
    assert.equal(r.ok, false);
    assert.equal(r.taken, 0);
    assert.equal(r.seeds, 0);
  });

  it('台账只记数字和作物名（没有任何"是谁"的信息）', () => {
    const l = ledger([
      { at: T0, cropName: '番茄', taken: 2 },
      { at: T0 + 1, cropName: '番茄', taken: 1 },
      { at: T0 + 2, cropName: '星光果', taken: 1 },
    ]);
    assert.equal(l.times, 3);
    assert.equal(l.totalLost, 4);
    assert.deepEqual(l.byCrop, { 番茄: 3, 星光果: 1 });
    assert.ok(!JSON.stringify(l).includes('玩家'));
  });
});

describe('被偷之后：按性格，不指控玩家', () => {
  it('性格分档认得出人设关键词', () => {
    assert.equal(temperamentOf({ personality: { core: '多疑且占有欲强' } }), '多疑型');
    assert.equal(temperamentOf({ drive: '不动声色地掌控全局' }), '腹黑型');
    assert.equal(temperamentOf({ personality: { surface: '说话直白、爽快' } }), '直球型');
    assert.equal(temperamentOf({ name: '谁' }), '粗心型');
  });

  it('事实文本只说"少了"，不说"谁"；事实部分不含禁词（禁词只出现在禁令句里）', () => {
    for (const t of ['粗心型', '多疑型', '腹黑型', '直球型'] as const) {
      const hint = stolenHint({ characterName: '阿回', cropName: '番茄', lost: 2, before: 5, times: 2, temperament: t });
      assert.ok(hint.includes('少了'));
      assert.ok(hint.includes('不知道是谁拿的'));
      // 事实句 = 禁令句之前的部分：不能出现"玩家"
      const facts = hint.split('写一条朋友圈')[0]!;
      assert.ok(!facts.includes('玩家'), `事实里不能出现玩家：${facts}`);
      assert.ok(!hasForbidden(facts), `事实里不该有禁词：${facts}`);
      // 禁令句要**点名**这些词（实测：点名禁令比含糊描述有效）
      assert.ok(hint.includes('「玩家」「游戏」'));
    }
  });

  it('发帖按行程意愿概率：0 → 必不发，100 → 必发', () => {
    const rng = makeRng(9);
    assert.equal(shouldPostOnScheduleChange(0, rng), false);
    for (let i = 0; i < 20; i++) assert.equal(shouldPostOnScheduleChange(100, rng), true);
    let hits = 0;
    for (let i = 0; i < 400; i++) if (shouldPostOnScheduleChange(50, rng)) hits++;
    assert.ok(hits > 120 && hits < 280, `50% 意愿应约一半命中，实测 ${hits}/400`);
  });

  it('兜底文案四档都像人话、且不指控', () => {
    for (const t of ['粗心型', '多疑型', '腹黑型', '直球型'] as const) {
      const line = fallbackLine(t, '番茄');
      assert.ok(line.includes('番茄'));
      assert.ok(!hasForbidden(line));
    }
  });

  it('禁词表覆盖「玩家/AI/好感度」这类出戏词', () => {
    assert.ok(FORBIDDEN_WORDS.includes('玩家'));
    assert.ok(hasForbidden('玩家偷了我的菜'));
    assert.equal(hasForbidden('我种的番茄少了几个'), false);
  });
});

describe('临时上下文（成熟写进上下文，说不说看角色自己）', () => {
  it('三档 TTL：被偷记最久', () => {
    assert.ok(NOTE_TTL.stolen > NOTE_TTL.ripe);
    assert.equal(NOTE_TTL.gift, NOTE_TTL.ripe);
  });

  it('过期的不算数，新的排在前面', () => {
    const old = makeNote('ripe', '旧事', T0);
    const fresh = makeRipeNote('番茄', T0 + 30 * HOUR);
    const now = T0 + 36 * HOUR;
    assert.equal(isFresh(old, now), false);
    const list = freshNotes([old, fresh], now);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.text, '你院子里的番茄熟了，还没来得及摘。');
  });

  it('注入文本明确"说不说由你自己决定"，且不含禁词', () => {
    const injection = noteInjection([makeRipeNote('番茄', T0), makeStolenNote('番茄', 2, 2, T0), makeGiftNote('星光果慕斯', T0)]);
    assert.ok(injection.includes('说不说'));
    assert.ok(injection.includes('别刻意提起'));
    assert.ok(!hasForbidden(injection));
  });

  it('没有状态时不注入任何东西', () => {
    assert.equal(noteInjection([]), '');
  });
});

describe('料理：编菜规则（治菜名塌缩 / 什么都做饭）', () => {
  it('做法形态由加成块决定', () => {
    assert.equal(formOf({ 老火高汤: 3, 猛火: 1, 秘制酱: 0 }), '炖汤');
    assert.equal(formOf({ 老火高汤: 1, 猛火: 4, 秘制酱: 2 }), '爆炒');
    assert.equal(formOf({ 老火高汤: 0, 猛火: 0, 秘制酱: 2 }), '凉拌酱汁');
    assert.equal(formOf({ 星光果: 9, 云顶米: 4 }), '家常');
  });

  it('云顶米不是主力时，菜名禁止出现饭/粥/米', () => {
    const words = bannedNameWords({ 星光果: 9, 晨露菜: 6, 云顶米: 2 });
    assert.ok(words.includes('饭'));
    assert.ok(words.includes('粥'));
    const rice = bannedNameWords({ 云顶米: 9, 星光果: 3 });
    assert.ok(!rice.includes('饭'));
  });

  it('意象词随机但同种子可复跑', () => {
    const a = pickImagery(makeRng(5), '炖汤', 3);
    const b = pickImagery(makeRng(5), '炖汤', 3);
    assert.deepEqual(a, b);
    assert.equal(a.length, 3);
    assert.equal(new Set(a).size, 3);
  });

  it('品质按重校准后的阈值分档（250/320/430）', () => {
    const rng = makeRng(1);
    assert.equal(dishBrief({ 星光果: 6 }, 200, rng).quality, '下品');
    assert.equal(dishBrief({ 星光果: 6 }, 260, rng).quality, '中品');
    assert.equal(dishBrief({ 星光果: 6 }, 330, rng).quality, '上品');
    assert.equal(dishBrief({ 星光果: 6 }, 470, rng).quality, '极品');
  });

  it('prompt 里同时钉住形态、意象词、禁词与最近菜名', () => {
    const brief = dishBrief({ 老火高汤: 4, 星光果: 8, 云顶米: 3 }, 470, makeRng(2), ['星光果慕斯']);
    const prompt = buildDishPrompt(brief);
    assert.ok(prompt.includes('炖汤'));
    assert.ok(prompt.includes('意象词'));
    assert.ok(prompt.includes('星光果慕斯'), '必须带上最近用过的菜名供它避开');
    assert.ok(prompt.includes(brief.imagery[0]!));
    assert.ok(!prompt.includes('玩家偷'));
  });

  it('盘面块 = 5 基础 + 3 加成，权重结构与修仙盘面一致', () => {
    assert.equal(KITCHEN_TILES.length, 8);
    assert.equal(KITCHEN_SET.types.length, 8);
    assert.equal(KITCHEN_SET.clearLine, '猛火');
    assert.deepEqual(Object.keys(KITCHEN_SET.weights).length, 8);
    assert.equal(KITCHEN_BOARD.size, 7);
    assert.equal(KITCHEN_BOARD.moves, 12);
  });

  it('编菜的 schema 把食材钉死在盘面 8 种块上', () => {
    const props = (DISH_SCHEMA as { properties: { ingredients: { items: { enum: string[] } } } }).properties;
    assert.deepEqual(props.ingredients.items.enum, [...KITCHEN_TILES]);
  });

  it('作物名查得到（给日报/提示用）', () => {
    assert.equal(cropName('starlight'), '星光果');
    assert.equal(cropName('nope'), 'nope');
  });
});
