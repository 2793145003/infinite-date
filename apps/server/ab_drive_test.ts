/**
 * 约会线「主动探索」离线 A/B 测试
 * 唯一变量：scene.actor 模板第 10 行「主动一点」段
 *   A 组 = scene.actor（现状，主动方向含糊）
 *   B 组 = scene.actor.ab（加了「向外探索对方」方向）
 * 复用生产 runActor 完整管线（角色卡、对话历史重建、guidedJson、重试），只换 input.templates.actor。
 */
import { runActor } from './src/lib/run-scene-turn';
import { buildCharacterCard } from './src/lib/character-card';

const PLAYER_ID = '__ab_test__'; // 无 fork → 读公共模板原版；LLM 走默认配置(vLLM)
const PLAYER_NAME = '星落';

const CHARS = [
  { id: '241603d6-8779-4ea3-b5c2-4d06b1c13735', name: '林溯' },
  { id: '29caba67-33ab-486a-bf58-6d083aae4761', name: '顾砚' },
  { id: 'ac06e969-ecd9-4114-a9e6-f4b057e83c1d', name: '冷惊尘' },
  { id: '04735903-8031-4abf-a288-0cb53361370d', name: '方知衡' },
];

const PLAYER_MESSAGES = [
  '今天天气不错啊。',
  '嗯。',
];

const BEAT_INTENT = '自然地推进此刻的互动，回应玩家刚才的话。'; // 与生产点名版 line 1065 一致
const HISTORY = '（一段环境旁白：两人在咖啡馆里坐下，阳光透过落地窗洒在木桌上，咖啡的香气若有若无。）';

function makeInput(actorTemplate: string, charId: string, charName: string, playerMessage: string) {
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
        character_card: buildCharacterCard(PLAYER_ID, charId),
        player_profile: `${PLAYER_NAME}，你的约会对象。`,
        player_description: '刚认识的陌生人',
        current_activity: '',
        chronicle_summary: '',
        retrieved_memories: '',
      },
    },
    current_time: '午后',
    player_id: PLAYER_ID,
    templates: { actor: actorTemplate },
  } as any;
}

async function runOne(charId: string, charName: string, playerMessage: string, actorTemplate: string) {
  const input = makeInput(actorTemplate, charId, charName, playerMessage);
  return runActor(input, charName, BEAT_INTENT, HISTORY, () => {});
}

async function main() {
  for (const ch of CHARS) {
    for (const pm of PLAYER_MESSAGES) {
      const a = await runOne(ch.id, ch.name, pm, 'scene.actor');
      const b = await runOne(ch.id, ch.name, pm, 'scene.actor.ab');
      console.log(`\n══════════════════════════════════════════`);
      console.log(`角色：${ch.name}｜玩家：「${pm}」`);
      console.log(`──────────────────────────────────────────`);
      console.log(`【A 组·现状】台词：`);
      for (const t of a.texts) console.log(`  · ${t}`);
      console.log(`  内心：${a.internal || '(无)'}`);
      console.log(`──────────────────────────────────────────`);
      console.log(`【B 组·向外探索】台词：`);
      for (const t of b.texts) console.log(`  · ${t}`);
      console.log(`  内心：${b.internal || '(无)'}`);
    }
  }
}

main()
  .then(() => console.log('\n✅ A/B 测试完成'))
  .catch((e) => {
    console.error('❌ 失败', e);
    process.exit(1);
  });
