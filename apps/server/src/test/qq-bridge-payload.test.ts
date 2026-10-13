import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutbound, assertNoInviteLeak, type SmsRowForBridge } from '../qq-bridge/payload';

function row(over: Partial<SmsRowForBridge> = {}): SmsRowForBridge {
  return {
    msgId: 'm1',
    threadId: 't1',
    playerId: 'p1',
    characterId: 'c1',
    sender: 'npc',
    body: '在忙？',
    imageAssetId: null,
    metadata: '{}',
    internal: '',
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

describe('QQ 桥 · 出站内容规则', () => {
  it('NPC 正文照发', () => {
    const r = buildOutbound(row());
    assert.deepEqual(r.sendable, [{ kind: 'text', content: '在忙？' }]);
  });

  it('玩家自己发的消息不外发', () => {
    const r = buildOutbound(row({ sender: 'player' }));
    assert.equal(r.sendable.length, 0);
    assert.equal(r.reason, 'not-npc');
  });

  it('心声（internal）绝不进入外发内容', () => {
    const r = buildOutbound(row({ body: '在忙？', internal: '她今天回得比平时慢，是不是在躲我。' }));
    assert.equal(r.sendable.length, 1);
    const sent = JSON.stringify(r.sendable);
    assert.ok(!sent.includes('是不是在躲我'), '心声被拼进了外发内容');
    assert.ok(!('internal' in (r.sendable[0] as object)), 'payload 里不该有 internal 字段');
  });

  it('图片消息外发成图片，正文为空不发空气泡', () => {
    const r = buildOutbound(row({ body: '', imageAssetId: 'asset-1' }));
    assert.deepEqual(r.sendable, [{ kind: 'image', assetId: 'asset-1' }]);
  });

  it('图文同时存在时先文字后图片', () => {
    const r = buildOutbound(row({ body: '给你看个东西', imageAssetId: 'asset-2' }));
    assert.deepEqual(r.sendable, [
      { kind: 'text', content: '给你看个东西' },
      { kind: 'image', assetId: 'asset-2' },
    ]);
  });

  it('图片还没生成完（pending 占位行）不外发，等下一轮', () => {
    const r = buildOutbound(row({ body: '', imageAssetId: null, metadata: '{"proactive":true,"pending":true}' }));
    assert.equal(r.sendable.length, 0);
    assert.equal(r.reason, 'pending-image');
  });

  it('真·空消息不外发', () => {
    const r = buildOutbound(row({ body: '   ' }));
    assert.equal(r.sendable.length, 0);
    assert.equal(r.reason, 'empty');
  });

  it('metadata 里出现约会邀请字段会被抓出来（邀请卡不能经 QQ 外发）', () => {
    const clean = [row()];
    assert.deepEqual(assertNoInviteLeak(clean), []);

    const dirty = [row({ msgId: 'bad', metadata: '{"invite":{"locationId":"loc1","locationName":"天台"}}' })];
    assert.deepEqual(assertNoInviteLeak(dirty), ['bad']);
  });

  it('metadata 坏 JSON 不影响出站', () => {
    const r = buildOutbound(row({ metadata: '{坏掉的 json' }));
    assert.deepEqual(r.sendable, [{ kind: 'text', content: '在忙？' }]);
  });
});
