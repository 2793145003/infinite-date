import { useState } from 'react';
import { api, setToken as saveToken } from '../lib/api';
import type { PlayerInfo } from '../lib/api';

export function BootScreen({ onLogin }: { onLogin: (token: string, player: PlayerInfo) => void }) {
  const [stage, setStage] = useState<'code' | 'name'>('code');
  const [code, setCode] = useState(() => localStorage.getItem('idate_last_code') ?? '');
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

  return (
    <div className="id-boot">
      <div className="id-boot-logo">
        <span className="id-boot-icon">∞</span>
        <span className="id-boot-title">无限心动</span>
        <span className="id-boot-subtitle">INFINITE DATE</span>
      </div>

      <div key={stage} className="id-boot-stage">
      {stage === 'code' ? (
        <>
          <div className="id-boot-prompt">输入邀请码</div>
          <div className="id-boot-hint">来自主城的通行凭证</div>
          <input
            className="id-boot-input"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCode()}
            placeholder="ID-XXXXXX"
            autoFocus
          />
          {error && <div className="id-boot-error">{error}</div>}
          <button className="id-boot-btn" onClick={handleCode} disabled={loading || !code.trim()}>
            {loading ? '验证中…' : '进入主城'}
          </button>
        </>
      ) : (
        <>
          <div className="id-boot-prompt">输入昵称</div>
          <div className="id-boot-hint">在主城里怎么称呼</div>
          <input
            className="id-boot-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleName()}
            placeholder="昵称"
            autoFocus
            maxLength={12}
          />
          {error && <div className="id-boot-error">{error}</div>}
          <button className="id-boot-btn" onClick={handleName} disabled={loading || !name.trim()}>
            {loading ? '进入中…' : '开始'}
          </button>
        </>
      )}
      </div>
    </div>
  );
}
