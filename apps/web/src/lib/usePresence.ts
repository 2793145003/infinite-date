import { useEffect, useRef, useCallback } from 'react';
import { api, type ProactiveMessage } from './api';

const HEARTBEAT_INTERVAL = 15_000; // 15s

/**
 * 跟踪用户在聊天/约会界面的闲置状态，定期发心跳。
 * 闲置超过阈值时，后端有概率触发NPC主动消息。
 *
 * @param view 当前视图类型
 * @param ctx  上下文（sessionId/threadId/characterId）
 * @param onProactive 收到NPC主动消息时的回调
 */
export function usePresence(
  view: string,
  ctx: { sessionId?: string; threadId?: string; characterId?: string },
  onProactive: (messages: ProactiveMessage[]) => void,
) {
  const lastActivityRef = useRef(Date.now());
  const onProactiveRef = useRef(onProactive);
  onProactiveRef.current = onProactive;

  // 用户活动时重置闲置计时
  const markActive = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // 监听用户活动事件
  useEffect(() => {
    const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
    for (const e of events) {
      window.addEventListener(e, markActive, { passive: true });
    }
    // 输入框有焦点时也算活跃——用户正在想说什么但还没按键
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) {
        markActive();
      }
    };
    window.addEventListener('focusin', onFocusIn);
    return () => {
      for (const e of events) {
        window.removeEventListener(e, markActive);
      }
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [markActive]);

  // 心跳定时器
  useEffect(() => {
    if (view !== 'conversation' && view !== 'sms-thread') return;

    let stopped = false;

    const beat = async () => {
      if (stopped) return;
      // 输入框有焦点时认为用户在线——正在打字或想内容
      const activeEl = document.activeElement;
      const inputFocused = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || (activeEl as HTMLElement).isContentEditable);
      const idleMs = inputFocused ? 0 : Date.now() - lastActivityRef.current;
      try {
        const res = await api.heartbeat({
          view,
          sessionId: ctx.sessionId,
          threadId: ctx.threadId,
          characterId: ctx.characterId,
          idleMs,
        });
        if (res.proactive && res.messages && res.messages.length > 0) {
          onProactiveRef.current(res.messages);
        }
      } catch { /* ignore */ }
    };

    // 首次延迟3s再开始（避免页面加载时立刻触发）
    const firstTimer = setTimeout(beat, 3000);
    const interval = setInterval(beat, HEARTBEAT_INTERVAL);

    return () => {
      stopped = true;
      clearTimeout(firstTimer);
      clearInterval(interval);
      // 离开页面时清除状态
      api.clearPresence().catch(() => {});
    };
  }, [view, ctx.sessionId, ctx.threadId, ctx.characterId]);
}
