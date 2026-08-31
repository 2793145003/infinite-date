import { useState, useEffect, useCallback } from 'react';
import { api, imageUrl, type NovelInfo } from '../lib/api';

type NovelView = 'square' | 'mine';

export function NovelList({
  onBack,
  onOpenEditor,
  onOpenPlay,
  currentPlayerId,
}: {
  onBack: () => void;
  onOpenEditor: (novelId: string | null) => void;
  onOpenPlay: (sessionId: string) => void;
  currentPlayerId: string | null;
}) {
  const [view, setView] = useState<NovelView>('square');
  const [novels, setNovels] = useState<NovelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeNovel, setActiveNovel] = useState<{ active: boolean; sessionId?: string; title?: string } | null>(null);
  const [enteringId, setEnteringId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [novelData, activeData] = await Promise.all([
        api.getNovels({ mine: view === 'mine' }),
        api.getActiveNovel(),
      ]);
      setNovels(novelData.novels);
      setActiveNovel(activeData);
    } catch (e) {
      console.error('加载小说失败', e);
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleEnter = async (novelId: string) => {
    if (enteringId) return;
    setEnteringId(novelId);
    try {
      const { sessionId } = await api.novelEnter(novelId);
      onOpenPlay(sessionId);
    } catch (e: any) {
      window.alert(e?.message || '进入失败');
    } finally {
      setEnteringId(null);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
        <button className="text-ink-soft" onClick={onBack}>←</button>
        <span className="font-semibold text-ink">互动小说</span>
        <button
          className="ml-auto rounded-lg bg-rose px-3 py-1.5 text-sm text-ink-on"
          onClick={() => onOpenEditor(null)}
        >＋ 创作</button>
      </div>

      {activeNovel?.active && activeNovel.sessionId && (
        <div
          className="mx-4 mt-3 cursor-pointer rounded-xl bg-bg-rose-soft/60 px-4 py-3 text-sm text-rose"
          onClick={() => onOpenPlay(activeNovel.sessionId!)}
        >
          <span>写作中：{activeNovel.title ?? '互动小说'}</span>
          <span className="float-right">继续写 →</span>
        </div>
      )}

      <div className="flex gap-2 px-4 py-3">
        {(['square', 'mine'] as NovelView[]).map(v => (
          <button
            key={v}
            className={`rounded-full px-4 py-1.5 text-sm ${view === v ? 'bg-rose text-ink-on' : 'frosted-glass text-ink-soft border border-border'}`}
            onClick={() => setView(v)}
          >
            {v === 'square' ? '广场' : '我的'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-[81px]">
        {loading ? (
          <div className="py-8 text-center text-sm text-ink-soft">加载中...</div>
        ) : novels.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-soft">
            {view === 'square' ? '广场还没有发布的小说' : '还没有创作小说，点右上角「＋ 创作」开始'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {novels.map(n => (
              <div
                key={n.id}
                className="cursor-pointer rounded-2xl border border-border frosted-glass p-4 transition hover:shadow-sm"
                onClick={() => view === 'mine' ? onOpenEditor(n.id) : handleEnter(n.id)}
              >
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-ink">{n.title}</h3>
                  <div className="flex items-center gap-2">
                    {view === 'square' && n.authorId === currentPlayerId && (
                      <button
                        className="rounded-full border border-border px-2.5 py-0.5 text-xs text-ink-soft"
                        onClick={(e) => { e.stopPropagation(); onOpenEditor(n.id); }}
                      >编辑</button>
                    )}
                    <span className={`rounded-full px-2 py-0.5 text-xs ${n.status === 'published' ? 'bg-bg-rose-soft/60 text-rose' : 'bg-bg-muted/60 text-ink-soft'}`}>
                      {n.status === 'published' ? '已发布' : '草稿'}
                    </span>
                  </div>
                </div>
                {n.summary && <p className="mt-1.5 text-sm text-ink-soft" style={{ lineHeight: 1.5 }}>{n.summary}</p>}
                {(n.characterNames?.length ?? 0) > 0 && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {n.characterNames!.map((name, i) => {
                      const avatar = n.characterAvatars?.[i];
                      return (
                        <span key={`${name}-${i}`} className="flex items-center gap-1.5">
                          {avatar ? (
                            <img src={imageUrl(avatar)} alt={name} className="h-7 w-7 rounded-full object-cover border border-border" />
                          ) : (
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-solid text-xs font-semibold text-solid-contrast">
                              {name.slice(-1)}
                            </span>
                          )}
                          <span className="text-xs text-ink-faint">{name}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between text-xs text-ink-faint">
                  <span>游玩{n.playCount}次</span>
                  <span>›</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
