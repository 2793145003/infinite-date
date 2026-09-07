import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { degradeWhen, buildWorldStateText } from '../routes/novel';

describe('degradeWhen 待办时间降级', () => {
  it('相邻时段（可跳）照写', () => {
    assert.equal(degradeWhen('下午', '第2天·中午'), '下午'); // 中午→午后
    assert.equal(degradeWhen('中午', '第2天·上午'), '中午'); // 上午→中午
    assert.equal(degradeWhen('上午', '第2天·清晨'), '上午'); // 清晨→上午
    assert.equal(degradeWhen('凌晨', '第2天·深夜'), '凌晨'); // 深夜→凌晨（环形相邻）
  });

  it('跨段（不可跳）降级为稍后', () => {
    assert.equal(degradeWhen('下午', '第2天·清晨'), '稍后'); // 清晨→午后 跨3段
    assert.equal(degradeWhen('下午', '第2天·上午'), '稍后'); // 上午→午后 跨2段
    assert.equal(degradeWhen('晚上', '第2天·中午'), '稍后'); // 中午→夜晚 跨3段
    assert.equal(degradeWhen('清晨', '第2天·深夜'), '稍后'); // 深夜→清晨 隔「凌晨」
  });

  it('跨天时间锚保留', () => {
    assert.equal(degradeWhen('明天', '第2天·清晨'), '明天');
    assert.equal(degradeWhen('明天早上八点', '第2天·傍晚'), '明天早上八点');
    assert.equal(degradeWhen('后天下午', '第2天·深夜'), '后天下午');
  });

  it('无时段词或空值原样返回', () => {
    assert.equal(degradeWhen('', '第2天·清晨'), '');
    assert.equal(degradeWhen('稍后', '第2天·清晨'), '稍后');
    assert.equal(degradeWhen('等会儿', '第2天·上午'), '等会儿');
    assert.equal(degradeWhen('下周', '第2天·中午'), '下周');
  });
});

describe('buildWorldStateText 注入文本', () => {
  // 真实抽取结果（cut_index=108 清晨场景）
  const dawnJson = JSON.stringify({
    苏叙: { current: { where: 'STARS宿舍餐厅', what: '站起身并做出调度指令' }, todo: { when: '下午', what: '去听沈遥写的Rap' } },
    唐予墨: { current: { where: 'STARS宿舍走廊', what: '踉跄着快步走向练习室' }, todo: { when: '', what: '' } },
    安之衡: { current: { where: 'STARS宿舍餐厅', what: '站在星落身边维持得体的协助姿态' }, todo: { when: '', what: '陪苏叙去医院' } },
    任晚星: { current: { where: '', what: '' }, todo: { when: '', what: '' } },
    沈遥: { current: { where: 'STARS宿舍餐厅', what: '站在餐桌边挑衅地注视星落' }, todo: { when: '下午', what: '去录音室' } },
    星落: { current: { where: 'STARS宿舍餐厅', what: '站起身环视成员并下达调度指令' }, todo: { when: '下午', what: '去听沈遥写的Rap' } },
  });

  it('清晨场景：跨段的「下午」待办降级为稍后，无时间锚的照写', () => {
    const out = buildWorldStateText(dawnJson, '第2天·清晨');
    assert.ok(out.includes('沈遥（稍后）：去录音室'), '跨段「下午」应降级为「稍后」');
    assert.ok(out.includes('安之衡：陪苏叙去医院'), '无 when 的待办应照写');
    assert.ok(!out.includes('（下午）'), '注入文本不应出现具体时段词「下午」');
    assert.ok(!out.includes('任晚星'), '全空的角色不应出现在注入里');
    assert.ok(out.includes('当前世界状态'), '应有状态块标题');
    assert.ok(out.includes('尚未完成的约定/待办'), '应有待办块标题');
  });

  it('中午场景：相邻的「下午」待办照写不降级', () => {
    const noonJson = JSON.stringify({ 沈遥: { current: { where: '', what: '' }, todo: { when: '下午', what: '去录音室' } } });
    const out = buildWorldStateText(noonJson, '第2天·中午');
    assert.ok(out.includes('沈遥（下午）：去录音室'), '中午→午后相邻，应保留「下午」');
  });

  it('空 world_state 返回空字符串', () => {
    assert.equal(buildWorldStateText('', '第2天·清晨'), '');
    assert.equal(buildWorldStateText('{}', '第2天·清晨'), '');
  });
});
