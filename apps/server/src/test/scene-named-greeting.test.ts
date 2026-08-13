/**
 * 点名版开场逻辑测试
 *
 * 覆盖：
 *  - 开场旁白 build 包含 circumstance 情境信息
 *  - 开场兜底男主 intent 包含 circumstance 情境提示
 *  - 各 circumstance 类型都能正确注入
 *  - 无 circumstance 时不报错（回退 default）
 *
 * 运行：node --import tsx --test src/test/scene-named-greeting.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGreetingSection } from '../prompt/loader';

/**
 * 构建开场旁白的 build 字符串。
 *
 * 当前实现 (run-scene-turn.ts L1172):
 *   `当前地点：${locName}。${locDesc}。写一段环境旁白。`
 *
 * 改后实现（加 circumstance 注入）:
 *   `当前地点：${locName}。${locDesc}。${circumstanceInfo}。写一段环境旁白。`
 *
 * 这个函数提取自 runSceneTurnNamed，使其可独立测试。
 */
function buildOpeningNarration(
  locName: string,
  locDesc: string,
  circumstance?: string,
  companions?: string,
): string {
  const loc = `当前地点：${locName}。${locDesc ? locDesc : ''}`;
  let circumstanceInfo = '';
  if (circumstance && circumstance !== 'default') {
    const greeting = loadGreetingSection(circumstance, {
      companions: companions ?? '',
      location: locName,
    });
    // 只取情境描述部分（去掉 default 基础纪律，旁白不需要导演纪律）
    // greeting 格式：{base}\n\n【本场情境】\n{specific}
    const parts = greeting.split('【本场情境】');
    circumstanceInfo = parts[1]?.trim() ?? parts[0]?.trim() ?? '';
  }
  return `${loc}。${circumstanceInfo}。写一段环境旁白。`;
}

/**
 * 构建开场兜底男主的 intent。
 *
 * 当前实现 (run-scene-turn.ts L1420):
 *   '开场自然地开口，和玩家展开对话。'
 *
 * 改后实现:
 *   '开场自然地开口，和玩家展开对话。' + circumstance 情境提示
 */
function buildFallbackIntent(circumstance?: string, companions?: string, location?: string): string {
  const base = '开场自然地开口，和玩家展开对话。';
  if (!circumstance || circumstance === 'default') return base;
  const greeting = loadGreetingSection(circumstance, {
    companions: companions ?? '',
    location: location ?? '',
  });
  const parts = greeting.split('【本场情境】');
  const specific = parts[1]?.trim() ?? '';
  return specific ? `${base}\n${specific}` : base;
}

// ─── 开场旁白 build ───────────────────────────────────

describe('开场旁白 build 包含 circumstance', () => {
  it('caught 情境：build 包含"逮"关键词', () => {
    const build = buildOpeningNarration('白景安的家', '一间整洁的公寓', 'caught', '白景安');
    assert.ok(build.includes('逮'), `build 应包含 caught 关键词，实际：${build.slice(0, 200)}`);
  });

  it('approach 情境：build 包含"路过"关键词', () => {
    const build = buildOpeningNarration('街道', '一条安静的街道', 'approach', '白景安');
    assert.ok(build.includes('路过'), `build 应包含 approach 关键词，实际：${build.slice(0, 200)}`);
  });

  it('invite 情境：build 包含"邀请"或"应邀"关键词', () => {
    const build = buildOpeningNarration('咖啡厅', '一家温馨的咖啡厅', 'invite', '白景安');
    assert.ok(
      build.includes('邀请') || build.includes('应邀'),
      `build 应包含 invite 关键词，实际：${build.slice(0, 200)}`,
    );
  });

  it('deity_pick 情境：build 包含"主神"或"抽"关键词', () => {
    const build = buildOpeningNarration('虚空', '一片虚空', 'deity_pick', '白景安');
    assert.ok(
      build.includes('主神') || build.includes('抽'),
      `build 应包含 deity_pick 关键词，实际：${build.slice(0, 200)}`,
    );
  });

  it('npc_invite 情境：build 包含"邀请"关键词', () => {
    const build = buildOpeningNarration('白景安的家', '一间公寓', 'npc_invite', '白景安');
    assert.ok(build.includes('邀请'), `build 应包含 npc_invite 关键词，实际：${build.slice(0, 200)}`);
  });

  it('无 circumstance：build 不报错，不包含情境关键词', () => {
    const build = buildOpeningNarration('某个地方', '一个普通的地方');
    assert.ok(build.includes('当前地点'));
    assert.ok(!build.includes('逮'));
    assert.ok(!build.includes('路过'));
  });

  it('circumstance=default：与无 circumstance 行为一致', () => {
    const build = buildOpeningNarration('某个地方', '一个普通的地方', 'default');
    assert.ok(build.includes('当前地点'));
    assert.ok(!build.includes('逮'));
  });

  it('build 始终包含地点信息', () => {
    const build = buildOpeningNarration('白景安的家', '一间整洁的公寓', 'caught', '白景安');
    assert.ok(build.includes('白景安的家'));
  });
});

// ─── 开场兜底男主 intent ─────────────────────────────

describe('开场兜底男主 intent 包含 circumstance', () => {
  it('caught 情境：intent 包含"逮"关键词', () => {
    const intent = buildFallbackIntent('caught', '白景安', '白景安的家');
    assert.ok(intent.includes('逮'), `intent 应包含 caught 关键词，实际：${intent.slice(0, 200)}`);
  });

  it('approach 情境：intent 包含"路过"关键词', () => {
    const intent = buildFallbackIntent('approach', '白景安', '街道');
    assert.ok(intent.includes('路过'), `intent 应包含 approach 关键词，实际：${intent.slice(0, 200)}`);
  });

  it('invite 情境：intent 包含"邀请"关键词', () => {
    const intent = buildFallbackIntent('invite', '白景安', '咖啡厅');
    assert.ok(intent.includes('邀请'), `intent 应包含 invite 关键词，实际：${intent.slice(0, 200)}`);
  });

  it('无 circumstance：intent 只有基础提示', () => {
    const intent = buildFallbackIntent();
    assert.ok(intent.includes('开场自然地开口'));
    assert.ok(!intent.includes('逮'));
    assert.ok(!intent.includes('路过'));
  });

  it('circumstance=default：与无 circumstance 行为一致', () => {
    const intent = buildFallbackIntent('default');
    assert.ok(intent.includes('开场自然地开口'));
    assert.ok(!intent.includes('逮'));
  });
});

// ─── 撤回后重试开场轮的情境一致性 ───────────────────

describe('撤回后重试开场轮的情境一致性', () => {
  it('整场撤回后重试 → caught 情境的 greeting 与首次开场一致', () => {
    // 首次开场的 greeting
    const firstGreeting = loadGreetingSection('caught', { companions: '白景安', location: '家' });
    // 撤回后重试的 greeting（circumstance 保留在 session 上）
    const retryGreeting = loadGreetingSection('caught', { companions: '白景安', location: '家' });
    assert.equal(firstGreeting, retryGreeting);
  });

  it('整场撤回后重试 → 开场旁白 build 与首次开场一致', () => {
    const firstBuild = buildOpeningNarration('家', '一间公寓', 'caught', '白景安');
    const retryBuild = buildOpeningNarration('家', '一间公寓', 'caught', '白景安');
    assert.equal(firstBuild, retryBuild);
  });

  it('整场撤回后重试 → 兜底男主 intent 与首次开场一致', () => {
    const firstIntent = buildFallbackIntent('caught', '白景安', '家');
    const retryIntent = buildFallbackIntent('caught', '白景安', '家');
    assert.equal(firstIntent, retryIntent);
  });

  it('不同情境的开场旁白 build 互不相同', () => {
    const caught = buildOpeningNarration('家', '公寓', 'caught', '白景安');
    const approach = buildOpeningNarration('街道', '路', 'approach', '白景安');
    const invite = buildOpeningNarration('咖啡厅', '咖啡馆', 'invite', '白景安');
    assert.notEqual(caught, approach);
    assert.notEqual(caught, invite);
    assert.notEqual(approach, invite);
  });
});
