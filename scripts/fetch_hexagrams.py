#!/usr/bin/env python3
"""抓取 zhouyi.cc 六十四卦数据 → 结构化 JSON。
温和抓取：每页间隔 sleep，可重入（已缓存跳过）。
用法：python3 fetch_hexagrams.py [起始序号] [结束序号]
      无参数 = 抓全部 64 卦（序号 = 周易卦序 1-64）。
兼容两种页面模板：strong 式（乾卦）与 guatt/gualist 式（坤卦）。
"""
import re, time, json, os, sys, urllib.request

BASE = 'https://zhouyi.cc/zhouyi/yijing64/'
OUT = '/output/infinite-date-v2/data/hexagrams'
os.makedirs(OUT, exist_ok=True)

UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

YAO_POS = '(初九|九二|九三|九四|九五|上九|初六|六二|六三|六四|六五|上六)'

def fetch(url, retries=2):
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            return urllib.request.urlopen(req, timeout=25).read().decode('utf-8', 'ignore')
        except Exception:
            if i == retries:
                raise
            time.sleep(3 * (i + 1))

def clean(t):
    t = t.replace('\r\n', '\n').replace('\r', '\n')
    t = re.sub(r'<script.*?</script>', '', t, flags=re.S)
    t = re.sub(r'<style.*?</style>', '', t, flags=re.S)
    t = re.sub(r'<img[^>]*>', '', t)
    t = re.sub(r'<br\s*/?>', '\n', t)
    t = re.sub(r'<[^>]+>', '', t)
    t = t.replace('&nbsp;', ' ').replace('&ldquo;', '“').replace('&rdquo;', '”')
    t = t.replace('&middot;', '·').replace('&mdash;', '—').replace('&agrave;', 'à')
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n\s*\n+', '\n', t)
    return t.strip()

def parse_title(title_html):
    # 周易第1卦_乾卦(乾为天)_乾上乾下_易安居吉祥网
    m = re.search(r'周易第(\d+)卦_([^_]+)_([^_]+)_', title_html)
    if not m:
        return None
    index = int(m.group(1))
    full_name = m.group(2)  # 如 "乾卦(乾为天)"
    name = full_name.split('(')[0].replace('卦', '')
    m2 = re.search(r'\(([^)]+)\)', full_name)
    gua_xiang = m2.group(1) if m2 else full_name
    shang_xia = m.group(3)
    return {'index': index, 'name': name, 'gua_xiang': gua_xiang, 'shang_xia': shang_xia}

def new_yao(pos):
    return {'position': pos, 'yao_ci': '', 'xiang_yue': '', 'baihua': '',
            'shaoyong': '', 'fupeirong': '', 'bian_gua': {}, 'philosophy': ''}

def parse_gua_level(body):
    """解析卦级字段（strong 切分），返回 (gua_fields, strong式爻列表, rel_text)。"""
    parts = re.split(r'<strong>(.*?)</strong>', body, flags=re.S)
    fields = {'gua_ci': '', 'xiang_yue': '', 'baihua': '', 'duanyitianshe': '',
              'shaoyong': '', 'fupeirong': '', 'chuantong': '', 'philosophy': '',
              'xiang_scope': '', 'xiang_body': ''}
    yaos = []
    rel_text = ''
    cur_yao = None
    i = 0
    while i < len(parts):
        if i % 2 == 1:
            title = clean(parts[i])
            content = clean(parts[i + 1]) if i + 1 < len(parts) else ''
            if title in ('本卦', '互卦', '错卦', '综卦'):
                rel_text += content + '\n'
            elif title.endswith('卦原文'):
                fields['gua_ci'] = content
                m = re.search(r'象曰：(.+)', content)
                if m:
                    fields['xiang_yue'] = m.group(1).strip()
            elif title == '白话文解释':
                if cur_yao is None:
                    fields['baihua'] = content
                else:
                    cur_yao['baihua'] = content
            elif title == '《断易天机》解':
                fields['duanyitianshe'] = content
            elif title == '北宋易学家邵雍解':
                if cur_yao is None:
                    fields['shaoyong'] = content
                else:
                    cur_yao['shaoyong'] = content
            elif title == '台湾国学大儒傅佩荣解':
                if cur_yao is None:
                    fields['fupeirong'] = content
                else:
                    cur_yao['fupeirong'] = content
            elif title == '传统解卦':
                fields['chuantong'] = content
            elif '哲学含义' in title and '爻' not in title:
                fields['philosophy'] = content
            elif '所包含的范围' in title:
                fields['xiang_scope'] = content
            elif '部位' in title:
                fields['xiang_body'] = content
            elif re.match(r'^' + YAO_POS + r'爻辞$', title):
                cur_yao = new_yao(title.replace('爻辞', ''))
                yaos.append(cur_yao)
                cur_yao['yao_ci'] = content
                m = re.search(r'象曰：(.+)', content)
                if m:
                    cur_yao['xiang_yue'] = m.group(1).strip()
            elif '变卦' in title:
                m = re.search(r'周易第(\d+)卦[:：]\s*([^。\s]+)', content)
                if m and cur_yao is not None:
                    cur_yao['bian_gua'] = {'index': int(m.group(1)), 'name': m.group(2)}
            elif '爻的哲学含义' in title:
                if cur_yao is not None:
                    cur_yao['philosophy'] = content
        i += 1
    return fields, yaos, rel_text

def parse_gualist_yaos(body):
    """解析 gualist 式爻块（坤卦等），返回爻列表。"""
    yaos = []
    # 爻块：<div class="guatt">周易第N卦X爻详解</div> 后跟 <div class="gualist">内容</div>
    for m in re.finditer(
            r'<div class="guatt[^"]*">[^<]*</div>\s*<div class="gualist[^"]*">(.*?)</div>',
            body, re.S):
        content = clean(m.group(1))
        lines = [l for l in content.split('\n') if l]
        # position 从内容里的 "X爻辞" 标题行取（guatt div 标题可能有笔误）
        pos = None
        for l in lines:
            pm = re.match(r'^' + YAO_POS + r'爻辞$', l)
            if pm:
                pos = pm.group(1)
                break
        if pos is None:
            continue
        yao = new_yao(pos)
        mode = None
        for line in lines:
            if re.match(r'^' + YAO_POS + r'爻辞$', line):
                mode = 'yao_ci'
                continue
            if line.startswith('象曰'):
                yao['xiang_yue'] += line.replace('象曰', '').strip('：: ') + '\n'
                mode = None
                continue
            if line == '白话文解释':
                mode = 'baihua'; continue
            if '邵雍解' in line:
                mode = 'shaoyong'; continue
            if '傅佩荣解' in line:
                mode = 'fupeirong'; continue
            if line.endswith('变卦'):
                mode = 'bian_gua'; continue
            if line.startswith('本爻辞的意思') or line.startswith('爻辞释义') or line.startswith('从卦象上看') or '人生启示' in line:
                mode = 'philosophy'
            # 内容行
            if mode == 'yao_ci':
                yao['yao_ci'] += line + '\n'
            elif mode == 'baihua':
                yao['baihua'] += line
            elif mode == 'shaoyong':
                yao['shaoyong'] += line
            elif mode == 'fupeirong':
                yao['fupeirong'] += line
            elif mode == 'bian_gua':
                m2 = re.search(r'周易第(\d+)卦[:：]\s*([^。\s]+)', line)
                if m2:
                    yao['bian_gua'] = {'index': int(m2.group(1)), 'name': m2.group(2)}
            elif mode == 'philosophy':
                yao['philosophy'] += line
        yaos.append(yao)
    return yaos

def merge_yaos(strong_yaos, gualist_yaos):
    """合并两种模板解析出的爻：按位序去重，字段级非空优先（strong 优先，gualist 补空）。"""
    merged = {}
    for y in strong_yaos + gualist_yaos:
        pos = y['position']
        if pos not in merged:
            merged[pos] = new_yao(pos)
        for field in ('yao_ci', 'xiang_yue', 'baihua', 'shaoyong', 'fupeirong', 'philosophy'):
            if y.get(field) and not merged[pos].get(field):
                merged[pos][field] = y[field]
        if y.get('bian_gua') and not merged[pos].get('bian_gua'):
            merged[pos]['bian_gua'] = y['bian_gua']
    order_map = {'初': 1, '二': 2, '三': 3, '四': 4, '五': 5, '上': 6}
    def pos_key(y):
        for ch, n in order_map.items():
            if ch in y['position']:
                return n
        return 9
    return sorted(merged.values(), key=pos_key)

def extract(html):
    title = re.search(r'<title>(.*?)</title>', html, re.S)
    meta = parse_title(title.group(1)) if title else {}
    if not meta:
        return None
    idx = html.find('big_box_wp')
    body = html[idx:html.find('</html>', idx)] if idx >= 0 else html
    # 删除图片容器 div（gualist 块内嵌 div 会截断非贪婪匹配）
    body = re.sub(r'<div[^>]*>\s*<img[^>]*>\s*</div>', '', body, flags=re.S)

    fields, strong_yaos, rel_text = parse_gua_level(body)
    gualist_yaos = parse_gualist_yaos(body)
    yaos = merge_yaos(strong_yaos, gualist_yaos)

    result = {**meta, **fields, 'relations': {}, 'yao': yaos}
    rel_matches = re.findall(r'第(\d+)卦[：:]\s*([^()（）\s/]+)', rel_text)
    if len(rel_matches) >= 4:
        keys = ['ben', 'hu', 'cuo', 'zong']
        result['relations'] = {keys[k]: {'index': int(rel_matches[k][0]),
                                         'name': rel_matches[k][1].replace('卦', '')}
                               for k in range(4)}
    return result

def get_hexagram_list():
    """从列表页提取 64 卦的 URL、序号、卦象名（去重、按卦序排序）。"""
    html = fetch(BASE)
    seen = {}
    for m in re.finditer(r'<a[^>]*href="(/zhouyi/yijing64/(\d+)\.html)"[^>]*>(.*?)</a>', html, re.S):
        url, num, anchor = m.group(1), m.group(2), clean(m.group(3))
        m2 = re.match(r'^(\d+)、(.+)$', anchor)
        if m2:
            seen[num] = {'url': url, 'num': num, 'index': int(m2.group(1)), 'name': m2.group(2)}
        elif num not in seen:
            seen[num] = {'url': url, 'num': num, 'index': None, 'name': anchor}
    items = sorted(seen.values(), key=lambda x: x['index'] if x['index'] is not None else 999)
    return items

def main():
    args = [int(a) for a in sys.argv[1:3] if a.isdigit()]
    start = args[0] if len(args) >= 1 else None
    end = args[1] if len(args) >= 2 else None

    listing = get_hexagram_list()
    print(f'列表页解析到 {len(listing)} 个卦（去重后）')
    if not listing:
        print('列表页解析失败，检查网络或页面结构'); return

    results = []
    for pos, item in enumerate(listing, start=1):
        if start is not None and pos < start:
            continue
        if end is not None and pos > end:
            continue
        num = item['num']
        cache = os.path.join(OUT, f'{num}.json')
        if os.path.exists(cache):
            with open(cache, encoding='utf-8') as f:
                results.append(json.load(f))
            print(f'[{pos}] {item["name"]} (缓存)')
            continue
        full = 'https://zhouyi.cc' + item['url']
        html = fetch(full)
        data = extract(html)
        if data is None:
            print(f'[{pos}] {item["name"]} 解析失败，跳过')
            continue
        with open(cache, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        results.append(data)
        n_yao = len(data.get('yao', []))
        n_bian = sum(1 for y in data.get('yao', []) if y.get('bian_gua'))
        print(f'[{pos}] {data.get("name")}({data.get("gua_xiang")}) 爻{n_yao} 变卦{n_bian} 关系{list(data.get("relations", {}).keys())}')
        time.sleep(1.5)

    all_path = os.path.join(OUT, '_all.json')
    with open(all_path, 'w', encoding='utf-8') as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f'\n完成：{len(results)} 卦 → {all_path}')

if __name__ == '__main__':
    main()
