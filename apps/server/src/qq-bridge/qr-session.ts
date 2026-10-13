/**
 * 扫码绑定会话（进程内，生命周期只有几分钟）
 *
 * 官方 SDK 的 startQrConnect 是个「一直转」的循环：自己建任务、自己刷新过期二维码、
 * 自己轮询结果。这里把它包成一个可查询的会话：
 *   · 前端 POST /qq/bind/qr/start 拿到 sessionId + 第一张二维码图
 *   · 前端每 2 秒 GET /qq/bind/qr/:sessionId 拿最新二维码和状态
 *   · 扫码成功 → 直接回调落库（绑定完成，前端下一次轮询就变 bound）
 *
 * 会话只存在内存里：这是几分钟的临时流程，服务重启就重扫，没必要落库
 * （落库反而会留下永远停在 waiting 的僵尸行）。
 */
import crypto from 'node:crypto';

const QR_URL_TTL_MS = 4 * 60 * 1000; // 二维码 4 分钟后放弃（SDK 会自己刷新，这里兜底不无限转）

export interface QrBindCredential {
  appId: string;
  appSecret: string;
  userOpenid?: string;
}

export interface QrBindSession {
  sessionId: string;
  playerId: string;
  characterId: string;
  state: 'waiting' | 'bound' | 'failed';
  qrUrl: string;
  error: string | null;
  createdAt: number;
}

const sessions = new Map<string, QrBindSession>();
const stoppers = new Map<string, () => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export interface StartQrBindArgs {
  playerId: string;
  characterId: string;
  onBound(cred: QrBindCredential): void;
}

export async function startQrBindSession(args: StartQrBindArgs): Promise<QrBindSession> {
  const mod = await importQrConnector();

  const sessionId = crypto.randomUUID();
  const session: QrBindSession = {
    sessionId,
    playerId: args.playerId,
    characterId: args.characterId,
    state: 'waiting',
    qrUrl: '',
    error: null,
    createdAt: Date.now(),
  };
  sessions.set(sessionId, session);

  // SDK 建任务、刷新二维码都是异步的（onQrDisplayed 会在建完任务后才回调），
  // 所以这里等第一张二维码就绪再返回 —— 否则前端拿到的是个空图，得自己等一轮。
  let resolveQr: (() => void) | null = null;
  const qrReady = new Promise<void>((resolve) => {
    resolveQr = resolve;
  });

  const stop = mod.startQrConnect(
    {
      onSuccess(credentials: QrBindCredential[]) {
        const first = credentials[0];
        if (!first) {
          session.state = 'failed';
          session.error = '扫码成功但没拿到凭据';
          resolveQr?.();
          cleanup(sessionId);
          return;
        }
        try {
          args.onBound(first);
          session.state = 'bound';
        } catch (err) {
          session.state = 'failed';
          session.error = err instanceof Error ? err.message : String(err);
        }
        resolveQr?.();
        cleanup(sessionId);
      },
      onFailure(err: Error) {
        // 用户取消 / 网络问题
        session.state = 'failed';
        session.error = err.message || '扫码失败';
        resolveQr?.();
        cleanup(sessionId);
      },
      onQrDisplayed(url: string) {
        session.qrUrl = url;
        resolveQr?.();
      },
      onQrExpired() {
        // SDK 已经自己去刷新了，这里不用管 —— 下一次 GET 会拿到新二维码
      },
    },
    { displayQrCodeToConsole: false, source: 'idate' },
  );
  stoppers.set(sessionId, stop);

  // 最多等 12 秒（建任务要打腾讯的接口）
  await Promise.race([
    qrReady,
    new Promise<void>((resolve) => setTimeout(resolve, 12_000).unref?.()),
  ]);

  timers.set(
    sessionId,
    setTimeout(() => {
      if (sessions.get(sessionId)?.state === 'waiting') {
        session.state = 'failed';
        session.error = '二维码超时，请重新生成';
      }
      cleanup(sessionId);
    }, QR_URL_TTL_MS),
  );

  return session;
}

export function getQrBindSession(sessionId: string, playerId: string): QrBindSession | undefined {
  const s = sessions.get(sessionId);
  // 不许跨玩家查别人的会话
  if (!s || s.playerId !== playerId) return undefined;
  return s;
}

/** 只停轮询和定时器，会话本身留在 Map 里让前端能读到终态（下次 start 会生成新 id）*/
function cleanup(sessionId: string): void {
  const stop = stoppers.get(sessionId);
  if (stop) {
    try {
      stop();
    } catch {
      /* 已经停了无所谓 */
    }
    stoppers.delete(sessionId);
  }
  const t = timers.get(sessionId);
  if (t) {
    clearTimeout(t);
    timers.delete(sessionId);
  }
  // 终态会话保留 10 分钟后清掉，避免 Map 无限增长
  setTimeout(() => {
    if (sessions.get(sessionId)?.state !== 'waiting') sessions.delete(sessionId);
  }, 10 * 60 * 1000).unref?.();
}

// ── 官方 SDK 的惰性加载 ────────────────────────────────────
interface QrConnectorModule {
  startQrConnect(
    cb: {
      onSuccess(credentials: QrBindCredential[]): void;
      onFailure(err: Error): void;
      onQrDisplayed?(url: string): void;
      onQrExpired?(): void;
    },
    opts?: { displayQrCodeToConsole?: boolean; source?: string },
  ): () => void;
}

async function importQrConnector(): Promise<QrConnectorModule> {
  const spec = '@tencent-connect/qqbot-connector';
  try {
    return (await import(spec)) as unknown as QrConnectorModule;
  } catch {
    throw new Error('没装 @tencent-connect/qqbot-connector，扫码绑定不可用（可以改用手填 AppID / AppSecret）');
  }
}
