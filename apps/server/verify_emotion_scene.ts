/**
 * 约会侧心绪端到端验证 —— 直接调生产 runActor（走真实模板 + schema + 解析）
 *
 * 验证三件事：
 *  ① 模板里新加的输出说明，能否让演员稳定给出 8 维心绪（且不被 2048 截断）
 *  ② 注入「角色级状态 + 时间衰减」得到的心绪后，台词是否真的随之改变（与短信侧同一位置：user 消息）
 *  ③ 抽到的心绪是否与注入值方向一致（连续性）
 *
 * 只读线上库（取角色卡素材），不写任何业务数据。
 * 用法：cd apps/server && npx tsx verify_emotion_scene.ts [--name=角色名]
 */
import { db } from './src/db';
import { loadCharacterData } from './src/lib/character';
import { buildCharacterCard } from './src/lib/character-card';
import { getPlayerProfile } from './src/prompt/builder';
import { runActor, type SceneTurnInput } from './src/lib/run-scene-turn';
import { emotionInjectionNote, EMOTION_KEYS, topEmotion } from './src/lib/emotion';
import type { EmotionScores } from '@idate/shared';

const argv = process.argv.slice(2);
const argVal = (k: string, d: string) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WANT = argVal('name', '');

function pickChar() {
  const threads = db
    .prepare(`SELECT DISTINCT character_id, player_id FROM message_threads WHERE character_id != 'DEITY'`)
    .all() as Array<{ character_id: string; player_id: string }>;
  for (const t of threads) {
    const cd = loadCharacterData(t.player_id, t.character_id);
    if (!cd) continue;
    if (WANT && cd.name !== WANT) continue;
    return { playerId: t.player_id, characterId: t.character_id, cd };
  }
  return null;
}

const ANGRY: EmotionScores = {
  joy: 5, desire: 10, panic: 10, loss: 40, grievance: 70, anger: 90, possessiveness: 60, tenderness: 0,
} as EmotionScores;

async function run(label: string, c: NonNullable<ReturnType<typeof pickChar>>, emotionState: string) {
  const name = c.cd.name || c.characterId;
  const conversationSoFar = ['玩家：你怎么了？', `${name}：没什么。`, '玩家：你刚才是不是生气了'].join('\n');
  const input: SceneTurnInput = {
    scene: {
      location: '海边的观景台',
      location_desc: '夜里没什么人的观景台，能听见浪声',
      scene_tone: '',
      scene_rules: '',
      companions: '',
      companions_raw: '',
      resident_npcs: '',
      scene_relations: '',
      player_descriptions: '',
      conversation_so_far: conversationSoFar,
      has_player_spoken: true,
      player_name: '知欣',
      player_message: '你刚才是不是生气了',
      max_beats: '1',
    },
    actors: {
      [name]: {
        character_id: c.characterId,
        character_name: name,
        character_card: buildCharacterCard(c.playerId, c.characterId),
        player_profile: getPlayerProfile(c.playerId),
        player_description: '恋人',
        current_activity: '和你并排靠在栏杆上看海',
        chronicle_summary: '',
        retrieved_memories: '',
        emotion_state: emotionState,
      },
    },
    player_id: c.playerId,
    current_time: '夜晚',
    has_player_turn_input: true,
  };

  console.log(`\n──────── ${label} ────────`);
  const t0 = Date.now();
  const out = await runActor(input, name, conversationSoFar, (s) => console.log(`   · ${s}`));
  const ms = Date.now() - t0;

  console.log(`  台词 ${out.texts.length} 条：${out.texts.join(' / ').slice(0, 110)}`);
  if (out.emotions) {
    const top = topEmotion(out.emotions);
    console.log(
      `  ✅ 心绪：${EMOTION_KEYS.map((k) => (out.emotions as unknown as Record<string, number>)[k]).join('/')} → 最强「${top.cn}」${top.value}`,
    );
  } else {
    console.log(`  ❌ 未拿到 emotions`);
  }
  console.log(`  （耗时 ${ms}ms）`);
  return out;
}

async function main() {
  console.log('=== 约会侧心绪端到端验证（生产 runActor，只读库）===');
  const before = (db.prepare('SELECT count(*) AS c FROM scene_messages').get() as { c: number }).c;

  const c = pickChar();
  if (!c) { console.error('没找到角色'); process.exit(1); }
  console.log(`角色：${c.cd.name}`);

  // ① 不注入（模板说明能否让它自己给出心绪）
  const plain = await run('① 不注入心绪', c, '');

  // ② 注入「愤怒 90」——同一段历史同一句话，只看注入带来的差异
  const injected = await run('② 注入 愤怒90（模拟刚从短信带过来的心绪）', c, emotionInjectionNote(ANGRY));

  const after = (db.prepare('SELECT count(*) AS c FROM scene_messages').get() as { c: number }).c;
  console.log(`\n=== 汇总 ===`);
  console.log(`模板自主输出心绪：${plain.emotions ? '✅ 是' : '❌ 否'}`);
  console.log(`注入后仍能输出心绪：${injected.emotions ? '✅ 是' : '❌ 否'}`);
  if (injected.emotions) {
    const t = topEmotion(injected.emotions);
    console.log(`注入的愤怒90 → 模型自评最强「${t.cn}」${t.value}（延续性看这里）`);
  }
  console.log(`台词是否随注入变化：${plain.texts.join() !== injected.texts.join() ? '✅ 变了' : '⚠️ 没变'}`);
  console.log(`scene_messages ${before} → ${after}　${before === after ? '✅ 未写入' : '⚠️ 有变化'}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
