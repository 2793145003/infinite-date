import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { CreationCardPanel } from './CreationCardPanel';

interface CreatorMessage {
  id: string;
  sender: 'player' | 'npc';
  body: string;
}

/**
 * 聊天式创建角色（照 v2 CreatorApp）：进入自动开始创建会话，AI 引导对话生成角色卡，
 * 可随时展开「角色卡」编辑 draft（后端 CharacterData 结构），确认后 finalize 落库。
 */
export function CreatorApp({ onBack, onCreated }: { onBack: () => void; onCreated?: () => void }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [messages, setMessages] = useState<CreatorMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [input, setInput] = useState('');
  const [started, setStarted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
        setMessages([{ id: `npc-${Date.now()}`, sender: 'npc', body: data.message }]);
      } catch (err) {
        alert((err as Error).message);
        onBack();
      } finally {
        setSending(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setMessages((prev) => [...prev, { id: tempId, sender: 'player', body: text }]);
    try {
      const data = await api.creationChat(sessionId, text);
      setMessages((prev) => [
        ...prev.map((m) => (m.id === tempId ? { ...m, id: `player-${Date.now()}` } : m)),
        { id: `npc-${Date.now()}`, sender: 'npc', body: data.message },
      ]);
      if (data.draft) setDraft(data.draft);
      if (data.ready) setReady(true);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(text);
      alert((err as Error).message);
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
      onCreated?.();
      onBack();
    } catch (err) {
      alert((err as Error).message);
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
    <div className="w-full max-w-md mx-auto min-h-full px-3.5 pt-3 pb-24 flex flex-col select-none">
      {/* 头部 */}
      <header className="sticky top-0 z-30 bg-bg-soft backdrop-blur-md flex items-center justify-between py-2 border-b border-border/80 mb-3">
        <button
          type="button"
          onClick={handleCancel}
          className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition shadow-2xs"
          aria-label="取消创建"
        >
          ←
        </button>
        <div className="text-center">
          <h1 className="text-sm font-bold text-ink">创建角色</h1>
          <p className="text-[10px] text-ink-muted">和系统对话，召唤你想要的角色</p>
        </div>
        <div className="w-8 h-8" />
      </header>

      {/* 创建卡片面板（角色卡预览/编辑） */}
      {sessionId && draft && (
        <div className="mb-2">
          <CreationCardPanel
            draft={draft}
            showCard={showCard}
            onToggle={() => setShowCard(!showCard)}
            onChange={setDraft}
            onFinalize={handleFinalize}
            sending={sending}
          />
        </div>
      )}

      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-2 space-y-2.5">
        {messages.length === 0 ? (
          <div className="text-center text-xs text-ink-faint py-10">正在召唤角色…</div>
        ) : (
          messages.map((msg) =>
            msg.sender === 'npc' ? (
              <div key={msg.id} className="flex items-start gap-2">
                <div className="w-7 h-7 rounded-full frosted-glass border border-border flex items-center justify-center text-sm shrink-0">
                  ⚡
                </div>
                <div className="max-w-[78%] px-3.5 py-2.5 rounded-2xl rounded-tl-sm frosted-glass border border-border text-sm text-ink leading-relaxed shadow-2xs">
                  {msg.body}
                </div>
              </div>
            ) : (
              <div key={msg.id} className="flex justify-end">
                <div className="max-w-[78%] px-3.5 py-2.5 rounded-2xl rounded-tr-sm bg-bg-rose-soft/70 text-sm text-ink leading-relaxed">
                  {msg.body}
                </div>
              </div>
            )
          )
        )}
        {sending && (
          <div className="flex items-center gap-1 px-1">
            <span className="w-1.5 h-1.5 rounded-full bg-bg-muted-2 animate-bounce" />
            <span className="w-1.5 h-1.5 rounded-full bg-bg-muted-2 animate-bounce" style={{ animationDelay: '0.1s' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-bg-muted-2 animate-bounce" style={{ animationDelay: '0.2s' }} />
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="flex items-center gap-2 pt-2 pb-[81px]">
        {ready ? (
          <>
            <button
              type="button"
              className="flex-1 rounded-lg bg-rose py-2.5 text-sm font-semibold text-ink-on hover:bg-rose transition disabled:opacity-50"
              onClick={handleFinalize}
              disabled={sending}
            >
              ✓ 就这样吧
            </button>
            <button
              type="button"
              className="px-3 py-2.5 rounded-lg frosted-glass border border-border text-xs font-medium text-ink-soft hover:bg-bg-muted transition"
              onClick={() => setReady(false)}
            >
              继续修改
            </button>
          </>
        ) : (
          <>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="描述你想要的角色…"
              disabled={sending}
              className="flex-1 px-3.5 py-2.5 text-sm bg-bg-muted/90 rounded-full border border-border-strong/80 outline-none focus:bg-bg-soft focus:border-border-dark transition disabled:opacity-50"
            />
            <button
              type="button"
              className="w-10 h-10 rounded-full bg-rose text-ink-on flex items-center justify-center hover:bg-rose transition disabled:opacity-50 shrink-0"
              onClick={handleSend}
              disabled={sending || !input.trim()}
            >
              ➤
            </button>
          </>
        )}
      </div>
    </div>
  );
}
