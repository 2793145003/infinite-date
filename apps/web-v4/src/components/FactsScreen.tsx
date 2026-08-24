import React, { useState, useEffect } from 'react';
import {
  ChevronLeft,
  Plus,
  Pencil,
  Trash2,
  X,
  Sparkles,
  BookHeart,
} from 'lucide-react';
import { Character } from '../types';
import { api, type FactItem } from '../lib/api';

interface FactsScreenProps {
  activeCharacter: Character;
  allCharacters: Character[];
  onBack: () => void;
  embedded?: boolean;
  defaultCharId?: string;
}

function formatFactTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - thatDay.getTime()) / 86400000);
  if (diffDays === 0) return `今天 ${hh}:${mm}`;
  if (diffDays === 1) return `昨天 ${hh}:${mm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export const FactsScreen: React.FC<FactsScreenProps> = ({
  activeCharacter,
  allCharacters,
  onBack,
  embedded,
  defaultCharId,
}) => {
  const [facts, setFacts] = useState<FactItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCharId, setFilterCharId] = useState<string>(defaultCharId ?? 'all');

  const [showModal, setShowModal] = useState(false);
  const [editingFact, setEditingFact] = useState<FactItem | null>(null);
  const [formContent, setFormContent] = useState('');
  const [formCharId, setFormCharId] = useState<string>('');

  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const loadFacts = async () => {
    try {
      const { facts: list } = await api.listFacts();
      setFacts(list);
    } catch (e) {
      console.error('加载记忆失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFacts();
  }, []);

  // 嵌入日记页时，跟随上方角色（defaultCharId）同步筛选
  useEffect(() => {
    if (embedded && defaultCharId) {
      setFilterCharId(defaultCharId);
    }
  }, [embedded, defaultCharId]);

  // 筛选：全部 / 按角色
  const filteredFacts =
    filterCharId === 'all' ? facts : facts.filter((f) => f.character_id === filterCharId);

  // 角色筛选项：从 allCharacters 生成（含「通用」）
  const charFilters: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  if (facts.some((f) => f.character_id === 'manual')) {
    seen.add('manual');
    charFilters.push({ id: 'manual', name: '通用' });
  }
  for (const c of allCharacters) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      charFilters.push({ id: c.id, name: c.name });
    }
  }

  const charName = (f: FactItem): string => {
    if (f.character_id === 'manual') return '通用';
    return f.character_name || '未知角色';
  };

  const openCreate = () => {
    setEditingFact(null);
    setFormContent('');
    setFormCharId(activeCharacter.id || 'manual');
    setShowModal(true);
  };

  const openEdit = (f: FactItem) => {
    setEditingFact(f);
    setFormContent(f.fact);
    setFormCharId(f.character_id);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!formContent.trim()) return;
    try {
      if (editingFact) {
        await api.updateFact(editingFact.id, formContent.trim());
        showToast('已更新记忆');
      } else {
        await api.addFact(formContent.trim(), formCharId || undefined);
        showToast('已记下');
      }
      setShowModal(false);
      await loadFacts();
    } catch (e) {
      console.error('保存记忆失败', e);
      showToast('操作失败');
    }
  };

  const handleDelete = async (f: FactItem) => {
    if (!window.confirm(`确定删除这条记忆？\n「${f.fact.slice(0, 40)}」`)) return;
    try {
      await api.deleteFact(f.id);
      showToast('已删除');
      await loadFacts();
    } catch (e) {
      console.error('删除失败', e);
    }
  };

  return (
    <div className={`w-full max-w-md mx-auto min-h-full pb-24 flex flex-col select-none ${embedded ? '' : 'px-3.5 pt-3'}`}>
      {/* Toast */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-60 bg-solid text-solid-contrast text-xs px-4 py-2 rounded-xl shadow-lg border border-border-dark animate-in fade-in slide-in-from-top-2">
          {toast}
        </div>
      )}

      {/* Top Bar */}
      {!embedded ? (
        <header className="flex items-center justify-between py-1.5 mb-2.5">
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition active:scale-95 cursor-pointer shadow-xs"
              aria-label="返回"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <h1 className="text-sm font-bold text-ink tracking-tight">记忆簿</h1>
          </div>
          <button
            onClick={openCreate}
            className="px-2.5 py-1.5 rounded-lg frosted-glass border border-border text-ink text-xs font-semibold hover:bg-bg-muted flex items-center gap-1 shadow-xs transition active:scale-95 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>记一条</span>
          </button>
        </header>
      ) : (
        <div className="flex justify-end py-1.5 mb-2.5">
          <button
            onClick={openCreate}
            className="px-2.5 py-1.5 rounded-lg frosted-glass border border-border text-ink text-xs font-semibold hover:bg-bg-muted flex items-center gap-1 shadow-xs transition active:scale-95 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>记一条</span>
          </button>
        </div>
      )}

      {/* 角色筛选 Chips（独立使用时显示；嵌入日记页时由上方「换人」控制，不显示） */}
      {!embedded && charFilters.length > 0 && (
        <div className="flex items-center gap-1.5 pb-2 overflow-x-auto no-scrollbar">
          <button
            onClick={() => setFilterCharId('all')}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
              filterCharId === 'all'
                ? 'bg-solid text-solid-contrast shadow-xs'
                : 'frosted-glass border border-border text-ink hover:bg-bg-soft'
            }`}
          >
            全部 ({facts.length})
          </button>
          {charFilters.map((c) => (
            <button
              key={c.id}
              onClick={() => setFilterCharId(c.id)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
                filterCharId === c.id
                  ? 'bg-solid text-solid-contrast shadow-xs'
                  : 'frosted-glass border border-border text-ink hover:bg-bg-soft'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* 列表 */}
      {loading ? (
        <p className="text-center text-xs text-ink-faint py-12">加载中...</p>
      ) : filteredFacts.length === 0 ? (
        <div className="text-center py-12">
          <BookHeart className="w-8 h-8 mx-auto mb-2 opacity-40 text-ink" />
          <p className="text-xs text-ink-faint">
            {facts.length === 0 ? '还没有记住任何关于 TA 的事，点「记一条」开始' : '这个角色还没有记忆'}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {filteredFacts.map((f) => (
            <div
              key={f.id}
              className="frosted-glass rounded-xl p-3.5 border border-border shadow-xs space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-ink leading-relaxed whitespace-pre-wrap flex-1 font-sans">
                  {f.fact}
                </p>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openEdit(f)}
                    className="w-7 h-7 rounded-md text-ink hover:bg-bg-muted flex items-center justify-center transition cursor-pointer"
                    aria-label="编辑"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(f)}
                    className="w-7 h-7 rounded-md text-ink hover:bg-bg-rose-soft hover:text-rose flex items-center justify-center transition cursor-pointer"
                    aria-label="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 rounded-md bg-bg-muted text-[10px] font-medium text-ink">
                  {charName(f)}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium ${
                    f.source === 'manual'
                      ? 'bg-bg-muted text-ink'
                      : 'bg-bg-blue-soft text-cyan'
                  }`}
                >
                  {f.source === 'manual' ? '手动' : '场景'}
                </span>
                <span className="text-[10px] text-ink-faint ml-auto">{formatFactTime(f.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 添加/编辑弹窗 */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-end sm:items-center justify-center animate-in fade-in duration-150">
          <div className="w-full max-w-md bg-panel rounded-t-2xl sm:rounded-2xl p-4 space-y-3 animate-in slide-in-from-bottom-4 duration-200">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-ink">
                {editingFact ? '编辑记忆' : '记一条记忆'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="w-7 h-7 rounded-md text-ink hover:bg-bg-muted flex items-center justify-center cursor-pointer"
                aria-label="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 关联角色 */}
            <div>
              <label className="text-[10px] text-ink font-medium block mb-1">关联角色</label>
              <select
                value={formCharId}
                onChange={(e) => setFormCharId(e.target.value)}
                className="w-full p-2.5 rounded-xl border border-border bg-bg-soft text-xs text-ink outline-none focus:border-border-dark cursor-pointer"
              >
                <option value="manual">通用（不关联具体角色）</option>
                {allCharacters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 内容 */}
            <div>
              <label className="text-[10px] text-ink font-medium block mb-1">记忆内容</label>
              <textarea
                rows={4}
                autoFocus
                placeholder="例如：TA 喜欢在下雨天喝热可可，讨厌香菜"
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                className="w-full p-3 rounded-xl border border-border bg-bg-soft text-xs text-ink placeholder-ink-faint outline-none focus:border-border-dark resize-none font-sans"
              />
            </div>

            <button
              onClick={handleSave}
              className="w-full py-2.5 rounded-xl bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer flex items-center justify-center gap-1.5 shadow-xs"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{editingFact ? '保存修改' : '记下'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
