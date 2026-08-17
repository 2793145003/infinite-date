import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { MissionInfo } from '../lib/api';

interface YaoCast {
  coins: boolean[]; // 三枚铜钱正反（true=背）
  backs: number;    // 背数 0-3
}

/** 背数(0-3) → 阴阳 + 是否动爻。背=阳、字=阴。3老阳○动 / 2少阴 / 1少阳 / 0老阴×动 */
function backsToYao(backs: number): { yang: boolean; dong: boolean } {
  if (backs === 3) return { yang: true, dong: true };
  if (backs === 2) return { yang: false, dong: false };
  if (backs === 1) return { yang: true, dong: false };
  return { yang: false, dong: true };
}

/** 从任务卦象（六爻阴阳 + 动爻位）反推 6 爻背数（刷新后失败重试用） */
function castFromHex(hex: { lines?: number[]; dong?: number[] }): number[] {
  const lines = hex.lines ?? [];
  const dong = hex.dong ?? [];
  return Array.from({ length: 6 }, (_, i) => {
    const yang = lines[i] === 1;
    const isDong = dong.includes(i + 1);
    if (yang && isDong) return 3; // 老阳
    if (yang) return 1;           // 少阳
    if (isDong) return 0;         // 老阴
    return 2;                     // 少阴
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const WORLD_STATUSES = ['available', 'active', 'preparing', 'failed'];

/**
 * 首页卦象卡：有任务显示任务卦象，无任务点一下抛三枚铜钱出一爻（六爻成卦）。
 * 成卦瞬间自动异步生成任务（后台 LLM）；生成失败可点重试；已生成点一下跳转任务界面。
 */
export function DivinationCard({ onNavigateToMissions }: { onNavigateToMissions: () => void }) {
  const [mission, setMission] = useState<MissionInfo | null>(null);
  const [yaos, setYaos] = useState<YaoCast[]>([]);
  const [flip, setFlip] = useState<{ coins: boolean[]; dur: number } | null>(null);
  const [flipKey, setFlipKey] = useState(0);
  const [lastCoins, setLastCoins] = useState<boolean[] | null>(null);
  const [rolling, setRolling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [divineName, setDivineName] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPoll = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const load = useCallback(async () => {
    try {
      const data = await api.getMissions();
      const m = data.missions.find(x => x.questType === 'world' && WORLD_STATUSES.includes(x.status)) ?? null;
      setMission(m);
      return m;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    load();
    return clearPoll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPoll = useCallback(() => {
    clearPoll();
    pollRef.current = setInterval(async () => {
      const m = await load();
      if (m && (m.status === 'available' || m.status === 'active' || m.status === 'failed')) {
        clearPoll();
        setSubmitting(false);
      }
    }, 2000);
  }, [load]);

  // 成卦瞬间 → 自动异步生成任务
  useEffect(() => {
    if (yaos.length === 6 && !mission && !submitting) {
      const cast = yaos.map(y => y.backs);
      setSubmitting(true);
      api.prepareMission(cast)
        .then((res) => {
          setDivineName(res.guaXiang);
          startPoll();
          load();
        })
        .catch(() => {
          // 请求失败（网络/后端拒绝）→ 静默，仍可再点重试
          setSubmitting(false);
        });
    }
  }, [yaos, mission, submitting, load, startPoll]);

  // 取 6 爻背数（成卦后重试用）：优先本地，其次从任务卦象反推
  const getCast = (): number[] | null => {
    if (yaos.length === 6) return yaos.map(y => y.backs);
    if (mission?.hexagram?.lines?.length === 6) return castFromHex(mission.hexagram);
    return null;
  };

  const handleTap = async () => {
    if (rolling || submitting) return;
    const status = mission?.status;

    if (status === 'available' || status === 'active') {
      onNavigateToMissions(); // 已生成 → 跳转任务界面确认任务信息
      return;
    }
    if (status === 'preparing') return; // 生成中，点无效果

    if (status === 'failed') {
      const cast = getCast();
      if (!cast) return;
      setSubmitting(true);
      setMission(null);
      try {
        const res = await api.prepareMission(cast);
        setDivineName(res.guaXiang);
        startPoll();
        load();
      } catch {
        setSubmitting(false);
      }
      return;
    }

    // 空 → 点一下抛三枚铜钱出一爻
    if (yaos.length >= 6) return;
    setRolling(true);
    const coins = [Math.random() < 0.5, Math.random() < 0.5, Math.random() < 0.5];
    const backs = coins.filter(Boolean).length;
    setFlip({ coins, dur: 680 });
    setFlipKey(k => k + 1);
    await sleep(680);
    setYaos(prev => [...prev, { coins, backs }]);
    setLastCoins(coins);
    setFlip(null);
    setRolling(false);
  };

  // ── 渲染数据 ──
  const hex = mission?.hexagram ?? null;
  const hexLines = hex?.lines ?? null;
  const hexDong = hex?.dong ?? [];
  const status = mission?.status ?? null;
  const hexName = hex?.ben ?? divineName ?? (status === 'available' || status === 'active' ? '无卦' : '未起卦');
  const hasHex = !!hexLines || yaos.length >= 6;

  // 六爻渲染数据（初→上，即从下往上）
  const rows: { yang: boolean | null; dong: boolean }[] = [];
  for (let i = 0; i < 6; i++) {
    if (hexLines) {
      rows.push({ yang: hexLines[i] === 1, dong: hexDong.includes(i + 1) });
    } else if (i < yaos.length) {
      const y = backsToYao(yaos[i]!.backs);
      rows.push({ yang: y.yang, dong: y.dong });
    } else {
      rows.push({ yang: null, dong: false });
    }
  }

  let statusText = '';
  let statusKind = '';
  if (status === 'available' || status === 'active') {
    statusText = hex ? '' : '任务进行中'; statusKind = 'ready';
  }
  else if (status === 'preparing') { statusText = '生成中…'; statusKind = 'busy'; }
  else if (status === 'failed') { statusText = '点击重试'; statusKind = 'err'; }
  else if (yaos.length === 6) { statusText = '生成中…'; statusKind = 'busy'; }
  else { statusText = ''; statusKind = 'idle'; }

  return (
    <div
      className={`id-div-card${statusKind ? ` is-${statusKind}` : ''}${hasHex ? ' is-cast' : ''}`}
      onClick={handleTap}
    >
      {hasHex && (
        <div className="id-div-card-head">
          <span className="id-div-card-title">卦象</span>
          <span className="id-div-card-sub">{hexName ?? '未起卦'}</span>
        </div>
      )}

      <div className="id-div-card-hex">
        <div className={`id-divine-yaos${hasHex ? '' : ' is-pending'}`}>
          {rows.map((r, i) => (
            <div className="id-yao" key={i}>
              <span className={`id-yao-mark${r.dong ? ' is-dong' : ''}`}>
                {r.dong && <i className={`id-yao-dong-mark${r.yang ? ' is-yang' : ' is-yin'}`} />}
              </span>
              {r.yang === null ? (
                <div className="id-yao-bar is-yang is-pending"><span className="id-yao-seg" /></div>
              ) : (
                <div className={`id-yao-bar${r.yang ? ' is-yang' : ' is-yin'}`}>
                  {r.yang
                    ? <span className="id-yao-seg" />
                    : <><span className="id-yao-seg" /><span className="id-yao-seg" /></>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 三枚铜钱（金=字面 / 银=背面）——成卦后隐藏，突出卦象 */}
      {!hasHex && (
        <div className="id-div-card-coins">
          {[0, 1, 2].map((i) => {
            const coins = flip ? flip.coins : lastCoins;
            const isBack = coins ? !!coins[i] : false;
            const dur = flip ? flip.dur : 720;
            return (
              <div className="id-coin id-coin-sm" key={`${flipKey}-${i}`}>
                <div
                  className={`id-coin-inner ${isBack ? 'is-back' : 'is-front'}${flip ? ' is-rolling' : ''}`}
                  style={{ '--flip-end': isBack ? '900deg' : '720deg', '--flip-dur': `${dur}ms` } as any}
                >
                  <div className="id-coin-face is-front" />
                  <div className="id-coin-face is-back" />
                </div>
                <span className="id-coin-hole" />
              </div>
            );
          })}
        </div>
      )}

      {statusText && <div className="id-div-card-hint">{statusText}</div>}
    </div>
  );
}
