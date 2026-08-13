import { useRef, useCallback, useEffect } from 'react';

/** 自适应高度的 textarea — 内容变化时自动撑高，不出现内部滚动条 */
export function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  // 初次挂载及 value 外部变化时自动撑高
  useEffect(() => { resize(); }, [props.value, resize]);

  return (
    <textarea
      {...props}
      ref={ref}
      onInput={resize}
      onChange={e => { props.onChange?.(e); resize(); }}
      style={{ minHeight: '2.4rem', ...props.style, overflow: 'hidden', resize: 'none' }}
    />
  );
}
