/**
 * 上传前压缩（浏览器端 canvas 缩放 + 重编码）。
 *
 * 为什么需要：手机相册/外部工具出图动辄 2~8MB，弱网上传要几十秒，
 * 中途断线还会让请求永久挂在服务端（前端一直「上传中」、按钮点不动）。
 *
 * 规则（压缩只是优化，任何时候失败都回退成原文件直传，绝不阻断上传）：
 *  - 体积 ≤ minBytes（默认 300KB）→ 原文件直传，不做无谓的重编码
 *  - GIF 动图 → 原文件直传（canvas 会把动画压成单帧）
 *  - 带 alpha 通道的 PNG → 保留 PNG（避免透明区域变白/黑底）
 *  - 其余 → JPEG q=quality
 *  - 解码失败 / 拿不到 2d 上下文 / 压完反而更大 → 原文件直传
 */

export interface CompressOptions {
  /** 长边上限（默认 1600） */
  maxSide?: number;
  /** JPEG 质量（默认 0.85） */
  quality?: number;
  /** 小于该体积直接放行（默认 300KB） */
  minBytes?: number;
}

export interface CompressResult {
  /** 用于上传的文件（未压缩时就是原文件） */
  file: File;
  compressed: boolean;
  before: number;
  after: number;
  width: number;
  height: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((b) => resolve(b), mime, quality);
    } else {
      resolve(null);
    }
  });
}

/** PNG 是否带 alpha：读 IHDR 颜色类型（4/6 一定有 alpha；调色板图再扫 tRNS 块） */
async function pngHasAlpha(file: File): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 33).arrayBuffer());
    if (head.length < 26) return true;
    if (!(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)) return false;
    const colorType = head[25];
    if (colorType === 4 || colorType === 6) return true;
    if (colorType === 3) {
      const tail = new Uint8Array(await file.slice(0, Math.min(file.size, 8192)).arrayBuffer());
      for (let i = 0; i + 4 <= tail.length; i++) {
        if (tail[i] === 0x74 && tail[i + 1] === 0x52 && tail[i + 2] === 0x4e && tail[i + 3] === 0x53) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

function renameExt(name: string, ext: string): string {
  const base = (name || 'image').replace(/\.[^./\\]+$/, '');
  return `${base}.${ext}`;
}

export async function compressImage(file: File, opts: CompressOptions = {}): Promise<CompressResult> {
  const maxSide = opts.maxSide ?? 1600;
  const quality = opts.quality ?? 0.85;
  const minBytes = opts.minBytes ?? 300 * 1024;
  const passthrough: CompressResult = {
    file,
    compressed: false,
    before: file.size,
    after: file.size,
    width: 0,
    height: 0,
  };

  if (typeof document === 'undefined') return passthrough;
  if (file.size <= minBytes) return passthrough;
  if (file.type === 'image/gif') return passthrough;

  let url = '';
  try {
    url = URL.createObjectURL(file);
    const img = await loadImage(url);
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    if (!sw || !sh) return passthrough;

    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return passthrough;
    ctx.drawImage(img, 0, 0, w, h);

    const keepPng = file.type === 'image/png' && (await pngHasAlpha(file));
    const mime = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, mime, quality);
    if (!blob || blob.size === 0 || blob.size >= file.size) return passthrough;

    return {
      file: new File([blob], renameExt(file.name, keepPng ? 'png' : 'jpg'), {
        type: mime,
        lastModified: Date.now(),
      }),
      compressed: true,
      before: file.size,
      after: blob.size,
      width: w,
      height: h,
    };
  } catch {
    return passthrough;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
