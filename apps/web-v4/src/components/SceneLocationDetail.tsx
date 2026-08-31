import { useEffect, useId, useMemo, useState } from 'react';
import {
  SceneLocationInfo,
  MapNpc,
  Pt,
  VizCell,
  imageUrl,
  W,
  H,
  computeTopLayout,
  computeLevel,
  polyBBox,
} from '../lib/sceneMapGeometry';
import { BackgroundPicker } from './BackgroundPicker';
import { api } from '../lib/api';

export function SceneLocationDetail({
  locationId,
  onBack,
  onExplore,
  onOpenLocation,
  onStartScene,
}: {
  locationId: string;
  onBack: () => void;
  onExplore: (locationId: string, locationName: string) => void;
  onOpenLocation: (locationId: string) => void;
  onStartScene: (sessionId: string) => void;
}) {
  const [loc, setLoc] = useState<SceneLocationInfo | null>(null);
  const [allLocs, setAllLocs] = useState<SceneLocationInfo[]>([]);
  const [allNpcs, setAllNpcs] = useState<Record<string, MapNpc[]>>({});
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [selectedChildId, setSelectedChildId] = useState<string | null>(null);
  const [newChildName, setNewChildName] = useState('');
  const [newChildSummary, setNewChildSummary] = useState('');
  const [newChildPublic, setNewChildPublic] = useState(true);
  const [npcRole, setNpcRole] = useState('');
  const [npcName, setNpcName] = useState('');
  const [npcPersona, setNpcPersona] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const clipId = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const load = async () => {
    try {
      const [locData, npcData] = await Promise.all([
        fetch('/v4/api/scene/locations').then((r) => r.json()),
        fetch('/v4/api/scene/map/npcs').then((r) => r.json()),
      ]);
      const locations: SceneLocationInfo[] = locData.locations ?? [];
      setAllLocs(locations);
      setLoc(locations.find((l) => l.id === locationId) ?? null);
      setAllNpcs(npcData.locations ?? {});
    } catch {}
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [locationId]);

  // 上传/生成地点背景后写回（公共地点进提交池，私有地点直写；用返回的实际 background 更新）
  const handleBackgroundSelect = async (imagePath: string) => {
    if (!loc) return;
    try {
      const res = await api.setLocationBackground(loc.id, imagePath);
      setLoc({ ...loc, background: res.background });
    } catch {
      alert('保存背景失败，请重试');
    }
  };

  const handleBackgroundClear = async () => {
    if (!loc) return;
    try {
      const res = await api.setLocationBackground(loc.id, '');
      setLoc({ ...loc, background: res.background });
    } catch {
      alert('清除背景失败，请重试');
    }
  };

  // 添加子地点（写 scene_locations，随后重载让地图/列表同步）
  const handleAddChild = async () => {
    if (!loc || !newChildName.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await api.sceneCreateLocation({
        name: newChildName.trim(),
        summary: newChildSummary.trim() || undefined,
        parentId: loc.id,
        isPublic: newChildPublic,
      });
      setNewChildName(''); setNewChildSummary('');
      await load();
    } catch (e) {
      setError((e as Error).message || '添加子地点失败');
    } finally { setBusy(false); }
  };

  // 添加路人（按 role 去重覆盖）
  const handleAddNpc = async () => {
    if (!loc || !npcRole.trim() || !npcName.trim() || busy) return;
    setBusy(true); setError('');
    try {
      await api.sceneAddNpc(loc.id, { role: npcRole.trim(), name: npcName.trim(), persona: npcPersona.trim() || undefined });
      setNpcRole(''); setNpcName(''); setNpcPersona('');
      await load();
    } catch (e) {
      setError((e as Error).message || '添加路人失败');
    } finally { setBusy(false); }
  };

  const childLocs = allLocs.filter((l) => l.parentId === locationId);
  // 子地点卡片列表：点击图形地图分区选中的置顶（只更换排序，不跳转）
  const orderedChildLocs = useMemo(() => {
    if (!selectedChildId) return childLocs;
    const sel = childLocs.find((l) => l.id === selectedChildId);
    return sel ? [sel, ...childLocs.filter((l) => l.id !== selectedChildId)] : childLocs;
  }, [childLocs, selectedChildId]);
  const breadcrumbs = loc?.path?.split(' › ') ?? [];

  // 祖先链（顶层 → 该地点本身），供图形地图下钻到该地点
  const ancestors = useMemo(() => {
    if (!loc) return [];
    const chain: string[] = [loc.id];
    let cur: SceneLocationInfo | undefined = loc;
    while (cur.parentId) {
      const parent = allLocs.find((l) => l.id === cur!.parentId);
      if (!parent) break;
      chain.unshift(parent.id);
      cur = parent;
    }
    return chain;
  }, [loc, allLocs]);

  // 该地点的图形地图：下钻到该地点，展示其子节点分区（叶子则落在其所在层并高亮自身）
  const mapLevel = useMemo(() => {
    if (!loc) return null;
    const roots = allLocs.filter((l) => !l.parentId);
    if (roots.length === 0) return null;
    const sizes = roots.map((r) => Math.max(allLocs.filter((l) => l.parentId === r.id).length, 1));
    const top = computeTopLayout(roots, sizes);
    return computeLevel(allLocs, top, ancestors);
  }, [loc, ancestors, allLocs]);

  // 卡片头像聚合：给定地点 id，返回它自己 + 所有后代地点里的确切在场角色
  const collectChars = (rootId: string): MapNpc[] => {
    const seen = new Map<string, MapNpc>();
    const walk = (id: string) => {
      for (const n of allNpcs[id] ?? []) {
        if (!seen.has(n.characterId)) seen.set(n.characterId, n);
      }
      for (const l of allLocs) {
        if (l.parentId === id) walk(l.id);
      }
    };
    walk(rootId);
    return [...seen.values()];
  };

  const selectedChild = childLocs.find((l) => l.id === selectedChildId) ?? null;

  const renderChildCard = (l: SceneLocationInfo) => {
    const childChars = collectChars(l.id);
    const isSel = selectedChildId === l.id;
    return (
      <button
        key={l.id}
        className={`w-full rounded-xl border border-border frosted-glass p-3 text-left transition hover:border-border-strong ${isSel ? 'ring-2 ring-[var(--accent)]/70' : ''}`}
        onClick={() => onOpenLocation(l.id)}
      >
        <div className="flex items-center gap-2">
          <span>📍</span>
          <div className="flex-1">
            <div className="text-sm font-medium text-ink">
              {l.name}
              {l.hasChildren && <span className="ml-2 rounded-full bg-bg-muted/60 px-1.5 py-0.5 text-[10px] text-ink-faint">含子区域</span>}
            </div>
            <div className="text-xs text-ink-faint">{l.summary || '一个地方'}</div>
          </div>
          <span className="shrink-0 rounded-full bg-cyan px-2.5 py-1 text-[11px] font-medium text-ink-on">进入</span>
        </div>
        {childChars.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {childChars.map((n) => (
              <span key={n.characterId} className="inline-flex items-center gap-1.5 rounded-full bg-bg-muted/60 px-2.5 py-1 text-xs text-ink-soft">
                <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full bg-bg-muted text-[10px] text-ink">
                  {n.avatarType === 'image' && n.avatar ? <img src={imageUrl(n.avatar)} alt="" className="h-full w-full object-cover" /> : (n.name?.charAt(0) ?? '?')}
                </span>
                {n.name}
              </span>
            ))}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
        <button className="text-ink-soft" onClick={onBack}>←</button>
        <span className="font-semibold text-ink">{loc?.name ?? '…'}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-[81px]">
        {ancestors.length > 1 && (
          <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-ink-faint">
            {ancestors.map((id, i) => {
              const name = allLocs.find((l) => l.id === id)?.name ?? '';
              const isLast = i === ancestors.length - 1;
              return (
                <span key={id} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-ink-faint">›</span>}
                  {isLast ? (
                    <span className="text-ink-faint">{name}</span>
                  ) : (
                    <button
                      className="text-cyan hover:underline cursor-pointer"
                      onClick={() => onOpenLocation(id)}
                    >
                      {name}
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}

        {loading ? (
          <div className="py-10 text-center text-ink-soft">加载中…</div>
        ) : !loc ? (
          <div className="py-10 text-center text-ink-faint">地点不存在</div>
        ) : (
          <>
            {/* 图形地图：该地点的子节点分区（点击子节点下钻到其详情页） */}
            {mapLevel && mapLevel.cells.length > 0 && (
              <div className="mb-4 overflow-hidden rounded-2xl border border-border frosted-glass">
                <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" role="img" aria-label={`${loc.name}地图`}>
                  <defs>
                    <clipPath id={clipId}>
                      <path d={mapLevel.boundary} />
                    </clipPath>
                    {mapLevel.cells.filter((c) => c.loc?.background).map((cell) => (
                      <clipPath key={cell.loc!.id} id={`bg-${cell.loc!.id}`}>
                        <path d={cell.path} />
                      </clipPath>
                    ))}
                  </defs>
                  <path d={mapLevel.boundary} fill="transparent" stroke="var(--color-ink)" strokeOpacity={0.7} strokeWidth={4} />
                  <g clipPath={`url(#${clipId})`}>
                    {mapLevel.cells.map((cell, i) => {
                      const cloc = cell.loc;
                      if (!cloc) {
                        return (
                          <g key={`lot-empty-${i}`}>
                            <path d={cell.path} fill="var(--color-ink-faint)" fillOpacity={0.08} stroke="var(--color-ink)" strokeOpacity={0.3} strokeWidth={2} strokeLinejoin="round" />
                          </g>
                        );
                      }
                      const isSelf = cloc.id === locationId;
                      const bg = cloc.background;
                      const bb = bg ? polyBBox(cell.poly) : null;
                      return (
                        <g
                          key={cloc.id}
                          className={isSelf ? '' : 'cursor-pointer'}
                          onClick={() => { if (!isSelf) setSelectedChildId((prev) => (prev === cloc.id ? null : cloc.id)); }}
                        >
                          <path d={cell.path} fill="var(--color-cyan)" fillOpacity={isSelf ? 0.35 : selectedChildId === cloc.id ? 0.3 : 0.18} stroke="none" />
                          {bg && bb && (
                            <g clipPath={`url(#bg-${cloc.id})`}>
                              <image href={imageUrl(bg)} x={bb.minx} y={bb.miny} width={bb.maxx - bb.minx} height={bb.maxy - bb.miny} preserveAspectRatio="xMidYMid slice" style={{ filter: 'brightness(0.4) saturate(1.1)' }} />
                            </g>
                          )}
                          {(isSelf || selectedChildId === cloc.id) && <path d={cell.path} fill="none" stroke="var(--accent)" strokeOpacity={1} strokeWidth={4} strokeLinejoin="round" />}
                        </g>
                      );
                    })}
                    <path d={mapLevel.boundaryLines.map(([a, b]) => `M ${a[0].toFixed(1)} ${a[1].toFixed(1)} L ${b[0].toFixed(1)} ${b[1].toFixed(1)}`).join(' ')} fill="none" stroke="var(--color-ink)" strokeOpacity={0.4} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
                  </g>
                  {mapLevel.cells.map((cell) => {
                    if (!cell.loc) return null;
                    const isSelf = cell.loc.id === locationId;
                    const name = cell.loc.name;
                    // 估算文字宽度：全角字符≈1 个 fontSize，半角（英文/数字/·）≈0.55
                    let unit = 0;
                    for (const ch of name) unit += /[\x00-\xff]/.test(ch) ? 0.55 : 1;
                    // 字号 20~28，让文字宽度不超过 320px；短名保持 28
                    const fontSize = Math.max(20, Math.min(28, 320 / Math.max(unit, 1)));
                    const barWidth = Math.ceil(unit * fontSize + 48);
                    return (
                      <g key={cell.loc.id} transform={`translate(${cell.cx}, ${cell.cy})`} style={{ pointerEvents: 'none' }}>
                        <rect x={-barWidth / 2} y={-23} width={barWidth} height={46} rx={12} fill={isSelf ? 'var(--color-cyan)' : 'var(--color-bg-map-soft)'} />
                        <text textAnchor="middle" dominantBaseline="central" fill={isSelf ? 'var(--color-bg-soft)' : 'var(--color-ink-on)'} style={{ fontSize, fontWeight: 600 }}>
                          {name}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            )}

            {/* 选中的子区域卡片：显示在区域简介上方 */}
            {selectedChild && (
              <div className="mb-4">
                <div className="mb-2 text-xs text-ink-faint">选中区域</div>
                {renderChildCard(selectedChild)}
              </div>
            )}

            {/* 环境概览 */}
            <div
              className="relative mb-4 overflow-hidden rounded-2xl border border-border frosted-glass"
              style={loc.background ? { backgroundImage: `url(${imageUrl(loc.background)})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
            >
              {loc.background && <div className="absolute inset-0 bg-black/40" aria-hidden />}
              <div className="relative p-4">
                <div className="mb-1 text-xl">🌆</div>
                <div className={`text-base font-semibold ${loc.background ? 'text-white' : 'text-ink'}`}>{loc.name}</div>
                <div className={`mt-1 text-sm ${loc.background ? 'text-white/80' : 'text-ink-muted'}`} style={{ lineHeight: 1.5 }}>{loc.summary || '一个安静的地方。'}</div>
              </div>
            </div>

            {/* 场景设置入口（弹层：背景 / 子地点 / 路人） */}
            <button
              className="mb-4 w-full rounded-xl border border-border frosted-glass p-4 text-left transition hover:border-border-strong"
              onClick={() => setShowSettings(true)}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">⚙️</span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink">场景设置</div>
                  <div className="text-xs text-ink-faint">设背景 · 加子地点 · 加路人</div>
                </div>
                <span className="text-ink-soft">›</span>
              </div>
            </button>

            {/* 常驻人员 */}
            {loc.npcs.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 text-xs text-ink-faint">常驻人员</div>
                <div className="flex flex-wrap gap-2">
                  {loc.npcs.map((n: any) => (
                    <span key={n.id} className="inline-flex items-center gap-1.5 rounded-full border border-border frosted-glass px-3 py-1 text-xs text-ink-soft">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-muted text-[10px] text-ink">{n.name.charAt(0)}</span>
                      {(n.role ? `${n.role}·` : '') + n.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 进入主行动 */}
            <button
              className="mb-4 w-full rounded-xl border border-border frosted-glass p-4 text-left transition hover:border-border-strong"
              onClick={() => onExplore(loc.id, loc.name)}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">🚶</span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink">进入{loc.name}</div>
                  <div className="text-xs text-ink-faint">四处走走，也许会偶遇谁</div>
                </div>
              </div>
              {(allNpcs[loc.id] ?? []).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {(allNpcs[loc.id] ?? []).map((n) => (
                    <span key={n.characterId} className="inline-flex items-center gap-1.5 rounded-full bg-bg-muted/60 px-2.5 py-1 text-xs text-ink-soft">
                      <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full bg-bg-muted text-[10px] text-ink">
                        {n.avatarType === 'image' && n.avatar ? <img src={imageUrl(n.avatar)} alt="" className="h-full w-full object-cover" /> : (n.name?.charAt(0) ?? '?')}
                      </span>
                      {n.name}
                    </span>
                  ))}
                </div>
              )}
            </button>

            {/* 邀请约会 */}
            <button
              className="mb-4 w-full rounded-xl border border-border frosted-glass p-4 text-left transition hover:border-border-strong"
              onClick={() => setShowInvite(true)}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">💌</span>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-ink">邀请约会</div>
                  <div className="text-xs text-ink-faint">约一位好友到这里见面</div>
                </div>
                <span className="text-ink-soft">›</span>
              </div>
            </button>

            {/* 子地点 */}
            {childLocs.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 text-xs text-ink-faint">区域</div>
                <div className="flex flex-col gap-2">
                  {orderedChildLocs.filter((l) => l.id !== selectedChildId).map(renderChildCard)}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {showInvite && loc && (
        <InviteModal
          locationId={loc.id}
          locationName={loc.name}
          onClose={() => setShowInvite(false)}
          onStart={onStartScene}
        />
      )}

      {showSettings && loc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowSettings(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-2xl bg-panel border border-border p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-base font-semibold text-ink">场景设置</div>
              <button onClick={() => setShowSettings(false)} className="text-ink-faint hover:text-ink cursor-pointer" aria-label="关闭">✕</button>
            </div>

            {/* 背景图 */}
            <div className="mb-4">
              <div className="mb-2 text-xs text-ink-faint">背景图</div>
              <BackgroundPicker
                value={loc.background || undefined}
                onSelect={handleBackgroundSelect}
                onClear={handleBackgroundClear}
                generatePlaceholder={loc.summary ? `${loc.name}，${loc.summary}` : loc.name}
                label="上传 / 生成背景"
                size={{ width: 768, height: 1344 }}
              />
              <div className="mt-1.5 text-[11px] text-ink-faint">
                {loc.isPublic ? '公开地点：提交进候选池，最先传的自动生效，管理员可挑选。' : '私有地点：只有你能设置。'}
              </div>
            </div>

            {/* 添加子地点 */}
            <div className="mb-4">
              <div className="mb-2 text-xs text-ink-faint">添加子地点</div>
              <input
                className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-ink outline-none"
                value={newChildName}
                onChange={(e) => setNewChildName(e.target.value)}
                placeholder="地点名称"
                maxLength={30}
              />
              <input
                className="mt-2 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-ink outline-none"
                value={newChildSummary}
                onChange={(e) => setNewChildSummary(e.target.value)}
                placeholder="这是什么地方？（可选）"
                maxLength={200}
              />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-ink-soft">类型</span>
                <button
                  className={`rounded-full px-3 py-1 text-xs font-medium ${newChildPublic ? 'bg-cyan text-ink-on' : 'border border-border text-ink-soft'}`}
                  onClick={() => setNewChildPublic(true)}
                >公开</button>
                <button
                  className={`rounded-full px-3 py-1 text-xs font-medium ${!newChildPublic ? 'bg-cyan text-ink-on' : 'border border-border text-ink-soft'}`}
                  onClick={() => setNewChildPublic(false)}
                >私有</button>
              </div>
              <div className="mt-1.5 text-[11px] text-ink-faint">
                {newChildPublic ? '所有人可见，NPC 可能出现在这里' : '仅自己可见'}
              </div>
              <button
                className="mt-2 w-full rounded-lg bg-rose px-3 py-2 text-sm font-medium text-ink-on"
                onClick={handleAddChild}
                disabled={busy || !newChildName.trim()}
              >
                添加子地点
              </button>
            </div>

            {/* 添加路人 */}
            <div>
              <div className="mb-2 text-xs text-ink-faint">添加路人</div>
              <input
                className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-ink outline-none"
                value={npcRole}
                onChange={(e) => setNpcRole(e.target.value)}
                placeholder="身份（如：服务生、摊主）"
                maxLength={20}
              />
              <input
                className="mt-2 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-ink outline-none"
                value={npcName}
                onChange={(e) => setNpcName(e.target.value)}
                placeholder="名字（如：小周）"
                maxLength={20}
              />
              <input
                className="mt-2 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-ink outline-none"
                value={npcPersona}
                onChange={(e) => setNpcPersona(e.target.value)}
                placeholder="设定（可选）"
                maxLength={200}
              />
              <button
                className="mt-2 w-full rounded-lg bg-rose px-3 py-2 text-sm font-medium text-ink-on"
                onClick={handleAddNpc}
                disabled={busy || !npcRole.trim() || !npcName.trim()}
              >
                添加路人
              </button>
            </div>

            {error && <div className="mt-3 text-xs text-rose">{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 邀请约会弹层 —— 不限人数好友选择，开场方式可伪装主神抽选（照 v2 InviteModal）。 */
function InviteModal({
  locationId,
  locationName,
  onClose,
  onStart,
}: {
  locationId: string;
  locationName: string;
  onClose: () => void;
  onStart: (sessionId: string) => void;
}) {
  const [friends, setFriends] = useState<{ characterId: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [deityPick, setDeityPick] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    fetch('/v4/api/missions/friends')
      .then((r) => r.json())
      .then((d) => {
        setFriends(d.friends ?? []);
        if ((d.friends ?? []).length === 0) setError('还没有好友可以邀请');
      })
      .catch(() => setError('加载好友失败'));
  }, []);

  const selectedSet = new Set(selected);
  const selectedFriends = selected
    .map((id) => friends.find((f) => f.characterId === id))
    .filter((f): f is { characterId: string; name: string } => !!f);

  const candidates = friends.filter((f) => {
    if (selectedSet.has(f.characterId)) return false;
    if (!query.trim()) return true;
    return f.name.toLowerCase().includes(query.trim().toLowerCase());
  });

  const addFriend = (id: string) => {
    if (selectedSet.has(id)) return;
    setSelected((prev) => [...prev, id]);
    setQuery('');
    setPicking(false);
    setError('');
  };

  const start = async () => {
    if (busy) return;
    if (selected.length === 0) { setError('请至少选择一位好友'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch('/v4/api/scene/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId,
          characterIds: selected,
          circumstance: deityPick ? 'deity_pick' : 'invite',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '发起失败');
      onStart(data.sessionId);
    } catch (e) {
      setError((e as Error).message || '发起失败');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-panel border border-border p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-base font-semibold text-ink">邀请约会</div>
        <div className="mb-3 text-xs text-ink-soft">在「{locationName}」邀请好友见面（已选 {selected.length} 位，不限人数）</div>

        {/* 已选列表 */}
        <div className="mb-3 flex flex-col gap-1.5">
          {selectedFriends.length === 0 ? (
            <div className="rounded-lg bg-bg-muted/50 px-3 py-2 text-xs text-ink-faint">从下面选择好友加入</div>
          ) : (
            selectedFriends.map((f) => (
              <div key={f.characterId} className="flex items-center justify-between rounded-lg bg-bg-muted/50 px-3 py-2 text-sm text-ink">
                <span>{f.name}</span>
                <button className="text-ink-faint hover:text-rose" onClick={() => setSelected((prev) => prev.filter((x) => x !== f.characterId))}>✕</button>
              </div>
            ))
          )}
        </div>

        {/* 选择好友 */}
        <div className="mb-3">
          <input
            className="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm text-ink outline-none"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPicking(true); }}
            onFocus={() => setPicking(true)}
            placeholder="搜索好友…"
          />
          {picking && candidates.length > 0 && (
            <div className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
              {candidates.map((f) => (
                <button key={f.characterId} className="rounded-lg bg-bg-muted/40 px-3 py-2 text-left text-sm text-ink hover:bg-bg-muted/70" onClick={() => addFriend(f.characterId)}>
                  {f.name}
                </button>
              ))}
            </div>
          )}
          {picking && candidates.length === 0 && query.trim() && (
            <div className="mt-1.5 px-1 text-xs text-ink-faint">没有匹配的好友</div>
          )}
        </div>

        {/* 开场方式 */}
        <label className="mb-3 flex items-start gap-2 text-xs text-ink-soft">
          <input type="checkbox" checked={deityPick} onChange={(e) => { setDeityPick(e.target.checked); setError(''); }} className="mt-0.5" />
          <span>
            <span className="block text-ink">伪装成随机抽选开场</span>
            <span className="text-ink-faint">{deityPick ? '对方以为是主神随机选中，其实是你挑的' : '正常邀请（对方知道是应邀而来）'}</span>
          </span>
        </label>

        {error && <div className="mb-2 text-xs text-rose">{error}</div>}

        <div className="flex gap-2">
          <button className="flex-1 rounded-lg border border-border px-3 py-2 text-sm text-ink-soft" onClick={onClose} disabled={busy}>取消</button>
          <button className="flex-1 rounded-lg bg-rose px-3 py-2 text-sm font-medium text-ink-on" onClick={start} disabled={busy || selected.length === 0}>
            {busy ? '发起中…' : `确定邀请（${selected.length}人）`}
          </button>
        </div>
      </div>
    </div>
  );
}

