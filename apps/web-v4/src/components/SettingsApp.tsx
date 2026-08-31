import { useState, useEffect, useRef } from 'react';
import type { PlayerInfo } from '../lib/api';
import { api, clearToken, imageUrl } from '../lib/api';
import { BackgroundPicker } from './BackgroundPicker';
import { ImageViewer } from './ImageViewer';
import { soundManager } from '../utils/audio';
import { THEMES, getTheme, setTheme, type ThemeId, FONT_SCALES, getFontScale, setFontScale, type FontScaleId, getFishToggle, setFishToggle, getCustomTheme, applyCustomTheme, DEFAULT_CUSTOM_THEME, type CustomTheme, HOME_BG_PRESETS, V3_WALLPAPERS, getHomeBg, setHomeBg, clearHomeBg, type HomeBg, getBgOverlay, setBgOverlay, DEFAULT_BG_OVERLAY, BG_OVERLAY_MAX } from '../lib/themes';

export function SettingsApp({
  player,
  onBack,
  onLogout,
  onUpdate,
  onNavigate,
  onToggleFish,
}: {
  player: PlayerInfo;
  onBack: () => void;
  onLogout: () => void;
  onUpdate: () => void;
  onNavigate?: (view: { type: 'feedback' | 'archived' | 'admin' | 'experimental' }) => void;
  onToggleFish: () => void;
}) {
  const [name, setName] = useState(player.name);
  const [gender, setGender] = useState(player.gender || 'female');
  const [appearance, setAppearance] = useState(player.appearance || '');
  const [savingName, setSavingName] = useState(false);
  // 头像
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [canGenerate, setCanGenerate] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  // 声音开关（v4 独有）
  const [isMuted, setIsMuted] = useState(soundManager.getMuted());
  const [theme, setThemeState] = useState<ThemeId>(getTheme());
  const [fontScale, setFontScaleState] = useState<FontScaleId>(getFontScale());
  const [fishToggle, setFishToggleState] = useState(getFishToggle());
  // 自定义皮肤
  const [custom, setCustom] = useState<CustomTheme>(getCustomTheme());
  const [showCustom, setShowCustom] = useState(getTheme() === 'custom');
  const [homeBg, setHomeBgState] = useState<HomeBg>(getHomeBg);
  const [bgOverlay, setBgOverlayState] = useState<number>(getBgOverlay);

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

  useEffect(() => {
    api.getImageGenEnabled().then(setCanGenerate);
  }, []);

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowAvatarMenu(false);
    setUploadingAvatar(true);
    try {
      const res = await api.uploadImage(file);
      await api.updatePlayer({ avatar: res.imagePath });
      await onUpdate();
      showMsg('头像已更新');
    } catch (err) {
      showMsg((err as Error).message);
    } finally {
      setUploadingAvatar(false);
      e.target.value = '';
    }
  };

  const handleGenerateAvatar = async () => {
    // 用输入框当前的外貌（本地 state），而非已保存的 player.appearance——
    // 否则用户刚填了外貌还没点「保存」就生成头像时，会 fallback 到「年轻男性/年轻女性」，
    // 丢掉发色瞳色等特征（如白发蓝眼 → 随机生成黑发）。
    const appearanceText = (appearance || '').trim();
    const prompt = appearanceText || (gender === 'male' ? '年轻男性' : '年轻女性');
    setShowAvatarMenu(false);
    setGeneratingAvatar(true);
    try {
      const res = await api.generateImage(prompt, { gender });
      setPendingAvatar(res.imagePath);
    } catch (err) {
      showMsg((err as Error).message);
    } finally {
      setGeneratingAvatar(false);
    }
  };

  const applyPendingAvatar = async () => {
    if (!pendingAvatar) return;
    try {
      await api.updatePlayer({ avatar: pendingAvatar });
      await onUpdate();
      setPendingAvatar(null);
      showMsg('头像已应用');
    } catch (err) {
      showMsg((err as Error).message);
    }
  };

  const handleToggleSound = () => {
    const next = !isMuted;
    setIsMuted(next);
    soundManager.setMuted(next);
    if (!next) {
      soundManager.playWaterRipple();
    }
  };

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
            {/* 头像 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem' }}>
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setShowAvatarMenu(v => !v)}
                  disabled={uploadingAvatar || generatingAvatar}
                  style={{ width: 56, height: 56, borderRadius: 12, cursor: 'pointer', background: 'var(--card-bg-hover)', border: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text)', overflow: 'hidden', padding: 0, fontFamily: 'inherit' }}
                >
                  {player.avatar ? (
                    <img src={imageUrl(player.avatar)} alt="头像" style={{ width: '100%', height: '100%', objectFit: 'cover' }} referrerPolicy="no-referrer" />
                  ) : (
                    <span style={{ fontSize: '1.35rem', lineHeight: 1, fontWeight: 600 }}>{uploadingAvatar || generatingAvatar ? '⏳' : (player.name?.[0] || '＋')}</span>
                  )}
                </button>
                {!player.avatar && !uploadingAvatar && !generatingAvatar && (
                  <span style={{ position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', color: '#1c1c1c', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', lineHeight: 1, fontWeight: 700, boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>＋</span>
                )}
                {showAvatarMenu && (
                  <div style={{ position: 'absolute', left: 0, top: '100%', marginTop: 4, zIndex: 20, background: 'var(--panel)', border: '1px solid var(--border-soft)', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.25)', padding: '4px 0', minWidth: 132 }}>
                    <button onClick={() => { setShowAvatarMenu(false); fileInputRef.current?.click(); }} style={{ display: 'block', width: '100%', padding: '0.45rem 0.7rem', textAlign: 'left', fontSize: '0.8rem', color: 'var(--text)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                      🖼 上传图片
                    </button>
                    {canGenerate && (
                      <button onClick={handleGenerateAvatar} style={{ display: 'block', width: '100%', padding: '0.45rem 0.7rem', textAlign: 'left', fontSize: '0.8rem', color: 'var(--text)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                        🎨 {generatingAvatar ? '生成中…' : '生成图片'}
                      </button>
                    )}
                    {player.avatar && (
                      <button onClick={() => { setShowAvatarMenu(false); setViewerSrc(player.avatar); }} style={{ display: 'block', width: '100%', padding: '0.45rem 0.7rem', textAlign: 'left', fontSize: '0.8rem', color: 'var(--text)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                        👁 查看图片
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div style={{ flex: 1, fontSize: '0.75rem', color: 'var(--text-mute)', lineHeight: 1.5 }}>
                上传或生成你的头像。没填外貌会按性别生成，留空用名字首字。
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarFile} style={{ display: 'none' }} />

            {(generatingAvatar || pendingAvatar) && (
              <div style={{ padding: '0.7rem', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--card-bg-alt)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>生成头像</span>
                  {pendingAvatar && (
                    <button onClick={() => setPendingAvatar(null)} style={{ width: 22, height: 22, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-mute)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }} aria-label="关闭">✕</button>
                  )}
                </div>
                {generatingAvatar ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem', padding: '1.2rem 0' }}>
                    <span style={{ fontSize: '1rem' }}>⏳</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>生成中…（约 10 秒）</span>
                  </div>
                ) : pendingAvatar ? (
                  <>
                    <img src={imageUrl(pendingAvatar)} alt="生成的头像" style={{ width: '100%', maxWidth: 220, margin: '0 auto', display: 'block', borderRadius: 10, border: '1px solid var(--border-soft)' }} referrerPolicy="no-referrer" />
                    <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginTop: '0.6rem' }}>
                      <button className="id-btn primary sm" onClick={applyPendingAvatar}>应用</button>
                      <button className="id-btn sm" onClick={handleGenerateAvatar} disabled={generatingAvatar}>重新生成</button>
                    </div>
                  </>
                ) : null}
              </div>
            )}

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

            {/* 自定义皮肤 */}
            <button
              onClick={() => setShowCustom(!showCustom)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.7rem',
                borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
                background: theme === 'custom' ? 'var(--card-bg-hover)' : 'transparent',
                border: theme === 'custom' ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                {[custom.base, custom.accent, custom.accent2].map((c, i) => (
                  <div key={i} style={{ width: 16, height: 16, borderRadius: '50%', background: c, border: '1px solid rgba(255,255,255,0.1)' }} />
                ))}
              </div>
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>自定义</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)' }}>自己挑颜色，只对你生效</div>
              </div>
              {theme === 'custom' && <span style={{ color: 'var(--accent)', fontSize: '0.9rem' }}>✓</span>}
            </button>

            {showCustom && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem', padding: '0.7rem', background: 'var(--card-bg-alt)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-soft)' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>背景主色</label>
                    <input type="color" value={custom.base} onChange={e => {
                      const next = { ...custom, base: e.target.value };
                      setCustom(next); applyCustomTheme(next); setThemeState('custom');
                    }} style={{ width: 34, height: 24, border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', padding: 0 }} />
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginTop: '0.15rem' }}>界面最底层的颜色</div>
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>强调色</label>
                    <input type="color" value={custom.accent} onChange={e => {
                      const next = { ...custom, accent: e.target.value };
                      setCustom(next); applyCustomTheme(next); setThemeState('custom');
                    }} style={{ width: 34, height: 24, border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', padding: 0 }} />
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginTop: '0.15rem' }}>你的气泡 + 高亮按钮</div>
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>次强调色</label>
                    <input type="color" value={custom.accent2} onChange={e => {
                      const next = { ...custom, accent2: e.target.value };
                      setCustom(next); applyCustomTheme(next); setThemeState('custom');
                    }} style={{ width: 34, height: 24, border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', padding: 0 }} />
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginTop: '0.15rem' }}>徽章、图标点缀</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>亮色模式</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginTop: '0.15rem' }}>浅底深字（适合浅色背景）</div>
                  </div>
                  <button
                    onClick={() => {
                      const next = { ...custom, isDark: !custom.isDark };
                      setCustom(next); applyCustomTheme(next); setThemeState('custom');
                    }}
                    style={{
                      flexShrink: 0, width: '44px', height: '26px', borderRadius: '13px',
                      background: !custom.isDark ? 'var(--accent)' : 'var(--border)',
                      border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', padding: 0,
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: '3px', left: !custom.isDark ? '21px' : '3px',
                      width: '20px', height: '20px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s', display: 'block',
                    }} />
                  </button>
                </div>
                <button
                  className="id-btn sm"
                  style={{ color: 'var(--text-mute)' }}
                  onClick={() => {
                    const next = { ...DEFAULT_CUSTOM_THEME };
                    setCustom(next); applyCustomTheme(next); setThemeState('custom');
                  }}
                >
                  恢复默认
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 主页背景 */}
        <div className="id-card">
          <div className="id-card-title">🖼️ 主页背景</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.4rem' }}>
            <button
              onClick={() => { clearHomeBg(); setHomeBgState({ type: 'none', value: '' }); }}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.7rem',
                borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
                background: homeBg.type === 'none' ? 'var(--card-bg-hover)' : 'transparent',
                border: homeBg.type === 'none' ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                transition: 'all 0.15s',
              }}
            >
              <div style={{ width: 40, height: 28, borderRadius: 6, flexShrink: 0, background: 'var(--phone-bg)', border: '1px solid var(--border-soft)' }} />
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>无</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)' }}>默认纯色光晕</div>
              </div>
              {homeBg.type === 'none' && <span style={{ color: 'var(--accent)', fontSize: '0.9rem' }}>✓</span>}
            </button>

            {/* v3：预设壁纸画廊（照抄心动终端：4 列 9/16 缩略图 + 选中蓝边勾选 + 底部名字） */}
            {onNavigate && (
              <div style={{ marginTop: '0.3rem' }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-dim)', marginBottom: '0.4rem' }}>官方预设精选壁纸</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                  {V3_WALLPAPERS.map(wp => {
                    const selected = homeBg.type === 'preset' && homeBg.value === wp.id;
                    return (
                      <div
                        key={wp.id}
                        onClick={() => { const bg: HomeBg = { type: 'preset', value: wp.id }; setHomeBg(bg); setHomeBgState(bg); }}
                        style={{
                          position: 'relative', borderRadius: '12px', overflow: 'hidden', cursor: 'pointer',
                          aspectRatio: '9 / 16',
                          border: selected ? '2px solid var(--accent)' : '2px solid #fff',
                          boxShadow: selected ? '0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent), 0 4px 12px color-mix(in srgb, var(--accent) 35%, transparent)' : '0 1px 4px rgba(0,0,0,0.08)',
                          transition: 'all 0.15s',
                        }}
                      >
                        <img src={wp.url} alt={wp.name} referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                        {selected && (
                          <div style={{ position: 'absolute', top: 4, right: 4, width: 16, height: 16, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.3)' }}>✓</div>
                        )}
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'linear-gradient(to top, rgba(15,23,42,0.8), transparent)', padding: '4px 2px' }}>
                          <span style={{ fontSize: '8.5px', color: '#fff', display: 'block', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{wp.name}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!onNavigate && HOME_BG_PRESETS.map(p => {
              const selected = homeBg.type === 'preset' && homeBg.value === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => { const bg: HomeBg = { type: 'preset', value: p.id }; setHomeBg(bg); setHomeBgState(bg); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.6rem 0.7rem',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'inherit',
                    background: selected ? 'var(--card-bg-hover)' : 'transparent',
                    border: selected ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ width: 40, height: 28, borderRadius: 6, flexShrink: 0, background: p.css, backgroundSize: 'cover', backgroundPosition: 'center', border: '1px solid var(--border-soft)' }} />
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>{p.name}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)' }}>{p.desc}</div>
                  </div>
                  {selected && <span style={{ color: 'var(--accent)', fontSize: '0.9rem' }}>✓</span>}
                </button>
              );
            })}

            <div style={{ padding: '0.6rem 0.7rem', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>自定义</div>
                {homeBg.type === 'upload' && <span style={{ color: 'var(--accent)', fontSize: '0.9rem' }}>✓</span>}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', margin: '0.15rem 0 0.4rem' }}>上传或生成自己的图作主页背景</div>
              <BackgroundPicker
                value={homeBg.type === 'upload' ? homeBg.value : undefined}
                onSelect={(imagePath) => { const bg: HomeBg = { type: 'upload', value: imagePath }; setHomeBg(bg); setHomeBgState(bg); }}
                onClear={() => { clearHomeBg(); setHomeBgState({ type: 'none', value: '' }); }}
                label="上传 / 生成背景"
                size={{ width: 768, height: 1344 }}
              />
            </div>

            {/* 背景蒙版透明度滑杆 */}
            <div style={{ padding: '0.6rem 0.7rem', border: '1px solid var(--border-soft)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>背景压暗</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>{Math.round(bgOverlay * 100)}%</span>
                  <button
                    onClick={() => { setBgOverlay(DEFAULT_BG_OVERLAY); setBgOverlayState(DEFAULT_BG_OVERLAY); }}
                    style={{ fontSize: '0.7rem', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
                  >重置</button>
                </div>
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', margin: '0.15rem 0 0.4rem' }}>越左背景图越透亮，越右越压暗（保证文字可读）</div>
              <input
                type="range"
                min={0}
                max={BG_OVERLAY_MAX}
                step={0.05}
                value={bgOverlay}
                onChange={e => { const v = parseFloat(e.target.value); setBgOverlay(v); setBgOverlayState(v); }}
                style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
              />
            </div>
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
                setFishToggleState(next);
                onToggleFish();
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
                配置你自己的 LLM API，用于你所有的 AI 生成（角色回复、旁白、记忆摘要、主动短信等）。支持任何 OpenAI 兼容接口。
              </p>
              <p style={{ fontSize: '0.78rem', color: 'var(--amber)' }}>
                ⚠️ 会有很多调用——每句对话、每条旁白、每次记忆整理都会请求一次。自配 key 请留意用量和费用；不配置则用服务器默认。
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

        {/* 更多功能（v3：反馈 / 旧版功能 / 管理 收进设置） */}
        {onNavigate && (
          <div className="id-card">
            <div className="id-card-title">📦 更多功能</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.4rem' }}>
              <button className="id-btn sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => onNavigate({ type: 'feedback' })}>
                💬 反馈
              </button>
              <button className="id-btn sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => onNavigate({ type: 'archived' })}>
                🗄️ 旧版功能
              </button>
              <button className="id-btn sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => onNavigate({ type: 'experimental' })}>
                🧪 实验功能
              </button>
              {player.is_admin && (
                <button className="id-btn sm" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => onNavigate({ type: 'admin' })}>
                  🛠 管理
                </button>
              )}
            </div>
          </div>
        )}

        {/* 关于 */}
        <div className="id-card" style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-mute)' }}>
          <div>无限心动 · INFINITE DATE</div>
          <div style={{ marginTop: '0.3rem' }}>无限流世界观驱动的恋爱模拟游戏</div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: 'var(--text-mute)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
            Player ID: {player.id}
          </div>
        </div>

        {/* 声音开关（v4 独有） */}
        <div className="id-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' }}>
          <div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text)' }}>🔊 触控音效与音乐盒</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-mute)', marginTop: '0.2rem' }}>水波涟漪、消息轻鸣与 Lover 旋律</div>
          </div>
          <button
            onClick={handleToggleSound}
            aria-label="声音开关"
            style={{
              width: '2.7rem', height: '1.45rem', borderRadius: '999px',
              border: '1px solid var(--border-bright)',
              background: isMuted ? 'var(--card-bg-hover)' : 'var(--accent)',
              position: 'relative', cursor: 'pointer', flexShrink: 0,
              transition: 'background 0.15s',
            }}
          >
            <span style={{
              position: 'absolute', top: '50%', transform: 'translateY(-50%)',
              left: isMuted ? '0.16rem' : 'calc(100% - 0.16rem - 1.1rem)',
              width: '1.1rem', height: '1.1rem', borderRadius: '999px',
              background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
              transition: 'left 0.15s',
            }} />
          </button>
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

      {viewerSrc && <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </div>
  );
}
