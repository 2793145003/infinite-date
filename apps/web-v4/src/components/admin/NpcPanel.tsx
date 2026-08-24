import React, { useState, useEffect } from 'react';
import { api, imageUrl } from '../../lib/api';
import { AutoTextarea } from '../AutoTextarea';
import { ImageUploadButton } from '../ImageUploadButton';
import type { NpcEntry, Draft, FieldVersion } from './types';
import { flattenFields, fieldLabel, computeDiff, collectFieldVersions, parseOverrideData } from './diffUtils';

export function NpcPanel() {
  const [npcs, setNpcs] = useState<NpcEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<NpcEntry | null>(null);
  const [editDraft, setEditDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<{ id: string; playerId: string; playerName: string; characterData: string; updatedAt: number }[]>([]);
  const [loadingOverrides, setLoadingOverrides] = useState(false);
  const [diffOverride, setDiffOverride] = useState<{ playerName: string; diffs: { label: string; oldVal: string; newVal: string }[] } | null>(null);
  const [fieldVersions, setFieldVersions] = useState<Map<string, FieldVersion[]>>(new Map());
  const [expandedPickers, setExpandedPickers] = useState<Set<string>>(new Set());

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.adminListCharacters();
      setNpcs(data.characters);
    } catch {
      setMsg('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const startEdit = async (npc: NpcEntry) => {
    try {
      const parsed = JSON.parse(npc.characterData);
      setEditDraft(parsed);
    } catch {
      setEditDraft({});
    }
    setEditing(npc);
    // 加载该角色的玩家override副本
    setLoadingOverrides(true);
    setExpandedPickers(new Set());
    try {
      const data = await api.adminListOverrides(npc.id);
      setOverrides(data.overrides);
      // 计算每个字段的版本集合
      let originalData: Draft | null = null;
      try { originalData = JSON.parse(npc.characterData) as Draft; } catch { /* ignore */ }
      setFieldVersions(collectFieldVersions(originalData, parseOverrideData(data.overrides)));
    } catch {
      setOverrides([]);
      setFieldVersions(new Map());
    } finally {
      setLoadingOverrides(false);
    }
  };

  const upd = (path: string, value: any) => {
    if (!editDraft) return;
    const keys = path.split('.');
    const next = JSON.parse(JSON.stringify(editDraft));
    let cur = next;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]!] = value;
    setEditDraft(next);
  };

  const handleSave = async () => {
    if (!editing || !editDraft) return;
    setSaving(true);
    try {
      const json = JSON.stringify(editDraft);
      await api.adminUpdateCharacter(editing.id, json);
      showMsg('已保存');
      setEditing(null);
      setEditDraft(null);
      await load();
    } catch {
      showMsg('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.adminDeleteCharacter(id);
      showMsg('已删除');
      setConfirmDelete(null);
      await load();
    } catch {
      showMsg('删除失败');
    }
  };

  // ── 字段版本选择器 ──
  const applyVersion = (path: string, value: string) => {
    if (path === 'likes' || path === 'dislikes') {
      upd(path, value.split('、').filter(Boolean));
    } else {
      upd(path, value);
    }
    showMsg(`已应用「${fieldLabel(path)}」版本`);
  };

  const togglePicker = (path: string) => {
    setExpandedPickers(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderVersions = (path: string) => {
    const versions = fieldVersions.get(path);
    if (!versions || versions.length < 2) return null;
    const expanded = expandedPickers.has(path);
    const currentFlat = flattenFields(editDraft);
    const currentVal = (currentFlat.get(path) ?? '').trim();
    return (
      <div style={{ marginTop: '0.1rem', marginBottom: '0.2rem' }}>
        <button
          onClick={() => togglePicker(path)}
          className="id-btn sm"
          style={{ fontSize: '0.62rem', padding: '0.1rem 0.35rem', color: 'var(--cyan)', opacity: 0.85 }}
        >
          📋 {versions.length}个版本 {expanded ? '▲' : '▼'}
        </button>
        {expanded && (
          <div style={{ marginTop: '0.2rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            {versions.map((v, i) => {
              const isActive = v.value.trim() === currentVal;
              return (
                <button
                  key={i}
                  onClick={() => applyVersion(path, v.value)}
                  style={{
                    textAlign: 'left',
                    background: isActive ? 'rgba(93,173,226,0.12)' : 'rgba(0,0,0,0.15)',
                    border: `1px solid ${isActive ? 'var(--cyan)' : 'var(--border-soft)'}`,
                    borderRadius: '4px',
                    padding: '0.25rem 0.35rem',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.1rem' }}>
                    <span style={{ fontSize: '0.62rem', color: isActive ? 'var(--cyan)' : 'var(--text-mute)', fontWeight: isActive ? 600 : 400 }}>
                      {v.source}{isActive ? ' ✓' : ''}
                    </span>
                    {v.updatedAt && (
                      <span style={{ fontSize: '0.58rem', color: 'var(--text-mute)' }}>
                        {new Date(v.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  <div style={{
                    fontSize: '0.72rem',
                    color: 'var(--text-dim)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: '4.5rem',
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                  }}>
                    {path === 'avatar' && v.value ? (
                      <>
                        <img src={imageUrl(v.value)} alt="" style={{ width: '2.6rem', height: '2.6rem', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} onError={e => (e.currentTarget.style.display = 'none')} />
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', wordBreak: 'break-all' }}>{v.value}</span>
                      </>
                    ) : (
                      <span style={{
                        maxHeight: '4.5rem',
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: 'vertical',
                      }}>{v.value}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  if (editing && editDraft) {
    const d = editDraft;
    return (
      <div>
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={() => { setEditing(null); setEditDraft(null); }}>←</button>
          <span className="id-appbar-title">编辑 · {d.name || editing.name}</span>
        </div>
        <div className="id-app-scroll">
          {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>{msg}</div>}

          {/* 从玩家副本加载 */}
          {overrides.length > 0 && (
            <div className="id-card" style={{ padding: '0.5rem 0.6rem', marginBottom: '0.5rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-mute)' }}>
                玩家副本
              </div>
              {overrides.map(o => {
                let diffCount = '';
                try {
                  const over = JSON.parse(o.characterData);
                  const d = computeDiff(editDraft, over);
                  diffCount = d.length > 0 ? `${d.length}处不同` : '完全一致';
                } catch { diffCount = '?'; }
                return (
                  <div key={o.id} style={{ marginBottom: '0.3rem' }}>
                    <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                      <button
                        className="id-btn sm"
                        style={{ flex: 1, textAlign: 'left', justifyContent: 'flex-start' }}
                        onClick={() => {
                          try {
                            setEditDraft(JSON.parse(o.characterData));
                            showMsg(`已加载 ${o.playerName} 的副本`);
                          } catch {
                            showMsg('加载失败：JSON格式无效');
                          }
                        }}
                      >
                        {o.playerName}
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-mute)', marginLeft: '0.4rem' }}>
                          {new Date(o.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </button>
                      <button
                        className="id-btn sm"
                        style={{ flexShrink: 0, fontSize: '0.7rem', color: diffCount === '完全一致' ? 'var(--text-mute)' : 'var(--cyan)' }}
                        onClick={() => {
                          try {
                            const over = JSON.parse(o.characterData);
                            const d = computeDiff(editDraft, over);
                            setDiffOverride({ playerName: o.playerName, diffs: d });
                          } catch {
                            showMsg('对比失败：JSON格式无效');
                          }
                        }}
                      >
                        {diffCount}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {loadingOverrides && <div className="id-loading" style={{ padding: '0.5rem' }}>加载玩家副本…</div>}

          {/* Diff 展示 */}
          {diffOverride && (
            <div className="id-card" style={{ padding: '0.6rem', marginBottom: '0.5rem', borderColor: 'var(--cyan)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                  差异 · {diffOverride.playerName}
                </span>
                <button className="id-btn sm" style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem' }} onClick={() => setDiffOverride(null)}>✕</button>
              </div>
              {diffOverride.diffs.length === 0 ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--text-mute)', textAlign: 'center', padding: '0.4rem' }}>
                  无差异，与当前编辑器内容完全一致
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {diffOverride.diffs.map((d, i) => (
                    <div key={i} style={{ fontSize: '0.78rem' }}>
                      <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: '0.15rem' }}>{d.label}</div>
                      {d.label === 'avatar' ? (
                        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                          {(d.oldVal ? [
                            <div key="old" style={{ color: 'var(--text-mute)', opacity: 0.75, textDecoration: 'line-through' }}>
                              {d.oldVal}
                              <div><img src={imageUrl(d.oldVal)} alt="" style={{ width: '3rem', height: '3rem', borderRadius: '50%', objectFit: 'cover', marginTop: '0.2rem' }} onError={e => (e.currentTarget.style.display = 'none')} /></div>
                            </div>,
                          ] : null)}
                          {(d.newVal ? [
                            <div key="new" style={{ color: 'var(--cyan)' }}>
                              {d.newVal}
                              <div><img src={imageUrl(d.newVal)} alt="" style={{ width: '3rem', height: '3rem', borderRadius: '50%', objectFit: 'cover', marginTop: '0.2rem' }} onError={e => (e.currentTarget.style.display = 'none')} /></div>
                            </div>,
                          ] : null)}
                        </div>
                      ) : (
                        <>
                          {d.oldVal && (
                            <div style={{ color: 'var(--text-mute)', textDecoration: 'line-through', opacity: 0.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                              {d.oldVal}
                            </div>
                          )}
                          {d.newVal && (
                            <div style={{ color: 'var(--cyan)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                              {d.newVal}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="id-creation-card" style={{ padding: '0.6rem' }}>
            {/* 头像 */}
            <div className="id-card-section">
              <div className="id-card-row">
                <label>头像</label>
                <ImageUploadButton
                  square
                  onUploaded={(path) => upd('avatar', path)}
                  onClear={() => upd('avatar', '')}
                  value={d.avatar}
                />
                {renderVersions('avatar')}
              </div>
            </div>

            {/* 基本信息 */}
            <div className="id-card-section">
              <div className="id-card-row">
                <label>名字</label>
                <input value={d.name ?? ''} onChange={e => upd('name', e.target.value)} />
                {renderVersions('name')}
              </div>
              <div className="id-card-row">
                <label>年龄</label>
                <input value={d.age ?? ''} onChange={e => upd('age', e.target.value)} />
                {renderVersions('age')}
              </div>
              <div className="id-card-row">
                <label>外貌</label>
                <AutoTextarea value={d.appearance ?? ''} onChange={e => upd('appearance', e.target.value)} />
                {renderVersions('appearance')}
              </div>
            </div>

            {/* 性格三层 */}
            <div className="id-card-section">
              <div className="id-card-section-title">性格</div>
              {(['surface', 'core', 'extreme'] as const).map(k => (
                <div className="id-card-row" key={k}>
                  <label>{k === 'surface' ? '表层' : k === 'core' ? '内核' : '极端'}</label>
                  <AutoTextarea value={d.personality?.[k] ?? ''} onChange={e => upd(`personality.${k}`, e.target.value)} />
                  {renderVersions(`personality.${k}`)}
                </div>
              ))}
            </div>

            {/* 说话风格 */}
            <div className="id-card-section">
              <div className="id-card-section-title">说话风格</div>
              <div className="id-card-row">
                <label>概述</label>
                <AutoTextarea value={d.speechStyle?.description ?? ''} onChange={e => upd('speechStyle.description', e.target.value)} />
                {renderVersions('speechStyle.description')}
              </div>
              {(d.speechStyle?.examples ?? []).map((ex: any, i: number) => (
                <div className="id-card-row" key={i}>
                  <label>台词{i + 1}{ex.context ? `（${ex.context}）` : ''}</label>
                  <input
                    value={ex.line ?? ''}
                    onChange={e => {
                      const arr = [...(d.speechStyle?.examples ?? [])];
                      arr[i] = { ...arr[i], line: e.target.value };
                      upd('speechStyle.examples', arr);
                    }}
                  />
                  {renderVersions(`speechStyle.examples[${i}].line`)}
                </div>
              ))}
            </div>

            {/* 短信风格 */}
            <div className="id-card-section">
              <div className="id-card-section-title">短信风格</div>
              <div className="id-card-row">
                <label>概述</label>
                <AutoTextarea value={d.textingStyle?.description ?? ''} onChange={e => upd('textingStyle.description', e.target.value)} />
                {renderVersions('textingStyle.description')}
              </div>
              {(d.textingStyle?.examples ?? []).map((ex: string, i: number) => (
                <div className="id-card-row" key={i}>
                  <label>短信{i + 1}</label>
                  <input
                    value={ex}
                    onChange={e => {
                      const arr = [...(d.textingStyle?.examples ?? [])];
                      arr[i] = e.target.value;
                      upd('textingStyle.examples', arr);
                    }}
                  />
                  {renderVersions(`textingStyle.examples[${i}]`)}
                </div>
              ))}
            </div>

            {/* 情绪信号 */}
            <div className="id-card-section">
              <div className="id-card-section-title">情绪信号</div>
              {(['nervous', 'happy', 'angry', 'moved', 'defensive'] as const).map(k => {
                const labels: Record<string, string> = { nervous: '紧张', happy: '开心', angry: '愤怒', moved: '感动', defensive: '防御' };
                return (
                  <div className="id-card-row" key={k}>
                    <label>{labels[k]}</label>
                    <AutoTextarea value={d.emotional_signals?.[k] ?? ''} onChange={e => upd(`emotional_signals.${k}`, e.target.value)} />
                    {renderVersions(`emotional_signals.${k}`)}
                  </div>
                );
              })}
            </div>

            {/* 背景 */}
            <div className="id-card-section">
              <div className="id-card-section-title">背景</div>
              {(['origin', 'shaping', 'current'] as const).map(k => {
                const labels: Record<string, string> = { origin: '出身', shaping: '经历', current: '现状' };
                return (
                  <div className="id-card-row" key={k}>
                    <label>{labels[k]}</label>
                    <AutoTextarea value={d.background?.[k] ?? ''} onChange={e => upd(`background.${k}`, e.target.value)} />
                    {renderVersions(`background.${k}`)}
                  </div>
                );
              })}
            </div>

            {/* 其他 */}
            <div className="id-card-section">
              <div className="id-card-row">
                <label>喜好</label>
                <input
                  value={Array.isArray(d.likes) ? d.likes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''}
                  onChange={e => upd('likes', e.target.value.split('、').filter(Boolean))}
                />
                {renderVersions('likes')}
              </div>
              <div className="id-card-row">
                <label>厌恶</label>
                <input
                  value={Array.isArray(d.dislikes) ? d.dislikes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''}
                  onChange={e => upd('dislikes', e.target.value.split('、').filter(Boolean))}
                />
                {renderVersions('dislikes')}
              </div>
              <div className="id-card-row">
                <label>底线</label>
                <AutoTextarea value={d.boundaries ?? ''} onChange={e => upd('boundaries', e.target.value)} />
                {renderVersions('boundaries')}
              </div>
              <div className="id-card-row">
                <label>目标</label>
                <AutoTextarea value={d.goals ?? ''} onChange={e => upd('goals', e.target.value)} />
                {renderVersions('goals')}
              </div>
              <div className="id-card-row">
                <label>怪癖</label>
                <AutoTextarea value={d.quirks ?? ''} onChange={e => upd('quirks', e.target.value)} />
                {renderVersions('quirks')}
              </div>
              <div className="id-card-row">
                <label>与玩家的关系</label>
                <AutoTextarea value={d.player_relation ?? ''} onChange={e => upd('player_relation', e.target.value)} placeholder="无特殊关系则留空" />
                {renderVersions('player_relation')}
              </div>
              <div className="id-card-row">
                <label>擅长</label>
                <AutoTextarea value={d.skills ?? ''} onChange={e => upd('skills', e.target.value)} placeholder="战斗、生活技能、知识领域、社交特长……" />
                {renderVersions('skills')}
              </div>
              <div className="id-card-row">
                <label>不擅长</label>
                <AutoTextarea value={d.ineptitudes ?? ''} onChange={e => upd('ineptitudes', e.target.value)} placeholder="软肋、不感兴趣、总做不好的事……" />
                {renderVersions('ineptitudes')}
              </div>
            </div>

            {/* 里程碑（可编辑+重新生成） */}
            <div className="id-card-section">
              <div className="id-card-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>背景里程碑</span>
                <button
                  className="id-btn sm"
                  style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', color: 'var(--cyan)' }}
                  onClick={async () => {
                    try {
                      showMsg('生成中…');
                      const data = await api.adminRegenerateMilestones(editing.id);
                      upd('backstory_milestones', data.milestones);
                      showMsg(`生成了${data.milestones.length}条里程碑`);
                    } catch {
                      showMsg('生成失败');
                    }
                  }}
                >↻ 重新生成</button>
              </div>
              {(!Array.isArray(d.backstory_milestones) || d.backstory_milestones.length === 0) && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)', padding: '0.2rem 0' }}>暂无里程碑，点击「重新生成」</div>
              )}
              {Array.isArray(d.backstory_milestones) && d.backstory_milestones.map((m: any, i: number) => (
                <div key={i} className="id-card-row" style={{ position: 'relative' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <input
                      value={m.label ?? ''}
                      onChange={e => {
                        const arr = [...(d.backstory_milestones ?? [])];
                        arr[i] = { ...arr[i], label: e.target.value };
                        upd('backstory_milestones', arr);
                      }}
                      style={{ flex: 1, fontSize: '0.85rem', fontWeight: 600 }}
                      placeholder="事件简称"
                    />
                    <input
                      value={m.time_description ?? ''}
                      onChange={e => {
                        const arr = [...(d.backstory_milestones ?? [])];
                        arr[i] = { ...arr[i], time_description: e.target.value };
                        upd('backstory_milestones', arr);
                      }}
                      style={{ width: '5rem', fontSize: '0.75rem', color: 'var(--text-mute)' }}
                      placeholder="时间"
                    />
                  </label>
                  <AutoTextarea
                    value={m.summary ?? ''}
                    onChange={e => {
                      const arr = [...(d.backstory_milestones ?? [])];
                      arr[i] = { ...arr[i], summary: e.target.value };
                      upd('backstory_milestones', arr);
                    }}
                    placeholder="事件概述（2-3句）"
                  />
                  <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', marginTop: '0.2rem' }}>
                    <select
                      value={m.dramatic_potential ?? 'medium'}
                      onChange={e => {
                        const arr = [...(d.backstory_milestones ?? [])];
                        arr[i] = { ...arr[i], dramatic_potential: e.target.value };
                        upd('backstory_milestones', arr);
                      }}
                      style={{ fontSize: '0.7rem', background: 'var(--card-bg)', color: 'var(--text-dim)', border: '1px solid var(--border-soft)', borderRadius: '4px', padding: '0.1rem 0.3rem' }}
                    >
                      <option value="high">★ 关键转折</option>
                      <option value="medium">普通</option>
                      <option value="low">次要</option>
                    </select>
                    <button
                      className="id-btn sm"
                      style={{ fontSize: '0.65rem', padding: '0.1rem 0.3rem', color: 'var(--text-mute)' }}
                      onClick={() => {
                        const arr = (d.backstory_milestones ?? []).filter((_: any, j: number) => j !== i);
                        upd('backstory_milestones', arr);
                      }}
                    >删除</button>
                  </div>
                </div>
              ))}
              <button
                className="id-btn sm"
                style={{ fontSize: '0.7rem', marginTop: '0.2rem', color: 'var(--text-mute)' }}
                onClick={() => {
                  const arr = [...(d.backstory_milestones ?? []), { label: '', time_description: '', summary: '', diff: {}, dramatic_potential: 'medium' }];
                  upd('backstory_milestones', arr);
                }}
              >+ 添加里程碑</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', padding: '0.6rem', paddingTop: 0 }}>
            <button className="id-btn primary sm" style={{ flex: 1 }} onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="id-btn sm" style={{ flex: 1 }} onClick={() => { setEditing(null); setEditDraft(null); }}>取消</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>{msg}</div>}
      {loading ? (
        <div className="id-loading">加载中…</div>
      ) : npcs.length === 0 ? (
        <div className="id-empty"><span>🍃</span><span>暂无公共NPC</span></div>
      ) : (
        npcs.map(npc => {
          const npcAvatar = npc.avatar || '';  // 后端 safeAvatar 统一兜底：缺失返回空串→显示首字
          return (
          <div key={npc.id} className="id-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div className="id-thread-avatar">
                  {npcAvatar ? (
                    <img src={imageUrl(npcAvatar)} alt="" className="id-thread-avatar-img" />
                  ) : (
                    (npc.name?.[0] ?? '?')
                  )}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '1rem' }}>{npc.name}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-mute)', fontFamily: 'var(--font-mono)', marginTop: '0.2rem' }}>
                    {npc.id.slice(0, 8)}…
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button className="id-btn sm" onClick={() => startEdit(npc)}>编辑</button>
                {confirmDelete === npc.id ? (
                  <>
                    <button className="id-btn danger sm" onClick={() => handleDelete(npc.id)}>确认</button>
                    <button className="id-btn sm" onClick={() => setConfirmDelete(null)}>取消</button>
                  </>
                ) : (
                  <button className="id-btn sm" style={{ color: 'var(--text-mute)' }} onClick={() => setConfirmDelete(npc.id)}>删除</button>
                )}
              </div>
            </div>
          </div>
          );
        })
      )}
    </>
  );
}
