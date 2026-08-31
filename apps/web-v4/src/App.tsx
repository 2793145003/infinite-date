/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Navigation } from './components/Navigation';
import { HomeScreen } from './components/HomeScreen';
import { CharacterArchiveScreen } from './components/CharacterArchiveScreen';
import { CharacterEditModal } from './components/CharacterEditModal';
import { CreatorApp } from './components/CreatorApp';
import { SettingsApp } from './components/SettingsApp';
import { MomentsScreen } from './components/MomentsScreen';
import { MailboxScreen } from './components/MailboxScreen';
import { DiaryScreen } from './components/DiaryScreen';
import { SmsScreen } from './components/SmsScreen';
import { FishMode } from './components/FishMode';
import { LoginScreen } from './components/LoginScreen';
import { api, getToken, setToken, setAuthFailHandler, clearToken } from './lib/api';
import type { PlayerInfo, CharacterData, MyCharacterSummary } from './lib/api';
import { syncHomeBgFromServer } from './lib/themes';
import { SceneMapScreen } from './components/SceneMapScreen';
import { SceneLocationDetail } from './components/SceneLocationDetail';
import { SceneExploreScreen } from './components/SceneExploreScreen';
import { SceneConversationScreen } from './components/SceneConversationScreen';
import { FeedbackScreen } from './components/FeedbackScreen';
import { AdminApp } from './components/AdminApp';
import { SceneryViewScreen } from './components/SceneryViewScreen';
import { MissionsApp } from './components/MissionsApp';
import { ScenarioSceneList } from './components/ScenarioSceneList';
import { ScenarioSceneDetail } from './components/ScenarioSceneDetail';
import { ScenarioSceneApp } from './components/ScenarioSceneApp';
import { ScenarioEditor } from './components/ScenarioEditor';
import { NovelList } from './components/NovelList';
import { NovelEditor } from './components/NovelEditor';
import { NovelPlay } from './components/NovelPlay';
import {
  Character,
  ChatMessage,
  ActiveTab,
  DateScenario,
  UserProfile,
  ActivityState,
} from './types';
import {
  INITIAL_CHARACTERS,
  INITIAL_CHAT_MESSAGES,
} from './data/mockData';

/**
 * 后端 CharacterData → 前端 Character 的映射。
 * 后端是「真实关系」模型（纯角色设定），前端 Character 混入的乙女数值字段
 * （亲密度/相伴天数/关系状态/身份/标签/状态签名）在后端没有对应概念，这里降级：
 *   - 关系状态 → 好友/已认识（来自 /me/characters 的 isFriend）
 *   - 身份 → background.current（角色「现状」）
 *   - 其余（亲密度/相伴天数/状态签名/标签）→ 空值或中性占位
 */
function mapCharacterDataToCharacter(cd: CharacterData, s: MyCharacterSummary): Character {
  return {
    id: s.characterId,
    name: cd.name,
    nickname: cd.name,
    gender: cd.gender === 'female' ? '女' : cd.gender === 'male' ? '男' : '未设定',
    age: cd.age || '',
    appearance: cd.appearance || '',
    identity: cd.background?.current || '未知',
    tag: s.isFriend ? '好友' : '角色',
    avatar: cd.name?.slice(-1) || '伴',
    avatarUrl: cd.avatar ? `/v4/api/uploads/${cd.avatar}` : '',
    status: '',
    relationshipStatus: s.isFriend ? '好友' : '已认识',
    daysTogether: s.friendCreatedAt ? Math.max(1, Math.ceil((Date.now() - s.friendCreatedAt) / 86400000)) : 0,
    startDate: '',
    intimacyLevel: 0,
    currentLocation: '',
    personaPrompt: '',
    wechatAccount: { id: '', passwordVal: '' },
    personalitySurface: cd.personality?.surface || '',
    personalityCore: cd.personality?.core || '',
    personalityExtreme: cd.personality?.extreme || '',
    speechStyle: cd.speechStyle?.description || '',
    messageStyle: cd.textingStyle?.description || '',
    emotionSignals: {
      nervous: cd.emotional_signals?.nervous || '',
      happy: cd.emotional_signals?.happy || '',
      angry: cd.emotional_signals?.angry || '',
      touched: cd.emotional_signals?.moved || '',
      defensive: cd.emotional_signals?.defensive || '',
    },
    background: {
      origin: cd.background?.origin || '',
      experience: cd.background?.shaping || '',
      current: cd.background?.current || '',
    },
    likes: (cd.likes || []).join('、'),
    dislikes: (cd.dislikes || []).join('、'),
    boundaries: cd.boundaries || '',
    goals: cd.goals || '',
    quirks: cd.quirks || '',
    relationshipWithPlayer: cd.player_relation || '',
    strengths: cd.skills || '',
    weaknesses: cd.ineptitudes || '',
    hasFork: s.hasFork,
    factCount: s.factCount,
    chronicleCount: s.chronicleCount,
  };
}

/** 当前角色的「当前行程」——约会/任务/剧本三态，空闲时 idle（类型定义见 types.ts） */

/** 加载「当前行程」：地图约会 > 剧本 > 任务 > 短信约会，返回行程中的角色 ID 与行程状态 */
async function loadActivityState(): Promise<{ activityCharId: string | null; activityState: ActivityState }> {
  try {
    const [activeScene, activeSc, missionsRes, activeSessionRes] = await Promise.all([
      api.getActiveScene(),
      api.getActiveSceneScenario(),
      api.getMissions(),
      api.getActiveSession(),
    ]);
    // 地图约会现场（scene-date）最优先
    if (activeScene?.session) {
      return {
        activityCharId: activeScene.session.characterId,
        activityState: { kind: 'scene-date', sessionId: activeScene.session.id, characterName: activeScene.session.characterName, locationName: activeScene.session.locationName, isGroup: activeScene.session.isGroup },
      };
    }
    if (activeSc?.active && activeSc.sessionId) {
      return {
        activityCharId: activeSc.characters?.[0] ?? null,
        activityState: { kind: 'scenario', sessionId: activeSc.sessionId, title: activeSc.title || '场景剧本' },
      };
    }
    const activeMission = missionsRes.missions.find((m) => m.status === 'active' && m.sessionId);
    if (activeMission) {
      return {
        activityCharId: activeMission.characterId ?? null,
        activityState: { kind: 'mission', sessionId: activeMission.sessionId!, title: activeMission.title || '任务' },
      };
    }
    if (activeSessionRes.session) {
      return {
        activityCharId: activeSessionRes.session.characterId,
        activityState: { kind: 'dating', sessionId: activeSessionRes.session.id, characterName: activeSessionRes.session.characterName, locationName: activeSessionRes.session.locationName },
      };
    }
    return { activityCharId: null, activityState: { kind: 'idle' } };
  } catch (e) {
    console.error('加载当前行程失败', e);
    return { activityCharId: null, activityState: { kind: 'idle' } };
  }
}

export default function App() {
  // Persistence state
  const [characters, setCharacters] = useState<Character[]>(() => {
    try {
      const saved = localStorage.getItem('serenity_characters');
      return saved ? JSON.parse(saved) : INITIAL_CHARACTERS;
    } catch {
      return INITIAL_CHARACTERS;
    }
  });

  const [activeCharacterId, setActiveCharacterId] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('serenity_active_char_id');
      return saved || 'char-sujin';
    } catch {
      return 'char-sujin';
    }
  });

  const [chatHistories, setChatHistories] = useState<Record<string, ChatMessage[]>>(() => {
    try {
      const saved = localStorage.getItem('serenity_chat_histories');
      return saved ? JSON.parse(saved) : INITIAL_CHAT_MESSAGES;
    } catch {
      return INITIAL_CHAT_MESSAGES;
    }
  });

  const [activeTab, setActiveTab] = useState<ActiveTab>('home');
  const [charactersVersion, setCharactersVersion] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [smsUnread, setSmsUnread] = useState(0);
  const [fishToggle, setFishToggle] = useState<boolean>(() => {
    try {
      return localStorage.getItem('idate_fish_toggle') === '1';
    } catch {
      return false;
    }
  });
  const [workMode, setWorkMode] = useState(false);
  const [exploreLocation, setExploreLocation] = useState<{ id: string; name: string } | null>(null);
  const [locationDetailId, setLocationDetailId] = useState<string | null>(null);
  const [conversationSessionId, setConversationSessionId] = useState<string | null>(null);
  const [smsTargetCharacterId, setSmsTargetCharacterId] = useState<string | null>(null);
  const [scenarioSessionId, setScenarioSessionId] = useState<string | null>(null);
  const [scenarioDetailId, setScenarioDetailId] = useState<string | null>(null);
  const [scenarioEditorId, setScenarioEditorId] = useState<string | null>(null);
  const [novelSessionId, setNovelSessionId] = useState<string | null>(null);
  const [novelEditorId, setNovelEditorId] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>({ kind: 'idle' });

  // 登录态：token + 玩家信息
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [player, setPlayer] = useState<PlayerInfo | null>(null);

  // token 失效（401）→ 回登录页
  useEffect(() => {
    setAuthFailHandler(() => {
      // 退出/401：清理 per-account 本地状态，避免跨账号串号（「当前选中角色」残留成上一个账号的角色）
      ['serenity_active_char_id', 'serenity_characters', 'serenity_chat_histories'].forEach((k) => localStorage.removeItem(k));
      setActiveCharacterId('');
      setTokenState(null);
    });
    return () => setAuthFailHandler(null);
  }, []);

  // 登录后从后端加载真实角色数据（/me/characters → 逐个 /characters/:id/edit）
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const { characters: summaries } = await api.listMyCharacters();
        if (cancelled) return;
        const chars: Character[] = [];
        for (const s of summaries) {
          try {
            const { characterData } = await api.getCharacterEdit(s.characterId);
            if (characterData) chars.push(mapCharacterDataToCharacter(characterData, s));
          } catch (e) {
            console.error('加载角色失败', s.characterId, e);
          }
        }
        if (cancelled) return;
        if (chars.length > 0) {
          setCharacters(chars);

          // 并行加载「当前行程」+「最后联系人」，决定默认选中的角色
          const { activityCharId, activityState } = await loadActivityState();
          if (cancelled) return;
          setActivity(activityState);

          let lastContactCharId: string | null = null;
          try {
            const { threads } = await api.getSmsThreads();
            // 最后联系的人（短信线程按时间降序，排除主神）
            lastContactCharId = threads.find((t) => t.character_id !== 'DEITY')?.character_id ?? null;
          } catch (e) {
            console.error('加载最后联系人失败', e);
          }

          if (cancelled) return;
          // 默认选中：约会进行中的人 > 最后主动联系的人 > 第一个（确保 ID 有效）
          const target = [lastContactCharId, activityCharId].find((id) => id && chars.some((c) => c.id === id)) || chars[0].id;
          setActiveCharacterId((prev) => {
            // 约会进行中：首页固定在约会中的那个人（否则「继续」的人和现场不是同一个人）
            const isDating = activityState.kind === 'scene-date' || activityState.kind === 'dating';
            if (isDating && activityCharId && chars.some((c) => c.id === activityCharId)) {
              return activityCharId;
            }
            return chars.some((c) => c.id === prev) ? prev : target;
          });
        } else {
          // 无好友/无角色：清空 mock，让首页显示「去地图上认识好友」空态
          setCharacters([]);
          setActiveCharacterId('');
          console.warn('后端角色列表为空，清空 mock 数据');
        }
      } catch (e) {
        console.error('加载角色列表失败', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, charactersVersion]);

  // 登录后/刷新后从后端加载真实玩家信息，同步玩家名到用户资料
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const { player: p } = await api.getPlayer();
        if (cancelled) return;
        setPlayer(p);
        if (p.name) {
          setUserProfile((prev) => ({ ...prev, name: p.name }));
        }
        // 壁纸入库：本地为空时用后端 home_bg 恢复（localStorage 被误删后兜底）
        syncHomeBgFromServer(p.home_bg);
      } catch (e) {
        console.error('加载玩家信息失败', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // 回到首页时刷新「当前行程」（玩家可能在任务/剧本/约会中改变了状态）
  useEffect(() => {
    if (!token || activeTab !== 'home') return;
    let cancelled = false;
    (async () => {
      const { activityState } = await loadActivityState();
      if (!cancelled) setActivity(activityState);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, activeTab]);

  // 短信未读角标：登录后拉取 + 每 30 秒刷新（底部导航「聊天」tab 显示未读数量）
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = () => {
      api.unreadSms()
        .then((res) => { if (!cancelled) setSmsUnread(res.count || 0); })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 30 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [token]);

  const handleLogin = (newToken: string, newPlayer: PlayerInfo) => {
    // 登录新账号前，清理上一个账号的 per-account 本地状态（防跨账号串号）
    ['serenity_active_char_id', 'serenity_characters', 'serenity_chat_histories'].forEach((k) => localStorage.removeItem(k));
    setActiveCharacterId('');
    setToken(newToken);
    setTokenState(newToken);
    setPlayer(newPlayer);
    // 同步真实玩家名到用户资料（替代默认假名'张琴'）
    setUserProfile((prev) => ({ ...prev, name: newPlayer.name }));
  };

  const handleLogout = () => {
    clearToken();
    ['serenity_active_char_id', 'serenity_characters', 'serenity_chat_histories'].forEach((k) => localStorage.removeItem(k));
    setActiveCharacterId('');
    setTokenState(null);
    setPlayer(null);
  };

  // User profile state
  const [userProfile, setUserProfile] = useState<UserProfile>(() => {
    try {
      const saved = localStorage.getItem('serenity_user_profile');
      return saved
        ? JSON.parse(saved)
        : {
            name: '张琴',
            appearance: '这里是描述描述',
            theme: '经典白',
            backgroundPreset: '舒适',
            workModeEnabled: false,
            workModeLabel: '可设置',
            dialogueTemp: 42,
          };
    } catch {
      return {
        name: '张琴',
        appearance: '这里是描述描述',
        theme: '经典白',
        backgroundPreset: '舒适',
        workModeEnabled: false,
        workModeLabel: '可设置',
        dialogueTemp: 42,
      };
    }
  });

  // Character editing state (dedicated standalone page)
  const [editingId, setEditingId] = useState<string | null>(null);

  // Standalone pages state
  const [sceneryChapterTitle, setSceneryChapterTitle] = useState('私人影院 · 独享包厢');

  // Save to localStorage
  useEffect(() => {
    localStorage.setItem('serenity_characters', JSON.stringify(characters));
  }, [characters]);

  useEffect(() => {
    localStorage.setItem('serenity_active_char_id', activeCharacterId);
  }, [activeCharacterId]);

  useEffect(() => {
    localStorage.setItem('serenity_chat_histories', JSON.stringify(chatHistories));
  }, [chatHistories]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  const activeCharacter =
    characters.find((c) => c.id === activeCharacterId) || characters[0] || INITIAL_CHARACTERS[0];

  // 继续当前行程：地图约会→场景现场、短信约会→聊天、任务/剧本→场景对话现场
  const handleContinueActivity = () => {
    if (activity.kind === 'scene-date') {
      setConversationSessionId(activity.sessionId);
      setActiveTab('map-dating');
    } else if (activity.kind === 'dating') {
      setActiveTab('chat');
    } else if (activity.kind === 'mission' || activity.kind === 'scenario') {
      setScenarioSessionId(activity.sessionId);
      setActiveTab('scenario-scene');
    }
  };

  // Handlers
  const handleSelectActiveCharacter = (character: Character) => {
    setActiveCharacterId(character.id);
    showToast(`已固定在主页：${character.name}`);
  };

  const handleEditCharacter = (character: Character) => {
    setEditingId(character.id);
  };

  const handleNewCharacter = () => {
    setActiveTab('creator');
  };

  const handleUpdateCharacter = (charId: string, partial: Partial<Character>) => {
    setCharacters((prev) =>
      prev.map((c) => (c.id === charId ? { ...c, ...partial } : c))
    );
  };

  const handleDeleteCharacter = (charId: string) => {
    setCharacters((prev) => prev.filter((c) => c.id !== charId));
    if (activeCharacterId === charId) {
      const remaining = characters.filter((c) => c.id !== charId);
      if (remaining.length > 0) {
        setActiveCharacterId(remaining[0].id);
      }
    }
    showToast('已删除角色档案');
  };

  const handleDeleteFriend = async (charId: string) => {
    try {
      await api.deleteFriend(charId);
      setCharactersVersion((v) => v + 1);
      showToast('已删除好友');
    } catch (e: any) {
      showToast(e?.message || '删除好友失败');
    }
  };

  const handleResetFork = async (charId: string) => {
    try {
      await api.resetCharacterFork(charId);
      setCharactersVersion((v) => v + 1);
      showToast('已恢复原版');
    } catch (e: any) {
      showToast(e?.message || '恢复原版失败');
    }
  };

  const handleImportCharacter = async (jsonText: string) => {
    // 走真实后端 /creation/import：按 CharacterData 格式落库（权限校验 + 角色卡 + 关系 + 家 + 广场），
    // 与「角色创建/编辑」共用同一套字段。失败抛错由 CharacterArchiveScreen 弹窗内展示。
    const res = await api.importCharacter(jsonText, true);
    setCharactersVersion((v) => v + 1);
    showToast(`已成功导入角色：${res.characterName}`);
  };

  const handleResetData = () => {
    localStorage.clear();
    setCharacters(INITIAL_CHARACTERS);
    setActiveCharacterId('char-sujin');
    setChatHistories(INITIAL_CHAT_MESSAGES);
    showToast('已重置为初始数据');
  };

  const handleToggleFish = () => {
    const next = !fishToggle;
    setFishToggle(next);
    try {
      localStorage.setItem('idate_fish_toggle', next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  // 未登录 → 登录页
  if (!token) {
    return (
      <div className="min-h-screen bg-ripple-pattern relative overflow-x-hidden flex flex-col">
        <LoginScreen onLogin={handleLogin} />
      </div>
    );
  }

  // 工作模式（伪装成 AI 助手）：由顶部「工作/灵感」开关控制
  if (workMode) {
    return (
      <div className="min-h-screen bg-panel relative overflow-x-hidden flex flex-col">
        <FishMode onExit={() => setWorkMode(false)} />
      </div>
    );
  }

  return (
    <div className="h-dvh bg-ripple-pattern text-ink font-body relative overflow-x-hidden flex flex-col selection:bg-ink-soft selection:text-white">
      {/* Main View Area */}
      <main className="flex-1 min-h-0 relative z-10 overflow-y-auto">
          {activeTab === 'home' && (
            <HomeScreen
              activeCharacter={activeCharacter}
              allCharacters={characters}
              onSelectCharacter={handleSelectActiveCharacter}
              onOpenChat={() => setActiveTab('chat')}
              onOpenMapDating={() => setActiveTab('map-dating')}
              onOpenNovel={() => setActiveTab('novels')}
              onOpenScenarios={() => setActiveTab('scenarios')}
              onOpenTasks={() => setActiveTab('task-world')}
              onOpenCharacterArchive={() => setActiveTab('archive')}
              onOpenMoments={() => setActiveTab('moments')}
              onOpenMailbox={() => setActiveTab('mailbox')}
              onOpenSettings={() => setActiveTab('settings')}
              activity={activity}
              onContinueActivity={handleContinueActivity}
            />
          )}

          {activeTab === 'map-dating' && (
            conversationSessionId ? (
              <SceneConversationScreen
                sessionId={conversationSessionId}
                onBack={() => setConversationSessionId(null)}
              />
            ) : locationDetailId ? (
              <SceneLocationDetail
                locationId={locationDetailId}
                onBack={() => setLocationDetailId(null)}
                onExplore={(id, name) => { setLocationDetailId(null); setExploreLocation({ id, name }); }}
                onOpenLocation={(id) => setLocationDetailId(id)}
                onStartScene={(sid) => { setLocationDetailId(null); setConversationSessionId(sid); }}
              />
            ) : exploreLocation ? (
              <SceneExploreScreen
                locationId={exploreLocation.id}
                locationName={exploreLocation.name}
                onBack={() => setExploreLocation(null)}
                onOpenConversation={(sid) => setConversationSessionId(sid)}
              />
            ) : (
              <SceneMapScreen
                onBack={() => setActiveTab('home')}
                onOpenLocation={(id) => setLocationDetailId(id)}
                onExplore={(id, name) => setExploreLocation({ id, name })}
              />
            )
          )}

          {activeTab === 'task-world' && (
            <MissionsApp
              onBack={() => setActiveTab('home')}
              onOpenScene={(sid) => { setScenarioSessionId(sid); setActiveTab('scenario-scene'); }}
            />
          )}

          {activeTab === 'scenarios' && (
            <ScenarioSceneList
              onBack={() => setActiveTab('home')}
              onOpenDetail={(sid) => { setScenarioDetailId(sid); setActiveTab('scenario-detail'); }}
              onOpenScene={(sid) => { setScenarioSessionId(sid); setActiveTab('scenario-scene'); }}
              onOpenEditor={() => { setScenarioEditorId(null); setActiveTab('scenario-editor'); }}
            />
          )}

          {activeTab === 'scenario-detail' && scenarioDetailId && (
            <ScenarioSceneDetail
              scenarioId={scenarioDetailId}
              onBack={() => { setScenarioDetailId(null); setActiveTab('scenarios'); }}
              onOpenScene={(sid) => { setScenarioSessionId(sid); setActiveTab('scenario-scene'); }}
            />
          )}

          {activeTab === 'scenario-scene' && scenarioSessionId && (
            <ScenarioSceneApp
              sessionId={scenarioSessionId}
              onBack={() => { setScenarioSessionId(null); setActiveTab('scenarios'); }}
              onBackToMissions={() => { setScenarioSessionId(null); setActiveTab('task-world'); }}
            />
          )}

          {activeTab === 'scenario-editor' && (
            <ScenarioEditor
              scenarioId={scenarioEditorId ?? undefined}
              onBack={() => { setScenarioEditorId(null); setActiveTab('scenarios'); }}
            />
          )}

          {activeTab === 'novels' && (
            <NovelList
              onBack={() => setActiveTab('home')}
              onOpenEditor={(id) => { setNovelEditorId(id); setActiveTab('novel-editor'); }}
              onOpenPlay={(sid) => { setNovelSessionId(sid); setActiveTab('novel-play'); }}
              currentPlayerId={player?.id ?? null}
            />
          )}

          {activeTab === 'novel-editor' && (
            <NovelEditor
              novelId={novelEditorId}
              onBack={() => { setNovelEditorId(null); setActiveTab('novels'); }}
              onEnter={(sid) => { setNovelSessionId(sid); setActiveTab('novel-play'); }}
            />
          )}

          {activeTab === 'novel-play' && novelSessionId && (
            <NovelPlay
              sessionId={novelSessionId}
              onBack={() => { setNovelSessionId(null); setActiveTab('novels'); }}
              onEdit={(id) => { setNovelEditorId(id); setActiveTab('novel-editor'); }}
            />
          )}

          {activeTab === 'scenery-view' && (
            <SceneryViewScreen
              title={sceneryChapterTitle}
              onBack={() => setActiveTab('diary')}
            />
          )}

          {activeTab === 'moments' && (
            <MomentsScreen
              activeCharacter={activeCharacter}
              allCharacters={characters}
              onBack={() => setActiveTab('home')}
              userName={userProfile.name}
            />
          )}

          {activeTab === 'mailbox' && (
            <MailboxScreen
              activeCharacter={activeCharacter}
              allCharacters={characters}
              onBack={() => setActiveTab('home')}
              userName={userProfile.name}
            />
          )}

          {activeTab === 'chat' && (
            <SmsScreen
              onOpenScenario={() => setActiveTab('scenarios')}
              onOpenCharacterArchive={() => setActiveTab('archive')}
              onBackToHome={() => setActiveTab('home')}
              onOpenConversation={(sid) => { setConversationSessionId(sid); setActiveTab('map-dating'); }}
              onOpenScene={(sid) => { setScenarioSessionId(sid); setActiveTab('scenario-scene'); }}
              initialCharacterId={smsTargetCharacterId}
            />
          )}

          {activeTab === 'diary' && (
            <DiaryScreen
              activeCharacter={activeCharacter}
              allCharacters={characters}
              onBack={() => setActiveTab('home')}
            />
          )}

          {activeTab === 'archive' && (
            <CharacterArchiveScreen
              characters={characters}
              activeCharacterId={activeCharacter.id}
              onBack={() => setActiveTab('home')}
              onSelectActiveCharacter={handleSelectActiveCharacter}
              onEditCharacter={handleEditCharacter}
              onNewCharacter={handleNewCharacter}
              onDeleteCharacter={handleDeleteCharacter}
              onDeleteFriend={handleDeleteFriend}
              onResetFork={handleResetFork}
              onImportCharacter={handleImportCharacter}
              onStartChat={(char) => { setSmsTargetCharacterId(char.id); setActiveTab('chat'); }}
            />
          )}

          {activeTab === 'creator' && (
            <CreatorApp
              onBack={() => setActiveTab('archive')}
              onCreated={() => setCharactersVersion((v) => v + 1)}
            />
          )}

          {activeTab === 'settings' && player && (
            <SettingsApp
              player={player}
              onBack={() => setActiveTab('home')}
              onLogout={handleLogout}
              onUpdate={() => { api.me().then((r) => setPlayer(r.player)).catch(() => {}); }}
              onNavigate={(view) => {
                if (view.type === 'feedback') setActiveTab('feedback');
                else if (view.type === 'admin') setActiveTab('admin');
                else if (view.type === 'experimental') setActiveTab('novels');
              }}
              onToggleFish={handleToggleFish}
            />
          )}

          {activeTab === 'feedback' && (
            <FeedbackScreen onBack={() => setActiveTab('settings')} />
          )}

          {activeTab === 'admin' && (
            <AdminApp onBack={() => setActiveTab('settings')} />
          )}
        </main>

        {/* 角色编辑弹窗（放 main 外，避免被 z-40 的 dock 层叠上下文压住） */}
        {editingId && (
          <CharacterEditModal
            characterId={editingId}
            onClose={() => setEditingId(null)}
            onSaved={() => setCharactersVersion((v) => v + 1)}
          />
        )}

        {/* Floating Bottom Navigation（弹窗打开时隐藏，避免透过半透明卡片露出来） */}
        {!editingId && <Navigation activeTab={activeTab} setActiveTab={setActiveTab} unreadCount={smsUnread} />}

        {/* Toast Notification */}
        {toastMessage && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-3.5 py-1.5 rounded-full text-xs font-semibold text-solid-contrast bg-solid shadow-md border border-border-dark animate-fade-in">
            {toastMessage}
          </div>
        )}

        {/* 摸鱼浮窗（设置页「工作模式」开关开启后显示，点击进入伪装成 AI 助手的摸鱼界面） */}
        {fishToggle && (
          <button
            onClick={() => setWorkMode(true)}
            aria-label="摸鱼"
            title="摸鱼：伪装成 AI 助手"
            className="fixed bottom-24 right-4 z-40 flex items-center gap-1.5 pl-3 pr-3.5 py-2 rounded-full bg-cyan text-ink-on shadow-lg shadow-cyan/20 border border-cyan/25 text-[12px] font-semibold active:scale-95 transition cursor-pointer"
          >
            <span className="text-[14px] leading-none">🐟</span>
            摸鱼
          </button>
        )}
    </div>
  );
}
