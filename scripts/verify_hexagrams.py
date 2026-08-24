#!/usr/bin/env python3
"""校验 + 补全六十四卦数据的推演正确性。
用 8 卦三爻阴阳表反推：变卦(384)、互卦、错卦、综卦，对照 zhouyi.cc 抓取的数据。
输出不一致报告；对缺失/错误的变卦用推演结果补全（标记 source='derived'）。
"""
import json, glob, os, re, sys

DATA_DIR = '/output/infinite-date-v2/data/hexagrams'

# 8 卦三爻（从下到上，1=阳 0=阴）
TRIGRAM = {
    '乾': (1, 1, 1), '兑': (1, 1, 0), '离': (1, 0, 1), '震': (1, 0, 0),
    '巽': (0, 1, 1), '坎': (0, 1, 0), '艮': (0, 0, 1), '坤': (0, 0, 0),
}
TRIGRAM_REV = {v: k for k, v in TRIGRAM.items()}

def lines_of(shang, xia):
    """六爻（从下到上）：下卦三爻 + 上卦三爻。"""
    return list(TRIGRAM[xia]) + list(TRIGRAM[shang])

def hexagram_of(lines):
    """六爻 → (下卦名, 上卦名)。"""
    return TRIGRAM_REV[tuple(lines[0:3])], TRIGRAM_REV[tuple(lines[3:6])]

def bian_gua(lines, i):
    """动第 i 爻（0-indexed 从初爻起）→ (下卦, 上卦)。"""
    new = list(lines)
    new[i] = 1 - new[i]
    return hexagram_of(new)

def hu_gua(lines):
    """互卦：新下卦=2,3,4爻，新上卦=3,4,5爻。"""
    return TRIGRAM_REV[tuple(lines[1:4])], TRIGRAM_REV[tuple(lines[2:5])]

def cuo_gua(lines):
    """错卦：六爻全反。"""
    return hexagram_of([1 - x for x in lines])

def zong_gua(lines):
    """综卦：六爻倒置。"""
    return hexagram_of(list(reversed(lines)))

def load():
    data = []
    for f in sorted(glob.glob(os.path.join(DATA_DIR, '*.json'))):
        if f.endswith('_all.json'):
            continue
        data.append(json.load(open(f, encoding='utf-8')))
    data.sort(key=lambda d: d.get('index', 999))
    return data

def main():
    data = load()
    print(f'加载 {len(data)} 卦')
    # 建 (下卦, 上卦) → 卦 映射（用于推演结果转卦名/序号）
    by_pairs = {}
    for d in data:
        m = re.match(r'(.+)上(.+)下', d.get('shang_xia', ''))
        if m:
            shang, xia = m.group(1), m.group(2)
            by_pairs[(xia, shang)] = d

    problems = []
    fixed_bian = 0
    for d in data:
        m = re.match(r'(.+)上(.+)下', d.get('shang_xia', ''))
        if not m:
            problems.append((d['index'], d['name'], 'shang_xia 解析失败', d.get('shang_xia')))
            continue
        shang, xia = m.group(1), m.group(2)
        if shang not in TRIGRAM or xia not in TRIGRAM:
            problems.append((d['index'], d['name'], '上下卦名非法', f'{xia}/{shang}'))
            continue
        lines = lines_of(shang, xia)

        # 校验变卦
        for j, yao in enumerate(d.get('yao', [])):
            expect_xia, expect_shang = bian_gua(lines, j)
            expect = by_pairs.get((expect_xia, expect_shang))
            got = yao.get('bian_gua') or {}
            if not got.get('index'):
                if expect:
                    yao['bian_gua'] = {'index': expect['index'], 'name': expect['gua_xiang'], 'source': 'derived'}
                    fixed_bian += 1
                    problems.append((d['index'], d['name'], f'{yao["position"]} 变卦缺失', f'补全→{expect["gua_xiang"]}'))
            elif expect and got['index'] != expect['index']:
                old = f'{got["name"]}({got["index"]})'
                yao['bian_gua'] = {'index': expect['index'], 'name': expect['gua_xiang'], 'source': 'derived'}
                fixed_bian += 1
                problems.append((d['index'], d['name'], f'{yao["position"]} 变卦不符',
                                 f'数据源={old} 推演={expect["gua_xiang"]}({expect["index"]}) 已覆盖'))

        # 校验互卦/错卦/综卦
        rel = d.get('relations', {})
        for key, fn in [('hu', hu_gua), ('cuo', cuo_gua), ('zong', zong_gua)]:
            ex_xia, ex_shang = fn(lines)
            expect = by_pairs.get((ex_xia, ex_shang))
            got = rel.get(key) or {}
            if expect and got.get('index') != expect['index']:
                old = f'{got.get("name")}({got.get("index")})'
                rel[key] = {'index': expect['index'], 'name': expect['gua_xiang'], 'source': 'derived'}
                problems.append((d['index'], d['name'], f'{key}卦 不符',
                                 f'数据源={old} 推演={expect["gua_xiang"]}({expect["index"]}) 已覆盖'))

    print(f'\n=== 问题统计：{len(problems)} 条，其中变卦补全 {fixed_bian} 个 ===')
    for p in problems:
        print(f'  [{p[0]:>2}] {p[1]}  {p[2]}: {p[3]}')

    # 回写（补全变卦）
    for d in data:
        for f in glob.glob(os.path.join(DATA_DIR, '*.json')):
            if f.endswith('_all.json'):
                continue
            jd = json.load(open(f, encoding='utf-8'))
            if jd.get('index') == d['index']:
                json.dump(d, open(f, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
                break
    # 更新 _all.json
    all_path = os.path.join(DATA_DIR, '_all.json')
    json.dump(data, open(all_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'\n已回写 → {all_path}')

if __name__ == '__main__':
    main()
