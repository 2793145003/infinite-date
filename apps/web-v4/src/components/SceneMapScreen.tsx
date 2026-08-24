import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Home } from 'lucide-react';
import {
  SceneLocationInfo,
  MapNpc,
  Pt,
  VizCell,
  imageUrl,
  VIS_ORDER,
  W,
  H,
  computeTopLayout,
  computeLevel,
  mulberry32,
  hashString,
  voronoiPartition,
  mapBlocksToCells,
  makeFitTransform,
  polyBBox,
  polyToPath,
  makeBumpyContour,
} from '../lib/sceneMapGeometry';

export const SceneMapScreen: React.FC<{
  onBack: () => void;
  onOpenLocation: (locationId: string) => void;
  onExplore: (locationId: string, locationName: string) => void;
}> = ({ onBack, onOpenLocation, onExplore }) => {
  const [locations, setLocations] = useState<SceneLocationInfo[]>([]);
  const [npcs, setNpcs] = useState<Record<string, MapNpc[]>>({});
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drillIds, setDrillIds] = useState<string[]>([]);
  const [scheduleCharId, setScheduleCharId] = useState<string | null>(null);
  const rawClipId = useId();
  const clipId = rawClipId.replace(/[^a-zA-Z0-9_-]/g, '');

  const loadData = () => {
    Promise.all([
      fetch('/v4/api/scene/locations').then((r) => r.json()),
      fetch('/v4/api/scene/map/npcs').then((r) => r.json()),
    ])
      .then(([locData, npcData]) => {
        setLocations(locData.locations ?? []);
        setNpcs(npcData.locations ?? {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadData();
  }, []);

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
  const level = useMemo(
    () => computeLevel(locations, top, drillIds),
    [drillIds, top, locations],
  );

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
  // 进入某地点：统一打开详情页（含图形地图 + 简介/人员/邀请 + 子地图卡片）
  const enterLoc = (loc: SceneLocationInfo) => {
    onOpenLocation(loc.id);
  };

  const gotoDepth = (depth: number) => {
    setDrillIds((prev) => prev.slice(0, depth));
    setSelectedId(null);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="px-3.5 py-2.5 flex items-center justify-between shrink-0 sticky top-0 z-30">
        <div className="flex items-center gap-2.5">
          <button
            onClick={onBack}
            className="p-1 -ml-1 text-ink rounded-lg hover:bg-bg-muted transition cursor-pointer"
            aria-label="返回"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="text-[15px] font-bold text-ink tracking-tight">地图</h1>
        </div>
        <span className="text-[11px] text-ink-muted">
          {loading ? '加载中…' : `${locations.length} 个地点`}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-[81px]">
        {loading ? (
          <div className="text-center text-ink-muted text-xs py-10">加载中…</div>
        ) : roots.length === 0 ? (
          <div className="text-center text-ink-muted text-xs py-10">
            <span className="block text-2xl mb-2">🍃</span>
            还没有地点
          </div>
        ) : (
          <>
            {breadcrumbs.length > 0 && (
              <div className="flex items-center gap-1 overflow-x-auto pb-2 px-1 -mx-1">
                <button
                  onClick={() => gotoDepth(0)}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] text-ink-muted frosted-glass transition cursor-pointer hover:bg-bg-muted hover:text-ink"
                >
                  <Home className="w-3 h-3" />
                  主城
                </button>
                {breadcrumbs.map((loc, i) => (
                  <Fragment key={loc.id}>
                    <ChevronRight className="w-3 h-3 text-ink-faint shrink-0" />
                    <button
                      onClick={() => gotoDepth(i + 1)}
                      className={`shrink-0 px-2 py-1 rounded-full text-[11px] transition cursor-pointer ${
                        i === breadcrumbs.length - 1
                          ? 'bg-cyan text-ink-on'
                          : 'text-ink-muted frosted-glass hover:bg-bg-muted hover:text-ink'
                      }`}
                    >
                      {loc.name}
                    </button>
                  </Fragment>
                ))}
              </div>
            )}

            <div className="rounded-2xl frosted-glass overflow-hidden shadow-2xs">
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label="主城地图">
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
                <path d={level.boundary} fill="transparent" stroke="var(--color-ink)" strokeOpacity={0.7} strokeWidth={4} />

                {/* 区域块 + 分界线（clip 到当前层边界） */}
                <g clipPath={`url(#${clipId})`}>
                  {cells.map((cell, i) => {
                    const loc = cell.loc;
                    if (!loc) {
                      // 空户占位块：淡灰、不可点击、无标签
                      return (
                        <g key={`lot-empty-${i}`}>
                          <path
                            d={cell.path}
                            fill="var(--color-ink-faint)"
                            fillOpacity={0.08}
                            stroke="var(--color-ink)"
                            strokeOpacity={0.3}
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
                        className="cursor-pointer"
                        onClick={() => setSelectedId(isSel ? null : loc.id)}
                      >
                        <path
                          d={cell.path}
                          fill="var(--color-cyan)"
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
                  <path d={boundaryPath} fill="none" stroke="var(--color-ink)" strokeOpacity={0.4} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
                </g>

                {/* 名字标签（浮在块上方，不被轮廓裁剪；白条宽度+字号随名字长度自适应） */}
                {cells.map((cell) => {
                  if (!cell.loc) return null;
                  const isSel = cell.loc.id === selectedId;
                  const name = cell.loc.name;
                  // 估算文字宽度：全角字符≈1 个 fontSize，半角（英文/数字/·）≈0.55
                  let unit = 0;
                  for (const ch of name) unit += /[\x00-\xff]/.test(ch) ? 0.55 : 1;
                  // 字号 20~28，让文字宽度不超过 320px；短名保持 28
                  const fontSize = Math.max(20, Math.min(28, 320 / Math.max(unit, 1)));
                  const barWidth = Math.ceil(unit * fontSize + 48);
                  return (
                    <g key={cell.loc.id} transform={`translate(${cell.cx}, ${cell.cy})`} style={{ pointerEvents: 'none' }}>
                      <rect
                        x={-barWidth / 2}
                        y={-23}
                        width={barWidth}
                        height={46}
                        rx={12}
                        fill={isSel ? 'var(--color-cyan)' : 'var(--color-bg-map-soft)'}
                      />
                      <text
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill={isSel ? 'var(--color-bg-soft)' : 'var(--color-ink-on)'}
                        style={{ fontSize, fontWeight: 600 }}
                      >
                        {name}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="flex flex-col gap-2 mt-3">
              {listCells.map((cell) => {
                const loc = cell.loc;
                if (!loc) return null;
                const isSel = loc.id === selectedId;
                const locChars = collectChars(loc.id);
                return (
                  <div
                    key={loc.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(isSel ? null : loc.id)}
                    className={`relative w-full text-left rounded-2xl overflow-hidden frosted-glass cursor-pointer transition ${
                      isSel ? 'ring-2 ring-[var(--accent)]/70' : ''
                    }`}
                  >
                    {loc.background && (
                      <div
                        className="absolute inset-0 bg-cover bg-center"
                        style={{ backgroundImage: `url(${imageUrl(loc.background)})` }}
                        aria-hidden
                      />
                    )}
                    <div className="absolute inset-0 bg-bg-soft/40" aria-hidden />
                    <div className="relative px-3 py-3 flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[13px] font-bold text-ink truncate">{loc.name}</span>
                          {loc.creatorType === 'player' && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium text-rose bg-rose/20">
                              {loc.isPublic ? '公开' : '私有'}
                            </span>
                          )}
                          {loc.hasChildren && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-full text-[9px] font-medium text-cyan bg-cyan/10">
                              含子区域
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-ink-muted mt-0.5 truncate">{loc.summary || '一个地方'}</div>
                        {(locChars.length > 0 || loc.npcs.length > 0) && (
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {locChars.map((n) => (
                              <button
                                key={n.characterId}
                                title={`查看${n.name}的行程`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setScheduleCharId(n.characterId);
                                }}
                                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-bg-soft border border-border text-[10px] text-ink cursor-pointer"
                              >
                                <span className="w-4 h-4 rounded-full overflow-hidden bg-bg-muted flex items-center justify-center text-[9px] font-bold shrink-0">
                                  {n.avatarType === 'image' && n.avatar ? (
                                    <img src={imageUrl(n.avatar)} alt="" className="w-full h-full object-cover" />
                                  ) : (
                                    n.name?.charAt(0) ?? '?'
                                  )}
                                </span>
                                {n.visibility === 'unknown' ? '?' : n.name}
                              </button>
                            ))}
                            {loc.npcs.map((n) => (
                              <span
                                key={n.id}
                                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-bg-soft border border-border text-[10px] text-ink"
                              >
                                <span className="w-4 h-4 rounded-full overflow-hidden bg-bg-muted flex items-center justify-center text-[9px] font-bold shrink-0">
                                  {n.name.charAt(0)}
                                </span>
                                {n.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 self-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            enterLoc(loc);
                          }}
                          className="px-2.5 py-1 rounded-full bg-cyan text-ink-on text-[11px] font-medium transition active:scale-95 cursor-pointer"
                        >
                          进入
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {scheduleCharId && (
        <SceneScheduleModal characterId={scheduleCharId} onClose={() => setScheduleCharId(null)} />
      )}
    </div>
  );
};

function SceneScheduleModal({ characterId, onClose }: { characterId: string; onClose: () => void }) {
  const [data, setData] = useState<{
    characterName: string;
    current: { locationName: string; activity: string; startTime: number; duration: number } | null;
    upcoming: { locationName: string; activity: string; startTime: number; duration: number }[];
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/v4/api/scene/npcs/${characterId}/schedule`)
      .then((r) => r.json())
      .then(setData)
      .catch((e) => {
        setError((e as Error).message);
      });
  }, [characterId]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-sm rounded-t-2xl sm:rounded-2xl bg-panel p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {error ? (
          <>
            <div className="text-[15px] font-bold text-ink">查看失败</div>
            <div className="text-xs text-rose mt-2">{error}</div>
            <div className="flex justify-end mt-4">
              <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-cyan text-ink-on text-xs font-medium cursor-pointer">
                关闭
              </button>
            </div>
          </>
        ) : !data ? (
          <div className="text-center text-ink-muted text-xs py-8">加载中…</div>
        ) : (
          <>
            <div className="text-[15px] font-bold text-ink">{data.characterName}的行程</div>
            {data.current ? (
              <div className="mt-3 p-3 rounded-xl bg-cyan/10 border border-cyan/20">
                <div className="text-[10px] text-cyan font-semibold">现在</div>
                <div className="text-[13px] font-bold text-ink mt-0.5">{data.current.locationName}</div>
                <div className="text-xs text-ink-muted mt-0.5">{data.current.activity}</div>
              </div>
            ) : (
              <div className="mt-3 p-3 rounded-xl bg-bg-muted">
                <div className="text-[10px] text-ink-faint font-semibold">不在主城</div>
              </div>
            )}
            {data.upcoming.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] text-ink-muted font-semibold mb-1.5">接下来</div>
                {data.upcoming.map((u, i) => (
                  <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border last:border-b-0">
                    <span className="text-[11px] text-ink-faint shrink-0 tabular-nums">{formatTime(u.startTime)}</span>
                    <span className="text-xs font-medium text-ink flex-1 truncate">{u.locationName}</span>
                    <span className="text-[11px] text-ink-muted shrink-0">{u.activity}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end mt-4">
              <button onClick={onClose} className="px-3 py-1.5 rounded-lg bg-cyan text-ink-on text-xs font-medium cursor-pointer">
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

