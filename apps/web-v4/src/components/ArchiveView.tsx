import { useState, useEffect, useCallback } from 'react';
import { ChevronLeft, Download, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import type {
  ArchiveDateItem,
  ArchiveDateDetail,
  ArchiveMessage,
  ArchiveSmsItem,
  ArchiveSmsDetail,
  ArchiveTextMessage,
  ArchiveScenarioItem,
  ArchiveScenarioDetail,
  ArchiveSceneDateItem,
  ArchiveSceneDateDetail,
  ArchiveSceneMessage,
  ArchiveSceneScenarioItem,
  ArchiveSceneScenarioDetail,
} from '../lib/api';

export type ArchiveKind = 'dates' | 'scenarios' | 'sms';

// 五类记录归一成的统一列表项
type RecordItem = {
  id: string;
  type: 'scene-date' | 'date' | 'scene-scenario' | 'scenario' | 'sms';
  characterId: string;
  characterName: string;
  title: string;
  locationName: string;
  summary: string;
  messageCount: number;
  createdAt: number;
  isGroup: boolean;
  goalAchieved: boolean;
  hasDream: boolean;
};

// 详情状态：按记录类型区分
type DetailState =
  | { type: 'scene-date'; session: ArchiveSceneDateDetail; messages: ArchiveSceneMessage[] }
  | { type: 'date'; session: ArchiveDateDetail; messages: ArchiveMessage[] }
  | { type: 'scene-scenario'; session: ArchiveSceneScenarioDetail; messages: ArchiveSceneMessage[] }
  | { type: 'scenario'; session: ArchiveScenarioDetail; messages: ArchiveMessage[] }
  | { type: 'sms'; thread: ArchiveSmsDetail; messages: ArchiveTextMessage[] }
  | null;

function fmtDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

function downloadMarkdown(markdown: string, filename: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 记录类型 → 导出 type 参数映射
const exportTypeMap: Record<RecordItem['type'], 'date' | 'sms' | 'scenario' | 'scene' | 'scene-scenario'> = {
  'scene-date': 'scene',
  date: 'date',
  'scene-scenario': 'scene-scenario',
  scenario: 'scenario',
  sms: 'sms',
};

const typeLabelMap: Record<RecordItem['type'], string> = {
  'scene-date': '场景约会',
  date: '约会',
  'scene-scenario': '场景剧本',
  scenario: '剧本',
  sms: '短信',
};

export function ArchiveView({ kind, characterId }: { kind: ArchiveKind; characterId?: string }) {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DetailState>(null);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const items: RecordItem[] = [];
      if (kind === 'dates') {
        const [scene, plain] = await Promise.all([api.getArchiveSceneDates(), api.getArchiveDates()]);
        scene.dates.forEach((d: ArchiveSceneDateItem) =>
          items.push({
            id: d.id, type: 'scene-date', characterId: d.characterId, characterName: d.characterName,
            title: d.characterName, locationName: d.locationName, summary: d.summary,
            messageCount: d.messageCount, createdAt: d.createdAt, isGroup: d.isGroup,
            goalAchieved: false, hasDream: false,
          }),
        );
        plain.dates.forEach((d: ArchiveDateItem) =>
          items.push({
            id: d.id, type: 'date', characterId: d.characterId, characterName: d.characterName,
            title: d.characterName, locationName: d.locationName, summary: d.summary,
            messageCount: d.messageCount, createdAt: d.createdAt, isGroup: d.isGroup,
            goalAchieved: false, hasDream: false,
          }),
        );
      } else if (kind === 'scenarios') {
        const [scene, plain] = await Promise.all([api.getArchiveSceneScenarios(), api.getArchiveScenarios()]);
        scene.sessions.forEach((s: ArchiveSceneScenarioItem) =>
          items.push({
            id: s.id, type: 'scene-scenario', characterId: s.characterId, characterName: s.characterName,
            title: s.scenarioTitle, locationName: '', summary: s.scenarioDescription,
            messageCount: s.messageCount, createdAt: s.createdAt, isGroup: s.isGroup,
            goalAchieved: s.goalAchieved, hasDream: !!s.dreamText,
          }),
        );
        plain.sessions.forEach((s: ArchiveScenarioItem) =>
          items.push({
            id: s.id, type: 'scenario', characterId: s.characterId, characterName: s.characterName,
            title: s.scenarioTitle, locationName: '', summary: s.scenarioDescription,
            messageCount: s.messageCount, createdAt: s.createdAt, isGroup: false,
            goalAchieved: s.goalAchieved, hasDream: !!s.dreamText,
          }),
        );
      } else {
        const { threads } = await api.getArchiveSms();
        threads.forEach((t: ArchiveSmsItem) =>
          items.push({
            id: t.id, type: 'sms', characterId: t.characterId, characterName: t.characterName,
            title: t.characterName, locationName: '', summary: '',
            messageCount: t.messageCount, createdAt: t.lastMessageAt ?? t.createdAt,
            isGroup: false, goalAchieved: false, hasDream: false,
          }),
        );
      }
      items.sort((a, b) => b.createdAt - a.createdAt);
      setRecords(characterId ? items.filter((i) => i.characterId === characterId) : items);
    } catch (e) {
      console.error('加载记录失败', e);
    } finally {
      setLoading(false);
    }
  }, [kind, characterId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const openDetail = async (item: RecordItem) => {
    try {
      if (item.type === 'scene-date') {
        const data = await api.getArchiveSceneDate(item.id);
        setDetail({ type: 'scene-date', session: data.session, messages: data.messages });
      } else if (item.type === 'date') {
        const data = await api.getArchiveDate(item.id);
        setDetail({ type: 'date', session: data.session, messages: data.messages });
      } else if (item.type === 'scene-scenario') {
        const data = await api.getArchiveSceneScenario(item.id);
        setDetail({ type: 'scene-scenario', session: data.session, messages: data.messages });
      } else if (item.type === 'scenario') {
        const data = await api.getArchiveScenario(item.id);
        setDetail({ type: 'scenario', session: data.session, messages: data.messages });
      } else {
        const data = await api.getArchiveSmsDetail(item.id);
        setDetail({ type: 'sms', thread: data.thread, messages: data.messages });
      }
    } catch {
      showToast('加载详情失败');
    }
  };

  const handleExport = async (singleId?: string) => {
    setExporting(true);
    try {
      // 单条导出时，从当前 records 找到对应 type；全部导出用 kind 对应的默认 type
      let type: 'date' | 'sms' | 'scenario' | 'scene' | 'scene-scenario';
      if (singleId) {
        const rec = records.find((r) => r.id === singleId);
        type = rec ? exportTypeMap[rec.type] : (kind === 'dates' ? 'scene' : kind === 'scenarios' ? 'scene-scenario' : 'sms');
      } else {
        type = kind === 'dates' ? 'scene' : kind === 'scenarios' ? 'scene-scenario' : 'sms';
      }
      const ids = singleId ? [singleId] : [];
      const data = await api.exportArchive(type, ids);
      const prefixMap: Record<string, string> = { date: '约会', sms: '短信', scenario: '剧本', scene: '场景约会', 'scene-scenario': '场景剧本' };
      const prefix = prefixMap[type] ?? '回忆';
      const date = new Date().toISOString().slice(0, 10);
      downloadMarkdown(data.markdown, `${prefix}回忆录_${date}.md`);
      showToast('已导出');
    } catch {
      showToast('导出失败');
    } finally {
      setExporting(false);
    }
  };

  // ─── 详情视图 ───────────────────────────────────────
  if (detail) {
    let title = '';
    let subtitle = '';
    let exportId = '';

    if (detail.type === 'scene-date') {
      title = detail.session.characterName + (detail.session.isGroup ? '（群聊）' : '');
      subtitle = (detail.session.locationName || '') + (detail.session.summary ? ` · ${detail.session.summary}` : '');
      exportId = detail.session.id;
    } else if (detail.type === 'date') {
      title = detail.session.characterName + (detail.session.isGroup ? '（群聊）' : '');
      subtitle = (detail.session.locationName || '') + (detail.session.summary ? ` · ${detail.session.summary}` : '');
      exportId = detail.session.id;
    } else if (detail.type === 'scene-scenario') {
      title = detail.session.scenarioTitle;
      subtitle = detail.session.characterName + (detail.session.goalAchieved ? ' · 目标达成' : '');
      exportId = detail.session.id;
    } else if (detail.type === 'scenario') {
      title = detail.session.scenarioTitle;
      subtitle = detail.session.characterName + (detail.session.goalAchieved ? ' · 目标达成' : '');
      exportId = detail.session.id;
    } else {
      title = detail.thread.characterName;
      subtitle = `短信记录 · ${detail.messages.length} 条`;
      exportId = detail.thread.id;
    }

    const renderMessage = (role: string, text: string, speakerName: string | null, internal: string, internalViewed: number, key: string) => {
      const isPlayer = role === 'player';
      const isNarration = role === 'narration' || role === 'narrator';
      if (isNarration) {
        return (
          <div key={key} className="text-center mb-2 text-[11px] text-ink-faint italic leading-relaxed px-3">
            {text}
          </div>
        );
      }
      return (
        <div key={key} className={`flex flex-col mb-2 ${isPlayer ? 'items-end' : 'items-start'}`}>
          {!isPlayer && speakerName && (
            <span className="text-[10px] text-ink-faint mb-0.5 px-1">{speakerName}</span>
          )}
          <div
            className={`max-w-[78%] px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
              isPlayer
                ? 'bg-chat-pink-soft/90 backdrop-blur-md rounded-2xl rounded-tr-sm text-ink'
                : 'frosted-glass border border-border rounded-2xl rounded-bl-sm text-ink'
            }`}
          >
            {text}
          </div>
          {internal && internalViewed === 1 && (
            <div className="max-w-[78%] px-2 py-1 mt-1 text-[11px] text-ink-faint opacity-80">
              （{internal}）
            </div>
          )}
        </div>
      );
    };

    return (
      <div className="w-full max-w-md mx-auto min-h-full pb-24 flex flex-col select-none">
        {toast && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-60 bg-solid text-solid-contrast text-xs px-4 py-2 rounded-xl shadow-lg border border-border-dark animate-in fade-in slide-in-from-top-2">
            {toast}
          </div>
        )}

        {/* 详情 header */}
        <header className="flex items-center justify-between py-1.5 mb-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setDetail(null)}
              className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition active:scale-95 cursor-pointer shadow-xs shrink-0"
              aria-label="返回"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <h1 className="text-sm font-bold text-ink tracking-tight truncate">{title}</h1>
          </div>
          <button
            onClick={() => handleExport(exportId)}
            disabled={exporting}
            className="px-2.5 py-1.5 rounded-lg frosted-glass border border-border text-ink text-xs font-semibold hover:bg-bg-muted flex items-center gap-1 shadow-xs transition active:scale-95 cursor-pointer shrink-0"
          >
            {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>导出</span>
          </button>
        </header>

        {subtitle && <p className="text-[11px] text-ink-faint mb-2 px-1">{subtitle}</p>}

        {/* 剧本元信息 */}
        {(detail.type === 'scenario' || detail.type === 'scene-scenario') && (
          <div className="space-y-1.5 mb-2 px-1">
            {detail.session.worldview && (
              <div className="flex gap-2 text-[11px]">
                <span className="text-ink-faint shrink-0">世界观：</span>
                <span className="text-ink-soft leading-relaxed">{detail.session.worldview}</span>
              </div>
            )}
            {detail.session.playerRole && (
              <div className="flex gap-2 text-[11px]">
                <span className="text-ink-faint shrink-0">我的身份：</span>
                <span className="text-ink-soft leading-relaxed">{detail.session.playerRole}</span>
              </div>
            )}
            {detail.session.openingScene && (
              <div className="flex gap-2 text-[11px]">
                <span className="text-ink-faint shrink-0">开局：</span>
                <span className="text-ink-soft leading-relaxed">{detail.session.openingScene}</span>
              </div>
            )}
            {detail.session.goal && (
              <div className="flex gap-2 text-[11px]">
                <span className="text-ink-faint shrink-0">目标：</span>
                <span className="text-ink-soft leading-relaxed">{detail.session.goal}</span>
              </div>
            )}
            {detail.session.dreamText && (
              <div className="frosted-glass rounded-xl p-3 border border-rose mt-2">
                <div className="text-[10px] text-rose mb-1">梦</div>
                <div className="text-xs text-ink-soft leading-relaxed">{detail.session.dreamText}</div>
              </div>
            )}
          </div>
        )}

        {/* 消息列表 */}
        <div className="flex-1">
          {detail.messages.length === 0 ? (
            <div className="text-center text-xs text-ink-faint py-12">没有消息记录</div>
          ) : (
            detail.messages.map((m, i) => {
              if (detail.type === 'sms') {
                const sm = m as ArchiveTextMessage;
                return renderMessage(sm.sender, sm.body, null, sm.internal, sm.internal_viewed, sm.id || String(i));
              }
              if (detail.type === 'scene-date' || detail.type === 'scene-scenario') {
                const sm = m as ArchiveSceneMessage;
                return renderMessage(sm.role, sm.text, sm.character_name || null, sm.internal, sm.internal_notable, sm.id || String(i));
              }
              const dm = m as ArchiveMessage;
              const speakerName = dm.speaker || (detail.type === 'scenario' ? detail.session.characterName : null);
              return renderMessage(dm.role, dm.text, speakerName, dm.internal, dm.internal_viewed, dm.id || String(i));
            })
          )}
        </div>
      </div>
    );
  }

  // ─── 列表视图（按角色分组）──────────────────────────
  const groups = new Map<string, { id: string; name: string; items: RecordItem[] }>();
  for (const r of records) {
    if (!groups.has(r.characterId)) {
      groups.set(r.characterId, { id: r.characterId, name: r.characterName, items: [] });
    }
    groups.get(r.characterId)!.items.push(r);
  }

  return (
    <div className="w-full max-w-md mx-auto min-h-full pb-24 flex flex-col select-none">
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-60 bg-solid text-solid-contrast text-xs px-4 py-2 rounded-xl shadow-lg border border-border-dark animate-in fade-in slide-in-from-top-2">
          {toast}
        </div>
      )}

      {/* 列表 header：标题 + 全部导出 */}
      <header className="flex items-center justify-between py-1.5 mb-2.5">
        <h1 className="text-sm font-bold text-ink tracking-tight">
          {kind === 'dates' ? '约会记录' : kind === 'scenarios' ? '剧本记录' : '短信记录'}
        </h1>
        <button
          onClick={() => handleExport()}
          disabled={exporting || records.length === 0}
          className="px-2.5 py-1.5 rounded-lg frosted-glass border border-border text-ink text-xs font-semibold hover:bg-bg-muted flex items-center gap-1 shadow-xs transition active:scale-95 cursor-pointer disabled:opacity-50"
        >
          {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          <span>全部导出</span>
        </button>
      </header>

      {loading ? (
        <p className="text-center text-xs text-ink-faint py-12">加载中...</p>
      ) : records.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-xs text-ink-faint">
            {kind === 'dates' ? '还没有约会记录' : kind === 'scenarios' ? '还没有剧本记录' : '还没有短信记录'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from(groups.values()).map((g) => (
            <div key={g.id}>
              <div className="flex items-center justify-between px-1 mb-1.5">
                <span className="text-xs font-semibold text-ink">{g.name}</span>
                <span className="text-[10px] text-ink-faint">{g.items.length} 条</span>
              </div>
              <div className="space-y-2">
                {g.items.map((r) => (
                  <div
                    key={r.id}
                    onClick={() => openDetail(r)}
                    className="frosted-glass rounded-xl p-3 border border-border shadow-xs cursor-pointer hover:bg-bg-soft transition active:scale-[0.99]"
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="px-1.5 py-0.5 rounded-md bg-bg-muted text-[10px] font-medium text-ink">
                        {typeLabelMap[r.type]}
                      </span>
                      <span className="text-[10px] text-ink-faint shrink-0">{fmtDate(r.createdAt)}</span>
                    </div>
                    {(r.type === 'scenario' || r.type === 'scene-scenario') && r.title && (
                      <div className="text-xs font-semibold text-ink mb-0.5 line-clamp-1">{r.title}</div>
                    )}
                    {r.type !== 'sms' && (
                      <>
                        {r.locationName && (
                          <div className="text-[11px] text-ink-muted mb-0.5">📍 {r.locationName}</div>
                        )}
                        {r.summary && (
                          <div className="text-xs text-ink leading-relaxed line-clamp-2">{r.summary}</div>
                        )}
                      </>
                    )}
                    {r.type === 'sms' && (
                      <div className="text-xs text-ink">{r.messageCount} 条短信</div>
                    )}
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <span className="text-[10px] text-ink-faint">{r.messageCount} 条消息</span>
                      {r.isGroup && <span className="text-[10px] text-ink-faint">· 群聊</span>}
                      {r.goalAchieved && <span className="text-[10px] text-sage">· 目标达成</span>}
                      {r.hasDream && <span className="text-[10px] text-ember">· 有梦</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
