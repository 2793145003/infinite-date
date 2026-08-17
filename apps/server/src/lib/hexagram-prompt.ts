/**
 * 卦象 → worldgen prompt 渲染层。
 *
 * 把 divination.ts 的查表结果翻译成 LLM 能读的叙事文本，注入任务世界生成 prompt：
 *   1. seed 拼接：玩家ID + 起卦时辰 + quest_type + 该玩家任务序号（确定性起卦）
 *   2. 卦象层：本卦(世界困境) / 变卦(目标态) / 互卦(暗线) / 动爻(转折扣子) / 解卦(主看) / 宜忌
 *   3. 纳甲层：六爻六亲 → 人物关系网 + 生克/冲合/旬空/回头克 → 戏剧张力
 *
 * 不做 LLM 调用，纯文本渲染。
 */
import {
  divinate,
  currentShichen,
  shiYingRelation,
  huiTouKe,
  chongHe,
  liuQinWangShuai,
  LIUQIN_CN,
  LIUSHEN_CN,
  type DivinationResult,
  type GuaSummary,
  type WangShuai,
} from './divination';

/** seed 拼接（含时辰）。确定性起卦：同玩家同时辰同任务序号 → 同卦。 */
export function buildDivinationSeed(
  playerId: string,
  questType: string,
  seq: number,
): { seed: string; shichen: string } {
  const shichen = currentShichen();
  const seed = `${playerId}|${shichen}|${questType}#${seq}`;
  return { seed, shichen };
}

/** 端到端起卦（供 mission generate/divine 调用）。date 默认今天。cast=玩家摇出的 6 爻背数（可选，玩家"灵"）。 */
export function castHexagram(
  playerId: string,
  questType: string,
  seq: number,
  opts?: { cast?: number[]; date?: string },
): DivinationResult {
  const { seed } = buildDivinationSeed(playerId, questType, seq);
  return divinate({ seed, date: opts?.date, cast: opts?.cast });
}

/** 宜忌：从 shaoyong 提炼（去掉傅佩荣分类段），fallback 到断易天机首句。 */
function yijiOf(g: GuaSummary): string {
  const base = g.shaoyong?.split('台湾国学大儒傅佩荣解')[0]?.trim();
  if (base) return base;
  return g.duanyitianshe?.split('\n')[0]?.trim() || '';
}

/** 六亲 → 降临身份（这个世界的人怎么看玩家/男主——他们是怎么被接进来的） */
const LIUQIN_DESCEND: Record<string, string> = {
  父母: '被某方势力或长辈托付/收养，视为上宾、继承人或信使',
  兄弟: '被某个同辈势力当自己人接纳，一起扛事',
  子孙: '被当成预言中能解厄的人召唤而来（救星/化解者）',
  妻财: '手里攥着这世界缺的关键之物，被各方求着留下',
  官鬼: '被官方/秩序当作能压制乱局的人请来，身份最重也最易被盯上',
};

/** 卦象层：本卦/宜忌/变卦/互卦/动爻/解卦 → 叙事文本 */
export function renderHexagramLayer(r: DivinationResult): string {
  const lines: string[] = [];
  lines.push(`本卦（世界困境）：${r.ben.guaXiang}（${r.ben.name}）——${r.ben.baihua || r.ben.guaCi}`);

  lines.push(`错卦（反面镜像）：${r.cuo.guaXiang}（${r.cuo.name}）——${r.cuo.baihua || r.cuo.guaCi}`);

  const yiji = yijiOf(r.ben);
  if (yiji) lines.push(`宜忌：${yiji}`);

  if (r.dong.length === 0) {
    lines.push(
      '变卦（目标态）：静卦（无动爻），本卦即变卦——变化不显于动爻，潜于六爻生克之间，目标态看【生克与冲合】。',
    );
  } else {
    lines.push(`变卦（目标态）：${r.bian.guaXiang}（${r.bian.name}）——${r.bian.baihua || r.bian.guaCi}`);
  }

  lines.push(`互卦（隐藏暗线）：${r.hu.guaXiang}（${r.hu.name}）——${r.hu.guaCi}`);

  if (r.dongYao.length) {
    const dongDesc = r.dongYao
      .map((y) => {
        const panYao = r.pan.yaoList.find((p) => p.position === y.position);
        const lq = panYao?.liuQin ?? '';
        const lqCn = lq ? `：${LIUQIN_CN[lq] ?? lq}` : '';
        return `第${y.position}爻（${lq}${lqCn}）动：${y.baihua || y.yaoCi}`.trim();
      })
      .join('\n  ');
    if (dongDesc) lines.push(`动爻（转折扣子）：\n  ${dongDesc}`);
    lines.push('动爻落在哪个六亲，这一局的剧情扣子就扣在哪个关系上：把转折落成这个关系里「谁和谁出了什么事」的具体人际变故，别只停在物件层面。');
  }

  lines.push(`解卦主看：${r.jie.kouzi} —— ${r.jie.content}`);
  return lines.join('\n');
}

/** 生克/冲合/旬空/回头克 → 戏剧张力提示 */
function renderDramaHints(r: DivinationResult): string[] {
  const { pan, bianPan, dong } = r;
  const out: string[] = [];

  // 世应生克
  const rel = shiYingRelation(pan);
  const relCn: Record<string, string> = {
    世生应: '世生应（你滋养/主动付出于他）',
    应生世: '应生世（他滋养/主动付出于你）',
    世克应: '世克应（你压制/掌控他）',
    应克世: '应克世（他压制/掌控你）',
    比和: '世应比和（你俩同气，平等并肩）',
  };
  out.push(`世应生克：${relCn[rel] ?? rel}`);

  // 世应冲合
  const shiYaoLine = pan.yaoList.find((y) => y.position === pan.shiYao)!;
  const yingYaoLine = pan.yaoList.find((y) => y.position === pan.yingYao)!;
  const ch = chongHe(shiYaoLine.naZhi, yingYaoLine.naZhi);
  if (ch === '冲') {
    out.push(`世应六冲：你俩纳支相冲（${shiYaoLine.naZhi}冲${yingYaoLine.naZhi}）——天生冲突、背道而驰，感情线带刺。`);
  } else if (ch === '合') {
    out.push(`世应六合：你俩纳支相合（${shiYaoLine.naZhi}合${yingYaoLine.naZhi}）——命运纠缠、天生一对，情感线最顺。`);
  }

  // 旬空
  const kongYao = pan.yaoList.filter((y) => y.kong);
  if (kongYao.length) {
    const kongDesc = kongYao
      .map((y) => `第${y.position}爻${y.liuQin}${y.shiYing ? `（${y.shiYing === '世' ? '世/玩家' : '应/男主'}）` : ''}`)
      .join('、');
    const kongNote = kongYao.some((y) => y.shiYing)
      ? '世应逢空，两人在这个世界的定位本就悬而未定。'
      : '';
    out.push(`旬空：${kongDesc} 空亡——所代表的角色/事物是虚的、落空的、时机未到。${kongNote}`);
  }

  // 回头克
  const ht = huiTouKe(pan, bianPan, dong);
  if (ht.length) {
    out.push(`回头克：第${ht.join('、')}爻动而变出的爻回头克它——事情反转、自食其果，表面解法正是陷阱。`);
  }

  return out;
}

/** 纳甲层：六爻六亲 → 人物关系网（给 LLM 生成世界 NPC 用）+ 生克冲合戏剧张力 */
export function renderNajiaLayer(r: DivinationResult): string {
  const { yaoList, shiYao, yingYao } = r.pan;
  const lines: string[] = [];

  // 世应
  const shiYaoLine = yaoList.find((y) => y.position === shiYao);
  const yingYaoLine = yaoList.find((y) => y.position === yingYao);
  if (shiYaoLine) {
    lines.push(`世爻（玩家方）：第${shiYao}爻 ${shiYaoLine.liuQin}${shiYaoLine.dong ? '（动）' : ''}${shiYaoLine.kong ? '（旬空）' : ''}`);
  }
  if (yingYaoLine) {
    lines.push(`应爻（男主——此行与你并肩的攻略对象）：第${yingYao}爻 ${yingYaoLine.liuQin}${yingYaoLine.dong ? '（动）' : ''}${yingYaoLine.kong ? '（旬空）' : ''}`);
  }

  // 降临身份：世爻/应爻六亲 → 玩家/男主在这个世界的降临身份（世界怎么看他们）
  if (shiYaoLine || yingYaoLine) {
    const jiLines: string[] = [];
    if (shiYaoLine) jiLines.push(`玩家（世爻 ${shiYaoLine.liuQin}）：${LIUQIN_DESCEND[shiYaoLine.liuQin] ?? shiYaoLine.liuQin}`);
    if (yingYaoLine) jiLines.push(`男主（应爻 ${yingYaoLine.liuQin}）：${LIUQIN_DESCEND[yingYaoLine.liuQin] ?? yingYaoLine.liuQin}`);
    lines.push(`降临身份（这个世界的人怎么看你们俩）：\n  ${jiLines.join('\n  ')}`);
  }

  // 六亲汇总（含位置）
  const byLiuqin = new Map<string, number[]>();
  for (const y of yaoList) {
    const arr = byLiuqin.get(y.liuQin) ?? [];
    arr.push(y.position);
    byLiuqin.set(y.liuQin, arr);
  }
  const order = ['官鬼', '妻财', '子孙', '父母', '兄弟'];
  for (const lq of order) {
    const pos = byLiuqin.get(lq);
    if (!pos) continue;
    const meaning = LIUQIN_CN[lq] ?? lq;
    const dongMark = pos.some((p) => yaoList.find((y) => y.position === p)?.dong) ? '（有动爻）' : '';
    const kongMark = pos.some((p) => yaoList.find((y) => y.position === p)?.kong) ? '（有旬空）' : '';
    lines.push(`${lq}（${meaning}）：第${pos.join('、')}爻${dongMark}${kongMark}`);
  }

  // 力量对比（旺衰生克）：月建/日辰五行 vs 爻五行 → 官鬼旺则对手强、子孙旺则有解
  const wsMap = liuQinWangShuai(r.pan, r.yueJian);
  const WANG_SHUAI_CN: Record<string, Record<WangShuai, string>> = {
    官鬼: { 旺: '对手势大、压得紧', 平: '对手势中', 衰: '对手势弱、外强中干' },
    子孙: { 旺: '有解，贵人得力', 平: '解力平平', 衰: '难解，贵人使不上劲' },
    妻财: { 旺: '所求之物要紧', 平: '所求平平', 衰: '所求之物轻' },
    父母: { 旺: '靠山硬、有背景', 平: '靠山平平', 衰: '靠山弱、无所凭依' },
    兄弟: { 旺: '同伴多、竞争也烈', 平: '同伴平平', 衰: '孤立无援' },
  };
  const wsOrder = ['官鬼', '子孙', '妻财', '父母', '兄弟'];
  const wsLines: string[] = [];
  for (const lq of wsOrder) {
    const ws = wsMap[lq];
    if (!ws) continue;
    wsLines.push(`${lq}${ws}——${WANG_SHUAI_CN[lq]?.[ws] ?? ''}`);
  }
  if (wsLines.length) lines.push(`力量对比（旺衰）：${wsLines.join('；')}`);

  // 六神（可选提示，供氛围参考）
  const liuShenUsed = new Set<string>();
  for (const y of yaoList) if (y.shiYing || y.dong) liuShenUsed.add(y.liuShen);
  if (liuShenUsed.size) {
    const shenDesc = [...liuShenUsed].map((s) => `${s}（${LIUSHEN_CN[s] ?? ''}）`).join('、');
    lines.push(`关键爻六神氛围：${shenDesc}`);
  }

  // 生克与冲合（戏剧张力）
  lines.push(...renderDramaHints(r));

  return lines.join('\n');
}
