import { useState, useEffect } from 'react';
import { CheckCircle2, Star } from 'lucide-react';
import { api, type MissionInfo } from '../lib/api';

function fmtDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

export function MissionRecords() {
  const [missions, setMissions] = useState<MissionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { missions: list } = await api.getMissions();
        // 只列已完成的，按完成时间倒序
        const done = list
          .filter((m) => m.status === 'completed')
          .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
        setMissions(done);
      } catch (e) {
        console.error('加载任务记录失败', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="w-full max-w-md mx-auto min-h-full pb-24 flex flex-col select-none">
      <header className="flex items-center justify-between py-1.5 mb-2.5">
        <h1 className="text-sm font-bold text-ink tracking-tight">任务记录</h1>
      </header>

      {loading ? (
        <p className="text-center text-xs text-ink-faint py-12">加载中...</p>
      ) : missions.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle2 className="w-8 h-8 mx-auto mb-2 opacity-40 text-ink" />
          <p className="text-xs text-ink-faint">还没有完成过的任务</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {missions.map((m) => (
            <div key={m.id} className="frosted-glass rounded-xl p-3.5 border border-border shadow-xs space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <CheckCircle2 className="w-3.5 h-3.5 text-sage shrink-0" />
                  <h3 className="text-xs font-semibold text-ink leading-snug truncate">{m.title}</h3>
                </div>
                {m.ratingScore !== null && m.ratingScore !== undefined && (
                  <span className="flex items-center gap-0.5 text-[11px] font-semibold text-amber shrink-0">
                    <Star className="w-3 h-3 fill-amber text-amber" />
                    {m.ratingScore}
                  </span>
                )}
              </div>

              {m.worldName && (
                <div className="text-[11px] text-ink-muted">🌐 {m.worldName}</div>
              )}

              {m.evaluationResult?.summary && (
                <div className="text-[11px] text-ink-soft leading-relaxed line-clamp-2">
                  {m.evaluationResult.summary}
                </div>
              )}

              <div className="flex items-center gap-2 pt-0.5">
                {m.completedAt && (
                  <span className="text-[10px] text-ink-faint">完成于 {fmtDate(m.completedAt)}</span>
                )}
                {m.reward > 0 && (
                  <span className="ml-auto text-[10px] text-ink-faint">奖励 {m.reward}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
