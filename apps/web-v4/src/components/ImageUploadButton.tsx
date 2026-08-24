/**
 * 图片上传按钮 + 预览
 * 通用组件：短信、约会、朋友圈共用
 * 点击触发文件选择 → 上传到服务器 → 显示缩略图预览 → 可删除
 */
import { useState, useRef, useEffect } from 'react';
import { api, imageUrl } from '../lib/api';
import { AvatarCropModal } from './AvatarCropModal';

interface Props {
  onUploaded: (imagePath: string) => void;
  onClear: () => void;
  disabled?: boolean;
  /** 当前已保存的头像文件名（编辑已有头像时回显；发送图片场景不传） */
  value?: string;
  /** 方形裁剪：true 时（头像用途）选图后弹出裁剪器，先裁成方形再上传 */
  square?: boolean;
}

export function ImageUploadButton({ onUploaded, onClear, disabled, value, square }: Props) {
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => (value ? imageUrl(value) : null));
  const [error, setError] = useState<string | null>(null);
  const [cropFile, setCropFile] = useState<File | null>(null); // 待裁剪的源图
  const fileRef = useRef<HTMLInputElement>(null);

  // 外部 value 变化（加载已有头像 / 被清空）时同步预览
  useEffect(() => {
    // value 变为空串（外部显式清空头像）→ 清空本地预览
    if (value === '') { setPreviewUrl(null); }
    // value 从未赋值到赋值，或赋值到新值 → 显示该头像
    else if (value) { setPreviewUrl(imageUrl(value)); }
  }, [value]);

  const handleFile = async (file: File) => {
    setError(null);

    // 前端验证
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('图片不能超过10MB');
      return;
    }

    // 方形（头像）用途：弹出裁剪器，让用户裁好后再上传；非方形直接传
    if (square) {
      setCropFile(file);
      return;
    }

    await doUpload(file);
  };

  const doUpload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      // 本地预览
      const localUrl = URL.createObjectURL(file);
      setPreviewUrl(localUrl);
      const result = await api.uploadImage(file);
      onUploaded(result.imagePath);
      // 上传完成后释放预览 URL，避免内存泄漏
      URL.revokeObjectURL(localUrl);
    } catch (err) {
      setError((err as Error).message || '上传失败');
      setPreviewUrl(null);
    } finally {
      setUploading(false);
    }
  };

  const handleClear = () => {
    setPreviewUrl(null);
    setError(null);
    onClear();
    if (fileRef.current) fileRef.current.value = '';
  };

  if (previewUrl) {
    return (
      <>
        <div className="image-upload-preview">
          <img src={previewUrl} alt="预览" className="image-upload-thumb" />
          <button
            type="button"
            className="image-upload-remove"
            onClick={handleClear}
            disabled={disabled}
            aria-label="删除图片"
          >
            ✕
          </button>
        </div>
        {cropFile && (
          <AvatarCropModal
            file={cropFile}
            onCancel={() => { setCropFile(null); if (fileRef.current) fileRef.current.value = ''; }}
            onConfirm={async (blob) => { setCropFile(null); await doUpload(blob); }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="image-upload-wrap">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          className="image-upload-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          disabled={disabled || uploading}
        />
        <button
          type="button"
          className="image-upload-btn"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || uploading}
          aria-label="发送图片"
        >
          {uploading ? '⏳' : '＋'}
        </button>
        {error && <span className="image-upload-error">{error}</span>}
      </div>
      {cropFile && (
        <AvatarCropModal
          file={cropFile}
          onCancel={() => { setCropFile(null); if (fileRef.current) fileRef.current.value = ''; }}
          onConfirm={async (blob) => { setCropFile(null); await doUpload(blob); }}
        />
      )}
    </>
  );
}