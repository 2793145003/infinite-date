import { type ReactNode } from 'react';

/**
 * 渲染带动作标记的文本。
 * *星号动作* → 柔色细体
 * （中文括号动作） → 柔色细体
 */
export function renderTextWithActions(text: string, color?: string): ReactNode[] {
  const parts = text.split(/(\*[^*]+\*|（[^）]+）|\([^)]+\)|（[^）]+\)|\([^)]*）)/);
  return parts.map((seg, i) => {
    if (seg.startsWith('*') && seg.endsWith('*') && seg.length > 2) {
      return (
        <span key={i} style={{
          color: color ?? 'var(--text-dim)',
          fontSize: '0.85em',
          opacity: 0.82,
        }}>
          {seg.slice(1, -1)}
        </span>
      );
    }
    const isAction = (seg.startsWith('（') || seg.startsWith('(')) && (seg.endsWith('）') || seg.endsWith(')'));
    if (isAction) {
      return (
        <span key={i} style={{
          color: color ?? 'var(--text-dim)',
          fontSize: '0.85em',
          opacity: 0.82,
        }}>
          {seg}
        </span>
      );
    }
    return <span key={i}>{seg}</span>;
  });
}
