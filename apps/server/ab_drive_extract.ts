/**
 * drive（内驱力）提炼脚本 —— 重提强势型角色（许墨/顾珩/秦彻）。
 * 相比首版：加了红线（禁暴力/控制），明确「推进=找话题了解她」而非「命令/封锁」。
 * 只打印、不写库。
 */
import { db } from './src/db';
import { chat } from './src/llm/adapter';
import { buildCharacterCard } from './src/lib/character-card';

const SYS = `你是恋爱约会游戏的「角色内驱力」提炼助手。玩家捏了一个角色（素材见下），你要为这个角色写一段「内驱力」——他在和玩家相处时，主动找话题、推进对话、了解玩家、把相处带往深处的方向。

规则：
1. 必须写「他主动做什么」。即使角色安静、慢热、被动，也要写出他主动带话题、主动了解对方的具体方式。绝不写「他安静陪着」「他不主动搭话」「让沉默自然流淌」这类还原被动的描述。
2. 风格必须来自素材：性格、喜好、关系决定他「用什么方式找话题、往哪个方向推进」，要有辨识度，不要千人一面的「关心你」。
3. 强势、掌控欲强、占有欲强的角色，可以保留这种张力（如"主导对话节奏""宣示归属"），但落脚点必须是「主动了解她、把话题往她身上带、推进关系」，绝不能写成「命令她、封锁话题、逼她服从、剥夺她选择权」。
4. 红线（绝不出现）：性暴力、SM、强迫、羞辱、贬低、精神控制、具体的情色动作描写。drive 只停在「对话与相处层面」。
5. 一段话，80~120 字，用「你」开头（直接对角色说）。
6. 只基于素材，不发明素材里没有的设定。
7. 只输出内驱力文本本身，不要前缀、解释、引号。

范例（安静慢热角色）：
你话不多，但你对她的在意是真的。你要主动把话题往前带——问她今天的状态、注意到她话里没说出口的情绪、分享你观察到的安静小事。你的方式温柔而不打扰，但你不让沉默冷场，不让这段相处变成两个人干坐着。`;

const TARGET = new Set(['许墨', '顾珩', '秦彻']);

async function main() {
  const rows = db.prepare('SELECT id, character_data FROM characters').all() as Array<{ id: string; character_data: string }>;
  for (const row of rows) {
    const data = JSON.parse(row.character_data);
    const name = data.name || '(未命名)';
    if (!TARGET.has(name)) continue;
    const card = buildCharacterCard('', row.id);
    if (!card) {
      console.log(`【${name}】⚠️ 角色卡为空，跳过`);
      continue;
    }
    const result = await chat(
      [
        { role: 'system', content: SYS },
        { role: 'user', content: `角色素材：\n${card}\n\n请提炼这位角色的内驱力。` },
      ],
      { temperature: 0.7, maxTokens: 200, callType: 'drive_extract' },
    );
    console.log(`\n【${name}】${result.content.trim()}`);
  }
}

main()
  .then(() => console.log('\n✅ 3 条重提完成'))
  .catch((e) => {
    console.error('❌', e);
    process.exit(1);
  });
