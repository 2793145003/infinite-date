import { useEffect, useState } from 'react';
import { api, imageUrl } from '../lib/api';
import type { View } from '../App';
import type { PlayerInfo, MissionInfo, ActiveScenarioSession } from '../lib/api';

const APP_DEFS = [
  { id: 'missions', emoji: '📋', label: '待办', tint: 'amber' as const, view: { type: 'missions' as const } },
  { id: 'scenario-scene-list', emoji: '🎬', label: '场景剧本', tint: 'sage' as const, view: { type: 'scenario-scene-list' as const } },
  { id: 'scenemap', emoji: '🧭', label: '地图', tint: 'sage' as const, view: { type: 'scenemap' as const } },
  { id: 'sms', emoji: '💬', label: '短信', tint: 'cyan' as const, view: { type: 'sms' as const } },
  { id: 'mail', emoji: '📧', label: '邮件', tint: 'plum' as const, view: { type: 'mail' as const } },
  { id: 'settings', emoji: '⚙️', label: '设置', tint: 'ember' as const, view: { type: 'settings' as const } },
  { id: 'facts', emoji: '🧠', label: '记忆', tint: 'plum' as const, view: { type: 'facts' as const } },
  { id: 'myspace', emoji: '🏠', label: '空间', tint: 'cyan' as const, view: { type: 'myspace' as const } },
  { id: 'moments', emoji: '📷', label: '朋友圈', tint: 'rose' as const, view: { type: 'moments' as const } },
  { id: 'feedback', emoji: '💬', label: '反馈', tint: 'sage' as const, view: { type: 'feedback' as const } },
  { id: 'archive', emoji: '📖', label: '回忆', tint: 'plum' as const, view: { type: 'archive' as const } },
  { id: 'archived', emoji: '🗃️', label: '回收站', tint: 'ember' as const, view: { type: 'archived' as const } },
  { id: 'admin', emoji: '🛠', label: '管理', tint: 'ember' as const, view: { type: 'admin' as const } },
];

export function Desktop({
  player,
  unreadEmails,
  unreadSms,
  unreadMoments,
  unreadSuggestions,
  onNavigate,
}: {
  player: PlayerInfo;
  unreadEmails: number;
  unreadSms: number;
  unreadMoments: number;
  unreadSuggestions: number;
  onNavigate: (view: View) => void;
}) {
  const [activeSession, setActiveSession] = useState<{ id: string; characterId: string; characterName: string; locationId: string; locationName: string; isGroup?: boolean; participants?: { characterId: string; name: string }[] } | null>(null);
  const [activeSceneDate, setActiveSceneDate] = useState<{ id: string; characterId: string; characterName: string; avatar?: string; locationId: string | null; locationName: string; isGroup?: boolean; participants?: { characterId: string; name: string; avatar?: string }[] } | null>(null);
  const [pendingMission, setPendingMission] = useState<MissionInfo | null>(null);
  const [activeScenario, setActiveScenario] = useState<ActiveScenarioSession | null>(null);

  useEffect(() => {
    api.getActiveSession().then(data => {
      if (data.session) {
        setActiveSession({
          id: data.session.id,
          characterId: data.session.characterId,
          characterName: data.session.characterName ?? (data.session.participants?.map(p => p.name).join(' ＆ ') ?? ''),
          locationId: data.session.locationId ?? '',
          locationName: data.session.locationName,
          isGroup: data.session.isGroup,
          participants: data.session.participants,
        });
      } else {
        setActiveSession(null);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api.getActiveSceneDate().then(data => {
      if (data.session) {
        setActiveSceneDate({
          id: data.session.id,
          characterId: data.session.characterId,
          characterName: data.session.characterName,
          avatar: data.session.avatar,
          locationId: data.session.locationId,
          locationName: data.session.locationName,
          isGroup: data.session.isGroup,
          participants: data.session.participants,
        });
      } else {
        setActiveSceneDate(null);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api.getActiveScenario().then(data => {
      if (data.active) {
        const charNames = data.characters ?? [];
        setActiveScenario({
          scenarioSessionId: data.sessionId,
          scenarioId: data.scenarioId,
          scenarioTitle: data.title,
          characterId: '',
          characterName: charNames.join(' ＆ ') || '角色',
          isGroup: charNames.length >= 2,
          participants: charNames.length >= 2 ? charNames.map((name: string) => ({ name, characterId: '' })) : undefined,
          statsState: {},
          statsConfig: [],
        } as any);
      } else {
        setActiveScenario(null);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api.getMissions().then(data => {
      const pending = data.missions.find(m => m.status === 'available');
      setPendingMission(pending ?? null);
    }).catch(() => {});
  }, []);

  const badgeMap: Record<string, number> = {
    sms: unreadSms,
    mail: unreadEmails,
    moments: unreadMoments,
    feedback: unreadSuggestions,
  };

  return (
    <div className="id-home-screen">
      {/* Widget 区域：优先级 进行中约会 > 剧本进行中 > 世界任务 > 短信 > 邮件 */}
      {activeSceneDate ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'scene-conversation', sessionId: activeSceneDate.id })}>
          <div className="id-widget-label">💗 约会进行中</div>
          <div className="id-widget-title-row">
            <div className="id-widget-avatar">
              {activeSceneDate.avatar ? (
                <img src={imageUrl(activeSceneDate.avatar)} alt="" className="id-widget-avatar-img" />
              ) : (
                (activeSceneDate.characterName?.charAt(0) ?? '?')
              )}
            </div>
            <div className="id-widget-title">{activeSceneDate.characterName}</div>
          </div>
          <div className="id-widget-hint">📍 {activeSceneDate.locationName || '未知地点'} · 点击继续 →</div>
        </div>
      ) : activeSession ? (
        <div className="id-widget" onClick={() => onNavigate(
          activeSession.isGroup
            ? { type: 'group-conversation', sessionId: activeSession.id, locationId: activeSession.locationId, participants: activeSession.participants ?? [] }
            : { type: 'conversation', sessionId: activeSession.id, characterId: activeSession.characterId, locationId: activeSession.locationId }
        )}>
          <div className="id-widget-label">💗 约会进行中</div>
          <div className="id-widget-title">{activeSession.characterName}</div>
          <div className="id-widget-hint">📍 {activeSession.locationName || '未知地点'} · 点击继续 →</div>
        </div>
      ) : activeScenario ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'scenario-scene', scenarioSessionId: activeScenario.scenarioSessionId })}>
          <div className="id-widget-label">🎭 剧本进行中</div>
          <div className="id-widget-title">{activeScenario.scenarioTitle}</div>
          <div className="id-widget-hint">与{activeScenario.isGroup && activeScenario.participants ? activeScenario.participants.map(p => p.name).join(' & ') : activeScenario.characterName} · 点击继续 →</div>
        </div>
      ) : pendingMission ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'missions' })}>
          <div className="id-widget-label">🌍 世界任务</div>
          <div className="id-widget-title">{pendingMission.worldName || '未知世界'}</div>
          <div className="id-widget-hint">回收：{pendingMission.item?.slice(0, 20) ?? '未知物品'}… · 点击查看 →</div>
        </div>
      ) : unreadSms > 0 ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'sms' })}>
          <div className="id-widget-label">💬 新短信</div>
          <div className="id-widget-title">{unreadSms}条未读消息</div>
          <div className="id-widget-hint">点击查看 →</div>
        </div>
      ) : unreadEmails > 0 ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'mail' })}>
          <div className="id-widget-label">📬 未读邮件</div>
          <div className="id-widget-title">{unreadEmails}封新邮件</div>
          <div className="id-widget-hint">点击查看 →</div>
        </div>
      ) : null}

      <div className="id-app-grid">
        {APP_DEFS.filter(app => app.id !== 'admin' || player.is_admin).map((app) => {
          const badge = badgeMap[app.id] ?? 0;
          return (
            <button
              key={app.id}
              className="id-app-icon"
              onClick={() => onNavigate(app.view)}
            >
              <div className={`id-app-tile is-${app.tint}`}>
                <span style={{ fontSize: '1.4rem' }}>{app.emoji}</span>
                {badge > 0 && <span className="id-app-badge">{badge}</span>}
              </div>
              <span className="id-app-label">{app.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
