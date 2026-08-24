import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronLeft,
  Volume2,
  VolumeX,
  Image as ImageIcon,
  Heart,
  RefreshCw,
  Upload,
  Trash2,
  Check,
  Sparkles,
  Camera,
  Layers,
  Fish,
  MessageSquare,
  ChevronRight,
} from 'lucide-react';
import { Character, UserProfile } from '../types';
import { soundManager } from '../utils/audio';
import { processUploadedImage } from '../utils/imageUpload';
import { api } from '../lib/api';
import butterflyWallpaperImg from '../assets/images/butterfly_ripple_wallpaper_1786953401075.jpg';

interface PersonalSettingsScreenProps {
  activeCharacter: Character;
  userProfile: UserProfile;
  activeWallpaper: string;
  fishToggle: boolean;
  onSelectWallpaper: (url: string) => void;
  onUpdateCharacter: (updates: Partial<Character>) => void;
  onUpdateUserProfile: (updates: Partial<UserProfile>) => void;
  onResetData: () => void;
  onToggleFish: () => void;
  onOpenFeedback: () => void;
  onBack: () => void;
}

interface WallpaperItem {
  id: string;
  name: string;
  url: string;
  isCustom?: boolean;
}

const presetWallpapers: WallpaperItem[] = [
  {
    id: 'butterfly-watercolor',
    name: '水畔蝶影 · 原画',
    url: butterflyWallpaperImg,
  },
  {
    id: 'mist-blue',
    name: '冰晶薄雾蓝',
    url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'deep-blue-ocean',
    name: '深蓝海洋之境',
    url: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=800&q=80',
  },
  {
    id: 'starlit-night',
    name: '星光梦境晚风',
    url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=800&q=80',
  },
];

export const PersonalSettingsScreen: React.FC<PersonalSettingsScreenProps> = ({
  activeCharacter,
  userProfile,
  activeWallpaper,
  fishToggle,
  onSelectWallpaper,
  onUpdateCharacter,
  onUpdateUserProfile,
  onResetData,
  onToggleFish,
  onOpenFeedback,
  onBack,
}) => {
  const [isMuted, setIsMuted] = useState(soundManager.getMuted());
  const [customWallpapers, setCustomWallpapers] = useState<WallpaperItem[]>(() => {
    try {
      const saved = localStorage.getItem('serenity_custom_wallpapers');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadSuccessToast, setUploadSuccessToast] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const characterAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const userAvatarInputRef = useRef<HTMLInputElement | null>(null);

  const handleToggleSound = () => {
    const next = !isMuted;
    setIsMuted(next);
    soundManager.setMuted(next);
    if (!next) {
      soundManager.playWaterRipple();
    }
  };

  // Upload wallpaper handler
  const handleFileChange = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
      alert('请上传图片格式文件 (JPG, PNG, WebP等)');
      return;
    }

    try {
      setIsUploading(true);
      const compressedDataUrl = await processUploadedImage(file);
      const newCustomItem: WallpaperItem = {
        id: `custom_wp_${Date.now()}`,
        name: file.name.replace(/\.[^/.]+$/, '').slice(0, 12) || '我的自定义壁纸',
        url: compressedDataUrl,
        isCustom: true,
      };

      const updatedList = [newCustomItem, ...customWallpapers.slice(0, 7)];
      setCustomWallpapers(updatedList);
      try {
        localStorage.setItem('serenity_custom_wallpapers', JSON.stringify(updatedList));
      } catch (storageErr) {
        console.warn('LocalStorage limit reached for list, keeping in state', storageErr);
      }

      onSelectWallpaper(compressedDataUrl);
      soundManager.playAffectionGain();
      setUploadSuccessToast('壁纸已成功更换！');
      setTimeout(() => setUploadSuccessToast(null), 2500);
    } catch (err) {
      console.error('Failed to process image', err);
      alert('图片上传失败，请重试');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Handle Drag & Drop
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFileChange(e.dataTransfer.files);
  };

  // Delete Custom Wallpaper
  const handleDeleteCustomWallpaper = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    soundManager.playWaterRipple();
    const updated = customWallpapers.filter((item) => item.id !== id);
    setCustomWallpapers(updated);
    try {
      localStorage.setItem('serenity_custom_wallpapers', JSON.stringify(updated));
    } catch (err) {
      console.warn(err);
    }
    // If the active wallpaper was this one, reset to default
    const deletedItem = customWallpapers.find((item) => item.id === id);
    if (deletedItem && activeWallpaper === deletedItem.url) {
      onSelectWallpaper(presetWallpapers[0].url);
    }
  };

  // Handle Avatar Uploads
  const handleAvatarUpload = async (files: FileList | null, type: 'character' | 'user') => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) return;
    try {
      const dataUrl = await processUploadedImage(file, 400, 400, 0.9);
      if (type === 'character') {
        onUpdateCharacter({ avatarUrl: dataUrl });
      } else {
        onUpdateUserProfile({ avatarUrl: dataUrl });
      }
      soundManager.playAffectionGain();
      setUploadSuccessToast(type === 'character' ? '角色头像已更新' : '你的头像已更新');
      setTimeout(() => setUploadSuccessToast(null), 2500);
    } catch (err) {
      console.error('Avatar upload failed', err);
    }
  };

  const characterAvatarUrl = activeCharacter.avatarUrl || '';
  const userAvatarUrl = userProfile.avatarUrl || userProfile.avatar || '';

  return (
    <div className="w-full h-full flex flex-col justify-between relative px-3.5 sm:px-4 pb-2.5 sm:pb-3 overflow-hidden select-none">
      {/* Toast Notification */}
      <AnimatePresence>
        {uploadSuccessToast && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-solid/90 text-solid-contrast text-xs font-medium backdrop-blur-md shadow-lg flex items-center gap-1.5 border border-border-strong/20"
          >
            <Check className="w-3.5 h-3.5 text-sage" />
            <span>{uploadSuccessToast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Header */}
      <div className="pt-1 pb-2 flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onBack}
            className="w-8 h-8 rounded-full bg-bg-soft backdrop-blur-md border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition-colors shrink-0"
            aria-label="返回"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h2 className="text-xl sm:text-2xl font-bold text-ink tracking-tight">
            设置与个性化
          </h2>
        </div>
        <span className="text-[11px] text-ink font-medium">自定义空间</span>
      </div>

      {/* Settings Scroll Content */}
      <div className="flex-1 overflow-y-auto no-scrollbar space-y-3 pr-0.5 pb-[81px] z-10">
        {/* 1. Custom Wallpaper Upload Card */}
        <div className="frosted-glass-v3 rounded-[26px] p-4 shadow-[0_6px_24px_var(--color-shadow-brand)] border border-border-strong space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold text-ink">
              <ImageIcon className="w-4 h-4 text-cyan" />
              <span>更换背景壁纸</span>
            </div>
            <span className="text-[10px] text-cyan bg-bg-blue-soft px-2 py-0.5 rounded-full font-medium">
              支持上传任意图片
            </span>
          </div>

          {/* Upload Drop Zone & Button */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-2xl p-4 flex flex-col items-center justify-center text-center cursor-pointer transition-all ${
              isDragOver
                ? 'border-cyan bg-bg-blue-soft/80 scale-[1.01]'
                : 'border-border-strong/80 hover:border-cyan bg-bg-soft/70 hover:bg-bg-soft'
            }`}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={(e) => handleFileChange(e.target.files)}
              accept="image/*"
              className="hidden"
            />

            <div className="w-10 h-10 rounded-full bg-cyan/10 text-cyan flex items-center justify-center mb-2 shadow-xs">
              {isUploading ? (
                <div className="w-5 h-5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
              ) : (
                <Upload className="w-5 h-5" />
              )}
            </div>

            <p className="text-xs font-semibold text-ink">
              {isUploading ? '正在处理并应用新壁纸...' : '点击或拖拽上传你的专属壁纸'}
            </p>
            <p className="text-[10.5px] text-ink mt-0.5">
              支持相册照片、水彩插画、情侣合照等 (自动适配手机屏幕)
            </p>
          </div>

          {/* Custom Uploaded History List */}
          {customWallpapers.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="text-[11px] font-semibold text-ink flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-amber" />
                <span>我上传的壁纸</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {customWallpapers.map((wp) => {
                  const isSelected = activeWallpaper === wp.url;
                  return (
                    <div
                      key={wp.id}
                      onClick={() => {
                        onSelectWallpaper(wp.url);
                        soundManager.playWaterRipple();
                      }}
                      className={`relative rounded-xl overflow-hidden border-2 cursor-pointer group transition-all aspect-[9/16] ${
                        isSelected
                          ? 'border-cyan shadow-md ring-2 ring-cyan/40'
                          : 'border-border-strong opacity-85 hover:opacity-100 hover:border-cyan'
                      }`}
                    >
                      <img
                        src={wp.url}
                        alt={wp.name}
                        className="w-full h-full object-cover"
                      />
                      {isSelected && (
                        <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-cyan text-ink-on flex items-center justify-center shadow">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </div>
                      )}
                      <button
                        onClick={(e) => handleDeleteCustomWallpaper(wp.id, e)}
                        className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-rose text-ink-on flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        title="删除此壁纸"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Preset Wallpapers Gallery */}
          <div className="space-y-1.5 pt-1">
            <div className="text-[11px] font-semibold text-ink flex items-center gap-1">
              <Layers className="w-3 h-3 text-cyan" />
              <span>官方预设精选壁纸</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {presetWallpapers.map((wp) => {
                const isSelected = activeWallpaper === wp.url;
                return (
                  <div
                    key={wp.id}
                    onClick={() => {
                      onSelectWallpaper(wp.url);
                      soundManager.playWaterRipple();
                    }}
                    className={`relative rounded-xl overflow-hidden border-2 cursor-pointer transition-all aspect-[9/16] ${
                      isSelected
                        ? 'border-cyan shadow-md ring-2 ring-cyan/40'
                        : 'border-border-strong opacity-80 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={wp.url}
                      alt={wp.name}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    {isSelected && (
                      <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-cyan text-ink-on flex items-center justify-center shadow">
                        <Check className="w-2.5 h-2.5 stroke-[3]" />
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/80 to-transparent p-1">
                      <span className="text-[8.5px] font-medium text-white block truncate text-center">
                        {wp.name}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 2. Couple Profile Settings & Avatar Customization */}
        <div className="frosted-glass-v3 rounded-[26px] p-4 shadow-[0_6px_24px_var(--color-shadow-brand)] border border-border-strong space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold text-ink">
            <Heart className="w-4 h-4 text-rose fill-rose" />
            <span>恋人信息与头像</span>
          </div>

          {/* Avatars Custom Upload Row */}
          <div className="flex items-center justify-around py-1 bg-bg-soft/70 rounded-2xl p-2 border border-border-soft">
            {/* Character Avatar */}
            <div className="flex flex-col items-center gap-1">
              <input
                type="file"
                ref={characterAvatarInputRef}
                onChange={(e) => handleAvatarUpload(e.target.files, 'character')}
                accept="image/*"
                className="hidden"
              />
              <div
                onClick={() => characterAvatarInputRef.current?.click()}
                className="relative w-12 h-12 rounded-full overflow-hidden border-2 border-border-strong shadow cursor-pointer group"
              >
                {characterAvatarUrl ? (
                  <img
                    src={characterAvatarUrl}
                    alt={activeCharacter.name}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-full h-full bg-bg-muted-2 flex items-center justify-center text-ink font-bold text-base">
                    {(activeCharacter.name || '伴').slice(-1)}
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white">
                  <Camera className="w-4 h-4" />
                </div>
              </div>
              <span className="text-[10px] text-ink font-medium">
                {activeCharacter.name}头像
              </span>
            </div>

            <span className="text-ink font-serif italic text-base">&</span>

            {/* User Avatar */}
            <div className="flex flex-col items-center gap-1">
              <input
                type="file"
                ref={userAvatarInputRef}
                onChange={(e) => handleAvatarUpload(e.target.files, 'user')}
                accept="image/*"
                className="hidden"
              />
              <div
                onClick={() => userAvatarInputRef.current?.click()}
                className="relative w-12 h-12 rounded-full overflow-hidden border-2 border-border-strong shadow cursor-pointer group"
              >
                {userAvatarUrl ? (
                  <img
                    src={userAvatarUrl}
                    alt={userProfile.name}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <div className="w-full h-full bg-bg-muted-2 flex items-center justify-center text-ink font-bold text-base">
                    {(userProfile.name || '你').slice(0, 1)}
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white">
                  <Camera className="w-4 h-4" />
                </div>
              </div>
              <span className="text-[10px] text-ink font-medium">
                {userProfile.name || '你'}头像
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-ink font-medium">角色称谓：</label>
              <input
                type="text"
                value={activeCharacter.name}
                onChange={(e) => onUpdateCharacter({ name: e.target.value })}
                className="w-full mt-1 bg-bg-soft border border-border/80 rounded-xl px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-cyan focus:bg-bg-soft"
              />
            </div>

            <div>
              <label className="text-[11px] text-ink font-medium">你的称呼：</label>
              <input
                type="text"
                value={userProfile.name || ''}
                onChange={(e) => onUpdateUserProfile({ name: e.target.value })}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name) {
                    api.updatePlayer({ name }).catch(() => {});
                  }
                }}
                className="w-full mt-1 bg-bg-soft border border-border/80 rounded-xl px-3 py-1.5 text-xs text-ink focus:outline-none focus:border-cyan focus:bg-bg-soft"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className="text-[11px] text-ink font-medium">相识纪念日：</label>
              <input
                type="text"
                value={activeCharacter.startDate || '2026.04.30'}
                onChange={(e) => onUpdateCharacter({ startDate: e.target.value })}
                placeholder="2026.04.30"
                className="w-full mt-1 bg-bg-soft border border-border/80 rounded-xl px-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-cyan focus:bg-bg-soft"
              />
            </div>

            <div>
              <label className="text-[11px] text-ink font-medium">在一起天数：</label>
              <input
                type="number"
                value={activeCharacter.daysTogether}
                onChange={(e) => onUpdateCharacter({ daysTogether: Number(e.target.value) || 1 })}
                className="w-full mt-1 bg-bg-soft border border-border/80 rounded-xl px-3 py-1.5 text-xs text-ink font-mono focus:outline-none focus:border-cyan focus:bg-bg-soft"
              />
            </div>
          </div>
        </div>

        {/* 3. Sound Toggle */}
        <div className="frosted-glass-v3 rounded-[24px] p-4 shadow-[0_6px_24px_var(--color-shadow-brand)] border border-border-strong flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-bg-blue-soft flex items-center justify-center text-cyan">
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </div>
            <div>
              <div className="text-xs font-bold text-ink">触控音效与音乐盒</div>
              <div className="text-[10.5px] text-ink">水波涟漪、消息轻鸣与Lover旋律</div>
            </div>
          </div>
          <button
            onClick={handleToggleSound}
            className={`w-11 h-6 rounded-full transition-colors p-1 cursor-pointer flex items-center ${
              !isMuted ? 'bg-solid-soft justify-end' : 'bg-bg-muted-2 justify-start'
            }`}
          >
            <motion.div layout className="w-4 h-4 rounded-full bg-bg-soft shadow-sm" />
          </button>
        </div>

        {/* 4. Reset Data */}
        <div className="frosted-glass-v3 rounded-[24px] p-4 shadow-[0_6px_24px_var(--color-shadow-brand)] border border-border-strong space-y-2">
          <div className="text-xs font-bold text-ink">情侣空间存档</div>
          <p className="text-[11px] text-ink leading-relaxed">
            数据已本地加密持久化，如需重新体验相识初始状态可重置数据。
          </p>
          <button
            onClick={() => {
              if (window.confirm('确认重置情侣空间数据与聊天记录吗？')) {
                onResetData();
                soundManager.playWaterRipple();
              }
            }}
            className="w-full py-2 mt-1 rounded-full bg-bg-muted hover:bg-bg-rose-soft text-xs text-ink hover:text-rose font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>重置所有记录</span>
          </button>
        </div>

        {/* 5. 摸鱼模式 */}
        <div className="frosted-glass-v3 rounded-[24px] p-4 shadow-[0_6px_24px_var(--color-shadow-brand)] border border-border-strong flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-bg-amber-soft flex items-center justify-center text-amber">
              <Fish className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-bold text-ink">摸鱼模式</div>
              <div className="text-[10.5px] text-ink">伪装成 AI 助手，老板路过也看不出</div>
            </div>
          </div>
          <button
            onClick={onToggleFish}
            className={`w-11 h-6 rounded-full transition-colors p-1 cursor-pointer flex items-center ${
              fishToggle ? 'bg-solid-soft justify-end' : 'bg-bg-muted-2 justify-start'
            }`}
          >
            <motion.div layout className="w-4 h-4 rounded-full bg-bg-soft shadow-sm" />
          </button>
        </div>

        {/* 6. 反馈 */}
        <div className="frosted-glass-v3 rounded-[24px] p-4 shadow-[0_6px_24px_var(--color-shadow-brand)] border border-border-strong">
          <button
            onClick={onOpenFeedback}
            className="w-full flex items-center justify-between cursor-pointer group"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-bg-blue-soft flex items-center justify-center text-cyan">
                <MessageSquare className="w-4 h-4" />
              </div>
              <div className="text-left">
                <div className="text-xs font-bold text-ink">意见反馈</div>
                <div className="text-[10.5px] text-ink">提建议、报问题、看更新日志</div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-ink-faint group-hover:text-ink-soft transition-colors" />
          </button>
        </div>
      </div>
    </div>
  );
};
