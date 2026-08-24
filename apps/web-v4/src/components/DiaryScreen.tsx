import { useState } from 'react';
import { ChevronLeft, ArrowLeftRight } from 'lucide-react';
import { Character } from '../types';
import { getAnimeMaleAvatar } from '../data/animeAvatars';
import { FactsScreen } from './FactsScreen';
import { ArchiveView, type ArchiveKind } from './ArchiveView';
import { MissionRecords } from './MissionRecords';

type Tab = 'facts' | 'dates' | 'scenarios' | 'sms' | 'missions';

// 日记页：整合「记忆（player fact）/ 约会记录 / 剧本记录 / 短信记录 / 任务记录」五类
export function DiaryScreen({
  onBack,
  activeCharacter,
  allCharacters,
}: {
  onBack: () => void;
  activeCharacter: Character;
  allCharacters: Character[];
}) {
  const [tab, setTab] = useState<Tab>('dates');
  const [selectedCharId, setSelectedCharId] = useState<string>(activeCharacter.id);
  const [showSwitchMenu, setShowSwitchMenu] = useState(false);

  const curChar = allCharacters.find((c) => c.id === selectedCharId) || activeCharacter;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'dates', label: '约会' },
    { key: 'scenarios', label: '剧本' },
    { key: 'sms', label: '短信' },
    { key: 'missions', label: '任务' },
    { key: 'facts', label: '记忆' },
  ];

  return (
    <div className="w-full max-w-md mx-auto min-h-full px-3.5 pt-3 pb-24 flex flex-col select-none">
      {/* 顶层 header */}
      <header className="flex items-center gap-2 py-1.5 mb-2.5">
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition active:scale-95 cursor-pointer shadow-xs"
          aria-label="返回"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <h1 className="text-sm font-bold text-ink tracking-tight">日记</h1>
      </header>

      {/* 关系卡（上方）+ 右上角换人箭头 */}
      <div className="relative frosted-glass rounded-xl p-4 border border-border shadow-xs mb-2.5">
        <button
          onClick={() => setShowSwitchMenu(!showSwitchMenu)}
          className="absolute top-3 right-3 w-7 h-7 rounded-lg bg-bg-muted hover:bg-bg-muted-2 border border-border flex items-center justify-center text-ink transition cursor-pointer active:scale-95"
          aria-label="换人"
          title="切换角色"
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
        </button>

        <div className="flex items-center gap-3">
          <div className="w-14 h-14 rounded-full bg-solid border-2 border-border-soft shadow-xs overflow-hidden shrink-0">
            <img
              src={curChar.avatarUrl || getAnimeMaleAvatar(curChar.name)}
              alt={curChar.name}
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-bold text-ink tracking-tight">{curChar.name}</h2>
            <div className="text-xs text-ink-soft mt-0.5">{curChar.relationshipStatus || '尚未成为好友'}</div>
            <div className="text-xs text-ink-muted mt-0.5">
              {curChar.daysTogether > 0 ? `已相识 ${curChar.daysTogether} 天` : '尚未成为好友'}
            </div>
          </div>
        </div>

        {/* 换人弹出菜单 */}
        {showSwitchMenu && (
          <div className="mt-3 pt-3 border-t border-border-soft animate-in fade-in zoom-in-95 duration-150">
            <div className="grid grid-cols-4 gap-2">
              {allCharacters.map((char) => {
                const isCur = char.id === selectedCharId;
                return (
                  <button
                    key={char.id}
                    onClick={() => {
                      setSelectedCharId(char.id);
                      setShowSwitchMenu(false);
                    }}
                    className={`flex flex-col items-center p-2 rounded-xl border transition cursor-pointer ${
                      isCur
                        ? 'bg-solid text-solid-contrast border-border-dark shadow-xs'
                        : 'bg-bg-soft border-border text-ink hover:bg-bg-muted'
                    }`}
                  >
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center overflow-hidden ${
                        isCur ? 'bg-solid-soft' : 'bg-bg-muted-2'
                      }`}
                    >
                      <img
                        src={char.avatarUrl || getAnimeMaleAvatar(char.name)}
                        alt={char.name}
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                    <span className="text-[10px] font-medium mt-1 truncate max-w-full">{char.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* tab bar */}
      <div className="flex items-center gap-1.5 pb-2 overflow-x-auto no-scrollbar">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition shrink-0 cursor-pointer ${
              tab === t.key
                ? 'bg-solid text-solid-contrast shadow-xs'
                : 'frosted-glass border border-border text-ink hover:bg-bg-soft'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 内容区 */}
      {tab === 'facts' && (
        <FactsScreen activeCharacter={activeCharacter} allCharacters={allCharacters} onBack={onBack} embedded defaultCharId={selectedCharId} />
      )}
      {tab === 'dates' && <ArchiveView kind={'dates' as ArchiveKind} characterId={selectedCharId} />}
      {tab === 'scenarios' && <ArchiveView kind={'scenarios' as ArchiveKind} characterId={selectedCharId} />}
      {tab === 'sms' && <ArchiveView kind={'sms' as ArchiveKind} characterId={selectedCharId} />}
      {tab === 'missions' && <MissionRecords />}
    </div>
  );
}
