/**
 * drive（内驱力）提炼 —— 从角色卡素材自动生成「主动找话题/推进」方向。
 * - 新角色创建时调用，自动生成并写进 character_data.drive。
 * - NSFW/纯性/强制型角色（素材无对话恋爱内容）返回 null，跳过不生成。
 * - 提炼失败返回 null，不影响角色创建主流程。
 */
import { chat } from '../llm/adapter';
import type { CharacterData } from '@idate/shared';

const DRIVE_SYS = `你是恋爱约会游戏的「角色内驱力」提炼助手。玩家捏了一个角色（素材见下），你要为这个角色写一段「内驱力」——他在和玩家相处时，主动找话题、推进对话、了解玩家、把相处带往深处的方向。

规则：
1. 必须写「他主动做什么」。即使角色安静、慢热、被动，也要写出他主动带话题、主动了解对方的具体方式。绝不写「他安静陪着」「他不主动搭话」「让沉默自然流淌」这类还原被动的描述。
2. 风格必须来自素材：性格、喜好、关系决定他「用什么方式找话题、往哪个方向推进」，要有辨识度，不要千人一面的「关心你」。
3. 强势、掌控欲强、占有欲强的角色，可以保留这种张力（如"主导对话节奏""宣示归属"），但落脚点必须是「主动了解她、把话题往她身上带、推进关系」，绝不能写成「命令她、封锁话题、逼她服从、剥夺她选择权」。
4. 红线（绝不出现）：性暴力、SM、强迫、羞辱、贬低、精神控制、具体的情色动作描写。drive 只停在「对话与相处层面」。
5. 如果这个角色的核心内容就是「性/强制/肉体关系」，没有「对话、恋爱、相处」的素材可提炼，直接输出 SKIP。
6. 一段话，80~120 字，用「你」开头（直接对角色说），指代玩家统一用「她」。
7. 只基于素材，不发明素材里没有的设定。
8. 只输出内驱力文本本身（或 SKIP），不要前缀、解释、引号。

范例（安静慢热角色）：
你话不多，但你对她的在意是真的。你要主动把话题往前带——问她今天的状态、注意到她话里没说出口的情绪、分享你观察到的安静小事。你的方式温柔而不打扰，但你不让沉默冷场，不让这段相处变成两个人干坐着。`;

/** 从 CharacterData 拼提炼素材（对齐 buildCharacterCard 的字段选择，但直接吃对象不查库） */
function materialFromCharData(d: CharacterData): string {
  const lines: string[] = [];
  if (d.name) lines.push(`名字：${d.name}`);
  if (d.appearance) lines.push(`外貌：${d.appearance}`);
  const pers = [d.personality?.surface, d.personality?.core, d.personality?.extreme].filter(Boolean).join('；');
  if (pers) lines.push(`性格：${pers}`);
  if (d.speechStyle?.description) lines.push(`说话风格：${d.speechStyle.description}`);
  const bg = d.background;
  const bgParts = [
    bg?.origin && `出身：${bg.origin}`,
    bg?.shaping && `经历：${bg.shaping}`,
    bg?.current && `现状：${bg.current}`,
  ].filter(Boolean);
  if (bgParts.length) lines.push(`背景：${bgParts.join('；')}`);
  if (Array.isArray(d.likes) && d.likes.length) lines.push(`喜欢：${d.likes.map(String).filter(Boolean).join('、')}`);
  if (Array.isArray(d.dislikes) && d.dislikes.length) lines.push(`讨厌：${d.dislikes.map(String).filter(Boolean).join('、')}`);
  if (d.boundaries) lines.push(`底线：${d.boundaries}`);
  if (d.goals) lines.push(`目标：${d.goals}`);
  if (d.player_relation) lines.push(`关系：${d.player_relation}`);
  if (d.quirks) lines.push(`怪癖：${d.quirks}`);
  if (d.skills) lines.push(`擅长：${d.skills}`);
  return lines.join('\n');
}

/**
 * 从角色卡素材提炼内驱力。
 * @returns drive 文本；SKIP（NSFW/纯性角色）或失败时返回 null
 */
export async function extractDrive(charData: CharacterData): Promise<string | null> {
  try {
    const material = materialFromCharData(charData);
    if (!material.trim()) return null;
    const result = await chat(
      [
        { role: 'system', content: DRIVE_SYS },
        { role: 'user', content: `角色素材：\n${material}\n\n请提炼这位角色的内驱力。` },
      ],
      { temperature: 0.7, maxTokens: 200, callType: 'drive_extract' },
    );
    const drive = result.content.trim();
    if (!drive || /^SKIP$/i.test(drive)) return null;
    return drive;
  } catch (err) {
    console.warn('[drive] extract failed:', err);
    return null;
  }
}
