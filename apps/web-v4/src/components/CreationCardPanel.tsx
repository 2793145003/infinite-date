import { useRef, useState } from 'react';
import { api, imageUrl } from '../lib/api';

/**
 * 聊天式创建角色：角色卡编辑面板（draft 直接用后端 CharacterData 结构，字段与数据库对齐）。
 * 照 v2 CreationCardPanel 移植，样式改 v4 frosted-glass + zinc/rose。
 */
export function CreationCardPanel({
  draft,
  showCard,
  onToggle,
  onChange,
  onFinalize,
  sending,
}: {
  draft: Record<string, any> | null;
  showCard: boolean;
  onToggle: () => void;
  onChange: (draft: Record<string, any>) => void;
  onFinalize: () => void;
  sending: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  if (!draft) return null;
  const set = (patch: Record<string, any>) => onChange({ ...draft, ...patch });

  const inputCls =
    'w-full px-3 py-2 text-xs bg-bg-muted/90 rounded-lg border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition';
  const areaCls = `${inputCls} min-h-[56px] resize-y leading-relaxed`;
  const labelCls = 'text-xs font-bold text-ink block mb-1';

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingAvatar(true);
    try {
      const res = await api.uploadImage(file);
      set({ avatar: res.imagePath });
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setUploadingAvatar(false);
      e.target.value = '';
    }
  };

  return (
    <div className="frosted-glass rounded-2xl border border-border p-3 shadow-xs">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg frosted-glass border border-border text-xs font-semibold text-ink hover:bg-bg-soft transition"
      >
        <span>📋 角色卡</span>
        <span className="text-ink-muted text-[10px]">{showCard ? '收起 ▲' : '展开 ▼'}</span>
      </button>

      {showCard && (
        <div className="mt-3 space-y-3">
          {/* 头像 */}
          <div>
            <label className={labelCls}>头像</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingAvatar}
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
                    <span className="text-base leading-none">{uploadingAvatar ? '⏳' : '＋'}</span>
                    <span className="text-[9px] text-ink-muted mt-0.5">上传</span>
                  </>
                )}
              </button>
              <div className="flex-1 text-[11px] text-ink-muted leading-relaxed">
                上传本地图片作为头像，留空则用角色名首字作头像。
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarFile} className="hidden" />
          </div>

          {/* 基础信息 */}
          <div>
            <div className="text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2">基础信息</div>
            <div className="space-y-2.5">
              <div>
                <label className={labelCls}>
                  名字 <span className="text-rose">*</span>
                </label>
                <input
                  className={inputCls}
                  value={draft.name ?? ''}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="角色姓名"
                />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className={labelCls}>性别</label>
                  <select
                    className={`${inputCls} cursor-pointer`}
                    value={draft.gender ?? ''}
                    onChange={(e) => set({ gender: e.target.value })}
                  >
                    <option value="">未设定</option>
                    <option value="male">男</option>
                    <option value="female">女</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>年龄</label>
                  <input
                    className={inputCls}
                    value={draft.age ?? ''}
                    onChange={(e) => set({ age: e.target.value })}
                    placeholder="例如：26"
                  />
                </div>
              </div>
              <div>
                <label className={labelCls}>外貌</label>
                <textarea
                  className={areaCls}
                  value={draft.appearance ?? ''}
                  onChange={(e) => set({ appearance: e.target.value })}
                  placeholder="外貌、气质、穿着……"
                />
              </div>
            </div>
          </div>

          {/* 性格三层 */}
          <div>
            <div className="text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2">性格</div>
            <div className="space-y-2.5">
              {(['surface', 'core', 'extreme'] as const).map((k) => (
                <div key={k}>
                  <label className={labelCls}>
                    {k === 'surface' ? '表层' : k === 'core' ? '内核' : '极端'}
                  </label>
                  <textarea
                    className={areaCls}
                    value={draft.personality?.[k] ?? ''}
                    onChange={(e) => set({ personality: { ...draft.personality, [k]: e.target.value } })}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 说话风格 */}
          <div>
            <div className="text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2">说话风格</div>
            <div className="space-y-2.5">
              <div>
                <label className={labelCls}>概述</label>
                <textarea
                  className={areaCls}
                  value={draft.speechStyle?.description ?? ''}
                  onChange={(e) => set({ speechStyle: { ...draft.speechStyle, description: e.target.value } })}
                />
              </div>
              {(draft.speechStyle?.examples ?? []).map((ex: any, i: number) => (
                <div key={i}>
                  <label className={labelCls}>台词 {i + 1}</label>
                  <input
                    className={inputCls}
                    value={ex.line ?? ''}
                    onChange={(e) => {
                      const arr = [...(draft.speechStyle?.examples ?? [])];
                      arr[i] = { ...arr[i], line: e.target.value };
                      set({ speechStyle: { ...draft.speechStyle, examples: arr } });
                    }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 短信风格 */}
          <div>
            <div className="text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2">短信风格</div>
            <div className="space-y-2.5">
              <div>
                <label className={labelCls}>概述</label>
                <textarea
                  className={areaCls}
                  value={draft.textingStyle?.description ?? ''}
                  onChange={(e) => set({ textingStyle: { ...draft.textingStyle, description: e.target.value } })}
                />
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
                      set({ textingStyle: { ...draft.textingStyle, examples: arr } });
                    }}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 情绪信号 */}
          <div>
            <div className="text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2">情绪信号</div>
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
                        set({ emotional_signals: { ...draft.emotional_signals, [k]: e.target.value } })
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* 背景 */}
          <div>
            <div className="text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2">背景</div>
            <div className="space-y-2.5">
              {(['origin', 'shaping', 'current'] as const).map((k) => {
                const labels: Record<string, string> = { origin: '出身', shaping: '经历', current: '现状' };
                return (
                  <div key={k}>
                    <label className={labelCls}>{labels[k]}</label>
                    <textarea
                      className={areaCls}
                      value={draft.background?.[k] ?? ''}
                      onChange={(e) => set({ background: { ...draft.background, [k]: e.target.value } })}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {/* 其他 */}
          <div>
            <div className="text-[11px] font-bold text-ink-muted uppercase tracking-wide mb-2">其他</div>
            <div className="space-y-2.5">
              <div>
                <label className={labelCls}>喜好</label>
                <input
                  className={inputCls}
                  value={
                    Array.isArray(draft.likes)
                      ? draft.likes
                          .map((x: any) =>
                            typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`
                          )
                          .join('、')
                      : ''
                  }
                  onChange={(e) => set({ likes: e.target.value.split('、').filter(Boolean) })}
                  placeholder="用「、」分隔多项"
                />
              </div>
              <div>
                <label className={labelCls}>厌恶</label>
                <input
                  className={inputCls}
                  value={
                    Array.isArray(draft.dislikes)
                      ? draft.dislikes
                          .map((x: any) =>
                            typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`
                          )
                          .join('、')
                      : ''
                  }
                  onChange={(e) => set({ dislikes: e.target.value.split('、').filter(Boolean) })}
                  placeholder="用「、」分隔多项"
                />
              </div>
              <div>
                <label className={labelCls}>底线</label>
                <textarea
                  className={areaCls}
                  value={draft.boundaries ?? ''}
                  onChange={(e) => set({ boundaries: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>目标</label>
                <textarea
                  className={areaCls}
                  value={draft.goals ?? ''}
                  onChange={(e) => set({ goals: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>怪癖</label>
                <textarea
                  className={areaCls}
                  value={draft.quirks ?? ''}
                  onChange={(e) => set({ quirks: e.target.value })}
                />
              </div>
              <div>
                <label className={labelCls}>与玩家的关系</label>
                <textarea
                  className={areaCls}
                  value={draft.player_relation ?? ''}
                  onChange={(e) => set({ player_relation: e.target.value })}
                  placeholder="无特殊关系则留空"
                />
              </div>
              <div>
                <label className={labelCls}>擅长</label>
                <textarea
                  className={areaCls}
                  value={draft.skills ?? ''}
                  onChange={(e) => set({ skills: e.target.value })}
                  placeholder="战斗、生活技能、知识领域、社交特长……"
                />
              </div>
              <div>
                <label className={labelCls}>不擅长</label>
                <textarea
                  className={areaCls}
                  value={draft.ineptitudes ?? ''}
                  onChange={(e) => set({ ineptitudes: e.target.value })}
                  placeholder="软肋、不感兴趣、总做不好的事……"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        className="w-full mt-3 rounded-lg bg-rose py-2.5 text-sm font-semibold text-ink-on hover:bg-rose transition disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onFinalize}
        disabled={sending || !draft.name?.trim()}
      >
        ✓ 保存角色
      </button>
    </div>
  );
}
