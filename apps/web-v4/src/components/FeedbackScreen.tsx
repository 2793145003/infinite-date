import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Heart, MessageCircle, Send, Trash2, Plus } from 'lucide-react';

// ─── 类型 ────────────────────────────────────────────────────

interface SuggestionInteraction {
  id: string;
  authorName: string;
  isMine?: boolean;
  body?: string;
  createdAt: number;
}

interface SuggestionInfo {
  id: string;
  authorName: string | null; // null = 匿名
  isAnonymous: boolean;
  title: string;
  body: string;
  category: string; // general/bug/feature/improvement
  status: string; // open/planned/done/declined
  adminNote: string;
  createdAt: number;
  updatedAt: number;
  likes: SuggestionInteraction[];
  comments: SuggestionInteraction[];
  myLiked: boolean;
}

interface ChangelogEntry {
  id: string;
  version: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

// ─── 工具 ────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

const CATEGORY_LABELS: Record<string, string> = {
  general: '综合',
  bug: '问题反馈',
  feature: '功能建议',
  improvement: '改进',
};

const ALL_STATUSES = ['open', 'planned', 'done', 'declined'] as const;

const STATUS_META: Record<string, { label: string; badge: string }> = {
  open: { label: '待处理', badge: 'bg-bg-amber-soft/80 text-amber' },
  planned: { label: '已计划', badge: 'bg-bg-blue-soft/80 text-cyan' },
  done: { label: '已完成', badge: 'bg-bg-emerald-soft/80 text-sage' },
  declined: { label: '不予采纳', badge: 'bg-bg-muted-2/70 text-ink-muted' },
};

// ─── 主组件 ──────────────────────────────────────────────────

export const FeedbackScreen: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [tab, setTab] = useState<'suggestions' | 'changelog'>('suggestions');

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="px-3.5 py-2.5 flex items-center justify-between shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2.5">
          <button
            onClick={onBack}
            className="p-1 -ml-1 text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
            aria-label="返回"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-[15px] font-bold text-ink tracking-tight">反馈中心</h1>
        </div>
      </header>

      {/* 标签页切换 */}
      <div className="px-3.5 pb-1 shrink-0">
        <div className="flex items-center gap-1 p-1 rounded-2xl bg-bg-soft backdrop-blur-md border border-border">
          <button
            onClick={() => setTab('suggestions')}
            className={`flex-1 py-1.5 rounded-xl text-[12px] font-semibold transition cursor-pointer ${
              tab === 'suggestions' ? 'bg-bg-soft text-ink shadow-2xs' : 'text-ink-muted hover:text-ink'
            }`}
          >
            功能建议
          </button>
          <button
            onClick={() => setTab('changelog')}
            className={`flex-1 py-1.5 rounded-xl text-[12px] font-semibold transition cursor-pointer ${
              tab === 'changelog' ? 'bg-bg-soft text-ink shadow-2xs' : 'text-ink-muted hover:text-ink'
            }`}
          >
            更新日志
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-[81px]">
        {tab === 'suggestions' ? <SuggestionsPanel /> : <ChangelogPanel />}
      </div>
    </div>
  );
};

// ═══ 建议面板 ════════════════════════════════════════════════

function SuggestionsPanel() {
  const [suggestions, setSuggestions] = useState<SuggestionInfo[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [enabledStatuses, setEnabledStatuses] = useState<Set<string>>(
    () => new Set<string>(ALL_STATUSES),
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/v4/api/suggestions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSuggestions((data.suggestions as SuggestionInfo[]) || []);
      setIsAdmin(!!data.isAdmin);
    } catch (e) {
      console.error('加载建议失败', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleStatus = (status: string) => {
    setEnabledStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        // 不允许全部取消——至少保留一个
        if (next.size === 1) return next;
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  };

  const filteredSuggestions = suggestions.filter((s) => enabledStatuses.has(s.status));

  if (loading) {
    return <div className="text-center text-ink-muted text-xs py-10">加载中…</div>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* 提交建议按钮 */}
      <button
        onClick={() => setShowForm(true)}
        className="flex items-center justify-center gap-1 py-2.5 rounded-2xl bg-bg-soft backdrop-blur-md border border-border text-ink text-[13px] font-semibold transition active:scale-95 cursor-pointer shadow-2xs"
      >
        <Plus className="w-4 h-4" />
        <span>提建议</span>
      </button>

      {showForm && (
        <SuggestionForm
          onCancel={() => setShowForm(false)}
          onSubmitted={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {/* 状态筛选 */}
      <div className="flex flex-wrap gap-1.5">
        {ALL_STATUSES.map((st) => {
          const active = enabledStatuses.has(st);
          return (
            <button
              key={st}
              onClick={() => toggleStatus(st)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition cursor-pointer border ${
                active
                  ? `${STATUS_META[st].badge} border-transparent`
                  : 'bg-bg-soft/40 border-border-soft text-ink-faint'
              }`}
            >
              {STATUS_META[st].label}
            </button>
          );
        })}
      </div>

      {/* 建议列表 */}
      {suggestions.length === 0 && !showForm ? (
        <div className="text-center text-ink-muted text-xs py-10">还没有建议，来提第一条吧</div>
      ) : filteredSuggestions.length === 0 ? (
        <div className="text-center text-ink-muted text-xs py-10">没有符合筛选条件的建议</div>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredSuggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} isAdmin={isAdmin} onUpdate={load} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 提交建议表单 ─────────────────────────────────────────────

function SuggestionForm({
  onCancel,
  onSubmitted,
}: {
  onCancel: () => void;
  onSubmitted: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('feature');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await fetch('/v4/api/suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), category, isAnonymous }),
      });
      onSubmitted();
    } catch (e) {
      console.error('提交建议失败', e);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 rounded-2xl bg-bg-soft backdrop-blur-md border border-border shadow-2xs">
      <input
        className="px-3 py-2 rounded-xl bg-bg-input border border-border text-[13px] text-ink placeholder:text-ink-faint outline-none focus:bg-bg-soft transition"
        placeholder="标题（简短描述你的建议）"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={100}
      />
      <textarea
        className="px-3 py-2 rounded-xl bg-bg-input border border-border text-[13px] text-ink placeholder:text-ink-faint outline-none focus:bg-bg-soft transition resize-none"
        placeholder="详细说明（可选）……"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
      />
      <div className="flex items-center justify-between gap-2">
        <select
          className="px-2.5 py-1.5 rounded-xl bg-bg-input border border-border text-[12px] text-ink outline-none transition cursor-pointer"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="feature">功能建议</option>
          <option value="bug">问题反馈</option>
          <option value="improvement">改进</option>
          <option value="general">综合</option>
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-soft cursor-pointer">
          <input
            type="checkbox"
            checked={isAnonymous}
            onChange={(e) => setIsAnonymous(e.target.checked)}
            className="accent-rose"
          />
          匿名提交
        </label>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3.5 py-1.5 rounded-xl bg-bg-soft border border-border text-ink-muted text-[12px] font-medium transition active:scale-95 cursor-pointer"
        >
          取消
        </button>
        <button
          onClick={handleSubmit}
          disabled={!title.trim() || submitting}
          className={`px-3.5 py-1.5 rounded-xl text-[12px] font-semibold transition active:scale-95 cursor-pointer ${
            title.trim() && !submitting
              ? 'bg-solid text-solid-contrast hover:bg-solid-soft'
              : 'bg-solid/30 text-solid-contrast cursor-not-allowed'
          }`}
        >
          {submitting ? '提交中…' : '提交'}
        </button>
      </div>
    </div>
  );
}

// ─── 建议卡片 ─────────────────────────────────────────────────

function SuggestionCard({
  suggestion: s,
  isAdmin,
  onUpdate,
}: {
  suggestion: SuggestionInfo;
  isAdmin: boolean;
  onUpdate: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [commenting, setCommenting] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [showAdminPanel, setShowAdminPanel] = useState(false);

  const handleLike = async () => {
    try {
      await fetch(`/v4/api/suggestions/${s.id}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      onUpdate();
    } catch (e) {
      console.error('点赞失败', e);
    }
  };

  const handleComment = async () => {
    if (!commentText.trim()) return;
    try {
      await fetch(`/v4/api/suggestions/${s.id}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: commentText.trim() }),
      });
      setCommentText('');
      setCommenting(false);
      onUpdate();
    } catch (e) {
      console.error('评论失败', e);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await fetch(`/v4/api/suggestions/${s.id}/comment/${commentId}`, { method: 'DELETE' });
      onUpdate();
    } catch (e) {
      console.error('删除评论失败', e);
    }
  };

  const handleAdminUpdate = async (status: string) => {
    try {
      await fetch(`/v4/api/admin/suggestions/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      setShowAdminPanel(false);
      onUpdate();
    } catch (e) {
      console.error('更新状态失败', e);
    }
  };

  const handleAdminDelete = async () => {
    if (!confirm('确定删除这条建议？')) return;
    try {
      await fetch(`/v4/api/admin/suggestions/${s.id}`, { method: 'DELETE' });
      onUpdate();
    } catch (e) {
      console.error('删除建议失败', e);
    }
  };

  const statusMeta = STATUS_META[s.status] ?? { label: s.status, badge: 'bg-bg-muted-2/70 text-ink-muted' };

  return (
    <div className="rounded-2xl bg-bg-soft backdrop-blur-md border border-border shadow-2xs overflow-hidden">
      {/* 头部（点击折叠/展开） */}
      <div className="p-3 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded-md bg-bg-muted text-ink-muted text-[10px] font-medium">
            {CATEGORY_LABELS[s.category] ?? s.category}
          </span>
          <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium ${statusMeta.badge}`}>
            {statusMeta.label}
          </span>
        </div>
        <div className="mt-1.5 text-[13px] font-semibold text-ink leading-snug">{s.title}</div>
        {s.body && (
          <div className="mt-1 text-[12px] text-ink-soft leading-relaxed whitespace-pre-wrap break-words">
            {expanded ? s.body : s.body.length > 80 ? `${s.body.slice(0, 80)}…` : s.body}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-ink-faint">
          <span>{s.isAnonymous ? '匿名用户' : s.authorName ?? '匿名用户'}</span>
          <span>·</span>
          <span>{formatTime(s.createdAt)}</span>
          {s.updatedAt > s.createdAt + 1000 && (
            <>
              <span>·</span>
              <span>更新于{formatTime(s.updatedAt)}</span>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          {/* 官方回复（若有） */}
          {s.adminNote && (
            <div className="px-2.5 py-2 rounded-xl bg-bg-amber-soft/70 border border-amber/60">
              <div className="text-[10px] font-semibold text-amber">官方回复</div>
              <div className="mt-0.5 text-[12px] text-ink-soft leading-relaxed whitespace-pre-wrap break-words">
                {s.adminNote}
              </div>
            </div>
          )}

          {/* 互动栏 */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleLike}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full border transition active:scale-95 cursor-pointer text-[11px] font-medium ${
                s.myLiked
                  ? 'bg-bg-rose-soft/80 border-rose/60 text-rose'
                  : 'bg-bg-soft border-border text-ink-muted hover:text-ink'
              }`}
            >
              <Heart className={`w-3.5 h-3.5 ${s.myLiked ? 'fill-rose' : ''}`} />
              <span>{s.likes.length || ''}</span>
            </button>
            <button
              onClick={() => setCommenting((v) => !v)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-bg-soft border border-border text-ink-muted hover:text-ink transition active:scale-95 cursor-pointer text-[11px] font-medium"
            >
              <MessageCircle className="w-3.5 h-3.5" />
              <span>{s.comments.length || ''}</span>
            </button>
            {isAdmin && (
              <button
                onClick={() => setShowAdminPanel((v) => !v)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full border transition active:scale-95 cursor-pointer text-[11px] font-medium ${
                  showAdminPanel
                    ? 'bg-solid text-solid-contrast border-transparent'
                    : 'bg-bg-soft border-border text-ink-muted hover:text-ink'
                }`}
              >
                管理
              </button>
            )}
          </div>

          {/* 评论列表 */}
          {s.comments.length > 0 && (
            <div className="flex flex-col gap-1">
              {s.comments.map((c) => (
                <div
                  key={c.id}
                  className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-xl bg-bg-muted/70"
                >
                  <span className="text-[11px] font-semibold text-ink-soft shrink-0">
                    {c.authorName}
                  </span>
                  <span className="flex-1 text-[12px] text-ink-soft leading-relaxed whitespace-pre-wrap break-words">
                    {c.body}
                  </span>
                  <span className="text-[10px] text-ink-faint shrink-0">{formatTime(c.createdAt)}</span>
                  {c.isMine || isAdmin ? (
                    <button
                      onClick={() => handleDeleteComment(c.id)}
                      className="shrink-0 text-ink-faint hover:text-rose transition cursor-pointer"
                      aria-label="删除评论"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {/* 评论输入框 */}
          {commenting && (
            <div className="flex items-center gap-1.5">
              <textarea
                rows={1}
                placeholder="写评论……"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                className="flex-1 resize-none rounded-xl bg-bg-input border border-border px-3 py-2 text-[12px] text-ink placeholder:text-ink-faint outline-none focus:bg-bg-soft transition"
              />
              <button
                onClick={handleComment}
                disabled={!commentText.trim()}
                className={`w-8 h-8 rounded-full flex items-center justify-center transition active:scale-95 cursor-pointer shrink-0 ${
                  commentText.trim()
                    ? 'bg-solid text-solid-contrast'
                    : 'bg-solid/20 text-solid-contrast cursor-not-allowed'
                }`}
                aria-label="发送评论"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 管理员面板 */}
          {showAdminPanel && isAdmin && (
            <AdminPanel
              suggestionId={s.id}
              currentStatus={s.status}
              currentNote={s.adminNote}
              onStatusChange={handleAdminUpdate}
              onDelete={handleAdminDelete}
              onUpdate={onUpdate}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── 管理员面板 ─────────────────────────────────────────────────

function AdminPanel({
  suggestionId,
  currentStatus,
  currentNote,
  onStatusChange,
  onDelete,
  onUpdate,
}: {
  suggestionId: string;
  currentStatus: string;
  currentNote: string;
  onStatusChange: (status: string) => void;
  onDelete: () => void;
  onUpdate: () => void;
}) {
  const [note, setNote] = useState(currentNote);
  const [savingNote, setSavingNote] = useState(false);

  const handleSaveNote = async () => {
    if (savingNote || note === currentNote) return;
    setSavingNote(true);
    try {
      await fetch(`/v4/api/admin/suggestions/${suggestionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminNote: note }),
      });
      onUpdate();
    } catch (e) {
      console.error('保存备注失败', e);
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-bg-muted/60 border border-border p-2.5">
      <div className="text-[10px] font-semibold text-ink-muted">管理员操作</div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-ink-muted shrink-0">状态</span>
        <select
          value={currentStatus}
          onChange={(e) => onStatusChange(e.target.value)}
          className="flex-1 px-2.5 py-1.5 rounded-lg bg-bg-input border border-border text-[12px] text-ink outline-none cursor-pointer"
        >
          <option value="open">待处理</option>
          <option value="planned">已计划</option>
          <option value="done">已完成</option>
          <option value="declined">不予采纳</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-ink-muted">备注（完成说明/拒绝理由）</span>
        <textarea
          rows={2}
          placeholder="管理员备注……"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="resize-none rounded-lg bg-bg-input border border-border px-2.5 py-2 text-[12px] text-ink placeholder:text-ink-faint outline-none focus:bg-bg-soft transition"
        />
        <button
          onClick={handleSaveNote}
          disabled={savingNote || note === currentNote}
          className={`self-end px-3 py-1 rounded-lg text-[11px] font-semibold transition active:scale-95 cursor-pointer ${
            note === currentNote || savingNote
              ? 'bg-solid/20 text-solid-contrast cursor-not-allowed'
              : 'bg-solid text-solid-contrast hover:bg-solid-soft'
          }`}
        >
          {savingNote ? '保存中…' : '保存备注'}
        </button>
      </div>

      <button
        onClick={onDelete}
        className="self-start px-3 py-1 rounded-lg bg-bg-rose-soft/70 border border-rose/40 text-rose text-[11px] font-semibold transition active:scale-95 cursor-pointer hover:bg-bg-rose-soft"
      >
        删除建议
      </button>
    </div>
  );
}

// ═══ 更新日志面板 ════════════════════════════════════════════

function ChangelogPanel() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/v4/api/changelog');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries((data.entries as ChangelogEntry[]) || []);
    } catch (e) {
      console.error('加载更新日志失败', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="text-center text-ink-muted text-xs py-10">加载中…</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.length === 0 ? (
        <div className="text-center text-ink-muted text-xs py-10">还没有更新日志</div>
      ) : (
        entries.map((e) => <ChangelogCard key={e.id} entry={e} />)
      )}
    </div>
  );
}

// ─── 日志卡片 ─────────────────────────────────────────────────

function ChangelogCard({ entry }: { entry: ChangelogEntry }) {
  return (
    <div className="p-3 rounded-2xl bg-bg-soft backdrop-blur-md border border-border shadow-2xs">
      <div className="flex items-center gap-1.5">
        {entry.version && (
          <span className="px-1.5 py-0.5 rounded-md bg-cyan/10 text-cyan text-[10px] font-semibold">
            {entry.version}
          </span>
        )}
        <span className="text-[10px] text-ink-faint">{formatTime(entry.createdAt)}</span>
      </div>
      <div className="mt-1.5 text-[13px] font-semibold text-ink leading-snug">{entry.title}</div>
      {entry.body && (
        <div className="mt-1 text-[12px] text-ink-soft leading-relaxed whitespace-pre-wrap break-words">
          {entry.body}
        </div>
      )}
      {entry.updatedAt > entry.createdAt + 1000 && (
        <div className="mt-1.5 text-[10px] text-ink-faint">更新于{formatTime(entry.updatedAt)}</div>
      )}
    </div>
  );
}
