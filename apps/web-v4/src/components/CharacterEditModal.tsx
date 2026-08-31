import { useEffect, useRef, useState } from 'react';
import { api, imageUrl } from '../lib/api';
import { ImageViewer } from './ImageViewer';

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
    <div className="text-[10px] text-ink-muted mt-1 pl-2 border-l-2 border-rose-deep opacity-80">
      原版：{o}
    </div>
  );
}

/**
 * 角色卡编辑弹窗（照 v2 CharacterEditModal 移植）。
 * 加载后端 CharacterData（fork 优先）→ 编辑 → 保存为 fork（不覆盖原版）。
 * 有 fork 时逐字段对比公共原版：改了的地方下方灰色显示原版值。
 */
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [canGenerate, setCanGenerate] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  useEffect(() => {
    api.getImageGenEnabled().then(setCanGenerate);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.getCharacterEdit(characterId);
        if (cancelled) return;
        setDraft(data.characterData as Draft);
        setHasFork(data.hasFork);
        setIsPublic(data.isPublic);
        setPublicData((data.publicData as Draft) ?? null);
      } catch (e) {
        if (!cancelled) setMsg((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  const showMsg = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 3000);
  };

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

  const orig = (path: string) => (publicData ? getPath(publicData, path) : undefined);
  const canDiff = hasFork && !!publicData;

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowAvatarMenu(false);
    setUploadingAvatar(true);
    try {
      const res = await api.uploadImage(file);
      upd('avatar', res.imagePath);
    } catch (err) {
      showMsg((err as Error).message);
    } finally {
      setUploadingAvatar(false);
      e.target.value = '';
    }
  };

  const handleGenerateAvatar = async () => {
    const appearance = (draft?.appearance ?? '').trim();
    if (!appearance) {
      showMsg('请先填写「外貌」描述，再生成头像');
      return;
    }
    setShowAvatarMenu(false);
    setGeneratingAvatar(true);
    try {
      const res = await api.generateImage(appearance, { gender: draft?.gender });
      setPendingAvatar(res.imagePath);
    } catch (err) {
      showMsg((err as Error).message);
    } finally {
      setGeneratingAvatar(false);
    }
  };

  const applyPendingAvatar = () => {
    if (pendingAvatar) {
      upd('avatar', pendingAvatar);
      setPendingAvatar(null);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition';
  const areaCls = `${inputCls} min-h-[56px] resize-y leading-relaxed`;
  const labelCls = 'text-xs font-bold text-ink block mb-1';
  const sectionCls = 'text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-3"
      onClick={onClose}
    >
      <div
        className="bg-panel w-full max-w-md rounded-2xl border border-border shadow-xl flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-ink">编辑角色</h2>
            {isPublic && !hasFork && (
              <span className="text-[10px] text-ink-muted">保存后仅你可见</span>
            )}
            {hasFork && <span className="text-[10px] text-rose">已有你的副本</span>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-soft transition"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* 内容区（可滚动） */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {loading ? (
            <div className="py-8 text-center text-xs text-ink-muted">加载中…</div>
          ) : msg && !draft ? (
            <div className="py-8 text-center text-xs text-rose">{msg}</div>
          ) : draft ? (
            <>
              {msg && (
                <div className="rounded-lg border border-rose text-center text-xs text-rose py-2">
                  {msg}
                </div>
              )}

              {/* 头像 */}
              <div>
                <label className={labelCls}>头像</label>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowAvatarMenu((v) => !v)}
                      disabled={uploadingAvatar || generatingAvatar}
                      className="w-16 h-16 rounded-xl bg-bg-muted/90 hover:bg-bg-muted-2/80 border border-border-strong flex flex-col items-center justify-center text-ink transition shadow-2xs disabled:opacity-50"
                    >
                      {draft.avatar ? (
                        <img
                          src={imageUrl(draft.avatar)}
                          alt="头像"
                          className="w-full h-full object-cover rounded-xl"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <>
                          <span className="text-base leading-none">{uploadingAvatar || generatingAvatar ? '⏳' : '＋'}</span>
                          <span className="text-[9px] text-ink-muted mt-0.5">头像</span>
                        </>
                      )}
                    </button>
                    {showAvatarMenu && (
                      <div className="absolute left-0 top-full mt-1 z-20 bg-panel rounded-lg border border-border shadow-lg py-1 min-w-[128px]">
                        <button
                          type="button"
                          onClick={() => { setShowAvatarMenu(false); fileInputRef.current?.click(); }}
                          className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
                        >
                          <span>🖼</span>上传图片
                        </button>
                        {canGenerate && (
                          <button
                            type="button"
                            onClick={handleGenerateAvatar}
                            className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
                          >
                            <span>🎨</span>{generatingAvatar ? '生成中…' : '生成图片'}
                          </button>
                        )}
                        {draft.avatar && (
                          <button
                            type="button"
                            onClick={() => { setShowAvatarMenu(false); setViewerSrc(draft.avatar); }}
                            className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
                          >
                            <span>👁</span>查看图片
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 text-[11px] text-ink-muted leading-relaxed">
                    上传本地图片，或点「＋」选「生成图片」按外貌生成。留空则用角色名首字作头像。
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarFile}
                  className="hidden"
                />
                {canDiff && <DiffHint original={orig('avatar')} current={draft.avatar} />}

                {/* 生成头像独立框：生成中显示 loading，完成显示大图 + 替换/再次生成 */}
                {(generatingAvatar || pendingAvatar) && (
                  <div className="mt-3 rounded-xl border border-border bg-bg-soft/50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-ink">生成头像</span>
                      {pendingAvatar && (
                        <button
                          type="button"
                          onClick={() => setPendingAvatar(null)}
                          className="w-6 h-6 rounded flex items-center justify-center text-ink-muted hover:text-ink transition"
                          aria-label="关闭预览"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {generatingAvatar ? (
                      <div className="flex flex-col items-center gap-2 py-8">
                        <div className="w-6 h-6 border-2 border-ink/20 border-t-ink rounded-full animate-spin" />
                        <span className="text-xs text-ink-muted">生成中…（约 10 秒）</span>
                      </div>
                    ) : pendingAvatar ? (
                      <>
                        <img
                          src={imageUrl(pendingAvatar)}
                          alt="生成的头像"
                          className="w-full max-w-[260px] mx-auto rounded-xl border border-border"
                          referrerPolicy="no-referrer"
                        />
                        <div className="flex items-center justify-center gap-2 mt-3">
                          <button
                            type="button"
                            onClick={applyPendingAvatar}
                            className="px-4 py-2 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:opacity-90 transition"
                          >
                            替换头像
                          </button>
                          <button
                            type="button"
                            onClick={handleGenerateAvatar}
                            disabled={generatingAvatar}
                            className="px-4 py-2 rounded-lg frosted-glass border border-border text-xs text-ink hover:bg-bg-soft transition disabled:opacity-50"
                          >
                            再次生成
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                )}
              </div>

              {/* 基础信息 */}
              <div>
                <div className={sectionCls}>基础信息</div>
                <div className="space-y-2.5">
                  <div>
                    <label className={labelCls}>
                      名字 <span className="text-rose">*</span>
                    </label>
                    <input
                      className={inputCls}
                      value={draft.name ?? ''}
                      onChange={(e) => upd('name', e.target.value)}
                      placeholder="角色姓名"
                    />
                    {canDiff && <DiffHint original={orig('name')} current={draft.name} />}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className={labelCls}>性别</label>
                      <select
                        className={`${inputCls} cursor-pointer`}
                        value={draft.gender ?? ''}
                        onChange={(e) => upd('gender', e.target.value)}
                      >
                        <option value="">未设定</option>
                        <option value="male">男</option>
                        <option value="female">女</option>
                      </select>
                      {canDiff && <DiffHint original={orig('gender')} current={draft.gender} />}
                    </div>
                    <div>
                      <label className={labelCls}>年龄</label>
                      <input
                        className={inputCls}
                        value={draft.age ?? ''}
                        onChange={(e) => upd('age', e.target.value)}
                        placeholder="例如：26"
                      />
                      {canDiff && <DiffHint original={orig('age')} current={draft.age} />}
                    </div>
                  </div>
                  <div>
                    <label className={labelCls}>外貌</label>
                    <textarea
                      className={areaCls}
                      value={draft.appearance ?? ''}
                      onChange={(e) => upd('appearance', e.target.value)}
                      placeholder="外貌、气质、穿着……"
                    />
                    {canDiff && <DiffHint original={orig('appearance')} current={draft.appearance} />}
                  </div>
                </div>
              </div>

              {/* 性格三层 */}
              <div>
                <div className={sectionCls}>性格</div>
                <div className="space-y-2.5">
                  {(['surface', 'core', 'extreme'] as const).map((k) => (
                    <div key={k}>
                      <label className={labelCls}>
                        {k === 'surface' ? '表层' : k === 'core' ? '内核' : '极端'}
                      </label>
                      <textarea
                        className={areaCls}
                        value={draft.personality?.[k] ?? ''}
                        onChange={(e) =>
                          upd(`personality.${k}`, e.target.value)
                        }
                      />
                      {canDiff && (
                        <DiffHint original={orig(`personality.${k}`)} current={draft.personality?.[k]} />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* 说话风格 */}
              <div>
                <div className={sectionCls}>说话风格</div>
                <div className="space-y-2.5">
                  <div>
                    <label className={labelCls}>概述</label>
                    <textarea
                      className={areaCls}
                      value={draft.speechStyle?.description ?? ''}
                      onChange={(e) =>
                        upd('speechStyle.description', e.target.value)
                      }
                    />
                    {canDiff && (
                      <DiffHint
                        original={orig('speechStyle.description')}
                        current={draft.speechStyle?.description}
                      />
                    )}
                  </div>
                  {(draft.speechStyle?.examples ?? []).map((ex: any, i: number) => (
                    <div key={i}>
                      <label className={labelCls}>
                        台词 {i + 1}
                        {ex.context ? `（${ex.context}）` : ''}
                      </label>
                      <input
                        className={inputCls}
                        value={ex.line ?? ''}
                        onChange={(e) => {
                          const arr = [...(draft.speechStyle?.examples ?? [])];
                          arr[i] = { ...arr[i], line: e.target.value };
                          upd('speechStyle.examples', arr);
                        }}
                      />
                      {canDiff && (
                        <DiffHint
                          original={orig(`speechStyle.examples.${i}.line`)}
                          current={ex.line}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* 短信风格 */}
              <div>
                <div className={sectionCls}>短信风格</div>
                <div className="space-y-2.5">
                  <div>
                    <label className={labelCls}>概述</label>
                    <textarea
                      className={areaCls}
                      value={draft.textingStyle?.description ?? ''}
                      onChange={(e) =>
                        upd('textingStyle.description', e.target.value)
                      }
                    />
                    {canDiff && (
                      <DiffHint
                        original={orig('textingStyle.description')}
                        current={draft.textingStyle?.description}
                      />
                    )}
                  </div>
                  {(draft.textingStyle?.examples ?? []).map((ex: string, i: number) => (
                    <div key={i}>
                      <label className={labelCls}>短信 {i + 1}</label>
                      <input
                        className={inputCls}
                        value={ex}
                        onChange={(e) => {
                          const arr = [...(draft.textingStyle?.examples ?? [])];
                          arr[i] = e.target.value;
                          upd('textingStyle.examples', arr);
                        }}
                      />
                      {canDiff && (
                        <DiffHint original={orig(`textingStyle.examples.${i}`)} current={ex} />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* 情绪信号 */}
              <div>
                <div className={sectionCls}>情绪信号</div>
                <div className="space-y-2.5">
                  {(['nervous', 'happy', 'angry', 'moved', 'defensive'] as const).map((k) => {
                    const labels: Record<string, string> = {
                      nervous: '紧张',
                      happy: '开心',
                      angry: '愤怒',
                      moved: '感动',
                      defensive: '防御',
                    };
                    return (
                      <div key={k}>
                        <label className={labelCls}>{labels[k]}</label>
                        <textarea
                          className={areaCls}
                          value={draft.emotional_signals?.[k] ?? ''}
                          onChange={(e) =>
                            upd(`emotional_signals.${k}`, e.target.value)
                          }
                        />
                        {canDiff && (
                          <DiffHint
                            original={orig(`emotional_signals.${k}`)}
                            current={draft.emotional_signals?.[k]}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 背景 */}
              <div>
                <div className={sectionCls}>背景</div>
                <div className="space-y-2.5">
                  {(['origin', 'shaping', 'current'] as const).map((k) => {
                    const labels: Record<string, string> = {
                      origin: '出身',
                      shaping: '经历',
                      current: '现状',
                    };
                    return (
                      <div key={k}>
                        <label className={labelCls}>{labels[k]}</label>
                        <textarea
                          className={areaCls}
                          value={draft.background?.[k] ?? ''}
                          onChange={(e) =>
                            upd(`background.${k}`, e.target.value)
                          }
                        />
                        {canDiff && (
                          <DiffHint original={orig(`background.${k}`)} current={draft.background?.[k]} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 其他 */}
              <div>
                <div className={sectionCls}>其他</div>
                <div className="space-y-2.5">
                  <div>
                    <label className={labelCls}>喜好</label>
                    <input
                      className={inputCls}
                      value={
                        Array.isArray(draft.likes)
                          ? draft.likes
                              .map((x: any) =>
                                typeof x === 'string'
                                  ? x
                                  : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`
                              )
                              .join('、')
                          : ''
                      }
                      onChange={(e) => upd('likes', e.target.value.split('、').filter(Boolean))}
                      placeholder="用「、」分隔多项"
                    />
                    {canDiff && <DiffHint original={orig('likes')} current={draft.likes} />}
                  </div>
                  <div>
                    <label className={labelCls}>厌恶</label>
                    <input
                      className={inputCls}
                      value={
                        Array.isArray(draft.dislikes)
                          ? draft.dislikes
                              .map((x: any) =>
                                typeof x === 'string'
                                  ? x
                                  : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`
                              )
                              .join('、')
                          : ''
                      }
                      onChange={(e) => upd('dislikes', e.target.value.split('、').filter(Boolean))}
                      placeholder="用「、」分隔多项"
                    />
                    {canDiff && <DiffHint original={orig('dislikes')} current={draft.dislikes} />}
                  </div>
                  <div>
                    <label className={labelCls}>底线</label>
                    <textarea
                      className={areaCls}
                      value={draft.boundaries ?? ''}
                      onChange={(e) => upd('boundaries', e.target.value)}
                    />
                    {canDiff && <DiffHint original={orig('boundaries')} current={draft.boundaries} />}
                  </div>
                  <div>
                    <label className={labelCls}>目标</label>
                    <textarea
                      className={areaCls}
                      value={draft.goals ?? ''}
                      onChange={(e) => upd('goals', e.target.value)}
                    />
                    {canDiff && <DiffHint original={orig('goals')} current={draft.goals} />}
                  </div>
                  <div>
                    <label className={labelCls}>怪癖</label>
                    <textarea
                      className={areaCls}
                      value={draft.quirks ?? ''}
                      onChange={(e) => upd('quirks', e.target.value)}
                    />
                    {canDiff && <DiffHint original={orig('quirks')} current={draft.quirks} />}
                  </div>
                  <div>
                    <label className={labelCls}>与玩家的关系</label>
                    <textarea
                      className={areaCls}
                      value={draft.player_relation ?? ''}
                      onChange={(e) => upd('player_relation', e.target.value)}
                      placeholder="无特殊关系则留空"
                    />
                    {canDiff && (
                      <DiffHint original={orig('player_relation')} current={draft.player_relation} />
                    )}
                  </div>
                  <div>
                    <label className={labelCls}>作息类型</label>
                    <select
                      className={`${inputCls} cursor-pointer`}
                      value={draft.sleepType ?? ''}
                      onChange={(e) => upd('sleepType', e.target.value === '' ? undefined : e.target.value)}
                    >
                      <option value="">自动推断</option>
                      <option value="normal">正常人（晚上睡）</option>
                      <option value="night_owl">夜猫子（白天睡）</option>
                    </select>
                    <span className="text-[10px] text-ink-muted mt-1 block">
                      夜猫子白天睡觉、夜里活动；留空则按人设自动推断
                    </span>
                    {canDiff && <DiffHint original={orig('sleepType')} current={draft.sleepType} />}
                  </div>
                  <div>
                    <label className={labelCls}>擅长</label>
                    <textarea
                      className={areaCls}
                      value={draft.skills ?? ''}
                      onChange={(e) => upd('skills', e.target.value)}
                      placeholder="战斗、生活技能、知识领域、社交特长……"
                    />
                    {canDiff && <DiffHint original={orig('skills')} current={draft.skills} />}
                  </div>
                  <div>
                    <label className={labelCls}>不擅长</label>
                    <textarea
                      className={areaCls}
                      value={draft.ineptitudes ?? ''}
                      onChange={(e) => upd('ineptitudes', e.target.value)}
                      placeholder="软肋、不感兴趣、总做不好的事……"
                    />
                    {canDiff && (
                      <DiffHint original={orig('ineptitudes')} current={draft.ineptitudes} />
                    )}
                  </div>
                </div>
              </div>

              {/* 里程碑（只读展示） */}
              {Array.isArray(draft.backstory_milestones) && draft.backstory_milestones.length > 0 && (
                <div>
                  <div className={sectionCls}>背景里程碑（只读）</div>
                  <div className="space-y-2.5">
                    {draft.backstory_milestones.map((m: any, i: number) => (
                      <div key={i}>
                        <label className={labelCls}>
                          {m.label ?? `#${i + 1}`}
                          {m.time_description ? ` · ${m.time_description}` : ''}
                        </label>
                        <textarea
                          className={`${areaCls} opacity-70`}
                          value={m.summary ?? ''}
                          readOnly
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg bg-bg-muted text-xs font-medium text-ink hover:bg-bg-muted-2 transition disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !draft?.name?.trim()}
            className="px-4 py-1.5 rounded-lg bg-rose text-xs font-semibold text-ink-on hover:bg-rose transition disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {viewerSrc && <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </div>
  );
}
