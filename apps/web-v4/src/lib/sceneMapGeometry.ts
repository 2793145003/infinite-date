import { Delaunay } from 'd3-delaunay';

// ── 场景地图几何计算（SceneMapScreen 与 SceneLocationDetail 共用）─────────────

// ── 类型（v4 版）─────────────────────────────────────────────
export interface SceneLocationInfo {
  id: string;
  name: string;
  summary: string;
  creatorType: 'system' | 'player' | 'character';
  creatorId: string | null;
  isPublic: boolean;
  parentId: string | null;
  path: string;
  hasChildren: boolean;
  npcs: any[];
  isHome: boolean;
  background: string;
  lotCount: number;
}

export type MapNpc = {
  characterId: string;
  name: string;
  avatarType?: 'image' | 'initial';
  avatar: string;
  visibility: 'friend' | 'stranger' | 'unknown';
  activity: string;
};

// 人物排序：好友 → 见过的人 → 陌生人
export const VIS_ORDER: Record<MapNpc['visibility'], number> = { friend: 0, stranger: 1, unknown: 2 };

/** 构建图片 URL（v4 经 /v4/api 前缀访问 v2 的 /uploads 静态资源） */
export function imageUrl(filename: string): string {
  if (!filename) return '';
  if (filename.startsWith('http') || filename.startsWith('data:') || filename.startsWith('/')) return filename;
  return `/v4/api/uploads/${filename}`;
}

/**
 * 可视化地图 —— Voronoi 凸块（块形状合理）+ 边界「大块随机凹凸」。
 * 每条边分成 3~5 个随机鼓包：方向（凹/凸）、幅度、宽度都随机，
 * 由边端点坐标 hash 决定，保证相邻块共享边严丝合缝。
 */

// ── 确定性 PRNG ──────────────────────────────────────────────
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const W = 1000;
export const H = 640;
export const PAD = 60;

export type Pt = [number, number];

// ── 几何工具 ────────────────────────────────────────────────

export function hash01(x: number, y: number, k = 0): number {
  return mulberry32(hashString(`${x}:${y}:${k}`))();
}

/** 凸包（Andrew 单调链，返回逆时针） */
export function convexHull(points: Pt[]): Pt[] {
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
export function expandHull(hull: Pt[], margin: number): Pt[] {
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
export function organicPath(poly: Pt[], amp: number): string {
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
export function polyToPath(poly: Pt[]): string {
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
export function ptKey(p: Pt): string {
  return `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
}

/** 规范边（字典序端点，保证共享边双向一致） */
export function canonEdge(a: Pt, b: Pt): [Pt, Pt] {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? [a, b] : [b, a];
}

/** 边列表 → 闭合环（区域外边界；假设简单环、顶点度 2） */
export function ringFromEdges(edges: [Pt, Pt][]): Pt[] {
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
export function centroid(poly: Pt[]): Pt {
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
export function polyArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** 射线法：点是否在多边形内 */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
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
export function segmentIntersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
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
export function clipSegmentToPolygon(a: Pt, b: Pt, poly: Pt[]): [Pt, Pt][] {
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
export function buildRings(edges: [Pt, Pt][]): Pt[][] {
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
export function polygonIntersect(subject: Pt[], clip: Pt[]): Pt[] {
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
export function makeBumpyContour(
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
export function distToHull(p: Pt, hullPts: Pt[]): number {
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
export function inwardDir(i: number, contour: Pt[]): Pt {
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
export function segIntersect(p: Pt, q: Pt, a: Pt, b: Pt): Pt | null {
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
export function rayToContour(P: Pt, d: Pt, contour: Pt[]): Pt | null {
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
export function bumpyLine(P: Pt, Q: Pt, rng: () => number, disp = 0.16, subdiv = 4): Pt[] {
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
export function makeOutline(seeds: Pt[]): Pt[] {
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

export interface VizCell {
  loc: SceneLocationInfo | null;
  poly: Pt[];
  path: string;
  cx: number;
  cy: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

export interface Block {
  poly: Pt[];
  path: string;
  cx: number;
  cy: number;
  area: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

export function polyBBox(poly: Pt[]): { minx: number; miny: number; maxx: number; maxy: number } {
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
export function voronoiPartition(
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
export function mapBlocksToCells(blocks: Block[], locs: SceneLocationInfo[], sizes: number[]): VizCell[] {
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
export function computeTopLayout(
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
export function makeFitTransform(
  bbox: { minx: number; miny: number; maxx: number; maxy: number },
  margin = 0.04,
): (p: Pt) => Pt {
  const sx = (W * (1 - 2 * margin)) / (bbox.maxx - bbox.minx || 1);
  const sy = (H * (1 - 2 * margin)) / (bbox.maxy - bbox.miny || 1);
  const ox = W * margin;
  const oy = H * margin;
  return (p) => [ox + (p[0] - bbox.minx) * sx, oy + (p[1] - bbox.miny) * sy];
}



/** 计算下钻到 drillIds 后当前层的图形（cells/boundary/boundaryLines），供地图主页与详情页共用 */
export function computeLevel(
  locations: SceneLocationInfo[],
  top: { outline: string; outlinePts: Pt[]; cells: VizCell[]; boundaryLines: [Pt, Pt][] },
  drillIds: string[],
): { cells: VizCell[]; boundaryLines: [Pt, Pt][]; boundary: string } {
  let rawCells = top.cells;
  let cells = top.cells;
  let boundary = top.outline;
  let boundaryLines = top.boundaryLines;
  let cumulativeFit: (p: Pt) => Pt = (p) => p;
  const ancestorPolys: Pt[][] = [];
  const outlinePts = top.outlinePts;

  for (const id of drillIds) {
    const parent = rawCells.find((c) => c.loc?.id === id);
    if (!parent || !parent.loc) break;
    const children = locations.filter((l) => l.parentId === parent.loc!.id);
    const lotCount = parent.loc.lotCount ?? 0;
    const slotCount = lotCount > 0 ? lotCount : children.length;
    // 叶子（无子地点、无位面格）：把叶子自身放大成单一 cell 铺满地图，而非停留在父层
    if (slotCount === 0) {
      const pb = polyBBox(parent.poly);
      const p0 = cumulativeFit([pb.minx, pb.miny]);
      const p1 = cumulativeFit([pb.maxx, pb.maxy]);
      const fitLayer = makeFitTransform({ minx: p0[0], miny: p0[1], maxx: p1[0], maxy: p1[1] });
      const prevFit = cumulativeFit;
      cumulativeFit = (p) => fitLayer(prevFit(p));

      const leafPoly = parent.poly.map(cumulativeFit);
      cells = [{
        ...parent,
        poly: leafPoly,
        path: polyToPath(leafPoly),
        cx: cumulativeFit([parent.cx, parent.cy])[0],
        cy: cumulativeFit([parent.cx, parent.cy])[1],
        bbox: {
          minx: cumulativeFit([pb.minx, pb.miny])[0],
          miny: cumulativeFit([pb.minx, pb.miny])[1],
          maxx: cumulativeFit([pb.maxx, pb.maxy])[0],
          maxy: cumulativeFit([pb.maxx, pb.maxy])[1],
        },
      }];
      boundary = polyToPath(leafPoly);
      boundaryLines = [];
      break; // 叶子已是最后一层，无需继续
    }
    const childSizes = children.map((c) => Math.max(locations.filter((l) => l.parentId === c.id).length, 1));
    const rng = mulberry32(hashString(parent.loc.id));
    const { blocks, boundaryLines: bl } = voronoiPartition(parent.poly, slotCount, rng, [outlinePts, ...ancestorPolys]);
    const newRawCells = mapBlocksToCells(blocks, children, childSizes);

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
}
