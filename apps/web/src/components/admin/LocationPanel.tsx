import React, { useState, useEffect } from 'react';
import { api, imageUrl } from '../../lib/api';
import type { SceneLocationEntry, SceneNpc } from './types';
import { ImageUploadButton } from '../ImageUploadButton';

/**
 * 管理端「地点」页签 —— 新地图(scene_locations)地点管理。
 * 含：树形层级展示、创建/移动/删除、家归属(scene_homes)、常驻路人(npcs)、
 *     活动池(activities)、背景图(background+玩家提交池)。
 * （合并了旧「地图活动」页签的能力，旧 locations 表不再管理。）
 */
export function LocationPanel() {
  const [locations, setLocations] = useState<SceneLocationEntry[]>([]);
  const [allNpcs, setAllNpcs] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<SceneLocationEntry | null>(null);
  const [generating, setGenerating] = useState(false);
  const [confirmRemoveNpc, setConfirmRemoveNpc] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [movingId, setMovingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newParent, setNewParent] = useState('');
  const [creating, setCreating] = useState(false);

  // 活动池：新建/编辑一条时的草稿
  const [newAct, setNewAct] = useState('');
  // 添加路人草稿
  const [npcRole, setNpcRole] = useState('');
  const [npcName, setNpcName] = useState('');
  const [npcPersona, setNpcPersona] = useState('');
  // 编辑某个路人时的草稿 { npcId, role, name, persona }
  const [editingNpc, setEditingNpc] = useState<{ npcId: string; role: string; name: string; persona: string } | null>(null);
  // 隐藏玩家创建的私有地点
  const [hidePrivate, setHidePrivate] = useState(true);
  // 编辑某个地点信息时的草稿
  const [editLocDraft, setEditLocDraft] = useState<{ name: string; summary: string } | null>(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [locData, npcData] = await Promise.all([
        api.adminListLocations(),
        api.adminListCharacters(),
      ]);
      setLocations(locData.locations);
      setAllNpcs(npcData.characters.map(c => ({ id: c.id, name: c.name })));
    } catch {
      setMsg('加载失败');
    } finally {
      setLoading(false);
    }
  };

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const refreshEditing = async () => {
    if (!editing) return;
    const updated = (await api.adminListLocations()).locations.find(l => l.id === editing.id);
    if (updated) setEditing(updated);
  };

  const handleUpdateLoc = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!editing || !editLocDraft) return;
    try {
      await api.adminUpdateLocation(editing.id, {
        name: editLocDraft.name.trim(),
        summary: editLocDraft.summary.trim(),
      });
      showMsg('已保存地点');
      setEditLocDraft(null);
      await load();
      await refreshEditing();
    } catch { showMsg('保存失败'); }
  };

  const handleMove = async (locationId: string, targetParentId: string | null) => {
    try {
      await api.adminMoveLocation(locationId, targetParentId);
      showMsg('已移动');
      setMovingId(null);
      await load();
    } catch (e) {
      const err = e as Error & { body?: { error?: string } };
      showMsg(err.body?.error || '移动失败');
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.adminCreateLocation({
        name: newName.trim(),
        summary: newSummary.trim() || undefined,
        isPublic: true,
        parentId: newParent || null,
      });
      showMsg('已创建');
      setShowCreate(false);
      setNewName(''); setNewSummary(''); setNewParent('');
      await load();
    } catch {
      showMsg('创建失败');
    } finally {
      setCreating(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 路径名（用于移动目标选择）
  const buildPath = (loc: SceneLocationEntry): string => {
    let path = loc.name;
    let cur = loc;
    while (cur.parentId) {
      const parent = locations.find(l => l.id === cur.parentId);
      if (!parent) break;
      path = `${parent.name} › ${path}`;
      cur = parent;
    }
    return path;
  };

  // 检查 candidate 是否是 loc 的子孙（防止循环移动）
  const isDescendant = (candidate: SceneLocationEntry, ancestor: SceneLocationEntry): boolean => {
    let cur = candidate;
    while (cur.parentId) {
      if (cur.parentId === ancestor.id) return true;
      const parent = locations.find(l => l.id === cur.parentId);
      if (!parent) break;
      cur = parent;
    }
    return false;
  };

  const renderTreeNode = (loc: SceneLocationEntry, depth: number): React.ReactNode => {
    const children = locations.filter(l => l.parentId === loc.id && !(hidePrivate && l.creatorType === 'player' && !l.isPublic));
    const isExpanded = expanded.has(loc.id);
    const indent = depth * 1.2;

    return (
      <div key={loc.id}>
        <div className="id-card" style={{ cursor: 'pointer', marginLeft: `${indent}rem`, padding: '0.5rem 0.6rem' }}
          onClick={() => setEditing(loc)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                {children.length > 0 && (
                  <span onClick={(e) => { e.stopPropagation(); toggleExpand(loc.id); }}
                    style={{ cursor: 'pointer', fontSize: '0.7rem', color: 'var(--text-mute)', width: '1rem', textAlign: 'center' }}>
                    {isExpanded ? '▼' : '▶'}
                  </span>
                )}
                {children.length === 0 && <span style={{ width: '1rem' }} />}
                <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{loc.name}</span>
                {loc.childrenCount > 0 && (
                  <span style={{ fontSize: '0.62rem', color: 'var(--text-mute)' }}>📁{loc.childrenCount}</span>
                )}
                {loc.homeResidents.length > 0 && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--warm)', border: '1px solid var(--warm)', borderRadius: '3px', padding: '0 0.2rem' }}>🏠{loc.homeResidents.map(r => r.name).join('、')}</span>
                )}
                {loc.creatorType === 'system' && loc.homeResidents.length === 0 && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--sage)', border: '1px solid var(--sage)', borderRadius: '3px', padding: '0 0.2rem' }}>系统</span>
                )}
                {loc.creatorType !== 'system' && loc.isPublic && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--cyan)', border: '1px solid var(--cyan)', borderRadius: '3px', padding: '0 0.2rem' }}>公开</span>
                )}
                {loc.creatorType !== 'system' && !loc.isPublic && (
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-mute)', border: '1px solid var(--text-mute)', borderRadius: '3px', padding: '0 0.2rem' }}>私有</span>
                )}
              </div>
              {loc.summary && <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginTop: '0.15rem', paddingLeft: '1rem' }}>{loc.summary}</div>}
              {loc.npcs.length > 0 && (
                <div style={{ fontSize: '0.68rem', color: 'var(--text-mute)', marginTop: '0.15rem', paddingLeft: '1rem' }}>
                  {loc.npcs.map(n => `${n.role}·${n.name}`).join('、')}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.2rem', alignItems: 'center' }}>
              <button className="id-btn sm" style={{ fontSize: '0.68rem', color: 'var(--text-mute)', padding: '0.1rem 0.3rem' }}
                onClick={(e) => { e.stopPropagation(); setMovingId(movingId === loc.id ? null : loc.id); }}>
                {movingId === loc.id ? '取消' : '移动'}
              </button>
              <span style={{ color: 'var(--text-mute)', fontSize: '0.8rem' }}>→</span>
            </div>
          </div>
          {/* 移动目标选择器 */}
          {movingId === loc.id && (
            <div style={{ marginTop: '0.4rem', paddingLeft: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.4rem' }}
              onClick={(e) => e.stopPropagation()}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginBottom: '0.2rem' }}>移动到：</div>
              <select style={{ width: '100%' }}
                onChange={(e) => {
                  const val = e.target.value;
                  handleMove(loc.id, val === '' ? null : val);
                }}
                defaultValue="">
                <option value="">⬆ 顶层</option>
                {locations.filter(l => l.id !== loc.id && !isDescendant(l, loc) && !(hidePrivate && l.creatorType === 'player' && !l.isPublic)).map(l => (
                  <option key={l.id} value={l.id}>{buildPath(l)}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {isExpanded && children.map(c => renderTreeNode(c, depth + 1))}
      </div>
    );
  };

  // ── 详情编辑视图 ────────────────────────────────
  const saveActivities = async (acts: string[]) => {
    if (!editing) return;
    try {
      await api.adminSetSceneActivities(editing.id, acts);
      showMsg('已保存活动');
      await load();
      await refreshEditing();
    } catch { showMsg('保存失败'); }
  };

  const handleAddAct = async () => {
    if (!editing || !newAct.trim()) return;
    await saveActivities([...editing.activities, newAct.trim()]);
    setNewAct('');
  };

  const handleRemoveAct = async (idx: number) => {
    if (!editing) return;
    await saveActivities(editing.activities.filter((_, i) => i !== idx));
  };

  const handleGenerateActs = async () => {
    if (!editing) return;
    setGenerating(true);
    try {
      await api.adminGenerateSceneActivities(editing.id);
      showMsg('已生成');
      await load();
      await refreshEditing();
    } catch { showMsg('生成失败，请手填'); }
    finally { setGenerating(false); }
  };

  const handleAddNpc = async () => {
    if (!editing || !npcRole.trim() || !npcName.trim()) return;
    try {
      // 用玩家接口（upsertNpc，按 role 去重）
      await api.sceneAddNpc(editing.id, { role: npcRole.trim(), name: npcName.trim(), persona: npcPersona.trim() || undefined });
      showMsg('已添加路人');
      setNpcRole(''); setNpcName(''); setNpcPersona('');
      await load();
      await refreshEditing();
    } catch { showMsg('添加失败'); }
  };

  const handleRemoveNpc = async (npcId: string) => {
    if (!editing) return;
    try {
      await api.adminRemoveNpcFromLocation(editing.id, npcId);
      showMsg('已移除');
      setConfirmRemoveNpc(null);
      await load();
      await refreshEditing();
    } catch { showMsg('移除失败'); }
  };

  const handleUpdateNpc = async () => {
    if (!editing || !editingNpc || !editingNpc.role.trim() || !editingNpc.name.trim()) return;
    try {
      await api.adminUpdateNpcOnLocation(editing.id, editingNpc.npcId, {
        role: editingNpc.role.trim(),
        name: editingNpc.name.trim(),
        persona: editingNpc.persona.trim() || undefined,
      });
      showMsg('已保存路人');
      setEditingNpc(null);
      await load();
      await refreshEditing();
    } catch { showMsg('保存失败'); }
  };

  if (editing) {
    return (
      <div>
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={() => setEditing(null)}>←</button>
          <span className="id-appbar-title">📍 {editing.name}</span>
        </div>
        <div className="id-app-scroll">
          {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>{msg}</div>}

          <div className="id-card" style={{ padding: '0.6rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>
                {editing.creatorType === 'system' ? '系统地点' : editing.isPublic ? '公开地点' : '私有地点'}
                {editing.parentId && ' · 子地点'}
              </div>
              <button className="id-btn sm" style={{ fontSize: '0.68rem', color: 'var(--text-mute)', padding: '0.1rem 0.3rem' }}
                onClick={() => setEditLocDraft(editLocDraft ? null : { name: editing.name, summary: editing.summary })}>
                {editLocDraft ? '取消' : '编辑'}
              </button>
            </div>
            {editLocDraft ? (
              <form onSubmit={handleUpdateLoc}>
                <div className="id-card-row">
                  <label>名称</label>
                  <input value={editLocDraft.name} onChange={e => setEditLocDraft({ ...editLocDraft, name: e.target.value })} maxLength={30} />
                </div>
                <div className="id-card-row">
                  <label>描述</label>
                  <textarea value={editLocDraft.summary} onChange={e => setEditLocDraft({ ...editLocDraft, summary: e.target.value })}
                    maxLength={500} rows={3} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                    placeholder="这个地点是什么样的？" />
                </div>
                <button className="id-btn primary sm" style={{ width: '100%', marginTop: '0.3rem' }}
                  type="submit" disabled={!editLocDraft.name.trim()}>
                  保存
                </button>
              </form>
            ) : (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-mute)' }}>
                {editing.summary || '（暂无描述）'}
              </div>
            )}
          </div>

          {/* 家设置（多对多：一个地点可以是多个角色的家） */}
          <div className="id-card" style={{ padding: '0.6rem' }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>🏠 谁的家</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginBottom: '0.3rem' }}>
              夜间NPC会回到这里，一个角色只有一个家
            </div>
            {editing.homeResidents.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.4rem' }}>
                {editing.homeResidents.map(r => (
                  <span key={r.characterId} style={{ fontSize: '0.72rem', color: 'var(--warm)', border: '1px solid var(--warm)', borderRadius: '3px', padding: '0.15rem 0.3rem', display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                    {r.name}
                    <button onClick={async () => {
                      try { await api.adminRemoveHome(editing.id, r.characterId); showMsg(`已移除${r.name}的家`); await load(); await refreshEditing(); }
                      catch { showMsg('操作失败'); }
                    }} style={{ background: 'none', border: 'none', color: 'var(--warm)', cursor: 'pointer', padding: 0, fontSize: '0.9rem', lineHeight: 1 }}>×</button>
                  </span>
                ))}
              </div>
            )}
            <select value="" onChange={async e => {
              const charId = e.target.value;
              if (!charId) return;
              try { await api.adminSetHome(editing.id, charId); showMsg('已添加家归属'); await load(); await refreshEditing(); }
              catch { showMsg('设置失败'); }
            }} style={{ width: '100%' }}>
              <option value="">+ 添加住客…</option>
              {allNpcs.filter(n => !editing.homeResidents.some(r => r.characterId === n.id)).map(n => (
                <option key={n.id} value={n.id}>{n.name}</option>
              ))}
            </select>
          </div>

          {/* 常驻路人 */}
          <div className="id-card" style={{ padding: '0.6rem' }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>常驻路人（{editing.npcs.length}）</div>
            {editing.npcs.length === 0 ? (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-mute)', padding: '0.4rem 0' }}>暂无路人被分配到此处</div>
            ) : (
              editing.npcs.map(n => (
                <div key={n.id} style={{ borderBottom: '1px solid var(--border)', padding: '0.3rem 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>{n.role}·{n.name}</div>
                      {n.persona && <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)' }}>{n.persona}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                      <button className="id-btn sm" style={{ fontSize: '0.68rem', color: 'var(--text-mute)', padding: '0.1rem 0.3rem' }}
                        onClick={() => setEditingNpc(editingNpc?.npcId === n.id ? null : { npcId: n.id, role: n.role, name: n.name, persona: n.persona })}>
                        {editingNpc?.npcId === n.id ? '取消' : '编辑'}
                      </button>
                      {confirmRemoveNpc === n.id ? (
                        <>
                          <button className="id-btn danger sm" onClick={() => handleRemoveNpc(n.id)}>确认移除</button>
                          <button className="id-btn sm" onClick={() => setConfirmRemoveNpc(null)}>取消</button>
                        </>
                      ) : (
                        <button className="id-btn sm" style={{ color: 'var(--text-mute)' }} onClick={() => setConfirmRemoveNpc(n.id)}>移除</button>
                      )}
                    </div>
                  </div>
                  {editingNpc?.npcId === n.id && (
                    <div style={{ marginTop: '0.4rem', paddingLeft: '0.3rem' }}>
                      <div className="id-card-row">
                        <label>身份</label>
                        <input value={editingNpc.role} onChange={e => setEditingNpc({ ...editingNpc, role: e.target.value })} maxLength={20} />
                      </div>
                      <div className="id-card-row">
                        <label>名字</label>
                        <input value={editingNpc.name} onChange={e => setEditingNpc({ ...editingNpc, name: e.target.value })} maxLength={20} />
                      </div>
                      <div className="id-card-row">
                        <label>设定</label>
                        <input value={editingNpc.persona} onChange={e => setEditingNpc({ ...editingNpc, persona: e.target.value })} maxLength={200} placeholder="可选" />
                      </div>
                      <button className="id-btn primary sm" style={{ width: '100%', marginTop: '0.3rem' }}
                        onClick={handleUpdateNpc} disabled={!editingNpc.role.trim() || !editingNpc.name.trim()}>
                        保存
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
            <div className="id-card-row" style={{ marginTop: '0.3rem' }}>
              <label>身份</label>
              <input value={npcRole} onChange={e => setNpcRole(e.target.value)} placeholder="如：服务生、摊主" maxLength={20} />
            </div>
            <div className="id-card-row">
              <label>名字</label>
              <input value={npcName} onChange={e => setNpcName(e.target.value)} placeholder="如：小周" maxLength={20} />
            </div>
            <div className="id-card-row">
              <label>设定</label>
              <input value={npcPersona} onChange={e => setNpcPersona(e.target.value)} placeholder="可选" maxLength={200} />
            </div>
            <button className="id-btn primary sm" style={{ width: '100%', marginTop: '0.3rem' }} onClick={handleAddNpc} disabled={!npcRole.trim() || !npcName.trim()}>
              添加路人
            </button>
          </div>

          {/* 活动池 */}
          <div className="id-card" style={{ padding: '0.6rem' }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.2rem' }}>活动池（{editing.activities.length}）</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginBottom: '0.4rem' }}>
              角色的行程会从这组活动里随机抽取
            </div>
            {editing.activities.length === 0 ? (
              <div style={{ fontSize: '0.8rem', color: 'var(--text-mute)', padding: '0.3rem 0' }}>暂无活动，行程会显示「闲逛」</div>
            ) : (
              editing.activities.map((a, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.2rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '0.85rem' }}>· {a}</span>
                  <button className="id-btn sm" style={{ fontSize: '0.7rem', color: 'var(--text-mute)', padding: '0 0.3rem' }} onClick={() => handleRemoveAct(i)}>×</button>
                </div>
              ))
            )}
            <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.4rem' }}>
              <input value={newAct} onChange={e => setNewAct(e.target.value)} placeholder="如：在角落看书"
                onKeyDown={e => { if (e.key === 'Enter') handleAddAct(); }} />
              <button className="id-btn primary sm" style={{ flexShrink: 0 }} onClick={handleAddAct} disabled={!newAct.trim()}>添加</button>
            </div>
            <button className="id-btn sm" style={{ width: '100%', marginTop: '0.3rem' }} onClick={handleGenerateActs} disabled={generating}>
              {generating ? '生成中…' : '✨ LLM 生成一组活动'}
            </button>
          </div>

          {/* 背景图 */}
          <div className="id-card" style={{ padding: '0.6rem' }}>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>背景图</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginBottom: '0.4rem' }}>
              用作该地点约会聊天的聊天背景。留空 = 不显示背景
            </div>
            <ImageUploadButton
              value={editing.background}
              onUploaded={async (imagePath) => {
                try { await api.adminSetSceneBackground(editing.id, imagePath); showMsg('已保存背景'); await load(); await refreshEditing(); }
                catch { showMsg('保存背景失败'); }
              }}
              onClear={async () => {
                try { await api.adminSetSceneBackground(editing.id, ''); showMsg('已移除背景'); await load(); await refreshEditing(); }
                catch { showMsg('移除背景失败'); }
              }}
            />
            {editing.submissions.length > 0 && (
              <div style={{ marginTop: '0.5rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-mute)', marginBottom: '0.3rem' }}>
                  玩家提交（{editing.submissions.length}）· 点击设为公共版
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {editing.submissions.map((s, i) => (
                    <button
                      key={i}
                      onClick={async () => {
                        try { await api.adminSetSceneBackground(editing.id, s.image); showMsg(`已采用 ${s.uploaderId.slice(0, 4)}… 的提交`); await load(); await refreshEditing(); }
                        catch { showMsg('设置失败'); }
                      }}
                      style={{
                        position: 'relative', border: editing.background === s.image ? '2px solid var(--cyan)' : '1px solid var(--border)',
                        borderRadius: '6px', padding: 0, overflow: 'hidden', cursor: 'pointer', background: 'none',
                      }}
                    >
                      <img src={imageUrl(s.image)} alt="提交" style={{ width: '3rem', height: '3rem', objectFit: 'cover', display: 'block' }} />
                      {editing.background === s.image && <div style={{ position: 'absolute', top: 0, left: 0, background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '0.6rem', padding: '0 0.2rem' }}>当前</div>}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 删除地点 */}
          <button className="id-btn sm" style={{ width: '100%', color: 'var(--danger, #e57373)', borderColor: 'var(--danger, #e57373)' }}
            onClick={async () => {
              if (!confirm(`确定删除「${editing.name}」？`)) return;
              try {
                await api.adminDeleteLocation(editing.id);
                setEditing(null);
                await load();
              } catch (e) {
                const err = e as Error & { body?: { error?: string } };
                showMsg(err.body?.error || '删除失败');
              }
            }}>
            删除地点
          </button>
        </div>
      </div>
    );
  }

  // ── 列表视图 ────────────────────────────────
  return (
    <>
      {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem' }}>{msg}</div>}

      {/* 新建地点 */}
      <div className="id-card" style={{ padding: '0.6rem' }}>
        {showCreate ? (
          <>
            <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '0.4rem' }}>新建地点</div>
            <div className="id-card-row">
              <label>名称</label>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="如：星河公园" />
            </div>
            <div className="id-card-row">
              <label>描述</label>
              <input value={newSummary} onChange={e => setNewSummary(e.target.value)} placeholder="可选" />
            </div>
            <div className="id-card-row">
              <label>父地点</label>
              <select value={newParent} onChange={e => setNewParent(e.target.value)} style={{ width: '100%' }}>
                <option value="">⬆ 顶层</option>
                {locations.filter(l => !(hidePrivate && l.creatorType === 'player' && !l.isPublic)).map(l => (
                  <option key={l.id} value={l.id}>{buildPath(l)}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.3rem' }}>
              <button className="id-btn primary sm" style={{ flex: 1 }} onClick={handleCreate} disabled={creating || !newName.trim()}>
                {creating ? '创建中…' : '创建'}
              </button>
              <button className="id-btn sm" onClick={() => { setShowCreate(false); setNewName(''); setNewSummary(''); setNewParent(''); }}>取消</button>
            </div>
          </>
        ) : (
          <button className="id-btn primary sm" style={{ width: '100%' }} onClick={() => setShowCreate(true)}>
            ＋ 新建地点
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.2rem 0.6rem 0.4rem', fontSize: '0.8rem', color: 'var(--text-mute)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={hidePrivate} onChange={e => setHidePrivate(e.target.checked)} />
          隐藏私有地点
        </label>
      </div>

      {loading ? (
        <div className="id-loading">加载中…</div>
      ) : locations.filter(l => !l.parentId && !(hidePrivate && l.creatorType === 'player' && !l.isPublic)).length === 0 ? (
        <div className="id-empty"><span>🍃</span><span>暂无地点</span></div>
      ) : (
        locations
          .filter(l => !l.parentId && !(hidePrivate && l.creatorType === 'player' && !l.isPublic))
          .map(loc => renderTreeNode(loc, 0))
      )}
    </>
  );
}