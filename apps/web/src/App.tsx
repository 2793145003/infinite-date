import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { api, setToken, clearToken, setAuthFailHandler, type PlayerInfo } from './lib/api';
import { PhoneShell } from './components/PhoneShell';
import { BootScreen } from './pages/Boot';
import { Desktop } from './pages/Desktop';
import { SmsApp } from './pages/SmsApp';
import { MailApp } from './pages/MailApp';
import { SettingsApp } from './pages/SettingsApp';
import { FactsApp } from './pages/FactsApp';
import { MapApp } from './pages/MapApp';
import { MissionsApp } from './pages/MissionsApp';
import { LocationDetail } from './pages/LocationDetail';
import { Conversation } from './pages/Conversation';
import { Explore } from './pages/Explore';
import { AdminApp } from './pages/AdminApp';
import { MySpaceApp } from './pages/MySpaceApp';
import { MomentsApp } from './pages/MomentsApp';
import { FeedbackApp } from './pages/FeedbackApp';
import { ScenarioList } from './pages/ScenarioList';
import { ScenarioDetail } from './pages/ScenarioDetail';
import { ScenarioEditor } from './pages/ScenarioEditor';
import { ScenarioConversation } from './pages/ScenarioConversation';
import { ScenarioDream } from './pages/ScenarioDream';
import { ScenarioSceneApp } from './pages/ScenarioSceneApp';
import { ScenarioSceneList } from './pages/ScenarioSceneList';
import { ScenarioSceneDetail } from './pages/ScenarioSceneDetail';
import { ArchiveApp } from './pages/ArchiveApp';
import { ArchivedApps } from './pages/ArchivedApps';
import { SceneMapApp } from './pages/SceneMapApp';
import { SceneLocation } from './pages/SceneLocation';
import { SceneConversation } from './pages/SceneConversation';
import { SceneExplore } from './pages/SceneExplore';
import { LiveConflictModal } from './components/LiveConflictModal';

export type View =
  | { type: 'desktop' }
  | { type: 'sms' }
  | { type: 'sms-thread'; threadId: string; characterId: string }
  | { type: 'mail' }
  | { type: 'mail-detail'; emailId: string }
  | { type: 'settings' }
  | { type: 'facts' }
  | { type: 'map' }
  | { type: 'location-detail'; locationId: string }
  | { type: 'conversation'; sessionId: string; characterId: string; locationId: string; greeting?: { environment: string; messages: string[]; internal: string; internal_notable: boolean } | null }
  | { type: 'group-conversation'; sessionId: string; locationId: string; greeting?: { messages: { speaker: string; text: string }[]; internals: Record<string, string>; internals_notable: Record<string, boolean> }; participants: { characterId: string; name: string }[] }
  | { type: 'explore'; sessionId: string; locationId: string; locationName: string; narration: string }
  | { type: 'missions' }
  | { type: 'admin' }
  | { type: 'myspace' }
  | { type: 'moments' }
  | { type: 'feedback' }
  | { type: 'scenarios' }
  | { type: 'scenario-detail'; scenarioId: string; isMine: boolean }
  | { type: 'scenario-editor'; scenarioId?: string }
  | { type: 'scenario-conversation'; scenarioSessionId: string }
  | { type: 'scenario-dream'; scenarioSessionId: string }
  | { type: 'scenario-scene'; scenarioSessionId: string }
  | { type: 'scenario-scene-list' }
  | { type: 'scenario-scene-detail'; scenarioId: string }
  | { type: 'archive' }
  | { type: 'archived' }
  | { type: 'scenemap' }
  | { type: 'scene-location'; locationId: string }
  | { type: 'scene-conversation'; sessionId: string }
  | { type: 'scene-explore'; locationId: string; locationName: string };  

export default function App() {
  const [player, setPlayer] = useState<PlayerInfo | null>(null);
  const [permissions, setPermissions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [netError, setNetError] = useState(false);
  const [view, setView] = useState<View>(() => {
    try {
      const saved = sessionStorage.getItem('idate_view');
      if (saved) return JSON.parse(saved) as View;
    } catch { /* ignore */ }
    return { type: 'desktop' };
  });
  const [unreadEmails, setUnreadEmails] = useState(0);
  const [unreadSms, setUnreadSms] = useState(0);
  const [unreadMoments, setUnreadMoments] = useState(0);
  const [unreadSuggestions, setUnreadSuggestions] = useState(0);
  const [maintenance, setMaintenance] = useState(false);

  // view 变化时持久化到 sessionStorage（切屏/刷新后恢复）
  useEffect(() => {
    try { sessionStorage.setItem('idate_view', JSON.stringify(view)); } catch { /* ignore */ }
  }, [view]);

  const refreshPlayer = useCallback(async () => {
    try {
      const data = await api.me();
      setPlayer(data.player);
      setPermissions(data.permissions);
      setNetError(false);
    } catch {
      // request() 在 401 时已经清了 token，这里不需要再清
      // 只有 token 真的没了才回到登录页；网络错误保留 token 让用户重试
      if (!localStorage.getItem('idate_token')) {
        setPlayer(null);
      } else {
        setNetError(true);
      }
    }
  }, []);

  // 连接监测：定时 ping /api/health，后端失联时显示维护横幅，恢复后自动隐藏
  useEffect(() => {
    if (!player) return;
    let alive = true;
    const ping = async () => {
      try {
        const res = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
        if (alive) setMaintenance(!res.ok);
      } catch {
        if (alive) setMaintenance(true);
      }
    };
    ping();
    const interval = setInterval(ping, 5000);
    return () => { alive = false; clearInterval(interval); };
  }, [player]);

  useEffect(() => {
    // token 失效时回到登录页（401 触发）
    setAuthFailHandler(() => {
      setPlayer(null);
      setNetError(false);
    });

    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      setToken(urlToken);
      window.history.replaceState({}, '', window.location.pathname);
    }
    const token = localStorage.getItem('idate_token');
    if (!token) {
      // 没有token，但有记住的邀请码→自动登录
      const savedCode = localStorage.getItem('idate_last_code');
      if (savedCode) {
        api.login(savedCode).then(data => {
          setToken(data.token);
          setPlayer(data.player);
          setLoading(false);
        }).catch(() => {
          setLoading(false);
        });
        return;
      }
      setLoading(false);
      return;
    }
    refreshPlayer().finally(() => setLoading(false));
  }, [refreshPlayer]);

  const handleLogin = (token: string, player: PlayerInfo) => {
    setToken(token);
    setPlayer(player);
  };

  const handleLogout = () => {
    clearToken();
    sessionStorage.removeItem('idate_view');
    setPlayer(null);
    setView({ type: 'desktop' });
  };

  // 刷新未读数
  const refreshUnread = useCallback(async () => {
    if (!player) return;
    try {
      const [emailData, smsData, momentsData, suggestionsData] = await Promise.all([
        api.getUnreadEmailCount(),
        api.getThreads(),
        api.getUnreadMomentsCount(Number(localStorage.getItem('idate_moments_seen') ?? 0)),
        api.getUnreadSuggestionsCount(Number(localStorage.getItem('idate_suggestions_seen') ?? 0)),
      ]);
      setUnreadEmails(emailData.count);
      setUnreadSms(smsData.threads.reduce((sum, t) => sum + t.unread_count, 0));
      setUnreadMoments(momentsData.count);
      setUnreadSuggestions(suggestionsData.count);
    } catch { /* ignore */ }
  }, [player]);

  // 轮询未读数
  useEffect(() => {
    if (!player) return;
    refreshUnread();
    const interval = setInterval(refreshUnread, 30000);
    return () => clearInterval(interval);
  }, [refreshUnread]);

  // 返回桌面/短信列表时立即刷新未读数（红点及时消除）
  useEffect(() => {
    if (view.type === 'desktop' || view.type === 'sms') {
      refreshUnread();
    }
  }, [view.type, refreshUnread]);

  // 当前屏幕内容
  const renderScreen = () => {
    if (loading) return <div className="id-loading">加载中…</div>;
    if (!player) {
      if (netError) {
        return (
          <div className="id-boot">
            <div className="id-boot-logo">
              <span className="id-boot-icon">∞</span>
              <span className="id-boot-title">无限心动</span>
            </div>
            <div className="id-boot-error">网络连接失败</div>
            <button className="id-boot-btn" onClick={() => { setNetError(false); setLoading(true); refreshPlayer().finally(() => setLoading(false)); }}>
              重试
            </button>
          </div>
        );
      }
      return <div className="id-fade-boot" key="boot"><BootScreen onLogin={handleLogin} /></div>;
    }

    const fadeKey = view.type === 'sms-thread' ? `sms-${view.threadId}`
      : view.type === 'mail-detail' ? `mail-${view.emailId}`
      : view.type;

    let content: ReactNode;
    switch (view.type) {
      case 'desktop':
        content = (
          <Desktop
            player={player}
            unreadEmails={unreadEmails}
            unreadSms={unreadSms}
            unreadMoments={unreadMoments}
            unreadSuggestions={unreadSuggestions}
            onNavigate={setView}
          />
        );
        break;
      case 'sms':
        content = <SmsApp onBack={() => setView({ type: 'desktop' })} onOpenThread={(tid, cid) => setView({ type: 'sms-thread', threadId: tid, characterId: cid })} />;
        break;
      case 'sms-thread':
        content = <SmsApp threadId={view.threadId} characterId={view.characterId} onBack={() => setView({ type: 'sms' })} onNavigate={setView} />;
        break;
      case 'mail':
        content = <MailApp onBack={() => setView({ type: 'desktop' })} onOpenEmail={(eid) => setView({ type: 'mail-detail', emailId: eid })} />;
        break;
      case 'mail-detail':
        content = <MailApp emailId={view.emailId} onBack={() => setView({ type: 'mail' })} />;
        break;
      case 'settings':
        content = <SettingsApp player={player} onBack={() => setView({ type: 'desktop' })} onLogout={handleLogout} onUpdate={refreshPlayer} />;
        break;
      case 'facts':
        content = <FactsApp onBack={() => setView({ type: 'desktop' })} />;
        break;
      case 'map':
        content = <MapApp onBack={() => setView({ type: 'desktop' })} onNavigate={setView} />;
        break;
      case 'location-detail':
        content = <LocationDetail
          locationId={view.locationId}
          onBack={() => setView({ type: 'map' })}
          onNavigate={setView}
        />;
        break;
      case 'conversation':
        content = <Conversation sessionId={view.sessionId} characterId={view.characterId} greeting={view.greeting} onBack={() => setView({ type: 'location-detail', locationId: view.locationId })} />;
        break;
      case 'group-conversation':
        content = <Conversation key="group" sessionId={view.sessionId} isGroup={true} greeting={view.greeting} participants={view.participants} onBack={() => setView({ type: 'location-detail', locationId: view.locationId })} />;
        break;
      case 'explore':
        content = <Explore sessionId={view.sessionId} locationId={view.locationId} locationName={view.locationName} initialNarration={view.narration} onBack={() => setView({ type: 'location-detail', locationId: view.locationId })} />;
        break;
      case 'missions':
        content = <MissionsApp onBack={() => setView({ type: 'desktop' })} onNavigate={setView} />;
        break;
      case 'admin':
        content = <AdminApp onBack={() => setView({ type: 'desktop' })} />;
        break;
      case 'myspace':
        content = <MySpaceApp onBack={() => setView({ type: 'desktop' })} />;
        break;
      case 'moments':
        content = <MomentsApp onBack={() => setView({ type: 'desktop' })} />;
        break;
      case 'feedback':
        content = <FeedbackApp onBack={() => setView({ type: 'desktop' })} />;
        break;
      case 'scenarios':
        content = <ScenarioList onBack={() => setView({ type: 'desktop' })} onNavigate={setView} />;
        break;
      case 'scenario-detail':
        content = <ScenarioDetail scenarioId={view.scenarioId} isMine={view.isMine} onBack={() => setView({ type: 'scenarios' })} onNavigate={setView} />;
        break;
      case 'scenario-editor':
        content = <ScenarioEditor scenarioId={view.scenarioId} onBack={() => setView({ type: 'scenarios' })} />;
        break;
      case 'scenario-conversation':
        content = <ScenarioConversation scenarioSessionId={view.scenarioSessionId} onBack={() => setView({ type: 'scenarios' })} onNavigate={setView} />;
        break;
      case 'scenario-dream':
        content = <ScenarioDream scenarioSessionId={view.scenarioSessionId} onBack={() => setView({ type: 'scenarios' })} onDone={() => setView({ type: 'desktop' })} />;
        break;
      case 'scenario-scene':
        content = <ScenarioSceneApp scenarioSessionId={view.scenarioSessionId} onBack={() => setView({ type: 'scenario-scene-list' })} onNavigate={setView} />;
        break;
      case 'scenario-scene-list':
        content = <ScenarioSceneList onBack={() => setView({ type: 'desktop' })} onNavigate={setView} />;
        break;
      case 'scenario-scene-detail':
        content = <ScenarioSceneDetail scenarioId={view.scenarioId} onBack={() => setView({ type: 'scenario-scene-list' })} onNavigate={setView} />;
        break;
      case 'archive':
        content = <ArchiveApp onBack={() => setView({ type: 'desktop' })} />;
        break;
      case 'archived':
        content = <ArchivedApps onBack={() => setView({ type: 'desktop' })} onNavigate={setView} />;
        break;
      case 'scenemap':
        content = (
          <SceneMapApp
            onBack={() => setView({ type: 'desktop' })}
            onOpenLocation={(locationId) => setView({ type: 'scene-location', locationId })}
          />
        );
        break;
      case 'scene-location':
        content = (
          <SceneLocation
            locationId={view.locationId}
            onBack={() => setView({ type: 'scenemap' })}
            onOpenScene={(sessionId) => setView({ type: 'scene-conversation', sessionId })}
            onExplore={(locationId, locationName) => setView({ type: 'scene-explore', locationId, locationName })}
            onOpenLocation={(locationId) => setView({ type: 'scene-location', locationId })}
          />
        );
        break;
      case 'scene-explore':
        content = (
          <SceneExplore
            locationId={view.locationId}
            locationName={view.locationName}
            onBack={() => setView({ type: 'scene-location', locationId: view.locationId })}
            onOpenScene={(sessionId) => setView({ type: 'scene-conversation', sessionId })}
          />
        );
        break;
      case 'scene-conversation':
        content = (
          <SceneConversation
            sessionId={view.sessionId}
            onBack={() => setView({ type: 'scenemap' })}
          />
        );
        break;
      default:
        content = <div className="id-empty">未知页面</div>;
    }
    return <div className="id-fade" key={fadeKey}>{content}</div>;
  };

  const goHome = () => setView({ type: 'desktop' });

  return (
    <PhoneShell
      permissions={permissions}
      showStatusbar={!!player}
      onHome={goHome}
    >
      {renderScreen()}
      {maintenance && (
        <div className="id-maintenance-banner">
          <span className="id-maintenance-dot" />
          服务器维护中，正在自动重连…
        </div>
      )}
      <LiveConflictModal onNavigate={(v) => setView(v as View)} />
    </PhoneShell>
  );
}
