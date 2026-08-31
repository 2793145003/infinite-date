import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

const PLAYER_TOKEN = '{{player_name}}';
const PLAYER_LABEL = '玩家';
const ZWSP = '\u200B'; // 零宽空格：chip 之间的输入分隔

export interface PlayerChipInputHandle {
  insertPlayer: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  onBlur?: (text: string) => void;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 纯文本（含 {{player_name}}）→ HTML（{{player_name}} 渲染为原子 chip）
function textToHtml(text: string): string {
  return text
    .split(PLAYER_TOKEN)
    .map((part, i, arr) => {
      let html = escapeHtml(part).replace(/\n/g, '<br>');
      if (i < arr.length - 1) {
        html += `<span class="player-chip" contenteditable="false" data-player="1">${PLAYER_LABEL}</span>${ZWSP}`;
      }
      return html;
    })
    .join('');
}

// DOM → 纯文本（chip → {{player_name}}，过滤零宽空格）
function domToText(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent || '').replace(/\u200B/g, '');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.getAttribute('data-player') === '1') {
        out += PLAYER_TOKEN;
        return;
      }
      if (el.tagName === 'BR') {
        out += '\n';
        return;
      }
      for (const c of Array.from(el.childNodes)) walk(c);
      if (el.tagName === 'DIV' || el.tagName === 'P') out += '\n';
    }
  };
  walk(root);
  return out.replace(/\n+$/, '');
}

export const PlayerChipInput = forwardRef<PlayerChipInputHandle, Props>(
  function PlayerChipInput({ value, onChange, placeholder, className, rows = 3, onBlur }, ref) {
    const divRef = useRef<HTMLDivElement>(null);
    const lastRendered = useRef<string | null>(null);
    const emitRef = useRef<() => void>(() => {});

    const emit = () => {
      const div = divRef.current;
      if (!div) return;
      const text = domToText(div);
      lastRendered.current = text;
      onChange(text);
    };
    emitRef.current = emit;

    // 初始化 / 外部 value 变化时同步（避免覆盖用户正在输入的内容）
    useEffect(() => {
      const div = divRef.current;
      if (!div) return;
      if (lastRendered.current === value) return;
      div.innerHTML = textToHtml(value);
      lastRendered.current = value;
    }, [value]);

    const insertPlayer = () => {
      const div = divRef.current;
      if (!div) return;
      div.focus();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!div.contains(range.commonAncestorContainer)) {
        range.selectNodeContents(div);
        range.collapse(false);
      }
      range.deleteContents();

      const chip = document.createElement('span');
      chip.className = 'player-chip';
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute('data-player', '1');
      chip.textContent = PLAYER_LABEL;

      range.insertNode(chip);
      const zwsp = document.createTextNode(ZWSP);
      range.setStartAfter(chip);
      range.collapse(true);
      range.insertNode(zwsp);
      range.setStartAfter(zwsp);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);

      emitRef.current();
    };

    useImperativeHandle(ref, () => ({ insertPlayer }));

    return (
      <div
        ref={divRef}
        className={`player-chip-input ${className || ''}`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emit}
        onBlur={() => { emit(); onBlur?.(lastRendered.current ?? value); }}
        style={{
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          userSelect: 'text',
          WebkitUserSelect: 'text',
          minHeight: `${rows * 1.5}em`,
          overflowY: 'auto',
        }}
      />
    );
  }
);
