/**
 * 卦象系统（divination）：摇卦 → 纳甲排盘 → 推演(变卦/互卦) → 解卦 → 白话映射。
 *
 * 纯查表 + 60 甲子 mod，不调 LLM、不爬数据。全部口径照搬 scripts/najia.py 与
 * scripts/qi_gua.py，仅两处差异（有意为之）：
 *   1. 摇卦随机源：Python 用 random.Random(seed)（MT19937），TS 用 sha256 派生——
 *      同 seed 结果确定、分布仍为二项 B(3,½)（动爻概率 1/4），但不与 Python 逐位一致。
 *   2. 日干支/时辰用 UTC 换算北京时间，不依赖 process.env.TZ 是否已设。
 *
 * 数据源：data/hexagrams/_all.json（64 卦资产）。路径由 HEXAGRAMS_FILE 覆盖，
 * 默认从 cwd（apps/server）上两级到项目根 data/hexagrams/_all.json。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ═══════════════════════════ 静态查表（照搬 najia.py / qi_gua.py）═══════════════════════════

/** 先天八卦（三爻，从下到上 1=阳 0=阴） */
const TRIGRAM: Record<string, [number, number, number]> = {
  乾: [1, 1, 1], 兑: [1, 1, 0], 离: [1, 0, 1], 震: [1, 0, 0],
  巽: [0, 1, 1], 坎: [0, 1, 0], 艮: [0, 0, 1], 坤: [0, 0, 0],
};
const TRIGRAM_REV: Record<string, string> = Object.fromEntries(
  Object.entries(TRIGRAM).map(([k, v]) => [v.join(','), k]),
);

/** 纳甲歌：六爻纳支（内卦三爻 / 外卦三爻，初爻→上爻） */
const NAZHI: Record<string, string[]> = {
  乾: ['子', '寅', '辰', '午', '申', '戌'],
  坎: ['寅', '辰', '午', '申', '戌', '子'],
  艮: ['辰', '午', '申', '戌', '子', '寅'],
  震: ['子', '寅', '辰', '午', '申', '戌'],
  巽: ['丑', '亥', '酉', '未', '巳', '卯'],
  离: ['卯', '丑', '亥', '酉', '未', '巳'],
  坤: ['未', '巳', '卯', '丑', '亥', '酉'],
  兑: ['巳', '卯', '丑', '亥', '酉', '未'],
};

/** 地支五行 */
const ZHI_WUXING: Record<string, string> = {
  子: '水', 亥: '水', 寅: '木', 卯: '木',
  巳: '火', 午: '火', 申: '金', 酉: '金',
  辰: '土', 戌: '土', 丑: '土', 未: '土',
};

/** 八宫卦序 + 卦宫五行（每宫 8 卦：本宫/一世/二世/三世/四世/五世/游魂/归魂） */
const PALACE: Record<string, { wuxing: string; gua: string[] }> = {
  乾: { wuxing: '金', gua: ['乾', '姤', '遁', '否', '观', '剥', '晋', '大有'] },
  兑: { wuxing: '金', gua: ['兑', '困', '萃', '咸', '蹇', '谦', '小过', '归妹'] },
  离: { wuxing: '火', gua: ['离', '旅', '鼎', '未济', '蒙', '涣', '讼', '同人'] },
  震: { wuxing: '木', gua: ['震', '豫', '解', '恒', '升', '井', '大过', '随'] },
  巽: { wuxing: '木', gua: ['巽', '小畜', '家人', '益', '无妄', '噬嗑', '颐', '蛊'] },
  坎: { wuxing: '水', gua: ['坎', '节', '屯', '既济', '革', '丰', '明夷', '师'] },
  艮: { wuxing: '土', gua: ['艮', '贲', '大畜', '损', '睽', '履', '中孚', '渐'] },
  坤: { wuxing: '土', gua: ['坤', '复', '临', '泰', '大壮', '夬', '需', '比'] },
};

/** 世爻位置（按宫序：本宫/一世/二世/三世/四世/五世/游魂/归魂） */
const SHI_POS = [6, 1, 2, 3, 4, 5, 4, 3];

/** 六神（日干 → 初爻起神，按固定顺序排到上爻） */
const LIUSHEN_ORDER = ['青龙', '朱雀', '勾陈', '腾蛇', '白虎', '玄武'];
const LIUSHEN_START: Record<string, string> = {
  甲: '青龙', 乙: '青龙', 丙: '朱雀', 丁: '朱雀',
  戊: '勾陈', 己: '腾蛇', 庚: '白虎', 辛: '白虎',
  壬: '玄武', 癸: '玄武',
};

/** 六神叙事释义（给 LLM 翻译用） */
const LIUSHEN_MEANING: Record<string, string> = {
  青龙: '吉庆、喜事、东方木、顺遂',
  朱雀: '口舌、文书、南方火、言语是非',
  勾陈: '田土、迟滞、中央土、牵连拖延',
  腾蛇: '忧思、虚惊、中央土、缠绕不安',
  白虎: '刑伤、凶险、西方金、冲突',
  玄武: '暗昧、盗贼、北方水、隐秘暧昧',
};

/** 六亲叙事释义（给 LLM 翻译） */
const LIUQIN_MEANING: Record<string, string> = {
  父母: '靠山、庇护、长辈、文书、房屋',
  兄弟: '同伴、竞争者、同辈、朋友',
  子孙: '解厄贵人、福神、晚辈、医术、化解之力',
  妻财: '所求之物、资源、财富、情感对象',
  官鬼: '对手、压力、不信任、困境、官非',
};

/** 六亲定名：生我父母、我生子孙、克我官鬼、我克妻财、同我兄弟 */
const WUXING_SHENG: Record<string, string> = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
const WUXING_KE: Record<string, string> = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };

/** 地支六冲（冲突分离） */
const LIUCHONG: [string, string][] = [
  ['子', '午'], ['丑', '未'], ['寅', '申'], ['卯', '酉'], ['辰', '戌'], ['巳', '亥'],
];
/** 地支六合（结合纠缠） */
const LIUHE: [string, string][] = [
  ['子', '丑'], ['寅', '亥'], ['卯', '戌'], ['辰', '酉'], ['巳', '申'], ['午', '未'],
];

const TIANGAN = '甲乙丙丁戊己庚辛壬癸'.split('');
const DIZHI = '子丑寅卯辰巳午未申酉戌亥'.split('');
/** 60 甲子表（纪日） */
const JIAZI: string[] = Array.from({ length: 60 }, (_, i) => TIANGAN[i % 10]! + DIZHI[i % 12]!);

/** 十二时辰（序号 1-12），子时 23:00-01:00 */
const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const POS_NAME = ['初', '二', '三', '四', '五', '上'];

// ═══════════════════════════ 类型 ═══════════════════════════

export interface Hexagram {
  index: number;
  name: string;        // 乾
  gua_xiang: string;   // 乾为天
  shang_xia: string;   // 乾上乾下
  gua_ci: string;
  xiang_yue: string;
  baihua: string;
  duanyitianshe: string;
  shaoyong: string;
  philosophy: string;
  yao: Array<{
    position: string;
    yao_ci: string;
    xiang_yue: string;
    baihua: string;
    shaoyong: string;
    philosophy: string;
  }>;
  /** 卦际关系：ben=本卦自身、hu=互卦、cuo=错卦（旁通，每爻取反）、zong=综卦（覆卦，上下颠倒） */
  relations?: {
    ben?: { index: number; name: string; source?: string };
    hu?: { index: number; name: string; source?: string };
    cuo?: { index: number; name: string; source?: string };
    zong?: { index: number; name: string; source?: string };
  };
}

export interface GuaSummary {
  index: number;
  name: string;
  guaXiang: string;
  guaCi: string;
  baihua: string;
  duanyitianshe: string;
  shaoyong: string;
  philosophy: string;
}

export interface DongYao {
  position: number;      // 1-6
  positionName: string;  // 初九
  yaoCi: string;
  baihua: string;
  shaoyong: string;
}

export interface NajiaYao {
  position: number;   // 1-6
  naZhi: string;      // 纳支
  wuXing: string;     // 五行
  liuQin: string;     // 六亲
  liuShen: string;    // 六神
  shiYing: '' | '世' | '应';
  dong: boolean;
  kong: boolean;      // 旬空（空亡）
}

export interface Pan {
  palace: string;        // 卦宫
  palaceWuXing: string;  // 宫五行
  shiYao: number;        // 世爻位置
  yingYao: number;       // 应爻位置
  dayGanZhi: string;     // 日干支
  yaoList: NajiaYao[];
}

export interface Jie {
  dongCount: number;
  kouzi: string;   // 解卦规则选出的扣子（看什么）
  content: string; // 扣子内容（爻辞/卦辞）
}

export interface DivinationResult {
  seed: string;
  shichen: string;
  dayGanZhi: string;
  yueJian: string;   // 月建地支（旺衰用）
  lines: number[];    // 六爻阴阳 [0阴1阳，初→上]
  dong: number[];     // 动爻位 [1-6]
  dongYao: DongYao[]; // 动爻的爻辞详情
  ben: GuaSummary;
  bian: GuaSummary;
  hu: GuaSummary;
  cuo: GuaSummary; // 错卦（旁通卦，本卦每爻取反）——反面镜像
  pan: Pan;
  bianPan: Pan;
  jie: Jie;
}

// ═══════════════════════════ 数据加载 ═══════════════════════════

const HEXAGRAMS_FILE =
  process.env.HEXAGRAMS_FILE || path.resolve(process.cwd(), '../../data/hexagrams/_all.json');

let hexagramCache: Hexagram[] | null = null;

export function loadHexagrams(): Hexagram[] {
  if (hexagramCache) return hexagramCache;
  const raw = fs.readFileSync(HEXAGRAMS_FILE, 'utf-8');
  hexagramCache = JSON.parse(raw) as Hexagram[];
  return hexagramCache;
}

/** shang_xia（"乾上乾下"）→ key（下卦,上卦）→ 卦 */
export function buildPairs(hexagrams: Hexagram[]): Map<string, Hexagram> {
  const m = new Map<string, Hexagram>();
  for (const g of hexagrams) {
    const mm = /^(.+)上(.+)下$/.exec(g.shang_xia);
    if (mm) m.set(`${mm[2]!}|${mm[1]!}`, g);
  }
  return m;
}

// ═══════════════════════════ 摇卦 ═══════════════════════════

export interface YaoDetail {
  backs: number;
  symbol: string;
}

/**
 * 单爻：三枚铜钱的"背"数(0-3) → 阴阳 + 是否动爻 + 记法。
 * 约定：背=阳、字=阴。三背=9 老阳○(动)、两背=8 少阴、一背=7 少阳、三字=6 老阴×(动)。
 */
export function yaoFromBacks(backs: number): { line: number; dong: boolean; symbol: string } {
  if (backs === 3) return { line: 1, dong: true, symbol: '9 老阳 ○（动）' };
  if (backs === 2) return { line: 0, dong: false, symbol: '8 少阴' };
  if (backs === 1) return { line: 1, dong: false, symbol: '7 少阳' };
  return { line: 0, dong: true, symbol: '6 老阴 ×（动）' };
}

/**
 * 摇卦：三枚铜钱掷六次（从下往上定六爻）。
 * 随机源：sha256(seed|yao{i}) 派生三枚铜钱的正反，确定性可复现。
 */
export function yaoGua(seed: string): { lines: number[]; dong: number[]; detail: YaoDetail[] } {
  const lines: number[] = [];
  const dong: number[] = [];
  const detail: YaoDetail[] = [];
  for (let i = 1; i <= 6; i++) {
    const h = createHash('sha256').update(`${seed}|yao${i}`).digest();
    let backs = 0;
    for (let c = 0; c < 3; c++) backs += h[c]! & 1;
    const { line, dong: isDong, symbol } = yaoFromBacks(backs);
    if (isDong) dong.push(i);
    lines.push(line);
    detail.push({ backs, symbol });
  }
  return { lines, dong, detail };
}

// ═══════════════════════════ 推演 ═══════════════════════════

/** 六爻阴阳 → 卦（用 pairs[(下卦,上卦)] 反查） */
export function linesToGua(
  lines: number[],
  pairs: Map<string, Hexagram>,
): { gua: Hexagram; xia: string; shang: string } {
  const xia = TRIGRAM_REV[lines.slice(0, 3).join(',')]!;
  const shang = TRIGRAM_REV[lines.slice(3, 6).join(',')]!;
  const gua = pairs.get(`${xia}|${shang}`);
  if (!gua) throw new Error(`上下卦无对应：${xia}下${shang}上`);
  return { gua, xia, shang };
}

// ═══════════════════════════ 纳甲排盘 ═══════════════════════════

/** 日期（YYYY-MM-DD）→ 日干支。以 2024-01-01 为甲子日基准，mod 60。 */
export function ganZhiOfDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = Date.UTC(2024, 0, 1);
  const target = Date.UTC(y!, m! - 1, d!);
  const delta = Math.floor((target - base) / 86400000);
  return JIAZI[((delta % 60) + 60) % 60]!;
}

/** 月建（月令）：以 12 节气（节，非中气）近似日期定月，返回月建地支。误差 ≤1 天，对旺衰用途足够。 */
export function yueJianOfDay(dateStr: string): string {
  const md = dateStr.slice(5, 10); // 'MM-DD'
  if (md >= '02-04' && md < '03-06') return '寅'; // 立春
  if (md >= '03-06' && md < '04-05') return '卯'; // 惊蛰
  if (md >= '04-05' && md < '05-06') return '辰'; // 清明
  if (md >= '05-06' && md < '06-06') return '巳'; // 立夏
  if (md >= '06-06' && md < '07-07') return '午'; // 芒种
  if (md >= '07-07' && md < '08-08') return '未'; // 小暑
  if (md >= '08-08' && md < '09-08') return '申'; // 立秋
  if (md >= '09-08' && md < '10-08') return '酉'; // 白露
  if (md >= '10-08' && md < '11-07') return '戌'; // 寒露
  if (md >= '11-07' && md < '12-07') return '亥'; // 立冬
  if (md >= '12-07' || md < '01-06') return '子'; // 大雪（跨年）
  return '丑'; // 小寒（01-06 ~ 02-03）
}

/** 旬空（空亡）：日干支所在旬，轮空的两个地支。落在空亡地支上的爻=「空」，代表虚、未落地、时机未到。 */
export function kongWangOfDay(dayGanZhi: string): [string, string] {
  const ganIdx = TIANGAN.indexOf(dayGanZhi[0]!);
  const zhiIdx = DIZHI.indexOf(dayGanZhi[1]!);
  const xunShouIdx = ((zhiIdx - ganIdx) % 12 + 12) % 12;
  return [DIZHI[(xunShouIdx - 2 + 12) % 12]!, DIZHI[(xunShouIdx - 1 + 12) % 12]!];
}

/** 两地支的冲/合关系。冲=冲突分离，合=结合纠缠。 */
export function chongHe(a: string, b: string): '冲' | '合' | '' {
  for (const [x, y] of LIUCHONG) if ((a === x && b === y) || (a === y && b === x)) return '冲';
  for (const [x, y] of LIUHE) if ((a === x && b === y) || (a === y && b === x)) return '合';
  return '';
}

/** 卦名 → (宫名, 宫五行, 世序位 index) */
function palaceOf(guaName: string): { palace: string; wuxing: string; idx: number } {
  for (const [pname, p] of Object.entries(PALACE)) {
    const idx = p.gua.indexOf(guaName);
    if (idx >= 0) return { palace: pname, wuxing: p.wuxing, idx };
  }
  throw new Error(`卦不在八宫：${guaName}`);
}

/**
 * 排盘。ben 需含 name/shang_xia；dong=动爻位列表(1-6)；dayGanZhi=日干支。
 * 返回六爻各爻的 {纳支, 五行, 六亲, 六神, 世/应, 是否动}。
 */
export function najiaPan(ben: { name: string; shang_xia: string }, dong: number[], dayGanZhi: string): Pan {
  const mm = /^(.+)上(.+)下$/.exec(ben.shang_xia);
  if (!mm) throw new Error(`shang_xia 无法解析：${ben.shang_xia}`);
  const shang = mm[1]!;
  const xia = mm[2]!;

  // 六爻纳支：下卦三爻(内) + 上卦三爻(外)
  const zhi = [...NAZHI[xia]!.slice(0, 3), ...NAZHI[shang]!.slice(3)];

  // 卦宫 + 五行 + 世应
  const { palace, wuxing: pWuxing, idx } = palaceOf(ben.name);
  const shiPos = SHI_POS[idx]!;
  const yingPos = ((shiPos + 3 - 1) % 6) + 1;

  // 六亲：以宫五行为我，爻地支五行定六亲
  const liuqin = (z: string): string => {
    const zw = ZHI_WUXING[z]!;
    if (zw === pWuxing) return '兄弟';
    if (WUXING_SHENG[pWuxing]! === zw) return '子孙'; // 我生
    if (WUXING_SHENG[zw]! === pWuxing) return '父母';  // 生我
    if (WUXING_KE[zw]! === pWuxing) return '官鬼';     // 克我
    if (WUXING_KE[pWuxing]! === zw) return '妻财';     // 我克
    return '?';
  };

  // 六神：日干起
  const gan = dayGanZhi[0]!;
  const si = LIUSHEN_ORDER.indexOf(LIUSHEN_START[gan]!);
  const liuShen = Array.from({ length: 6 }, (_, i) => LIUSHEN_ORDER[(si + i) % 6]!);

  // 旬空：日干支空亡地支
  const [kongA, kongB] = kongWangOfDay(dayGanZhi);

  const yaoList: NajiaYao[] = Array.from({ length: 6 }, (_, i) => {
    const pos = i + 1;
    const z = zhi[i]!;
    return {
      position: pos,
      naZhi: z,
      wuXing: ZHI_WUXING[z]!,
      liuQin: liuqin(z),
      liuShen: liuShen[i]!,
      shiYing: pos === shiPos ? '世' : pos === yingPos ? '应' : '',
      dong: dong.includes(pos),
      kong: z === kongA || z === kongB,
    };
  });

  return { palace, palaceWuXing: pWuxing, shiYao: shiPos, yingYao: yingPos, dayGanZhi, yaoList };
}

/** 世应生克：世爻（我/玩家）与应爻（对方/男主）的五行关系 */
export function shiYingRelation(pan: Pan): string {
  const shi = pan.yaoList.find((y) => y.position === pan.shiYao)!;
  const ying = pan.yaoList.find((y) => y.position === pan.yingYao)!;
  if (WUXING_SHENG[shi.wuXing] === ying.wuXing) return '世生应';
  if (WUXING_SHENG[ying.wuXing] === shi.wuXing) return '应生世';
  if (WUXING_KE[shi.wuXing] === ying.wuXing) return '世克应';
  if (WUXING_KE[ying.wuXing] === shi.wuXing) return '应克世';
  return '比和';
}

/** 回头克：动爻变出的爻（变卦同位置）五行克本爻五行 → 事情反转、自食其果 */
export function huiTouKe(benPan: Pan, bianPan: Pan, dong: number[]): number[] {
  const result: number[] = [];
  for (const pos of dong) {
    const benYao = benPan.yaoList[pos - 1];
    const bianYao = bianPan.yaoList[pos - 1];
    if (benYao && bianYao && WUXING_KE[bianYao.wuXing] === benYao.wuXing) result.push(pos);
  }
  return result;
}

// ═══════════════════════════ 旺衰（月建/日辰生克）═══════════════════════════

export type WangShuai = '旺' | '平' | '衰';

/** 单爻旺衰：月建（权重高）+ 日辰（权重低）对爻五行的生克。旺相休囚死口诀的白话版。 */
export function wangShuaiOf(yaoWuXing: string, yueWuXing: string, dayWuXing: string): WangShuai {
  let score = 0;
  // 月建（月令）：当令旺 / 月生相 / 月克死 / 泄耗衰
  if (yaoWuXing === yueWuXing) score += 2;
  else if (WUXING_SHENG[yueWuXing] === yaoWuXing) score += 1; // 月建生爻 = 相
  else if (WUXING_KE[yueWuXing] === yaoWuXing) score -= 2;    // 月建克爻 = 死
  else score -= 1;                                            // 爻生月建(休) / 爻克月建(囚)
  // 日辰：辅助加减
  if (yaoWuXing === dayWuXing) score += 1;
  else if (WUXING_SHENG[dayWuXing] === yaoWuXing) score += 1; // 日辰生爻
  else if (WUXING_KE[dayWuXing] === yaoWuXing) score -= 1;    // 日辰克爻
  if (score >= 2) return '旺';
  if (score <= 0) return '衰';
  return '平';
}

/** 六亲旺衰：该六亲各爻里取旺衰最高的一档（叙事取最强信号）。 */
export function liuQinWangShuai(pan: Pan, yueJian: string): Record<string, WangShuai> {
  const yueWx = ZHI_WUXING[yueJian]!;
  const dayWx = ZHI_WUXING[pan.dayGanZhi[1]!]!;
  const rank: Record<WangShuai, number> = { 旺: 3, 平: 2, 衰: 1 };
  const result: Record<string, WangShuai> = {};
  for (const y of pan.yaoList) {
    const ws = wangShuaiOf(y.wuXing, yueWx, dayWx);
    const prev = result[y.liuQin];
    if (!prev || rank[ws] > rank[prev]) result[y.liuQin] = ws;
  }
  return result;
}

// ═══════════════════════════ 解卦（朱熹《易学启蒙》）═══════════════════════════

export function jieGua(ben: Hexagram, bian: Hexagram, dong: number[]): Jie {
  const n = dong.length;
  if (n === 0) return { dongCount: 0, kouzi: '本卦卦辞', content: ben.gua_ci ?? '' };
  if (n === 1) {
    const y = ben.yao[dong[0]! - 1]!;
    return { dongCount: 1, kouzi: `${y.position}爻辞`, content: y.yao_ci ?? '' };
  }
  if (n === 2) {
    const yHi = ben.yao[dong[1]! - 1]!;
    return { dongCount: 2, kouzi: `${yHi.position}（上爻为主）`, content: yHi.yao_ci ?? '' };
  }
  if (n === 3) {
    return { dongCount: 3, kouzi: '本卦+变卦卦辞', content: `${ben.gua_ci ?? ''} / ${bian.gua_ci ?? ''}` };
  }
  if (n === 4) {
    const jing = [0, 1, 2, 3, 4, 5].filter((i) => !dong.includes(i + 1));
    const y = bian.yao[jing[0]!]!;
    return { dongCount: 4, kouzi: `变卦${y.position}（下爻为主）`, content: y.yao_ci ?? '' };
  }
  if (n === 5) {
    const jing = [0, 1, 2, 3, 4, 5].filter((i) => !dong.includes(i + 1));
    const y = bian.yao[jing[0]!]!;
    return { dongCount: 5, kouzi: `变卦${y.position}`, content: y.yao_ci ?? '' };
  }
  return { dongCount: 6, kouzi: '变卦卦辞', content: bian.gua_ci ?? '' };
}

// ═══════════════════════════ 时辰 ═══════════════════════════

/** 按北京时间算当前时辰（UTC+8，不依赖 process.env.TZ） */
export function currentShichen(now: Date = new Date()): string {
  const beijingHour = (now.getUTCHours() + 8) % 24;
  const idx = Math.floor(((beijingHour + 1) % 24) / 2);
  return SHICHEN[idx]!;
}

// ═══════════════════════════ 白话映射（给 LLM 翻译）═══════════════════════════

export const LIUQIN_CN: Record<string, string> = {
  父母: '靠山/庇护/长辈', 兄弟: '同伴/竞争者', 子孙: '解厄贵人/化解之力',
  妻财: '所求之物/资源/情感对象', 官鬼: '对手/压力/困境/不信任',
};

export const LIUSHEN_CN: Record<string, string> = {
  青龙: '吉庆顺遂', 朱雀: '口舌是非', 勾陈: '迟滞拖延',
  腾蛇: '缠绕不安', 白虎: '凶险冲突', 玄武: '暗昧隐秘',
};

// ═══════════════════════════ 主入口 ═══════════════════════════

export interface DivinateOptions {
  /** 起卦种子（玩家ID|时辰|任务成分，或玩家摇出的随机数） */
  seed: string;
  /** 起卦日期 YYYY-MM-DD（默认今天，用于日干支） */
  date?: string;
  /** 玩家摇出的 6 爻铜钱"背"数（0-3，初爻→上爻）。有则取代 sha256 随机源（玩家"灵"）。 */
  cast?: number[];
}

function toGuaSummary(g: Hexagram): GuaSummary {
  return {
    index: g.index,
    name: g.name,
    guaXiang: g.gua_xiang,
    guaCi: g.gua_ci ?? '',
    baihua: g.baihua ?? '',
    duanyitianshe: g.duanyitianshe ?? '',
    shaoyong: g.shaoyong ?? '',
    philosophy: g.philosophy ?? '',
  };
}

/** 端到端：摇卦 → 排盘 → 推演 → 解卦。纯函数，不调 LLM。 */
export function divinate(opts: DivinateOptions): DivinationResult {
  const hexagrams = loadHexagrams();
  const pairs = buildPairs(hexagrams);
  const dateStr = opts.date || new Date().toISOString().slice(0, 10);
  const dayGanZhi = ganZhiOfDay(dateStr);
  const yueJian = yueJianOfDay(dateStr);
  const shichen = currentShichen();

  // 1. 摇卦：玩家摇出的 cast（6 爻背数）优先，否则用确定性 sha256
  const lines: number[] = [];
  const dong: number[] = [];
  if (opts.cast && opts.cast.length === 6) {
    for (let i = 0; i < 6; i++) {
      const { line, dong: isDong } = yaoFromBacks(opts.cast[i]!);
      lines.push(line);
      if (isDong) dong.push(i + 1);
    }
  } else {
    const g = yaoGua(opts.seed);
    lines.push(...g.lines);
    dong.push(...g.dong);
  }

  // 2. 本卦
  const { gua: ben } = linesToGua(lines, pairs);

  // 3. 排盘
  const pan = najiaPan({ name: ben.name, shang_xia: ben.shang_xia }, dong, dayGanZhi);

  // 4. 推演：变卦（翻动爻）、互卦（2-4爻、3-5爻）
  const bianLines = lines.map((x, i) => (dong.includes(i + 1) ? 1 - x : x));
  const bian = linesToGua(bianLines, pairs).gua;
  const hu = linesToGua([...lines.slice(1, 4), ...lines.slice(2, 5)], pairs).gua;
  // 错卦（旁通卦，每爻取反）：优先用数据里的 relations.cuo（已修好的卦际关系），缺失时用数学定义兜底
  const cuo = (() => {
    const idx = ben.relations?.cuo?.index;
    if (idx != null) {
      const found = hexagrams.find((g) => g.index === idx);
      if (found) return found;
    }
    return linesToGua(lines.map((x) => 1 - x), pairs).gua;
  })();
  // 变卦排盘（用于回头克）
  const bianPan = najiaPan({ name: bian.name, shang_xia: bian.shang_xia }, [], dayGanZhi);

  // 5. 解卦
  const jie = jieGua(ben, bian, dong);

  // 6. 动爻爻辞详情
  const dongYao: DongYao[] = dong.map((pos) => {
    const y = ben.yao[pos - 1];
    return {
      position: pos,
      positionName: y?.position ?? POS_NAME[pos - 1]!,
      yaoCi: y?.yao_ci ?? '',
      baihua: y?.baihua ?? '',
      shaoyong: y?.shaoyong ?? '',
    };
  });

  return {
    seed: opts.seed,
    shichen,
    dayGanZhi,
    yueJian,
    lines,
    dong,
    dongYao,
    ben: toGuaSummary(ben),
    bian: toGuaSummary(bian),
    hu: toGuaSummary(hu),
    cuo: toGuaSummary(cuo),
    pan,
    bianPan,
    jie,
  };
}
