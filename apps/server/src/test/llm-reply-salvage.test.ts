/**
 * LLM 回复「JSON 碎片被当成台词」修复 —— 离线验证
 *
 * 样本来源：2026-09-18 全库排查时在 messages 表里发现 8 条脏台词（08-02 一场对话）：
 *   '],' / 'internal히' / 'internal_notable' / 'player_description' / '正在掌握着主导权的爱人'
 *   / 'item_obtained' / 'null' / 'scene_concluded' / 'false' / 'environment' / '' / 'quest_npc_line'
 * 成因：输出被截断导致 "messages" 数组没闭合时，旧的抢救逻辑用非贪婪正则吃到第一个 ']'，
 *      把后面字段的字段名和值一并当成台词提取出来。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isJsonFragmentText, salvageMessagesFromText } from '../prompt/builder';

/** 事故里真实出现过的脏台词 */
const OBSERVED_GARBAGE = [
  "'],", 'internal히', 'internal_notable', 'player_description', 'item_obtained',
  'null', 'false', 'scene_concluded', 'environment', 'quest_npc_line', 'internal',
];

/** 复刻当时的坏输出：messages 数组没闭合，后面还跟着字段（第一个 ']' 出现在 item_obtained 里） */
const TRUNCATED_RAW = `{"messages": ["我在想你", "（你终于回来了）", "internal히": "心里一暖", "internal_notable": false, "player_description": "正在掌握着主导权的爱人", "item_obtained": [], "scene_concluded": false`;

describe('JSON 碎片识别', () => {
  it('事故里出现过的脏台词全部识别为碎片', () => {
    for (const g of OBSERVED_GARBAGE) {
      assert.equal(isJsonFragmentText(g), true, `应识别为碎片：${JSON.stringify(g)}`);
    }
  });

  it('正常台词不会被误判', () => {
    const legit = [
      '我在想你', '（你终于回来了）', '嗯', '好～', '……',
      '（他低下头，声音很轻）你回来了。', '（低声说：别走）',
      '他说：我等你很久了。', 'OK.', '哈啊……好疼……', '苏醒了！',
    ];
    for (const s of legit) {
      assert.equal(isJsonFragmentText(s), false, `不应误判：${JSON.stringify(s)}`);
    }
  });
});

describe('损坏输出的台词抢救', () => {
  it('截断输出：只抢救真台词，字段名/值不再漏进来', () => {
    const salvaged = salvageMessagesFromText(TRUNCATED_RAW);
    assert.ok(salvaged, '应抢救出结果');
    assert.deepEqual(salvaged!.messages, ['我在想你', '（你终于回来了）']);
    for (const g of OBSERVED_GARBAGE) {
      assert.ok(!salvaged!.messages.includes(g), `脏台词不应出现：${g}`);
    }
    // 值也不应漏进来（internal/player_description 的值属于字段，不是台词）
    assert.ok(!salvaged!.messages.some((m) => m.includes('心里一暖')));
    assert.ok(!salvaged!.messages.some((m) => m.includes('正在掌握着主导权的爱人')));
  });

  it('数组闭合但整体 JSON 坏掉（未转义引号）：仍能抢救出台词', () => {
    const raw = '{"messages": ["他忽然笑了", "（捏了捏你的脸）"], "internal": "有点想你", "internal_notable": true, "scene_concluded": fals}';
    const salvaged = salvageMessagesFromText(raw);
    assert.ok(salvaged);
    assert.deepEqual(salvaged!.messages, ['他忽然笑了', '（捏了捏你的脸）']);
    assert.equal(salvaged!.internal, '有点想你');
  });

  it('messages 是字符串而不是数组：也能拿到那一句', () => {
    const raw = '{"messages": "就一句台词", "internal": ""';
    const salvaged = salvageMessagesFromText(raw);
    assert.ok(salvaged);
    assert.deepEqual(salvaged!.messages, ['就一句台词']);
  });

  it('全是碎片的输出：不返回结果（让上层走下一层防御）', () => {
    const raw = '{"messages": ["internal_notable", "null", "false"], "item_obtained": []';
    const salvaged = salvageMessagesFromText(raw);
    assert.equal(salvaged, null);
  });

  it('creation 路由的单字段格式仍可抢救', () => {
    const salvaged = salvageMessagesFromText('{"message": "欢迎回来", "draft": {"name": "阿岚"}');
    assert.ok(salvaged);
    assert.deepEqual(salvaged!.messages, ['欢迎回来']);
  });
});
