import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { Delaunay } from 'd3-delaunay';
import { api, imageUrl } from '../lib/api';
import type { SceneLocationInfo } from '../lib/api';
import { SceneSettingsModal } from './SceneLocation';

type MapNpc = {
  characterId: string;
  name: string;
  avatarType?: 'image' | 'initial';
  avatar: string;
  visibility: 'friend' | 'stranger' | 'unknown';
  activity: string;
};

// 人物排序：好友 → 见过的人 → 陌生人
const VIS_ORDER: Record<MapNpc['visibility'], number> = { friend: 0, stranger: 1, unknown: 2 };

/**
 * 可视化地图 —— Voronoi 凸块（块形状合理）+ 边界「大块随机凹凸」。
 * 每条边分成 3~5 个随机鼓包：方向（凹/凸）、幅度、宽度都随机，
 * 由边端点坐标 hash 决定，保证相邻块共享边严丝合缝。
 */

// ── 确定性 PRNG ──────────────────────────────────────────────
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 1000;
const H = 640;
const PAD = 60;

type Pt = [number, number];

// ── 几何工具 ────────────────────────────────────────────────

function hash01(x: number, y: number, k = 0): number {
  return mulberry32(hashString(`${x}:${y}:${k}`))();
}

/** 凸包（Andrew 单调链，返回逆时针） */
function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** 凸包向外膨胀（顶点沿质心方向外移） */
function expandHull(hull: Pt[], margin: number): Pt[] {
  if (hull.length < 3) return hull;
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * margin, y + (dy / len) * margin] as Pt;
  });
}

/**
 * 大块随机凹凸边界：每条边分成 3~5 个鼓包，每个鼓包方向（凹/凸）、
 * 幅度（0.6x~1.4x amp）随机，由边端点坐标 hash 决定（共享边双向一致）。
 */
function organicPath(poly: Pt[], amp: number): string {
  if (poly.length < 3) return '';
  const f = (n: number) => n.toFixed(1);
  const pts: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (!a || !b) continue;
    const edgeLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (edgeLen < 1) continue; // 跳过零长度边
    // 规范方向（字典序端点，独立于遍历顺序 → 共享边双向一致）
    const [a0, b0] = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
    const dx = b0[0] - a0[0];
    const dy = b0[1] - a0[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    // 随机分段数 3~5（由边端点决定）
    const K = 3 + Math.floor(hash01(Math.round(a0[0]), Math.round(a0[1]), 7) * 3);
    for (let j = 0; j <= K; j++) {
      const t = j / K;
      const px = a0[0] + dx * t;
      const py = a0[1] + dy * t;
      let off = 0;
      if (j > 0 && j < K) {
        const sign = hash01(Math.round(a0[0]), Math.round(a0[1]), j * 2) < 0.5 ? -1 : 1;
        const mag = (0.6 + hash01(Math.round(a0[0]), Math.round(a0[1]), j * 2 + 1) * 0.8) * amp;
        off = sign * mag;
      }
      pts.push([px + nx * off, py + ny * off]);
    }
  }
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    d += (i === 0 ? `M ${f(p[0])},${f(p[1])}` : ` L ${f(p[0])},${f(p[1])}`);
  }
  return d + ' Z';
}

/** 多边形 → SVG path（直线边界） */
function polyToPath(poly: Pt[]): string {
  if (poly.length < 3) return '';
  const f = (n: number) => n.toFixed(1);
  let d = '';
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    d += (i === 0 ? `M ${f(p[0])},${f(p[1])}` : ` L ${f(p[0])},${f(p[1])}`);
  }
  return d + ' Z';
}

/** 点 → key（2 位小数，用于边去重） */
function ptKey(p: Pt): string {
  return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
}

/** 规范边（字典序端点，保证共享边双向一致） */
function canonEdge(a: Pt, b: Pt): [Pt, Pt] {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
}

/** 边列表 → 闭合环（区域外边界；假设简单环、顶点度 2） */
function ringFromEdges(edges: [Pt, Pt][]): Pt[] {
  if (edges.length === 0) return [];
  const adj = new Map<string, Pt[]>();
  const push = (k: string, p: Pt) => adj.set(k, [...(adj.get(k) ?? []), p]);
  for (const [a, b] of edges) {
    push(ptKey(a), b);
    push(ptKey(b), a);
  }
  const ring: Pt[] = [edges[0]![0], edges[0]![1]];
  const visited = new Set<string>([ptKey(edges[0]![0]), ptKey(edges[0]![1])]);
  let cur = edges[0]![1];
  for (let guard = 0; guard < edges.length + 2; guard++) {
    const nexts = (adj.get(ptKey(cur)) ?? []).filter((p) => !visited.has(ptKey(p)));
    if (nexts.length === 0) break;
    const next = nexts[0]!;
    ring.push(next);
    visited.add(ptKey(next));
    cur = next;
    if (ptKey(next) === ptKey(ring[0]!)) break;
  }
  return ring;
}

/** 面积质心（凹多边形也落在块内） */
function centroid(poly: Pt[]): Pt {
  if (poly.length === 0) return [W / 2, H / 2];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i]!;
    const p1 = poly[(i + 1) % poly.length]!;
    const cross = p0[0] * p1[1] - p1[0] * p0[1];
    a += cross;
    cx += (p0[0] + p1[0]) * cross;
    cy += (p0[1] + p1[1]) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-6) return [W / 2, H / 2];
  return [cx / (6 * a), cy / (6 * a)];
}

/** 多边形面积（绝对值） */
function polyArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** 射线法：点是否在多边形内 */
function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  const [x, y] = p;
  let inside = false;
  const n = poly.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

/** 线段 ab 与线段 cd 求交（忽略端点相切），返回交点或 null */
function segmentIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom;
  if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) {
    return [a[0] + t * rx, a[1] + t * ry];
  }
  return null;
}

/** 线段 ab 被多边形 poly 裁剪，返回落在 poly 内的子段列表 */
function clipSegmentToPolygon(a: Pt, b: Pt, poly: Pt[]): [Pt, Pt][] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-6) return [];
  const ts: { t: number; p: Pt }[] = [{ t: 0, p: a }, { t: 1, p: b }];
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i]!;
    const d = poly[(i + 1) % poly.length]!;
    const inter = segmentIntersect(a, b, c, d);
    if (inter) ts.push({ t: Math.hypot(inter[0] - a[0], inter[1] - a[1]) / len, p: inter });
  }
  ts.sort((x, y) => x.t - y.t);
  const segs: [Pt, Pt][] = [];
  for (let i = 0; i < ts.length - 1; i++) {
    if (ts[i + 1]!.t - ts[i]!.t < 1e-6) continue;
    const mid: Pt = [(ts[i]!.p[0] + ts[i + 1]!.p[0]) / 2, (ts[i]!.p[1] + ts[i + 1]!.p[1]) / 2];
    if (pointInPolygon(mid, poly)) segs.push([ts[i]!.p, ts[i + 1]!.p]);
  }
  return segs;
}

/** 边列表 → 若干闭合环（顶点度按 2 处理；支持多环） */
function buildRings(edges: [Pt, Pt][]): Pt[][] {
  const unique = new Map<string, [Pt, Pt]>();
  for (const [a, b] of edges) {
    const [a0, b0] = canonEdge(a, b);
    const k = `${ptKey(a0)}_${ptKey(b0)}`;
    if (!unique.has(k)) unique.set(k, [a0, b0]);
  }
  const edgeList = [...unique.values()];
  if (edgeList.length === 0) return [];
  const adj = new Map<string, Pt[]>();
  for (const [a, b] of edgeList) {
    adj.set(ptKey(a), [...(adj.get(ptKey(a)) ?? []), b]);
    adj.set(ptKey(b), [...(adj.get(ptKey(b)) ?? []), a]);
  }
  const used = new Set<string>();
  const rings: Pt[][] = [];
  for (const [sa, sb] of edgeList) {
    if (used.has(`${ptKey(canonEdge(sa, sb)[0])}_${ptKey(canonEdge(sa, sb)[1])}`)) continue;
    const ring: Pt[] = [sa, sb];
    used.add(`${ptKey(canonEdge(sa, sb)[0])}_${ptKey(canonEdge(sa, sb)[1])}`);
    let cur = sb;
    let guard = 0;
    while (guard < edgeList.length + 2) {
      guard++;
      const prevKey = ptKey(ring[ring.length - 2]!);
      const nexts = (adj.get(ptKey(cur)) ?? []).filter((p) => ptKey(p) !== prevKey);
      if (nexts.length === 0) break;
      const next = nexts[0]!;
      const [c0, c1] = canonEdge(cur, next);
      const ek = `${ptKey(c0)}_${ptKey(c1)}`;
      if (used.has(ek)) break;
      used.add(ek);
      ring.push(next);
      cur = next;
      if (ptKey(next) === ptKey(ring[0]!)) break;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** 多边形交集 subject ∩ clip（取面积最大的环，用于把 Voronoi 环裁到轮廓内、去掉溢出假角） */
function polygonIntersect(subject: Pt[], clip: Pt[]): Pt[] {
  const edges: [Pt, Pt][] = [];
  for (let i = 0; i < subject.length; i++) {
    edges.push(...clipSegmentToPolygon(subject[i]!, subject[(i + 1) % subject.length]!, clip));
  }
  for (let i = 0; i < clip.length; i++) {
    edges.push(...clipSegmentToPolygon(clip[i]!, clip[(i + 1) % clip.length]!, subject));
  }
  const rings = buildRings(edges);
  if (rings.length === 0) return subject;
  return rings.reduce((best, r) => (polyArea(r) > polyArea(best) ? r : best), rings[0]!);
}

/**
 * 随机中点位移法生成分形海岸线外轮廓（移植并改造自 dsh 的 random_map.py）。
 * 初始骨架用「随机半径控制点」而非正弦波 → 总体轮廓不再是圆/椭圆，而是
 * 不对称的不规则大陆（有凸角、有缺口）；中点位移叠加细碎海岸线，位移幅度
 * 与边长成比例保证不自交。
 */
function makeBumpyContour(
  rng: () => number,
  nBlobs = 6,
  concavity = 0.55,
  rLo = 0.55,
  rHi = 1.4,
  margin = 0,
): Pt[] {
  const nCtrl = Math.max(4, nBlobs);
  const subdiv = 5;
  const jitter = 0.12;
  const disp = 0.18 + 0.25 * Math.max(0, Math.min(1, concavity));

  // 控制点：均匀角度 + 抖动，半径随机 → 总体形状不规整
  const angles: number[] = [];
  for (let i = 0; i < nCtrl; i++) {
    angles.push((i * 2 * Math.PI) / nCtrl + (rng() * 2 - 1) * jitter);
  }
  angles.sort((a, b) => a - b);
  const radii = angles.map(() => rLo + rng() * (rHi - rLo));
  let pts: Pt[] = angles.map((a, i) => [Math.cos(a) * radii[i]!, Math.sin(a) * radii[i]!]);

  // 中点位移细分（叠加细碎海岸线）
  for (let s = 0; s < subdiv; s++) {
    const m = pts.length;
    const newPts: Pt[] = [];
    for (let i = 0; i < m; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[(i + 1) % m]!;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const segLen = Math.hypot(dx, dy) || 1;
      const off = (rng() * 2 - 1) * segLen * disp;
      newPts.push([mx + (-dy / segLen) * off, my + (dx / segLen) * off]);
    }
    const merged: Pt[] = [];
    for (let i = 0; i < m; i++) {
      merged.push(pts[i]!);
      merged.push(newPts[i]!);
    }
    pts = merged;
  }

  // 确保逆时针（面积 > 0）
  let signed = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    signed += x1 * y2 - x2 * y1;
  }
  if (signed < 0) pts = pts.slice().reverse();

  // 缩放到画布并居中（留边距）
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minx = Math.min(...xs);
  const maxx = Math.max(...xs);
  const miny = Math.min(...ys);
  const maxy = Math.max(...ys);
  const wSpan = maxx - minx || 1;
  const hSpan = maxy - miny || 1;
  // 各向异性缩放：x/y 分别贴满画布，让大陆横向占满宽度（也占满高度），不再一边贴满另一边留白
  const scaleX = (W * (1 - 2 * margin)) / wSpan;
  const scaleY = (H * (1 - 2 * margin)) / hSpan;
  const cxs = (minx + maxx) / 2;
  const cys = (miny + maxy) / 2;
  return pts.map(([x, y]) => [
    Math.max(0, Math.min(W, W / 2 + (x - cxs) * scaleX)),
    Math.max(0, Math.min(H, H / 2 + (y - cys) * scaleY)),
  ]);
}

/** 点到凸包边的最近距离（衡量凹陷深度） */
function distToHull(p: Pt, hullPts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < hullPts.length; i++) {
    const a = hullPts[i]!;
    const b = hullPts[(i + 1) % hullPts.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

/** 凹角向内方向（角平分线取反，指向大陆内部） */
function inwardDir(i: number, contour: Pt[]): Pt {
  const n = contour.length;
  const P = contour[i]!;
  const A = contour[(i - 1 + n) % n]!;
  const B = contour[(i + 1) % n]!;
  const l1 = Math.hypot(A[0] - P[0], A[1] - P[1]) || 1;
  const l2 = Math.hypot(B[0] - P[0], B[1] - P[1]) || 1;
  const dx = -((A[0] - P[0]) / l1 + (B[0] - P[0]) / l2) / 2;
  const dy = -((A[1] - P[1]) / l1 + (B[1] - P[1]) / l2) / 2;
  const L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

/** 线段求交 */
function segIntersect(p: Pt, q: Pt, a: Pt, b: Pt): Pt | null {
  const dx1 = q[0] - p[0];
  const dy1 = q[1] - p[1];
  const dx2 = b[0] - a[0];
  const dy2 = b[1] - a[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((a[0] - p[0]) * dy2 - (a[1] - p[1]) * dx2) / denom;
  const s = ((a[0] - p[0]) * dy1 - (a[1] - p[1]) * dx1) / denom;
  if (t >= 0 && t <= 1 && s >= 0 && s <= 1) return [p[0] + t * dx1, p[1] + t * dy1];
  return null;
}

/** 射线与轮廓求交（取最近交点） */
function rayToContour(P: Pt, d: Pt, contour: Pt[]): Pt | null {
  const far: Pt = [P[0] + d[0] * 5000, P[1] + d[1] * 5000];
  let best: Pt | null = null;
  let bd = Infinity;
  for (let i = 0; i < contour.length; i++) {
    const hit = segIntersect(P, far, contour[i]!, contour[(i + 1) % contour.length]!);
    if (hit) {
      const dd = Math.hypot(hit[0] - P[0], hit[1] - P[1]);
      if (dd > 1 && dd < bd) {
        bd = dd;
        best = hit;
      }
    }
  }
  return best;
}

/** 凹凸分割线（开放折线中点位移，呼应海岸线起伏） */
function bumpyLine(P: Pt, Q: Pt, rng: () => number, disp = 0.16, subdiv = 4): Pt[] {
  let pts: Pt[] = [P, Q];
  for (let s = 0; s < subdiv; s++) {
    const m = pts.length;
    const newPts: Pt[] = [];
    for (let i = 0; i < m - 1; i++) {
      const [x1, y1] = pts[i]!;
      const [x2, y2] = pts[i + 1]!;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const sl = Math.hypot(dx, dy) || 1;
      const off = (rng() * 2 - 1) * sl * disp;
      newPts.push([mx + (-dy / sl) * off, my + (dx / sl) * off]);
    }
    const merged: Pt[] = [pts[0]!];
    for (let i = 0; i < m - 1; i++) {
      merged.push(newPts[i]!);
      merged.push(pts[i + 1]!);
    }
    pts = merged;
  }
  return pts;
}



/** 外轮廓（n>=3 凸包+膨胀；n<3 椭圆兜底） */
function makeOutline(seeds: Pt[]): Pt[] {
  if (seeds.length >= 3) return expandHull(convexHull(seeds), 42);
  const cx = seeds.reduce((s, p) => s + p[0], 0) / Math.max(seeds.length, 1);
  const cy = seeds.reduce((s, p) => s + p[1], 0) / Math.max(seeds.length, 1);
  const rx = seeds.length <= 1 ? 220 : Math.max(...seeds.map((p) => Math.abs(p[0] - cx))) + 130;
  const ry = seeds.length <= 1 ? 150 : Math.max(...seeds.map((p) => Math.abs(p[1] - cy))) + 110;
  const pts: Pt[] = [];
  const N = 12;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

interface VizCell {
  loc: SceneLocationInfo | null;
  poly: Pt[];
  path: string;
  cx: number;
  cy: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

interface Block {
  poly: Pt[];
  path: string;
  cx: number;
  cy: number;
  area: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

function polyBBox(poly: Pt[]): { minx: number; miny: number; maxx: number; maxy: number } {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const [x, y] of poly) {
    if (x < minx) minx = x;
    if (y < miny) miny = y;
    if (x > maxx) maxx = x;
    if (y > maxy) maxy = y;
  }
  return { minx, miny, maxx, maxy };
}

/**
 * 通用 Voronoi 分区：在 boundaryPoly 内撒种子，Lloyd 松弛到 N 个锚点，合并成 N 块。
 * clipPolys = 祖先链（种子必须落在所有这些多边形内，保证多层下钻时子块不越出祖先区域）。
 */
function voronoiPartition(
  boundaryPoly: Pt[],
  N: number,
  rng: () => number,
  clipPolys: Pt[][] = [],
): { blocks: Block[]; boundaryLines: [Pt, Pt][] } {
  const bbox = polyBBox(boundaryPoly);
  const bw = bbox.maxx - bbox.minx || 1;
  const bh = bbox.maxy - bbox.miny || 1;
  const inside = (p: Pt) =>
    pointInPolygon(p, boundaryPoly) && clipPolys.every((cp) => pointInPolygon(p, cp));

  // 1. 种子 rejection sampling（只撒在 boundaryPoly ∩ 祖先内）
  const TARGET = 120;
  const seeds: Pt[] = [];
  let guard = 0;
  while (seeds.length < TARGET && guard < 20000) {
    guard++;
    const p: Pt = [bbox.minx + rng() * bw, bbox.miny + rng() * bh];
    if (inside(p)) seeds.push(p);
  }

  // 2. Voronoi（bounds 外扩 300，边缘 cell 完整闭合；溢出部分渲染时用 clipPath 裁掉）
  const M = 300;
  const delaunay = Delaunay.from(seeds);
  const voronoi = delaunay.voronoi([bbox.minx - M, bbox.miny - M, bbox.maxx + M, bbox.maxy + M]);
  const cellPolys: Pt[][] = seeds.map((_, i) => voronoi.cellPolygon(i) ?? []);

  // 3. N 个锚点 + Lloyd 松弛到势力范围中心
  const anchors: Pt[] = [];
  {
    let g = 0;
    while (anchors.length < N && g < 10000) {
      g++;
      const p: Pt = [bbox.minx + rng() * bw, bbox.miny + rng() * bh];
      if (inside(p)) anchors.push(p);
    }
  }
  const nearestAnchor = (p: Pt): number => {
    let bi = 0;
    let bd = Infinity;
    for (let k = 0; k < anchors.length; k++) {
      const d = Math.hypot(p[0] - anchors[k]![0], p[1] - anchors[k]![1]);
      if (d < bd) {
        bd = d;
        bi = k;
      }
    }
    return bi;
  };
  for (let it = 0; it < 15; it++) {
    const tmp = seeds.map(nearestAnchor);
    for (let k = 0; k < N; k++) {
      const cell = seeds.filter((_, j) => tmp[j] === k);
      if (cell.length) {
        anchors[k] = [
          cell.reduce((s, p) => s + p[0], 0) / cell.length,
          cell.reduce((s, p) => s + p[1], 0) / cell.length,
        ];
      }
    }
  }

  // 4. 合并同锚点 cell → N 块
  const assign: number[] = seeds.map(nearestAnchor);
  const blocks: Block[] = [];
  for (let r = 0; r < N; r++) {
    const cellIdx: number[] = [];
    assign.forEach((a, i) => {
      if (a === r) cellIdx.push(i);
    });
    if (cellIdx.length === 0) continue;

    const edgeCount = new Map<string, { a: Pt; b: Pt; count: number }>();
    for (const ci of cellIdx) {
      const poly = cellPolys[ci]!;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
        const [a0, b0] = canonEdge(a, b);
        const key = `${ptKey(a0)}_${ptKey(b0)}`;
        const e = edgeCount.get(key);
        if (e) e.count++;
        else edgeCount.set(key, { a: a0, b: b0, count: 1 });
      }
    }
    const boundaryEdges: [Pt, Pt][] = [];
    for (const e of edgeCount.values()) if (e.count === 1) boundaryEdges.push([e.a, e.b]);
    const rawRing = ringFromEdges(boundaryEdges);
    // 裁到边界多边形内：去掉 Voronoi cell 延伸到计算边界（外扩 300）的假角，得到干净轮廓
    const ring = polygonIntersect(rawRing, boundaryPoly);
    const path = polyToPath(ring);
    const cx = cellIdx.reduce((s, ci) => s + seeds[ci]![0], 0) / cellIdx.length;
    const cy = cellIdx.reduce((s, ci) => s + seeds[ci]![1], 0) / cellIdx.length;
    let sx0 = Infinity;
    let sy0 = Infinity;
    let sx1 = -Infinity;
    let sy1 = -Infinity;
    for (const ci of cellIdx) {
      const s = seeds[ci]!;
      if (s[0] < sx0) sx0 = s[0];
      if (s[0] > sx1) sx1 = s[0];
      if (s[1] < sy0) sy0 = s[1];
      if (s[1] > sy1) sy1 = s[1];
    }
    blocks.push({ poly: ring, path, cx, cy, area: cellIdx.length, bbox: { minx: sx0, miny: sy0, maxx: sx1, maxy: sy1 } });
  }

  // 5. 分界线：相邻 block 之间的 Voronoi 共享边（只画一次）
  const globalEdges = new Map<string, { a: Pt; b: Pt; blocks: Set<number> }>();
  for (let ci = 0; ci < seeds.length; ci++) {
    const poly = cellPolys[ci]!;
    const blk = assign[ci]!;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
      const [a0, b0] = canonEdge(a, b);
      const key = `${ptKey(a0)}_${ptKey(b0)}`;
      const e = globalEdges.get(key);
      if (e) e.blocks.add(blk);
      else globalEdges.set(key, { a: a0, b: b0, blocks: new Set([blk]) });
    }
  }
  const boundaryLines: [Pt, Pt][] = [];
  for (const e of globalEdges.values()) {
    if (e.blocks.size >= 2) boundaryLines.push([e.a, e.b]);
  }

  return { blocks, boundaryLines };
}

/** 面积降序映射到 locs（sizes 大的地点拿大块）；locs 不够时剩余块作为空户（loc=null） */
function mapBlocksToCells(blocks: Block[], locs: SceneLocationInfo[], sizes: number[]): VizCell[] {
  const order = locs.map((_, i) => i).sort((a, b) => (sizes[b] ?? 0) - (sizes[a] ?? 0));
  blocks.sort((a, b) => b.area - a.area);
  const cells: VizCell[] = [];
  blocks.forEach((blk, k) => {
    const loc = locs[order[k]!] ?? null;
    cells.push({ loc, poly: blk.poly, path: blk.path, cx: blk.cx, cy: blk.cy, bbox: blk.bbox });
  });
  return cells;
}

/** 顶层布局：分形海岸线大陆 + Voronoi 分区 + 面积映射 */
function computeTopLayout(
  roots: SceneLocationInfo[],
  sizes: number[],
): { outline: string; outlinePts: Pt[]; cells: VizCell[]; boundaryLines: [Pt, Pt][] } {
  const N = roots.length;
  if (N === 0) return { outline: '', outlinePts: [], cells: [], boundaryLines: [] };

  const rng = mulberry32(hashString('map-fractal-v1'));
  const outlinePts = makeBumpyContour(rng, 6, 0.55, 0.55, 1.4, 0.04);
  const outline = polyToPath(outlinePts);
  const { blocks, boundaryLines } = voronoiPartition(outlinePts, N, rng);
  const cells = mapBlocksToCells(blocks, roots, sizes);

  return { outline, outlinePts, cells, boundaryLines };
}

/** 仿射变换：把 bbox 各向异性拉伸贴满画布（margin 与顶层 makeBumpyContour 一致），供下钻层把父区域放大到全屏 */
function makeFitTransform(
  bbox: { minx: number; miny: number; maxx: number; maxy: number },
  margin = 0.04,
): (p: Pt) => Pt {
  const sx = (W * (1 - 2 * margin)) / (bbox.maxx - bbox.minx || 1);
  const sy = (H * (1 - 2 * margin)) / (bbox.maxy - bbox.miny || 1);
  const ox = W * margin;
  const oy = H * margin;
  return (p) => [ox + (p[0] - bbox.minx) * sx, oy + (p[1] - bbox.miny) * sy];
}


export function SceneMapViz({
  onBack,
  onOpenLocation,
  onToggleView,
  onExplore,
}: {
  onBack: () => void;
  onOpenLocation: (locationId: string) => void;
  onToggleView?: () => void;
  onExplore: (locationId: string, locationName: string) => void;
}) {
  const [locations, setLocations] = useState<SceneLocationInfo[]>([]);
  const [npcs, setNpcs] = useState<Record<string, MapNpc[]>>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drillIds, setDrillIds] = useState<string[]>([]);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const clipId = useId();

  const loadData = () => {
    Promise.all([api.sceneLocations(), api.sceneMapNpcs()])
      .then(([locData, npcData]) => {
        setLocations(locData.locations);
        setNpcs(npcData.locations);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  // 顶层 = parentId 为空的节点；父级不可见（被权限过滤/私有）的地点及其后代一律不显示
  const roots = useMemo(
    () => locations.filter((l) => !l.parentId),
    [locations],
  );
  const sizes = useMemo(
    () => roots.map((r) => Math.max(locations.filter((l) => l.parentId === r.id).length, 1)),
    [roots, locations],
  );
  const top = useMemo(() => computeTopLayout(roots, sizes), [roots, sizes]);
  const outline = top.outline;
  const outlinePts = top.outlinePts;

  // 当前层：顶层直接用 top；下钻时逐层从大陆坐标重新切子区域，并累积仿射变换把父区域拉伸铺满全屏
  // （viewBox 恒为 1000×640，留白/位置/比例都和顶层一致）
  const level = useMemo(() => {
    let rawCells = top.cells; // 大陆坐标（供下一层撒种子）
    let cells = top.cells; // 显示坐标（顶层 = 大陆坐标）
    let boundary = outline;
    let boundaryLines = top.boundaryLines;
    let cumulativeFit: (p: Pt) => Pt = (p) => p;
    const ancestorPolys: Pt[][] = []; // 祖先 poly（大陆坐标），限制种子不越出祖先

    for (const id of drillIds) {
      const parent = rawCells.find((c) => c.loc?.id === id);
      if (!parent || !parent.loc) break;
      const children = locations.filter((l) => l.parentId === parent.loc!.id);
      const lotCount = parent.loc.lotCount ?? 0;
      // 位面住宅区（lotCount>0）：切成 lotCount 块，真实子地点占前几块，其余空户；普通地点按子地点数切
      const slotCount = lotCount > 0 ? lotCount : children.length;
      if (slotCount === 0) break;
      const childSizes = children.map((c) => Math.max(locations.filter((l) => l.parentId === c.id).length, 1));
      const rng = mulberry32(hashString(parent.loc.id));
      const { blocks, boundaryLines: bl } = voronoiPartition(parent.poly, slotCount, rng, [outlinePts, ...ancestorPolys]);
      const newRawCells = mapBlocksToCells(blocks, children, childSizes); // 大陆坐标

      // 本层 fit：把「累积变换后的父轮廓 bbox」拉伸铺满画布（margin 0.04，与顶层一致）
      const pb = polyBBox(parent.poly);
      const p0 = cumulativeFit([pb.minx, pb.miny]);
      const p1 = cumulativeFit([pb.maxx, pb.maxy]);
      const fitLayer = makeFitTransform({ minx: p0[0], miny: p0[1], maxx: p1[0], maxy: p1[1] });
      const prevFit = cumulativeFit;
      cumulativeFit = (p) => fitLayer(prevFit(p));

      cells = newRawCells.map((c) => ({
        ...c,
        poly: c.poly.map(cumulativeFit),
        path: polyToPath(c.poly.map(cumulativeFit)),
        cx: cumulativeFit([c.cx, c.cy])[0],
        cy: cumulativeFit([c.cx, c.cy])[1],
        bbox: {
          minx: cumulativeFit([c.bbox.minx, c.bbox.miny])[0],
          miny: cumulativeFit([c.bbox.minx, c.bbox.miny])[1],
          maxx: cumulativeFit([c.bbox.maxx, c.bbox.maxy])[0],
          maxy: cumulativeFit([c.bbox.maxx, c.bbox.maxy])[1],
        },
      }));
      boundary = polyToPath(parent.poly.map(cumulativeFit));
      boundaryLines = bl.map(([a, b]) => [cumulativeFit(a), cumulativeFit(b)] as [Pt, Pt]);
      rawCells = newRawCells;
      ancestorPolys.push(parent.poly);
    }

    return { cells, boundaryLines, boundary };
  }, [drillIds, top, locations, outlinePts]);

  const cells = level.cells;
  const selected = cells.find((c) => c.loc?.id === selectedId) ?? null;
  // 下方地点卡片列表：选中的地点置顶，其余保持地图顺序
  const listCells = useMemo(() => {
    if (!selected) return cells;
    return [selected, ...cells.filter((c) => c !== selected)];
  }, [cells, selected]);
  // 「列表地图」地点卡片：聚合某地点（含全部后代）里的角色，按「好友 → 见过的人 → 陌生人」排序
  const collectChars = (rootId: string): MapNpc[] => {
    const seen = new Map<string, MapNpc>();
    const walk = (id: string) => {
      for (const n of npcs[id] ?? []) {
        if (!seen.has(n.characterId)) seen.set(n.characterId, n);
      }
      for (const l of locations) {
        if (l.parentId === id) walk(l.id);
      }
    };
    walk(rootId);
    return [...seen.values()].sort((a, b) => VIS_ORDER[a.visibility] - VIS_ORDER[b.visibility]);
  };
  const boundaryPath = useMemo(
    () =>
      level.boundaryLines
        .map(([a, b]) => `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}`)
        .join(' '),
    [level.boundaryLines],
  );

  const breadcrumbs = useMemo(
    () => drillIds.map((id) => locations.find((l) => l.id === id)).filter((l): l is SceneLocationInfo => !!l),
    [drillIds, locations],
  );
  // 进入某地点：有子地点就下钻，没有就打开详情；位面（lotCount>0）即使当前没子地点也可下钻看分割块
  const enterLoc = (loc: SceneLocationInfo) => {
    if (loc.hasChildren || (loc.lotCount ?? 0) > 0) {
      setDrillIds((prev) => [...prev, loc.id]);
      setSelectedId(null);
    } else {
      onOpenLocation(loc.id);
    }
  };

  const gotoDepth = (depth: number) => {
    setDrillIds((prev) => prev.slice(0, depth));
    setSelectedId(null);
  };

  return (
    <div className="id-app scv-page">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">地图</span>
        {onToggleView && (
          <button className="scv-toggle" onClick={onToggleView}>列表</button>
        )}
      </div>
      <div className="id-app-scroll">
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : roots.length === 0 ? (
          <div className="id-empty"><span>🍃</span><span>还没有地点</span></div>
        ) : (
          <>
            {breadcrumbs.length > 0 && (
              <div className="scv-breadcrumb">
                <button className="scv-crumb" onClick={() => gotoDepth(0)}>主城</button>
                {breadcrumbs.map((loc, i) => (
                  <Fragment key={loc.id}>
                    <span className="scv-crumb-sep">›</span>
                    <button
                      className={`scv-crumb${i === breadcrumbs.length - 1 ? ' scv-crumb-cur' : ''}`}
                      onClick={() => gotoDepth(i + 1)}
                    >
                      {loc.name}
                    </button>
                  </Fragment>
                ))}
              </div>
            )}
            <div className="scv-stage">
              <svg viewBox={`0 0 ${W} ${H}`} className="scv-svg" role="img" aria-label="主城地图">
                <defs>
                  <clipPath id={clipId}>
                    <path d={level.boundary} />
                  </clipPath>
                  {cells.filter((c) => c.loc?.background).map((cell) => (
                    <clipPath key={cell.loc!.id} id={`bg-${cell.loc!.id}`}>
                      <path d={cell.path} />
                    </clipPath>
                  ))}
                </defs>

                {/* 当前层边界描边（顶层 = 大陆轮廓，下钻 = 父区域拉伸后的轮廓） */}
                <path d={level.boundary} fill="transparent" stroke="var(--border)" strokeWidth={4} />

                {/* 区域块 + 分界线（clip 到当前层边界） */}
                <g clipPath={`url(#${clipId})`}>
                  {cells.map((cell, i) => {
                    const loc = cell.loc;
                    if (!loc) {
                      // 空户占位块：淡灰、不可点击、无标签
                      return (
                        <g key={`lot-empty-${i}`} className="scv-cell scv-cell-empty">
                          <path
                            d={cell.path}
                            fill="rgba(255, 255, 255, 0.05)"
                            stroke="var(--border)"
                            strokeOpacity={0.6}
                            strokeWidth={2}
                            strokeLinejoin="round"
                          />
                        </g>
                      );
                    }
                    const isSel = loc.id === selectedId;
                    const bg = loc.background;
                    const bb = bg ? polyBBox(cell.poly) : null;
                    return (
                      <g
                        key={loc.id}
                        className="scv-cell"
                        onClick={() => setSelectedId(isSel ? null : loc.id)}
                      >
                        <path
                          d={cell.path}
                          fill="var(--accent)"
                          fillOpacity={isSel ? 0.3 : 0.18}
                          stroke="none"
                        />
                        {bg && bb && (
                          <g clipPath={`url(#bg-${loc.id})`}>
                            <image
                              href={imageUrl(bg)}
                              x={bb.minx}
                              y={bb.miny}
                              width={bb.maxx - bb.minx}
                              height={bb.maxy - bb.miny}
                              preserveAspectRatio="xMidYMid slice"
                              style={{ filter: 'brightness(0.4) saturate(1.1)' }}
                            />
                          </g>
                        )}
                        {isSel && (
                          <path d={cell.path} fill="none" stroke="var(--accent)" strokeOpacity={1} strokeWidth={4} strokeLinejoin="round" />
                        )}
                      </g>
                    );
                  })}
                  <path d={boundaryPath} fill="none" stroke="var(--border)" strokeOpacity={0.55} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
                </g>

                {/* 名字标签（浮在块上方，不被轮廓裁剪） */}
                {cells.map((cell) => {
                  if (!cell.loc) return null;
                  const isSel = cell.loc.id === selectedId;
                  return (
                    <g key={cell.loc.id} transform={`translate(${cell.cx}, ${cell.cy})`} style={{ pointerEvents: 'none' }}>
                      <rect x={-120} y={-23} width={240} height={46} rx={12} className={`scv-label-bg ${isSel ? 'scv-label-sel' : ''}`} />
                      <text textAnchor="middle" dominantBaseline="central" className={`scv-label-text ${isSel ? 'scv-label-sel' : ''}`}>
                        {cell.loc.name}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="scv-info">
              {!selected && (
                <button className="id-scene-settings-btn" onClick={() => setShowSettings(true)}>
                  {breadcrumbs.length > 0 ? '⚙️ 场景设置' : '➕ 新建子地点'}
                </button>
              )}
              <div className="id-map-list">
                {listCells.map((cell) => {
                  const loc = cell.loc;
                  if (!loc) return null;
                  const isSel = loc.id === selectedId;
                  const locChars = collectChars(loc.id);
                  return (
                    <button
                      key={loc.id}
                      className={`id-map-card unlocked${isSel ? ' scv-card-sel' : ''}`}
                      onClick={() => setSelectedId(isSel ? null : loc.id)}
                    >
                      {loc.background && (
                        <div className="id-map-card-bg" style={{ backgroundImage: `url(${imageUrl(loc.background)})` }} aria-hidden />
                      )}
                      <div className="id-map-info">
                        <div className="id-map-name">
                          {loc.name}
                          {loc.creatorType === 'player' && (
                            <span className="id-map-tag">{loc.isPublic ? '公开' : '私有'}</span>
                          )}
                        </div>
                        <div className="id-map-desc">{loc.summary || '一个地方'}</div>
                        {(locChars.length > 0 || loc.npcs.length > 0) && (
                          <div className="id-map-npcs">
                            {locChars.map((n) => (
                              <button
                                key={n.characterId}
                                className="id-map-npc-tag"
                                title={`查看${n.name}的行程`}
                                onClick={(e) => { e.stopPropagation(); setScheduleCharId(n.characterId); }}
                              >
                                <span className="id-map-npc-avatar">
                                  {n.avatarType === 'image' && n.avatar ? (
                                    <img src={imageUrl(n.avatar)} alt="" className="id-map-npc-avatar-img" />
                                  ) : (
                                    n.name?.charAt(0) ?? '?'
                                  )}
                                </span>
                                {n.visibility === 'unknown' ? '?' : n.name}
                              </button>
                            ))}
                            {loc.npcs.map((n) => (
                              <span key={n.id} className="id-map-npc-tag">
                                <span className="id-map-npc-avatar">{n.name.charAt(0)}</span>
                                {n.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="id-map-action" onClick={(e) => { e.stopPropagation(); enterLoc(loc); }}>进入</div>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
      {scheduleCharId && (
        <SceneScheduleModal characterId={scheduleCharId} onClose={() => setScheduleCharId(null)} />
      )}
      {showSettings && (
        <SceneSettingsModal
          loc={(selected?.loc ?? (breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1] : null)) ?? null}
          onClose={() => setShowSettings(false)}
          onChanged={loadData}
        />
      )}
    </div>
  );
}

export function SceneScheduleModal({ characterId, onClose }: { characterId: string; onClose: () => void }) {
  const [data, setData] = useState<{
    characterName: string;
    current: { locationName: string; activity: string; startTime: number; duration: number } | null;
    upcoming: { locationName: string; activity: string; startTime: number; duration: number }[];
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getSceneNpcSchedule(characterId).then(setData).catch((e) => {
      setError((e as Error).message);
    });
  }, [characterId]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="id-modal-overlay" onClick={onClose}>
      <div className="id-modal" onClick={(e) => e.stopPropagation()}>
        {error ? (
          <>
            <div className="id-modal-title">查看失败</div>
            <div className="id-modal-error">{error}</div>
            <div className="id-modal-actions">
              <button className="id-btn primary" onClick={onClose}>关闭</button>
            </div>
          </>
        ) : !data ? (
          <div className="id-loading">加载中…</div>
        ) : (
          <>
            <div className="id-modal-title">{data.characterName}的行程</div>
            {data.current ? (
              <div className="id-schedule-current">
                <div className="id-schedule-now">现在</div>
                <div className="id-schedule-loc">{data.current.locationName}</div>
                <div className="id-schedule-act">{data.current.activity}</div>
              </div>
            ) : (
              <div className="id-schedule-current">
                <div className="id-schedule-now">不在主城</div>
              </div>
            )}
            {data.upcoming.length > 0 && (
              <div className="id-schedule-upcoming">
                <div className="id-schedule-section-title">接下来</div>
                {data.upcoming.map((u, i) => (
                  <div key={i} className="id-schedule-row">
                    <span className="id-schedule-time">{formatTime(u.startTime)}</span>
                    <span className="id-schedule-loc">{u.locationName}</span>
                    <span className="id-schedule-act">{u.activity}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="id-modal-actions">
              <button className="id-btn primary" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
