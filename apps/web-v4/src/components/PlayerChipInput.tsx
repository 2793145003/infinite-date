import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent } from 'react';

const PLAYER_TOKEN = '{{player_name}}';
const CHARACTER_TOKEN = '{{character_name}}';
const PLAYER_LABEL = '玩家';
const CHARACTER_LABEL = '角色名';
const ZWSP = '\u200B'; // 零宽空格：chip 之间的输入分隔

export interface PlayerChipInputHandle {
  insertPlayer: () => void;
  insertCharacter: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  rows?: number;
  onBlur?: (text: string) => void;
  /** 真实角色名：角色名胶囊显示真实角色名，为空时显示「角色名」三个字 */
  characterName?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isChip(node: Node | null): node is HTMLElement {
  return (
    !!node &&
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as HTMLElement).getAttribute('data-player') === '1' ||
      (node as HTMLElement).getAttribute('data-character') === '1')
  );
}

function isZwsp(node: Node | null): boolean {
  return !!node && node.nodeType === Node.TEXT_NODE && node.textContent === ZWSP;
}

// 归一化占位符变体（{{char_name}}/{{char}}/{{player}}/{{user}} 等 → 标准 token），
// 防止 LLM 输出或历史数据里的 {{char_name}} 变体无法被识别成胶囊。
function normalizeTokens(text: string): string {
  return text
    .replace(/\{\{\s*char_name\s*\}\}/g, CHARACTER_TOKEN)
    .replace(/\{\{\s*character\s*\}\}/g, CHARACTER_TOKEN)
    .replace(/\{\{\s*char\s*\}\}/g, CHARACTER_TOKEN)
    .replace(/\{\{\s*角色名\s*\}\}/g, CHARACTER_TOKEN)
    .replace(/\{\{\s*player_name\s*\}\}/g, PLAYER_TOKEN)
    .replace(/\{\{\s*user_name\s*\}\}/g, PLAYER_TOKEN)
    .replace(/\{\{\s*player\s*\}\}/g, PLAYER_TOKEN)
    .replace(/\{\{\s*user\s*\}\}/g, PLAYER_TOKEN)
    .replace(/\{\{\s*玩家\s*\}\}/g, PLAYER_TOKEN);
}

// 纯文本（含 {{character_name}}/{{player_name}}）→ HTML（token 渲染为原子 chip）
function textToHtml(text: string, characterName?: string): string {
  const charLabel = escapeHtml(characterName || CHARACTER_LABEL);
  return normalizeTokens(text)
    .split(/(\{\{character_name\}\}|\{\{player_name\}\})/)
    .map((part) => {
      if (part === PLAYER_TOKEN) {
        return `<span class="player-chip" contenteditable="false" data-player="1">${PLAYER_LABEL}</span>${ZWSP}`;
      }
      if (part === CHARACTER_TOKEN) {
        return `<span class="player-chip char-chip" contenteditable="false" data-character="1">${charLabel}</span>${ZWSP}`;
      }
      return escapeHtml(part).replace(/\n/g, '<br>');
    })
    .join('');
}

// DOM → 纯文本（chip → token，过滤零宽空格）
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
      if (el.getAttribute('data-character') === '1') {
        out += CHARACTER_TOKEN;
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
  function PlayerChipInput({ value, onChange, placeholder, className, rows = 3, onBlur, characterName }, ref) {
    const divRef = useRef<HTMLDivElement>(null);
    const lastRendered = useRef<string | null>(null);
    const lastCharName = useRef<string | undefined>(undefined);
    const emitRef = useRef<() => void>(() => {});
    const charNameRef = useRef<string | undefined>(characterName);
    charNameRef.current = characterName;

    const emit = () => {
      const div = divRef.current;
      if (!div) return;
      const text = domToText(div);
      lastRendered.current = text;
      onChange(text);
    };
    emitRef.current = emit;

    // 初始化 / 外部 value 或角色名变化时同步（避免覆盖用户正在输入的内容）
    useEffect(() => {
      const div = divRef.current;
      if (!div) return;
      if (lastRendered.current === value && lastCharName.current === characterName) return;
      div.innerHTML = textToHtml(value, characterName);
      lastRendered.current = value;
      lastCharName.current = characterName;
    }, [value, characterName]);

    const insertToken = (kind: 'player' | 'character') => {
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
      chip.className = 'player-chip' + (kind === 'character' ? ' char-chip' : '');
      chip.setAttribute('contenteditable', 'false');
      chip.setAttribute(kind === 'character' ? 'data-character' : 'data-player', '1');
      // 玩家胶囊固定显示「玩家」，角色名胶囊显示真实角色名（空兜底「角色名」）
      chip.textContent = kind === 'character' ? (charNameRef.current || CHARACTER_LABEL) : PLAYER_LABEL;

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

    // 删除一个 chip（连带它后面的零宽空格），并把光标恢复到 chip 原位
    const removeChip = (chip: HTMLElement) => {
      const r = document.createRange();
      r.setStartBefore(chip);
      r.collapse(true);
      const next = chip.nextSibling;
      if (isZwsp(next)) next.remove();
      chip.remove();
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
      }
    };

    // contenteditable=false 的 chip 是原子节点，浏览器默认 backspace/delete 行为不可靠
    //（chip 后跟零宽空格，退格先删空字符、chip 看似删不掉）。这里手动拦截删除整个 chip。
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return;

      const { startContainer, startOffset } = range;

      if (e.key === 'Backspace') {
        // 光标在 chip 后面的零宽空格里，任意位置退格都删 chip
        if (startContainer.nodeType === Node.TEXT_NODE && startContainer.textContent === ZWSP) {
          const chip = startContainer.previousSibling;
          if (isChip(chip)) {
            e.preventDefault();
            removeChip(chip);
            emitRef.current();
            return;
          }
        }
        let before: Node | null = null;
        if (startContainer.nodeType === Node.TEXT_NODE) {
          if (startOffset === 0) before = startContainer.previousSibling;
        } else {
          const children = Array.from((startContainer as HTMLElement).childNodes);
          before = children[startOffset - 1] ?? null;
        }
        // before 是零宽空格（光标在胶囊后方文字开头）时，退格应删零宽空格前面的胶囊
        if (isZwsp(before)) {
          const chip = before.previousSibling;
          if (isChip(chip)) {
            e.preventDefault();
            removeChip(chip);
            emitRef.current();
            return;
          }
        }
        if (isChip(before)) {
          e.preventDefault();
          removeChip(before);
          emitRef.current();
        }
      } else {
        // Delete：光标紧后是 chip 时删除整个 chip
        let after: Node | null = null;
        if (startContainer.nodeType === Node.TEXT_NODE) {
          if (startOffset === (startContainer.textContent || '').length) after = startContainer.nextSibling;
        } else {
          const children = Array.from((startContainer as HTMLElement).childNodes);
          after = children[startOffset] ?? null;
        }
        if (isChip(after)) {
          e.preventDefault();
          removeChip(after);
          emitRef.current();
        }
      }
    };

    const insertPlayer = () => insertToken('player');
    const insertCharacter = () => insertToken('character');

    useImperativeHandle(ref, () => ({ insertPlayer, insertCharacter }));

    return (
      <div
        ref={divRef}
        className={`player-chip-input ${className || ''}`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={emit}
        onKeyDown={handleKeyDown}
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
