import { useState } from 'react';
import type { View } from '../AppV2';
import { FactsApp } from './FactsApp';
import { ArchiveApp } from './ArchiveApp';
import { ArchivedApps } from './ArchivedApps';

type Tab = 'facts' | 'archive' | 'archived';

// 日记页（v3）：整合「记忆（玩家事实）/ 回忆（约会·剧本）/ 归档」三类记忆功能
export function DiaryApp({ onBack, onNavigate }: { onBack: () => void; onNavigate: (v: View) => void }) {
  const [tab, setTab] = useState<Tab>('facts');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'facts', label: '🧠 记忆' },
    { key: 'archive', label: '💭 回忆' },
    { key: 'archived', label: '📦 归档' },
  ];

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">📔 日记</span>
      </div>

      <div className="id-diary-tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'facts' && <FactsApp onBack={onBack} embedded />}
      {tab === 'archive' && <ArchiveApp onBack={onBack} embedded />}
      {tab === 'archived' && <ArchivedApps onBack={onBack} onNavigate={onNavigate} embedded />}
    </div>
  );
}
