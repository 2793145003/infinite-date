import { useState, useRef, useEffect } from 'react';
import { api } from '../lib/api';
import { AutoTextarea } from '../components/AutoTextarea';
import { renderTextWithActions } from '../lib/text-render';

interface ExploreMessage {
  id: string;
  role: 'player' | 'narration';
  text: string;
  foundItem?: { ownerName: string; itemDescription: string };
}

export function Explore({
  sessionId,
  locationName,
  initialNarration,
  onBack,
}: {
  sessionId: string;
  locationId: string;
  locationName: string;
  initialNarration: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ExploreMessage[]>([
    { id: 'init', role: 'narration', text: initialNarration },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showEndModal, setShowEndModal] = useState(false);
  const [ending, setEnding] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');

    const playerMsg: ExploreMessage = { id: `p-${Date.now()}`, role: 'player', text };
    setMessages(prev => [...prev, playerMsg]);

    try {
      const data = await api.exploreAct(sessionId, text);
      setMessages(prev => [...prev, {
        id: `n-${Date.now()}`,
        role: 'narration',
        text: data.narration,
        foundItem: data.foundItem ?? undefined,
      }]);
    } catch (err) {
      const e = err as Error;
      setMessages(prev => [...prev, {
        id: `e-${Date.now()}`,
        role: 'narration',
        text: `（出了点问题：${e.message}）`,
      }]);
    } finally {
      setSending(false);
    }
  };

  const handleEnd = async () => {
    setEnding(true);
    try {
      await api.endExplore(sessionId);
    } catch { /* ignore */ }
    onBack();
  };

  return (
    <div className="id-chat-view">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={() => setShowEndModal(true)}>←</button>
        <span className="id-appbar-title">探索 · {locationName}</span>
        <button className="id-appbar-action" onClick={() => setShowEndModal(true)} title="结束探索">✕</button>
      </div>

      <div className="id-chat-messages">
        {messages.map(msg => (
          msg.role === 'player' ? (
            <div key={msg.id} className="id-bubble-row player">
              <div className="id-bubble player">
                {renderTextWithActions(msg.text)}
              </div>
            </div>
          ) : (
            <div key={msg.id} className="id-narration">
              <div className="id-narration-line" />
              <div className="id-narration-text">
                {renderTextWithActions(msg.text)}
                {msg.foundItem && (
                  <div className="id-explore-found-item">
                    <span>📦 发现了{msg.foundItem.ownerName}的{msg.foundItem.itemDescription}</span>
                  </div>
                )}
              </div>
              <div className="id-narration-line" />
            </div>
          )
        ))}
        {sending && (
          <div className="id-typing-dots"><span /><span /><span /></div>
        )}
        <div ref={endRef} />
      </div>

      <div className="id-chat-input-area">
        <AutoTextarea
          className="id-chat-input id-chat-input-textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="你做什么？"
          disabled={sending}
          rows={1}
        />
        <button className="id-chat-send-btn" onClick={handleSend} disabled={sending || !input.trim()}>
          ➤
        </button>
      </div>

      {showEndModal && (
        <div className="id-modal-overlay" onClick={() => setShowEndModal(false)}>
          <div className="id-modal" onClick={e => e.stopPropagation()}>
            <div className="id-modal-title">结束探索？</div>
            <div className="id-modal-desc">
              离开{locationName}，结束本次探索。
            </div>
            <div className="id-modal-actions">
              <button className="id-btn danger" onClick={handleEnd} disabled={ending}>
                {ending ? '结束中…' : '离开'}
              </button>
              <button className="id-btn" onClick={() => setShowEndModal(false)} disabled={ending}>
                继续探索
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
