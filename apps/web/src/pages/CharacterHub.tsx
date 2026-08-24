import { useState, useEffect } from 'react';
import { Upload, Plus, Search, MessageCircle, Pencil, Trash2 } from 'lucide-react';
import { api, imageUrl, type ThreadInfo } from '../lib/api';
import type { View } from '../AppV2';
import { CharacterEditModal } from '../components/CharacterEditModal';

// 好友页（v3）：好友列表（与短信列表同源），卡片式，支持搜索 / 新建 / 导入 / 编辑 / 删除 / 聊天
export function CharacterHub({
  onBack,
  onNavigate,
}: {
  onBack: () => void;
  onNavigate: (view: View) => void;
}) {
  const [friends, setFriends] = useState<ThreadInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.getThreads();
      setFriends(data.threads.filter((t) => t.character_id !== 'DEITY'));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = friends.filter((f) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      (f.character_name ?? '').toLowerCase().includes(q) ||
      (genderLabel(f.gender) ?? '').includes(q)
    );
  });

  const handleDelete = async (characterId: string) => {
    try {
      await api.deleteFriend(characterId);
      setConfirmDelete(null);
      await load();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">好友</span>
        <button className="id-appbar-action" onClick={() => setImportOpen(true)}>
          <Upload size={14} strokeWidth={1.8} style={{ marginRight: '0.2rem', verticalAlign: '-2px' }} />
          导入
        </button>
      </div>

      <div className="id-friends-toolbar">
        <div className="id-friends-search">
          <Search size={15} strokeWidth={1.8} />
          <input
            placeholder="搜索好友"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="id-friends-new" onClick={() => onNavigate({ type: 'creation' })}>
          <Plus size={16} strokeWidth={2} />
          <span>新建</span>
        </button>
      </div>

      <div className="id-app-scroll">
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="id-empty">
            <span>🍃</span>
            <span>{query.trim() ? '没有匹配的好友' : '还没有好友，去约会里认识新角色吧'}</span>
          </div>
        ) : (
          filtered.map((f) => (
            <div key={f.id} className="id-friends-item">
              <div className="id-friends-avatar">
                {f.avatar ? (
                  <img src={imageUrl(f.avatar)} alt="" />
                ) : (
                  <span>{f.character_name?.[0] ?? '?'}</span>
                )}
              </div>
              <div className="id-friends-body">
                <div className="id-friends-name-row">
                  <span className="id-friends-name">{f.character_name || '未知'}</span>
                  {genderLabel(f.gender) && (
                    <span className="id-friends-gender">{genderLabel(f.gender)}</span>
                  )}
                </div>
                <div className="id-friends-bio">
                  {[f.age ? `${f.age}岁` : '', f.appearance].filter(Boolean).join(' · ') || '这个人很神秘，还没留下什么信息'}
                </div>
              </div>
              <div className="id-friends-actions">
                <button
                  title="聊天"
                  onClick={() => onNavigate({ type: 'sms-thread', threadId: f.id, characterId: f.character_id })}
                >
                  <MessageCircle size={16} strokeWidth={1.8} />
                </button>
                <button title="编辑" onClick={() => setEditId(f.character_id)}>
                  <Pencil size={16} strokeWidth={1.8} />
                </button>
                <button title="删除" onClick={() => setConfirmDelete(f.character_id)}>
                  <Trash2 size={16} strokeWidth={1.8} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {editId && (
        <CharacterEditModal
          characterId={editId}
          onClose={() => setEditId(null)}
          onSaved={() => load()}
        />
      )}

      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false);
            load();
          }}
        />
      )}

      {confirmDelete && (
        <div className="id-modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="id-modal" onClick={(e) => e.stopPropagation()}>
            <div className="id-modal-title">删除好友</div>
            <div className="id-modal-desc">
              确定删除这个好友吗？会清空和 ta 的短信、记忆，以及你编辑过的角色副本。
            </div>
            <div className="id-modal-actions">
              <button className="id-btn sm" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="id-btn sm danger" onClick={() => handleDelete(confirmDelete)}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function genderLabel(g?: string | null): string {
  if (g === 'male') return '男';
  if (g === 'female') return '女';
  return '';
}

// ─── JSON 导入弹窗 ─────────────────────────────────────────────
function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [json, setJson] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File) => {
    setError('');
    try {
      const text = await file.text();
      setJson(text);
    } catch {
      setError('无法读取文件');
    }
  };

  const handleImport = async () => {
    setError('');
    if (!json.trim()) {
      setError('请输入 JSON 或上传文件');
      return;
    }
    // 前端先做格式与字段校验，后端会再校验一次
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError('JSON 格式错误，无法解析');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('JSON 必须是一个角色卡对象');
      return;
    }
    const draft = parsed as Record<string, unknown>;
    if (!String(draft.name ?? '').trim()) {
      setError('缺少名字字段（name）');
      return;
    }
    setBusy(true);
    try {
      await api.importCharacter(json, true);
      onImported();
    } catch (e) {
      setError((e as Error).message || '导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" onClick={(e) => e.stopPropagation()}>
        <div className="id-modal-title">导入好友</div>
        <div className="id-modal-desc">
          粘贴角色卡 JSON，或上传 .json 文件。至少需要 name 字段；可选 gender（male/female）、age、appearance。
        </div>
        <textarea
          className="id-import-textarea"
          placeholder={'{\n  "name": "…",\n  "gender": "male",\n  "age": "…",\n  "appearance": "…"\n}'}
          value={json}
          onChange={(e) => setJson(e.target.value)}
        />
        <label className="id-import-file">
          <Upload size={14} strokeWidth={1.8} />
          <span>上传文件</span>
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        </label>
        {error && <div className="id-import-error">{error}</div>}
        <div className="id-modal-actions" style={{ marginTop: '0.8rem' }}>
          <button className="id-btn sm" onClick={onClose}>取消</button>
          <button className="id-btn sm primary" onClick={handleImport} disabled={busy}>
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
