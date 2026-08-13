/**
 * 清洗 LLM 生成的 NPC 台词里的「游离（不配对）右闭符号」。
 *
 * 背景：Gemma 在生成台词时偶发在句尾多补一个孤立的右括号/右引号（如 `…躯壳。）`
 * 或 `…响应。"」），因为 JSON schema 只校验字符串类型、管不着内容里的字符配对，
 * 于是这种「多出一个右闭符号」会原样落库、污染展示。
 *
 * 规则（只修游离、绝不碰成对）：
 *   统计全串中 `（`/`）`、`"`/`"` 各自的左右数量。
 *   若右闭符号数量 > 左开符号数量，说明存在「多余」的右闭符号，
 *   从字符串末尾开始，把多出来的那几个右闭符号删掉。
 *   —— 因为「游离」的右闭符号几乎总是出现在句尾。
 *
 *   成对的（`（他…）`、`"话"`）左右数量相等，完全不触发，零误伤。
 *
 * 只用于 NPC 台词；玩家消息（用户原话）与旁白不清洗。
 * 纯函数，无副作用，可安全用于落库前的增量清洗与存量数据回刷。
 */
export function cleanStraySymbols(text: string): string {
  if (!text) return text;
  // 统一半角括号为全角——点名版不走 cleanMessageText，半角 () 会漏网
  let out = text.replace(/\(/g, '（').replace(/\)/g, '）');
  const count = (s: string, ch: string): number => {
    let c = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === ch) c++;
    return c;
  };
  // 从末尾删多余个 target
  const dropTrailing = (s: string, open: string, close: string, target: string): string => {
    const excess = count(s, close) - count(s, open);
    if (excess <= 0) return s;
    const arr = s.split('');
    let removed = 0;
    for (let j = arr.length - 1; j >= 0 && removed < excess; j--) {
      if (arr[j] === target) {
        arr.splice(j, 1);
        removed++;
      }
    }
    return arr.join('');
  };
  out = dropTrailing(out, '（', '）', '）');
  out = dropTrailing(out, '\u201c', '\u201d', '\u201d');
  return out;
}
