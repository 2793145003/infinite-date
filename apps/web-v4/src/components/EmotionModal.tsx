/**
 * 心绪弹窗 —— 短信里点头像打开
 *
 * 顶部：头像 / 名称 / 此刻心绪（最强那一维）
 * 中部：八维花瓣图（愉悦在最上方，顺时针：欲望 慌乱 失落 委屈 愤怒 占有欲 怜爱）
 * 底部：最近五轮「心率」曲线 —— 心率 = 当轮最强情绪强度映射（0→62bpm，100→160bpm），
 *       比干巴巴的 0-100 强度更直观，也更贴恋爱语境
 *
 * 纯 SVG 实现，无图表库依赖。
 */
import { useEffect, useState } from 'react';
import { api, type EmotionPanelData } from '../lib/api';
import { EMOTION_ORDER as ORDER, PETAL_COLORS, MAX_RATIO, BURST_FROM } from '../lib/emotionVisual';

/** 强度 → 心率：0 → 62bpm，100 → 160bpm */
const toBpm = (v: number) => Math.round(62 + (Math.max(0, Math.min(100, v)) / 100) * 98);

// viewBox 留足左右空间，否则外圈标签（「占有欲」等三字）会被裁掉
const CX = 125;
const CY = 112;
const R = 68;

/**
 * 强度 → 花瓣半径。88 分以下线性收缩在常规框内（所以平时花瓣都不大），
 * 88 分以上额外向外冲，最高到约 1.13R —— 明显突破常规满格框，形成「爆表」。
 */
function radiusOf(value: number): number {
  const v = Math.max(0, Math.min(100, value));
  let r = (v / 100) * MAX_RATIO * R;
  if (v >= BURST_FROM) {
    const t = (v - BURST_FROM) / (100 - BURST_FROM);
    r += t * R * 0.28;
  }
  return r;
}

/** 第 i 个轴、半径比例 ratio 处的坐标（0 号轴在正上方，顺时针） */
function polar(i: number, ratio: number): [number, number] {
  const ang = ((-90 + i * 45) * Math.PI) / 180;
  return [CX + Math.cos(ang) * R * ratio, CY + Math.sin(ang) * R * ratio];
}

/**
 * 单个花瓣的路径：从花心出发、最宽处在 55% 长度处、尖端落在强度对应的半径上。
 * 用两段二次贝塞尔拼成一片对称花瓣（比雷达多边形更像花）。
 */
function petalPath(i: number, value: number): string {
  const v = Math.max(0, Math.min(100, value));
  if (v < 1) return '';
  const L = radiusOf(v);
  const theta = ((-90 + i * 45) * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const px = -sin; // 垂直于花瓣方向的单位向量
  const py = cos;
  const w = L * 0.4; // 花瓣最大半宽（随长度缩放，短花瓣不会显胖）
  const bx = CX + cos * L * 0.55;
  const by = CY + sin * L * 0.55;
  const tipX = CX + cos * L;
  const tipY = CY + sin * L;
  return `M ${CX},${CY} Q ${(bx + px * w).toFixed(2)},${(by + py * w).toFixed(2)} ${tipX.toFixed(2)},${tipY.toFixed(2)} Q ${(bx - px * w).toFixed(2)},${(by - py * w).toFixed(2)} ${CX},${CY}`;
}

interface Props {
  /** 角色 id —— 心绪是角色级状态，短信和约会读的是同一份 */
  characterId: string;
  characterName: string;
  /** 已拼好 base 的头像 URL；空串表示无图 */
  avatar: string;
  isDeity?: boolean;
  onClose: () => void;
}

export function EmotionModal({ characterId, characterName, avatar, isDeity, onClose }: Props) {
  const [data, setData] = useState<EmotionPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    api
      .getCharacterEmotions(characterId)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [characterId]);

  const current = data?.current ?? null;
  const turns = data?.turns ?? [];
  const emo = current?.emotions ?? null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 backdrop-blur-sm px-5"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[340px] max-h-[88%] overflow-y-auto bg-panel rounded-3xl shadow-2xl border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 顶部：头像 / 名称 / 此刻心绪 ── */}
        <div className="relative px-5 pt-6 pb-4 flex flex-col items-center">
          <div className="w-16 h-16 rounded-full overflow-hidden border border-border-strong shadow-sm shrink-0">
            {isDeity ? (
              <div className="w-full h-full flex items-center justify-center bg-bg-amber-soft text-amber text-2xl">⚡</div>
            ) : avatar ? (
              <img src={avatar} alt={characterName} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-bg-muted-2 text-ink font-bold text-lg">
                {(characterName || '伴').slice(-1)}
              </div>
            )}
          </div>
          <div className="mt-2.5 text-[14px] font-bold text-ink tracking-tight">{characterName}</div>

          <div className="mt-3 text-center">
            <div className="text-[26px] font-bold leading-none text-rose tracking-wide">
              {loading ? '…' : failed ? '—' : current?.value ? current.cn : '平静'}
            </div>
            <div className="mt-1.5 text-[10px] text-ink-muted tracking-[0.2em]">此刻心绪</div>
          </div>
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-ink-muted">读取中…</div>
        ) : failed ? (
          <div className="py-10 text-center text-xs text-ink-muted">心绪读取失败</div>
        ) : !current ? (
          <div className="px-6 pb-8 pt-2 text-center text-xs text-ink-muted leading-relaxed">
            还没有心绪记录
            <br />
            <span className="text-ink-faint">给他发条短信，就知道他此刻的心情了</span>
          </div>

        ) : (
          <>
            {/* ── 花瓣图 ── */}
            <div className="px-3 pb-3">
              <svg viewBox="0 0 250 220" className="w-full h-auto">
                {/* 只留最外一圈：它就是他「满格」的基准线，花瓣冲出去即为爆表 */}
                <circle
                  cx={CX}
                  cy={CY}
                  r={MAX_RATIO * R}
                  fill="none"
                  stroke="var(--border, rgba(150,150,150,0.25))"
                  strokeWidth={1}
                  opacity={0.95}
                />
                {/* 花瓣：每种心绪一片、各自配色；强度为 0 就不长花瓣 */}
                {ORDER.map((e, i) => ({ e, i, v: Number(emo?.[e.key] ?? 0) }))
                  .sort((a, b) => a.v - b.v) // 弱的先画，最强的那片压在最上层
                  .map(({ e, i, v }) => {
                    const d = petalPath(i, v);
                    if (!d) return null;
                    const isTop = current.key === e.key;
                    const bursting = v >= BURST_FROM;
                    const [tipX, tipY] = polar(i, radiusOf(v) / R);
                    return (
                      <g key={e.key}>
                        <path
                          d={d}
                          fill={PETAL_COLORS[e.key]}
                          fillOpacity={bursting ? 0.62 : isTop ? 0.5 : 0.34}
                          stroke={PETAL_COLORS[e.key]}
                          strokeOpacity={isTop || bursting ? 1 : 0.75}
                          strokeWidth={isTop || bursting ? 1.6 : 1}
                          style={
                            bursting
                              ? {
                                  filter: `drop-shadow(0 0 9px ${PETAL_COLORS[e.key]}) drop-shadow(0 0 3px ${PETAL_COLORS[e.key]})`,
                                }
                              : isTop
                                ? { filter: `drop-shadow(0 0 6px ${PETAL_COLORS[e.key]}99)` }
                                : undefined
                          }
                        />
                        {/* 爆表火花：尖端脉动的光点 */}
                        {bursting && (
                          <circle cx={tipX} cy={tipY} r={2.6} fill="#fff">
                            <animate attributeName="r" values="2.2;4.4;2.2" dur="1.5s" repeatCount="indefinite" />
                            <animate attributeName="opacity" values="0.95;0.28;0.95" dur="1.5s" repeatCount="indefinite" />
                          </circle>
                        )}
                      </g>
                    );
                  })}
                {/* 维度标签 */}
                {ORDER.map((e, i) => {
                  const [x, y] = polar(i, 1.28);
                  const anchor = x < CX - 3 ? 'end' : x > CX + 3 ? 'start' : 'middle';
                  const isTop = current.key === e.key;
                  const bursting = Number(emo?.[e.key] ?? 0) >= BURST_FROM;
                  return (
                    <text
                      key={e.key}
                      x={x}
                      y={y}
                      textAnchor={anchor}
                      dominantBaseline="middle"
                      fontSize={isTop ? 11.5 : 10.5}
                      fontWeight={isTop ? 700 : 500}
                      fill={isTop ? PETAL_COLORS[e.key] : 'var(--text-dim, #8a8a8a)'}
                      opacity={isTop ? 1 : 0.9}
                      style={bursting ? { filter: `drop-shadow(0 0 5px ${PETAL_COLORS[e.key]})` } : undefined}
                    >
                      {e.cn}
                    </text>
                  );
                })}
                {/* 花心 */}
                <circle
                  cx={CX}
                  cy={CY}
                  r={3}
                  fill="var(--panel, #1a2030)"
                  stroke="var(--border-bright, #3d4868)"
                  strokeWidth={1}
                />
              </svg>
            </div>

            {/* ── 最近五轮心率 ── */}
            <div className="px-5 pt-1 pb-5">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-semibold text-ink-soft">最近五轮</span>
                <span className="text-[10px] text-ink-muted">心绪变化 · 心率</span>
              </div>

              {turns.length < 2 ? (
                <div className="mt-2.5 py-3 text-center text-[10px] text-ink-faint">
                  对话再多几轮，就能看到心绪的起伏了
                </div>
              ) : (
                <HeartChart turns={turns} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 心率折线：y 轴 55-170bpm，点按轮次等距 */
function HeartChart({ turns }: { turns: EmotionPanelData['turns'] }) {
  const W = 220;
  const H = 82;
  const padX = 18;
  const top = 12;
  const bottom = H - 16;
  const BPM_MIN = 55;
  const BPM_MAX = 170;
  const yOf = (bpm: number) => bottom - ((Math.max(BPM_MIN, Math.min(BPM_MAX, bpm)) - BPM_MIN) / (BPM_MAX - BPM_MIN)) * (bottom - top);
  const xOf = (i: number) => padX + (i * (W - padX * 2)) / Math.max(1, turns.length - 1);

  const pts = turns.map((t, i) => ({ x: xOf(i), y: yOf(toBpm(t.top.value)), bpm: toBpm(t.top.value), t }));
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${padX},${bottom} ${line} ${(W - padX).toFixed(1)},${bottom}`;
  const last = pts[pts.length - 1]!;

  return (
    <div className="mt-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        <defs>
          <linearGradient id="heartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--rose, #e88aa6)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--rose, #e88aa6)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* 基线 */}
        {[BPM_MIN, (BPM_MIN + BPM_MAX) / 2, BPM_MAX].map((b) => (
          <line
            key={b}
            x1={padX}
            x2={W - padX}
            y1={yOf(b)}
            y2={yOf(b)}
            stroke="var(--border, rgba(150,150,150,0.25))"
            strokeWidth={0.6}
            strokeDasharray={b === BPM_MIN ? '0' : '2 3'}
            opacity={0.5}
          />
        ))}

        <polygon points={area} fill="url(#heartFill)" />
        <polyline points={line} fill="none" stroke="var(--rose, #e88aa6)" strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" />

        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === pts.length - 1 ? 2.8 : 2}
            fill="var(--panel, #fff)"
            stroke="var(--rose, #e88aa6)"
            strokeWidth={1.4}
          />
        ))}

        {/* 最新一轮的心率数值 */}
        <text
          x={Math.min(last.x, W - padX - 2)}
          y={Math.max(last.y - 7, 9)}
          textAnchor="end"
          fontSize={9.5}
          fontWeight={700}
          fill="var(--rose, #e88aa6)"
        >
          {last.bpm}
        </text>
      </svg>

      <div className="flex items-center justify-between mt-0.5 px-1">
        <span className="text-[9px] text-ink-faint">← 更早</span>
        <span className="text-[9px] text-ink-faint">最近一轮 {last.bpm} bpm</span>
      </div>
    </div>
  );
}
