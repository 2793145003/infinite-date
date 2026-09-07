import { useRef, type ReactNode } from 'react';
import { PlayerChipInput, type PlayerChipInputHandle } from './PlayerChipInput';

/**
 * 叙述字段输入组件：label 行右侧带「角色名」「玩家」两个胶囊按钮，
 * 点击把 {{character_name}} / {{player_name}} 以 chip 形式插入正文，避免作者写死真实名字。
 * 角色名胶囊显示真实角色名（characterName），角色名为空时显示「角色名」三个字。
 */
export function CapsuleField({
  label,
  labelClassName,
  value,
  onChange,
  placeholder,
  rows = 3,
  inputClassName,
  onBlur,
  characterName,
  headerExtra,
}: {
  label: string;
  labelClassName?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  inputClassName?: string;
  onBlur?: (text: string) => void;
  characterName?: string;
  headerExtra?: ReactNode;
}) {
  const ref = useRef<PlayerChipInputHandle>(null);
  const charLabel = characterName || '角色名';

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className={labelClassName}>{label}</label>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="rounded-full px-2 py-0.5 text-[10px] font-medium transition hover:opacity-85"
            style={{ background: 'var(--rose)', color: 'var(--ink-on)' }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => ref.current?.insertCharacter()}
          >
            {charLabel}
          </button>
          <button
            type="button"
            className="rounded-full px-2 py-0.5 text-[10px] font-medium transition hover:opacity-85"
            style={{ background: 'var(--accent)', color: 'var(--ink-on)' }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => ref.current?.insertPlayer()}
          >
            玩家
          </button>
          {headerExtra}
        </div>
      </div>
      <PlayerChipInput
        ref={ref}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        rows={rows}
        className={inputClassName}
        onBlur={onBlur}
        characterName={characterName}
      />
    </div>
  );
}
