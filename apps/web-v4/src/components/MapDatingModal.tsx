import React, { useState } from 'react';
import { X, MapPin, Heart, Sparkles, Navigation, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';
import { Character } from '../types';
import { CONFETTI_NEUTRAL } from '../constants/colors';

interface MapDatingModalProps {
  activeCharacter: Character;
  onClose: () => void;
  onSelectScene: (location: string) => void;
}

interface DateSpot {
  id: string;
  name: string;
  category: string;
  description: string;
  distance: string;
  atmosphere: string;
  intimacyReward: number;
}

export const MapDatingModal: React.FC<MapDatingModalProps> = ({
  activeCharacter,
  onClose,
  onSelectScene,
}) => {
  const [selectedSpotId, setSelectedSpotId] = useState<string>('spot-cinema');
  const [arrivedSpotId, setArrivedSpotId] = useState<string | null>(null);

  const charInitial = activeCharacter.name?.slice(-1) || '伴';

  const dateSpots: DateSpot[] = [
    {
      id: 'spot-cinema',
      name: '私人影院 · 独享包厢',
      category: '独处空间',
      description: '双人沙发与雪松香薰，午夜电影在银幕流转，他静静握住你的指尖。',
      distance: '0.4 km',
      atmosphere: '昏暗静谧 · 呼吸相近',
      intimacyReward: 15,
    },
    {
      id: 'spot-beach',
      name: '暮色海岸 · 潮汐漫步',
      category: '户外浪漫',
      description: '暮色将海浪染成深灰银色，晚风拂过衣角，在沙滩并肩留下两串脚印。',
      distance: '2.1 km',
      atmosphere: '宁静克制 · 晚风漫步',
      intimacyReward: 20,
    },
    {
      id: 'spot-cafe',
      name: '静谧厨房 · 烘焙时光',
      category: '日常温馨',
      description: '香草曲奇在烤箱里散发香气，他从身后递来温热的饮品。',
      distance: '1.2 km',
      atmosphere: '烟火人间 · 宁静日常',
      intimacyReward: 18,
    },
    {
      id: 'spot-stargaze',
      name: '云野露营 · 旷野守望',
      category: '星空私语',
      description: '仰望漫天星辰，他在微凉夜风里将大衣分你一半。',
      distance: '5.8 km',
      atmosphere: '静谧旷野 · 星辰见证',
      intimacyReward: 25,
    },
  ];

  const currentSpot = dateSpots.find((s) => s.id === selectedSpotId) || dateSpots[0];

  const handleArrive = () => {
    setArrivedSpotId(currentSpot.id);
    confetti({
      particleCount: 20,
      spread: 50,
      origin: { y: 0.6 },
      colors: CONFETTI_NEUTRAL,
    });
    setTimeout(() => {
      onSelectScene(currentSpot.name);
      onClose();
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-3">
      <div className="bg-panel w-full max-w-sm rounded-2xl p-4 shadow-xl border border-border flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-2.5 border-b border-border-soft">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-bg-muted border border-border-strong flex items-center justify-center text-xs font-bold text-ink">
              {charInitial}
            </div>
            <div>
              <h2 className="text-xs font-bold text-ink">地图约会 · 场景探索</h2>
              <span className="text-[10px] text-ink">选择与 {activeCharacter.name} 奔赴的目的地</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-bg-muted text-ink hover:text-ink flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Stylized Abstract Map Visual (Compact Monochrome) */}
        <div className="relative my-2.5 h-28 rounded-xl bg-bg-muted border border-border overflow-hidden flex items-center justify-center">
          {/* Subtle grid lines */}
          <div className="absolute inset-0 grid grid-cols-6 grid-rows-3 gap-1 opacity-20 pointer-events-none">
            {Array.from({ length: 18 }).map((_, i) => (
              <div key={i} className="border border-border-strong" />
            ))}
          </div>

          <div className="relative z-10 text-center px-4">
            <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full frosted-glass border border-border-strong shadow-xs mb-1">
              <MapPin className="w-3 h-3 text-ink" />
              <span className="text-xs font-bold text-ink">{currentSpot.name}</span>
            </div>
            <p className="text-[10px] text-ink">距当前位置 {currentSpot.distance} · {currentSpot.atmosphere}</p>
          </div>
        </div>

        {/* Spot Selection List */}
        <div className="space-y-1.5 overflow-y-auto flex-1 pr-0.5 mb-2.5">
          {dateSpots.map((spot) => {
            const isSelected = spot.id === selectedSpotId;
            return (
              <button
                key={spot.id}
                onClick={() => setSelectedSpotId(spot.id)}
                className={`w-full text-left p-2.5 rounded-xl border transition ${
                  isSelected
                    ? 'border-border-dark bg-bg-soft ring-1 ring-ink/10'
                    : 'border-border frosted-glass hover:bg-bg-soft'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-ink">{spot.name}</span>
                    <span className="text-[9px] px-1.5 py-0.2 rounded bg-bg-muted text-ink border border-border">
                      {spot.category}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-ink">{spot.distance}</span>
                </div>
                <p className="text-[10px] text-ink mt-1 line-clamp-1">{spot.description}</p>
              </button>
            );
          })}
        </div>

        {/* Footer Action */}
        <div className="pt-2 border-t border-border-soft flex items-center justify-between">
          <div className="flex items-center gap-1 text-[11px] text-ink font-medium">
            <Heart className="w-3 h-3 text-ink" />
            <span>心动值 +{currentSpot.intimacyReward}</span>
          </div>

          <button
            onClick={handleArrive}
            disabled={Boolean(arrivedSpotId)}
            className="px-4 py-1.5 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition flex items-center gap-1.5 shadow-xs"
          >
            {arrivedSpotId ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>已抵达</span>
              </>
            ) : (
              <>
                <Navigation className="w-3.5 h-3.5" />
                <span>立即奔赴</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
