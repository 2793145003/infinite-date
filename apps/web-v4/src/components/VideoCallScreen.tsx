import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronLeft,
  Mic,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
  Send,
  Sparkles,
  Heart,
  Smile,
  RefreshCw,
  Camera,
  Wifi,
  Battery,
} from 'lucide-react';
import { Character, ChatMessage, UserProfile } from '../types';

interface VideoCallMessage {
  id: string;
  sender: 'user' | 'character';
  text: string;
  isAction?: boolean;
}

interface VideoCallScreenProps {
  character: Character;
  userProfile?: UserProfile;
  onEndCall: (durationSeconds: number, dialogueSummary?: string) => void;
  onBack: () => void;
}

export const VideoCallScreen: React.FC<VideoCallScreenProps> = ({
  character,
  userProfile,
  onEndCall,
  onBack,
}) => {
  // Call status: 'connecting' | 'connected'
  const [callState, setCallState] = useState<'connecting' | 'connected'>('connecting');
  const [callDuration, setCallDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isCameraFront, setIsCameraFront] = useState(true);
  const [inputText, setInputText] = useState('');
  const [isReplying, setIsReplying] = useState(false);

  // Background image URL resolution
  const defaultMangaWallpaper = '/src/assets/images/videocall_manga_bf_1787142834862.jpg';
  const defaultUserPip = '/src/assets/images/videocall_user_pip_1787142853189.jpg';

  const wallpaperUrl =
    userProfile?.videoCallBackgroundUrl ||
    character.avatarUrl ||
    defaultMangaWallpaper;

  const userAvatarUrl =
    userProfile?.avatarUrl ||
    defaultUserPip;

  // Real-time video call subtitles / dialogues
  const [dialogueStream, setDialogueStream] = useState<VideoCallMessage[]>([
    {
      id: 'vm-1',
      sender: 'user',
      text: '我跟你说这个很好吃的。',
    },
    {
      id: 'vm-2',
      sender: 'character',
      text: '奥利奥啊，经典。',
    },
    {
      id: 'vm-3',
      sender: 'character',
      text: '不过你举这么高挡住半张脸，是想让我看饼干还是看你啊？',
    },
    {
      id: 'vm-4',
      sender: 'user',
      text: '（眼睛微微眯起来，嘴角忍不住往上勾）',
      isAction: true,
    },
    {
      id: 'vm-5',
      sender: 'character',
      text: '两个都好看，行了吧。',
    },
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<any>(null);

  // Auto connect after 2.2 seconds
  useEffect(() => {
    if (callState === 'connecting') {
      const timer = setTimeout(() => {
        setCallState('connected');
      }, 2200);
      return () => clearTimeout(timer);
    }
  }, [callState]);

  // Duration counter when connected
  useEffect(() => {
    if (callState === 'connected') {
      timerRef.current = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [callState]);

  // Auto scroll subtitles
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [dialogueStream, isReplying]);

  // Format seconds to mm:ss
  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const handleSendMessage = (textToSend?: string) => {
    const content = textToSend || inputText;
    if (!content.trim() || isReplying) return;

    const userMsg: VideoCallMessage = {
      id: `vm-${Date.now()}`,
      sender: 'user',
      text: content.trim(),
      isAction: content.trim().startsWith('（') || content.trim().startsWith('('),
    };

    setDialogueStream((prev) => [...prev, userMsg]);
    setInputText('');
    setIsReplying(true);

    // Simulate AI character realtime video response
    setTimeout(() => {
      const charResponses = [
        `“镜头别晃，让我再多看你几秒。”`,
        `“嗯，听着呢。刚才那个表情特别可爱。”`,
        `（隔着屏幕伸手轻点了一下镜头，眼神带着几分宠溺的笑意）`,
        `“要是现在能直接到你身边就好了。”`,
        `“你刚才说的我记住了，待会儿视频挂了我也去买同款。”`,
        `“这么专注地看着我，是不是今天格外想我？”`,
      ];
      const randomResponse =
        charResponses[Math.floor(Math.random() * charResponses.length)];

      const aiMsg: VideoCallMessage = {
        id: `vm-ai-${Date.now()}`,
        sender: 'character',
        text: randomResponse,
        isAction: randomResponse.startsWith('（') || randomResponse.startsWith('('),
      };

      setDialogueStream((prev) => [...prev, aiMsg]);
      setIsReplying(false);
    }, 1200);
  };

  const handleHangUp = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    const summary = dialogueStream.slice(-3).map((d) => d.text).join(' ');
    onEndCall(callDuration, summary);
  };

  const quickVideoChips = [
    '我跟你说这个很好吃的。',
    '（把脸凑近屏幕眨眨眼）',
    '今天过得怎么样？',
    '好想你呀',
    '（端起奶茶向你展示）',
  ];

  return (
    <div className="w-full max-w-md mx-auto h-full relative flex flex-col justify-between overflow-hidden bg-black text-white select-none">
      {/* =========================================================
          STATE 1: 呼叫连接中 (Connecting View matching image left)
          ========================================================= */}
      {callState === 'connecting' && (
        <div className="w-full min-h-full flex flex-col justify-between p-6 bg-gradient-to-b from-call-bg-from via-call-bg-via to-call-bg-to relative">
          {/* Top Bar */}
          <div className="flex items-center justify-between pt-2">
            <button
              id="btn-videocall-cancel-top"
              onClick={onBack}
              className="w-9 h-9 rounded-full bg-bg-soft/10 backdrop-blur-md flex items-center justify-center text-white/90 hover:bg-bg-soft/20 transition cursor-pointer"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <span className="text-sm font-medium text-white/90 tracking-wide">
              视频通话
            </span>
            <div className="flex items-center gap-1.5 text-white/60 text-xs">
              <Wifi className="w-3.5 h-3.5" />
              <Battery className="w-4 h-4" />
            </div>
          </div>

          {/* Center Avatar & Status */}
          <div className="flex flex-col items-center justify-center my-auto -mt-6">
            {/* Glowing Avatar Frame */}
            <div className="relative mb-5">
              <div className="w-32 h-32 rounded-full overflow-hidden border-2 border-border-soft shadow-2xl relative z-10 bg-solid-soft">
                <img
                  src={character.avatarUrl || defaultMangaWallpaper}
                  alt={character.name}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
              {/* Outer pulsing ring */}
              <div className="absolute inset-0 rounded-full bg-bg-soft/10 scale-125 animate-ping opacity-40 -z-0" />
              <div className="absolute inset-0 rounded-full bg-bg-soft/5 scale-140 animate-pulse -z-0" />
            </div>

            {/* Character Nickname / Name */}
            <h2 className="text-xl font-bold text-white tracking-tight mb-2">
              {character.nickname || character.name}
            </h2>

            {/* Calling Status Badge */}
            <div className="px-4 py-1.5 rounded-full bg-bg-soft/10 backdrop-blur-md border border-border-strong/15 text-xs text-white/80 flex items-center gap-2 animate-pulse">
              <span>等待对方接受邀请...</span>
            </div>

            {/* Instant Connect Shortcut (For UX testing) */}
            <button
              onClick={() => setCallState('connected')}
              className="mt-6 px-3 py-1 rounded-full bg-bg-soft/15 hover:bg-bg-soft/25 text-[11px] text-white/70 transition cursor-pointer"
            >
              点击直接接通 →
            </button>
          </div>

          {/* Bottom Control Bar */}
          <div className="flex items-center justify-around pb-8 pt-4">
            {/* Mic Toggle */}
            <button
              id="btn-call-mute-connecting"
              onClick={() => setIsMuted(!isMuted)}
              className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition active:scale-95 cursor-pointer ${
                isMuted ? 'bg-solid-muted text-white' : 'bg-bg-soft text-ink'
              }`}
            >
              {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </button>

            {/* Hangup Red Button */}
            <button
              id="btn-call-hangup-connecting"
              onClick={handleHangUp}
              className="w-16 h-16 rounded-full bg-rose hover:bg-rose text-ink-on flex items-center justify-center shadow-xl shadow-rose-950/40 transition active:scale-95 cursor-pointer"
            >
              <PhoneOff className="w-7 h-7" />
            </button>

            {/* Camera Switch */}
            <button
              id="btn-call-video-connecting"
              onClick={() => setIsVideoEnabled(!isVideoEnabled)}
              className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition active:scale-95 cursor-pointer ${
                !isVideoEnabled ? 'bg-solid-muted text-white' : 'bg-bg-soft text-ink'
              }`}
            >
              {isVideoEnabled ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
            </button>
          </div>
        </div>
      )}

      {/* =========================================================
          STATE 2: 通话进行中 (Connected View matching image right)
          ========================================================= */}
      {callState === 'connected' && (
        <div className="w-full min-h-full relative flex flex-col justify-between">
          {/* 1. Full Screen Wallpaper Background */}
          <div className="absolute inset-0 z-0">
            <img
              src={wallpaperUrl}
              alt="Video Call Background"
              className="w-full h-full object-cover object-top"
              referrerPolicy="no-referrer"
            />
            {/* Gradients for readability */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/90 pointer-events-none" />
            <div className="absolute inset-0 bg-black/20 pointer-events-none" />
          </div>

          {/* 2. Top Header & Title */}
          <div className="relative z-10 p-4 pt-3 flex items-start justify-between">
            {/* Left Return / Minimize */}
            <button
              id="btn-videocall-back-connected"
              onClick={onBack}
              className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center text-white/90 hover:bg-black/60 transition cursor-pointer mt-1"
              title="返回聊天"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            {/* Center Call Info */}
            <div className="flex flex-col items-center text-center">
              <span className="text-[11px] text-white/60 tracking-wider font-light">
                视频通话
              </span>
              <h2 className="text-base font-bold text-white tracking-tight mt-0.5 shadow-xs">
                {character.nickname || character.name}
              </h2>
              <span className="text-[10px] text-white/80 font-light mt-0.5">
                正在与对方通话中...
              </span>
              {/* Duration Timer Pill */}
              <div className="mt-1.5 px-3 py-0.5 rounded-full bg-black/50 backdrop-blur-md border border-border-strong/20 text-[11px] font-mono font-medium text-white/90 shadow-sm">
                {formatTimer(callDuration)}
              </div>
            </div>

            {/* Right Status Indicator */}
            <div className="flex items-center gap-1 text-white/60 text-xs mt-1">
              <Wifi className="w-3.5 h-3.5" />
              <Battery className="w-4 h-4" />
            </div>
          </div>

          {/* 3. Top-Right Floating User PIP Window */}
          <div className="absolute top-14 right-3.5 z-20 w-22 h-30 sm:w-24 sm:h-32 rounded-2xl overflow-hidden border-2 border-border-soft shadow-2xl bg-solid group cursor-pointer active:scale-98 transition">
            <img
              src={userAvatarUrl}
              alt="User Camera View"
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
            {/* Dark gradient in PIP */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />
            {/* User Badge "我" in bottom right corner matching reference image */}
            <div className="absolute bottom-1.5 right-1.5 w-5 h-5 rounded-full bg-black/80 backdrop-blur-xs border border-border-soft flex items-center justify-center text-[9px] font-bold text-white shadow-xs">
              我
            </div>
          </div>

          {/* 4. Subtitle / Dialogue Live Bubble Stream */}
          <div className="relative z-10 flex-1 flex flex-col justify-end px-3.5 pb-2 min-h-0">
            <div className="space-y-2 overflow-y-auto no-scrollbar max-h-60 pr-0.5 pt-3 [mask-image:linear-gradient(to_bottom,transparent_0%,black_14px,black_100%)]">
              {dialogueStream.map((item) => {
                const isUser = item.sender === 'user';
                return (
                  <div
                    key={item.id}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-150 shrink-0`}
                  >
                    <div
                      className={`max-w-[84%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed backdrop-blur-md shadow-md border ${
                        isUser
                          ? item.isAction
                            ? 'bg-black/60 text-ink italic border-border-strong/10 rounded-br-xs text-[11px]'
                            : 'bg-black/75 text-ink-contrast border-border-strong/20 rounded-br-xs'
                          : item.isAction
                          ? 'bg-solid/80 text-ink italic border-border-strong/15 rounded-bl-xs text-[11px]'
                          : 'bg-solid/90 text-solid-contrast border-border-strong/20 rounded-bl-xs font-normal'
                      }`}
                    >
                      {item.text}
                    </div>
                  </div>
                );
              })}

              {isReplying && (
                <div className="flex justify-start animate-in fade-in shrink-0">
                  <div className="px-3.5 py-1.5 rounded-2xl rounded-bl-xs bg-solid/80 backdrop-blur-md text-[11px] text-solid-contrast/70 border border-border-strong/15 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 bg-bg-soft rounded-full animate-bounce" />
                    <span className="w-1.5 h-1.5 bg-bg-soft rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-1.5 h-1.5 bg-bg-soft rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="text-[10px] ml-1">{character.name} 正在回应...</span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Quick Dialogue Suggestion Chips */}
            <div className="flex gap-1.5 overflow-x-auto no-scrollbar py-1 mt-2">
              {quickVideoChips.map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSendMessage(chip)}
                  disabled={isReplying}
                  className="px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-border-strong/20 text-[10.5px] text-white/80 whitespace-nowrap hover:bg-bg-soft/20 transition shrink-0 cursor-pointer shadow-xs active:scale-95"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>

          {/* 5. Real-time Input Field */}
          <div className="relative z-10 px-3.5 pb-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="relative flex items-center"
            >
              <input
                id="input-videocall-message"
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="发送实时消息..."
                className="w-full bg-black/60 backdrop-blur-md border border-border-strong/20 rounded-full pl-4 pr-10 py-2.5 text-xs text-white placeholder-white/50 outline-none focus:border-border-soft shadow-lg"
              />
              <button
                type="submit"
                disabled={!inputText.trim() || isReplying}
                className="absolute right-1.5 w-8 h-8 rounded-full bg-bg-soft/20 hover:bg-bg-soft/40 disabled:opacity-30 text-white flex items-center justify-center transition cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>

          {/* 6. Bottom Action Controls Bar matching screenshot */}
          <div className="relative z-10 flex items-center justify-around px-6 pb-6 pt-1">
            {/* Mic Toggle */}
            <button
              id="btn-call-mute-active"
              onClick={() => setIsMuted(!isMuted)}
              className={`w-13 h-13 rounded-full flex items-center justify-center shadow-xl transition active:scale-95 cursor-pointer backdrop-blur-md ${
                isMuted
                  ? 'bg-solid-soft text-white/70 border border-border-strong/20'
                  : 'bg-bg-soft text-ink hover:bg-bg-muted'
              }`}
              title={isMuted ? '解除静音' : '静音'}
            >
              {isMuted ? <MicOff className="w-5.5 h-5.5" /> : <Mic className="w-5.5 h-5.5" />}
            </button>

            {/* Hangup Red Button */}
            <button
              id="btn-call-hangup-active"
              onClick={handleHangUp}
              className="w-15 h-15 rounded-full bg-rose hover:bg-rose text-ink-on flex items-center justify-center shadow-2xl shadow-rose-950/60 transition active:scale-95 cursor-pointer"
              title="挂断通话"
            >
              <PhoneOff className="w-6.5 h-6.5" />
            </button>

            {/* Camera Switch / Toggle */}
            <button
              id="btn-call-video-active"
              onClick={() => setIsVideoEnabled(!isVideoEnabled)}
              className={`w-13 h-13 rounded-full flex items-center justify-center shadow-xl transition active:scale-95 cursor-pointer backdrop-blur-md ${
                !isVideoEnabled
                  ? 'bg-solid-soft text-white/70 border border-border-strong/20'
                  : 'bg-bg-soft text-ink hover:bg-bg-muted'
              }`}
              title={isVideoEnabled ? '关闭摄像头' : '开启摄像头'}
            >
              {isVideoEnabled ? <Video className="w-5.5 h-5.5" /> : <VideoOff className="w-5.5 h-5.5" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
