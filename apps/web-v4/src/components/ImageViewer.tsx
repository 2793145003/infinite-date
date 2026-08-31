import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { imageUrl } from '../lib/api';

interface ImageViewerProps {
  src: string;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * 全屏图片查看器：黑底、原图 object-contain 铺满、点背景或 ✕ 或 Esc 关闭。
 * 支持双指缩放（1~4 倍）与缩放后的单指平移；松手时若已缩回 1 倍则回弹居中。
 * src 可为裸文件名（走 /v4/api/uploads 前缀）或完整 URL/相对路径，统一经 imageUrl 归一。
 */
export const ImageViewer: React.FC<ImageViewerProps> = ({ src, onClose }) => {
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [isGesturing, setIsGesturing] = useState(false);

  const g = useRef({
    mode: 'none' as 'none' | 'pinch' | 'pan',
    startScale: 1,
    startX: 0,
    startY: 0,
    startDist: 0,
    startMidX: 0,
    startMidY: 0,
    lastMidX: 0,
    lastMidY: 0,
    moved: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 换图时重置缩放/位移
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
    setIsGesturing(false);
  }, [src]);

  const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches;
    const s = g.current;
    s.moved = false;
    if (t.length >= 2) {
      const d = dist(t[0], t[1]);
      const m = mid(t[0], t[1]);
      s.mode = 'pinch';
      s.startScale = transform.scale;
      s.startDist = d;
      s.startX = transform.x;
      s.startY = transform.y;
      s.startMidX = m.x;
      s.startMidY = m.y;
      s.lastMidX = m.x;
      s.lastMidY = m.y;
    } else if (t.length === 1) {
      s.mode = 'pan';
      s.startX = transform.x;
      s.startY = transform.y;
      s.lastMidX = t[0].clientX;
      s.lastMidY = t[0].clientY;
    }
    setIsGesturing(true);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const t = e.touches;
    const s = g.current;
    if (t.length >= 2) {
      const d = dist(t[0], t[1]);
      const m = mid(t[0], t[1]);
      const scale = clamp(s.startScale * (d / s.startDist), MIN_SCALE, MAX_SCALE);
      if (Math.abs(d - s.startDist) > 3) s.moved = true;
      // 围绕两指中点缩放，同时跟随中点位移平移
      setTransform({ scale, x: s.startX + (m.x - s.startMidX), y: s.startY + (m.y - s.startMidY) });
      s.lastMidX = m.x;
      s.lastMidY = m.y;
    } else if (t.length === 1 && s.mode === 'pan') {
      const dx = t[0].clientX - s.lastMidX;
      const dy = t[0].clientY - s.lastMidY;
      if (Math.abs(dx) + Math.abs(dy) > 3) s.moved = true;
      setTransform((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      s.lastMidX = t[0].clientX;
      s.lastMidY = t[0].clientY;
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const t = e.touches;
    const s = g.current;
    if (t.length === 1) {
      // 双指缩放后剩一根手指：无缝切到平移，不跳位
      s.mode = 'pan';
      s.startX = transform.x;
      s.startY = transform.y;
      s.lastMidX = t[0].clientX;
      s.lastMidY = t[0].clientY;
    } else if (t.length === 0) {
      s.mode = 'none';
      setIsGesturing(false);
      // 已缩回 1 倍时回弹居中，避免残留位移
      if (transform.scale <= 1.02) {
        setTransform({ scale: 1, x: 0, y: 0 });
      }
    }
  };

  const handleBackdropClick = () => {
    // 缩放/平移手势结束后浏览器仍会派发一次 click，这里吞掉以免误关闭
    if (g.current.moved) {
      g.current.moved = false;
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 overflow-hidden touch-none cursor-zoom-out select-none"
      onClick={handleBackdropClick}
      role="dialog"
      aria-label="图片查看"
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 text-white hover:bg-white/25 flex items-center justify-center transition active:scale-95 z-10"
        aria-label="关闭"
      >
        <X className="w-5 h-5" />
      </button>
      <img
        src={imageUrl(src)}
        alt="查看图片"
        draggable={false}
        className="max-w-full max-h-full object-contain touch-none"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transition: isGesturing ? 'none' : 'transform 0.18s ease',
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      />
    </div>
  );
};
