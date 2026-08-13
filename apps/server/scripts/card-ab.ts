/**
 * 角色卡对比实验：旧版提炼 vs 新版提炼，同一 LLM 同一场景，看刻板印象差异
 */
import { loadCharacterData } from '../src/lib/character';
import { loadPrompt, renderPrompt } from '../src/prompt/loader';
import { chat } from '../src/llm/adapter';

const PLAYER = '00031c8f-097c-487b-b82b-dd73a37e4451';
const CHAR = '7631e492-f69b-4d31-b21f-aab7e4f9d785';

// ── 旧版：当前代码逻辑（含字段错位 bug + 只留 4 字段）──
function buildOld(data: any): string {
  const parts: string[] = [];
  const pick = (k: string) => data?.[k];
  if (pick('name')) parts.push(`名字：${pick('name')}`);
  if (pick('personality')) parts.push(`性格：${JSON.stringify(pick('personality'))}`);
  if (pick('speechStyle')) parts.push(`说话风格：${JSON.stringify(pick('speechStyle'))}`);
  if (pick('background')) parts.push(`背景：${JSON.stringify(pick('background'))}`);
  if (pick('likes') && Array.isArray(pick('likes'))) parts.push(`特质：${pick('likes').join('、')}`);
  return parts.join('\n');
}

// ── 新版：保留行为信号/台词范例/底线/弱点/癖好 ──
function buildNew(data: any): string {
  const P = data.personality || {};
  const S = data.speechStyle || {};
  const B = data.background || {};
  const E = data.emotional_signals || {};
  const lines: string[] = [];
  lines.push(`【角色】${data.name}`);
  if (data.appearance) lines.push(`【外貌】${String(data.appearance).replace('。身形匀称，在战斗时会表现出极强的爆发力与利落感。', '')}`);
  const pers = [P.surface, P.core, P.extreme].filter(Boolean).join('；');
  if (pers) lines.push(`【性格】${pers}`);
  const spk = [S.description, ...(S.examples || []).map((e: any) => `  · ${e.line}`)].filter(Boolean).join('\n');
  if (spk) lines.push(`【说话风格】${spk}`);
  const sigs = [E.nervous, E.happy, E.moved].filter(Boolean).join('；');
  if (sigs) lines.push(`【身体语言】${sigs}`);
  if (data.background) lines.push(`【背景】${[B.origin].filter(Boolean).join('')}`);
  if (data.boundaries) lines.push(`【底线】${data.boundaries}`);
  const like = Array.isArray(data.likes) ? data.likes.map((l: any) => String(l).split('（')[0]).join('、') : '';
  const dis = Array.isArray(data.dislikes) ? data.dislikes.map((d: any) => String(d).split('（')[0]).join('、') : '';
  if (like) lines.push(`【喜欢】${like}`);
  if (dis) lines.push(`【讨厌】${dis}`);
  if (data.quirks) lines.push(`【习惯】${data.quirks}`);
  if (data.ineptitudes) lines.push(`【弱点】${data.ineptitudes}`);
  if (data.goals) lines.push(`【目标】${data.goals}`);
  if (data.player_relation) lines.push(`【关系】${data.player_relation}`);
  return lines.join('\n');
}

const SCENE = `现在你在一家安静的咖啡馆，对面的少女是你刚认识的一个人。她突然提出：\"以后每天都要请你喝咖啡，你要是不来我就一直等你。\"这个请求有点越界和突然。请以你的性格和底线自然回应——是拒绝、撒娇、还是别的，都要符合你这个人，不要把话说得又软又圆滑。`;

// ── 完整版：全部 18 字段原样 JSON 塞进去（对照组）──
function buildFull(data: any): string {
  return JSON.stringify(data, null, 2);
}

async function run(label: string, system: string) {
  const tpl = loadPrompt('scene.actor');
  const sys = renderPrompt(tpl, {
    character_name: '沈星回',
    character_card: system,
    player_profile: '性别：女',
    player_description: '刚认识的陌生人',
    chronicle_summary: '',
    retrieved_memories: '',
    current_time: '',
    location: '街角咖啡馆',
    conversation_so_far: '玩家：以后每天都要请你喝咖啡，你要是不来我就一直等你。',
    beat_intent: '回应这个有些越界的请求，按你的性格和底线自然应对，不要圆滑讨好',
  });
  const res = await chat(
    [{ role: 'system', content: sys }, { role: 'user', content: '请输出你的这一句表演。' }],
    { temperature: 0.85, maxTokens: 260 },
  );
  // 提取 text + internal
  const m = res.content.match(/"(?:text|internal)"\s*:\s*"([^"]*)"/g) || [];
  console.log(`\n——【${label}】——`);
  for (const mm of m.slice(0, 2)) console.log('  ' + mm);
}

const data = loadCharacterData(PLAYER, CHAR)!;
const oldCard = buildOld(data);
const newCard = buildNew(data);
const fullCard = buildFull(data);

console.log('┌────────────────────────────────────────┐');
console.log('│  现场先看两版卡片各自的样子            │');
console.log('└────────────────────────────────────────┘');
console.log('\n◼ 旧版卡片全文:');
console.log(oldCard);
console.log('\n◼ 新版卡片全文:');
console.log(newCard);

await run('新版卡片', newCard);
await run('完整版卡片', fullCard);
await run('新版卡片(2nd)', newCard);
await run('完整版卡片(2nd)', fullCard);
await run('新版卡片(3rd)', newCard);
await run('完整版卡片(3rd)', fullCard);
