import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { ScenarioInfo, StatsConfigItem, NpcRoleSlot } from '../lib/api';

const FIELDS: { key: string; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: 'worldview', label: '世界观', placeholder: '世界设定、规则、氛围...', multiline: true },
  { key: 'player_role', label: '玩家身份', placeholder: '玩家在世界中的角色...' },
  { key: 'opening_scene', label: '开局情境', placeholder: '两人一上来面对的状况...', multiline: true },
  { key: 'goal', label: '目标', placeholder: '可选，文字目标或数值目标...' },
];

export function ScenarioEditor({
  scenarioId,
  onBack,
}: {
  scenarioId?: string;
  onBack: () => void;
}) {
  const [scenario, setScenario] = useState<ScenarioInfo | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<StatsConfigItem[]>([]);
  const [npcRoles, setNpcRoles] = useState<NpcRoleSlot[]>([]);
  const [greetings, setGreetings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rolling, setRolling] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadScenario = useCallback(async () => {
    if (!scenarioId) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.getScenario(scenarioId);
      setScenario(data.scenario);
      setTitle(data.scenario.title);
      setDescription(data.scenario.description);
      setFields({
        worldview: data.scenario.worldview,
        player_role: data.scenario.playerRole,
        opening_scene: data.scenario.openingScene,
        goal: data.scenario.goal,
      });
      setStats(data.scenario.statsConfig);
      setNpcRoles(data.scenario.npcRoles ?? []);
      setGreetings(data.scenario.greetings ?? []);
    } catch {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  }, [scenarioId]);

  useEffect(() => { loadScenario(); }, [loadScenario]);

  const handleCreate = async () => {
    if (!title.trim() || !description.trim()) return;
    setSaving(true);
    try {
      const data = await api.createScenario({ title: title.trim(), description: description.trim() });
      window.location.hash = '';
      const scenarioData = await api.getScenario(data.scenarioId);
      setScenario(scenarioData.scenario);
      setFields({});
      setStats(scenarioData.scenario.statsConfig);
      // 新剧本默认1个空角色槽位
      const defaultRoles = [{ identity: '', description: '' }];
      const defaultGreetings = [''];
      setNpcRoles(defaultRoles);
      setGreetings(defaultGreetings);
      await api.updateScenario(data.scenarioId, {
        npc_roles: JSON.stringify(defaultRoles),
        greetings: JSON.stringify(defaultGreetings),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveField = async (key: string, value: string) => {
    if (!scenario) return;
    try {
      const data: Record<string, string> = {};
      data[key] = value;
      await api.updateScenario(scenario.id, data);
      setScenario(prev => prev ? { ...prev, [key === 'player_role' ? 'playerRole' : key === 'opening_scene' ? 'openingScene' : key]: value } : prev);
    } catch {
      setError('保存失败');
    }
  };

  const handleRoll = async (key: string) => {
    if (!scenario) return;
    setRolling(key);
    setError('');
    try {
      const data = await api.rollScenarioField(scenario.id, key);
      setFields(prev => ({ ...prev, [key]: data.value }));
      await handleSaveField(key, data.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setRolling(null);
    }
  };

  const handleRollStats = async () => {
    if (!scenario) return;
    setRolling('stats');
    setError('');
    try {
      const data = await api.rollScenarioStats(scenario.id);
      setStats(data.stats);
      await api.updateScenario(scenario.id, { stats_config: JSON.stringify(data.stats) });
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setRolling(null);
    }
  };

  const handleRollNpcRoles = async () => {
    if (!scenario) return;
    setRolling('npc-roles');
    setError('');
    try {
      const data = await api.rollScenarioNpcRoles(scenario.id);
      setNpcRoles(data.npcRoles);
      await api.updateScenario(scenario.id, { npc_roles: JSON.stringify(data.npcRoles) });
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setRolling(null);
    }
  };

  const handleSaveNpcRole = async (index: number, field: 'identity' | 'description', value: string) => {
    if (!scenario) return;
    const updated = [...npcRoles];
    if (!updated[index]) updated[index] = { identity: '', description: '' };
    updated[index] = { ...updated[index], [field]: value };
    setNpcRoles(updated);
    try {
      await api.updateScenario(scenario.id, { npc_roles: JSON.stringify(updated) });
    } catch {
      setError('保存失败');
    }
  };

  const handleSaveGreeting = async (index: number, value: string) => {
    if (!scenario) return;
    const updated = [...greetings];
    while (updated.length < npcRoles.length) updated.push('');
    updated[index] = value;
    setGreetings(updated);
    try {
      await api.updateScenario(scenario.id, { greetings: JSON.stringify(updated) });
    } catch {
      setError('保存失败');
    }
  };

  const handleAddNpcRole = async () => {
    if (!scenario) return;
    const updatedRoles = [...npcRoles, { identity: '', description: '' }];
    const updatedGreetings = [...greetings, ''];
    setNpcRoles(updatedRoles);
    setGreetings(updatedGreetings);
    try {
      await api.updateScenario(scenario.id, {
        npc_roles: JSON.stringify(updatedRoles),
        greetings: JSON.stringify(updatedGreetings),
      });
    } catch {
      setError('保存失败');
    }
  };

  const handleRemoveNpcRole = async (index: number) => {
    if (!scenario) return;
    const updatedRoles = npcRoles.filter((_, i) => i !== index);
    const updatedGreetings = greetings.filter((_, i) => i !== index);
    setNpcRoles(updatedRoles);
    setGreetings(updatedGreetings);
    try {
      await api.updateScenario(scenario.id, {
        npc_roles: JSON.stringify(updatedRoles),
        greetings: JSON.stringify(updatedGreetings),
      });
    } catch {
      setError('保存失败');
    }
  };

  const handlePublish = async () => {
    if (!scenario) return;
    if (npcRoles.length === 0 || npcRoles.some(r => !r.description.trim())) {
      setError('请至少填写1个角色槽位（描述不能为空）');
      return;
    }
    try {
      await api.updateScenario(scenario.id, { status: 'published' });
      setScenario(prev => prev ? { ...prev, status: 'published' } : prev);
    } catch {
      setError('发布失败');
    }
  };

  const handleDelete = async () => {
    if (!scenario) return;
    if (!confirm('确定删除这个剧本？')) return;
    try {
      await api.deleteScenario(scenario.id);
      onBack();
    } catch {
      setError('删除失败');
    }
  };

  if (loading) return <div className="id-app"><div className="id-empty">加载中...</div></div>;

  // 新建模式
  if (!scenario) {
    return (
      <div className="id-app id-scenario-editor">
        <div className="id-appbar">
          <button className="id-appbar-back" onClick={onBack}>←</button>
          <span className="id-appbar-title">创建剧本</span>
        </div>
        <div className="id-scenario-form">
          <label>
            <span>剧本名 *</span>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="给你的剧本起个名字" />
          </label>
          <label>
            <span>简介 *</span>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="一句话介绍，让其他玩家知道这个剧本讲什么" />
          </label>
          {error && <div className="id-error-text">{error}</div>}
          <button
            className="id-scenario-create-submit"
            disabled={!title.trim() || !description.trim() || saving}
            onClick={handleCreate}
          >{saving ? '创建中...' : '创建'}</button>
        </div>
      </div>
    );
  }

  // 编辑模式
  return (
    <div className="id-app id-scenario-editor">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">编辑剧本</span>
        <span className={`id-scenario-badge ${scenario.status}`}>{scenario.status === 'published' ? '已发布' : '草稿'}</span>
      </div>

      <div className="id-scenario-form">
        <label>
          <span>剧本名</span>
          <div className="id-field-row">
            <input value={title} onChange={e => setTitle(e.target.value)} onBlur={() => handleSaveField('title', title)} />
          </div>
        </label>

        <label>
          <span>简介</span>
          <div className="id-field-row">
            <textarea value={description} onChange={e => setDescription(e.target.value)} onBlur={() => handleSaveField('description', description)} />
          </div>
        </label>

        {FIELDS.map(f => (
          <label key={f.key}>
            <span>{f.label}</span>
            <div className="id-field-row">
              {f.multiline ? (
                <textarea
                  value={fields[f.key] ?? ''}
                  onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                  onBlur={e => handleSaveField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                />
              ) : (
                <input
                  value={fields[f.key] ?? ''}
                  onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                  onBlur={e => handleSaveField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                />
              )}
              <button
                className="id-roll-btn"
                disabled={rolling === f.key}
                onClick={() => handleRoll(f.key)}
              >{rolling === f.key ? '...' : 'Roll'}</button>
            </div>
          </label>
        ))}

        {/* 数值系统 */}
        <label>
          <div className="id-field-row id-stats-header">
            <span>数值系统</span>
            <button
              className="id-roll-btn"
              disabled={rolling === 'stats'}
              onClick={handleRollStats}
            >{rolling === 'stats' ? '...' : 'Roll数值'}</button>
          </div>
          {stats.length > 0 ? (
            <div className="id-stats-list">
              {stats.map((s, i) => (
                <div key={i} className="id-stats-item">
                  <div className="id-stats-item-header">
                    <strong>{s.name}</strong>
                    <span>初始{s.initial}{s.target != null ? ` / 目标${s.target}` : ''}</span>
                  </div>
                  <p>{s.rules}</p>
                </div>
              ))}
              <button className="id-stats-clear" onClick={async () => {
                setStats([]);
                await api.updateScenario(scenario.id, { stats_config: '[]' });
              }}>清除数值</button>
            </div>
          ) : (
            <p className="id-field-hint">未设置数值系统（可选）</p>
          )}
        </label>

        {/* 角色槽位 */}
        <label>
          <div className="id-field-row id-stats-header">
            <span>角色槽位</span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                className="id-roll-btn"
                disabled={rolling === 'npc-roles'}
                onClick={handleRollNpcRoles}
              >{rolling === 'npc-roles' ? '...' : 'Roll角色'}</button>
              <button
                className="id-roll-btn"
                onClick={handleAddNpcRole}
              >+添加</button>
            </div>
          </div>
          {npcRoles.length > 0 ? (
            <div className="id-stats-list">
              {npcRoles.map((role, i) => (
                <div key={i} className="id-stats-item">
                  <div className="id-stats-item-header">
                    <strong>角色 {i + 1}{role.identity ? ` · ${role.identity}` : ''}</strong>
                    <button
                      className="id-stats-clear"
                      style={{ fontSize: '12px' }}
                      onClick={() => handleRemoveNpcRole(i)}
                    >删除</button>
                  </div>
                  <input
                    value={role.identity ?? ''}
                    onChange={e => {
                      const updated = [...npcRoles];
                      if (!updated[i]) updated[i] = { identity: '', description: '' };
                      updated[i] = { ...updated[i], identity: e.target.value };
                      setNpcRoles(updated);
                    }}
                    onBlur={e => handleSaveNpcRole(i, 'identity', e.target.value)}
                    placeholder="简短身份标签（如：未婚夫、前任、青梅竹马）"
                    style={{ width: '100%', marginBottom: '6px' }}
                  />
                  <textarea
                    value={role.description}
                    onChange={e => {
                      const updated = [...npcRoles];
                      if (!updated[i]) updated[i] = { identity: '', description: '' };
                      updated[i] = { ...updated[i], description: e.target.value };
                      setNpcRoles(updated);
                    }}
                    onBlur={e => handleSaveNpcRole(i, 'description', e.target.value)}
                    placeholder="这个NPC在剧本中的身份与能力..."
                    style={{ width: '100%', minHeight: '60px', resize: 'vertical' }}
                  />
                  <textarea
                    value={greetings[i] ?? ''}
                    onChange={e => {
                      const updated = [...greetings];
                      while (updated.length < npcRoles.length) updated.push('');
                      updated[i] = e.target.value;
                      setGreetings(updated);
                    }}
                    onBlur={e => handleSaveGreeting(i, e.target.value)}
                    placeholder="该角色开场白（进入剧本后说的第一句话，可选）..."
                    style={{ width: '100%', minHeight: '40px', resize: 'vertical', marginTop: '6px' }}
                  />
                </div>
              ))}
              <p className="id-field-hint">默认1个角色=单人剧本，添加更多=多人剧本。</p>
            </div>
          ) : (
            <p className="id-field-hint">点击"+添加"创建角色槽位</p>
          )}
        </label>

        {error && <div className="id-error-text">{error}</div>}

        <div className="id-scenario-actions">
          <button
            className="id-scenario-publish"
            disabled={scenario.status === 'published'}
            onClick={handlePublish}
          >{scenario.status === 'published' ? '已发布' : '发布剧本'}</button>
          <button className="id-scenario-delete" onClick={handleDelete}>删除</button>
        </div>
      </div>
    </div>
  );
}
