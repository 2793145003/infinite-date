import { useRef, useState, useEffect } from 'react';

/**
 * 方形头像裁剪弹层
 * 选图后弹出：方形遮罩 + 用户可拖动(平移)、滚轮缩放，确认后输出裁好的方形图 Blob。
 * 只在 ImageUploadButton 设 square 时启用（头像用途），聊天/朋友圈/背景不经过这里。
 */
interface Props {
  file: File;
  onConfirm: (blob: File) => void;  // 裁好的方形图片
  onCancel: () => void;
}

const STAGE = 300;   // 方形裁剪区边长(px)

export function AvatarCropModal({ file, onConfirm, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [srcUrl, setSrcUrl] = useState('');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [scale, setScale] = useState(1);           // 显示缩放（源图 → 舞台）
  const [off, setOff] = useState({ x: 0, y: 0 });  // 源图坐标下的可视区左上角(px)

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrcUrl(url);
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // 初始化：短边铺满舞台，长边居中
  useEffect(() => {
    if (!img) return;
    const s = Math.max(STAGE / img.naturalWidth, STAGE / img.naturalHeight);
    setScale(s);
    setOff({
      x: (img.naturalWidth - STAGE / s) / 2,
      y: (img.naturalHeight - STAGE / s) / 2,
    });
  }, [img]);

  // 裁剪区（源图坐标下的可视方形）
  const visW = STAGE / scale;
  const visH = STAGE / scale;

  const clamp = (o: { x: number; y: number }) => {
    if (!img) return o;
    const maxX = Math.max(img.naturalWidth - visW, 0);
    const maxY = Math.max(img.naturalHeight - visH, 0);
    return { x: Math.min(Math.max(o.x, 0), maxX), y: Math.min(Math.max(o.y, 0), maxY) };
  };

  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!img) return;
    // 用函数式更新避免闭包陈旧（连续滚轮事件间 scale/off 可能未 re-render）
    setScale(prevScale => {
      const ns = Math.min(4, Math.max(1, prevScale - e.deltaY * 0.0012));
      // 以中心为锚缩放
      setOff(prevOff => {
        const cx = prevOff.x + visW / 2, cy = prevOff.y + visH / 2;
        const nvisW = STAGE / ns, nvisH = STAGE / ns;
        return clamp({ x: cx - nvisW / 2, y: cy - nvisH / 2 });
      });
      return ns;
    });
  };

  const confirm = () => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    canvas.width = STAGE; canvas.height = STAGE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, off.x, off.y, visW, visH, 0, 0, STAGE, STAGE);
    canvas.toBlob((b) => {
      if (!b) return;
      onConfirm(new File([b], 'avatar.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  };

  return (
    <div className="id-modal-overlay" onClick={onCancel}>
      <div className="id-modal avatar-crop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="id-modal-title">调整头像</div>
        <div className="id-modal-desc">拖动图片调整位置，滚轮缩放</div>
        <div
          className="avatar-crop-stage"
          style={{ width: STAGE, height: STAGE }}
          onMouseDown={(e) => {
            if (!img) return;
            dragRef.current = { sx: e.clientX, sy: e.clientY, ox: off.x, oy: off.y };
            const move = (ev: MouseEvent) => {
              if (!dragRef.current) return;
              setOff(clamp({
                x: dragRef.current.ox - (ev.clientX - dragRef.current.sx) / scale,
                y: dragRef.current.oy - (ev.clientY - dragRef.current.sy) / scale,
              }));
            };
            const up = () => { dragRef.current = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
          }}
          onWheel={handleWheel}
        >
          {img && (
            <img
              src={srcUrl}
              alt=""
              style={{
                position: 'absolute',
                left: -off.x * scale,
                top: -off.y * scale,
                width: img.naturalWidth * scale,
                height: img.naturalHeight * scale,
              }}
              draggable={false}
            />
          )}
          <div className="avatar-crop-border" />
          <div className="avatar-crop-corner tl" /><div className="avatar-crop-corner tr" />
          <div className="avatar-crop-corner bl" /><div className="avatar-crop-corner br" />
        </div>
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <div className="avatar-crop-actions">
          <button className="id-btn" onClick={onCancel}>取消</button>
          <button className="id-btn primary" onClick={confirm}>确认</button>
        </div>
      </div>
    </div>
  );
}
