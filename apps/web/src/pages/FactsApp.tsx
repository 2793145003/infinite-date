import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { AutoTextarea } from '../components/AutoTextarea';

interface FactItem {
  id: string;
  character_id: string;
  character_name: string;
  fact: string;
  source: string;
  created_at: number;
  updated_at: number;
}

type Tab = 'new' | 'legacy';

export function FactsApp({ onBack, embedded }: { onBack: () => void; embedded?: boolean }) {
  const [tab, setTab] = useState<Tab>('new');
  const [facts, setFacts] = useState<FactItem[]>([]);
  const [legacyFacts, setLegacyFacts] = useState<FactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [adding, setAdding] = useState(false);
  const [newFact, setNewFact] = useState('');
  const [msg, setMsg] = useState('');
  const [selectedChar, setSelectedChar] = useState<string>('all');

  const load = async () => {
    try {
      const data = await api.getFacts();
      setFacts(data.facts);
    } catch {
      setMsg('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const loadLegacy = async () => {
    try {
      const data = await api.getLegacyFacts();
      setLegacyFacts(data.facts);
    } catch {
      setMsg('旧记忆加载失败');
    }
  };

  useEffect(() => { load(); loadLegacy(); }, []);

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const startEdit = (f: FactItem) => {
    setEditingId(f.id);
    setEditText(f.fact);
  };

  const saveEdit = async () => {
    if (!editingId || !editText.trim()) return;
    try {
      await api.updateFact(editingId, editText.trim());
      setEditingId(null);
      showMsg('已保存');
      load();
    } catch {
      showMsg('保存失败');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除这条记忆吗？')) return;
    try {
      await api.deleteFact(id);
      showMsg('已删除');
      load();
    } catch {
      showMsg('删除失败');
    }
  };

  const handleAdd = async () => {
    if (!newFact.trim()) return;
    try {
      await api.addFact(newFact.trim());
      setNewFact('');
      setAdding(false);
      showMsg('已添加');
      load();
    } catch {
      showMsg('添加失败');
    }
  };

  const sourceLabel = (s: string) => {
    if (s === 'conversation') return '对话';
    if (s === 'manual') return '手动';
    if (s === 'scene') return '实景';
    if (s === 'exploration') return '探索';
    return s;
  };

  // 按角色分组（分角色功能，两个页签共用）
  const groupByChar = (list: FactItem[]) => {
    const groups: Record<string, { name: string; facts: FactItem[] }> = {};
    for (const f of list) {
      if (!groups[f.character_id]) {
        groups[f.character_id] = { name: f.character_name, facts: [] };
      }
      groups[f.character_id]!.facts.push(f);
    }
    return Object.entries(groups);
  };

  const charFilter = (list: FactItem[], sel: string) =>
    sel === 'all' ? list : list.filter(f => f.character_id === sel);

  const activeFacts = tab === 'new' ? facts : legacyFacts;
  const groupEntries = groupByChar(charFilter(activeFacts, selectedChar));

  return (
    <div className="id-app">
      {!embedded && (
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">🧠 记忆</span>
          {tab === 'new' && (
            <button className="id-btn sm" style={{ marginRight: '0.3rem' }} onClick={() => setAdding(!adding)}>
              {adding ? '取消' : '＋ 添加'}
            </button>
          )}
        </div>
      )}

      {/* 页签：新记忆（可编辑）/ 旧记忆（只读折叠） */}
      <div style={{ display: 'flex', gap: '0.4rem', padding: '0.4rem 0.6rem' }}>
        <button
          className={`id-btn sm ${tab === 'new' ? 'primary' : ''}`}
          style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0' }}
          onClick={() => { setTab('new'); setSelectedChar('all'); }}
        >
          🧠 新记忆（{facts.length}）
        </button>
        <button
          className={`id-btn sm ${tab === 'legacy' ? 'primary' : ''}`}
          style={{ flex: 1, fontSize: '0.8rem', padding: '0.4rem 0' }}
          onClick={() => { setTab('legacy'); setSelectedChar('all'); }}
        >
          🗂 旧记忆（{legacyFacts.length}）
        </button>
        {embedded && tab === 'new' && (
          <button className="id-btn sm primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.5rem' }} onClick={() => setAdding(!adding)}>
            {adding ? '取消' : '＋'}
          </button>
        )}
      </div>

      <div className="id-app-scroll">
        {msg && (
          <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>
            {msg}
          </div>
        )}

        {tab === 'new' ? (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', padding: '0 0.5rem', marginBottom: '0.5rem' }}>
            角色记得的关于你的事。如果有误可以编辑或删除。
          </div>
        ) : (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', padding: '0 0.5rem', marginBottom: '0.5rem' }}>
            旧系统记录的关于你的事（只读）。
          </div>
        )}

        {activeFacts.length > 0 && (
          <div className="id-card" style={{ padding: '0.5rem 0.8rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-mute)', flexShrink: 0 }}>筛选角色</span>
            <select
              className="id-input"
              style={{ flex: 1, padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}
              value={selectedChar}
              onChange={e => setSelectedChar(e.target.value)}
            >
              <option value="all">全部（{activeFacts.length} 条）</option>
              {groupByChar(activeFacts).map(([cid, group]) => (
                <option key={cid} value={cid}>{group.name}（{group.facts.length} 条）</option>
              ))}
            </select>
          </div>
        )}

        {tab === 'new' && adding && (
          <div className="id-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <AutoTextarea
              className="id-input"
              style={{ minHeight: '3rem', resize: 'vertical' }}
              placeholder="例如：我喜欢吃火锅，尤其是麻辣锅底"
              value={newFact}
              onChange={e => setNewFact(e.target.value)}
              autoFocus
            />
            <button className="id-btn primary sm" onClick={handleAdd} disabled={!newFact.trim()}>
              确认添加
            </button>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-mute)', padding: '2rem' }}>加载中…</div>
        ) : activeFacts.length === 0 ? (
          <div className="id-card" style={{ textAlign: 'center', color: 'var(--text-mute)', fontSize: '0.85rem' }}>
            {tab === 'new' ? '还没有记忆。和角色聊聊天，他们会记住关于你的事。' : '暂无旧记忆'}
          </div>
        ) : (
          groupEntries.map(([cid, group]) => (
            <div key={cid} style={{ marginBottom: '0.8rem' }}>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-mute)', padding: '0.3rem 0.5rem', fontWeight: 600 }}>
                {group.name}
              </div>
              {group.facts.map(f => (
                <div key={f.id} className="id-card" style={{ padding: '0.8rem', marginBottom: '0.4rem' }}>
                  {tab === 'new' && editingId === f.id ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      <AutoTextarea
                        className="id-input"
                        style={{ minHeight: '3rem', resize: 'vertical' }}
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        autoFocus
                      />
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button className="id-btn primary sm" style={{ flex: 1 }} onClick={saveEdit} disabled={!editText.trim()}>保存</button>
                        <button className="id-btn sm" style={{ flex: 1 }} onClick={() => setEditingId(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '0.4rem' }}>{f.fact}</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-dim)' }}>
                          {sourceLabel(f.source)}
                        </span>
                        {tab === 'new' && (
                          <div style={{ display: 'flex', gap: '0.3rem' }}>
                            <button className="id-btn sm" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={() => startEdit(f)}>
                              ✏️ 编辑
                            </button>
                            <button className="id-btn sm" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', color: 'var(--danger)' }} onClick={() => handleDelete(f.id)}>
                              🗑 删除
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
