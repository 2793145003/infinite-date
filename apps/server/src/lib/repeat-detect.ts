/**
 * 复述检测相关的纯函数（无任何 DB/LLM 依赖）。
 *
 * 单独成文件的原因：这些函数被测试直接 import；若放在 run-scene-turn.ts 里，
 * 测试会通过其 import 链（llm/adapter → db）触发 SQLite 连接，
 * 多个测试子进程并发打开同一 DB 会报 `database is locked`。
 */

/** 从对话历史末尾提取玩家最后一条发言（去掉名字前缀）。
 *  重试/继续空推轮 player_message 为空，但角色可能复述历史里玩家上一句话——
 *  用这条历史发言做复述检测锚点（只用于检测，不落库、不追加历史）。 */
export function extractLastPlayerLine(conversationSoFar: string, playerName: string): string {
  const pn = playerName?.trim();
  if (!pn || !conversationSoFar) return '';
  const lines = conversationSoFar.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.trim() ?? '';
    if (!t) continue;
    if (t.startsWith(`${pn}：`) || t.startsWith(`${pn}:`)) {
      return t.replace(/^[^：:]+[：:]\s*/, '');
    }
  }
  return '';
}
