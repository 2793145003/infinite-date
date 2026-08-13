import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { SuggestionInfo, ChangelogEntry } from '../lib/api';
import { AutoTextarea } from '../components/AutoTextarea';

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

const STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  planned: '已计划',
  done: '已完成',
  declined: '不予采纳',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'is-open',
  planned: 'is-planned',
  done: 'is-done',
  declined: 'is-declined',
};

// ─── 主组件 ──────────────────────────────────────────────────

export function FeedbackApp({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'suggestions' | 'changelog'>('suggestions');

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">反馈中心</span>
      </div>
      <div className="id-feedback-tabs">
        <button
          className={`id-feedback-tab ${tab === 'suggestions' ? 'is-active' : ''}`}
          onClick={() => setTab('suggestions')}
        >
          功能建议
        </button>
        <button
          className={`id-feedback-tab ${tab === 'changelog' ? 'is-active' : ''}`}
          onClick={() => setTab('changelog')}
        >
          更新日志
        </button>
      </div>
      <div className="id-app-scroll no-pad">
        {tab === 'suggestions' ? <SuggestionsPanel /> : <ChangelogPanel />}
      </div>
    </div>
  );
}

// ═══ 建议面板 ════════════════════════════════════════════════

const ALL_STATUSES = ['open', 'planned', 'done', 'declined'] as const;
type StatusFilter = Set<string>;

function SuggestionsPanel() {
  const [suggestions, setSuggestions] = useState<SuggestionInfo[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [enabledStatuses, setEnabledStatuses] = useState<StatusFilter>(() => {
    try {
      const saved = localStorage.getItem('idate_feedback_filters');
      if (saved) {
        const arr = JSON.parse(saved) as string[];
        const set = new Set(arr.filter(st => ALL_STATUSES.includes(st as any)));
        return set.size > 0 ? set : new Set(ALL_STATUSES as readonly string[]);
      }
    } catch { /* ignore */ }
    return new Set(ALL_STATUSES as readonly string[]);
  });

  const load = useCallback(async () => {
    try {
      const data = await api.getSuggestions();
      setSuggestions(data.suggestions);
      setIsAdmin(data.isAdmin);
      localStorage.setItem('idate_suggestions_seen', String(data.serverTime));
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleStatus = (status: string) => {
    setEnabledStatuses(prev => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      // 不允许全部取消——至少保留一个
      if (next.size === 0) {
        next.add(status);
      }
      localStorage.setItem('idate_feedback_filters', JSON.stringify([...next]));
      return next;
    });
  };

  const filteredSuggestions = suggestions.filter(s => enabledStatuses.has(s.status));

  if (loading) return <div className="id-loading">加载中…</div>;

  return (
    <>
      {/* 提交建议按钮 */}
      <div className="id-feedback-compose-bar">
        <button className="id-feedback-compose-btn" onClick={() => setShowForm(true)}>
          + 提建议
        </button>
      </div>

      {showForm && (
        <SuggestionForm
          onCancel={() => setShowForm(false)}
          onSubmitted={() => { setShowForm(false); load(); }}
        />
      )}

      {/* 状态筛选 */}
      <div className="id-feedback-filter-bar">
        {ALL_STATUSES.map(st => (
          <button
            key={st}
            className={`id-feedback-filter-chip ${STATUS_COLORS[st] ?? ''} ${enabledStatuses.has(st) ? 'is-active' : ''}`}
            onClick={() => toggleStatus(st)}
          >
            {STATUS_LABELS[st]}
          </button>
        ))}
      </div>

      {/* 建议列表 */}
      <div className="id-feedback-list">
        {suggestions.length === 0 && !showForm ? (
          <div className="id-empty-hint">还没有建议，来提第一条吧</div>
        ) : filteredSuggestions.length === 0 ? (
          <div className="id-empty-hint">没有符合筛选条件的建议</div>
        ) : (
          filteredSuggestions.map(s => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              isAdmin={isAdmin}
              onUpdate={load}
            />
          ))
        )}
      </div>
    </>
  );
}

// ─── 提交建议表单 ─────────────────────────────────────────────

function SuggestionForm({ onCancel, onSubmitted }: { onCancel: () => void; onSubmitted: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('feature');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      await api.createSuggestion({ title: title.trim(), body: body.trim(), category, isAnonymous });
      onSubmitted();
    } catch { /* ignore */ }
    setSubmitting(false);
  };

  return (
    <div className="id-feedback-form">
      <input
        className="id-feedback-input"
        placeholder="标题（简短描述你的建议）"
        value={title}
        onChange={e => setTitle(e.target.value)}
        maxLength={100}
      />
      <AutoTextarea
        className="id-autotextarea id-feedback-textarea"
        placeholder="详细说明（可选）……"
        value={body}
        onChange={e => setBody(e.target.value)}
        rows={3}
      />
      <div className="id-feedback-form-row">
        <select className="id-feedback-select" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="feature">功能建议</option>
          <option value="bug">问题反馈</option>
          <option value="improvement">改进</option>
          <option value="general">综合</option>
        </select>
        <label className="id-feedback-anonymous">
          <input
            type="checkbox"
            checked={isAnonymous}
            onChange={e => setIsAnonymous(e.target.checked)}
          />
          匿名提交
        </label>
      </div>
      <div className="id-feedback-form-actions">
        <button className="id-feedback-btn-cancel" onClick={onCancel}>取消</button>
        <button className="id-feedback-btn-submit" onClick={handleSubmit} disabled={!title.trim() || submitting}>
          {submitting ? '提交中…' : '提交'}
        </button>
      </div>
    </div>
  );
}

// ─── 建议卡片 ─────────────────────────────────────────────────

function SuggestionCard({ suggestion: s, isAdmin, onUpdate }: {
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
      await api.likeSuggestion(s.id);
      onUpdate();
    } catch { /* ignore */ }
  };

  const handleComment = async () => {
    if (!commentText.trim()) return;
    try {
      await api.commentSuggestion(s.id, commentText.trim());
      setCommentText('');
      setCommenting(false);
      onUpdate();
    } catch { /* ignore */ }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      await api.deleteSuggestionComment(s.id, commentId);
      onUpdate();
    } catch { /* ignore */ }
  };

  const handleAdminUpdate = async (status: string) => {
    try {
      await api.adminUpdateSuggestion(s.id, { status });
      setShowAdminPanel(false);
      onUpdate();
    } catch { /* ignore */ }
  };

  return (
    <div className={`id-feedback-card ${STATUS_COLORS[s.status] ?? ''}`}>
      <div className="id-feedback-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="id-feedback-card-title-area">
          <span className="id-feedback-cat">{CATEGORY_LABELS[s.category] ?? s.category}</span>
          <span className="id-feedback-status-tag">{STATUS_LABELS[s.status] ?? s.status}</span>
        </div>
        <div className="id-feedback-card-title">{s.title}</div>
        {s.body && (
          <div className="id-feedback-card-body-preview">
            {expanded ? s.body : (s.body.length > 80 ? s.body.slice(0, 80) + '…' : s.body)}
          </div>
        )}
        <div className="id-feedback-card-meta">
          <span>{s.isAnonymous ? '匿名用户' : (s.authorName ?? '匿名用户')}</span>
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
        <div className="id-feedback-card-actions">
          {/* 互动栏 */}
          <div className="id-feedback-interaction-bar">
            <button
              className={`id-feedback-like-btn ${s.myLiked ? 'is-liked' : ''}`}
              onClick={handleLike}
            >
              ♡ {s.likes.length || ''}
            </button>
            <button
              className="id-feedback-comment-btn"
              onClick={() => setCommenting(!commenting)}
            >
              💬 {s.comments.length || ''}
            </button>
            {isAdmin && (
              <button
                className="id-feedback-admin-btn"
                onClick={() => setShowAdminPanel(!showAdminPanel)}
              >
                管理
              </button>
            )}
          </div>

          {/* 评论列表 */}
          {s.comments.length > 0 && (
            <div className="id-feedback-comments">
              {s.comments.map(c => (
                <div key={c.id} className="id-feedback-comment">
                  <span className="id-feedback-comment-author">{c.authorName}</span>
                  <span className="id-feedback-comment-body">{c.body}</span>
                  <span className="id-feedback-comment-time">{formatTime(c.createdAt)}</span>
                  {(c.isMine || isAdmin) && (
                    <button
                      className="id-feedback-comment-delete"
                      onClick={() => handleDeleteComment(c.id)}
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 评论输入框 */}
          {commenting && (
            <div className="id-feedback-comment-input">
              <AutoTextarea
                className="id-autotextarea"
                placeholder="写评论……"
                value={commentText}
                onChange={e => setCommentText(e.target.value)}
                rows={1}
              />
              <button className="id-feedback-comment-send" onClick={handleComment} disabled={!commentText.trim()}>
                发送
              </button>
            </div>
          )}

          {/* 管理员面板 */}
          {showAdminPanel && isAdmin && (
            <div className="id-feedback-admin-panel">
              <div className="id-feedback-admin-row">
                <label>状态：</label>
                <select
                  value={s.status}
                  onChange={e => handleAdminUpdate(e.target.value)}
                  className="id-feedback-select"
                >
                  <option value="open">待处理</option>
                  <option value="planned">已计划</option>
                  <option value="done">已完成</option>
                  <option value="declined">不予采纳</option>
                </select>
              </div>
              <AdminNoteEditor
                suggestionId={s.id}
                currentNote={s.adminNote}
                onUpdated={onUpdate}
              />
              <button
                className="id-feedback-admin-delete"
                onClick={async () => {
                  if (confirm('确定删除这条建议？')) {
                    await api.adminDeleteSuggestion(s.id);
                    onUpdate();
                  }
                }}
              >
                删除建议
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── 管理员备注编辑器 ─────────────────────────────────────────

function AdminNoteEditor({ suggestionId, currentNote, onUpdated }: {
  suggestionId: string;
  currentNote: string;
  onUpdated: () => void;
}) {
  const [note, setNote] = useState(currentNote);
  const [saving, setSaving] = useState(false);

  return (
    <div className="id-feedback-admin-row">
      <label>备注：</label>
      <AutoTextarea
        className="id-autotextarea id-feedback-admin-note"
        placeholder="管理员备注（如完成说明/拒绝理由）"
        value={note}
        onChange={e => setNote(e.target.value)}
        rows={2}
      />
      <button
        className="id-feedback-admin-save"
        disabled={saving || note === currentNote}
        onClick={async () => {
          setSaving(true);
          try {
            await api.adminUpdateSuggestion(suggestionId, { adminNote: note });
            onUpdated();
          } catch { /* ignore */ }
          setSaving(false);
        }}
      >
        保存备注
      </button>
    </div>
  );
}

// ═══ 更新日志面板 ════════════════════════════════════════════

function ChangelogPanel() {
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.getChangelog();
      setEntries(data.entries);
      setIsAdmin(data.isAdmin);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="id-loading">加载中…</div>;

  return (
    <>
      {isAdmin && (
        <div className="id-feedback-compose-bar">
          <button className="id-feedback-compose-btn" onClick={() => setShowForm(true)}>
            + 写日志
          </button>
        </div>
      )}

      {showForm && isAdmin && (
        <ChangelogForm
          onCancel={() => setShowForm(false)}
          onSubmitted={() => { setShowForm(false); load(); }}
        />
      )}

      <div className="id-feedback-list">
        {entries.length === 0 && !showForm ? (
          <div className="id-empty-hint">还没有更新日志</div>
        ) : (
          entries.map(e => (
            <ChangelogCard
              key={e.id}
              entry={e}
              isAdmin={isAdmin}
              isEditing={editingId === e.id}
              onEditToggle={() => setEditingId(editingId === e.id ? null : e.id)}
              onUpdate={load}
            />
          ))
        )}
      </div>
    </>
  );
}

// ─── 日志卡片 ─────────────────────────────────────────────────

function ChangelogCard({ entry, isAdmin, isEditing, onEditToggle, onUpdate }: {
  entry: ChangelogEntry;
  isAdmin: boolean;
  isEditing: boolean;
  onEditToggle: () => void;
  onUpdate: () => void;
}) {
  if (isEditing && isAdmin) {
    return (
      <ChangelogForm
        entry={entry}
        onCancel={onEditToggle}
        onSubmitted={() => { onEditToggle(); onUpdate(); }}
      />
    );
  }

  return (
    <div className="id-feedback-card id-changelog-card">
      <div className="id-changelog-header">
        {entry.version && <span className="id-changelog-version">{entry.version}</span>}
        <span className="id-changelog-date">{formatTime(entry.createdAt)}</span>
      </div>
      <div className="id-feedback-card-title">{entry.title}</div>
      {entry.body && (
        <div className="id-changelog-body">{entry.body}</div>
      )}
      {entry.updatedAt > entry.createdAt + 1000 && (
        <div className="id-feedback-card-meta">
          <span>更新于{formatTime(entry.updatedAt)}</span>
        </div>
      )}
      {isAdmin && (
        <div className="id-feedback-card-actions">
          <div className="id-feedback-interaction-bar">
            <button className="id-feedback-admin-btn" onClick={onEditToggle}>编辑</button>
            <button
              className="id-feedback-admin-delete"
              onClick={async () => {
                if (confirm('确定删除这条日志？')) {
                  await api.adminDeleteChangelog(entry.id);
                  onUpdate();
                }
              }}
            >
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 日志表单（新建/编辑共用） ───────────────────────────────

function ChangelogForm({ entry, onCancel, onSubmitted }: {
  entry?: ChangelogEntry;
  onCancel: () => void;
  onSubmitted: () => void;
}) {
  const [version, setVersion] = useState(entry?.version ?? '');
  const [title, setTitle] = useState(entry?.title ?? '');
  const [body, setBody] = useState(entry?.body ?? '');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      if (entry) {
        await api.adminUpdateChangelog(entry.id, { version, title, body });
      } else {
        await api.adminCreateChangelog({ version, title, body });
      }
      onSubmitted();
    } catch { /* ignore */ }
    setSubmitting(false);
  };

  return (
    <div className="id-feedback-form">
      <input
        className="id-feedback-input"
        placeholder="标题"
        value={title}
        onChange={e => setTitle(e.target.value)}
        maxLength={100}
      />
      <input
        className="id-feedback-input id-feedback-version-input"
        placeholder="版本号（可选，如 v1.2.0）"
        value={version}
        onChange={e => setVersion(e.target.value)}
        maxLength={30}
      />
      <AutoTextarea
        className="id-autotextarea id-feedback-textarea"
        placeholder="更新内容……"
        value={body}
        onChange={e => setBody(e.target.value)}
        rows={5}
      />
      <div className="id-feedback-form-actions">
        <button className="id-feedback-btn-cancel" onClick={onCancel}>取消</button>
        <button className="id-feedback-btn-submit" onClick={handleSubmit} disabled={!title.trim() || submitting}>
          {submitting ? '保存中…' : (entry ? '保存' : '发布')}
        </button>
      </div>
    </div>
  );
}
