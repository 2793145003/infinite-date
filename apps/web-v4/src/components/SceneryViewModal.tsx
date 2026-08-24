import React from 'react';
import { X, Sparkles, Heart } from 'lucide-react';

interface SceneryViewModalProps {
  title: string;
  onClose: () => void;
}

export const SceneryViewModal: React.FC<SceneryViewModalProps> = ({
  title,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-panel w-full max-w-sm rounded-2xl p-5 shadow-xl border border-border text-center">
        <div className="flex justify-end mb-1">
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-bg-muted text-ink hover:text-ink flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="w-14 h-14 rounded-2xl bg-bg-muted border border-border-strong flex items-center justify-center mx-auto mb-3 text-ink">
          <Heart className="w-6 h-6 stroke-[1.5]" />
        </div>

        <h3 className="text-sm font-bold text-ink tracking-tight mb-1">
          {title}
        </h3>
        <p className="text-xs text-ink leading-relaxed max-w-xs mx-auto mb-4">
          静谧的相处空间，在这里每一个眼神与呼吸都被妥帖珍藏。
        </p>

        <button
          onClick={onClose}
          className="w-full py-2 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition"
        >
          返回独处空间
        </button>
      </div>
    </div>
  );
};
