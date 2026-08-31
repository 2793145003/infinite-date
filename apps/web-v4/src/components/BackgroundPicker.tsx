import { useEffect, useRef, useState } from 'react';
import { api, imageUrl } from '../lib/api';

interface BackgroundPickerProps {
  /** 当前已保存的图片文件名（imagePath），用于回显预览 */
  value?: string;
  /** 上传或生成成功后回调（返回 imagePath） */
  onSelect: (imagePath: string) => void;
  /** 清除当前背景（可选） */
  onClear?: () => void;
  /** 生成弹窗的提示词预填（地点背景传「地点名+简介」，壁纸传空） */
  generatePlaceholder?: string;
  /** 加号下方的文字 */
  label?: string;
  /** 生成尺寸（默认 1024×1024 方形；竖屏聊天/主页背景传 768×1344） */
  size?: { width: number; height: number };
}

/**
 * 背景图选择器：点加号 → 上传图片 / 生成图片（自己输入提示词）
 * 与角色头像交互一致；生成不禁人（背景图允许出现人物）
 */
export function BackgroundPicker({
  value,
  onSelect,
  onClear,
  generatePlaceholder = '',
  label = '背景',
  size,
}: BackgroundPickerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [canGenerate, setCanGenerate] = useState(false);
  const [generatedPath, setGeneratedPath] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getImageGenEnabled().then(setCanGenerate);
  }, []);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const res = await api.uploadImage(file);
      onSelect(res.imagePath);
    } catch {
      alert('上传失败，请重试');
    } finally {
      setUploading(false);
    }
  };

  const openGenerate = () => {
    setMenuOpen(false);
    setPrompt(generatePlaceholder);
    setGeneratedPath(null);
    setShowPrompt(true);
  };

  const handleGenerate = async () => {
    const p = prompt.trim();
    if (!p) {
      alert('请先输入提示词');
      return;
    }
    setGenerating(true);
    try {
      // 背景图走场景分支，是否出人由 gemma 按提示词判断（玩家自输外貌提示词时也能正常出人）
      const res = await api.generateImage(p, { scene: true, width: size?.width, height: size?.height });
      setGeneratedPath(res.imagePath);
    } catch {
      alert('生成失败，请重试');
    } finally {
      setGenerating(false);
    }
  };

  const handleConfirm = () => {
    if (generatedPath) {
      onSelect(generatedPath);
      setShowPrompt(false);
      setGeneratedPath(null);
    }
  };

  return (
    <>
      <div className="relative">
        {value ? (
          // 已有背景：预览 + 重新选择 + 清除
          <div className="relative overflow-hidden rounded-xl border border-border-strong">
            <img src={imageUrl(value)} alt="背景预览" className="w-full h-24 object-cover" />
            <div className="absolute top-1 right-1 flex gap-1">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="w-7 h-7 rounded-full bg-black/50 text-white text-xs flex items-center justify-center hover:bg-black/70"
                title="重新选择"
              >
                ⇄
              </button>
              {onClear && (
                <button
                  type="button"
                  onClick={onClear}
                  className="w-7 h-7 rounded-full bg-black/50 text-white text-xs flex items-center justify-center hover:bg-rose"
                  title="清除"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        ) : (
          // 无背景：加号按钮
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={uploading || generating}
            className="flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-border-strong/80 hover:border-cyan p-3 text-ink-muted hover:text-cyan transition-colors"
          >
            <span className="text-base leading-none">{uploading || generating ? '⏳' : '＋'}</span>
            <span className="text-[10px]">{uploading ? '上传中…' : generating ? '生成中…' : label}</span>
          </button>
        )}

        {/* 上传 / 生成菜单 */}
        {menuOpen && (
          <div className="absolute left-0 top-full mt-1 z-30 bg-panel rounded-lg border border-border shadow-lg py-1 min-w-[128px]">
            <button
              type="button"
              onClick={() => { setMenuOpen(false); fileInputRef.current?.click(); }}
              className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
            >
              <span>🖼</span>上传图片
            </button>
            {canGenerate && (
              <button
                type="button"
                onClick={openGenerate}
                className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
              >
                <span>🎨</span>生成图片
              </button>
            )}
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUpload(file);
          e.target.value = '';
        }}
      />

      {/* 生成提示词弹窗 */}
      {showPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
          onClick={() => { if (!generating) { setShowPrompt(false); setGeneratedPath(null); } }}
        >
          <div
            className="w-full max-w-sm bg-panel rounded-2xl border border-border shadow-xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-ink">🎨 生成背景图</div>

            {generatedPath ? (
              <>
                <div className="relative overflow-hidden rounded-xl border border-border">
                  <img src={imageUrl(generatedPath)} alt="生成结果预览" className="w-full h-40 object-cover" />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setGeneratedPath(null)}
                    disabled={generating}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-bg-soft transition"
                  >
                    重新输入
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={generating}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs border border-border text-ink hover:bg-bg-soft transition disabled:opacity-50"
                  >
                    {generating ? '生成中…' : '🔄 重新生成'}
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={generating}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-cyan text-white hover:opacity-90 transition disabled:opacity-50"
                  >
                    ✓ 确认使用
                  </button>
                </div>
              </>
            ) : (
              <>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="描述你想要的画面，例如：午后阳光洒进的街角咖啡馆，暖色调…"
                  rows={4}
                  className="w-full resize-none bg-bg-soft border border-border/80 rounded-xl px-3 py-2 text-xs text-ink focus:outline-none focus:border-cyan"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setShowPrompt(false)}
                    disabled={generating}
                    className="px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-bg-soft transition"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={generating}
                    className="px-4 py-1.5 rounded-lg text-xs font-medium bg-cyan text-white hover:opacity-90 transition disabled:opacity-50"
                  >
                    {generating ? '生成中…' : '生成'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
