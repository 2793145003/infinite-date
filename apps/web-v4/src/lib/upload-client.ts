/**
 * 图片上传核心（XHR 版，带上传进度 + 超时）。
 *
 * 为什么不用 fetch：fetch 拿不到上传进度（无法驱动进度条），
 * 而且原来的实现没有超时——弱网下请求永久挂着，UI 就永远停在「上传中」。
 * XHR 的 upload.onprogress 能给出已发送字节数，timeout 能在慢网兜住。
 *
 * 注意：XHR 不走 installFetchAuth 的 window.fetch 拦截，token 必须手动带。
 */

export interface UploadProgress {
  /**
   * compress   本地压缩阶段（还不知道进度，显示为不确定态）
   * upload     正在往服务器传字节（pct 可靠）
   * processing 字节已发完、等服务器落库/返回（弱网下这一段可能好几秒，必须和 upload 分开显示，
   *            否则进度条会停在 100% 不动，看起来像卡死 —— 正是这次要修的问题）
   */
  phase: 'compress' | 'upload' | 'processing';
  /** 0~1（phase=compress/processing 时给上一次的值或 1） */
  pct: number;
}

export interface UploadResult {
  imagePath: string;
  size: number;
}

export interface UploadClientOptions {
  apiBase: string;
  token?: string | null;
  /** 传输超时（默认 90s）：慢网下宁可报错让用户重试，也不要永久卡住 */
  timeoutMs?: number;
  onProgress?: (p: UploadProgress) => void;
  /** 401 回调（token 失效） */
  onUnauthorized?: () => void;
}

export function uploadFileXhr(file: File, opts: UploadClientOptions): Promise<UploadResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${opts.apiBase}/upload/image`);
    if (opts.token) xhr.setRequestHeader('Authorization', `Bearer ${opts.token}`);
    xhr.timeout = timeoutMs;

    if (opts.onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) {
          opts.onProgress!({ phase: 'upload', pct: Math.min(1, e.loaded / e.total) });
        }
      };
      // 字节发完 → 进入「服务器处理中」，直到 onload/onerror 才结束
      xhr.upload.onload = () => opts.onProgress!({ phase: 'processing', pct: 1 });
    }

    xhr.onload = () => {
      let data: { imagePath?: string; size?: number; error?: string } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status === 401) {
        opts.onUnauthorized?.();
        reject(new Error('未认证'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.imagePath) {
        resolve({ imagePath: data.imagePath, size: data.size ?? file.size });
        return;
      }
      reject(new Error(data?.error || `上传失败（HTTP ${xhr.status}）`));
    };

    xhr.onerror = () => reject(new Error('网络中断，上传失败'));
    xhr.ontimeout = () => reject(new Error('上传超时（图片较大或网络太慢），请重试'));
    xhr.onabort = () => reject(new Error('上传已取消'));

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}
