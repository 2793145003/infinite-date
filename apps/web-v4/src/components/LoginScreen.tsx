/**
 * 登录页 —— 照搬 v3（AppV2）watercolor 主题的 Boot 登录页：
 * 浅蓝白底 + 淡紫 glow + ∞ logo + 邀请码/昵称双 stage
 */
import { useState } from 'react';
import { api, setToken as saveToken } from '../lib/api';
import type { PlayerInfo } from '../lib/api';

export const LoginScreen: React.FC<{
  onLogin: (token: string, player: PlayerInfo) => void;
}> = ({ onLogin }) => {
  const [stage, setStage] = useState<'code' | 'name'>('code');
  const [code, setCode] = useState(() => {
    try {
      return localStorage.getItem('idate_last_code') ?? '';
    } catch {
      return '';
    }
  });
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCode = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.login(code.trim());
      localStorage.setItem('idate_last_code', code.trim());
      saveToken(data.token);
      setToken(data.token);
      if (!data.player.name) {
        // 新用户或删档后，先输入昵称
        setStage('name');
      } else {
        onLogin(data.token, data.player);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleName = async () => {
    if (!name.trim()) return;
    setLoading(true);
    setError('');
    try {
      await api.updatePlayer({ name: name.trim() });
      const data = await api.me();
      onLogin(token, data.player);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-[220px] px-4 py-2.5 text-center bg-boot-cyan/10 border border-boot-border rounded-lg text-boot-text text-base font-mono outline-none focus:border-boot-cyan placeholder:text-boot-text-mute transition-colors';

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-8 text-center"
      style={{
        background:
          'radial-gradient(600px 400px at 50% 30%, var(--color-boot-glow), transparent 70%), var(--color-boot-bg)',
      }}
    >
      {/* logo */}
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-[3rem] leading-none text-boot-text animate-pulse">∞</span>
        <span className="text-[1.6rem] font-bold text-boot-text tracking-[0.15em]">无限心动</span>
        <span className="text-[0.7rem] text-boot-text-mute tracking-[0.3em] font-mono">INFINITE DATE</span>
      </div>

      <div key={stage} className="flex flex-col items-center">
        {stage === 'code' ? (
          <>
            <div className="text-boot-text-dim text-base mt-8">输入邀请码</div>
            <div className="text-boot-text-mute text-xs mb-4">来自主城的通行凭证</div>
            <input
              className={inputCls}
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCode()}
              placeholder="ID-XXXXXX"
              autoFocus
            />
            {error && <div className="text-boot-ember text-xs mt-2">{error}</div>}
            <button
              className="mt-4 px-7 py-2 bg-boot-cyan/15 border border-boot-cyan rounded-lg text-boot-cyan text-sm font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleCode}
              disabled={loading || !code.trim()}
            >
              {loading ? '验证中…' : '进入主城'}
            </button>
          </>
        ) : (
          <>
            <div className="text-boot-text-dim text-base mt-8">输入昵称</div>
            <div className="text-boot-text-mute text-xs mb-4">在主城里怎么称呼</div>
            <input
              className={inputCls}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleName()}
              placeholder="昵称"
              autoFocus
              maxLength={12}
            />
            {error && <div className="text-boot-ember text-xs mt-2">{error}</div>}
            <button
              className="mt-4 px-7 py-2 bg-boot-cyan/15 border border-boot-cyan rounded-lg text-boot-cyan text-sm font-semibold transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              onClick={handleName}
              disabled={loading || !name.trim()}
            >
              {loading ? '进入中…' : '开始'}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
