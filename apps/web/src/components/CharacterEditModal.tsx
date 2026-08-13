/**
 * 角色卡编辑弹窗（普通用户版）
 *
 * - 加载角色数据（fork 优先）
 * - 编辑后保存为 fork（不覆盖原角色）
 * - 有 fork 时逐字段对比公共原版：改了的地方下方灰色显示原版值
 */
import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { AutoTextarea } from './AutoTextarea';
import { ImageUploadButton } from './ImageUploadButton';

type Draft = Record<string, any>;

/** 获取嵌套路径的值 */
function getPath(obj: any, path: string): any {
  if (!obj) return undefined;
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 把值规范化为可对比的字符串 */
function norm(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? x : `${x.item ?? ''}${x.reason ? '（' + x.reason + '）' : ''}`).join('、');
  return String(v);
}

/** 字段对比提示：值和原版不同时在编辑框下方显示原版值 */
function DiffHint({ original, current }: { original: any; current: any }) {
  const o = norm(original);
  const c = norm(current);
  if (!o || o === c) return null;
  return (
    <div style={{ fontSize: '0.6rem', color: 'var(--text-mute)', marginTop: '0.1rem', padding: '0.1rem 0.35rem', borderLeft: '2px solid var(--ember)', opacity: 0.8 }}>
      原版：{o}
    </div>
  );
}

export function CharacterEditModal({
  characterId,
  onClose,
  onSaved,
}: {
  characterId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [publicData, setPublicData] = useState<Draft | null>(null);
  const [hasFork, setHasFork] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getCharacterForEdit(characterId);
        if (cancelled) return;
        setDraft(data.characterData as Draft);
        setHasFork(data.hasFork);
        setIsPublic(data.isPublic);
        setPublicData(data.publicData as Draft ?? null);
      } catch (e) {
        if (!cancelled) setMsg((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [characterId]);

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const upd = (path: string, value: any) => {
    if (!draft) return;
    const keys = path.split('.');
    const next = JSON.parse(JSON.stringify(draft));
    let cur = next;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]!] = value;
    setDraft(next);
  };

  const handleSave = async () => {
    if (!draft || !draft.name?.trim()) return;
    setSaving(true);
    try {
      await api.forkCharacter(characterId, draft);
      showMsg('已保存');
      onSaved?.();
      setTimeout(() => onClose(), 800);
    } catch (e) {
      showMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // diff 辅助：获取原版对应路径的值
  const orig = (path: string) => publicData ? getPath(publicData, path) : undefined;
  const canDiff = hasFork && !!publicData;

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" style={{ maxWidth: '32rem', maxHeight: '85vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
        <div className="id-modal-title">
          编辑角色
          {isPublic && !hasFork && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-mute)', marginLeft: '0.4rem', fontWeight: 400 }}>
              保存后仅你可见
            </span>
          )}
          {hasFork && (
            <span style={{ fontSize: '0.7rem', color: 'var(--cyan)', marginLeft: '0.4rem', fontWeight: 400 }}>
              已有你的副本
            </span>
          )}
        </div>

        {loading ? (
          <div className="id-loading" style={{ padding: '1rem' }}>加载中…</div>
        ) : msg && !draft ? (
          <div className="id-modal-error">{msg}</div>
        ) : draft ? (
          <>
            {msg && <div className="id-card" style={{ borderColor: 'var(--cyan)', textAlign: 'center', fontSize: '0.85rem', padding: '0.4rem' }}>{msg}</div>}

            <div className="id-creation-card" style={{ padding: '0.6rem' }}>
              {/* 头像 */}
              <div className="id-card-section">
                <div className="id-card-row">
                  <label>头像</label>
                  <ImageUploadButton
                    square
                    onUploaded={(path) => upd('avatar', path)}
                    onClear={() => upd('avatar', '')}
                    value={draft.avatar}
                  />
                  {canDiff && <DiffHint original={orig('avatar')} current={draft.avatar} />}
                </div>
              </div>

              {/* 基本信息 */}
              <div className="id-card-section">
                <div className="id-card-row">
                  <label>名字</label>
                  <input value={draft.name ?? ''} onChange={e => upd('name', e.target.value)} />
                  {canDiff && <DiffHint original={orig('name')} current={draft.name} />}
                </div>
                <div className="id-card-row">
                  <label>年龄</label>
                  <input value={draft.age ?? ''} onChange={e => upd('age', e.target.value)} />
                  {canDiff && <DiffHint original={orig('age')} current={draft.age} />}
                </div>
                <div className="id-card-row">
                  <label>外貌</label>
                  <AutoTextarea value={draft.appearance ?? ''} onChange={e => upd('appearance', e.target.value)} />
                  {canDiff && <DiffHint original={orig('appearance')} current={draft.appearance} />}
                </div>
              </div>

              {/* 性格三层 */}
              <div className="id-card-section">
                <div className="id-card-section-title">性格</div>
                {(['surface', 'core', 'extreme'] as const).map(k => (
                  <div className="id-card-row" key={k}>
                    <label>{k === 'surface' ? '表层' : k === 'core' ? '内核' : '极端'}</label>
                    <AutoTextarea value={draft.personality?.[k] ?? ''} onChange={e => upd(`personality.${k}`, e.target.value)} />
                    {canDiff && <DiffHint original={orig(`personality.${k}`)} current={draft.personality?.[k]} />}
                  </div>
                ))}
              </div>

              {/* 说话风格 */}
              <div className="id-card-section">
                <div className="id-card-section-title">说话风格</div>
                <div className="id-card-row">
                  <label>概述</label>
                  <AutoTextarea value={draft.speechStyle?.description ?? ''} onChange={e => upd('speechStyle.description', e.target.value)} />
                  {canDiff && <DiffHint original={orig('speechStyle.description')} current={draft.speechStyle?.description} />}
                </div>
                {(draft.speechStyle?.examples ?? []).map((ex: any, i: number) => (
                  <div className="id-card-row" key={i}>
                    <label>台词{i + 1}{ex.context ? `（${ex.context}）` : ''}</label>
                    <input
                      value={ex.line ?? ''}
                      onChange={e => {
                        const arr = [...(draft.speechStyle?.examples ?? [])];
                        arr[i] = { ...arr[i], line: e.target.value };
                        upd('speechStyle.examples', arr);
                      }}
                    />
                    {canDiff && <DiffHint original={orig(`speechStyle.examples.${i}.line`)} current={ex.line} />}
                  </div>
                ))}
              </div>

              {/* 短信风格 */}
              <div className="id-card-section">
                <div className="id-card-section-title">短信风格</div>
                <div className="id-card-row">
                  <label>概述</label>
                  <AutoTextarea value={draft.textingStyle?.description ?? ''} onChange={e => upd('textingStyle.description', e.target.value)} />
                  {canDiff && <DiffHint original={orig('textingStyle.description')} current={draft.textingStyle?.description} />}
                </div>
                {(draft.textingStyle?.examples ?? []).map((ex: string, i: number) => (
                  <div className="id-card-row" key={i}>
                    <label>短信{i + 1}</label>
                    <input
                      value={ex}
                      onChange={e => {
                        const arr = [...(draft.textingStyle?.examples ?? [])];
                        arr[i] = e.target.value;
                        upd('textingStyle.examples', arr);
                      }}
                    />
                    {canDiff && <DiffHint original={orig(`textingStyle.examples.${i}`)} current={ex} />}
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
                      <AutoTextarea value={draft.emotional_signals?.[k] ?? ''} onChange={e => upd(`emotional_signals.${k}`, e.target.value)} />
                      {canDiff && <DiffHint original={orig(`emotional_signals.${k}`)} current={draft.emotional_signals?.[k]} />}
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
                      <AutoTextarea value={draft.background?.[k] ?? ''} onChange={e => upd(`background.${k}`, e.target.value)} />
                      {canDiff && <DiffHint original={orig(`background.${k}`)} current={draft.background?.[k]} />}
                    </div>
                  );
                })}
              </div>

              {/* 其他 */}
              <div className="id-card-section">
                <div className="id-card-row">
                  <label>喜好</label>
                  <input
                    value={Array.isArray(draft.likes) ? draft.likes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''}
                    onChange={e => upd('likes', e.target.value.split('、').filter(Boolean))}
                  />
                  {canDiff && <DiffHint original={orig('likes')} current={draft.likes} />}
                </div>
                <div className="id-card-row">
                  <label>厌恶</label>
                  <input
                    value={Array.isArray(draft.dislikes) ? draft.dislikes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''}
                    onChange={e => upd('dislikes', e.target.value.split('、').filter(Boolean))}
                  />
                  {canDiff && <DiffHint original={orig('dislikes')} current={draft.dislikes} />}
                </div>
                <div className="id-card-row">
                  <label>底线</label>
                  <AutoTextarea value={draft.boundaries ?? ''} onChange={e => upd('boundaries', e.target.value)} />
                  {canDiff && <DiffHint original={orig('boundaries')} current={draft.boundaries} />}
                </div>
                <div className="id-card-row">
                  <label>目标</label>
                  <AutoTextarea value={draft.goals ?? ''} onChange={e => upd('goals', e.target.value)} />
                  {canDiff && <DiffHint original={orig('goals')} current={draft.goals} />}
                </div>
                <div className="id-card-row">
                  <label>怪癖</label>
                  <AutoTextarea value={draft.quirks ?? ''} onChange={e => upd('quirks', e.target.value)} />
                  {canDiff && <DiffHint original={orig('quirks')} current={draft.quirks} />}
                </div>
                <div className="id-card-row">
                  <label>与玩家的关系</label>
                  <AutoTextarea value={draft.player_relation ?? ''} onChange={e => upd('player_relation', e.target.value)} placeholder="无特殊关系则留空" />
                  {canDiff && <DiffHint original={orig('player_relation')} current={draft.player_relation} />}
                </div>
                <div className="id-card-row">
                  <label>作息类型</label>
                  <select
                    value={draft.sleepType ?? ''}
                    onChange={e => upd('sleepType', e.target.value === '' ? undefined : e.target.value)}
                  >
                    <option value="">自动推断</option>
                    <option value="normal">正常人（晚上睡）</option>
                    <option value="night_owl">夜猫子（白天睡）</option>
                  </select>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-mute)', marginTop: '0.15rem', width: '100%' }}>
                    夜猫子白天睡觉、夜里活动；留空则按人设自动推断
                  </span>
                  {canDiff && <DiffHint original={orig('sleepType')} current={draft.sleepType} />}
                </div>
                <div className="id-card-row">
                  <label>擅长</label>
                  <AutoTextarea value={draft.skills ?? ''} onChange={e => upd('skills', e.target.value)} placeholder="战斗、生活技能、知识领域、社交特长……" />
                  {canDiff && <DiffHint original={orig('skills')} current={draft.skills} />}
                </div>
                <div className="id-card-row">
                  <label>不擅长</label>
                  <AutoTextarea value={draft.ineptitudes ?? ''} onChange={e => upd('ineptitudes', e.target.value)} placeholder="软肋、不感兴趣、总做不好的事……" />
                  {canDiff && <DiffHint original={orig('ineptitudes')} current={draft.ineptitudes} />}
                </div>
              </div>

              {/* 里程碑（只读展示） */}
              {Array.isArray(draft.backstory_milestones) && draft.backstory_milestones.length > 0 && (
                <div className="id-card-section">
                  <div className="id-card-section-title">背景里程碑（只读）</div>
                  {draft.backstory_milestones.map((m: any, i: number) => (
                    <div className="id-card-row" key={i}>
                      <label>{m.label ?? `#${i + 1}`}{m.time_description ? ` · ${m.time_description}` : ''}</label>
                      <AutoTextarea value={m.summary ?? ''} readOnly style={{ opacity: 0.7 }} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="id-modal-actions">
              <button className="id-btn" onClick={onClose} disabled={saving}>取消</button>
              <button className="id-btn primary" onClick={handleSave} disabled={saving || !draft.name?.trim()}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
