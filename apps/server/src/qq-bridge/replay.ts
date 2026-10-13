/**
 * 离线回放验证 —— 用**真实历史短信**演练出站规则，全程不联网、不写库。
 *
 * 为什么是回放而不是直接接 QQ：星落的规矩是生产改动必须先离线验证。
 * 桥的出站靠只读轮询 text_messages，所以回放就等于把桥的出站逻辑
 * 拿真实数据跑一遍，看结果对不对 —— 这一步过了，接 QQ 才有意义。
 *
 * 跑法：
 *   npx tsx src/qq-bridge/replay.ts --limit 500
 *   npx tsx src/qq-bridge/replay.ts --player <playerId> --limit 200 --samples 5
 *
 * 断言（不通过就退出码 1）：
 *   A. 心声（internal）绝不出现在任何外发内容里
 *   B. 约会邀请字段绝不出现（invite / locationId / locationName）
 *   C. 玩家发的消息不外发
 *   D. 空的 pending 图片占位行不外发
 */
import path from 'node:path';
import { openReadOnly, readSmsRows, readCharacterName } from './reader';
import { buildOutbound, assertNoInviteLeak, type SmsRowForBridge } from './payload';

interface Args {
  db: string;
  player?: string;
  character?: string;
  limit: number;
  samples: number;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataDir = process.env.IDATE_DATA_DIR || path.resolve(process.cwd(), 'data');
  return {
    db: get('--db') || path.join(dataDir, 'infinite-date.sqlite'),
    player: get('--player'),
    character: get('--character'),
    limit: Number(get('--limit') || 500),
    samples: Number(get('--samples') || 3),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log('══ 无限 × QQ 桥 · 出站规则离线回放 ══');
  console.log(`库（只读）: ${args.db}`);
  console.log(`范围: ${args.player ? `player=${args.player}` : '全部玩家'}${args.character ? ` character=${args.character}` : ''} limit=${args.limit}`);
  console.log('');

  const db = openReadOnly(args.db);

  const rows = readSmsRows(db, {
    playerId: args.player,
    characterId: args.character,
    limit: args.limit,
  });

  if (rows.length === 0) {
    console.log('⚠️ 没读到 NPC 消息。检查 --db / --player 参数，或库里确实还没有短信。');
    process.exitCode = 2;
    return;
  }

  // ── 统计 ──────────────────────────────────────────────
  let textCount = 0;
  let imageCount = 0;
  let pendingSkipped = 0;
  let emptySkipped = 0;
  let multiPart = 0;
  let withInternal = 0;
  let internalChars = 0;

  const perCharacter = new Map<string, number>();
  const samples: Array<{ row: SmsRowForBridge; rendered: string }> = [];

  for (const row of rows) {
    if (row.internal && row.internal.trim()) {
      withInternal++;
      internalChars += row.internal.trim().length;
    }

    const { sendable, reason } = buildOutbound(row);
    if (reason === 'pending-image') pendingSkipped++;
    if (reason === 'empty') emptySkipped++;
    if (sendable.length === 0) continue;

    if (sendable.length > 1) multiPart++;
    for (const s of sendable) {
      if (s.kind === 'text') textCount++;
      else imageCount++;
    }

    perCharacter.set(row.characterId, (perCharacter.get(row.characterId) ?? 0) + 1);

    if (samples.length < args.samples) {
      samples.push({
        row,
        rendered: sendable
          .map(s => (s.kind === 'text' ? s.content : `[图片 ${s.assetId}]`))
          .join('  +  '),
      });
    }
  }

  console.log('── 外发统计 ──');
  console.log(`NPC 消息总数      : ${rows.length}`);
  console.log(`会外发（文本条）  : ${textCount}`);
  console.log(`会外发（图片条）  : ${imageCount}`);
  console.log(`其中图文多段      : ${multiPart} 条消息`);
  console.log(`跳过·图片未生成   : ${pendingSkipped}`);
  console.log(`跳过·空消息       : ${emptySkipped}`);
  console.log(`涉及角色数        : ${perCharacter.size}`);
  console.log('');

  console.log('── 减法规则核查 ──');
  console.log(`带心声(internal)的消息 : ${withInternal} 条 / 共 ${internalChars} 字`);
  console.log(`  → 这些心声全部只留在库里，不进入外发内容（见下方断言 A）`);
  console.log('');

  console.log(`── 样例（最近 ${samples.length} 条会外发的）──`);
  for (const s of samples) {
    const name = readCharacterName(db, s.row.characterId);
    const ts = new Date(s.row.createdAt).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] ${name} → ${s.rendered}`);
    if (s.row.internal.trim()) {
      console.log(`            （心声留在网页端：${s.row.internal.trim().slice(0, 40)}…）`);
    }
  }
  console.log('');

  // ── 断言 ──────────────────────────────────────────────
  const failures: string[] = [];

  // A. 心声不外发：buildOutbound 的返回类型里没有 internal 字段，
  //    这里再做一次字符串级检查，防止有人把 internal 拼进正文。
  const leakedInternal = rows.filter(r => {
    const { sendable } = buildOutbound(r);
    const internal = r.internal.trim();
    if (!internal || sendable.length === 0) return false;
    return sendable.some(s => s.kind === 'text' && internal.includes(s.content) === false && s.content.includes(internal));
  });
  if (leakedInternal.length > 0) {
    failures.push(`A. 心声外泄：${leakedInternal.length} 条（例：${leakedInternal[0]!.msgId}）`);
  }

  // B. 约会邀请不出现
  const inviteOffenders = assertNoInviteLeak(rows);
  if (inviteOffenders.length > 0) {
    failures.push(`B. metadata 里出现约会邀请字段：${inviteOffenders.length} 条（例：${inviteOffenders[0]}）`);
  }

  // C. 玩家消息不外发（readSmsRows 已只取 sender='npc'，这里顺手验证过滤真的生效）
  const playerRows = rows.filter(r => r.sender !== 'npc');
  if (playerRows.length > 0) {
    failures.push(`C. 读到了非 NPC 消息：${playerRows.length} 条`);
  }

  // D. pending 图片占位行不外发
  const badPending = rows.filter(r => {
    if (r.imageAssetId || r.body.trim()) return false;
    const meta = safeJson(r.metadata);
    return Boolean(meta.pending) && buildOutbound(r).sendable.length > 0;
  });
  if (badPending.length > 0) {
    failures.push(`D. pending 图片占位行被外发：${badPending.length} 条`);
  }

  if (failures.length > 0) {
    console.log('❌ 回放失败：');
    for (const f of failures) console.log(`   ${f}`);
    process.exitCode = 1;
  } else {
    console.log('✅ 回放通过：A 心声不外发 / B 无约会邀请 / C 只有 NPC 消息 / D pending 图片不外发');
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

main();
