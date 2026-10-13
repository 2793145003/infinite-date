import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import type { WorldSummary, WorldState, WorldNpcSummary, WorldBoard } from '../lib/api';
import { Match2Board } from './Match2Board';

// 通用配方（与后端 RECIPES 中 faction 为空者一致，固定表）
const PLAYER_RECIPES = [
  { id: 0, name: '凝气丹方', output: '凝气丹', materials: '灵草×2 材料×1' },
  { id: 1, name: '续命丹方', output: '续命丹', materials: '灵草×2 材料×2' },
  { id: 2, name: '筑基丹方', output: '筑基丹', materials: '灵草×3 材料×2' },
  { id: 3, name: '青锋剑谱', output: '青锋剑', materials: '材料×3' },
  { id: 4, name: '玄龟盾谱', output: '玄龟盾', materials: '材料×3' },
  { id: 5, name: '护身符方', output: '护身符', materials: '灵草×1 材料×2' },
  { id: 6, name: '太乙剑诀抄本', output: '太乙剑诀', materials: '材料×2' },
];

// 区域淡色（区分大方格边界）
const REGION_TINTS = [
  'rgba(233,30,99,0.06)', 'rgba(33,150,243,0.06)', 'rgba(76,175,80,0.06)', 'rgba(255,152,0,0.06)',
  'rgba(156,39,176,0.06)', 'rgba(0,150,136,0.06)', 'rgba(121,85,72,0.06)', 'rgba(96,125,139,0.06)',
];

function cellName(loc: number, map: WorldState['map']): string {
  const gx = loc % map.size;
  const gy = Math.floor(loc / map.size);
  const cx = gx % map.cells;
  const cy = gy % map.cells;
  const regionIdx = Math.floor(gy / map.cells) * map.regions + Math.floor(gx / map.cells);
  const cellIdx = cy * map.cells + cx;
  return `${map.regionNames[regionIdx] ?? '无名'}·${map.cellNames[cellIdx] ?? '野地'}`;
}

// 动作描写（*...*）特殊字体：斜体 + 柔色 + 缩小 + 半透明
function renderText(text: string): React.ReactNode {
  const parts = text.split(/\*([^*]+)\*/g);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <span key={i} style={{ fontStyle: 'italic', opacity: 0.7, fontSize: '0.85em', color: 'var(--text-mute, #888)' }}>{p}</span>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export function DerivativeWorldApp({ onBack }: { onBack: () => void }) {
  // ── 状态（全部在顶部，勿在条件 return 后新增 hook）──
  const [view, setView] = useState<'list' | 'world'>('list');
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [state, setState] = useState<WorldState | null>(null);
  const [busy, setBusy] = useState(false); // 推进/移动等操作中

  // 创建弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createScale, setCreateScale] = useState(40);

  // 对话弹窗
  const [talkNpc, setTalkNpc] = useState<WorldNpcSummary | null>(null);
  const [talkLog, setTalkLog] = useState<{ speaker: 'player' | 'npc'; text: string }[]>([]);
  const [talkInput, setTalkInput] = useState('');
  const [talking, setTalking] = useState(false);

  // 炼制弹窗
  const [craftOpen, setCraftOpen] = useState(false);
  const [board, setBoard] = useState<WorldBoard | null>(null);
  const [recipeId, setRecipeId] = useState<number | null>(null);
  const [recipeLabel, setRecipeLabel] = useState('');
  const [craftResult, setCraftResult] = useState<string | null>(null);

  // ── 数据加载 ──
  const loadWorlds = useCallback(async () => {
    setLoading(true);
    try {
      const { worlds } = await api.worldList();
      setWorlds(worlds);
    } catch (e: any) {
      window.alert(e?.message || '加载世界失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadWorlds(); }, [loadWorlds]);

  const loadState = useCallback(async (id: string) => {
    try {
      const s = await api.worldState(id);
      setState(s);
    } catch (e: any) {
      window.alert(e?.message || '加载世界状态失败');
    }
  }, []);

  // ── 操作 ──
  const enterWorld = async (id: string) => {
    setCurrentId(id);
    setView('world');
    await loadState(id);
  };

  const createWorld = async () => {
    setBusy(true);
    try {
      const w = await api.worldCreate({ name: createName.trim() || undefined, npcCount: createScale });
      setCreateOpen(false);
      setCreateName('');
      await loadWorlds();
      await enterWorld(w.id);
    } catch (e: any) {
      window.alert(e?.message || '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const advance = async (months: number) => {
    if (!currentId || busy) return;
    setBusy(true);
    try {
      await api.worldAdvance(currentId, months);
      await loadState(currentId);
    } catch (e: any) {
      window.alert(e?.message || '推进失败');
    } finally {
      setBusy(false);
    }
  };

  const move = async (loc: number) => {
    if (!currentId || busy) return;
    setBusy(true);
    try {
      const r = await api.worldMove(currentId, loc);
      await loadState(currentId);
      if (r.met.length > 0) {
        const names = r.met.map((n) => n.name).join('、');
        window.alert(`你在${r.locName}遇见了：${names}`);
      }
    } catch (e: any) {
      window.alert(e?.message || '移动失败');
    } finally {
      setBusy(false);
    }
  };

  const deleteWorld = async (id: string, name: string) => {
    if (!window.confirm(`确定删除「${name}」吗？此界将归于虚无。`)) return;
    try {
      await api.worldDelete(id);
      if (currentId === id) {
        setCurrentId(null);
        setState(null);
        setView('list');
      }
      await loadWorlds();
    } catch (e: any) {
      window.alert(e?.message || '删除失败');
    }
  };

  // ── 对话 ──
  const openTalk = (npc: WorldNpcSummary) => {
    setTalkNpc(npc);
    setTalkLog([]);
    setTalkInput('');
  };

  const sendTalk = async () => {
    if (!currentId || !talkNpc || talking) return;
    const msg = talkInput.trim();
    if (!msg) return;
    setTalkInput('');
    setTalkLog((prev) => [...prev, { speaker: 'player', text: msg }]);
    setTalking(true);
    try {
      const r = await api.worldTalk(currentId, talkNpc.id, msg);
      setTalkLog((prev) => [...prev, { speaker: 'npc', text: r.reply.reply }]);
      setTalkNpc((prev) => (prev ? { ...prev, affinityToPlayer: r.affinityToPlayer } : prev));
    } catch (e: any) {
      window.alert(e?.message || '对话失败');
    } finally {
      setTalking(false);
    }
  };

  // ── 炼制 ──
  const startCraft = async (rid: number) => {
    if (!currentId) return;
    setBusy(true);
    try {
      const r = await api.worldCraftStart(currentId, rid);
      setRecipeId(rid);
      setRecipeLabel(`${r.recipeName} → ${r.outputName}`);
      setBoard(r.board);
      setCraftResult(null);
    } catch (e: any) {
      window.alert(e?.message || '开始炼制失败');
    } finally {
      setBusy(false);
    }
  };

  const swap = async (x1: number, y1: number, x2: number, y2: number) => {
    if (!currentId || !board) return;
    const r = await api.worldCraftSwap(currentId, board, x1, y1, x2, y2);
    setBoard(r.board);
    if (r.board.movesLeft <= 0) {
      await finishCraft(r.board);
    }
  };

  const finishCraft = async (finalBoard: WorldBoard) => {
    if (!currentId || recipeId == null) return;
    setBusy(true);
    try {
      const r = await api.worldCraftFinish(currentId, recipeId, finalBoard);
      if (r.result.success) {
        setCraftResult(r.result.desc);
        setBoard(null);
        setRecipeId(null);
        await loadState(currentId);
      } else {
        setCraftResult(r.result.desc);
      }
    } catch (e: any) {
      window.alert(e?.message || '炼制失败');
    } finally {
      setBusy(false);
    }
  };

  // ── 渲染：列表 ──
  if (view === 'list') {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
          <button className="text-ink-soft" onClick={onBack}>←</button>
          <span className="font-semibold text-ink">衍生世界</span>
          <button className="ml-auto rounded-lg bg-rose px-3 py-1.5 text-sm text-ink-on" onClick={() => setCreateOpen(true)}>＋ 开一界</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-[81px]">
          <div className="mt-3 rounded-xl bg-bg-rose-soft/60 px-4 py-3 text-sm text-rose">
            一界一众生：此界由五行六亲自行演化，你遇见的修士才会「活过来」与你交谈。
          </div>
          {loading ? (
            <div className="py-8 text-center text-sm text-ink-soft">加载中...</div>
          ) : worlds.length === 0 ? (
            <div className="py-8 text-center text-sm text-ink-soft">还没有衍生世界，点右上角「开一界」</div>
          ) : (
            <div className="mt-3 flex flex-col gap-3">
              {worlds.map((w) => (
                <div key={w.id} className="cursor-pointer rounded-2xl border border-border frosted-glass p-4 transition hover:shadow-sm" onClick={() => enterWorld(w.id)}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-ink">{w.name}</h3>
                    <div className="flex items-center gap-2">
                      <button className="rounded-full border border-status-red/40 px-2.5 py-0.5 text-xs text-status-red" onClick={(e) => { e.stopPropagation(); deleteWorld(w.id, w.name); }}>删除</button>
                      <span className="text-xs text-ink-faint">›</span>
                    </div>
                  </div>
                  <div className="mt-1.5 text-sm text-ink-soft">第 {w.tick} 月</div>
                  <div className="mt-1 text-xs text-ink-faint">种子 {w.seed} · 更新于 {new Date(w.updated_at).toLocaleString('zh-CN')}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {createOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4" onClick={() => setCreateOpen(false)}>
            <div className="w-full max-w-sm rounded-2xl border border-border bg-panel p-5" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-semibold text-ink">开一界</h3>
              <div className="mt-4 flex flex-col gap-3">
                <div>
                  <label className="text-xs text-ink-soft">世界名（留空自动命名）</label>
                  <input className="mt-1 w-full rounded-lg border border-border bg-bg-muted px-3 py-2 text-sm text-ink" placeholder="如：青莲界" value={createName} onChange={(e) => setCreateName(e.target.value)} />
                </div>
                <div>
                  <label className="text-xs text-ink-soft">修士规模</label>
                  <div className="mt-1 flex gap-2">
                    {[20, 40, 80].map((n) => (
                      <button key={n} className={`flex-1 rounded-lg px-2 py-2 text-sm ${createScale === n ? 'bg-rose text-ink-on' : 'border border-border bg-bg-muted text-ink-soft'}`} onClick={() => setCreateScale(n)}>{n} 修士</button>
                    ))}
                  </div>
                </div>
                <button className="mt-1 w-full rounded-lg bg-rose py-2.5 text-sm text-ink-on" disabled={busy} onClick={createWorld}>{busy ? '开辟中...' : '开辟此界'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── 渲染：世界视图 ──
  const map = state?.map;
  const player = state?.player;
  const npcLocs = new Map<number, WorldNpcSummary[]>();
  state?.npcs.forEach((n) => {
    if (!n.alive) return;
    const arr = npcLocs.get(n.loc) ?? [];
    arr.push(n);
    npcLocs.set(n.loc, arr);
  });

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
        <button className="text-ink-soft" onClick={() => { setView('list'); setCurrentId(null); setState(null); }}>←</button>
        <span className="font-semibold text-ink">{state?.name ?? '衍生世界'}</span>
        <span className="rounded-full bg-bg-muted px-2 py-0.5 text-xs text-ink-soft">第 {state?.tick ?? 0} 月</span>
        <button className="ml-auto rounded-full border border-status-red/40 px-2.5 py-0.5 text-xs text-status-red" onClick={() => state && deleteWorld(state.id, state.name)}>弃界</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-[81px]">
        {/* 玩家状态 */}
        {player && (
          <div className="mt-3 rounded-2xl border border-border frosted-glass p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-semibold text-ink">{player.name}</span>
                <span className="ml-2 text-sm text-ink-soft">{player.realmName} · {player.locName}</span>
              </div>
              <button className="rounded-lg bg-rose px-3 py-1.5 text-sm text-ink-on" onClick={() => setCraftOpen(true)}>开炉炼制</button>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs text-ink-soft">
              <div><div className="text-base font-semibold text-ink">{player.qi}</div>气</div>
              <div><div className="text-base font-semibold text-ink">{player.fortune}</div>气运</div>
              <div><div className="text-base font-semibold text-ink">{player.comprehension}</div>悟性</div>
              <div><div className="text-base font-semibold text-ink">{player.charm}</div>魅力</div>
            </div>
            {player.backpack.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {player.backpack.map((it) => (
                  <span key={it.id} className="rounded-full bg-bg-muted px-2 py-0.5 text-xs text-ink-soft">{it.name}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 时间推进 */}
        <div className="mt-3 flex gap-2">
          <button className="flex-1 rounded-lg border border-border bg-bg-muted py-2 text-sm text-ink" disabled={busy} onClick={() => advance(1)}>打坐一月</button>
          <button className="flex-1 rounded-lg border border-border bg-bg-muted py-2 text-sm text-ink" disabled={busy} onClick={() => advance(12)}>闭关一年</button>
        </div>

        {/* 地图 */}
        {map && (
          <div className="mt-3 rounded-2xl border border-border frosted-glass p-4">
            <div className="mb-2 flex items-center justify-between text-xs text-ink-soft">
              <span>此界舆图</span>
              <span className="text-ink-faint">{map.size}×{map.size} · 点击格子行至该处</span>
            </div>
            <div className="grid gap-px overflow-hidden rounded-lg border border-border" style={{ gridTemplateColumns: `repeat(${map.size}, minmax(0, 1fr))` }}>
              {Array.from({ length: map.size * map.size }, (_, loc) => {
                const gx = loc % map.size;
                const gy = Math.floor(loc / map.size);
                const regionIdx = Math.floor(gy / map.cells) * map.regions + Math.floor(gx / map.cells);
                const isPlayer = player?.loc === loc;
                const npcsHere = npcLocs.get(loc);
                return (
                  <button
                    key={loc}
                    title={cellName(loc, map)}
                    onClick={() => move(loc)}
                    className="relative flex aspect-square items-center justify-center"
                    style={{ backgroundColor: REGION_TINTS[regionIdx % REGION_TINTS.length] }}
                  >
                    {isPlayer && <span className="absolute inset-0 rounded-sm ring-2 ring-rose" />}
                    {isPlayer && <span className="text-[10px] font-bold text-rose">你</span>}
                    {!isPlayer && npcsHere && (
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: npcsHere.length > 1 ? '#e91e63' : '#4caf50' }} />
                    )}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-faint">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#4caf50]" /> 修士</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[#e91e63]" /> 多人</span>
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full ring-1 ring-rose" /> 你</span>
            </div>
          </div>
        )}

        {/* 事件流 */}
        <div className="mt-3 rounded-2xl border border-border frosted-glass p-4">
          <h3 className="text-sm font-semibold text-ink">近月风云</h3>
          {(state?.recentEvents.length ?? 0) === 0 ? (
            <div className="mt-2 text-sm text-ink-soft">此界初开，尚无风波。</div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              {state!.recentEvents.slice(0, 15).map((e) => (
                <div key={e.id} className="flex items-baseline gap-2 text-sm">
                  <span className="shrink-0 text-xs text-ink-faint">第{e.tick}月</span>
                  <span className="text-ink-soft">{e.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 修士列表 */}
        <div className="mt-3 rounded-2xl border border-border frosted-glass p-4">
          <h3 className="text-sm font-semibold text-ink">此界修士 <span className="ml-1 text-xs font-normal text-ink-faint">{state?.npcs.filter((n) => n.alive).length ?? 0} 位在世</span></h3>
          <div className="mt-2 flex flex-col gap-1.5">
            {state?.npcs.filter((n) => n.alive).map((n) => (
              <button key={n.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-bg-muted" onClick={() => openTalk(n)}>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-solid text-xs font-semibold text-solid-contrast">{n.name.slice(-1)}</span>
                <span className="text-ink">{n.name}</span>
                <span className="text-xs text-ink-faint">{n.realmName} · {n.faction}</span>
                <span className="ml-auto text-xs text-ink-faint">{n.locName}</span>
                {n.hasCard && <span className="text-[10px] text-rose">已识</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 对话弹窗 */}
      {talkNpc && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/40 backdrop-blur-xs" onClick={() => setTalkNpc(null)}>
          <div className="mt-auto flex max-h-[80vh] w-full flex-col rounded-t-2xl border-t border-border bg-panel p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-solid text-sm font-semibold text-solid-contrast">{talkNpc.name.slice(-1)}</span>
              <div>
                <div className="font-semibold text-ink">{talkNpc.name}</div>
                <div className="text-xs text-ink-faint">{talkNpc.realmName} · {talkNpc.faction} · 好感 {talkNpc.affinityToPlayer}</div>
              </div>
              <button className="ml-auto text-ink-soft" onClick={() => setTalkNpc(null)}>✕</button>
            </div>
            <div className="mt-3 flex-1 overflow-y-auto">
              {talkLog.length === 0 ? (
                <div className="py-4 text-center text-sm text-ink-soft">你与{talkNpc.name}初次相遇，说点什么？</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {talkLog.map((m, i) => (
                    <div key={i} className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.speaker === 'player' ? 'self-end bg-rose text-ink-on' : 'self-start bg-bg-muted text-ink'}`}>
                      {m.speaker === 'player' ? m.text : renderText(m.text)}
                    </div>
                  ))}
                </div>
              )}
              {talking && <div className="mt-2 text-xs text-ink-faint">{talkNpc.name} 正在思索...</div>}
            </div>
            <div className="mt-3 flex gap-2">
              <input className="flex-1 rounded-lg border border-border bg-bg-muted px-3 py-2 text-sm text-ink" placeholder="说点什么..." value={talkInput} onChange={(e) => setTalkInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendTalk(); }} />
              <button className="rounded-lg bg-rose px-4 py-2 text-sm text-ink-on" disabled={talking || !talkInput.trim()} onClick={sendTalk}>发送</button>
            </div>
          </div>
        </div>
      )}

      {/* 炼制弹窗 */}
      {craftOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-xs p-4" onClick={() => { setCraftOpen(false); setBoard(null); setCraftResult(null); }}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-ink">开炉炼制</h3>
              <button className="text-ink-soft" onClick={() => { setCraftOpen(false); setBoard(null); setCraftResult(null); }}>✕</button>
            </div>
            {!board && !craftResult && (
              <div className="mt-3 flex flex-col gap-2">
                {PLAYER_RECIPES.map((r) => (
                  <button key={r.id} className="flex items-center gap-2 rounded-lg border border-border bg-bg-muted px-3 py-2.5 text-left text-sm" onClick={() => startCraft(r.id)}>
                    <span className="text-ink">{r.name}</span>
                    <span className="text-xs text-ink-faint">→ {r.output}</span>
                    <span className="ml-auto text-xs text-ink-faint">{r.materials}</span>
                  </button>
                ))}
              </div>
            )}
            {craftResult && (
              <div className="mt-3 flex flex-col gap-3">
                <div className="rounded-lg bg-bg-rose-soft/60 px-3 py-2.5 text-sm text-rose">{craftResult}</div>
                <button className="w-full rounded-lg bg-rose py-2.5 text-sm text-ink-on" onClick={() => setCraftResult(null)}>再炼一次</button>
              </div>
            )}
            {board && recipeId != null && (
              <div className="mt-3 flex flex-col gap-3">
                <div className="text-sm text-ink-soft">{recipeLabel} · 交换相邻格消除，步数尽即出成品</div>
                <Match2Board board={board} onSwap={swap} disabled={busy} />
                <button className="w-full rounded-lg bg-rose py-2.5 text-sm text-ink-on" disabled={busy} onClick={() => finishCraft(board)}>就此收炉（{board.score} 分）</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
