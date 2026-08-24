import { useEffect, useRef, useState } from 'react';
import { api, imageUrl } from '../lib/api';
import { getHomeBg } from '../lib/themes';
import type { View } from '../App';
import type { PlayerInfo, MissionInfo, ActiveScenarioSession, ThreadInfo } from '../lib/api';
import { DivinationCard } from '../components/DivinationCard';

const APP_DEFS = [
  { id: 'sms', emoji: '💬', label: '短信', tint: 'cyan' as const, view: { type: 'sms' as const } },
  { id: 'scenemap', emoji: '🧭', label: '地图', tint: 'sage' as const, view: { type: 'scenemap' as const } },
  { id: 'missions', emoji: '📋', label: '待办', tint: 'amber' as const, view: { type: 'missions' as const } },
  { id: 'scenario-scene-list', emoji: '🎬', label: '场景剧本', tint: 'sage' as const, view: { type: 'scenario-scene-list' as const } },
  { id: 'archive', emoji: '📖', label: '回忆', tint: 'plum' as const, view: { type: 'archive' as const } },
  { id: 'moments', emoji: '📷', label: '朋友圈', tint: 'rose' as const, view: { type: 'moments' as const } },
  { id: 'facts', emoji: '🧠', label: '记忆', tint: 'plum' as const, view: { type: 'facts' as const } },
  { id: 'mail', emoji: '📧', label: '邮件', tint: 'plum' as const, view: { type: 'mail' as const } },
  { id: 'settings', emoji: '⚙️', label: '设置', tint: 'ember' as const, view: { type: 'settings' as const } },
  { id: 'myspace', emoji: '🏠', label: '空间', tint: 'cyan' as const, view: { type: 'myspace' as const } },
  { id: 'feedback', emoji: '💬', label: '反馈', tint: 'sage' as const, view: { type: 'feedback' as const } },
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
  const [activeMission, setActiveMission] = useState<MissionInfo | null>(null);
  const [activeScenario, setActiveScenario] = useState<ActiveScenarioSession | null>(null);
  const [homeBg] = useState(getHomeBg);
  const [awaitingReply, setAwaitingReply] = useState<ThreadInfo | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [friends, setFriends] = useState<{ threadId: string; id: string; name: string; avatar?: string | null; onlineState?: string; schedule?: string }[]>([]);
  const [activePage, setActivePage] = useState(0);
  const appPagesRef = useRef<HTMLDivElement>(null);

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
      const active = data.missions.find(m => m.status === 'active');
      setActiveMission(active ?? null);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api.getThreads().then(data => {
      const awaiting = data.threads
        .filter(t => t.unread_count === 0 && t.last_sender === 'npc')
        .sort((a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0))[0];
      setAwaitingReply(awaiting ?? null);

      // 好友 = 短信列表去主神（加了联系方式的才是好友）
      const friendThreads = data.threads.filter(t => t.character_name && t.character_name !== '主神');
      setFriends(friendThreads.map(t => ({
        threadId: t.id,
        id: t.character_id,
        name: t.character_name!,
        avatar: t.avatar,
        onlineState: t.online_state,
        schedule: '',
      })));
      // 异步补当前行程小字
      friendThreads.forEach(t => {
        api.getNpcSchedule(t.character_id).then(s => {
          if (s.current) {
            const text = `${s.current.locationName} · ${s.current.activity}`;
            setFriends(prev => prev.map(f => f.id === t.character_id ? { ...f, schedule: text } : f));
          }
        }).catch(() => {});
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const badgeMap: Record<string, number> = {
    sms: unreadSms,
    mail: unreadEmails,
    moments: unreadMoments,
    feedback: unreadSuggestions,
  };

  // 图标分两页：第一页 8 个常用，第二页其余（设置/工具类）
  const visibleApps = APP_DEFS.filter(app => app.id !== 'admin' || player.is_admin);
  const APP_PAGE_SIZE = 8;
  const appPages = [visibleApps.slice(0, APP_PAGE_SIZE), visibleApps.slice(APP_PAGE_SIZE)];

  const handleAppScroll = () => {
    const el = appPagesRef.current;
    if (!el) return;
    setActivePage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
  };

  const goToPage = (pi: number) => {
    const el = appPagesRef.current;
    if (!el) return;
    el.scrollTo({ left: pi * el.clientWidth, behavior: 'smooth' });
  };

  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
  const weekStr = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const greetStr = now.getHours() < 5 ? '夜深了' : now.getHours() < 12 ? '早上好' : now.getHours() < 14 ? '中午好' : now.getHours() < 18 ? '下午好' : '晚上好';

  return (
    <div className={`id-home-screen${homeBg.type !== 'none' ? ' has-home-bg' : ''}`}>
      <div className="id-home-grid">
        {/* Widget 区域：优先级 约会 > 剧本 > 任务进行中 > 已读未回 > 新任务 > 短信 > 邮件 > 默认时钟 */}
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
      ) : activeMission && activeMission.sessionId ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'scenario-scene', scenarioSessionId: activeMission.sessionId as string })}>
          <div className="id-widget-label">⚡ 任务进行中</div>
          <div className="id-widget-title">{activeMission.worldName || activeMission.title}</div>
          <div className="id-widget-hint">点击继续任务 →</div>
        </div>
      ) : awaitingReply ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'sms' })}>
          <div className="id-widget-label">💬 消息待回复</div>
          <div className="id-widget-title">{awaitingReply.character_name || 'TA'} 还在等你回复</div>
          <div className="id-widget-hint">点击回复 →</div>
        </div>
      ) : pendingMission ? (
        <div className="id-widget" onClick={() => onNavigate({ type: 'missions' })}>
          <div className="id-widget-label">🌍 世界任务</div>
          <div className="id-widget-title">{pendingMission.worldName || '未知世界'}</div>
          <div className="id-widget-hint">{(pendingMission.missionGoal || '点击查看任务详情').slice(0, 20)} · 点击查看 →</div>
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
      ) : (
        <div className="id-widget id-widget-clock">
          <div className="id-widget-clock-time">{timeStr}</div>
          <div className="id-widget-clock-date">{dateStr} · {weekStr}</div>
          <div className="id-widget-clock-greet">{greetStr}</div>
        </div>
      )}

        {/* 中间区域：左方形好友大图（头像铺满背景+文字蒙版，横滑切好友）+ 右长方形卦象卡 */}
        <div className="id-friend-rail">
          {friends.length === 0 ? (
            <div className="id-friend-card id-friend-empty">
              <div className="id-friend-bg id-friend-bg-fallback">?</div>
              <div className="id-friend-overlay">
                <div className="id-friend-name">暂无好友</div>
              </div>
            </div>
          ) : (
            friends.map(f => (
              <button
                key={f.id}
                className="id-friend-card"
                onClick={() => onNavigate({ type: 'sms-thread', threadId: f.threadId, characterId: f.id })}
              >
                {f.avatar ? (
                  <img src={imageUrl(f.avatar)} alt="" className="id-friend-bg" />
                ) : (
                  <div className="id-friend-bg id-friend-bg-fallback">{f.name.charAt(0)}</div>
                )}
                <div className="id-friend-overlay">
                  <div className="id-friend-name">{f.name}</div>
                  <div className="id-friend-schedule">{f.schedule || '\u00A0'}</div>
                </div>
                <span className={`id-friend-dot${f.onlineState === 'online' ? ' is-online' : ''}`} />
              </button>
            ))
          )}
        </div>
        <DivinationCard onNavigateToMissions={() => onNavigate({ type: 'missions' })} />
      </div>

      {/* 图标分两页：横滑切换 + 底部圆点指示 */}
      <div className="id-app-pages" ref={appPagesRef} onScroll={handleAppScroll}>
        {appPages.map((page, pi) => (
          <div className="id-app-page" key={pi}>
            {page.map((app) => {
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
        ))}
      </div>
      {appPages.length > 1 && (
        <div className="id-app-dots">
          {appPages.map((_, pi) => (
            <button
              key={pi}
              type="button"
              className={`id-app-dot${pi === activePage ? ' is-active' : ''}`}
              onClick={() => goToPage(pi)}
              aria-label={`第 ${pi + 1} 页`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
