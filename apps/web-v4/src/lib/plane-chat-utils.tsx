import React, { type ReactNode } from 'react';
import type { PlaneSessionMessage } from '../lib/api';

/**
 * 位面聊天共享工具 —— 大厅快聊共用：
 * 气泡类型、消息行映射、动作标记渲染、延时。
 */

export type Bubble = {
  id: string;
  kind: 'narration' | 'character' | 'player';
  speaker?: string;
  content: string;
  time?: number;
  internal: string;
  internalNotable: boolean;
};

export type Beat = {
  kind: string;
  speaker?: string;
  content: string;
  characterId?: string;
  internal?: string;
  internalNotable?: boolean;
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 把后端消息行映射为前端 Bubble */
export function toLine(m: PlaneSessionMessage): Bubble {
  const kind: Bubble['kind'] =
    m.role === 'player' ? 'player' : m.role === 'narration' ? 'narration' : 'character';
  return {
    id: m.id ?? `${kind}-${m.character_name}-${m.text}`,
    kind,
    speaker: kind === 'narration' ? undefined : m.character_name || (kind === 'player' ? '我' : '角色'),
    content: m.text,
    internal: kind === 'character' ? m.internal ?? '' : '',
    internalNotable: kind === 'character' ? !!m.internal_notable : false,
  };
}

/** 把流式 beat 映射为 Bubble（供逐拍追加） */
export function beatToLine(b: Beat, id: string): Bubble {
  const isNarration = b.kind === 'narration';
  return {
    id,
    kind: isNarration ? 'narration' : 'character',
    speaker: isNarration ? undefined : b.speaker ?? '角色',
    content: b.content,
    time: Date.now(),
    internal: isNarration ? '' : b.internal ?? '',
    internalNotable: !isNarration && !!b.internalNotable,
  };
}

/** 渲染带动作标记的文本：*星号动作* 与（中文括号动作）/（半角）→ 柔色斜体 */
export function renderText(text: string, dimClass = 'text-ink-muted/70'): ReactNode[] {
  const parts = text.split(/(\*[^*]+\*|（[^）]+）|\([^)]+\))/);
  return parts.map((seg, i) => {
    const isStar = seg.startsWith('*') && seg.endsWith('*') && seg.length > 2;
    const isBracket =
      (seg.startsWith('（') || seg.startsWith('(')) && (seg.endsWith('）') || seg.endsWith(')'));
    if (isStar || isBracket) {
      return (
        <span key={i} className={`${dimClass} italic`} style={{ fontSize: '0.85em', opacity: 0.82 }}>
          {isStar ? seg.slice(1, -1) : seg}
        </span>
      );
    }
    return <span key={i}>{seg}</span>;
  });
}
