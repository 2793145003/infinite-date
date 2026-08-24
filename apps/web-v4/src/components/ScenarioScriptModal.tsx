import React, { useState } from 'react';
import { X, Clapperboard, Play, Sparkles, Heart, ChevronRight } from 'lucide-react';
import confetti from 'canvas-confetti';
import { Character, DateScenario } from '../types';
import { CONFETTI_NEUTRAL } from '../constants/colors';

interface ScenarioScriptModalProps {
  activeCharacter: Character;
  scenarios: DateScenario[];
  onClose: () => void;
  onApplyScenarioToChat: (scenario: DateScenario, initialDialogue?: string) => void;
}

export const ScenarioScriptModal: React.FC<ScenarioScriptModalProps> = ({
  activeCharacter,
  scenarios,
  onClose,
  onApplyScenarioToChat,
}) => {
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(scenarios[0]?.id || 'scene-cinema');
  const [chosenChoiceIndex, setChosenChoiceIndex] = useState<number | null>(null);

  const selectedScenario = scenarios.find((s) => s.id === selectedScenarioId) || scenarios[0];
  const charInitial = activeCharacter.name?.slice(-1) || '伴';

  const handleChoiceSelect = (index: number) => {
    setChosenChoiceIndex(index);
    confetti({
      particleCount: 15,
      spread: 45,
      origin: { y: 0.6 },
      colors: CONFETTI_NEUTRAL,
    });
  };

  const handleStartInChat = () => {
    let dialogueText = '';
    if (chosenChoiceIndex !== null && selectedScenario?.choices[chosenChoiceIndex]) {
      dialogueText = `（你选择了：${selectedScenario.choices[chosenChoiceIndex].text}）`;
    }
    onApplyScenarioToChat(selectedScenario, dialogueText);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-3">
      <div className="glass-panel w-full max-w-sm rounded-2xl p-4 shadow-xl frosted-glass border border-border flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-2.5 border-b border-border-soft">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-bg-muted border border-border-strong flex items-center justify-center text-xs font-bold text-ink">
              <Clapperboard className="w-3.5 h-3.5" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-ink">场景剧本 · 剧情演练</h2>
              <span className="text-[10px] text-ink">沉浸式分支互动与情感演练</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-bg-muted text-ink hover:text-ink flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Scenarios Tabs (Horizontal monochrome pills) */}
        <div className="flex gap-1.5 overflow-x-auto py-2 border-b border-border-soft no-scrollbar">
          {scenarios.map((sc) => {
            const isSel = sc.id === selectedScenarioId;
            return (
              <button
                key={sc.id}
                onClick={() => {
                  setSelectedScenarioId(sc.id);
                  setChosenChoiceIndex(null);
                }}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition border ${
                  isSel
                    ? 'bg-solid text-solid-contrast border-border-dark'
                    : 'bg-bg-soft text-ink border-border hover:bg-bg-muted'
                }`}
              >
                {sc.title.split('·')[0].trim()}
              </button>
            );
          })}
        </div>

        {/* Selected Scenario Body (No image, pure typography) */}
        <div className="flex-1 overflow-y-auto space-y-2.5 py-2.5 pr-0.5">
          {/* Atmosphere Card */}
          <div className="p-3 bg-bg-soft rounded-xl border border-border-strong">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-xs font-bold text-ink">{selectedScenario.title}</h3>
              <span className="text-[9px] px-1.5 py-0.2 rounded bg-bg-muted-2 text-ink font-mono">
                {selectedScenario.location}
              </span>
            </div>
            <p className="text-[11px] text-ink leading-relaxed font-sans">
              {selectedScenario.description}
            </p>
          </div>

          {/* Dialogue preview */}
          <div className="space-y-1.5">
            <span className="text-[10px] text-ink font-bold uppercase tracking-wider block">
              情境开场白
            </span>
            {selectedScenario.dialogues.map((d, i) => (
              <div key={i} className="p-2 frosted-glass rounded-lg border border-border text-xs">
                <div className="flex items-center gap-1 mb-0.5">
                  <div className="w-4 h-4 rounded bg-bg-muted-2 text-ink text-[9px] font-bold flex items-center justify-center">
                    {charInitial}
                  </div>
                  <span className="font-bold text-ink text-[11px]">{d.speaker}</span>
                </div>
                <p className="text-ink text-xs leading-relaxed">{d.text}</p>
                {d.action && (
                  <p className="text-[10px] text-ink italic mt-0.5">{d.action}</p>
                )}
              </div>
            ))}
          </div>

          {/* Interactive Choices */}
          <div className="space-y-1.5 pt-1">
            <span className="text-[10px] text-ink font-bold uppercase tracking-wider block">
              分支心动回应
            </span>
            {selectedScenario.choices.map((choice, idx) => {
              const isSelected = chosenChoiceIndex === idx;
              return (
                <button
                  key={idx}
                  onClick={() => handleChoiceSelect(idx)}
                  className={`w-full text-left p-2.5 rounded-xl border transition ${
                    isSelected
                      ? 'bg-solid text-solid-contrast border-border-dark'
                      : 'frosted-glass border-border text-ink hover:bg-bg-soft'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{choice.text}</span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-bold ${
                        isSelected ? 'bg-solid-soft text-ink' : 'bg-bg-muted text-ink'
                      }`}
                    >
                      +{choice.affinityGain}
                    </span>
                  </div>

                  {isSelected && (
                    <p className="text-[10px] text-ink mt-1.5 pt-1.5 border-t border-border-dark italic">
                      苏烬反应：{choice.reaction}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-2 border-t border-border-soft flex items-center justify-between">
          <span className="text-[10px] text-ink">将剧情直接导入当前独处聊天</span>
          <button
            onClick={handleStartInChat}
            className="px-4 py-1.5 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition flex items-center gap-1"
          >
            <Play className="w-3.5 h-3.5 fill-white" />
            <span>进入剧本聊天</span>
          </button>
        </div>
      </div>
    </div>
  );
};
