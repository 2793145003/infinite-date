/**
 * 温馨向 NPC 任务 worldgen 渲染辅助。
 * 从 experiment-worldgen-cozy.ts 抽到生产：八卦类象池 + 温馨化标签/玩法映射。
 * 类象层：每个单卦从「万物属类意象池」用 seed 确定性抽 2 个意象喂 LLM。
 */
import { createHash } from 'node:crypto';
import { loadHexagrams, type DivinationResult } from './divination';

/** 每个卦的意象池：人物/动物/静物/屋舍/饮食/人事/色，古代象 + 现代象混在一起 */
export const BAGUA_POOL: Record<string, string[]> = {
  乾: ['君父', '老人', '长者', '官宦', '马', '天鹅', '狮', '象', '金玉', '宝珠', '圆物', '镜', '冠', '硬币', '钥匙', '手表', '手机', '车', '眼镜', '楼台', '高堂', '大厦', '写字楼', '酒店', '礼堂', '水果', '辛辣', '刚健', '果决', '多动', '赤', '玄'],
  坤: ['老母', '后母', '农夫', '乡人', '牛', '牝马', '百兽', '方物', '柔物', '布帛', '五谷', '瓦器', '盒子', '收纳箱', '衣物', '被子', '米面', '锅', '罐', '村居', '田舍', '矮屋', '仓库', '平房', '院子', '甘味', '芋笋', '柔顺', '众多', '黄', '黑'],
  震: ['长男', '龙', '蛇', '木竹', '竹木乐器', '花草', '木制品', '音响', '耳机', '盆栽', '运动器材', '山林', '楼阁', '鲜肉', '菜蔬', '果酸', '起动', '多动', '虚惊', '青', '绿', '碧'],
  巽: ['长女', '秀士', '鸡', '百禽', '虫', '绳', '直物', '长物', '竹木', '工巧器', '笔', '线绳', '尺', '木梳', '香水', '手工艺品', '寺观', '楼台', '山林居', '鸡肉', '蔬果酸', '柔和', '不定', '进退', '青', '绿', '白'],
  坎: ['中男', '江湖人', '舟人', '猪', '鱼', '弓轮', '酒器', '水具', '带核物', '饮料', '水瓶', '水杯', '壶', '雨具', '鱼缸', '车', '水管', '近水', '水阁', '江楼', '酒', '海味', '冷味', '险陷', '漂泊', '外柔', '黑'],
  离: ['中女', '文人', '雉', '龟', '蟹', '螺蚌', '书', '文', '干燥物', '赤色物', '课本', '文件', '证件', '屏幕', '灯', '数码', '灶具', '阳明宅', '明窗', '煎炒', '烧炙', '热肉', '聪明', '才学', '赤', '紫', '红'],
  艮: ['少男', '闲人', '山人', '虎', '狗', '鼠', '百兽', '土石', '瓜果', '黄物', '土中物', '石头', '盆景', '土豆', '红薯', '坚果', '宠物狗', '仓鼠', '山居', '近石', '近路', '野味', '竹笋', '守静', '阻隔', '进退', '黄'],
  兑: ['少女', '歌手', '主播', '羊', '泽中物', '金刀', '乐器', '缺器', '耳机', '麦克风', '音箱', '刀剪', '杯碗', '近泽', '水边', '老房子', '羊肉', '辛辣', '喜悦', '口', '言笑', '白'],
};

/** 玩法温馨化映射：战斗去暴力化 + 其他玩法轻量化 */
export const GOAL_COZY: Record<string, string> = {
  战斗: '动手出力的小事（教人/陪练/锻炼/除虫害/驱赶捣乱小动物）',
  寻物: '找走丢的人或物',
  破案: '小谜题/失物',
  和解: '说和',
  守护: '照看/陪伴',
};

/** 卦象层标签温馨化：本卦（世界困境）→ 本卦（需要帮忙的小事）等 */
export function cozyHexLayer(hex: string): string {
  return hex
    .replace(/本卦（世界困境）/g, '本卦（需要帮忙的小事）')
    .replace(/错卦（反面镜像）/g, '错卦（小事背后的另一面）')
    .replace(/变卦（目标态）/g, '变卦（办成后的样子）')
    .replace(/互卦（隐藏暗线）/g, '互卦（温馨小插曲）')
    .replace(/动爻（转折扣子）/g, '动爻（事情的关键扣子）');
}

/** 确定性抽签：seed + salt → sha256 链 → 从池里抽 n 个不重复 */
export function pickFromPool(seed: string, salt: string, pool: string[], n: number): string[] {
  const result: string[] = [];
  const available = [...pool];
  let h = createHash('sha256').update(`${seed}|${salt}`).digest('hex');
  for (let i = 0; i < n && available.length > 0; i++) {
    h = createHash('sha256').update(h).digest('hex');
    const idx = parseInt(h.slice(0, 8), 16) % available.length;
    result.push(available.splice(idx, 1)[0]!);
  }
  return result;
}

const _hexagrams = loadHexagrams();
function shangXiaOf(name: string): string {
  return _hexagrams.find((g) => g.name === name)?.shang_xia ?? '';
}

/** 八卦类象层（roll版）：本卦/变卦/互卦上下单卦，各抽 2 个意象 */
export function renderBaguaXiangLayer(div: DivinationResult): string {
  const seed = div.seed;
  const lines: string[] = [];
  const parts: [string, { name: string; guaXiang: string }][] = [
    ['本卦', div.ben],
    ['变卦', div.bian],
    ['互卦', div.hu],
  ];
  for (const [label, g] of parts) {
    if (label === '变卦' && div.dong.length === 0) continue; // 静卦无变卦
    const sx = shangXiaOf(g.name);
    const m = /^(.+)上(.+)下$/.exec(sx);
    if (!m) {
      lines.push(`${label} ${g.name}（${g.guaXiang}）`);
      continue;
    }
    const shang = m[1]!;
    const xia = m[2]!;
    const sp = pickFromPool(seed, `${label}-上-${shang}`, BAGUA_POOL[shang] ?? [], 2);
    const xp = pickFromPool(seed, `${label}-下-${xia}`, BAGUA_POOL[xia] ?? [], 2);
    lines.push(`${label} ${g.name}（${shang}上${xia}下）：${shang}取「${sp.join('、')}」；${xia}取「${xp.join('、')}」`);
  }
  return lines.join('\n');
}

/** 温馨化玩法引导（替代世界任务的 renderGoalGuide） */
export function cozyGoalGuide(goal: string): string {
  const cozy = GOAL_COZY[goal] ?? goal;
  return [
    `【任务目标】这一局的任务玩法已定为「${goal}」，温馨化为「${cozy}」：写一件轻松、可帮可不帮的小事，让邀请 NPC 和玩家用这个玩法去办成。`,
    `mission_goal 就写成「${cozy}——具体目标」，不要改换玩法。`,
  ].join('\n');
}
