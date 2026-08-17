/**
 * 世界观基调（参考网文/无限流副本分类）：世界生成时的第一层随机维度。
 *
 * 基调不是"选名字库"这么浅——它是副本级别的框架，注入 prompt 后指导整个生成：
 *   剧情走向、氛围、NPC 设定、命名，全都往基调走。
 *
 * 机制：起卦 → roll 基调（playerId+seq 确定性，同玩家连续生成基调轮换）→ 注入 prompt。
 */
function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

export type Theme =
  | '古风' | '仙侠' | '民国' | '都市' | '乡村' | '西幻'
  | '科幻' | '日式' | '灵异' | '末世' | '悬疑' | '二次元';

export const THEME_LIST: Theme[] = [
  '古风', '仙侠', '民国', '都市', '乡村', '西幻',
  '科幻', '日式', '灵异', '末世', '悬疑', '二次元',
];

export interface ThemeGuide {
  theme: Theme;
  /** 氛围 / 气质 */
  atmosphere: string;
  /** NPC 典型设定 */
  npcTypes: string;
  /** 命名风格（人名 + 地名） */
  nameStyle: string;
}

export const THEME_GUIDES: Record<Theme, ThemeGuide> = {
  '古风': {
    theme: '古风',
    atmosphere: '青石板路、酒旗、老宅、炊烟，市井烟火气里透着旧时代的规矩与束缚',
    npcTypes: '掌柜、郎中、镖师、货郎、教书先生、账房、衙役、说书人',
    nameStyle: '古风名（如陆卿正、刘星耀、何以忠），地名用古镇名（风陵渡、歇马驿、青苔镇）',
  },
  '仙侠': {
    theme: '仙侠',
    atmosphere: '仙山云海、洞府、丹炉、飞剑，飘逸出尘，却也有躲不掉的红尘劫',
    npcTypes: '掌门、散修、炼丹师、剑修、灵兽、护法、守山弟子',
    nameStyle: '道号/仙名（清玄、若虚、云鹤、长真），地名用仙山/洞府名（栖霞峰、忘尘谷）',
  },
  '民国': {
    theme: '民国',
    atmosphere: '租界霓虹、黄包车、老式电话、舞厅留声机，繁华底下的动荡与身不由己',
    npcTypes: '报馆记者、舞女、巡捕、医生、商人、学生、伶人、车夫',
    nameStyle: '民国名（沈从文式、张爱玲式），地名用租界/戏园/公馆/报馆',
  },
  '都市': {
    theme: '都市',
    atmosphere: '写字楼、地铁、出租屋、外卖，现代生活的疲惫与孤独',
    npcTypes: '同事、房东、外卖员、医生、心理咨询师、邻居、上司',
    nameStyle: '现代名（有质感的，不要陈金万这种最普通的），地名用街道/小区/大厦',
  },
  '乡村': {
    theme: '乡村',
    atmosphere: '田埂、水井、老槐树、祠堂，淳朴里藏着守旧与闲言碎语',
    npcTypes: '村支书、赤脚医生、猎户、货郎、媒婆、留守老人、货郎',
    nameStyle: '乡村称呼（阿满、老栓、王婆、翠花），地名用村名（杏花村、槐树村）',
  },
  '西幻': {
    theme: '西幻',
    atmosphere: '城堡、森林、魔法、骑士与龙，中世纪的浪漫与蛮荒',
    npcTypes: '骑士、法师、炼金术士、酒馆老板、吟游诗人、铁匠、领主',
    nameStyle: '西幻音译名（有质感的，不要约翰玛丽这种），地名用城堡/森林/庄园',
  },
  '科幻': {
    theme: '科幻',
    atmosphere: '霓虹、义体、全息广告、数据流，高科技低生活的反差',
    npcTypes: '黑客、义体医生、佣兵、情报贩子、企业职员、改造人',
    nameStyle: '代号/义体名（有质感的），地名用XX区/XX港/XX城',
  },
  '日式': {
    theme: '日式',
    atmosphere: '神社鸟居、纸灯笼、和室、梅雨，阴郁诡异的和风',
    npcTypes: '巫女、僧侣、艺人、渔师、旅馆老板娘、神主',
    nameStyle: '日本名（佐藤、花子式），地名用XX村/XX町/XX神社',
  },
  '灵异': {
    theme: '灵异',
    atmosphere: '阴森、荒村、老宅、不可名状，中式恐怖与克苏鲁式的恐惧',
    npcTypes: '神婆、道士、守墓人、更夫、失踪者、幸存者',
    nameStyle: '中式民俗名，地名用荒村/老宅/坟地/义庄',
  },
  '末世': {
    theme: '末世',
    atmosphere: '废墟、断壁、荒芜、物资匮乏，末日求生的残酷',
    npcTypes: '幸存者、拾荒者、军医、民兵、避难所管理员',
    nameStyle: '末世感的名字，地名用XX避难所/XX废墟/XX营地',
  },
  '悬疑': {
    theme: '悬疑',
    atmosphere: '雨夜、侦探社、密室、证物，迷雾重重的案件',
    npcTypes: '侦探、警察、嫌疑人、目击者、法医、律师',
    nameStyle: '现代/民国名，地名用侦探社/警局/案发现场',
  },
  '二次元': {
    theme: '二次元',
    atmosphere: '校园、社团、夏日祭，轻小说式的青春与幻想',
    npcTypes: '同学、学长学姐、社团成员、老师、青梅竹马',
    nameStyle: '日式/轻小说名，地名用校园/社团/商店街',
  },
};

/** 按 playerId 洗牌 + seq 切块，确定性 roll 出一个基调（同玩家连续生成轮换不重复） */
export function rollTheme(playerId: string, seq: number): Theme {
  const shuffled = shuffle(THEME_LIST, seededRng(playerId + '|theme'));
  return shuffled[seq % shuffled.length]!;
}

/** 渲染成 prompt 段落：基调指导 */
export function renderThemeGuide(theme: Theme): string {
  const g = THEME_GUIDES[theme];
  return [
    `【世界观基调】这个世界是「${g.theme}」基调，生成时所有设定都要贴合这个基调：`,
    `- 氛围：${g.atmosphere}`,
    `- NPC 设定：${g.npcTypes}`,
    `- 命名风格：${g.nameStyle}`,
  ].join('\n');
}

/** 任务玩法（第二层随机维度）：和基调一样确定性 roll，不靠六亲推导、不让 LLM 自由选 */
export type Goal = '战斗' | '寻物' | '破案' | '和解' | '守护';

export const GOAL_LIST: Goal[] = ['战斗', '寻物', '破案', '和解', '守护'];

export const GOAL_GUIDES: Record<Goal, string> = {
  战斗: '正面压住/制服/逼退一个正在害人的具体对象。对象要有名字、有动机、落到具体的事上；威胁形态跟着世界观基调走。写清它是谁、在祸害谁、怎么祸害',
  寻物: '找回一件丢失/被藏起/稀缺的具体东西，或一个走丢的人；写清丢了什么、对谁重要、为什么非找不可',
  破案: '查明一件没查清的事的真相；写清是什么事、谁干的、真相去向',
  和解: '化解一段心结/误会/冲突；写清谁和谁、结了什么怨、为什么放不下',
  守护: '护住一个具体的人或一件具体的东西不被夺走、拆毁、荒废。护的是有名字、能摸得着的东西，不是抽象概念；威胁形态跟着世界观基调走。写清在护谁/护什么、被什么威胁、为什么非守不可',
};

/** 按 playerId 洗牌 + seq 切块，确定性 roll 一个玩法（同玩家连续生成玩法轮换不重复） */
export function rollGoal(playerId: string, seq: number): Goal {
  const shuffled = shuffle(GOAL_LIST, seededRng(playerId + '|goal'));
  return shuffled[seq % shuffled.length]!;
}

/** 渲染成 prompt 段落：任务目标（玩法） */
export function renderGoalGuide(goal: Goal): string {
  const explain = GOAL_GUIDES[goal];
  const lines = [
    `【任务目标】这一局的任务玩法已定为「${goal}」：${explain}。`,
    `玩法是任务的主线，写进 briefing 和 mission_hook，让玩家一眼知道这一局是「打一场」「查个案」「找个东西」还是「守个东西」「化解心结」。`,
    `mission_goal 就写成「${goal}——具体目标」，不要改换玩法。`,
  ];
  // 对手必需性由玩法定：战斗压的就是一个具体对象，没有对手就穿帮
  if (goal === '战斗') {
    lines.push('战斗玩法必须有对手：那个「正在害人的具体对象」要作为 world_npcs 里 role=「对手」的 NPC 出现（有名字、有动机、落到具体的事上），不能只写在 briefing 里、没有对应的 NPC。');
  }
  // 线索与进度：只有破案（推理）需要线索；进度由代码按线索数算，LLM 不写 progress
  if (goal === '破案') {
    lines.push(
      '【线索（仅破案玩法）】破案是推理玩法，需要线索：把「隐藏暗线」和「转折种子」拆成 3-4 条线索（clues 数组），从模糊到真相、最后一条是真相本身，像剧本杀一样分发到各 NPC 的 knows（写线索编号）。信息差：不要人人知道全部，真相那条只给「任务核心对象」；「对手」可以握着关键线索，但按人设不会轻易说。每条线索一句话，写具体的人/物/事/情，不要抽象术语。另给 1-2 条环境线索（environmental_clues），是环境/物品/氛围能透露的碎片。',
    );
  } else {
    lines.push(
      '【线索与进度】本玩法不需要线索和进度：clues 返回空数组 []，environmental_clues 返回空数组 []，world_npcs 的 knows 全部返回空数组 []。任务完成以玩法为准（事办成了就完成），不靠数值、不拼线索。',
    );
  }
  // 通关流程：所有玩法都生成 goal_path，供系统判定「任务是否完成」+ 剧情导演参考推进方向
  lines.push(
    '【通关流程（goal_path）】生成 goal_path 字段：一份「可参考的通关流程」，写清玩家用「' + goal + '」这个玩法、经过哪几步，任务（mission_goal）就算办成了。2-4 步，从困境表象走到目标态（target_state），每步落到本任务的具体的人/物/事上、可被观察到（谁做了什么、世界变成了什么样）。通关流程的终点 = mission_goal 达成（对应 target_state 出现），不要把 hidden_thread 的暗线当成通关必经步骤。这份流程是系统判定「任务是否完成」和剧情导演参考推进方向的依据，不要写抽象术语。',
  );
  return lines.join('\n');
}
