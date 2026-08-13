/**
 * 个人空间 — 普通用户管理APP
 *
 * 两个Tab：
 * - 人设：列出所有相关角色，可编辑角色卡(fork)、重置fork
 * - 记忆：列出各角色记忆条数，可清除单角色记忆或全部记忆
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../lib/api';
import { CharacterEditModal } from '../components/CharacterEditModal';

type MyTab = 'persona' | 'memory';

interface MyCharacterEntry {
  characterId: string;
  name: string;
  hasFork: boolean;
  forkUpdatedAt: number | null;
  factCount: number;
  chronicleCount: number;
  isFriend: boolean;
}

export function MySpaceApp({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<MyTab>('persona');

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">🏠 我的空间</span>
      </div>
      <div style={{ display: 'flex', gap: '0.3rem', padding: '0.5rem 0.6rem 0' }}>
        <button
          className={`id-btn sm ${tab === 'persona' ? 'primary' : ''}`}
          style={{ flex: 1 }}
          onClick={() => setTab('persona')}
        >人设</button>
        <button
          className={`id-btn sm ${tab === 'memory' ? 'primary' : ''}`}
          style={{ flex: 1 }}
          onClick={() => setTab('memory')}
        >记忆</button>
      </div>
      <div className="id-app-scroll" style={{ paddingTop: '0.4rem' }}>
        {tab === 'persona' ? <PersonaPanel /> : <MemoryPanel />}
      </div>
    </div>
  );
}

// ─── 人设管理面板 ─────────────────────────────────────────────

function PersonaPanel() {
  const [characters, setCharacters] = useState<MyCharacterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [confirmReset, setConfirmReset] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getMyCharacters();
      setCharacters(data.characters);
    } catch {
      setMsg('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const handleResetFork = async (characterId: string) => {
    try {
      await api.resetCharacterFork(characterId);
      showMsg('已恢复原版');
      setConfirmReset(null);
      await load();
    } catch {
      showMsg('操作失败');
    }
  };

  if (editingId) {
    return (
      <>
        <CharacterEditModal
          characterId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => { load(); }}
        />
      </>
    );
  }

  return (
    <>
      {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>{msg}</div>}

      <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', padding: '0 0.5rem', marginBottom: '0.5rem' }}>
        编辑角色卡会创建你的个人副本，不影响其他玩家。有副本时可以恢复原版。
      </div>

      {loading ? (
        <div className="id-loading">加载中…</div>
      ) : characters.length === 0 ? (
        <div className="id-empty"><span>🍃</span><span>还没有互动过的角色</span></div>
      ) : (
        characters.map(c => (
          <div key={c.characterId} className="id-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{c.name}</span>
                  {c.isFriend && <span style={{ fontSize: '0.65rem', color: 'var(--cyan)', border: '1px solid var(--cyan)', borderRadius: '3px', padding: '0 0.2rem' }}>好友</span>}
                  {c.hasFork && <span style={{ fontSize: '0.65rem', color: 'var(--ember)', border: '1px solid var(--ember)', borderRadius: '3px', padding: '0 0.2rem' }}>已编辑</span>}
                </div>
                {c.hasFork && c.forkUpdatedAt && (
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-mute)', marginTop: '0.2rem' }}>
                    上次编辑：{new Date(c.forkUpdatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
              <button className="id-btn sm primary" style={{ flex: 1 }} onClick={() => setEditingId(c.characterId)}>
                ✏️ {c.hasFork ? '编辑副本' : '编辑人设'}
              </button>
              {c.hasFork && (
                confirmReset === c.characterId ? (
                  <div style={{ display: 'flex', gap: '0.3rem' }}>
                    <button className="id-btn danger sm" onClick={() => handleResetFork(c.characterId)}>确认</button>
                    <button className="id-btn sm" onClick={() => setConfirmReset(null)}>取消</button>
                  </div>
                ) : (
                  <button className="id-btn sm" style={{ color: 'var(--text-mute)' }} onClick={() => setConfirmReset(c.characterId)}>恢复原版</button>
                )
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
}

// ─── 记忆管理面板 ─────────────────────────────────────────────

function MemoryPanel() {
  const [characters, setCharacters] = useState<MyCharacterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [confirmClearChar, setConfirmClearChar] = useState<string | null>(null);
  const [confirmDeleteFriend, setConfirmDeleteFriend] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getMyCharacters();
      setCharacters(data.characters);
    } catch {
      setMsg('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const handleClearCharMemory = async (characterId: string) => {
    setBusy(true);
    try {
      await api.clearCharacterMemory(characterId);
      showMsg('已清除该角色记忆');
      setConfirmClearChar(null);
      await load();
    } catch {
      showMsg('操作失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteFriend = async (characterId: string) => {
    setBusy(true);
    try {
      await api.deleteFriend(characterId);
      showMsg('已删除好友');
      setConfirmDeleteFriend(null);
      await load();
    } catch {
      showMsg('操作失败');
    } finally {
      setBusy(false);
    }
  };

  const handleClearAllMemory = async () => {
    setBusy(true);
    try {
      await api.clearAllMemory();
      showMsg('已清除所有记忆');
      setConfirmClearAll(false);
      await load();
    } catch {
      showMsg('操作失败');
    } finally {
      setBusy(false);
    }
  };

  const totalFacts = characters.reduce((sum, c) => sum + c.factCount, 0);
  const totalChronicles = characters.reduce((sum, c) => sum + c.chronicleCount, 0);
  const friendCount = characters.filter(c => c.isFriend).length;

  return (
    <>
      {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>{msg}</div>}

      <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', padding: '0 0.5rem', marginBottom: '0.5rem' }}>
        清除记忆：删除角色对你的印象和互动摘要，不影响好友和聊天记录。<br/>
        删除好友：彻底抹除与该角色的一切痕迹，就当没认识过。
      </div>

      {/* 总览 + 全部清除 */}
      <div className="id-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-mute)' }}>记忆总览</div>
          <div style={{ fontSize: '0.85rem', marginTop: '0.2rem' }}>
            {totalFacts} 条印象 · {totalChronicles} 条摘要 · {friendCount} 位好友
          </div>
        </div>
        {totalFacts + totalChronicles > 0 && (
          confirmClearAll ? (
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              <button className="id-btn danger sm" onClick={handleClearAllMemory} disabled={busy}>确认清除</button>
              <button className="id-btn sm" onClick={() => setConfirmClearAll(false)}>取消</button>
            </div>
          ) : (
            <button className="id-btn sm" style={{ color: 'var(--danger)' }} onClick={() => setConfirmClearAll(true)}>全部清除</button>
          )
        )}
      </div>

      {loading ? (
        <div className="id-loading">加载中…</div>
      ) : characters.filter(c => c.factCount > 0 || c.chronicleCount > 0 || c.isFriend).length === 0 ? (
        <div className="id-empty"><span>🍃</span><span>还没有记忆数据</span></div>
      ) : (
        characters
          .filter(c => c.factCount > 0 || c.chronicleCount > 0 || c.isFriend)
          .map(c => {
            const hasMemory = c.factCount > 0 || c.chronicleCount > 0;
            return (
              <div key={c.characterId} className="id-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{c.name}</span>
                      {c.isFriend && <span style={{ fontSize: '0.65rem', color: 'var(--cyan)', border: '1px solid var(--cyan)', borderRadius: '3px', padding: '0 0.2rem' }}>好友</span>}
                    </div>
                    {hasMemory && (
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', marginTop: '0.2rem' }}>
                        {c.factCount > 0 && `${c.factCount} 条印象`}
                        {c.factCount > 0 && c.chronicleCount > 0 && ' · '}
                        {c.chronicleCount > 0 && `${c.chronicleCount} 条摘要`}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
                  {hasMemory && (
                    confirmClearChar === c.characterId ? (
                      <div style={{ display: 'flex', gap: '0.3rem' }}>
                        <button className="id-btn danger sm" onClick={() => handleClearCharMemory(c.characterId)} disabled={busy}>确认清除</button>
                        <button className="id-btn sm" onClick={() => setConfirmClearChar(null)}>取消</button>
                      </div>
                    ) : (
                      <button className="id-btn sm" style={{ flex: 1, color: 'var(--text-mute)' }} onClick={() => setConfirmClearChar(c.characterId)} disabled={busy}>清除记忆</button>
                    )
                  )}
                  {c.isFriend && (
                    confirmDeleteFriend === c.characterId ? (
                      <div style={{ display: 'flex', gap: '0.3rem', flex: hasMemory ? undefined : 1 }}>
                        <button className="id-btn danger sm" onClick={() => handleDeleteFriend(c.characterId)} disabled={busy}>确认删除</button>
                        <button className="id-btn sm" onClick={() => setConfirmDeleteFriend(null)}>取消</button>
                      </div>
                    ) : (
                      <button className="id-btn sm" style={{ flex: hasMemory ? undefined : 1, color: 'var(--danger)' }} onClick={() => setConfirmDeleteFriend(c.characterId)} disabled={busy}>删除好友</button>
                    )
                  )}
                </div>
              </div>
            );
          })
      )}
    </>
  );
}
