/**
 * QQ 机器人官方 API 客户端（v2）
 *
 * 只依赖 Node 内置 fetch / WebSocket（Node 22+），零第三方依赖 —— 不想为了 PoC
 * 往 server 的 package.json 里塞东西。等接前端时再考虑换成官方 SDK。
 *
 * 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/
 *
 * 两种消息形态（频控差别很大，桥必须分清楚）：
 *  · 被动消息：回复玩家 5 分钟内的消息，要带 msg_id，同一个 msg_id 最多回 5 次
 *  · 主动消息：玩家必须在机器人资料卡手动打开「主动消息」开关才能收到
 *    （对应 C2C_MSG_RECEIVE 事件）；频控：未认证 30/qpm（bot 维度）、单关系 20/qpm
 */
import type { DatabaseSync } from 'node:sqlite';

const API_BASE = process.env.QQ_API_BASE || 'https://api.sgroup.qq.com';
const TOKEN_URL = process.env.QQ_TOKEN_URL || 'https://bots.qq.com/app/getAppAccessToken';

/** C2C 私聊消息事件（GROUP_AND_C2C_EVENT，intent 1<<25） */
export const INTENT_C2C = 1 << 25;

export interface QqCredentials {
  appId: string;
  appSecret: string;
}

/** 被动回复参数：seq 由调用方从库里推出来（必须跨重启连续），不在这里自增 */
export interface PassiveRef {
  msgId: string;
  seq: number;
}

export interface SendResult {
  ok: boolean;
  qqMsgId?: string;
  error?: string;
  /** true = 因为玩家没开「主动消息」开关被拒（需要引导玩家去开） */
  needProactive?: boolean;
}

// ────────────────────────────────────────────────────────────
// 接口：桥只依赖这个接口，所以离线时可以用 MockQQGateway 顶上
// ────────────────────────────────────────────────────────────
export interface QqGateway {
  /** 发文本（被动：传 passive；主动：不传） */
  sendText(openid: string, content: string, passive?: PassiveRef): Promise<SendResult>;
  /** 发图片（读 image_blobs 的二进制上传再发） */
  sendImage(openid: string, assetId: string, db: DatabaseSync, passive?: PassiveRef): Promise<SendResult>;
}

// ────────────────────────────────────────────────────────────
// AccessToken 缓存：一个 bot 一个 token，提前 60s 过期
// ────────────────────────────────────────────────────────────
interface TokenCache {
  token: string;
  exp: number;
}
const tokenCache = new Map<string, TokenCache>();

export async function getAccessToken(cred: QqCredentials): Promise<string> {
  const cached = tokenCache.get(cred.appId);
  if (cached && cached.exp > Date.now()) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: cred.appId, clientSecret: cred.appSecret }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: string | number; code?: number; message?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`获取 access_token 失败: ${data.message ?? res.status}`);
  }
  const ttl = (typeof data.expires_in === 'string' ? parseInt(data.expires_in, 10) : data.expires_in ?? 7200) * 1000;
  tokenCache.set(cred.appId, { token: data.access_token, exp: Date.now() + ttl - 60_000 });
  return data.access_token;
}

/** 令牌失效（玩家重置了 AppSecret）时清缓存，下次调用会重新取 */
export function invalidateToken(appId: string): void {
  tokenCache.delete(appId);
}

/** 被动回复参数：带上 msg_id + 递增 msg_seq；主动消息则两者都不带 */
function passiveFields(passive?: PassiveRef): Record<string, unknown> {
  if (!passive) return {};
  return { msg_id: passive.msgId, msg_seq: passive.seq };
}

// ────────────────────────────────────────────────────────────
// 真实实现
// ────────────────────────────────────────────────────────────
export class RealQqGateway implements QqGateway {
  constructor(private cred: QqCredentials) {}

  private async auth(): Promise<Record<string, string>> {
    const token = await getAccessToken(this.cred);
    return { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' };
  }

  async sendText(openid: string, content: string, passive?: PassiveRef): Promise<SendResult> {
    const body: Record<string, unknown> = { content, msg_type: 0, ...passiveFields(passive) };
    return this.post(`/v2/users/${openid}/messages`, body);
  }

  async sendImage(openid: string, assetId: string, db: DatabaseSync, passive?: PassiveRef): Promise<SendResult> {
    // 1) 从 image_blobs 读二进制（无限把图片存在库里，不是文件系统）
    const blob = db.prepare('SELECT data, mimetype FROM image_blobs WHERE id = ?').get(assetId) as
      | { data: Uint8Array; mimetype: string }
      | undefined;
    if (!blob) return { ok: false, error: `image_blobs 里没有 ${assetId}` };

    // 2) 上传富媒体换 file_info
    const up = await this.post(`/v2/users/${openid}/files`, {
      file_type: 1, // 1=图片
      url: '',
      srv_send_msg: false,
      file_data: Buffer.from(blob.data).toString('base64'),
    });
    if (!up.ok || !up.raw?.file_info) return { ok: false, error: up.error ?? '上传图片失败' };

    // 3) 用 file_info 发图
    const body: Record<string, unknown> = {
      content: '',
      msg_type: 7,
      media: { file_info: up.raw.file_info },
      ...passiveFields(passive),
    };
    return this.post(`/v2/users/${openid}/messages`, body);
  }

  private async post(pathname: string, body: Record<string, unknown>): Promise<SendResult & { raw?: Record<string, any> }> {
    let headers: Record<string, string>;
    try {
      headers = await this.auth();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const res = await fetch(`${API_BASE}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: Record<string, any> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, any>) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const msg = String(data.message ?? data.err_msg ?? text).slice(0, 300);
      // 401/403 多为凭证失效；主动消息被拒时会明确提到主动消息
      if (res.status === 401 || res.status === 403) invalidateToken(this.cred.appId);
      const needProactive = /主动|proactive/i.test(msg);
      return { ok: false, error: `${res.status} ${msg}`, needProactive, raw: data };
    }
    return { ok: true, qqMsgId: data.id as string | undefined, raw: data };
  }
}

// ────────────────────────────────────────────────────────────
// 离线用的假实现 —— 不发网络请求，把要发的东西打到 stdout
// ────────────────────────────────────────────────────────────
export class MockQqGateway implements QqGateway {
  readonly sent: Array<{ openid: string; kind: 'text' | 'image'; content: string; replyTo?: string }> = [];

  async sendText(openid: string, content: string, passive?: PassiveRef): Promise<SendResult> {
    this.sent.push({ openid, kind: 'text', content, replyTo: passive ? `${passive.msgId}#${passive.seq}` : undefined });
    console.log(`  [mock] → ${openid}: ${content}`);
    return { ok: true, qqMsgId: `mock-${this.sent.length}` };
  }

  async sendImage(openid: string, assetId: string, _db: DatabaseSync, passive?: PassiveRef): Promise<SendResult> {
    this.sent.push({ openid, kind: 'image', content: assetId, replyTo: passive ? `${passive.msgId}#${passive.seq}` : undefined });
    console.log(`  [mock] → ${openid}: [图片 ${assetId}]`);
    return { ok: true, qqMsgId: `mock-${this.sent.length}` };
  }
}

// ────────────────────────────────────────────────────────────
// WebSocket 网关：收 C2C 私聊消息
// ────────────────────────────────────────────────────────────
export interface InboundEvent {
  appId: string;
  /** 玩家在这个 bot 下的 openid */
  userOpenid: string;
  content: string;
  /** 官方消息 id —— 拿来做被动回复 + 去重 */
  msgId: string;
  msgSeq?: number;
  /** 玩家在资料卡开了「主动消息」开关 */
  proactiveOpened?: boolean;
  proactiveClosed?: boolean;
}

export interface GatewayCallbacks {
  onEvent(evt: InboundEvent): void | Promise<void>;
  onError?(appId: string, err: Error): void;
  /** 链路层的可见性日志（hello / identify / READY / 事件类型）——排查"消息到底有没有到桥"全靠它 */
  onLog?(appId: string, msg: string): void;
}

/** 用 Node 内置 WebSocket 连官方网关（Node 22+，零依赖）*/
export class QqWebSocketClient {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(
    private cred: QqCredentials,
    private cb: GatewayCallbacks,
  ) {}

  async connect(): Promise<void> {
    const token = await getAccessToken(this.cred);
    const res = await fetch(`${API_BASE}/gateway`, { headers: { Authorization: `QQBot ${token}` } });
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error('拿不到网关地址');

    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WS) throw new Error('当前 Node 没有全局 WebSocket（需要 Node 22+）');

    this.ws = new WS(data.url);
    this.ws.addEventListener('message', (e: MessageEvent) => this.onMessage(String(e.data), token));
    this.ws.addEventListener('error', () => this.cb.onError?.(this.cred.appId, new Error('WebSocket error')));
    this.ws.addEventListener('close', (e: { code?: number; reason?: string }) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.cb.onLog?.(this.cred.appId, `网关连接关闭（code=${e.code}${e.reason ? ` reason=${e.reason}` : ''}）`);
      if (!this.closed) {
        // 断线 5s 后重连（凭证失效时重连也会失败，由上层标记 invalid）
        setTimeout(() => void this.connect().catch(err => this.cb.onError?.(this.cred.appId, err as Error)), 5000);
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  private onMessage(raw: string, token: string): void {
    let pkt: { op: number; d: any; s?: number; t?: string };
    try {
      pkt = JSON.parse(raw) as { op: number; d: any; s?: number; t?: string };
    } catch {
      return;
    }
    if (typeof pkt.s === 'number') this.seq = pkt.s;

    // op 10 = hello：拿心跳间隔、发 identify
    if (pkt.op === 10) {
      const interval = (pkt.d?.heartbeat_interval as number) ?? 30000;
      this.cb.onLog?.(this.cred.appId, `收到 hello（心跳 ${interval}ms），发送 identify（intents=${INTENT_C2C}）`);
      this.heartbeat = setInterval(() => {
        this.ws?.send(JSON.stringify({ op: 1, d: this.seq }));
      }, interval);
      this.ws?.send(
        JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: INTENT_C2C,
            shard: [0, 1],
            // 官方 identify 要求带 properties；之前漏了，网关可能直接拒握手而不报错
            properties: { $os: 'linux', $browser: 'idate-qq-bridge', $device: 'idate-qq-bridge' },
          },
        }),
      );
      return;
    }

    // op 9 = 无效会话（token / intents 不对），op 7 = 要求重连
    if (pkt.op === 9 || pkt.op === 7) {
      this.cb.onLog?.(this.cred.appId, `⚠️ 网关返回 op=${pkt.op}（${pkt.op === 9 ? '会话无效，多半是 token 或 intents 不对' : '要求重连'}）`);
      this.ws?.close();
      return;
    }

    // op 11 = 心跳回执；op 0 = 事件
    if (pkt.op !== 0) return;

    // ⚠️ 事件名在**顶层** t，不在 d 里。
    // 这里曾经写成 pkt.d?.t，于是永远 undefined —— 所有事件（含 READY 和玩家私聊）
    // 都被静默丢掉，表现为「消息确实到了桥，但桥一声不吭」。
    const t = pkt.t;
    const d = pkt.d ?? {};

    // 握手成功的真正证据：收到 READY
    if (t === 'READY') {
      this.cb.onLog?.(this.cred.appId, `✅ 网关握手成功（READY，session=${String(d.session_id ?? '').slice(0, 8)}…）`);
      return;
    }

    // 其它事件类型都记一笔 —— 排查"消息到底有没有送到桥"时，这行是唯一线索
    if (t && t !== 'C2C_MESSAGE_CREATE') {
      this.cb.onLog?.(this.cred.appId, `收到事件 ${t}`);
    }

    if (t === 'C2C_MESSAGE_CREATE') {
      const content = String(d.content ?? '').trim();
      this.cb.onLog?.(
        this.cred.appId,
        `📩 收到私聊消息 openid=${String(d.author?.user_openid ?? '').slice(0, 12)}… 内容="${content.slice(0, 30)}"`,
      );
      void this.cb.onEvent({
        appId: this.cred.appId,
        userOpenid: String(d.author?.user_openid ?? ''),
        content,
        msgId: String(d.id ?? ''),
        msgSeq: undefined,
      });
    } else if (t === 'C2C_MSG_RECEIVE') {
      void this.cb.onEvent({
        appId: this.cred.appId,
        userOpenid: String(d.openid ?? ''),
        content: '',
        msgId: '',
        proactiveOpened: true,
      });
    } else if (t === 'C2C_MSG_REJECT') {
      void this.cb.onEvent({
        appId: this.cred.appId,
        userOpenid: String(d.openid ?? ''),
        content: '',
        msgId: '',
        proactiveClosed: true,
      });
    }
  }
}
