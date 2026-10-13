/**
 * 接入 QQ 弹窗
 *
 * 从角色卡片角落的二维码按钮打开。只做两件事：给二维码、给 AppID/Secret 输入框。
 * 其余是必须的引导 —— 玩家得先在 q.qq.com 创建一个 QQ 机器人，否则没东西可绑；
 * 绑完还得去机器人资料卡打开「主动消息」开关，否则男主只能回话、不能主动找她。
 */
import React from 'react';
import { X, QrCode, ExternalLink, Check, Unlink, AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import { request } from '../lib/api';

interface QqBindModalProps {
  characterId: string;
  characterName: string;
  characterAvatar?: string;
  onClose: () => void;
  /** 绑定状态变化（绑成/解绑）时通知外层刷新卡片状态 */
  onChanged: () => void;
}

interface BindingState {
  characterId: string;
  appId: string;
  status: string;
  proactiveEnabled: boolean;
  /** 只有被平台真拒过才为 true —— 没被拒就不该提示"去开开关" */
  proactiveBlocked: boolean;
  hasOpenid: boolean;
  lastError: string | null;
}

type Phase = 'loading' | 'unbound' | 'scanning' | 'bound' | 'manual';

const CREATE_BOT_URL = 'https://q.qq.com/qqbot/openclaw/login.html';

export const QqBindModal: React.FC<QqBindModalProps> = ({
  characterId,
  characterName,
  characterAvatar,
  onClose,
  onChanged,
}) => {
  const [phase, setPhase] = React.useState<Phase>('loading');
  const [binding, setBinding] = React.useState<BindingState | null>(null);
  const [sessionId, setSessionId] = React.useState('');
  const [qrDataUrl, setQrDataUrl] = React.useState('');
  const [error, setError] = React.useState('');
  const [manualAppId, setManualAppId] = React.useState('');
  const [manualSecret, setManualSecret] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // 载入当前绑定状态
  const loadBinding = React.useCallback(async () => {
    try {
      const r = await request<{ bindings: BindingState[] }>('/qq/bindings');
      const mine = r.bindings.find((b) => b.characterId === characterId) ?? null;
      setBinding(mine);
      setPhase(mine ? 'bound' : 'unbound');
    } catch (err: any) {
      setError(err?.message || '读不到绑定状态');
      setPhase('unbound');
    }
  }, [characterId]);

  React.useEffect(() => {
    void loadBinding();
  }, [loadBinding]);

  // 开扫码会话
  const startScan = React.useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const r = await request<{ sessionId: string; qrDataUrl: string; state: string }>('/qq/bind/qr/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId }),
      });
      setSessionId(r.sessionId);
      setQrDataUrl(r.qrDataUrl);
      setPhase('scanning');
    } catch (err: any) {
      setError(err?.message || '生成二维码失败');
    } finally {
      setBusy(false);
    }
  }, [characterId]);

  // 轮询扫码结果（二维码过期时 SDK 会换一张，这里跟着刷新）
  React.useEffect(() => {
    if (phase !== 'scanning' || !sessionId) return;
    const timer = setInterval(async () => {
      try {
        const r = await request<{ state: string; qrDataUrl: string; error: string | null }>(`/qq/bind/qr/${sessionId}`);
        if (r.qrDataUrl && r.qrDataUrl !== qrDataUrl) setQrDataUrl(r.qrDataUrl);
        if (r.state === 'bound') {
          clearInterval(timer);
          await loadBinding();
          onChanged();
        } else if (r.state === 'failed') {
          clearInterval(timer);
          setError(r.error || '扫码失败');
          setPhase('unbound');
        }
      } catch {
        /* 一次轮询失败不管，下一次接着来 */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, sessionId, qrDataUrl, loadBinding, onChanged]);

  const submitManual = async () => {
    setBusy(true);
    setError('');
    try {
      await request('/qq/bind/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId, appId: manualAppId.trim(), appSecret: manualSecret.trim() }),
      });
      setManualSecret('');
      await loadBinding();
      onChanged();
    } catch (err: any) {
      setError(err?.message || '绑定失败');
    } finally {
      setBusy(false);
    }
  };

  const doUnbind = async () => {
    if (!window.confirm(`断开【${characterName}】的 QQ 连接？断开后他就不再通过 QQ 找你了。`)) return;
    setBusy(true);
    try {
      await request(`/qq/bind/${characterId}`, { method: 'DELETE' });
      setManualAppId('');
      setManualSecret('');
      await loadBinding();
      onChanged();
    } catch (err: any) {
      setError(err?.message || '解绑失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="glass-panel w-full max-w-sm rounded-2xl p-4 shadow-xl frosted-glass border border-border max-h-[85vh] overflow-y-auto">
        {/* 标题 */}
        <div className="flex items-start justify-between mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {characterAvatar ? (
              <img src={characterAvatar} alt={characterName} className="w-7 h-7 rounded-lg object-cover border border-border shrink-0" referrerPolicy="no-referrer" />
            ) : null}
            <div className="min-w-0">
              <h3 className="text-xs font-bold text-ink flex items-center gap-1.5">
                <QrCode className="w-3.5 h-3.5" />
                <span>让 {characterName} 在 QQ 里找你</span>
              </h3>
              <p className="text-[10px] text-ink-faint mt-0.5">只接短信，不会发约会邀请</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-ink-soft hover:text-ink transition shrink-0" aria-label="关闭">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-1.5 mb-2.5 px-2.5 py-2 rounded-lg bg-bg-soft border border-border-strong">
            <AlertCircle className="w-3.5 h-3.5 text-ink shrink-0 mt-0.5" />
            <p className="text-[11px] text-ink leading-relaxed">{error}</p>
          </div>
        )}

        {/* ─── 已绑定 ─── */}
        {phase === 'bound' && binding && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-bg-soft border border-border-strong">
              <Check className="w-3.5 h-3.5 text-ink shrink-0" />
              <div className="min-w-0">
                <p className="text-[11px] text-ink font-medium">已接入 QQ</p>
                <p className="text-[10px] text-ink-faint font-mono truncate">AppID {binding.appId}</p>
              </div>
            </div>

            {binding.proactiveBlocked && (
              <div className="px-2.5 py-2 rounded-lg bg-bg-soft border border-border-strong">
                <p className="text-[11px] text-ink leading-relaxed">
                  <span className="font-medium">平台拒收了他主动发的消息。</span>
                  去 QQ 里打开这个机器人的资料卡，把「主动消息」推送开关打开再试。
                </p>
                {binding.lastError && (
                  <p className="mt-1 text-[10px] text-ink-faint leading-relaxed">{binding.lastError}</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <button
                onClick={doUnbind}
                disabled={busy}
                className="px-2.5 py-1 rounded-md border border-border-strong text-[11px] font-medium text-ink hover:text-rose transition flex items-center gap-1 disabled:opacity-50"
              >
                <Unlink className="w-3 h-3" />
                断开
              </button>
              <button onClick={onClose} className="px-3.5 py-1 rounded-md bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft">
                好
              </button>
            </div>
          </div>
        )}

        {/* ─── 扫码中 ─── */}
        {phase === 'scanning' && (
          <div className="space-y-2.5">
            {/* 二维码必须白底 —— 深色主题下扫不出来 */}
            <div className="bg-white rounded-xl p-3 flex items-center justify-center">
              {qrDataUrl ? (
                <img src={qrDataUrl} alt="QQ 扫码绑定" className="w-48 h-48 object-contain" />
              ) : (
                <div className="w-48 h-48 flex items-center justify-center">
                  <Loader2 className="w-5 h-5 animate-spin text-neutral-400" />
                </div>
              )}
            </div>
            <p className="text-[11px] text-ink text-center leading-relaxed">
              用手机 QQ 扫码，选择要绑给 <span className="font-medium">{characterName}</span> 的机器人
            </p>
            <p className="text-[10px] text-ink-faint text-center">二维码过期会自动换一张</p>

            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => setPhase('unbound')}
                className="px-2.5 py-1 rounded-md border border-border-strong text-[11px] font-medium text-ink"
              >
                返回
              </button>
              <button
                onClick={startScan}
                disabled={busy}
                className="px-2.5 py-1 rounded-md border border-border-strong text-[11px] font-medium text-ink flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw className="w-3 h-3" />
                换一张
              </button>
            </div>
          </div>
        )}

        {/* ─── 未绑定 / 手填 ─── */}
        {(phase === 'unbound' || phase === 'manual' || phase === 'loading') && (
          <div className="space-y-2.5">
            {phase === 'unbound' && (
              <>
                {/* 前置引导：先得有一个机器人 */}
                <div className="px-2.5 py-2 rounded-lg bg-bg-soft border border-border-strong">
                  <p className="text-[11px] text-ink leading-relaxed">
                    <span className="font-medium">还没有 QQ 机器人？</span>
                    先手机 QQ 扫码登录开放平台，点一次「创建机器人」就有了（个人最多 5 个）。
                    创建后记得进管理端把头像换成他的立绘 —— 官方接口改不了头像，只能手动传。
                  </p>
                  <a
                    href={CREATE_BOT_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink underline underline-offset-2"
                  >
                    去创建机器人
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>

                <button
                  onClick={startScan}
                  disabled={busy}
                  className="w-full px-3 py-2 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition flex items-center justify-center gap-1.5 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <QrCode className="w-3.5 h-3.5" />}
                  扫码绑定
                </button>

                <button
                  onClick={() => setPhase('manual')}
                  className="w-full text-[11px] text-ink-faint hover:text-ink transition text-center"
                >
                  已有 AppID / AppSecret，手动填
                </button>
              </>
            )}

            {phase === 'manual' && (
              <>
                <div>
                  <label className="text-[11px] text-ink-muted">AppID</label>
                  <input
                    value={manualAppId}
                    onChange={(e) => setManualAppId(e.target.value)}
                    placeholder="纯数字"
                    inputMode="numeric"
                    className="mt-1 w-full px-2.5 py-2 rounded-lg border border-border text-xs font-mono text-ink outline-none focus:border-border-dark"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-ink-muted">AppSecret</label>
                  <input
                    value={manualSecret}
                    onChange={(e) => setManualSecret(e.target.value)}
                    placeholder="开放平台里复制"
                    type="password"
                    className="mt-1 w-full px-2.5 py-2 rounded-lg border border-border text-xs font-mono text-ink outline-none focus:border-border-dark"
                  />
                  <p className="mt-1 text-[10px] text-ink-faint">只存在服务端加密保存，不会回传到页面。</p>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <button
                    onClick={() => setPhase('unbound')}
                    className="px-2.5 py-1 rounded-md border border-border-strong text-[11px] font-medium text-ink"
                  >
                    返回
                  </button>
                  <button
                    onClick={submitManual}
                    disabled={busy || !manualAppId.trim() || !manualSecret.trim()}
                    className="px-3.5 py-1 rounded-md bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft disabled:opacity-40"
                  >
                    绑定
                  </button>
                </div>
              </>
            )}

            {phase === 'loading' && (
              <div className="py-6 flex items-center justify-center">
                <Loader2 className="w-4 h-4 animate-spin text-ink-faint" />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
