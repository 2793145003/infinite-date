import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Send, Sparkles, Copy, Undo2, Quote } from 'lucide-react';
import confetti from 'canvas-confetti';
import { getAnimeMaleAvatar } from '../data/animeAvatars';

export interface ScriptPlayMessage {
  id: string;
  type: 'narrative' | 'character' | 'player' | 'monologue';
  speaker?: string;
  speakerTitle?: string;
  avatarChar?: string;
  avatarUrl?: string;
  content: string;
  actionText?: string;
  innerVoice?: string;
  isMonologueExpanded?: boolean;
}

interface ScriptPlaySessionScreenProps {
  scriptTitle: string;
  scriptGoal?: string;
  assignedRoles: { [key: number]: string };
  onBack: () => void;
  onEnd: () => void;
}

export const ScriptPlaySessionScreen: React.FC<ScriptPlaySessionScreenProps> = ({
  scriptTitle = '凌珑餐厅',
  scriptGoal = '在层层叠叠的谎言与精心设计的剧本中...',
  assignedRoles,
  onBack,
  onEnd,
}) => {
  const role1Name = assignedRoles[0] || '苏烬';
  const role2Name = assignedRoles[1] || '沈星回';
  const companionDisplayName = `${role1Name}`;

  const [inputVal, setInputVal] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [isReplying, setIsReplying] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 1800);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard?.writeText?.(text);
    showToast('已复制');
  };

  const handleQuote = (text: string) => {
    setInputVal(`「${text.length > 15 ? text.slice(0, 15) + '...' : text}」 `);
    showToast('已引用到输入框');
  };

  // Initial messages matching the exact screenshot layout and content
  const [messages, setMessages] = useState<ScriptPlayMessage[]>([
    {
      id: 'msg-1',
      type: 'narrative',
      content:
        '午间炽热的阳光穿透凌珑餐厅的大幅落地窗，被精致的水晶吊灯折射成细碎而跳跃的光斑，洒在洁白的餐布上。空气中浮动着独有的高级香料与新鲜花卉交织的微甜气味，远处餐具轻碰瓷器的清脆声响，在舒缓的爵士乐缝隙里显得格外清晰。身为影视总监 / 新锐导演的阿烬 / 苏导早已在临窗最好的位置静候，举手投足从容矜贵。（温和从容、冷静果断，对外界保持适度礼貌与克制疏离。）',
    },
    {
      id: 'msg-2',
      type: 'character',
      speaker: '阿烬 / 苏导',
      speakerTitle: '影视总监 / 新锐导演',
      avatarChar: role1Name.slice(-1) || '烬',
      content:
        '姐姐～\n（他坐在临窗的位子上，察觉到你的身影后，原本正漫不经心转动着手里银质餐匙的手停了下来，抬起头看向你，深邃沉静的眸子里瞬间漾开了盈盈的笑意）',
    },
    {
      id: 'msg-3',
      type: 'monologue',
      content:
        '终于见到她了……刚才盯着门口看的时候，心跳快得简直要失控。好想立刻扑过去抱住她，把所有的委屈和那些只有在见到她时才能有的渴望都揉进她的怀里。不过现在要忍住，得表现得乖一点，让她觉得和我在一起是很轻松、很愉快的。哪怕只是看着她坐下来，我这颗悬了很久的心，也终于落地了。',
      isMonologueExpanded: true,
    },
    {
      id: 'msg-4',
      type: 'character',
      speaker: '阿烬 / 苏导',
      speakerTitle: '影视总监 / 新锐导演',
      avatarChar: role1Name.slice(-1) || '烬',
      content:
        '总算等到你了，在凌珑餐厅这里，所有的细节我都按照你的喜好提前准备好了～',
    },
  ]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const toggleMonologue = (id: string) => {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === id ? { ...msg, isMonologueExpanded: !msg.isMonologueExpanded } : msg
      )
    );
  };

  const handleContinueNarrative = () => {
    const nextNarrativeId = `nar-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: nextNarrativeId,
        type: 'narrative',
        content:
          '微风吹拂着轻柔的白色纱帘，侍者悄无声息地为你们奉上特调的水果冰饮。空气中流淌着温软的暧昧与期待，周围的低声细语仿佛都在这一刻退为背景。',
      },
    ]);
    showToast('已推进环境剧情');
  };

  const handleSendMessage = () => {
    if (!inputVal.trim()) return;

    const userText = inputVal.trim();
    setInputVal('');

    const newMsgId = `player-${Date.now()}`;
    const userMsg: ScriptPlayMessage = {
      id: newMsgId,
      type: 'player',
      content: userText,
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsReplying(true);

    // Simulated NPC response matching map dating tone
    setTimeout(() => {
      setIsReplying(false);
      const respId = `char-${Date.now()}`;

      const replies = [
        {
          text: `“既然来了，今天的所有时间就都是我的了。”（他眼神温柔而专注地凝视着你，唇角含笑递上一杯温度刚好的柠檬水）`,
          inner: `只要能像这样看着她，哪怕坐上一整天我也不会觉得厌烦。`,
        },
        {
          text: `“你刚才走过来的样子，真的很好看。”（他指尖轻轻碰了碰杯沿，目光始终停留在你身上）`,
          inner: `真想把她藏起来，不让任何其他人看见。`,
        },
      ];

      const chosen = replies[Math.floor(Math.random() * replies.length)];

      setMessages((prev) => [
        ...prev,
        {
          id: respId,
          type: 'character',
          speaker: '阿烬 / 苏导',
          speakerTitle: '影视总监 / 新锐导演',
          avatarChar: role1Name.slice(-1) || '烬',
          content: chosen.text,
        },
        {
          id: `mono-${Date.now()}`,
          type: 'monologue',
          content: chosen.inner,
          isMonologueExpanded: true,
        },
      ]);
    }, 1100);
  };

  const handleWithdrawMessage = (id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    showToast('已撤回消息');
  };

  return (
    <div
      id="script-play-session-screen"
      className="w-full max-w-[412px] mx-auto min-h-full text-ink flex flex-col justify-between relative select-none font-sans"
      style={{
        backgroundImage: `radial-gradient(circle at 50% 30%, rgba(255, 255, 255, 0.95), rgba(244, 245, 248, 0.9)), url('https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=800&q=80')`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      {/* 1. Header (← 返回  凌珑餐厅  结束) */}
      <header className="px-4 py-3 bg-bg-soft backdrop-blur-md flex items-center justify-between sticky top-0 z-30 border-b border-border-dark/[0.05]">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[15px] font-bold text-ink hover:opacity-75 transition cursor-pointer"
        >
          <ArrowLeft className="w-4.5 h-4.5 stroke-[2.2]" />
          <span>返回</span>
        </button>

        <h1 className="text-[15px] font-bold text-ink text-center tracking-tight truncate max-w-[180px]">
          {scriptTitle || '凌珑餐厅'}
        </h1>

        <button
          onClick={onEnd}
          className="px-4 py-1 rounded-full bg-solid text-solid-contrast text-xs font-bold hover:bg-solid-soft transition active:scale-95 cursor-pointer shadow-xs"
        >
          结束
        </button>
      </header>

      {/* 2. Companion Sub-header Bar (❤️ 与他【苏烬】同行 心动约会中) */}
      <div className="bg-bg-soft backdrop-blur-md px-4 py-2 border-b border-border flex items-center gap-1.5 text-xs text-ink font-medium">
        <span className="text-rose text-sm">❤️</span>
        <span>与他【{companionDisplayName}】同行</span>
        <span className="text-rose font-medium ml-0.5">心动约会中</span>
      </div>

      {/* 3. Messages Stream Area */}
      <main className="flex-1 px-4 py-4 space-y-4 overflow-y-auto no-scrollbar pb-24">
        {messages.map((item) => {
          // --- 1. Environment / Scene Narrative Box ---
          if (item.type === 'narrative') {
            return (
              <div
                key={item.id}
                className="relative bg-bg-soft rounded-2xl p-4 border border-border text-[13.5px] leading-relaxed text-ink-soft shadow-xs text-justify font-sans"
              >
                <div className="absolute left-0 top-3 bottom-3 w-1 bg-black/10 rounded-full" />
                <p className="tracking-wide">{item.content}</p>

                {/* Narrative Action Pills: 复制 / 引用 / 继续 */}
                <div className="flex items-center gap-1.5 mt-3 pt-1">
                  <button
                    onClick={() => copyToClipboard(item.content)}
                    className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                  >
                    复制
                  </button>
                  <button
                    onClick={() => handleQuote(item.content)}
                    className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                  >
                    引用
                  </button>
                  <button
                    onClick={handleContinueNarrative}
                    className="px-3.5 py-0.5 rounded-full bg-solid text-solid-contrast text-[11px] font-semibold transition hover:bg-solid-soft active:scale-95 cursor-pointer shadow-2xs"
                  >
                    继续
                  </button>
                </div>
              </div>
            );
          }

          // --- 2. Inner Monologue / 心声 Card (Soft delicate pink tint) ---
          if (item.type === 'monologue') {
            return (
              <div
                key={item.id}
                className="bg-chat-pink-bg/90 backdrop-blur-md border border-chat-pink-border/40 rounded-2xl p-4 text-[13px] leading-relaxed text-ember flex flex-col gap-2 shadow-xs"
              >
                <button
                  onClick={() => toggleMonologue(item.id)}
                  className="self-start px-2 py-0.5 rounded-lg bg-chat-pink-border/20 text-rose text-[11px] font-bold flex items-center gap-1 cursor-pointer transition active:scale-95"
                >
                  <span>⚡ {item.isMonologueExpanded ? '收起心声' : '展开心声'}</span>
                </button>

                {item.isMonologueExpanded && (
                  <p className="tracking-wide text-justify text-rose animate-in fade-in duration-200">
                    {item.content}
                  </p>
                )}
              </div>
            );
          }

          // --- 3. Companion / NPC Chat Bubble ---
          if (item.type === 'character') {
            const avatarSrc = item.avatarUrl || getAnimeMaleAvatar(item.speaker || role1Name);

            return (
              <div key={item.id} className="flex flex-col items-start gap-1.5">
                {/* Sender Title Header */}
                <div className="flex items-center gap-1.5 pl-0.5">
                  <div className="w-6 h-6 rounded-full overflow-hidden border border-border-dark/5 flex items-center justify-center text-[11px] font-bold shadow-2xs">
                    <img
                      src={avatarSrc}
                      alt={item.speaker || role1Name}
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  <span className="text-xs font-bold text-ink/90">
                    {item.speaker || `${role1Name} / 苏导`}
                    {item.speakerTitle ? ` · ${item.speakerTitle}` : ''}
                  </span>
                </div>

                {/* Bubble Content */}
                <div className="max-w-[92%] bg-bg-muted backdrop-blur-md rounded-2xl px-4 py-3 border border-border text-[13.5px] text-ink leading-relaxed shadow-xs whitespace-pre-wrap text-justify">
                  <span>{item.content}</span>
                  {item.actionText && (
                    <span className="text-ink block mt-1 italic">
                      {item.actionText}
                    </span>
                  )}
                </div>

                {/* Bubble Actions: 复制 / 引用 */}
                <div className="flex items-center gap-1.5 pl-1">
                  <button
                    onClick={() => copyToClipboard(`${item.content} ${item.actionText || ''}`)}
                    className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                  >
                    复制
                  </button>
                  <button
                    onClick={() => handleQuote(item.content)}
                    className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                  >
                    引用
                  </button>
                </div>
              </div>
            );
          }

          // --- 4. Player Message Bubble ---
          if (item.type === 'player') {
            return (
              <div key={item.id} className="self-end flex flex-col items-end gap-1 max-w-[82%]">
                <div className="bg-solid text-solid-contrast px-4 py-2.5 rounded-2xl text-[13.5px] font-medium shadow-sm leading-relaxed">
                  {item.content}
                </div>

                <div className="flex gap-1.5 pr-0.5">
                  <button
                    onClick={() => copyToClipboard(item.content)}
                    className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                  >
                    复制
                  </button>
                  <button
                    onClick={() => handleQuote(item.content)}
                    className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-black/10 text-[11px] text-ink transition cursor-pointer"
                  >
                    引用
                  </button>
                  <button
                    onClick={() => handleWithdrawMessage(item.id)}
                    className="px-2.5 py-0.5 rounded-full bg-black/5 hover:bg-rose hover:text-ink-on text-[11px] text-ink transition cursor-pointer"
                  >
                    撤回
                  </button>
                </div>
              </div>
            );
          }

          return null;
        })}

        {isReplying && (
          <div className="flex items-center gap-1.5 text-xs text-ink pl-1 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-solid-muted-2 animate-bounce" />
            <span className="w-1.5 h-1.5 rounded-full bg-solid-muted-2 animate-bounce [animation-delay:-0.15s]" />
            <span className="w-1.5 h-1.5 rounded-full bg-solid-muted-2 animate-bounce [animation-delay:-0.3s]" />
            <span>{companionDisplayName} 正在回应...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* 4. Bottom Floating Input Bar (Matching Map Dating Chat Exactly) */}
      <footer className="fixed bottom-[76px] left-1/2 -translate-x-1/2 w-full max-w-[412px] px-3.5 py-2.5 bg-bg-soft backdrop-blur-md border-t border-border z-40 flex items-center gap-2">
        {/* Left Action Command Icon: () */}
        <button
          onClick={() => showToast('已调出专属动作指令')}
          className="w-9 h-9 rounded-full bg-black/[0.04] border border-border-dark/5 flex items-center justify-center text-sm font-semibold text-ink hover:bg-black/[0.08] transition cursor-pointer shrink-0"
        >
          ()
        </button>

        {/* Middle Input Field: placeholder="你想做什么？" */}
        <div className="flex-1 relative">
          <input
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSendMessage();
            }}
            placeholder="你想做什么？"
            className="w-full bg-bg-input text-ink placeholder-ink-soft text-[13.5px] rounded-full px-4 py-2 outline-none border border-transparent focus:border-border-dark/10 transition"
          />
        </div>

        {/* Right Send Button */}
        <button
          onClick={handleSendMessage}
          disabled={!inputVal.trim()}
          className={`w-9 h-9 rounded-full flex items-center justify-center transition cursor-pointer shrink-0 shadow-xs active:scale-95 ${
            inputVal.trim()
              ? 'bg-solid text-solid-contrast'
              : 'bg-solid-soft text-solid-contrast'
          }`}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </footer>

      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-solid/90 text-solid-contrast text-xs px-4 py-2 rounded-full shadow-lg backdrop-blur-xs animate-in fade-in duration-150">
          {toastMsg}
        </div>
      )}
    </div>
  );
};
