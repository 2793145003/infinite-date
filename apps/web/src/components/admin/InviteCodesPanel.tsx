import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import type { InviteCodeEntry } from './types';

export function InviteCodesPanel() {
  const [codes, setCodes] = useState<InviteCodeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [newPerm, setNewPerm] = useState('');
  const [creating, setCreating] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.adminListInviteCodes();
      setCodes(data.codes);
    } catch {
      setMsg('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const perm = newPerm.trim() ? parseInt(newPerm.trim(), 10) : undefined;
      if (perm !== undefined && (isNaN(perm) || perm < 0)) {
        showMsg('权限数量必须是非负整数');
        setCreating(false);
        return;
      }
      const data = await api.adminCreateInviteCode(perm);
      setCreatedCode(data.code);
      setNewPerm('');
      await load();
    } catch {
      showMsg('创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (code: string) => {
    try {
      await api.adminRevokeInviteCode(code);
      showMsg('已吊销');
      setConfirmRevoke(null);
      await load();
    } catch (e) {
      const err = e as Error & { body?: { error?: string } };
      showMsg(err.body?.error || '吊销失败');
    }
  };

  const handleDelete = async (code: string) => {
    try {
      await api.adminDeleteInviteCode(code);
      showMsg('已删除');
      setConfirmDelete(null);
      await load();
    } catch (e) {
      const err = e as Error & { body?: { error?: string } };
      showMsg(err.body?.error || '删除失败');
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard?.writeText(code).then(() => showMsg('已复制')).catch(() => {});
  };

  const formatLoginTime = (ts: number | null): string => {
    if (!ts) return '从未登录';
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - ts;
    const oneDay = 86400000;
    if (diff < oneDay && d.getDate() === now.getDate()) {
      return `今天 ${d.toLocaleTimeString('zh-CN', { hour: 'numeric', minute: '2-digit' })}`;
    }
    if (diff < oneDay * 2) return `昨天 ${d.toLocaleTimeString('zh-CN', { hour: 'numeric', minute: '2-digit' })}`;
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const activeCodes = codes.filter(c => c.active);
  const revokedCodes = codes.filter(c => !c.active);

  const renderCodeCard = (c: InviteCodeEntry) => (
    <div key={c.code} className="id-card" style={{ opacity: c.active ? 1 : 0.5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{c.playerName || '(未命名)'}</span>
            {c.isAdmin && <span style={{ fontSize: '0.65rem', color: 'var(--ember)', border: '1px solid var(--ember)', borderRadius: '3px', padding: '0 0.2rem' }}>管理员</span>}
            {!c.active && <span style={{ fontSize: '0.65rem', color: 'var(--text-mute)', border: '1px solid var(--text-mute)', borderRadius: '3px', padding: '0 0.2rem' }}>已吊销</span>}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', marginTop: '0.2rem', color: 'var(--cyan)', cursor: 'pointer' }}
               onClick={() => copyCode(c.code)}>
            {c.code} 📋
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-mute)', marginTop: '0.2rem' }}>
            权限: {c.permissionBalance} · 创建于 {new Date(c.createdAt).toLocaleDateString('zh-CN')}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-mute)', marginTop: '0.1rem' }}>
            最后登录: <span style={{ color: c.lastLoginAt ? 'var(--text-dim)' : 'var(--text-mute)' }}>{formatLoginTime(c.lastLoginAt)}</span>
          </div>
        </div>
        <div>
          {c.active && !c.isAdmin && (
            confirmRevoke === c.code ? (
              <div style={{ display: 'flex', gap: '0.3rem' }}>
                <button className="id-btn danger sm" onClick={() => handleRevoke(c.code)}>确认</button>
                <button className="id-btn sm" onClick={() => setConfirmRevoke(null)}>取消</button>
              </div>
            ) : (
              <button className="id-btn sm" style={{ color: 'var(--text-mute)' }} onClick={() => setConfirmRevoke(c.code)}>吊销</button>
            )
          )}
          {!c.active && (
            confirmDelete === c.code ? (
              <div style={{ display: 'flex', gap: '0.3rem' }}>
                <button className="id-btn danger sm" onClick={() => handleDelete(c.code)}>删除</button>
                <button className="id-btn sm" onClick={() => setConfirmDelete(null)}>取消</button>
              </div>
            ) : (
              <button className="id-btn danger sm" onClick={() => setConfirmDelete(c.code)}>删除</button>
            )
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>{msg}</div>}

      {/* 创建新邀请码 */}
      <div className="id-card" style={{ padding: '0.6rem' }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>创建新邀请码</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', marginBottom: '0.4rem' }}>玩家首次登录时自行输入昵称</div>
        <div className="id-card-row">
          <label>初始权限</label>
          <input value={newPerm} onChange={e => setNewPerm(e.target.value)} placeholder="留空=0" type="number" min={0} />
        </div>
        <button className="id-btn primary sm" style={{ width: '100%', marginTop: '0.3rem' }} onClick={handleCreate} disabled={creating}>
          {creating ? '创建中…' : '生成邀请码'}
        </button>
      </div>

      {/* 创建成功的邀请码 — 高亮+复制 */}
      {createdCode && (
        <div className="id-card" style={{ borderColor: 'var(--cyan)', padding: '0.6rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-mute)', marginBottom: '0.2rem' }}>邀请码已创建</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.2rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--cyan)' }}>
            {createdCode}
          </div>
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
            <button className="id-btn sm" style={{ flex: 1 }} onClick={() => copyCode(createdCode)}>复制</button>
            <button className="id-btn sm" style={{ flex: 1 }} onClick={() => setCreatedCode(null)}>关闭</button>
          </div>
        </div>
      )}

      {/* 活跃邀请码列表 */}
      {loading ? (
        <div className="id-loading">加载中…</div>
      ) : activeCodes.length === 0 && revokedCodes.length === 0 ? (
        <div className="id-empty"><span>🍃</span><span>暂无邀请码</span></div>
      ) : (
        <>
          {activeCodes.length > 0 && (
            <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', padding: '0.2rem 0.6rem', fontWeight: 600 }}>
              活跃 ({activeCodes.length})
            </div>
          )}
          {activeCodes.map(renderCodeCard)}

          {/* 已吊销邀请码 — 折叠区 */}
          {revokedCodes.length > 0 && (
            <>
              <button
                className="id-btn sm"
                style={{ width: '100%', marginTop: '0.4rem', color: 'var(--text-mute)', fontSize: '0.75rem' }}
                onClick={() => setShowRevoked(v => !v)}
              >
                已吊销 ({revokedCodes.length}) {showRevoked ? '▲' : '▼'}
              </button>
              {showRevoked && revokedCodes.map(renderCodeCard)}
            </>
          )}
        </>
      )}
    </>
  );
}
