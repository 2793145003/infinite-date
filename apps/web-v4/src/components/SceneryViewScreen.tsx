import React from 'react';
import { ArrowLeft, Sparkles, Heart, Compass, BookOpen, Share2 } from 'lucide-react';

interface SceneryViewScreenProps {
  title: string;
  onBack: () => void;
}

export const SceneryViewScreen: React.FC<SceneryViewScreenProps> = ({
  title,
  onBack,
}) => {
  return (
    <div
      id="scenery-view-screen"
      className="w-full max-w-[402px] mx-auto min-h-full text-ink flex flex-col justify-between relative select-none pb-8"
    >
      {/* Top Header */}
      <header className="px-4 py-3 frosted-glass border-b border-border/80 flex items-center justify-between sticky top-0 z-30 shadow-2xs">
        <div className="flex items-center gap-2.5">
          <button
            onClick={onBack}
            className="p-1 -ml-1 text-ink hover:text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
            aria-label="返回"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-solid text-solid-contrast flex items-center justify-center text-xs font-bold shadow-2xs">
              <BookOpen className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-xs font-bold text-ink">剧情长卷 · 场景特写</h1>
              <span className="text-[10px] text-ink">专属记忆与静谧空间</span>
            </div>
          </div>
        </div>

        <button
          onClick={onBack}
          className="px-2.5 py-1 rounded-lg bg-bg-muted hover:bg-bg-muted-2 text-ink text-[11px] font-medium transition cursor-pointer"
        >
          返回日记
        </button>
      </header>

      {/* Main Body */}
      <main className="flex-1 px-4 py-4 space-y-4">
        {/* Scenery Visual Stage */}
        <div className="relative rounded-2xl frosted-glass border border-border shadow-xs p-6 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-bg-muted border border-border-strong flex items-center justify-center mx-auto text-ink shadow-2xs">
            <Heart className="w-7 h-7 stroke-[1.5]" />
          </div>

          <div>
            <h2 className="text-base font-bold text-ink tracking-tight mb-1">
              {title || '避风港 · 安歇处'}
            </h2>
            <p className="text-xs text-ink leading-relaxed max-w-xs mx-auto">
              “ 静谧的相处空间，在这里每一个眼神与呼吸都被妥帖珍藏。 ”
            </p>
          </div>

          <div className="pt-3 border-t border-border-soft grid grid-cols-3 gap-2 text-center text-[10px] text-ink">
            <div className="p-2 bg-bg-soft rounded-xl">
              <span className="block text-ink">天气</span>
              <span className="font-semibold text-ink mt-0.5 block">微凉夜风</span>
            </div>
            <div className="p-2 bg-bg-soft rounded-xl">
              <span className="block text-ink">状态</span>
              <span className="font-semibold text-ink mt-0.5 block">独处陪伴</span>
            </div>
            <div className="p-2 bg-bg-soft rounded-xl">
              <span className="block text-ink">记录</span>
              <span className="font-semibold text-ink mt-0.5 block">已珍藏</span>
            </div>
          </div>
        </div>

        {/* Story Prose */}
        <div className="p-4 frosted-glass rounded-2xl border border-border shadow-2xs space-y-2.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink block">
            空间私语
          </span>
          <p className="text-xs text-ink leading-relaxed font-serif">
            指针在壁炉上方的铜钟里轻叩，夜色像浸了温热牛奶的墨汁，在窗棂外缓缓晕开。没有多余的寒暄与修饰，彼此的温度是这处静谧空间里唯一被明确丈量的距离。
          </p>
        </div>
      </main>

      {/* Sticky Bottom Action */}
      <footer className="sticky bottom-0 bg-bg-soft backdrop-blur-md border-t border-border pt-3 px-4 pb-[76px] flex items-center justify-between shadow-xs">
        <span className="text-xs text-ink">已收录于记忆回忆册</span>
        <button
          onClick={onBack}
          className="px-5 py-2 rounded-xl bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft active:scale-95 transition shadow-xs cursor-pointer"
        >
          返回上一页
        </button>
      </footer>
    </div>
  );
};
