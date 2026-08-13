import { useState } from 'react';
import { api } from '../lib/api';
import type { PlayerInfo } from '../lib/api';

export function LoginScreen({ onLogin }: { onLogin: (token: string, player: PlayerInfo) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.login(code.trim());
      onLogin(data.token, data.player);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <h1>无限心动</h1>
      <p>输入邀请码进入主城</p>
      <input
        className="login-input"
        type="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        placeholder="ID-XXXXXX"
        autoFocus
      />
      {error && <span className="login-error">{error}</span>}
      <button className="login-btn" onClick={handleSubmit} disabled={loading || !code.trim()}>
        {loading ? '进入中…' : '进入'}
      </button>
    </div>
  );
}
