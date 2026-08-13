/**
 * 摸鱼模式 — 伪装成AI助手的聊天界面
 * 接vLLM真实对话，老板路过看不出破绽
 */
import { useState, useRef, useEffect, useCallback } from 'react';

interface FishMessage {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  '帮我写一封请假邮件',
  '解释一下什么是闭包',
  '总结一下今天的待办事项',
  '翻译：The quick brown fox',
];

export function FishMode() {
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

  useEffect(() => { scrollToBottom(); }, [messages, loading, scrollToBottom]);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: FishMessage = { role: 'user', content: trimmed };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/fish/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(localStorage.getItem('idate_token')
            ? { Authorization: `Bearer ${localStorage.getItem('idate_token')}` }
            : {}),
        },
        body: JSON.stringify({ messages: newMessages }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');

      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '未知错误';
      setMessages(prev => [...prev, { role: 'assistant', content: `（出错了：${errMsg}）` }]);
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
    <div className="fish-mode">
      {/* 伪装头部 — AI助手标识 */}
      <div className="fish-header">
        <div className="fish-logo">
          <span className="fish-logo-text">AI 助手</span>
        </div>
        <div className="fish-status">
          <span className="fish-status-dot" />
          <span>在线</span>
        </div>
      </div>

      {/* 聊天区域 */}
      <div className="fish-chat" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="fish-welcome">
            <div className="fish-welcome-title">AI 助手</div>
            <div className="fish-welcome-desc">有什么可以帮你的？</div>
            <div className="fish-suggestions">
              {SUGGESTIONS.map(s => (
                <button key={s} className="fish-suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`fish-msg fish-msg-${msg.role}`}>
            <div className="fish-msg-bubble">{msg.content}</div>
            {msg.role === 'user' && <div className="fish-msg-avatar fish-msg-avatar-user">我</div>}
          </div>
        ))}

        {loading && (
          <div className="fish-msg fish-msg-assistant">
            <div className="fish-msg-bubble fish-typing">
              <span /><span /><span />
            </div>
          </div>
        )}
      </div>

      {/* 输入区域 */}
      <div className="fish-input-area">
        <textarea
          ref={inputRef}
          className="fish-input"
          placeholder="输入问题…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={loading}
        />
        <button
          className="fish-send"
          onClick={() => send(input)}
          disabled={!input.trim() || loading}
        >
          发送
        </button>
      </div>
    </div>
  );
}
