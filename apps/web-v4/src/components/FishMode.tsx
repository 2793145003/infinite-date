/**
 * 摸鱼模式 — 伪装成 AI 助手的聊天界面
 * 接 v2 后端真实对话，老板路过看不出破绽
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, X, Bot } from 'lucide-react';

interface FishMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  { icon: '✉️', text: '帮我写一封请假邮件' },
  { icon: '💻', text: '解释一下什么是闭包' },
  { icon: '📋', text: '总结一下今天的待办事项' },
  { icon: '🌐', text: '翻译：The quick brown fox' },
];

export const FishMode: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  const [messages, setMessages] = useState<FishMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: FishMessage = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const token = localStorage.getItem('idate_token');
      const res = await fetch('/v4/api/fish/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ messages: newMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');

      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '未知错误';
      setMessages((prev) => [...prev, { role: 'assistant', content: `（出错了：${errMsg}）` }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-[var(--ink-2)]">
      {/* 伪装头部 — AI 助手标识 */}
      <header className="px-4 py-3 flex items-center justify-between shrink-0 bg-panel border-b border-bg-muted-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-cyan flex items-center justify-center">
            <Bot className="w-4 h-4 text-ink-on" />
          </div>
          <span className="text-[14px] font-bold text-ink">AI 助手</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 text-ink-muted">
            <span className="w-2 h-2 rounded-full bg-status-green" />
            <span className="text-[11px]">在线</span>
          </div>
          <button
            onClick={onExit}
            className="w-6 h-6 rounded-full flex items-center justify-center text-ink-faint hover:text-ink hover:bg-bg-muted transition cursor-pointer"
            aria-label="退出摸鱼模式"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* 聊天区域 */}
      <div className="flex-1 overflow-y-auto px-4 py-4" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center">
            <div className="text-[20px] font-bold text-ink">AI 助手</div>
            <div className="text-[13px] text-ink-muted mt-1 mb-6">有什么可以帮你的？</div>
            <div className="flex flex-col gap-2 w-full max-w-[280px]">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.text}
                  onClick={() => send(s.text)}
                  className="px-4 py-3 rounded-xl bg-panel border border-bg-muted-2 text-[13px] text-ink hover:bg-bg-muted transition cursor-pointer text-left flex items-center gap-2.5"
                >
                  <span className="text-[16px] leading-none shrink-0">{s.icon}</span>
                  <span>{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} mb-3`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-lg bg-cyan flex items-center justify-center shrink-0 mr-2">
                <Bot className="w-3.5 h-3.5 text-ink-on" />
              </div>
            )}
            <div
              className={`max-w-[75%] px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                msg.role === 'user'
                  ? 'bg-cyan text-ink-on rounded-2xl rounded-tr-sm'
                  : 'bg-panel text-ink rounded-2xl rounded-tl-sm border border-bg-muted-2'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start mb-3">
            <div className="w-7 h-7 rounded-lg bg-cyan flex items-center justify-center shrink-0 mr-2">
              <Bot className="w-3.5 h-3.5 text-ink-on" />
            </div>
            <div className="px-4 py-2.5 bg-bg-soft rounded-2xl rounded-tl-sm border border-bg-muted-2 flex items-center gap-1">
              <span className="fish-typing-dot" />
              <span className="fish-typing-dot" />
              <span className="fish-typing-dot" />
            </div>
          </div>
        )}
      </div>

      {/* 输入区域 */}
      <footer className="px-3 pt-2.5 pb-3 flex items-end gap-2 shrink-0 bg-panel border-t border-bg-muted-2">
        <textarea
          ref={inputRef}
          className="flex-1 resize-none rounded-xl bg-bg-soft border border-bg-muted-2 px-3.5 py-2.5 text-[13px] text-ink placeholder:text-ink-muted outline-none focus:border-cyan transition max-h-[120px]"
          placeholder="输入问题…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={loading}
        />
        <button
          className={`h-10 px-4 rounded-xl flex items-center justify-center gap-1.5 text-[13px] font-medium transition active:scale-95 shrink-0 cursor-pointer ${
            input.trim() && !loading
              ? 'bg-cyan text-ink-on hover:opacity-90'
              : 'bg-bg-muted text-ink-muted cursor-not-allowed'
          }`}
          onClick={() => send(input)}
          disabled={!input.trim() || loading}
        >
          <Send className="w-3.5 h-3.5" />
          发送
        </button>
      </footer>
    </div>
  );
};
