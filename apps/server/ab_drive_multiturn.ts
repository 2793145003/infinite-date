/**
 * drive（内驱力）多轮 A/B：验证「往角色卡加『向外驱动方向』」能否让话题持续、关系推进。
 *   A 组 = 无 drive（现状）
 *   C 组 = 有 drive（手工草稿，仅验证机制，非替作者定稿）
 * 唯一变量：character_card 末尾是否拼接【你此刻真正想要的（内驱力）】。
 * 4 轮连续对话，玩家回复故意平淡，看角色能否持续推进话题而非每轮重启。
 */
import { runActor } from './src/lib/run-scene-turn';
import { buildCharacterCard } from './src/lib/character-card';

const PLAYER_ID = '__ab_test__';
const PLAYER_NAME = '星落';

// drive 草稿——严格从角色卡已有素材（player_relation/goals/background/likes/emotional_signals）提炼，
// 不发明新设定，仅用于验证「加 drive 字段」这条机制是否有效。
const DRIVES: Record<string, string> = {
  林溯:
    '你想把星落彻底变成属于你的人——不是强迫，而是不动声色地掌控这段关系的节奏：摸清她的底细、试探她的边界、让她一点点习惯并依赖你的存在。所以你不满足于表面寒暄，会不断把话题往她身上引、往更深处探，同时观察她的每一个反应。',
  顾砚:
    '你话不多，但你对她的在意是真的。你要主动把话题往前带——问她今天的状态、注意到她话里没说出口的情绪、分享你观察到的安静小事。你的方式温柔而不打扰，但你不让沉默冷场，不让这段相处变成两个人干坐着。',
  方知衡:
    '你想把星落拉进你的世界里——天文、摄影、你亲手做的食物，这些是你最珍视也最愿意分享的东西。你会抛出这些试探她的兴趣，也小心翼翼想知道她的世界，一点点缩短你们之间那层「安全距离」。你的推进克制而执着：不越界，但每一步都朝向她。',
  冷惊尘:
    '你被星落身上某种你看不透的东西吸引，想搞清她没对你展露的部分。你不擅长细腻的情感表达，所以你的关心是克制而审慎的：观察她的反应、试探她回避或含糊的地方，用你惯有的冷静，一点点逼近真相。你不满足于表面的回答。',
};

const CHARS = [
  { id: '29caba67-33ab-486a-bf58-6d083aae4761', name: '顾砚' },
];

// 玩家 4 轮回复：故意平淡、留白，把「推进」的责任交给角色。
const PLAYER_SEQ = ['今天天气不错啊。', '嗯，确实。', '你平时喜欢做些什么？', '这样啊，挺有意思的。'];

const BEAT_INTENT = '自然地推进此刻的互动，回应玩家刚才的话。';
const HISTORY0 = '（一段环境旁白：两人在咖啡馆里坐下，阳光透过落地窗洒在木桌上，咖啡的香气若有若无。）';

function makeInput(charId: string, charName: string, card: string, playerMessage: string) {
  return {
    scene: {
      player_name: PLAYER_NAME,
      player_message: playerMessage,
      location: '咖啡馆',
      location_desc: '安静的街角咖啡馆，午后的阳光斜斜地洒进来',
      scene_tone: '轻松日常的氛围',
      scene_rules: '',
      companions_raw: '',
      available_locations: '',
      time_elapsed: '',
      has_player_spoken: true,
    },
    actors: {
      [charName]: {
        character_id: charId,
        character_name: charName,
        character_card: card,
        player_profile: `${PLAYER_NAME}，你的约会对象。`,
        player_description: '刚认识的陌生人',
        current_activity: '',
        chronicle_summary: '',
        retrieved_memories: '',
      },
    },
    current_time: '午后',
    player_id: PLAYER_ID,
    templates: { actor: 'scene.actor' },
  } as any;
}

async function runMultiRound(charId: string, charName: string, withDrive: boolean) {
  let history = HISTORY0;
  let card = buildCharacterCard(PLAYER_ID, charId);
  if (withDrive) {
    card = card + '\n\n【你此刻真正想要的（内驱力）】\n' + DRIVES[charName];
  }
  const rounds: { player: string; char: string }[] = [];
  for (const pm of PLAYER_SEQ) {
    const input = makeInput(charId, charName, card, pm);
    const out = await runActor(input, charName, BEAT_INTENT, history, () => {});
    const texts = out.texts.join(' ');
    rounds.push({ player: pm, char: texts });
    history = `${history}\n${PLAYER_NAME}：${pm}\n${charName}：${texts}`;
  }
  return rounds;
}

async function main() {
  for (const ch of CHARS) {
    console.log(`\n══════════════════════════════════════════════════`);
    console.log(`角色：${ch.name}`);
    for (const [label, withDrive] of [
      ['A 组·无 drive', false],
      ['C 组·有 drive', true],
    ] as const) {
      console.log(`\n──────── ${label} ────────`);
      const rounds = await runMultiRound(ch.id, ch.name, withDrive);
      for (const [i, r] of rounds.entries()) {
        console.log(`  轮${i + 1} 玩家:「${r.player}」`);
        console.log(`       ${ch.name}：${r.char}`);
      }
    }
  }
}

main()
  .then(() => console.log('\n✅ 多轮 A/B 完成'))
  .catch((e) => {
    console.error('❌ 失败', e);
    process.exit(1);
  });
