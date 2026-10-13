import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kinship, ke, sheng, shengMe, keMe, isXiangSheng, isXiangKe } from '../world/wuxing';

describe('五行相生', () => {
  it('金生水、水生木、木生火、火生土、土生金', () => {
    assert.equal(sheng('金'), '水');
    assert.equal(sheng('水'), '木');
    assert.equal(sheng('木'), '火');
    assert.equal(sheng('火'), '土');
    assert.equal(sheng('土'), '金');
  });
  it('生我互为逆', () => {
    assert.equal(shengMe('水'), '金');
    assert.equal(shengMe('金'), '土');
  });
});

describe('五行相克', () => {
  it('金克木、木克土、土克水、水克火、火克金', () => {
    assert.equal(ke('金'), '木');
    assert.equal(ke('木'), '土');
    assert.equal(ke('土'), '水');
    assert.equal(ke('水'), '火');
    assert.equal(ke('火'), '金');
  });
  it('克我互为逆', () => {
    assert.equal(keMe('木'), '金');
    assert.equal(keMe('金'), '火');
  });
});

describe('六亲推导', () => {
  it('同五行 = 兄弟', () => {
    assert.equal(kinship('金', '金'), '兄弟');
  });
  it('生我者 = 父母', () => {
    // 金生水：水眼里的金是父母（金生水）
    assert.equal(kinship('水', '金'), '父母');
  });
  it('我生者 = 子孙', () => {
    assert.equal(kinship('金', '水'), '子孙');
  });
  it('克我者 = 官鬼', () => {
    // 火克金：金眼里的火是官鬼
    assert.equal(kinship('金', '火'), '官鬼');
  });
  it('我克者 = 妻财', () => {
    // 金克木：金眼里的木是妻财
    assert.equal(kinship('金', '木'), '妻财');
  });
});

describe('关系成对互补', () => {
  it('金克木：金视木为妻财，木视金为官鬼', () => {
    assert.equal(kinship('金', '木'), '妻财');
    assert.equal(kinship('木', '金'), '官鬼');
  });
  it('金生水：金视水为子孙，水视金为父母', () => {
    assert.equal(kinship('金', '水'), '子孙');
    assert.equal(kinship('水', '金'), '父母');
  });
  it('isXiangSheng / isXiangKe 对称', () => {
    assert.ok(isXiangSheng('金', '水'));
    assert.ok(isXiangSheng('水', '金'));
    assert.ok(isXiangKe('金', '木'));
    assert.ok(isXiangKe('木', '金'));
    assert.ok(!isXiangKe('金', '金'));
  });
});
