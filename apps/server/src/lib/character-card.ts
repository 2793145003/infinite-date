/**
 * character-card —— 角色卡构建（独立文件，可单独编辑调优）
 *
 * 设计依据：实测对比（scripts/card-ab.ts）证明——角色卡"精简+选对字段"比"全塞"更有辨识度。
 *   - 完整版（全字段 JSON）→ 信息被稀释 → 模板化
 *   - 旧版（只留概念的 4 字段）→ 锚点太少 → 也偏泛
 *   - 本版（精选行为信号/台词范例/底线/弱点/癖好）→ 信息密度高、锚点准 → 最有辨识度
 *
 * 保留原则：
 *   - 玩家可手写编辑的人设字段 **全部原样完整保留**（外貌/性格三层/说话风格+范例/
 *     行为信号(含全部情绪)/背景三段/喜欢/讨厌/底线/目标/怪癖/擅长/不擅长/关系）
 *   - 精简：仅短信风格(textingStyle)不上卡（玩家手写但用于短信语境，场景对话用不到）、
 *     系统生成的 backstory_milestones（玩家追问的往事在 background 里完整）不重复塞
 *
 * CharacterData 字段（见 @idate/shared）：
 *   name age appearance personality{surface/core/extreme} speechStyle{description,examples[]}
 *   textingStyle background{origin/shaping/current} emotional_signals likes[] dislikes[]
 *   boundaries goals quirks backstory_milestones[] player_relation skills ineptitudes
 */
import { loadCharacterData } from './character';

/**
 * 把 CharacterData 提炼成一段精炼、有辨识度的角色卡。
 * @param playerId 玩家（fork 优先）
 * @param characterId 角色
 */
export function buildCharacterCard(playerId: string, characterId: string): string {
  const data = loadCharacterData(playerId, characterId);
  if (!data) return '';
  const d = data as any;
  const lines: string[] = [];

  const name = d.name;
  if (name) {
    const age = d.age ? `（${d.age}）` : '';
    lines.push(`【角色】${name}${age}`);
  }

  // 外貌：玩家手写，完整保留
  if (d.appearance) lines.push(`【外貌】${d.appearance}`);

  // 性格三层：全留
  if (d.personality) {
    const p = d.personality;
    const pers = [p.surface, p.core, p.extreme].filter(Boolean).join('；');
    if (pers) lines.push(`【性格】${pers}`);
  }

  // 说话风格：描述 + 台词范例（玩家手写，完整保留）
  if (d.speechStyle) {
    const style: string[] = [];
    if (d.speechStyle.description) style.push(d.speechStyle.description);
    if (Array.isArray(d.speechStyle.examples) && d.speechStyle.examples.length) {
      const exs = d.speechStyle.examples.map((e: any) => {
        if (typeof e === 'string') return `· ${e}`;
        return `· ${e.line ?? ''}`;
      }).filter(Boolean);
      if (exs.length) style.push(`台词范例：\n${exs.join('\n')}`);
    }
    if (style.length) lines.push(`【说话风格】\n${style.join('\n')}`);
  }

  // 行为信号：全部情绪（紧张/开心/感动/防御/愤怒）完整保留
  if (d.emotional_signals) {
    const e = d.emotional_signals;
    const sigs = [e.nervous, e.happy, e.moved, e.defensive, e.angry].filter(Boolean).join('；');
    if (sigs) lines.push(`【身体语言】${sigs}`);
  }

  // 背景：三段完整（出身/经历/现状）——玩家手写的往事(如哥哥失踪)在经历段
  if (d.background) {
    const bg: string[] = [];
    if (d.background.origin) bg.push(`出身：${d.background.origin}`);
    if (d.background.shaping) bg.push(`经历：${d.background.shaping}`);
    if (d.background.current) bg.push(`现状：${d.background.current}`);
    if (bg.length) lines.push(`【背景】\n${bg.join('\n')}`);
  }

  // 底线
  if (d.boundaries) lines.push(`【底线】${d.boundaries}`);

  // 喜欢/讨厌：完整
  const like = Array.isArray(d.likes) ? d.likes.map((l: any) => String(l)).filter(Boolean).join('、') : '';
  const dis = Array.isArray(d.dislikes) ? d.dislikes.map((x: any) => String(x)).filter(Boolean).join('、') : '';
  if (like) lines.push(`【喜欢】${like}`);
  if (dis) lines.push(`【讨厌】${dis}`);

  // 怪癖
  if (d.quirks) lines.push(`【怪癖】${d.quirks}`);

  // 擅长 / 不擅长
  if (d.skills) lines.push(`【擅长】${d.skills}`);
  if (d.ineptitudes) lines.push(`【不擅长】${d.ineptitudes}`);

  // 目标 / 关系
  if (d.goals) lines.push(`【目标】${d.goals}`);
  if (d.player_relation) lines.push(`【关系】${d.player_relation}`);

  return lines.join('\n');
}
