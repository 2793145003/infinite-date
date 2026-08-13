/**
 * cleanStraySymbols 测试
 *
 * 运行：node --import tsx --test src/test/clean-stray.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanStraySymbols } from '../lib/clean-text';

test('正常成对括号不修改', () => {
  const t = '没事，他们只是服务人员。（他低声安抚道）好的。';
  assert.equal(cleanStraySymbols(t), t);
});

test('末尾多余全角右括号删除', () => {
  const t = '台词（动作描写））';
  assert.equal(cleanStraySymbols(t), '台词（动作描写）');
});

test('末尾多余半角右括号删除（点名版不走 cleanMessageText 的场景）', () => {
  // LLM 输出混用全角左括号 + 全角右括号 + 半角右括号
  const t = '没事，他们只是服务人员。（他低声安抚道，声音压得很低）)';
  const result = cleanStraySymbols(t);
  assert.equal(result, '没事，他们只是服务人员。（他低声安抚道，声音压得很低）');
  assert.ok(!result.endsWith(')'), '不应以半角右括号结尾');
});

test('半角括号统一为全角', () => {
  const t = '台词(动作)后续';
  const result = cleanStraySymbols(t);
  assert.equal(result, '台词（动作）后续');
});

test('用户报告的实际 case', () => {
  const t = '没事，他们只是服务人员。（他低声安抚道，声音压得很低，像是怕惊扰了你刚刚找回的平静。随后，他抬起眼睫，对那位服务员礼貌地点了点头，语调平和却带着一种上位者惯有的、不容忽视的客气）)';
  const result = cleanStraySymbols(t);
  assert.ok(!result.endsWith(')'), '不应以半角右括号结尾');
  assert.ok(!result.endsWith('））'), '不应以双全角右括号结尾');
  assert.ok(result.endsWith('客气）'), '应以"客气）"结尾');
});

test('多余引号也清理', () => {
  const t = '台词\u201d';
  assert.equal(cleanStraySymbols(t), '台词');
});

test('空字符串安全', () => {
  assert.equal(cleanStraySymbols(''), '');
});

test('多余右括号后跟句号（不在最末尾）', () => {
  // Gemma 偶发：成对括号结束后，句尾又多补一个右括号 + 句号
  const t = '怎么……（他看着你，语气平稳却透着一丝放纵）这么晚了，还要奔波而来。）';
  const result = cleanStraySymbols(t);
  assert.equal(result, '怎么……（他看着你，语气平稳却透着一丝放纵）这么晚了，还要奔波而来。');
  assert.ok(!result.includes('））'), '不应有连续双右括号');
  const closeCount = (result.match(/）/g) || []).length;
  assert.equal(closeCount, 1, '只应保留一个右括号');
});
