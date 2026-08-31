import React, { useState, useEffect } from 'react';
import { ArrowLeftRight, Camera, MapPin, Sparkles, Heart, Bell, Mail, Map, Compass, Clapperboard, BookOpen } from 'lucide-react';
import { Character, ActivityState } from '../types';
import { getAnimeMaleAvatar } from '../data/animeAvatars';
import { api } from '../lib/api';

interface HomeScreenProps {
  activeCharacter: Character;
  allCharacters: Character[];
  onSelectCharacter: (char: Character) => void;
  onOpenChat: () => void;
  onOpenMapDating: () => void;
  onOpenNovel: () => void;
  onOpenScenarios: () => void;
  onOpenTasks: () => void;
  onOpenCharacterArchive: () => void;
  onOpenMoments?: () => void;
  onOpenMailbox?: () => void;
  onOpenSettings?: () => void;
  onOpenLocationSelect?: () => void;
  activity: ActivityState;
  onContinueActivity: () => void;
  userAvatar?: string;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  activeCharacter,
  allCharacters,
  onSelectCharacter,
  onOpenChat,
  onOpenMapDating,
  onOpenNovel,
  onOpenScenarios,
  onOpenTasks,
  onOpenCharacterArchive,
  onOpenMoments,
  onOpenMailbox,
  onOpenSettings,
  onOpenLocationSelect,
  activity,
  onContinueActivity,
}) => {
  const [showSwitchMenu, setShowSwitchMenu] = useState(false);
  const [idleSchedule, setIdleSchedule] = useState<{ locationName: string; activity: string } | null>(null);
  // 位置文案：默认主城，约会显示约会地点，任务显示「任务场景」，剧本显示「场景剧本中」
  const locationText =
    activity.kind === 'scene-date' ? activity.locationName || '约会中'
    : activity.kind === 'dating' ? activity.locationName || '约会中'
    : activity.kind === 'scenario' ? '场景剧本中'
    : activity.kind === 'mission' ? '任务场景'
    : '主城';
  const [momentsUnread, setMomentsUnread] = useState(0);
  const [emailsUnread, setEmailsUnread] = useState(0);

  // Live real clock state
  const [currentTime, setCurrentTime] = useState({
    time: '10:24',
    date: '10月24日 , 周日',
  });

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const month = now.getMonth() + 1;
      const date = now.getDate();
      const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const dayName = days[now.getDay()];

      setCurrentTime({
        time: `${hours}:${minutes}`,
        date: `${month}月${date}日 , ${dayName}`,
      });
    };

    updateTime();
    const timer = setInterval(updateTime, 1000 * 30);
    return () => clearInterval(timer);
  }, []);

  // 空闲时加载角色当前行程（在哪里做什么）；非好友/无数据 → 回退「空闲」
  useEffect(() => {
    if (activity.kind !== 'idle' || !activeCharacter?.id) {
      setIdleSchedule(null);
      return;
    }
    let cancelled = false;
    api.getNpcSchedule(activeCharacter.id)
      .then((res) => { if (!cancelled) setIdleSchedule(res.current); })
      .catch(() => { if (!cancelled) setIdleSchedule(null); });
    return () => { cancelled = true; };
  }, [activity.kind, activeCharacter?.id]);

  // 未读角标：朋友圈新帖/新互动 + 未读邮件（后端真实统计）
  useEffect(() => {
    let cancelled = false;
    api.unreadMoments(Number(localStorage.getItem('idate_moments_seen') ?? 0))
      .then((res) => { if (!cancelled) setMomentsUnread(res.count || 0); })
      .catch(() => {});
    api.unreadEmails()
      .then((res) => { if (!cancelled) setEmailsUnread(res.count || 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const charInitial = activeCharacter.name?.slice(-1) || '烬';

  // 当前行程的显示文案/图标
  const activityMeta = (
    {
      idle: { label: '空闲', icon: '🕊️' },
      'scene-date': { label: '约会中', icon: '💗' },
      dating: { label: '约会中', icon: '💗' },
      mission: { label: '任务中', icon: '⚔️' },
      scenario: { label: '剧本中', icon: '🎬' },
    } as const
  )[activity.kind];

  // 约会进行中：主页角色锁定在约会对象，禁止切换
  const isDating = activity.kind === 'scene-date' || activity.kind === 'dating';

  // 每日寄语：gemma 现场写（换角色重新生成）；加载中/生成失败兜底默认句
  const DEFAULT_POEMS = [
    '“ 那些共度的静谧时光，最为震耳欲聋。 ”',
    '“ 只要你在身边，无论哪种沉默都很温柔。 ”',
    '“ 晚风吹过街道，你在我身旁便是一切归宿。 ”',
    '“ 所有的心动与偏爱，都只为你一人写就。 ”',
  ];
  const [poem, setPoem] = useState<string | null>(null);

  useEffect(() => {
    setPoem(null); // 切角色先清空，避免短暂显示上一个角色的寄语
    if (!activeCharacter?.id) return;
    let cancelled = false;
    api.getHomePoem(activeCharacter.id)
      .then((res) => { if (!cancelled && res.poem) setPoem(res.poem); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeCharacter?.id]);

  return (
    <div
      id="home-screen-container"
      className="w-full max-w-md mx-auto min-h-full px-3.5 pt-3 pb-24 flex flex-col justify-between select-none"
    >
      {/* 1. Top Header (Location on Left, Bell & User Avatar on Right) */}
      <header className="flex items-center justify-between py-1.5 mb-1">
        {/* Left Location */}
        <button
          id="btn-location-header"
          onClick={onOpenLocationSelect || onOpenMapDating}
          className="text-left group cursor-pointer"
        >
          <span className="text-[10px] text-ink font-medium block tracking-wider uppercase">
            LOCATION · 位置
          </span>
          <div className="flex items-center gap-1 mt-0.5">
            <MapPin className="w-3 h-3 text-ink shrink-0" />
            <span className="text-xs font-bold text-ink group-hover:text-ink transition truncate max-w-[170px]">
              {locationText}
            </span>
          </div>
        </button>

        {/* Right Moments (朋友圈) & User Icon */}
        <div className="flex items-center gap-2">
          {/* Moments (朋友圈) Button */}
          <button
            id="btn-moments-header"
            onClick={onOpenMoments || onOpenChat}
            className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted hover:border-border-strong transition active:scale-95 cursor-pointer relative shadow-xs group"
            aria-label="朋友圈"
            title="进入朋友圈"
          >
            <Camera className="w-3.5 h-3.5 text-ink group-hover:text-ink transition" />
            {momentsUnread > 0 && (
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-status-red rounded-full ring-1 ring-white" />
            )}
          </button>

          {/* Mailbox (邮箱) Button */}
          <button
            id="btn-user-avatar-header"
            onClick={onOpenMailbox || onOpenSettings || onOpenCharacterArchive}
            className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted hover:border-border-strong transition active:scale-95 cursor-pointer relative shadow-xs group"
            aria-label="信箱/邮箱"
            title="信箱"
          >
            <Mail className="w-3.5 h-3.5 text-ink group-hover:text-ink transition" />
            {emailsUnread > 0 && (
              <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-status-red rounded-full ring-1 ring-white" />
            )}
          </button>
        </div>
      </header>

      {/* 2. Hero Digital Clock & Date Display */}
      <section className="text-center my-2">
        <h1 className="text-[46px] font-semibold text-ink tracking-tight font-sans leading-none">
          {currentTime.time}
        </h1>
        <p className="text-xs text-ink font-medium tracking-wide mt-1.5">
          {currentTime.date}
        </p>
      </section>

      {/* 3. Main Companion Card / 空态引导 */}
      {allCharacters.length === 0 ? (
        <section className="relative">
          <div className="relative frosted-glass rounded-xl p-6 border border-border shadow-xs flex flex-col items-center justify-center text-center">
            <div className="text-3xl mb-2">🌆</div>
            <h2 className="text-sm font-semibold text-ink mb-1">还没有认识的人</h2>
            <p className="text-xs text-ink-soft mb-4">去地图转转，遇到的人可以搭话</p>
            <button
              onClick={onOpenMapDating}
              className="text-xs font-semibold text-solid-contrast bg-solid hover:bg-solid-soft rounded-lg px-4 py-2 cursor-pointer transition active:scale-95"
            >
              去地图转转 →
            </button>
          </div>
        </section>
      ) : (
      <section className="relative">
        <div
          id="main-companion-hero-card"
          className="relative frosted-glass rounded-xl p-4 border border-border shadow-xs"
        >
          <div className="flex items-center justify-between">
            {/* Left: Companion Avatar & Name */}
            <div className="flex-1 flex flex-col items-center justify-center">
              <div
                className="relative cursor-pointer group"
                onClick={onOpenChat}
                title="进入独处对话"
              >
                {/* Circular Avatar */}
                <div className="w-18 h-18 rounded-full bg-solid border-2 border-border-soft shadow-xs overflow-hidden flex items-center justify-center text-solid-contrast relative transition-transform group-hover:scale-105">
                  <img
                    src={activeCharacter.avatarUrl || getAnimeMaleAvatar(activeCharacter.name)}
                    alt={activeCharacter.name}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>
              </div>

              {/* Name below avatar */}
              <h2 className="mt-2 text-base font-bold text-ink tracking-tight">
                {activeCharacter.name}
              </h2>
            </div>

            {/* Middle Divider with Switch Arrow Button (⇄) */}
            <div className="flex flex-col items-center justify-center px-2 relative">
              <div className="w-[1px] h-8 border-l border-dashed border-border" />
              <button
                id="btn-switch-companion"
                onClick={() => setShowSwitchMenu(!showSwitchMenu)}
                disabled={isDating}
                className={`w-7 h-7 rounded-lg bg-bg-muted border border-border flex items-center justify-center text-ink transition my-1 ${
                  isDating
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:bg-bg-muted-2 cursor-pointer active:scale-95'
                }`}
                aria-label="切换主页角色"
                title={isDating ? '约会中，先结束约会再切换' : '切换固定在主页的角色'}
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
              </button>
              <div className="w-[1px] h-8 border-l border-dashed border-border" />
            </div>

            {/* Right: 当前行程 & 相伴时长 */}
            <div className="flex-1 pl-3 flex flex-col justify-center space-y-2.5 text-left">
              <div>
                <span className="text-[10px] text-ink block mb-0.5 font-normal tracking-wide">
                  当前行程
                </span>
                {activity.kind === 'idle' && idleSchedule ? (
                  <div className="text-xs font-semibold text-ink bg-bg-soft border border-border px-2 py-1 rounded-md">
                    <div className="flex items-center gap-1">
                      <span className="text-[11px]">📍</span>
                      <span>{idleSchedule.locationName}</span>
                    </div>
                    <div className="text-[11px] font-normal text-ink-soft">{idleSchedule.activity}</div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 w-fit text-xs font-semibold text-ink bg-bg-soft border border-border px-2 py-0.5 rounded-md">
                    <span className="text-[11px]">{activityMeta.icon}</span>
                    <span>{activityMeta.label}</span>
                    {(activity.kind === 'scene-date' || activity.kind === 'dating') && activity.characterName ? (
                      <span className="font-normal text-ink-soft">· {activity.characterName}</span>
                    ) : (activity.kind === 'mission' || activity.kind === 'scenario') && activity.title ? (
                      <span className="font-normal text-ink-soft">· {activity.title}</span>
                    ) : null}
                  </div>
                )}
                {activity.kind !== 'idle' && (
                  <button
                    onClick={onContinueActivity}
                    className="mt-1.5 text-[11px] font-semibold text-solid-contrast bg-solid hover:bg-solid-soft rounded-md px-2.5 py-1 cursor-pointer transition active:scale-95"
                  >
                    继续 →
                  </button>
                )}
              </div>

              <div>
                <span className="text-[10px] text-ink block mb-0.5 font-normal tracking-wide">
                  相伴时长
                </span>
                <div className="text-xs text-ink font-normal flex items-baseline gap-1">
                  {activeCharacter.daysTogether > 0 ? (
                    <>
                      <span>已相识</span>
                      <span className="text-base font-bold text-ink font-sans">
                        {activeCharacter.daysTogether}
                      </span>
                      <span>天</span>
                    </>
                  ) : (
                    <span>尚未成为好友</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Quick Switch Dropdown List */}
          {showSwitchMenu && !isDating && (
            <div className="mt-3 pt-3 border-t border-border-soft animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold text-ink">切换主页角色</span>
                <button
                  onClick={onOpenCharacterArchive}
                  className="text-[11px] text-ink hover:text-ink font-medium transition cursor-pointer"
                >
                  全部档案 →
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {allCharacters.map((char) => {
                  const initial = char.name?.slice(-1) || '伴';
                  const isCur = char.id === activeCharacter.id;
                  return (
                    <button
                      key={char.id}
                      onClick={() => {
                        onSelectCharacter(char);
                        setShowSwitchMenu(false);
                      }}
                      className={`flex flex-col items-center p-2 rounded-xl border transition cursor-pointer ${
                        isCur
                          ? 'bg-solid text-solid-contrast border-border-dark shadow-xs'
                          : 'bg-bg-soft border-border text-ink hover:bg-bg-muted'
                      }`}
                    >
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold overflow-hidden ${
                          isCur ? 'bg-solid-soft text-white' : 'bg-bg-muted-2 text-ink'
                        }`}
                      >
                        <img
                          src={char.avatarUrl || getAnimeMaleAvatar(char.name)}
                          alt={char.name}
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                      <span className="text-[10px] font-medium mt-1 truncate max-w-full">
                        {char.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>
      )}

      {/* 4. Bottom Three Feature Cards Grid matching character design */}
      <section className="grid grid-cols-2 gap-2.5 mt-[20px] mb-2">
        {/* Left Stacked Cards: 地图约会 & 互动小说（地图约会砍半，让一半给互动小说） */}
        <div className="flex flex-col gap-2.5 justify-between">
          {/* Top: 地图约会 */}
          <button
            id="btn-map-dating-card"
            onClick={onOpenMapDating}
            className="flex-1 rounded-xl frosted-glass p-3 border border-border shadow-xs flex items-center justify-between group cursor-pointer hover:border-border-strong transition-all active:scale-98"
          >
            {/* Left line icon */}
            <div className="w-10 h-10 rounded-xl bg-bg-muted border border-border flex items-center justify-center text-ink shrink-0 group-hover:scale-105 group-hover:text-ink transition-all shadow-2xs">
              <Map className="w-5 h-5 stroke-[1.6]" />
            </div>

            {/* Right Title */}
            <div className="text-right pr-1">
              <h3 className="text-xs font-bold text-ink group-hover:text-ink tracking-tight transition">
                地图约会
              </h3>
              <span className="text-[10px] text-ink font-normal">地图相识</span>
            </div>
          </button>

          {/* Bottom: 互动小说 */}
          <button
            id="btn-novel-card"
            onClick={onOpenNovel}
            className="flex-1 rounded-xl frosted-glass p-3 border border-border shadow-xs flex items-center justify-between group cursor-pointer hover:border-border-strong transition-all active:scale-98"
          >
            {/* Left line icon */}
            <div className="w-10 h-10 rounded-xl bg-bg-muted border border-border flex items-center justify-center text-ink shrink-0 group-hover:scale-105 group-hover:text-ink transition-all shadow-2xs">
              <BookOpen className="w-5 h-5 stroke-[1.6]" />
            </div>

            {/* Right Title */}
            <div className="text-right pr-1">
              <h3 className="text-xs font-bold text-ink group-hover:text-ink tracking-tight transition">
                互动小说
              </h3>
              <span className="text-[10px] text-ink font-normal">共同创作</span>
            </div>
          </button>
        </div>

        {/* Right Stacked Cards: 任务世界 & 场景剧本 */}
        <div className="flex flex-col gap-2.5 justify-between">
          {/* Top: 任务世界 */}
          <button
            id="btn-task-world-card"
            onClick={onOpenTasks}
            className="flex-1 rounded-xl frosted-glass p-3 border border-border shadow-xs flex items-center justify-between group cursor-pointer hover:border-border-strong transition-all active:scale-98"
          >
            {/* Left line icon */}
            <div className="w-10 h-10 rounded-xl bg-bg-muted border border-border flex items-center justify-center text-ink shrink-0 group-hover:scale-105 group-hover:text-ink transition-all shadow-2xs">
              <Compass className="w-5 h-5 stroke-[1.6]" />
            </div>

            {/* Right Title */}
            <div className="text-right pr-1">
              <h3 className="text-xs font-bold text-ink group-hover:text-ink tracking-tight transition">
                任务世界
              </h3>
              <span className="text-[10px] text-ink font-normal">待完成</span>
            </div>
          </button>

          {/* Bottom: 场景剧本 */}
          <button
            id="btn-scenario-script-card"
            onClick={onOpenScenarios}
            className="flex-1 rounded-xl frosted-glass p-3 border border-border shadow-xs flex items-center justify-between group cursor-pointer hover:border-border-strong transition-all active:scale-98"
          >
            {/* Left line icon */}
            <div className="w-10 h-10 rounded-xl bg-bg-muted border border-border flex items-center justify-center text-ink shrink-0 group-hover:scale-105 group-hover:text-ink transition-all shadow-2xs">
              <Clapperboard className="w-5 h-5 stroke-[1.6]" />
            </div>

            {/* Right Title */}
            <div className="text-right pr-1">
              <h3 className="text-xs font-bold text-ink group-hover:text-ink tracking-tight transition">
                场景剧本
              </h3>
              <span className="text-[10px] text-ink font-normal">互动演绎</span>
            </div>
          </button>
        </div>
      </section>

      {/* 5. Poetic Subtitle & Waiting Text */}
      <section className="text-center pt-2 pb-1">
        <p className="text-xs text-ink font-sans tracking-wide leading-relaxed">
          {poem || DEFAULT_POEMS[0]}
        </p>
        <p className="text-[10px] text-ink-soft text-right mt-0.5 pr-0.5">
          —— {activeCharacter.name}
        </p>
        <p className="text-[10px] text-ink mt-1 tracking-wider">
          正在静候你的言语...
        </p>
      </section>
    </div>
  );
};
