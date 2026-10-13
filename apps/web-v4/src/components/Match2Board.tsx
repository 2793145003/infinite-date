import { useState } from 'react';
import type { WorldBoard } from '../lib/api';

// 8 种盘面块的显示元信息（五行基础块 + 加成块）
const TILE_META: Record<string, { bg: string; fg: string; label: string }> = {
  '金': { bg: '#e8c86a', fg: '#5a4310', label: '金' },
  '木': { bg: '#8fd694', fg: '#1f4a23', label: '木' },
  '水': { bg: '#7fb8e8', fg: '#153c5e', label: '水' },
  '火': { bg: '#e88b7f', fg: '#5e1c13', label: '火' },
  '土': { bg: '#c9a87f', fg: '#4a3112', label: '土' },
  '灵石': { bg: '#7fd8cf', fg: '#12413c', label: '灵' },
  '仙晶': { bg: '#b78fe8', fg: '#3a1560', label: '晶' },
  '丹炉': { bg: '#e8a97f', fg: '#5e2e12', label: '炉' },
};

/**
 * 二消盘面（布偶餐厅式，无失败纯爽）。
 * 受控组件：父组件持有 board 状态，onSwap 调后端结算后更新 board。
 * 交互：点第一格选中，点相邻格交换；点不相邻格重新选中。
 */
export function Match2Board({
  board,
  onSwap,
  disabled,
}: {
  board: WorldBoard;
  onSwap: (x1: number, y1: number, x2: number, y2: number) => Promise<void>;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<[number, number] | null>(null);
  const [swapping, setSwapping] = useState(false);

  const size = board.size;

  const handleClick = async (x: number, y: number) => {
    if (disabled || swapping) return;
    if (!selected) {
      setSelected([x, y]);
      return;
    }
    const [sx, sy] = selected;
    if (sx === x && sy === y) {
      setSelected(null);
      return;
    }
    if (Math.abs(sx - x) + Math.abs(sy - y) !== 1) {
      setSelected([x, y]);
      return;
    }
    setSelected(null);
    setSwapping(true);
    try {
      await onSwap(sx, sy, x, y);
    } finally {
      setSwapping(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-ink-soft">
        <span>分数 <b className="text-ink">{board.score}</b></span>
        <span>剩余步数 <b className="text-ink">{board.movesLeft}</b></span>
      </div>
      <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}>
        {board.cells.map((row, y) =>
          row.map((cell, x) => {
            const meta = cell ? TILE_META[cell] : undefined;
            const isSel = !!selected && selected[0] === x && selected[1] === y;
            return (
              <button
                key={`${x}-${y}`}
                onClick={() => handleClick(x, y)}
                disabled={disabled}
                className="flex aspect-square items-center justify-center rounded-md text-sm font-semibold transition-opacity"
                style={{
                  backgroundColor: meta ? meta.bg : 'rgba(127,127,127,0.08)',
                  color: meta ? meta.fg : 'transparent',
                  boxShadow: isSel ? '0 0 0 2px var(--accent, #e91e63) inset' : 'none',
                  opacity: swapping ? 0.6 : 1,
                }}
              >
                {meta?.label ?? ''}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
