import { useState } from 'react';
import type { AdminTab } from '../components/admin/types';
import { InviteCodesPanel } from '../components/admin/InviteCodesPanel';
import { NpcPanel } from '../components/admin/NpcPanel';
import { LocationPanel } from '../components/admin/LocationPanel';

export function AdminApp({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<AdminTab>('invites');

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">🛠 管理</span>
      </div>
      <div style={{ display: 'flex', gap: '0.3rem', padding: '0.5rem 0.6rem 0' }}>
        <button
          className={`id-btn sm ${tab === 'invites' ? 'primary' : ''}`}
          style={{ flex: 1 }}
          onClick={() => setTab('invites')}
        >邀请码</button>
        <button
          className={`id-btn sm ${tab === 'npcs' ? 'primary' : ''}`}
          style={{ flex: 1 }}
          onClick={() => setTab('npcs')}
        >公共NPC</button>
        <button
          className={`id-btn sm ${tab === 'locations' ? 'primary' : ''}`}
          style={{ flex: 1 }}
          onClick={() => setTab('locations')}
        >地点</button>
      </div>
      <div className="id-app-scroll" style={{ paddingTop: '0.4rem' }}>
        {tab === 'invites' ? <InviteCodesPanel /> : tab === 'npcs' ? <NpcPanel /> : <LocationPanel />}
      </div>
    </div>
  );
}
