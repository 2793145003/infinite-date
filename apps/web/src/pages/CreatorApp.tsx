import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import type { TextMessage } from '../lib/api';
import { CreationCardPanel } from '../components/CreationCardPanel';

// 聊天式创建角色（v3）：独立页面，通过对话生成角色卡，可编辑后保存
export function CreatorApp({ onBack }: { onBack: () => void }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [messages, setMessages] = useState<TextMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [input, setInput] = useState('');
  const [started, setStarted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 进入页面自动开始创建会话
  useEffect(() => {
    if (started) return;
    setStarted(true);
    (async () => {
      setSending(true);
      try {
        const data = await api.startCreation();
        setSessionId(data.sessionId);
        setReady(false);
        if (data.draft) setDraft(data.draft);
        setMessages([
          {
            id: `npc-create-${Date.now()}`,
            sender: 'npc' as const,
            body: data.message,
            status: 'delivered',
            image_asset_id: null,
            internal: '',
            internal_notable: 0,
            internal_viewed: 0,
            created_at: Date.now(),
            delivered_at: Date.now(),
          },
        ]);
      } catch (err) {
        alert((err as Error).message);
        onBack();
      } finally {
        setSending(false);
      }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const handleSend = async () => {
    if (!input.trim() || sending || !sessionId) return;
    const text = input.trim();
    setInput('');
    setSending(true);
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: tempId,
        sender: 'player' as const,
        body: text,
        status: 'delivered',
        image_asset_id: null,
        internal: '',
        internal_notable: 0,
        internal_viewed: 0,
        created_at: Date.now(),
        delivered_at: Date.now(),
      },
    ]);
    try {
      const data = await api.creationChat(sessionId, text);
      setMessages((prev) => [
        ...prev.map((m) => (m.id === tempId ? { ...m, id: `player-${Date.now()}` } : m)),
        {
          id: `npc-${Date.now()}`,
          sender: 'npc' as const,
          body: data.message,
          status: 'delivered',
          image_asset_id: null,
          internal: '',
          internal_notable: 0,
          internal_viewed: 0,
          created_at: Date.now(),
          delivered_at: Date.now(),
        },
      ]);
      if (data.draft) setDraft(data.draft);
      if (data.ready) setReady(true);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(text);
      const msg = (err as Error & { body?: { error?: string } }).body?.error || (err as Error).message;
      if (msg.includes('不存在') || msg.includes('已结束') || msg.includes('404')) {
        setSessionId(null);
        setReady(false);
        setDraft(null);
      }
      alert(msg);
    } finally {
      setSending(false);
    }
  };

  const handleFinalize = async () => {
    if (!sessionId) return;
    setSending(true);
    try {
      const data = await api.finalizeCreation(sessionId, true, draft ?? undefined);
      alert(`${data.characterName}已进入主城。在地图上找到ta，打个招呼吧。`);
      onBack();
    } catch (err) {
      const msg = (err as Error & { body?: { error?: string } }).body?.error || (err as Error).message;
      if (msg.includes('不存在') || msg.includes('已结束') || msg.includes('404')) {
        setSessionId(null);
        setReady(false);
        setDraft(null);
      }
      alert(msg);
    } finally {
      setSending(false);
    }
  };

  const handleCancel = async () => {
    if (sessionId) {
      try {
        await api.cancelCreation(sessionId);
      } catch {
        /* ignore */
      }
    }
    onBack();
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={handleCancel}>←</button>
        <span className="id-appbar-title">创建角色</span>
      </div>

      <div className="id-chat-view" style={{ flex: 1, minHeight: 0 }}>
        {/* 创建卡片面板（角色卡预览/编辑） */}
        {sessionId && draft && (
          <CreationCardPanel
            draft={draft}
            showCard={showCard}
            onToggle={() => setShowCard(!showCard)}
            onChange={setDraft}
            onFinalize={handleFinalize}
            sending={sending}
          />
        )}

        {/* 消息列表 */}
        <div className="id-chat-messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="id-loading">正在召唤角色…</div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`id-bubble-row ${msg.sender}`}>
                {msg.sender === 'npc' && (
                  <div className="id-sms-chat-avatar">⚡</div>
                )}
                <div>
                  <div className={`id-bubble ${msg.sender}`}>{msg.body}</div>
                </div>
              </div>
            ))
          )}
          {sending && <div className="id-typing-dots"><span /><span /><span /></div>}
        </div>

        {/* 输入区 */}
        <div className="id-chat-input-area">
          {ready ? (
            <>
              <button className="id-chat-send-btn" style={{ width: 'auto', padding: '0 1rem' }} onClick={handleFinalize} disabled={sending}>
                ✓ 就这样吧
              </button>
              <button className="id-chat-send-btn" style={{ width: 'auto', padding: '0 1rem', background: 'rgba(255,255,255,0.05)', borderColor: 'var(--border)' }} onClick={() => setReady(false)}>
                继续修改
              </button>
            </>
          ) : (
            <>
              <input
                ref={inputRef}
                className="id-chat-input"
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="描述你想要的角色…"
                disabled={sending}
              />
              <button className="id-chat-send-btn" onClick={handleSend} disabled={sending || !input.trim()}>
                ➤
              </button>
              <button
                className="id-chat-send-btn"
                style={{ width: 'auto', padding: '0 0.7rem', background: 'rgba(255,255,255,0.05)', borderColor: 'var(--border)', color: 'var(--text-mute)' }}
                onClick={handleCancel}
                disabled={sending}
              >
                ✕
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
