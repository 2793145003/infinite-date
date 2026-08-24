import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { renderTextWithActions } from '../lib/text-render';
import type {
  ArchiveDateItem, ArchiveDateDetail, ArchiveMessage,
  ArchiveSmsItem, ArchiveSmsDetail, ArchiveTextMessage,
  ArchiveScenarioItem, ArchiveScenarioDetail,
  ArchiveSceneDateItem, ArchiveSceneDateDetail, ArchiveSceneMessage,
  ArchiveSceneScenarioItem, ArchiveSceneScenarioDetail,
} from '../lib/api';

type Tab = 'scene' | 'scene-scenario' | 'dates' | 'sms' | 'scenarios';

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDateShort(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtDateFull(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function downloadMarkdown(md: string, filename: string) {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ArchiveApp({ onBack, embedded }: { onBack: () => void; embedded?: boolean }) {
  const [tab, setTab] = useState<Tab>('scene');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState('');
  const [showOld, setShowOld] = useState(false);  // 旧记录分组是否展开

  // 列表数据
  const [sceneDates, setSceneDates] = useState<ArchiveSceneDateItem[]>([]);
  const [sceneScenarios, setSceneScenarios] = useState<ArchiveSceneScenarioItem[]>([]);
  const [dates, setDates] = useState<ArchiveDateItem[]>([]);
  const [smsThreads, setSmsThreads] = useState<ArchiveSmsItem[]>([]);
  const [scenarios, setScenarios] = useState<ArchiveScenarioItem[]>([]);

  // 二级：选中的角色
  const [selectedChar, setSelectedChar] = useState<{ id: string; name: string } | null>(null);

  // 三级：详情数据
  const [detail, setDetail] = useState<
    | { type: 'scene'; session: ArchiveSceneDateDetail; messages: ArchiveSceneMessage[] }
    | { type: 'scene-scenario'; session: ArchiveSceneScenarioDetail; messages: ArchiveSceneMessage[] }
    | { type: 'date'; session: ArchiveDateDetail; messages: ArchiveMessage[] }
    | { type: 'sms'; thread: ArchiveSmsDetail; messages: ArchiveTextMessage[] }
    | { type: 'scenario'; session: ArchiveScenarioDetail; messages: ArchiveMessage[] }
    | null
  >(null);

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  // ─── 加载列表 ───────────────────────────────────────────
  const loadList = useCallback(async (t: Tab, q: string) => {
    setLoading(true);
    setDetail(null);
    setSelectedChar(null);
    try {
      if (t === 'scene') {
        const data = await api.getArchiveSceneDates(q || undefined);
        setSceneDates(data.dates);
      } else if (t === 'scene-scenario') {
        const data = await api.getArchiveSceneScenarios(q || undefined);
        setSceneScenarios(data.sessions);
      } else if (t === 'dates') {
        const data = await api.getArchiveDates(q || undefined);
        setDates(data.dates);
      } else if (t === 'sms') {
        const data = await api.getArchiveSms(q || undefined);
        setSmsThreads(data.threads);
      } else {
        const data = await api.getArchiveScenarios(q || undefined);
        setScenarios(data.sessions);
      }
    } catch {
      showMsg('加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList(tab, search);
  }, [tab, search]);

  const handleSearch = () => {
    setSearch(searchInput.trim());
  };

  // ─── 加载详情 ───────────────────────────────────────────
  const openDetail = async (type: Tab, id: string) => {
    try {
      if (type === 'scene') {
        const data = await api.getArchiveSceneDate(id);
        setDetail({ type: 'scene', session: data.session, messages: data.messages });
      } else if (type === 'scene-scenario') {
        const data = await api.getArchiveSceneScenario(id);
        setDetail({ type: 'scene-scenario', session: data.session, messages: data.messages });
      } else if (type === 'dates') {
        const data = await api.getArchiveDate(id);
        setDetail({ type: 'date', session: data.session, messages: data.messages });
      } else if (type === 'sms') {
        const data = await api.getArchiveSmsDetail(id);
        setDetail({ type: 'sms', thread: data.thread, messages: data.messages });
      } else {
        const data = await api.getArchiveScenario(id);
        setDetail({ type: 'scenario', session: data.session, messages: data.messages });
      }
    } catch {
      showMsg('加载详情失败');
    }
  };

  // ─── 导出 ───────────────────────────────────────────────
  const handleExport = async (singleId?: string) => {
    setExporting(true);
    try {
      const type: 'date' | 'sms' | 'scenario' | 'scene' | 'scene-scenario' = tab === 'dates' ? 'date' : tab === 'sms' ? 'sms' : tab === 'scenarios' ? 'scenario' : tab === 'scene-scenario' ? 'scene-scenario' : 'scene';
      const ids = singleId ? [singleId] : [];
      const data = await api.exportArchive(type, ids);
      const prefixMap: Record<string, string> = { date: '约会', sms: '短信', scenario: '剧本', scene: '场景约会', 'scene-scenario': '场景剧本' };
      const prefix = prefixMap[type] ?? '回忆';
      const date = new Date().toISOString().slice(0, 10);
      downloadMarkdown(data.markdown, `${prefix}回忆录_${date}.md`);
      showMsg('已导出');
    } catch {
      showMsg('导出失败');
    } finally {
      setExporting(false);
    }
  };

  // ─── 按角色分组 ─────────────────────────────────────────
  function groupByChar<T extends { characterId: string; characterName: string }>(items: T[]): Map<string, { id: string; name: string; items: T[] }> {
    const map = new Map<string, { id: string; name: string; items: T[] }>();
    for (const item of items) {
      if (!map.has(item.characterId)) {
        map.set(item.characterId, { id: item.characterId, name: item.characterName, items: [] });
      }
      map.get(item.characterId)!.items.push(item);
    }
    return map;
  }

  // ─── 渲染消息气泡（只读） ───────────────────────────────
  const renderBubble = (key: string, role: string, text: string, internal: string, internalViewed: number, speaker?: string | null, nameMap?: Map<string, string>) => {
    const isPlayer = role === 'player';
    const speakerName = speaker && nameMap ? (nameMap.get(speaker) ?? speaker) : '';
    return (
      <div key={key} style={{ display: 'flex', flexDirection: 'column', alignItems: isPlayer ? 'flex-end' : 'flex-start', marginBottom: '0.5rem' }}>
        {!isPlayer && speaker && nameMap && (
          <span style={{ fontSize: '0.7rem', color: 'var(--text-mute)', marginBottom: '0.15rem', padding: '0 0.5rem' }}>{speakerName}</span>
        )}
        <div
          className={isPlayer ? 'id-bubble player' : 'id-bubble npc'}
          style={{ maxWidth: '78%', padding: '0.5rem 0.8rem', borderRadius: '0.8rem', fontSize: '0.9rem', lineHeight: 1.5 }}
        >
          {renderTextWithActions(text)}
        </div>
        {internal && internalViewed === 1 && (
          <div style={{ maxWidth: '78%', padding: '0.3rem 0.6rem', marginTop: '0.15rem', fontSize: '0.78rem', color: 'var(--text-mute)', opacity: 0.8 }}>
            （{renderTextWithActions(internal)}）
          </div>
        )}
      </div>
    );
  };

  // ═══ 三级：详情视图 ═══════════════════════════════════════
  if (detail) {
    const back = () => setDetail(null);
    let title = '';
    let subtitle = '';
    let exportId = '';

    if (detail.type === 'scene') {
      title = detail.session.characterName + (detail.session.isGroup ? '（群聊）' : '');
      subtitle = (detail.session.locationName || '') + (detail.session.summary ? ` · ${detail.session.summary}` : '');
      exportId = detail.session.id;
    } else if (detail.type === 'scene-scenario') {
      title = detail.session.scenarioTitle;
      subtitle = detail.session.characterName + (detail.session.goalAchieved ? ' · 目标达成' : '');
      exportId = detail.session.id;
    } else if (detail.type === 'date') {
      title = detail.session.characterName + (detail.session.isGroup ? '（群聊）' : '');
      subtitle = (detail.session.locationName || '') + (detail.session.summary ? ` · ${detail.session.summary}` : '');
      exportId = detail.session.id;
    } else if (detail.type === 'sms') {
      title = detail.thread.characterName;
      subtitle = `短信记录 · ${detail.messages.length} 条`;
      exportId = detail.thread.id;
    } else {
      title = detail.session.scenarioTitle;
      subtitle = `${detail.session.characterName}${detail.session.goalAchieved ? ' · 目标达成' : ''}`;
      exportId = detail.session.id;
    }

    return (
      <div className="id-app">
        {!embedded && (
          <div className="id-appbar">
            <button className="id-appbar-back" onClick={back}>←</button>
            <span className="id-appbar-title">回忆</span>
            <button className="id-appbar-action" disabled={exporting} onClick={() => handleExport(exportId)}>
              {exporting ? '…' : '导出'}
            </button>
          </div>
        )}
        <div className="id-app-scroll">
          {embedded && (
            <div style={{ display: 'flex', alignItems: 'center', padding: '0.4rem 0.8rem', gap: '0.5rem' }}>
              <button className="id-btn sm" onClick={back}>← 返回</button>
              <button className="id-btn sm" style={{ marginLeft: 'auto' }} disabled={exporting} onClick={() => handleExport(exportId)}>
                {exporting ? '…' : '导出'}
              </button>
            </div>
          )}
          {msg && <div className="id-card" style={{ textAlign: 'center', fontSize: '0.85rem', borderColor: 'var(--cyan)' }}>{msg}</div>}
          <div style={{ padding: '0.6rem 0.8rem', borderBottom: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text)' }}>{title}</div>
            {subtitle && <div style={{ fontSize: '0.78rem', color: 'var(--text-mute)', marginTop: '0.2rem' }}>{subtitle}</div>}
          </div>

          {/* 剧本元信息 */}
          {detail.type === 'scenario' && (
            <div style={{ padding: '0.5rem 0.8rem' }}>
              {detail.session.worldview && <InfoLine label="世界观" value={detail.session.worldview} />}
              {detail.session.playerRole && <InfoLine label="我的身份" value={detail.session.playerRole} />}
              {detail.session.npcRoles?.length > 0 && <InfoLine label="NPC角色" value={detail.session.npcRoles.map(r => r.identity || r.description).join('、')} />}
              {detail.session.openingScene && <InfoLine label="开局" value={detail.session.openingScene} />}
              {detail.session.goal && <InfoLine label="目标" value={detail.session.goal} />}
              {detail.session.dreamText && (
                <div className="id-card" style={{ marginTop: '0.5rem', borderColor: 'var(--plum)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--plum)', marginBottom: '0.3rem' }}>梦</div>
                  <div style={{ fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-dim)' }}>{detail.session.dreamText}</div>
                </div>
              )}
            </div>
          )}

          {/* 场景剧本元信息 */}
          {detail.type === 'scene-scenario' && (
            <div style={{ padding: '0.5rem 0.8rem' }}>
              {detail.session.worldview && <InfoLine label="世界观" value={detail.session.worldview} />}
              {detail.session.playerRole && <InfoLine label="我的身份" value={detail.session.playerRole} />}
              {detail.session.openingScene && <InfoLine label="开局" value={detail.session.openingScene} />}
              {detail.session.goal && <InfoLine label="目标" value={detail.session.goal} />}
              {detail.session.dreamText && (
                <div className="id-card" style={{ marginTop: '0.5rem', borderColor: 'var(--plum)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--plum)', marginBottom: '0.3rem' }}>梦</div>
                  <div style={{ fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-dim)' }}>{detail.session.dreamText}</div>
                </div>
              )}
            </div>
          )}

          {/* 消息列表 */}
          <div style={{ padding: '0.5rem' }}>
            {detail.messages.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-mute)', padding: '2rem' }}>没有消息记录</div>
            ) : (
              detail.messages.map((m, i) => {
                if (detail.type === 'sms') {
                  const sm = m as ArchiveTextMessage;
                  return renderBubble(sm.id, sm.sender, sm.body, sm.internal, sm.internal_viewed);
                }
                if (detail.type === 'scene' || detail.type === 'scene-scenario') {
                  const sm = m as ArchiveSceneMessage;
                  if (sm.role === 'narration' || sm.role === 'narrator') {
                    return (
                      <div key={sm.id} style={{ textAlign: 'center', marginBottom: '0.5rem', fontSize: '0.78rem', color: 'var(--text-mute)', fontStyle: 'italic', lineHeight: 1.5 }}>
                        {renderTextWithActions(sm.text)}
                      </div>
                    );
                  }
                  return renderBubble(sm.id, sm.role, sm.text, sm.internal, sm.internal_notable, sm.character_name || null);
                }
                const dm = m as ArchiveMessage;
                let nameMap: Map<string, string> | undefined;
                if (detail.type === 'date' && detail.session.isGroup && detail.session.participants.length > 0) {
                  nameMap = new Map(detail.session.participants.map(p => [p.characterId, p.name]));
                }
                return renderBubble(dm.id || String(i), dm.role, dm.text, dm.internal, dm.internal_viewed, dm.speaker, nameMap);
              })
            )}
          </div>
        </div>
      </div>
    );
  }

  // ═══ 二级：选中角色后，显示和TA的记录列表 ═════════════════
  if (selectedChar) {
    const back = () => setSelectedChar(null);

    return (
      <div className="id-app">
        {!embedded && (
          <div className="id-appbar">
            <button className="id-appbar-back" onClick={back}>←</button>
            <span className="id-appbar-title">{selectedChar.name}</span>
          </div>
        )}
        <div className="id-app-scroll">
          {embedded && (
            <div style={{ padding: '0.4rem 0.8rem' }}>
              <button className="id-btn sm" onClick={back}>← 返回</button>
            </div>
          )}
          {msg && <div className="id-card" style={{ textAlign: 'center', fontSize: '0.85rem', borderColor: 'var(--cyan)' }}>{msg}</div>}

          {tab === 'scene' && (() => {
            const items = sceneDates.filter(d => (d.characterName ?? '').includes(selectedChar.name) || d.characterId === selectedChar.id);
            if (items.length === 0) return <EmptyHint text="没有场景约会记录" />;
            return items.map(d => (
              <div key={d.id} className="id-card" style={{ marginBottom: '0.4rem', cursor: 'pointer' }} onClick={() => openDetail('scene', d.id)}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-mute)', marginBottom: '0.3rem' }}>
                  {fmtDateFull(d.createdAt)}
                </div>
                {d.locationName && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.2rem' }}>📍 {d.locationName}</div>
                )}
                {d.summary && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.4 }}>{d.summary}</div>
                )}
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>{d.messageCount} 条消息{d.isGroup ? ' · 群聊' : ''}</div>
              </div>
            ));
          })()}

          {tab === 'scene-scenario' && (() => {
            const items = sceneScenarios.filter(s => (s.characterName ?? '').includes(selectedChar.name) || s.characterId === selectedChar.id);
            if (items.length === 0) return <EmptyHint text="没有场景剧本记录" />;
            return items.map(s => (
              <div key={s.id} className="id-card" style={{ marginBottom: '0.4rem', cursor: 'pointer' }} onClick={() => openDetail('scene-scenario', s.id)}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-mute)', marginBottom: '0.3rem' }}>
                  {fmtDateFull(s.createdAt)}
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text)', fontWeight: 600 }}>{s.scenarioTitle}</div>
                {s.scenarioDescription && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{s.scenarioDescription.slice(0, 60)}</div>
                )}
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
                  {s.messageCount} 条消息{s.goalAchieved ? ' · 目标达成' : ''}{s.dreamText ? ' · 有梦' : ''}
                </div>
              </div>
            ));
          })()}

          {tab === 'dates' && (() => {
            const items = dates.filter(d => d.characterId === selectedChar.id);
            if (items.length === 0) return <EmptyHint text="没有约会记录" />;
            return items.map(d => (
              <div key={d.id} className="id-card" style={{ marginBottom: '0.4rem', cursor: 'pointer' }} onClick={() => openDetail('dates', d.id)}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-mute)', marginBottom: '0.3rem' }}>
                  {fmtDateFull(d.createdAt)}
                </div>
                {d.locationName && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginBottom: '0.2rem' }}>📍 {d.locationName}</div>
                )}
                {d.summary && (
                  <div style={{ fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.4 }}>{d.summary}</div>
                )}
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>{d.messageCount} 条消息{d.isGroup ? ' · 群聊' : ''}</div>
              </div>
            ));
          })()}

          {tab === 'sms' && (() => {
            // SMS每个角色只有一个thread，直接打开详情
            const items = smsThreads.filter(t => t.characterId === selectedChar.id);
            if (items.length === 0) return <EmptyHint text="没有短信记录" />;
            return items.map(t => (
              <div key={t.id} className="id-card" style={{ marginBottom: '0.4rem', cursor: 'pointer' }} onClick={() => openDetail('sms', t.id)}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-mute)', marginBottom: '0.3rem' }}>
                  {t.lastMessageAt ? `最后消息 ${fmtDateFull(t.lastMessageAt)}` : ''}
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text)' }}>{t.messageCount} 条短信</div>
              </div>
            ));
          })()}

          {tab === 'scenarios' && (() => {
            const items = scenarios.filter(s => s.characterId === selectedChar.id);
            if (items.length === 0) return <EmptyHint text="没有剧本记录" />;
            return items.map(s => (
              <div key={s.id} className="id-card" style={{ marginBottom: '0.4rem', cursor: 'pointer' }} onClick={() => openDetail('scenarios', s.id)}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-mute)', marginBottom: '0.3rem' }}>
                  {fmtDateFull(s.createdAt)}
                </div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text)', fontWeight: 600 }}>{s.scenarioTitle}</div>
                {s.scenarioDescription && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginTop: '0.2rem' }}>{s.scenarioDescription.slice(0, 60)}</div>
                )}
                <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.3rem' }}>
                  {s.messageCount} 条消息{s.goalAchieved ? ' · 目标达成' : ''}{s.dreamText ? ' · 有梦' : ''}
                </div>
              </div>
            ));
          })()}
        </div>
      </div>
    );
  }

  // ═══ 一级：角色列表 ═══════════════════════════════════════
  const charGroups = (tab === 'scene'
    ? groupByChar(sceneDates)
    : tab === 'scene-scenario'
    ? groupByChar(sceneScenarios)
    : tab === 'dates'
    ? groupByChar(dates)
    : tab === 'sms'
    ? groupByChar(smsThreads)
    : groupByChar(scenarios)) as Map<string, { id: string; name: string; items: { characterId: string; characterName: string }[] }>;

  return (
    <div className="id-app">
      {!embedded && (
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">回忆</span>
          <button className="id-appbar-action" disabled={exporting} onClick={() => handleExport()}>
            {exporting ? '…' : '全部导出'}
          </button>
        </div>
      )}
      <div className="id-app-scroll">
        {msg && <div className="id-card" style={{ textAlign: 'center', fontSize: '0.85rem', borderColor: 'var(--cyan)' }}>{msg}</div>}

        {/* Tab：场景约会 + 场景剧本为主，旧记录折叠 */}
        <div style={{ padding: '0.5rem 0.8rem' }}>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <button
              className="id-btn sm"
              style={{
                flex: 1,
                padding: '0.5rem',
                background: tab === 'scene' ? 'var(--cyan)' : 'var(--btn-bg)',
                color: tab === 'scene' ? 'var(--ink)' : 'var(--text)',
                borderColor: tab === 'scene' ? 'var(--cyan)' : 'var(--border-bright)',
                fontSize: '0.9rem',
                fontWeight: 600,
              }}
              onClick={() => setTab('scene')}
            >
              🧭 场景约会
            </button>
            <button
              className="id-btn sm"
              style={{
                flex: 1,
                padding: '0.5rem',
                background: tab === 'scene-scenario' ? 'var(--cyan)' : 'var(--btn-bg)',
                color: tab === 'scene-scenario' ? 'var(--ink)' : 'var(--text)',
                borderColor: tab === 'scene-scenario' ? 'var(--cyan)' : 'var(--border-bright)',
                fontSize: '0.9rem',
                fontWeight: 600,
              }}
              onClick={() => setTab('scene-scenario')}
            >
              🎬 场景剧本
            </button>
          </div>

          <button
            className="id-btn sm"
            style={{
              width: '100%',
              marginTop: '0.4rem',
              padding: '0.4rem',
              background: 'var(--btn-bg)',
              color: 'var(--text-mute)',
              borderColor: 'var(--border-soft)',
              fontSize: '0.8rem',
            }}
            onClick={() => setShowOld(s => !s)}
          >
            📦 旧记录 {showOld ? '▾' : '▸'}
          </button>

          {showOld && (
            <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.4rem' }}>
              {([
                { key: 'dates' as Tab, label: '约会' },
                { key: 'sms' as Tab, label: '短信' },
                { key: 'scenarios' as Tab, label: '剧本' },
              ]).map(t => (
                <button
                  key={t.key}
                  className="id-btn sm"
                  style={{
                    flex: 1,
                    background: tab === t.key ? 'var(--cyan)' : 'var(--btn-bg)',
                    color: tab === t.key ? 'var(--ink)' : 'var(--text)',
                    borderColor: tab === t.key ? 'var(--cyan)' : 'var(--border-bright)',
                    fontSize: '0.85rem',
                  }}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 搜索 */}
        <div style={{ display: 'flex', gap: '0.3rem', padding: '0 0.8rem 0.5rem' }}>
          <input
            className="id-input"
            style={{ flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
            placeholder="搜索角色名/内容/地点…"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
          />
          <button className="id-btn sm" onClick={handleSearch}>搜索</button>
          {search && <button className="id-btn sm" onClick={() => { setSearch(''); setSearchInput(''); }}>清除</button>}
        </div>

        {/* 角色列表 */}
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-mute)', padding: '2rem' }}>加载中…</div>
        ) : charGroups.size === 0 ? (
          <EmptyHint text={tab === 'scene' ? '还没有场景约会记录' : tab === 'scene-scenario' ? '还没有场景剧本记录' : tab === 'dates' ? '还没有约会记录' : tab === 'sms' ? '还没有短信记录' : '还没有剧本记录'} />
        ) : (
          Array.from(charGroups.values()).map(g => (
            <div
              key={g.id}
              className="id-card"
              style={{ marginBottom: '0.4rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              onClick={() => {
                // SMS只有一个thread，直接进详情
                if (tab === 'sms' && g.items.length === 1) {
                  openDetail('sms', (g.items[0] as ArchiveSmsItem).id);
                } else {
                  setSelectedChar({ id: g.id, name: g.name });
                }
              }}
            >
              <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text)' }}>{g.name}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{g.items.length} 条记录</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.3rem', fontSize: '0.8rem' }}>
      <span style={{ color: 'var(--text-mute)', flexShrink: 0 }}>{label}：</span>
      <span style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>{value}</span>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="id-card" style={{ textAlign: 'center', color: 'var(--text-mute)', fontSize: '0.85rem' }}>
      {text}
    </div>
  );
}
