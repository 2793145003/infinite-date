import { useEffect, useState } from 'react';
import { ListTodo, Clapperboard, Mail, Users, Camera, BookOpen } from 'lucide-react';
import { api, imageUrl } from '../lib/api';
import { hasHomeBgImage } from '../lib/themes';
import { DivinationCard } from '../components/DivinationCard';
import type { View } from '../AppV2';
import type { PlayerInfo, MissionInfo, ActiveScenarioSession, ThreadInfo } from '../lib/api';

// 桌面图标（我们的 APP：好友 / 日记 / 任务 / 剧本 / 朋友圈 / 邮件）
const APP_DEFS = [
  { id: 'character-hub', icon: Users, label: '好友', view: { type: 'character-hub' as const } },
  { id: 'diary', icon: BookOpen, label: '日记', view: { type: 'diary' as const } },
  { id: 'missions', icon: ListTodo, label: '任务', view: { type: 'missions' as const } },
  { id: 'scenario-scene-list', icon: Clapperboard, label: '剧本', view: { type: 'scenario-scene-list' as const } },
  { id: 'moments', icon: Camera, label: '朋友圈', view: { type: 'moments' as const } },
  { id: 'mail', icon: Mail, label: '邮件', view: { type: 'mail' as const } },
];

export function DesktopV2({
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
  const [scenarioAvatars, setScenarioAvatars] = useState<{ characterId: string; name: string; avatar: string }[]>([]);
  const [awaitingReply, setAwaitingReply] = useState<ThreadInfo | null>(null);
  const [friends, setFriends] = useState<{ threadId: string; id: string; name: string; avatar?: string | null; onlineState?: string; schedule?: string }[]>([]);
  const [now, setNow] = useState(() => new Date());

  const hasHomeBg = hasHomeBgImage();

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
          scenarioSessionId: data.sessionId ?? '',
          scenarioId: data.scenarioId ?? '',
          scenarioTitle: data.title ?? '',
          characterId: '',
          characterName: charNames.join(' ＆ ') || '角色',
          isGroup: charNames.length >= 2,
          participants: charNames.length >= 2 ? charNames.map((name) => ({ name, characterId: '' })) : undefined,
          statsState: {},
          statsConfig: [],
          goalAchieved: data.goalAchieved ?? false,
          createdAt: 0,
        });
        // 剧本详情带参与者头像，异步补上
        if (data.sessionId) {
          api.sceneScenarioGet(data.sessionId).then(detail => {
            setScenarioAvatars(detail.participants ?? []);
          }).catch(() => {});
        }
      } else {
        setActiveScenario(null);
        setScenarioAvatars([]);
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
      // 已读未回（NPC 最后发言、我没回复的）优先级最高
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
    mail: unreadEmails,
    moments: unreadMoments,
  };

  // 各 widget 的头像（角色相关都要带头像，找不到回退首字母）
  const sceneDateAvatar = activeSceneDate?.avatar ?? null;
  const sessionAvatar = (() => {
    if (!activeSession) return null;
    const targetId = activeSession.isGroup
      ? activeSession.participants?.[0]?.characterId
      : activeSession.characterId;
    if (!targetId) return null;
    return friends.find(f => f.id === targetId)?.avatar ?? null;
  })();
  const scenarioAvatar = scenarioAvatars[0]?.avatar ?? null;
  const awaitingAvatar = awaitingReply?.avatar ?? null;

  // 男主头像卡（4 格）：进行中约会/剧本角色 > 最近好友 > 空
  const heroName = activeSceneDate?.characterName ?? activeSession?.characterName ?? friends[0]?.name ?? null;
  const heroAvatar = sceneDateAvatar ?? sessionAvatar ?? friends[0]?.avatar ?? null;
  const heroLocation = activeSceneDate?.locationName ?? activeSession?.locationName ?? friends[0]?.schedule ?? null;
  // 绿点 = 在线；按男主实际 online_state 判断（online 绿 / sleep·mission 灰），不硬编码「约会中=在线」
  const heroCharacterId = activeSceneDate?.characterId
    ?? (activeSession?.isGroup ? activeSession.participants?.[0]?.characterId : activeSession?.characterId)
    ?? friends[0]?.id
    ?? null;
  const heroOnline = heroCharacterId ? friends.find(f => f.id === heroCharacterId)?.onlineState === 'online' : false;

  const handleHeroClick = () => {
    if (activeSceneDate) {
      onNavigate({ type: 'scene-conversation', sessionId: activeSceneDate.id });
    } else if (activeSession) {
      onNavigate(
        activeSession.isGroup
          ? { type: 'group-conversation', sessionId: activeSession.id, locationId: activeSession.locationId, participants: activeSession.participants ?? [] }
          : { type: 'conversation', sessionId: activeSession.id, characterId: activeSession.characterId, locationId: activeSession.locationId }
      );
    } else if (friends[0]) {
      onNavigate({ type: 'sms-thread', threadId: friends[0].threadId, characterId: friends[0].id });
    }
  };

  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  const dateStr = `${now.getMonth() + 1}月${now.getDate()}日`;
  const weekStr = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const greetStr = now.getHours() < 5 ? '夜深了' : now.getHours() < 12 ? '早上好' : now.getHours() < 14 ? '中午好' : now.getHours() < 18 ? '下午好' : '晚上好';

  return (
    <div className={`id-home-screen${hasHomeBg ? ' has-home-bg' : ''}`}>
      {/* 格子定位：以底部 APP 图标为 4 列网格。小组件 8 格，男主头像 4 格，卦象 4 格 */}
      <div className="id-home-grid">
        {/* 小组件（8 格）：优先级 约会 > 剧本 > 任务进行中 > 已读未回 > 新任务 > 短信 > 邮件 > 时钟 */}
        {activeSceneDate ? (
          <div className="id-widget" onClick={() => onNavigate({ type: 'scene-conversation', sessionId: activeSceneDate.id })}>
            <div className="id-widget-label">💗 约会进行中</div>
            <div className="id-widget-title-row">
              <div className="id-widget-avatar">
                {sceneDateAvatar ? (
                  <img src={imageUrl(sceneDateAvatar)} alt="" className="id-widget-avatar-img" referrerPolicy="no-referrer" />
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
            <div className="id-widget-title-row">
              <div className="id-widget-avatar">
                {sessionAvatar ? (
                  <img src={imageUrl(sessionAvatar)} alt="" className="id-widget-avatar-img" referrerPolicy="no-referrer" />
                ) : (
                  (activeSession.characterName?.charAt(0) ?? '?')
                )}
              </div>
              <div className="id-widget-title">{activeSession.characterName}</div>
            </div>
            <div className="id-widget-hint">📍 {activeSession.locationName || '未知地点'} · 点击继续 →</div>
          </div>
        ) : activeScenario ? (
          <div className="id-widget" onClick={() => onNavigate({ type: 'scenario-scene', scenarioSessionId: activeScenario.scenarioSessionId })}>
            <div className="id-widget-label">🎭 剧本进行中</div>
            <div className="id-widget-title-row">
              <div className="id-widget-avatar">
                {scenarioAvatar ? (
                  <img src={imageUrl(scenarioAvatar)} alt="" className="id-widget-avatar-img" referrerPolicy="no-referrer" />
                ) : (
                  (activeScenario.characterName?.charAt(0) ?? '?')
                )}
              </div>
              <div className="id-widget-title">{activeScenario.scenarioTitle}</div>
            </div>
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
            <div className="id-widget-title-row">
              <div className="id-widget-avatar">
                {awaitingAvatar ? (
                  <img src={imageUrl(awaitingAvatar)} alt="" className="id-widget-avatar-img" referrerPolicy="no-referrer" />
                ) : (
                  ((awaitingReply.character_name ?? 'TA').charAt(0))
                )}
              </div>
              <div className="id-widget-title">{awaitingReply.character_name || 'TA'} 还在等你回复</div>
            </div>
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

        {/* 男主头像（4 格）：头像铺满 + 名字 + 行程，点击进入对话 */}
        <div className="id-friend-rail">
          <button className="id-friend-card" onClick={handleHeroClick}>
            {heroAvatar ? (
              <img src={imageUrl(heroAvatar)} alt="" className="id-friend-bg" referrerPolicy="no-referrer" />
            ) : (
              <div className="id-friend-bg-fallback">{heroName?.charAt(0) ?? '?'}</div>
            )}
            <div className="id-friend-overlay">
              <div className="id-friend-name">{heroName ?? '暂无男主'}</div>
              <div className="id-friend-schedule">{heroLocation || '点击互动 →'}</div>
            </div>
            <span className={`id-friend-dot${heroOnline ? ' is-online' : ''}`} />
          </button>
        </div>

        {/* 卦象（4 格） */}
        <DivinationCard onNavigateToMissions={() => onNavigate({ type: 'missions' })} />
      </div>

      {/* 图标区：真图标，白色毛玻璃方块 */}
      <div className="id-app-grid">
        {APP_DEFS.map((app) => {
          const Icon = app.icon;
          const badge = badgeMap[app.id] ?? 0;
          return (
            <button
              key={`${app.id}-${app.label}`}
              className="id-app-icon"
              onClick={() => onNavigate(app.view as View)}
            >
              <div className="id-app-tile">
                <Icon size={22} strokeWidth={1.5} />
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
