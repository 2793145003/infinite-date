import { useState, useEffect } from 'react';
import type { PlayerInfo } from '../lib/api';
import { api, clearToken } from '../lib/api';
import { THEMES, getTheme, setTheme, type ThemeId, FONT_SCALES, getFontScale, setFontScale, type FontScaleId, getFishToggle, setFishToggle } from '../lib/themes';

export function SettingsApp({
  player,
  onBack,
  onLogout,
  onUpdate,
}: {
  player: PlayerInfo;
  onBack: () => void;
  onLogout: () => void;
  onUpdate: () => void;
}) {
  const [name, setName] = useState(player.name);
  const [gender, setGender] = useState(player.gender || 'female');
  const [appearance, setAppearance] = useState(player.appearance || '');
  const [savingName, setSavingName] = useState(false);
  const [theme, setThemeState] = useState<ThemeId>(getTheme());
  const [fontScale, setFontScaleState] = useState<FontScaleId>(getFontScale());
  const [fishToggle, setFishToggleState] = useState(getFishToggle());

  // LLM配置
  const [llm, setLlm] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [apiKeySet, setApiKeySet] = useState(false);
  const [showLlm, setShowLlm] = useState(false);
  const [savingLlm, setSavingLlm] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api.getSettings().then(s => {
      setLlm({ baseUrl: s.baseUrl, apiKey: '', model: s.model });
      setApiKeySet(s.apiKeySet);
    }).catch(() => {});
  }, []);

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  const handleSaveName = async () => {
    if (!name.trim()) return;
    setSavingName(true);
    try {
      await api.updatePlayer({ name: name.trim(), gender, appearance: appearance.trim() });
      await onUpdate();
      showMsg('已保存');
    } catch (err) {
      showMsg((err as Error).message);
    } finally {
      setSavingName(false);
    }
  };

  const handleSaveLlm = async () => {
    setSavingLlm(true);
    try {
      const patch: { baseUrl?: string; apiKey?: string; model?: string } = {
        baseUrl: llm.baseUrl,
        model: llm.model,
      };
      if (llm.apiKey) patch.apiKey = llm.apiKey;
      const res = await api.updateSettings(patch);
      setApiKeySet(res.apiKeySet);
      setLlm(f => ({ ...f, apiKey: '' }));
      showMsg('LLM配置已保存');
    } catch {
      showMsg('保存失败');
    } finally {
      setSavingLlm(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await api.deleteAccount();
      clearToken();
      window.location.reload();
    } catch {
      showMsg('删除失败');
      setDeleting(false);
    }
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">⚙️ 设置</span>
      </div>
      <div className="id-app-scroll">
        {msg && (
          <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>
            {msg}
          </div>
        )}

        {/* 玩家信息 */}
        <div className="id-card">
          <div className="id-card-title">👤 玩家信息</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>名字</label>
              <input className="id-input" type="text" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>性别</label>
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.3rem' }}>
                {([['female', '女'], ['male', '男']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => setGender(val)}
                    style={{
                      flex: 1, padding: '0.45rem', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: '0.85rem',
                      background: gender === val ? 'var(--card-bg-hover)' : 'transparent',
                      border: gender === val ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                      color: 'var(--text)', transition: 'all 0.15s',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>外貌（可选）</label>
              <input className="id-input" type="text" placeholder="简单描述你的外貌特征" value={appearance} onChange={e => setAppearance(e.target.value)} />
            </div>
            <button className="id-btn primary sm" onClick={handleSaveName} disabled={savingName || !name.trim() || (name === player.name && gender === (player.gender || 'female') && appearance === (player.appearance || ''))}>
              {savingName ? '保存中…' : '保存'}
            </button>
          </div>
        </div>

        {/* 主题 */}
        <div className="id-card">
          <div className="id-card-title">🎨 配色主题</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.4rem' }}>
            {THEMES.map(t => (
              <button
                key={t.id}
                onClick={() => { setTheme(t.id); setThemeState(t.id); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.7rem',
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
                  background: theme === t.id ? 'var(--card-bg-hover)' : 'transparent',
                  border: theme === t.id ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                  {t.swatch.map((c, i) => (
                    <div key={i} style={{ width: 16, height: 16, borderRadius: '50%', background: c, border: '1px solid rgba(255,255,255,0.1)' }} />
                  ))}
                </div>
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>{t.name}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)' }}>{t.desc}</div>
                </div>
                {theme === t.id && <span style={{ color: 'var(--accent)', fontSize: '0.9rem' }}>✓</span>}
              </button>
            ))}
          </div>
        </div>

        {/* 字体大小 */}
        <div className="id-card">
          <div className="id-card-title">🔍 字体大小</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.4rem' }}>
            {FONT_SCALES.map(f => (
              <button
                key={f.id}
                onClick={() => { setFontScale(f.id); setFontScaleState(f.id); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.7rem',
                  borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
                  background: fontScale === f.id ? 'var(--card-bg-hover)' : 'transparent',
                  border: fontScale === f.id ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <span style={{ fontSize: `${0.85 * f.scale}rem`, fontWeight: 600, color: 'var(--text)' }}>{f.name}</span>
                  <span style={{ fontSize: `${0.72 * f.scale}rem`, color: 'var(--text-mute)', marginLeft: '0.5rem' }}>{f.desc}</span>
                </div>
                {fontScale === f.id && <span style={{ color: 'var(--accent)', fontSize: '0.9rem' }}>✓</span>}
              </button>
            ))}
          </div>
        </div>

        {/* 摸鱼开关 */}
        <div className="id-card">
          <div className="id-card-title">💼 工作模式</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem' }}>
            <div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text)' }}>显示「工作/灵感」开关</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginTop: '0.2rem' }}>
                工作模式伪装成AI助手界面，灵感模式为正常游戏
              </div>
            </div>
            <button
              onClick={() => {
                const next = !fishToggle;
                setFishToggle(next);
                setFishToggleState(next);
              }}
              style={{
                flexShrink: 0,
                width: '44px', height: '26px',
                borderRadius: '13px',
                background: fishToggle ? 'var(--accent)' : 'var(--border)',
                border: 'none',
                cursor: 'pointer',
                position: 'relative',
                transition: 'background 0.2s',
                padding: 0,
              }}
            >
              <span style={{
                position: 'absolute',
                top: '3px', left: fishToggle ? '21px' : '3px',
                width: '20px', height: '20px',
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.2s',
                display: 'block',
              }} />
            </button>
          </div>
        </div>

        {/* LLM 配置 */}
        <div className="id-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="id-card-title" style={{ marginBottom: 0 }}>🤖 AI 对话配置</span>
            <button className="id-btn sm" onClick={() => setShowLlm(!showLlm)}>
              {showLlm ? '收起' : '展开'}
            </button>
          </div>
          {showLlm && (
            <div style={{ marginTop: '0.8rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                配置 LLM API 用于角色自由对话回复。支持任何 OpenAI 兼容接口。
              </p>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>API Base URL</label>
                <input className="id-input" placeholder="https://api.openai.com/v1" value={llm.baseUrl} onChange={e => setLlm({ ...llm, baseUrl: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>
                  API Key {apiKeySet ? '（已配置，留空不修改）' : ''}
                </label>
                <input className="id-input" type="password" placeholder="sk-..." value={llm.apiKey} onChange={e => setLlm({ ...llm, apiKey: e.target.value })} />
              </div>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>模型名称</label>
                <input className="id-input" placeholder="gemma-4-26b / gpt-4o / ..." value={llm.model} onChange={e => setLlm({ ...llm, model: e.target.value })} />
              </div>
              <button className="id-btn primary sm" onClick={handleSaveLlm} disabled={savingLlm}>
                {savingLlm ? '保存中…' : '保存配置'}
              </button>
            </div>
          )}
        </div>

        {/* 关于 */}
        <div className="id-card" style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-mute)' }}>
          <div>无限心动 · INFINITE DATE</div>
          <div style={{ marginTop: '0.3rem' }}>无限流世界观驱动的恋爱模拟游戏</div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-mute)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
            Player ID: {player.id}
          </div>
        </div>

        {/* 退出 / 删除存档 */}
        <div className="id-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <button className="id-btn danger" onClick={onLogout} style={{ width: '100%' }}>退出登录</button>
          {confirmDelete ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--danger)', textAlign: 'center' }}>
                确定删除存档？所有数据不可恢复！
              </span>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button className="id-btn danger sm" style={{ flex: 1 }} onClick={handleDeleteAccount} disabled={deleting}>
                  {deleting ? '删除中…' : '确认删除'}
                </button>
                <button className="id-btn sm" style={{ flex: 1 }} onClick={() => setConfirmDelete(false)}>取消</button>
              </div>
            </div>
          ) : (
            <button className="id-btn sm" style={{ width: '100%', color: 'var(--text-mute)' }} onClick={() => setConfirmDelete(true)}>
              🗑 删除存档
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
