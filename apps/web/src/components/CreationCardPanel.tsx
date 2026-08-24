import { ImageUploadButton } from './ImageUploadButton';
import { AutoTextarea } from './AutoTextarea';

// 聊天式创建角色：角色卡编辑面板（SmsApp 与 CreatorApp 共用）
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
  if (!draft) return null;
  const set = (patch: Record<string, any>) => onChange({ ...draft, ...patch });

  return (
    <div className="id-creation-card-panel">
      <button className="id-creation-card-toggle" onClick={onToggle}>
        📋 角色卡 {showCard ? '▲' : '▼'}
      </button>
      {showCard && (
        <div className="id-creation-card">
          {/* 头像 */}
          <div className="id-card-section">
            <div className="id-card-row">
              <label>头像</label>
              <ImageUploadButton
                square
                onUploaded={(path) => set({ avatar: path })}
                onClear={() => set({ avatar: '' })}
                value={draft.avatar}
              />
            </div>
          </div>

          {/* 基本信息 */}
          <div className="id-card-section">
            <div className="id-card-row">
              <label>名字</label>
              <input value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="id-card-row">
              <label>性别</label>
              <select value={draft.gender ?? ''} onChange={(e) => set({ gender: e.target.value })}>
                <option value="">未设定</option>
                <option value="male">男</option>
                <option value="female">女</option>
              </select>
            </div>
            <div className="id-card-row">
              <label>年龄</label>
              <input value={draft.age ?? ''} onChange={(e) => set({ age: e.target.value })} />
            </div>
            <div className="id-card-row">
              <label>外貌</label>
              <AutoTextarea value={draft.appearance ?? ''} onChange={(e) => set({ appearance: e.target.value })} />
            </div>
          </div>

          {/* 性格三层 */}
          <div className="id-card-section">
            <div className="id-card-section-title">性格</div>
            {(['surface', 'core', 'extreme'] as const).map((k) => (
              <div className="id-card-row" key={k}>
                <label>{k === 'surface' ? '表层' : k === 'core' ? '内核' : '极端'}</label>
                <AutoTextarea
                  value={draft.personality?.[k] ?? ''}
                  onChange={(e) => set({ personality: { ...draft.personality, [k]: e.target.value } })}
                />
              </div>
            ))}
          </div>

          {/* 说话风格 */}
          <div className="id-card-section">
            <div className="id-card-section-title">说话风格</div>
            <div className="id-card-row">
              <label>概述</label>
              <AutoTextarea value={draft.speechStyle?.description ?? ''} onChange={(e) => set({ speechStyle: { ...draft.speechStyle, description: e.target.value } })} />
            </div>
            {(draft.speechStyle?.examples ?? []).map((ex: any, i: number) => (
              <div className="id-card-row" key={i}>
                <label>台词{i + 1}</label>
                <input
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

          {/* 短信风格 */}
          <div className="id-card-section">
            <div className="id-card-section-title">短信风格</div>
            <div className="id-card-row">
              <label>概述</label>
              <AutoTextarea value={draft.textingStyle?.description ?? ''} onChange={(e) => set({ textingStyle: { ...draft.textingStyle, description: e.target.value } })} />
            </div>
            {(draft.textingStyle?.examples ?? []).map((ex: string, i: number) => (
              <div className="id-card-row" key={i}>
                <label>短信{i + 1}</label>
                <input
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

          {/* 情绪信号 */}
          <div className="id-card-section">
            <div className="id-card-section-title">情绪信号</div>
            {(['nervous', 'happy', 'angry', 'moved', 'defensive'] as const).map((k) => {
              const labels: Record<string, string> = { nervous: '紧张', happy: '开心', angry: '愤怒', moved: '感动', defensive: '防御' };
              return (
                <div className="id-card-row" key={k}>
                  <label>{labels[k]}</label>
                  <AutoTextarea
                    value={draft.emotional_signals?.[k] ?? ''}
                    onChange={(e) => set({ emotional_signals: { ...draft.emotional_signals, [k]: e.target.value } })}
                  />
                </div>
              );
            })}
          </div>

          {/* 背景 */}
          <div className="id-card-section">
            <div className="id-card-section-title">背景</div>
            {(['origin', 'shaping', 'current'] as const).map((k) => {
              const labels: Record<string, string> = { origin: '出身', shaping: '经历', current: '现状' };
              return (
                <div className="id-card-row" key={k}>
                  <label>{labels[k]}</label>
                  <AutoTextarea
                    value={draft.background?.[k] ?? ''}
                    onChange={(e) => set({ background: { ...draft.background, [k]: e.target.value } })}
                  />
                </div>
              );
            })}
          </div>

          {/* 其他 */}
          <div className="id-card-section">
            <div className="id-card-row">
              <label>喜好</label>
              <input value={Array.isArray(draft.likes) ? draft.likes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''} onChange={(e) => set({ likes: e.target.value.split('、').filter(Boolean) })} />
            </div>
            <div className="id-card-row">
              <label>厌恶</label>
              <input value={Array.isArray(draft.dislikes) ? draft.dislikes.map((x: any) => typeof x === 'string' ? x : `${x.item}${x.reason ? '（' + x.reason + '）' : ''}`).join('、') : ''} onChange={(e) => set({ dislikes: e.target.value.split('、').filter(Boolean) })} />
            </div>
            <div className="id-card-row">
              <label>底线</label>
              <AutoTextarea value={draft.boundaries ?? ''} onChange={(e) => set({ boundaries: e.target.value })} />
            </div>
            <div className="id-card-row">
              <label>目标</label>
              <AutoTextarea value={draft.goals ?? ''} onChange={(e) => set({ goals: e.target.value })} />
            </div>
            <div className="id-card-row">
              <label>怪癖</label>
              <AutoTextarea value={draft.quirks ?? ''} onChange={(e) => set({ quirks: e.target.value })} />
            </div>
            <div className="id-card-row">
              <label>与玩家的关系</label>
              <AutoTextarea value={draft.player_relation ?? ''} onChange={(e) => set({ player_relation: e.target.value })} placeholder="无特殊关系则留空" />
            </div>
            <div className="id-card-row">
              <label>擅长</label>
              <AutoTextarea value={draft.skills ?? ''} onChange={(e) => set({ skills: e.target.value })} placeholder="战斗、生活技能、知识领域、社交特长……" />
            </div>
            <div className="id-card-row">
              <label>不擅长</label>
              <AutoTextarea value={draft.ineptitudes ?? ''} onChange={(e) => set({ ineptitudes: e.target.value })} placeholder="软肋、不感兴趣、总做不好的事……" />
            </div>
          </div>
        </div>
      )}
      <button
        className="id-chat-send-btn"
        style={{ width: '100%', marginTop: '0.5rem' }}
        onClick={onFinalize}
        disabled={sending || !draft.name?.trim()}
      >
        ✓ 保存角色
      </button>
    </div>
  );
}
