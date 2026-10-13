import type { UploadProgress } from '../lib/api';

/**
 * 上传进度条（头像这类「小操作，但原图很大」的上传用）。
 *
 * 三个阶段必须分开显示，尤其不能把「字节发完」当成功：
 * 弱网下字节发完 → 后端落库/返回之间可能还有好几秒，
 * 进度条停在 100% 不动会被读成卡死（线上用户报的就是「一直上传中/上传失败」）。
 */
export function UploadProgressBar({
  progress,
  className = '',
}: {
  progress: UploadProgress | null;
  className?: string;
}) {
  if (!progress) return null;
  const { phase, pct } = progress;
  const indeterminate = phase !== 'upload';
  const label =
    phase === 'compress'
      ? '压缩中…'
      : phase === 'processing'
        ? '上传完成，服务器处理中…'
        : `上传中 ${Math.round(pct * 100)}%`;
  const width = phase === 'compress' ? 100 : Math.max(4, Math.min(100, Math.round(pct * 100)));

  return (
    <div className={`mt-2 ${className}`}>
      <div className="text-[10px] text-ink-muted mb-1">{label}</div>
      <div className="h-1.5 w-full rounded-full bg-bg-muted border border-border-soft overflow-hidden">
        <div
          className={`h-full rounded-full bg-rose transition-[width] duration-150 ${indeterminate ? 'animate-pulse opacity-70' : ''}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
