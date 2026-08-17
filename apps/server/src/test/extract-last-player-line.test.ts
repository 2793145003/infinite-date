/**
 * extractLastPlayerLine 测试
 *
 * 覆盖：重试/继续空推轮复述检测锚点——从对话历史末尾提取玩家最后一条发言。
 * 背景 bug：retry 传 player_message=undefined，fixRepeatEcho 检测被跳过，
 *   男主复述玩家上一轮的话（如「比想象中大……」「抬一下那边……」）。
 *
 * 运行：node --import tsx --test src/test/extract-last-player-line.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLastPlayerLine } from '../lib/repeat-detect';

test('末尾就是玩家话 → 正确提取并去掉名字前缀', () => {
  const csf = [
    '白景安：让我来吧。（他撑起身子）',
    '星落（女性）：好（点点头，和他一起来到门口，签收了快递）比想象中大，抬一下那边',
  ].join('\n');
  const out = extractLastPlayerLine(csf, '星落（女性）');
  assert.equal(out, '好（点点头，和他一起来到门口，签收了快递）比想象中大，抬一下那边');
});

test('末尾是角色话，玩家话在更早 → 从后往前找到玩家最后一条', () => {
  const csf = [
    '星落（女性）：比想象中大，抬一下那边',
    '白景安：交给我就好。',
    '白景安：唔……这样可以吗？',
  ].join('\n');
  const out = extractLastPlayerLine(csf, '星落（女性）');
  assert.equal(out, '比想象中大，抬一下那边');
});

test('玩家名带性别标注（含括号）→ 正确匹配', () => {
  const csf = [
    '旁白：夜色渐深。',
    '星落（女性）：嗯。',
  ].join('\n');
  const out = extractLastPlayerLine(csf, '星落（女性）');
  assert.equal(out, '嗯。');
});

test('半角冒号也识别', () => {
  const csf = '星落（女性）: 走吧';
  const out = extractLastPlayerLine(csf, '星落（女性）');
  assert.equal(out, '走吧');
});

test('没有玩家发言 → 返回空字符串', () => {
  const csf = ['白景安：你好。', '白景安：嗯。'].join('\n');
  assert.equal(extractLastPlayerLine(csf, '星落（女性）'), '');
});

test('空对话历史 / 空玩家名 → 返回空字符串', () => {
  assert.equal(extractLastPlayerLine('', '星落（女性）'), '');
  assert.equal(extractLastPlayerLine('星落（女性）：嗯。', ''), '');
});

test('bug 场景：提取结果可被复述检测命中', () => {
  // 复述检测的判定核心：角色首条气泡「括号前文本去标点后连续≥3字出现在玩家话里」。
  // 这里验证提取出的玩家话包含角色复述的「比想象中大」片段（即检测能命中）。
  const csf = [
    '白景安：让我来吧。',
    '星落（女性）：好（点点头，和他一起来到门口，签收了快递）比想象中大，抬一下那边',
  ].join('\n');
  const playerMsg = extractLastPlayerLine(csf, '星落（女性）');
  // 角色复述的开头「比想象中大」必须能从玩家话里匹配到
  const strip = (s: string) => s.replace(/[。！？，、；：""''～…?\-~,\.\s你我]/g, '');
  assert.ok(strip(playerMsg).includes('比想象中'), '提取的玩家话应包含「比想象中」供检测命中');
  assert.ok(strip(playerMsg).includes('抬一下那边'), '提取的玩家话应包含「抬一下那边」');
});
