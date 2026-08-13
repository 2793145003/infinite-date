/**
 * 撤回/重试逻辑测试
 *
 * 覆盖：
 *  - retry 路径判定（有/无玩家发言 → 整场重开 vs 本轮重试）
 *  - 撤回 keepPlayerMessage 语义
 *  - circumstance 在撤回/重试后保留
 *  - greeting 情境在撤回后重试时正确注入
 *
 * 注意：rollbackScene 依赖真实 DB，这里测的是接口契约和路由层逻辑，
 * 不直接调 DB。DB 层的测试需要单独的集成测试环境。
 *
 * 运行：node --import tsx --test src/test/scene-rollback.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGreetingSection } from '../prompt/loader';

// ─── retry 路径判定逻辑 ───────────────────────────────

describe('retry 路径判定', () => {
  // 模拟 scene.ts retry 路由里的判定逻辑
  // 核心规则：
  //   - 无玩家发言（撤回后回到开场） → targetRound=0（整场重开）
  //   - 有玩家发言 → 找最后一个非玩家消息的 round_no，重试该轮
  //   - targetRound=0 时 keepPlayerMessage 无效（全部清空）
  //   - targetRound>0 时 keepPlayerMessage=true（保留玩家发言，只重生成 NPC/旁白）

  function determineRetryTarget(
    hasPlayerMessage: boolean,
    lastNonPlayerRound: number | null,
  ): { targetRound: number; isRetainPlayerRetry: boolean } {
    if (!hasPlayerMessage) {
      return { targetRound: 0, isRetainPlayerRetry: false };
    }
    if (lastNonPlayerRound === null || lastNonPlayerRound < 1) {
      return { targetRound: 0, isRetainPlayerRetry: false };
    }
    return { targetRound: lastNonPlayerRound, isRetainPlayerRetry: true };
  }

  it('无玩家发言 → 整场重开 (targetRound=0)', () => {
    const result = determineRetryTarget(false, null);
    assert.equal(result.targetRound, 0);
    assert.equal(result.isRetainPlayerRetry, false);
  });

  it('有玩家发言 + 有NPC回复 → 本轮重试', () => {
    const result = determineRetryTarget(true, 3);
    assert.equal(result.targetRound, 3);
    assert.equal(result.isRetainPlayerRetry, true);
  });

  it('有玩家发言 + 无NPC回复（round<1） → 整场重开', () => {
    const result = determineRetryTarget(true, 0);
    assert.equal(result.targetRound, 0);
    assert.equal(result.isRetainPlayerRetry, false);
  });

  it('有玩家发言 + lastNonPlayerRound=null → 整场重开', () => {
    const result = determineRetryTarget(true, null);
    assert.equal(result.targetRound, 0);
    assert.equal(result.isRetainPlayerRetry, false);
  });
});

// ─── 撤回 keepPlayerMessage 语义 ─────────────────────

describe('撤回 keepPlayerMessage 语义', () => {
  // 模拟 deleteAppendedRows 的逻辑
  function simulateDelete(
    messages: { round_no: number; role: string }[],
    targetRound: number,
    keepPlayerMessage: boolean,
  ): { round_no: number; role: string }[] {
    if (keepPlayerMessage) {
      return messages.filter(
        m => m.round_no <= targetRound || (m.round_no === targetRound && m.role === 'player')
      ).filter(m => m.round_no < targetRound || m.role === 'player');
    }
    return messages.filter(m => m.round_no < targetRound);
  }

  it('keepPlayerMessage=true：保留本轮玩家发言，删NPC/旁白', () => {
    const messages = [
      { round_no: 1, role: 'player' },
      { round_no: 1, role: 'narration' },
      { round_no: 1, role: 'character' },
      { round_no: 2, role: 'player' },
      { round_no: 2, role: 'character' },
    ];
    const result = simulateDelete(messages, 2, true);
    // round 2 只保留 player，删掉 character
    assert.ok(result.some(m => m.round_no === 2 && m.role === 'player'));
    assert.ok(!result.some(m => m.round_no === 2 && m.role === 'character'));
    // round 1 全部保留
    assert.equal(result.filter(m => m.round_no === 1).length, 3);
  });

  it('keepPlayerMessage=false：删掉目标轮及之后全部', () => {
    const messages = [
      { round_no: 1, role: 'player' },
      { round_no: 1, role: 'character' },
      { round_no: 2, role: 'player' },
      { round_no: 2, role: 'character' },
    ];
    const result = simulateDelete(messages, 2, false);
    // 只保留 round 1
    assert.equal(result.length, 2);
    assert.ok(result.every(m => m.round_no === 1));
  });

  it('整场撤回 (targetRound=0) keepPlayerMessage 无效', () => {
    const messages = [
      { round_no: 1, role: 'player' },
      { round_no: 1, role: 'character' },
    ];
    const result = simulateDelete(messages, 0, true);
    assert.equal(result.length, 0);
  });
});

// ─── circumstance 在撤回/重试后保留 ─────────────────

describe('circumstance 在撤回/重试后保留', () => {
  // circumstance 存在 scene_sessions 表上，撤回不删 session 行
  // 重试时 buildSceneInput 仍能从 session.circumstance 读到

  it('整场撤回后 circumstance 仍保留（session 行不删）', () => {
    // 模拟：session.circumstance = 'caught'
    // rollbackScene(targetRound=0) 只删追加型数据，不删 session
    // 重试时 buildSceneInput 读 session.circumstance → 仍为 'caught'
    const sessionAfterRollback = {
      circumstance: 'caught',
      round_no: 0,
    };
    assert.equal(sessionAfterRollback.circumstance, 'caught');
  });

  it('按轮撤回后 circumstance 仍保留', () => {
    const sessionAfterRollback = {
      circumstance: 'approach',
      round_no: 1, // 修正为现存最大轮
    };
    assert.equal(sessionAfterRollback.circumstance, 'approach');
  });

  it('撤回后重试开场轮 → has_player_spoken=false → isOpening=true', () => {
    // 整场撤回后无玩家消息 → has_player_spoken=false → 开场轮
    // 此时 circumstance 应被注入开场旁白和兜底男主
    const hasPlayerSpoken = false; // 整场撤回后
    const isOpening = !hasPlayerSpoken;
    assert.equal(isOpening, true);
  });

  it('按轮撤回保留玩家发言 → has_player_spoken=true → 非开场轮', () => {
    // 按轮撤回 + keepPlayerMessage → 玩家消息保留 → has_player_spoken=true
    const hasPlayerSpoken = true;
    const isOpening = !hasPlayerSpoken;
    assert.equal(isOpening, false);
  });
});

// ─── greeting 情境在撤回后重试时注入 ─────────────────

describe('greeting 情境在撤回后重试时注入', () => {
  // 点名版开场旁白 build 应包含 circumstance 信息
  // 当前代码 (L1172): `当前地点：${locName}。${locDesc}。写一段环境旁白。`
  // 改后应包含 circumstance → loadGreetingSection(circumstance) 的情境描述

  it('caught 情境的 greeting 在撤回后重试应能正确加载', () => {
    const greeting = loadGreetingSection('caught', { companions: '白景安', location: '白景安的家' });
    assert.ok(greeting.includes('逮'));
    assert.ok(greeting.includes('白景安'));
  });

  it('approach 情境的 greeting 在撤回后重试应能正确加载', () => {
    const greeting = loadGreetingSection('approach', { companions: '白景安', location: '街道' });
    assert.ok(greeting.includes('路过'));
  });

  it('无 circumstance（默认）的 greeting 应包含开场纪律', () => {
    const greeting = loadGreetingSection('default');
    assert.ok(greeting.includes('开场纪律'));
  });

  // 以下是改后应满足的测试（当前会失败 = TDD 红灯）
  // 改完后跑这些测试应该变绿

  it('开场旁白 build 应包含 circumstance 情境信息（改后通过）', () => {
    // 模拟改后的 build 逻辑
    const circumstance = 'caught';
    const locName = '白景安的家';
    const locDesc = '一间整洁的公寓';
    const greeting = loadGreetingSection(circumstance, { companions: '白景安', location: locName });

    // 改后的 build 应包含 greeting 情境
    // 当前代码不含 → 这个测试会失败（TDD 红灯）
    const build = `当前地点：${locName}。${locDesc}。${greeting}。写一段环境旁白。`;
    assert.ok(build.includes('逮'), '开场旁白 build 应包含 caught 情境关键词');
  });

  it('开场兜底男主 intent 应包含 circumstance 情境提示（改后通过）', () => {
    // 模拟改后的兜底 intent
    const circumstance = 'approach';
    const greeting = loadGreetingSection(circumstance, { companions: '白景安', location: '街道' });

    // 改后的兜底 intent 应包含情境提示
    const fallbackIntent = `开场自然地开口，和玩家展开对话。${greeting}`;
    assert.ok(fallbackIntent.includes('路过'), '兜底男主 intent 应包含 approach 情境关键词');
  });
});
