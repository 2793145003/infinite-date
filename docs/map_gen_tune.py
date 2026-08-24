#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
地图生成调参脚本 —— Voronoi 多边形 → 删外圈 + 侵蚀 → 补洞成整块 → 按角度分区（三个地点汇聚于一点）

依赖：pip install numpy scipy

用法：直接改下面「参数」区，然后 python3 map_gen_tune.py
输出：ASCII 预览（A/B/C 三个地点，* 是中心点）+ 统计信息（格子数/连通性）
"""

import numpy as np
from scipy.spatial import Voronoi
import math

# ============================================================
# 参数区（改这里）
# ============================================================
W, H = 1000, 640        # 画布尺寸（SVG viewBox）
PAD = 60                # 地图与画布边缘的留白

GX, GY = 12, 10         # 切分密度：横竖各多少格（越大切分越细，格子越多）
ERODE = 8               # 侵蚀口数：删完外圈后，再随机啃多少口（越多边界越凹凸；太多会碎/有洞）

SIZES = [17, 14, 11]    # 三个地点的大小权重（当前 = 子地点数：主城/云枢/住宅）。比例决定每块占的角度
                        #   → 角度比例 = SIZES[i] / sum(SIZES) * 360°

START_ANGLE = None      # 三个扇区从哪个角度开始（度，0~360）。None = 随机（每次跑会变）
                        #   固定一个值可复现同一个朝向

SEED = 'map-v4'         # 随机种子（决定 Voronoi 种子抖动、侵蚀顺序、START 随机值）
# ============================================================


def hash_string(s):
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def mulberry32(seed):
    a = seed & 0xFFFFFFFF
    def rng():
        nonlocal a
        a = (a + 0x6d2b79f5) & 0xFFFFFFFF
        t = a
        t = (t ^ (t >> 15)) * (1 | t) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rng


def main():
    rng = mulberry32(hash_string(SEED))

    # 1. 生成 Voronoi 种子（网格 + 抖动）
    cw = (W - 2 * PAD) / GX
    ch = (H - 2 * PAD) / GY
    seeds = []
    for r in range(GY):
        for c in range(GX):
            x = PAD + c * cw + cw / 2 + (rng() - 0.5) * cw * 0.8
            y = PAD + r * ch + ch / 2 + (rng() - 0.5) * ch * 0.8
            seeds.append((x, y))

    vor = Voronoi(np.array(seeds))
    x0, y0, x1, y1 = PAD, PAD, W - PAD, H - PAD

    # Sutherland-Hodgman 裁剪（把每个 Voronoi 单元裁到画布内）
    def clip(poly, edge):
        res = []
        n = len(poly)
        if n == 0:
            return []
        def inside(p):
            return {'left': p[0] >= x0, 'right': p[0] <= x1,
                    'top': p[1] >= y0, 'bottom': p[1] <= y1}[edge]
        def inter(a, b):
            if edge in ('left', 'right'):
                X = x0 if edge == 'left' else x1
                t = (X - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0
                return (X, a[1] + t * (b[1] - a[1]))
            Y = y0 if edge == 'top' else y1
            t = (Y - a[1]) / (b[1] - a[1]) if b[1] != a[1] else 0
            return (a[0] + t * (b[0] - a[0]), Y)
        for i in range(n):
            a, b = poly[i], poly[(i + 1) % n]
            ain, bin_ = inside(a), inside(b)
            if ain and bin_:
                res.append(b)
            elif ain and not bin_:
                res.append(inter(a, b))
            elif not ain and bin_:
                res.append(inter(a, b))
                res.append(b)
        return res

    def clip_all(vs):
        p = list(vs)
        for e in ['left', 'right', 'top', 'bottom']:
            p = clip(p, e)
            if not p:
                break
        return p

    polys, boundary = [], []
    for si in range(len(seeds)):
        region = vor.regions[vor.point_region[si]]
        verts = [vor.vertices[v] for v in region if v != -1]
        poly = clip_all(verts)
        polys.append(poly)
        if len(poly) < 3:
            boundary.append(True)
            continue
        b = any(abs(p[0] - x0) < 0.5 or abs(p[0] - x1) < 0.5 or
                abs(p[1] - y0) < 0.5 or abs(p[1] - y1) < 0.5 for p in poly)
        boundary.append(b)

    neighbors = [set() for _ in seeds]
    for (a, b) in vor.ridge_points:
        neighbors[a].add(int(b))
        neighbors[b].add(int(a))

    # 2. 删外圈（贴画布边的格子），去掉长方形直边
    removed = set(i for i in range(len(seeds)) if boundary[i])

    # 3. 侵蚀：随机啃掉「贴已删块」的格子
    erng = mulberry32(hash_string('erosion'))
    for _ in range(ERODE):
        edge = [i for i in range(len(seeds))
                if i not in removed and any(nb in removed for nb in neighbors[i])]
        if not edge:
            break
        removed.add(edge[int(erng() * len(edge))])

    kept = [i for i in range(len(seeds)) if i not in removed and len(polys[i]) >= 3]
    K = len(kept)
    local_of = {g: li for li, g in enumerate(kept)}
    lNeighbors = [[local_of[nb] for nb in neighbors[g] if nb in local_of] for g in kept]

    # 4. 补洞：只保留最大连通分量（侵蚀可能切出孤岛）
    def components_of_kept():
        unvisited = set(range(K))
        comps = []
        while unvisited:
            start = unvisited.pop()
            comp = set([start])
            stack = [start]
            while stack:
                cur = stack.pop()
                for nb in lNeighbors[cur]:
                    if nb in unvisited:
                        unvisited.discard(nb)
                        comp.add(nb)
                        stack.append(nb)
            comps.append(comp)
        return comps

    comps = components_of_kept()
    comps.sort(key=len, reverse=True)
    main = comps[0]
    if len(main) < K:
        kept = [kept[li] for li in sorted(main)]
        K = len(kept)
        local_of = {g: li for li, g in enumerate(kept)}
        lNeighbors = [[local_of[nb] for nb in neighbors[g] if nb in local_of] for g in kept]

    def centroid(poly):
        a = cx = cy = 0
        for i in range(len(poly)):
            p0, p1 = poly[i], poly[(i + 1) % len(poly)]
            cr = p0[0] * p1[1] - p1[0] * p0[1]
            a += cr
            cx += (p0[0] + p1[0]) * cr
            cy += (p0[1] + p1[1]) * cr
        a /= 2
        if abs(a) < 1e-6:
            return (W / 2, H / 2)
        return (cx / (6 * a), cy / (6 * a))

    def poly_area(poly):
        a = 0
        for i in range(len(poly)):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % len(poly)]
            a += x1 * y2 - x2 * y1
        return abs(a) / 2

    centroids = [centroid(polys[g]) for g in kept]

    # 5. 中心点 = 面积加权质心（三个地点在此汇聚）
    tot_area = cx = cy = 0
    for li in range(K):
        pa = poly_area(polys[kept[li]])
        tot_area += pa
        cx += centroids[li][0] * pa
        cy += centroids[li][1] * pa
    C = (cx / tot_area, cy / tot_area)

    # 6. 角度分区：每个地点占一个角度扇区（按 SIZES 比例），从中心点发散
    N = len(SIZES)
    total = sum(SIZES)
    angle_bounds = [0.0]
    for s in SIZES[:-1]:
        angle_bounds.append(angle_bounds[-1] + s / total * 360)
    angle_bounds.append(360)
    START = (rng() * 360) % 360 if START_ANGLE is None else START_ANGLE

    assign = [-1] * K
    for li in range(K):
        p = centroids[li]
        ang = math.degrees(math.atan2(p[1] - C[1], p[0] - C[0]))
        ang = (ang + 360) % 360
        rel = (ang - START) % 360
        for r in range(N):
            if angle_bounds[r] <= rel < angle_bounds[r + 1]:
                assign[li] = r
                break
        if assign[li] == -1:
            assign[li] = N - 1

    counts = [assign.count(r) for r in range(N)]

    # 连通性检查
    def region_components(r):
        members = [li for li in range(K) if assign[li] == r]
        seen = set()
        comps = []
        for m in members:
            if m in seen:
                continue
            comp = set([m])
            stack = [m]
            seen.add(m)
            while stack:
                cur = stack.pop()
                for nb in lNeighbors[cur]:
                    if assign[nb] == r and nb not in seen:
                        seen.add(nb)
                        stack.append(nb)
                        comp.add(nb)
            comps.append(comp)
        return comps

    # 打印统计
    print(f"切分 {GX}x{GY}={GX*GY} 块 → 删外圈+侵蚀{ERODE} → 剩 {K} 块（整块连通，分量数={len(comps)}）")
    print(f"中心点 = ({C[0]:.0f}, {C[1]:.0f})，起始角 = {START:.0f}°")
    print(f"角度区间 = {[round(b) for b in angle_bounds]}°")
    print(f"三个地点格子数 = {counts}（权重 {SIZES}，理想比例 {[round(s/total*K) for s in SIZES]}）")
    for r in range(N):
        comps_r = region_components(r)
        ok = '✓' if len(comps_r) == 1 else f'✗{len(comps_r)}'
        print(f"  地点{r} 格子{counts[r]} 连通{ok}")

    # ASCII 预览
    COLS, ROWS = 110, 46
    grid = [[' '] * COLS for _ in range(ROWS)]
    def gx(x): return int(round(x / W * COLS))
    def gy(y): return int(round(y / H * ROWS))
    for li in range(K):
        poly = polys[kept[li]]
        r = assign[li]
        ch = 'ABC'[r]
        miny = max(0, min(gy(p[1]) for p in poly))
        maxy = min(ROWS - 1, max(gy(p[1]) for p in poly))
        for yy in range(miny, maxy + 1):
            yreal = (yy + 0.5) / ROWS * H
            xs = []
            for i in range(len(poly)):
                a, b = poly[i], poly[(i + 1) % len(poly)]
                if (a[1] <= yreal < b[1]) or (b[1] <= yreal < a[1]):
                    t = (yreal - a[1]) / (b[1] - a[1])
                    xs.append(a[0] + t * (b[0] - a[0]))
            xs.sort()
            for k in range(0, len(xs) - 1, 2):
                for xx in range(max(0, gx(xs[k])), min(COLS, gx(xs[k + 1])) + 1):
                    grid[yy][xx] = ch
    grid[gy(C[1])][gx(C[0])] = '*'
    print("\n" + "\n".join(''.join(row).rstrip() for row in grid))


if __name__ == '__main__':
    main()
