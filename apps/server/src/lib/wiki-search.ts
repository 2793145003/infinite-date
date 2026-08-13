/**
 * IP 角色搜索模块 — 通过 MediaWiki API 查询 Fandom / Biligame Wiki
 * 拿到角色页面的 wikitext，供 LLM 提取结构化角色卡
 */

export interface WikiSearchResult {
  name: string;
  source: string;       // 'biligame' | 'fandom'
  url: string;          // 页面 URL
  wikitext: string;     // 原始 wiki 标记文本
  extract?: string;     // 纯文本摘要（如果有）
}

const WIKIS = {
  // 中文 B 站 wiki — 结构化数据最丰富
  biligame: {
    api: 'https://wiki.biligame.com/sr/api.php',
    articlePath: 'https://wiki.biligame.com/sr/wiki/',
  },
  // 英文 Fandom wiki
  fandom: {
    api: 'https://honkai-star-rail.fandom.com/api.php',
    articlePath: 'https://honkai-star-rail.fandom.com/wiki/',
  },
};

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'InfiniteDate/1.0 (character search)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 在某个 wiki 上搜索角色页面
 */
async function searchOnWiki(
  wikiKey: keyof typeof WIKIS,
  query: string,
): Promise<WikiSearchResult | null> {
  const wiki = WIKIS[wikiKey];
  const { api, articlePath } = wiki;

  try {
    // Step 1: search for the page title
    const searchUrl = `${api}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json`;
    const searchData = await fetchJson(searchUrl);
    const hits = searchData?.query?.search;
    if (!hits || hits.length === 0) return null;

    // Pick best match — prefer exact title match
    const exact = hits.find((h: any) => h.title === query);
    const best = exact ?? hits[0];
    const pageTitle = best.title;

    // Step 2: get wikitext
    const parseUrl = `${api}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&redirects=1&format=json`;
    const parseData = await fetchJson(parseUrl);
    const wikitext = parseData?.parse?.wikitext?.['*'];
    if (!wikitext || wikitext.length < 50) return null;

    return {
      name: pageTitle,
      source: wikiKey,
      url: `${articlePath}${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
      wikitext,
    };
  } catch (e) {
    console.warn(`[wiki-search] ${wikiKey} search failed:`, e);
    return null;
  }
}

/**
 * 从 wikitext 中提取角色相关字段，去掉游戏数值/CV/材料等噪声
 */
function extractWikiSummary(wikitext: string): string {
  const lines = wikitext.split('\n');
  const usefulKeys = new Set([
    '名称', '外文名', '全名', '性别', '阵营', '派系', '出身', '种族',
    '介绍', '角色详细', '角色定位', '昵称/外号',
    '短信签名', '卷首语',
    '角色故事1', '角色故事2', '角色故事3', '角色故事4',
  ]);

  const parts: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\|\s*([^=]+?)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.trim();
    let val = m[2]!.trim();
    if (!usefulKeys.has(key) || !val) continue;
    // 清理 wiki 标记
    val = val.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
             .replace(/<ref[^>]*\/>/g, '')
             .replace(/<br\s*\/?>/g, '\n')
             .replace(/\{\{[^}]*\}\}/g, '')
             .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
             .replace(/<[^>]+>/g, '')
             .trim();
    if (val) parts.push(`【${key}】${val}`);
  }
  // 也提取页面正文（模板之后的描述性文字）
  const afterTemplate = wikitext.split(/\}\}/).slice(-3).join('}}');
  const plainText = afterTemplate
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .trim();
  if (plainText.length > 50) parts.push(`【页面描述】${plainText.slice(0, 500)}`);

  return parts.join('\n');
}

/**
 * 搜索 IP 角色资料
 * 先查中文 biligame，没结果再查英文 fandom
 */
export async function searchCharacter(name: string): Promise<WikiSearchResult | null> {
  // 先查中文 wiki
  const cn = await searchOnWiki('biligame', name);
  if (cn) {
    // 预提取有用字段，替换原始 wikitext
    cn.wikitext = extractWikiSummary(cn.wikitext);
    return cn;
  }

  // 中文没有 → 试英文
  const en = await searchOnWiki('fandom', name);
  if (en) {
    en.wikitext = extractWikiSummary(en.wikitext);
  }
  return en;
}
