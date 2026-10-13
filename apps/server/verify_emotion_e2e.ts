/**
 * 心绪端到端验证 —— 走**生产代码路径**（buildSystemPrompt + generateReply + normalizeReply），
 * 用线上真实历史，只读库、不写任何业务数据。
 *
 * 与 verify_emotion_*.ts 的区别：那些是自己拼 fetch 做机制实验；
 * 这个验证的是「改完生产代码之后，真实调用链能否拿到心绪」，含：
 *   ① 短信路径（emotionsEnabled=true）能否稳定拿到 emotions 并被 normalizeReply 保留
 *   ② 台词是否仍然正常（长度/复述/JSON 碎片）
 *   ③ 连续两轮：第二轮注入上一轮心绪（惯性+衰减）后，心绪是否连贯且仍能解析
 *
 * 用法：cd apps/server && npx tsx verify_emotion_e2e.ts --n=3
 */
import { db } from './src/db';
import { loadCharacterData } from './src/lib/character';
import { buildSystemPrompt, buildMessages, generateReply, getHubLocationsText, getPlayerProfile, type PromptContext } from './src/prompt/builder';
import { buildEmotionInjection, decayEmotions, emotionInjectionNote, topEmotion, EMOTION_KEYS } from './src/lib/emotion';
import type { EmotionScores } from '@idate/shared';
import { genId, now } from './src/lib/util';

const argv = process.argv.slice(2);
const argVal = (k: string, d: string) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const N = Number(argVal('n', '3'));

interface Sample {
  characterId: string; playerId: string; name: string; threadId: string;
  history: { role: 'player' | 'assistant'; text: string }[];
  inputs: string[];
}

function pickSamples(n: number): Sample[] {
  const threads = db.prepare(
    `SELECT t.id AS thread_id, t.character_id, t.player_id,
            (SELECT count(*) FROM text_messages m WHERE m.thread_id = t.id AND m.body != '') AS n
     FROM message_threads t WHERE t.character_id != 'DEITY' ORDER BY n DESC LIMIT 60`,
  ).all() as Array<{ thread_id: string; character_id: string; player_id: string; n: number }>;
  const out: Sample[] = [];
  for (const t of threads) {
    if (out.length >= n) continue;
    const rows = db.prepare(
      `SELECT sender, body FROM text_messages WHERE thread_id = ? AND body != '' ORDER BY created_at DESC, rowid DESC LIMIT 30`,
    ).all(t.thread_id) as Array<{ sender: string; body: string }>;
    if (rows.length < 8) continue;
    const cd = loadCharacterData(t.player_id, t.character_id);
    if (!cd) continue;
    // 取最后两条「玩家消息」（相隔一轮），第一条当首轮输入，第二条当续轮输入
    const players: number[] = [];
    for (let i = 0; i < rows.length; i++) if (rows[i]!.sender === 'player') players.push(i);
    if (players.length < 2) continue;
    const [i2, i1] = [players[0]!, players[1]!]; // 倒序：players[0] 最新
    const history = rows.slice(i1 + 1, Math.min(i1 + 9, rows.length)).reverse()
      .map((r) => ({ role: (r.sender === 'player' ? 'player' : 'assistant') as 'player' | 'assistant', text: r.body }));
    out.push({
      characterId: t.character_id, playerId: t.player_id, name: cd.name || t.character_id, threadId: t.thread_id,
      history, inputs: [rows[i1]!.body, rows[i2]!.body],
    });
  }
  return out;
}

function reportEmotion(tag: string, e: EmotionScores | undefined) {
  if (!e) {
    console.log(`      ${tag} ❌ 未拿到 emotions`);
    return false;
  }
  const t = topEmotion(e);
  console.log(`      ${tag} ✅ ${EMOTION_KEYS.map((k) => `${(e as unknown as Record<string, number>)[k]}`).join('/')} → 最强「${t.cn}」${t.value}`);
  return true;
}

async function main() {
  console.log('=== 心绪端到端验证（生产代码路径，只读线上库）===');
  const before = (db.prepare('SELECT count(*) AS c FROM text_messages').get() as { c: number }).c;
  const samples = pickSamples(N);
  if (!samples.length) { console.error('没抽到样本'); process.exit(1); }

  let ok = 0, total = 0;
  for (const s of samples) {
    const cd = loadCharacterData(s.playerId, s.characterId)!;
    const mkCtx = (note?: string): PromptContext => ({
      characterData: cd,
      playerDescription: '（端到端验证）',
      playerProfile: getPlayerProfile(s.playerId),
      chronicleSummary: '',
      recentMessages: [],
      isTextMessage: true,
      isDeity: false,
      locationName: '（短信中无法确定位置）',
      hubLocations: getHubLocationsText(),
      retrievedMemories: null,
      emotionsEnabled: true,
      ...(note ? { situationalNote: note } : {}),
    });

    console.log(`\n──────── ${s.name} ────────`);
    console.log(`  首轮玩家输入：${s.inputs[0]!.slice(0, 50)}`);

    // ── 第 1 轮：无历史心绪（新功能上线后的真实首轮情形）
    const ctx1 = mkCtx();
    ctx1.recentMessages = s.history;
    const r1 = await generateReply(buildMessages(buildSystemPrompt(ctx1), ctx1.recentMessages, s.inputs[0]!), {
      temperature: 0.85, maxTokens: 1024, playerId: s.playerId,
    });
    total++;
    if (reportEmotion('首轮', r1.emotions)) ok++;
    console.log(`      台词 ${r1.messages.length} 条：${r1.messages.join(' / ').slice(0, 90)}`);

    // ── 第 2 轮：把上一轮心绪（衰减后）注入当前 user 消息 —— 验证惯性链路
    if (r1.emotions) {
      const decayed = decayEmotions(r1.emotions);
      const injection = emotionInjectionNote(decayed);
      const ctx2 = mkCtx();
      ctx2.recentMessages = [
        ...s.history,
        { role: 'player' as const, text: s.inputs[0]! },
        { role: 'assistant' as const, text: r1.messages.join('\n') },
      ];
      const r2 = await generateReply(
        buildMessages(buildSystemPrompt(ctx2), ctx2.recentMessages, `${injection}\n${s.inputs[1]!}`),
        { temperature: 0.85, maxTokens: 1024, playerId: s.playerId },
      );
      total++;
      if (reportEmotion('续轮', r2.emotions)) ok++;
      console.log(`      玩家续：${s.inputs[1]!.slice(0, 40)}`);
      console.log(`      台词 ${r2.messages.length} 条：${r2.messages.join(' / ').slice(0, 90)}`);
      if (r2.emotions && r1.emotions) {
        const d = EMOTION_KEYS.reduce((acc, k) => acc + Math.abs((r2.emotions as unknown as Record<string, number>)[k]! - (decayed as unknown as Record<string, number>)[k]!), 0);
        console.log(`      与注入态的总偏移 ${d}（0=完全照搬，越大越说明在按语境演化）`);
      }
    }

    // 展示真实注入文本（上线后模型实际看到的内容）
    if (process.env.SHOW_INJECTION) {
      console.log(`      [注入样例] ${emotionInjectionNote(decayEmotions(r1.emotions ?? (Object.fromEntries(EMOTION_KEYS.map((k) => [k, 60])) as unknown as EmotionScores))).slice(0, 200)}`);
    }
  }

  const after = (db.prepare('SELECT count(*) AS c FROM text_messages').get() as { c: number }).c;
  console.log(`\n=== 结果 ===`);
  console.log(`心绪链路：${ok}/${total} 次拿到合法 emotions`);
  console.log(`只读自检：text_messages ${before} → ${after}　${before === after ? '✅ 未写入' : '⚠️ 有变化'}`);
  console.log(`（本次调用会写 llm_call_log 调用日志表，属预期）`);
  process.exit(ok === total && before === after ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
