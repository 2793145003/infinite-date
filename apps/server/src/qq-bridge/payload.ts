/**
 * 出站内容生成（纯函数，无 IO）—— 桥的核心规则都集中在这里，方便离线回放验证。
 *
 * 三条硬规则（对应星落确认的三点）：
 *  ① 只连短信：只处理 text_messages / sender='npc'，别的渠道（约会、场景、朋友圈、邮件）不在此表。
 *  ② 不发约会邀请：约会邀请是短信接口 **HTTP 响应里的 invite 字段**，不是库里的行，
 *     所以从库里读消息的桥结构上就看不到它 —— 这里再用断言把它钉死（见 replay.ts）。
 *     注意：邀请卡不外发，但角色正文里自然说一句「想见你」属于正常台词，照发。
 *  ③ 心声不外发：internal（内心独白，网页端花权限解锁才能看）**不进入 payload 类型**，
 *     是类型层面的保证，不是「记得别拼进去」的运行时约定。
 */

/** text_messages 里桥需要读到的字段（只读，不含 internal —— 见下方说明）*/
export interface SmsRowForBridge {
  msgId: string;
  threadId: string;
  playerId: string;
  characterId: string;
  sender: string;
  body: string;
  imageAssetId: string | null;
  metadata: string;
  /** 仅用于审计/断言：确认 internal 存在但不会被外发 */
  internal: string;
  createdAt: number;
}

export type SkipReason =
  | 'not-npc'        // 玩家自己发的
  | 'empty'          // 空消息（无正文无图）
  | 'pending-image'; // 图片还没生成完（metadata.pending），下一轮会带上

export type Sendable =
  | { kind: 'text'; content: string }
  | { kind: 'image'; assetId: string };

export type OutboundResult = {
  /** 实际要发的内容，按顺序发。空数组 = 不发 */
  sendable: Sendable[];
  /** 不发的原因（仅用于日志/回放统计） */
  reason?: SkipReason;
};

/**
 * ⚠️ 这个类型里**没有** internal 字段。桥能外发的东西在类型层面就只能是正文和图片，
 * 别人想往里加「顺手把独白发出去」都过不了类型检查。
 */
export type OutboundPayload = Sendable;

export function buildOutbound(row: SmsRowForBridge): OutboundResult {
  if (row.sender !== 'npc') return { sendable: [], reason: 'not-npc' };

  const meta = safeParseMeta(row.metadata);
  const hasBody = row.body.trim().length > 0;
  const hasImage = Boolean(row.imageAssetId);

  if (!hasBody && !hasImage) {
    // 图片占位行：proactive 先插一行 body='' + image_asset_id=NULL + metadata.pending=true，
    // 等生成完再回填。这种情况下要等，不能当成空消息丢掉。
    if (meta.pending) return { sendable: [], reason: 'pending-image' };
    return { sendable: [], reason: 'empty' };
  }

  const out: Sendable[] = [];
  if (hasBody) out.push({ kind: 'text', content: row.body.trim() });
  if (hasImage) out.push({ kind: 'image', assetId: row.imageAssetId as string });
  return { sendable: out };
}

/** 一条消息会不会被外发（回放统计用） */
export function isSendable(row: SmsRowForBridge): boolean {
  return buildOutbound(row).sendable.length > 0;
}

function safeParseMeta(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 断言库里的消息不会夹带约会邀请。
 * 约会邀请（invite: {locationId, locationName}）目前只作为 HTTP 响应字段传给前端，
 * 若哪天有人把它写进 metadata，这里会失败 —— 因为那意味着它会经 QQ 外发。
 */
export function assertNoInviteLeak(rows: SmsRowForBridge[]): string[] {
  const offenders: string[] = [];
  for (const r of rows) {
    const meta = safeParseMeta(r.metadata);
    if ('invite' in meta || 'locationId' in meta || 'locationName' in meta) {
      offenders.push(r.msgId);
    }
  }
  return offenders;
}
