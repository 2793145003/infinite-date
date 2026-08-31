import { useState, useEffect, useCallback, useRef, type ChangeEvent } from 'react';
import { api, imageUrl, type NovelInfo, type NovelCharacter } from '../lib/api';
import { PlayerChipInput, type PlayerChipInputHandle } from './PlayerChipInput';

const FIELD_DEFS = [
  { snake: 'world_setting', camel: 'worldSetting', label: '世界观', placeholder: '这个世界是怎样的？可手写或点右侧 roll' },
  { snake: 'protagonist_setting', camel: 'protagonistSetting', label: '玩家身份', placeholder: '玩家在这个世界里的身份处境，可手写或 roll' },
] as const;

// 起名页草稿：输入自动存 localStorage，刷新/重开自动回填
const NOVEL_DRAFT_KEY = 'novel_draft_v1';

function readDraft(): { title: string; summary: string } {
  try {
    const raw = localStorage.getItem(NOVEL_DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return {
        title: typeof d.title === 'string' ? d.title : '',
        summary: typeof d.summary === 'string' ? d.summary : '',
      };
    }
  } catch {}
  return { title: '', summary: '' };
}

export function NovelEditor({
  novelId,
  onBack,
  onEnter,
}: {
  novelId: string | null;
  onBack: () => void;
  onEnter: (sessionId: string) => void;
}) {
  // 创建阶段
  const [title, setTitle] = useState(() => readDraft().title);
  const [summary, setSummary] = useState(() => readDraft().summary);
  const [creating, setCreating] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);

  // 编辑阶段
  const [currentId, setCurrentId] = useState<string | null>(novelId);
  const [novel, setNovel] = useState<NovelInfo | null>(null);
  const [characters, setCharacters] = useState<NovelCharacter[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingField, setRollingField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 角色编辑表单
  const [charName, setCharName] = useState('');
  const [charGender, setCharGender] = useState('');
  const [charPersona, setCharPersona] = useState('');
  const [charAnchor, setCharAnchor] = useState('');
  const [charAppearance, setCharAppearance] = useState('');
  const [editingCharId, setEditingCharId] = useState<string | null>(null);
  const [rollCount, setRollCount] = useState(3);
  const [rollDirection, setRollDirection] = useState('');
  const [charAvatar, setCharAvatar] = useState('');
  const [generatingAvatar, setGeneratingAvatar] = useState(false);
  const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const avatarFileRef = useRef<HTMLInputElement>(null);

  const createSummaryRef = useRef<PlayerChipInputHandle>(null);
  const editSummaryRef = useRef<PlayerChipInputHandle>(null);
  const fieldRefs = useRef<Record<string, PlayerChipInputHandle | null>>({});
  const charPersonaRef = useRef<PlayerChipInputHandle>(null);
  const openingRef = useRef<PlayerChipInputHandle>(null);

  const loadNovel = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const { novel: n, characters: c } = await api.getNovel(id);
      setNovel(n);
      setCharacters(c);
    } catch (e) {
      console.error('加载小说失败', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (currentId) loadNovel(currentId);
  }, [currentId, loadNovel]);

  // 起名页草稿自动保存（输入即存；清空即删）
  useEffect(() => {
    try {
      if (title.trim() || summary.trim()) {
        localStorage.setItem(NOVEL_DRAFT_KEY, JSON.stringify({ title, summary }));
      } else {
        localStorage.removeItem(NOVEL_DRAFT_KEY);
      }
    } catch {}
  }, [title, summary]);

  const handleImport = async () => {
    if (!importText.trim()) return;
    setImporting(true);
    try {
      const { novelId: id } = await api.importNovel(importText.trim());
      localStorage.removeItem(NOVEL_DRAFT_KEY);
      setTitle('');
      setSummary('');
      setImportText('');
      setShowImport(false);
      setCurrentId(id);
      await loadNovel(id);
    } catch (e: any) {
      window.alert(e?.message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) return window.alert('小说名不能为空');
    setCreating(true);
    try {
      const { novelId: id } = await api.createNovel({ title: title.trim(), summary: summary.trim() });
      localStorage.removeItem(NOVEL_DRAFT_KEY);
      setTitle('');
      setSummary('');
      setCurrentId(id);
      await loadNovel(id);
    } catch (e: any) {
      window.alert(e?.message || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdateField = async (snake: string, value: string) => {
    if (!currentId) return;
    try {
      await api.updateNovel(currentId, { [snake]: value });
    } catch (e: any) {
      console.error('保存失败', e);
    }
  };

  const handleRollField = async (snake: string) => {
    if (!currentId || rollingField) return;
    setRollingField(snake);
    try {
      const { value } = await api.rollNovelField(currentId, snake);
      const def = FIELD_DEFS.find(d => d.snake === snake);
      if (def) setNovel(prev => prev ? { ...prev, [def.camel]: value } : prev);
    } catch (e: any) {
      window.alert(e?.message || '生成失败');
    } finally {
      setRollingField(null);
    }
  };

  const handleRollCharacters = async () => {
    if (!currentId || busy) return;
    setBusy(true);
    try {
      const { characters: c } = await api.rollNovelCharacters(currentId, rollCount, rollDirection || undefined);
      setCharacters(prev => [...prev, ...c]);
    } catch (e: any) {
      window.alert(e?.message || '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRollOpening = async () => {
    if (!currentId || busy) return;
    setBusy(true);
    try {
      const { opening } = await api.rollNovelOpening(currentId);
      setNovel(prev => prev ? { ...prev, opening } : prev);
    } catch (e: any) {
      window.alert(e?.message || '生成失败');
    } finally {
      setBusy(false);
    }
  };

  const handleAddCharacter = async () => {
    if (!currentId) return;
    if (!charName.trim()) return window.alert('角色名字不能为空');
    setBusy(true);
    try {
      const { character } = await api.addNovelCharacter(currentId, {
        name: charName.trim(),
        gender: charGender || undefined,
        persona: charPersona.trim(),
        emotional_anchor: charAnchor.trim() || undefined,
        appearance: charAppearance.trim(),
        avatar: charAvatar || undefined,
      });
      setCharacters(prev => [...prev, character]);
      setCharName(''); setCharGender(''); setCharPersona(''); setCharAnchor(''); setCharAppearance(''); setCharAvatar('');
    } catch (e: any) {
      window.alert(e?.message || '添加失败');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCharacter = async () => {
    if (!currentId || !editingCharId) return;
    if (!charName.trim()) return window.alert('角色名字不能为空');
    setBusy(true);
    try {
      const { character } = await api.updateNovelCharacter(currentId, editingCharId, {
        name: charName.trim(),
        gender: charGender || undefined,
        persona: charPersona.trim(),
        emotional_anchor: charAnchor.trim() || undefined,
        appearance: charAppearance.trim(),
        avatar: charAvatar || undefined,
      });
      setCharacters(prev => prev.map(c => c.id === editingCharId ? character : c));
      setEditingCharId(null); setCharName(''); setCharGender(''); setCharPersona(''); setCharAnchor(''); setCharAppearance(''); setCharAvatar('');
    } catch (e: any) {
      window.alert(e?.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const handleEditCharacter = (c: NovelCharacter) => {
    setEditingCharId(c.id);
    setCharName(c.name);
    setCharGender(c.gender ?? '');
    setCharPersona(c.persona);
    setCharAnchor(c.emotionalAnchor ?? '');
    setCharAppearance(c.appearance);
    setCharAvatar(c.avatar ?? '');
  };

  const handleCancelEdit = () => {
    setEditingCharId(null); setCharName(''); setCharGender(''); setCharPersona(''); setCharAnchor(''); setCharAppearance(''); setCharAvatar('');
  };

  const handleDeleteCharacter = async (charId: string) => {
    if (!currentId) return;
    if (!window.confirm('确定删除这个角色？')) return;
    try {
      await api.deleteNovelCharacter(currentId, charId);
      setCharacters(prev => prev.filter(c => c.id !== charId));
    } catch (e: any) {
      window.alert(e?.message || '删除失败');
    }
  };

  const handleAvatarFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowAvatarMenu(false);
    setUploadingAvatar(true);
    try {
      const res = await api.uploadImage(file);
      setCharAvatar(res.imagePath);
    } catch (err) {
      window.alert((err as Error).message || '上传失败');
    } finally {
      setUploadingAvatar(false);
      e.target.value = '';
    }
  };

  const handleGenerateAvatar = async () => {
    if (!charAppearance.trim()) return window.alert('先填「外貌」描述，再生成头像');
    setShowAvatarMenu(false);
    setGeneratingAvatar(true);
    try {
      const { imagePath } = await api.generateImage(charAppearance.trim(), { gender: charGender || undefined });
      setPendingAvatar(imagePath);
    } catch (e: any) {
      window.alert(e?.message || '生成失败');
    } finally {
      setGeneratingAvatar(false);
    }
  };

  const applyPendingAvatar = () => {
    if (pendingAvatar) {
      setCharAvatar(pendingAvatar);
      setPendingAvatar(null);
    }
  };

  const handlePublish = async () => {
    if (!currentId) return;
    if (!novel?.opening?.trim()) return window.alert('开场还没写，先手写或 roll 一段开场');
    if (characters.length === 0) return window.alert('还没有角色，先添加或 roll 几个角色');
    setBusy(true);
    try {
      await api.updateNovel(currentId, { status: 'published' });
      const { sessionId } = await api.novelEnter(currentId);
      onEnter(sessionId);
    } catch (e: any) {
      window.alert(e?.message || '发布失败');
    } finally {
      setBusy(false);
    }
  };

  // ── 创建阶段 ──
  if (!currentId) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
          <button className="text-ink-soft" onClick={onBack}>←</button>
          <span className="font-semibold text-ink">创作小说</span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 pb-[81px]">
          {/* 一键导入 */}
          <div className="mb-4 rounded-xl border border-border bg-bg-soft p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">✨ 一键导入写好的设定</span>
              <button type="button" className="text-xs text-ink-soft" onClick={() => setShowImport(v => !v)}>
                {showImport ? '收起' : '展开'}
              </button>
            </div>
            {showImport && (
              <>
                <p className="mt-1.5 text-xs text-ink-muted leading-relaxed">把完整设定整段粘进来，自动拆成书名/简介/世界观/玩家身份/角色，缺失的外貌和开场白也会补上。</p>
                <textarea
                  className="mt-2 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-border-strong"
                  placeholder="粘贴你的完整设定（可几千字）..."
                  rows={8}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                />
                <button
                  className="mt-2 w-full rounded-lg bg-rose px-3 py-2 text-sm font-semibold text-ink-on disabled:opacity-50"
                  onClick={handleImport}
                  disabled={importing || !importText.trim()}
                >
                  {importing ? '导入中（可能要几十秒）...' : '导入'}
                </button>
              </>
            )}
          </div>
          <label className="mb-1.5 block text-sm font-semibold text-ink">小说名</label>
          <input
            className="w-full rounded-xl border border-border bg-bg-soft px-3 py-2.5 text-sm text-ink outline-none focus:border-border-strong"
            placeholder="给这部小说起个名字"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="mt-4 mb-1.5 flex items-center justify-between">
            <label className="text-sm font-semibold text-ink">一句话简介</label>
            <button
              type="button"
              className="rounded-full border border-border px-2.5 py-0.5 text-xs text-ink-soft"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => createSummaryRef.current?.insertPlayer()}
            >玩家</button>
          </div>
          <PlayerChipInput
            ref={createSummaryRef}
            className="w-full rounded-xl border border-border bg-bg-soft px-3 py-2.5 text-sm text-ink outline-none focus:border-border-strong"
            placeholder="这部小说讲什么（可选）"
            rows={3}
            value={summary}
            onChange={setSummary}
          />
          <button
            className="mt-4 w-full rounded-xl bg-rose py-3 text-sm font-semibold text-ink-on"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? '创建中...' : '创建，继续设定'}
          </button>
        </div>
      </div>
    );
  }

  if (loading || !novel) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-transparent">
        <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
          <button className="text-ink-soft" onClick={onBack}>←</button>
          <span className="font-semibold text-ink">编辑小说</span>
        </div>
        <div className="py-8 text-center text-sm text-ink-soft">加载中...</div>
      </div>
    );
  }

  // ── 编辑阶段 ──
  return (
    <div className="flex h-full flex-col overflow-hidden bg-transparent">
      <div className="flex items-center gap-3 border-b border-border frosted-glass px-4 py-3">
        <button className="text-ink-soft" onClick={onBack}>←</button>
        <span className="font-semibold text-ink">{novel.title}</span>
        <button
          className="ml-auto rounded-lg bg-rose px-3 py-1.5 text-sm text-ink-on disabled:opacity-50"
          onClick={handlePublish}
          disabled={busy}
        >
          {busy ? '处理中...' : novel.status === 'published' ? '进入写作' : '发布并开始'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-[81px]">
        {/* 简介 */}
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-sm font-semibold text-ink">简介</label>
          <button
            type="button"
            className="rounded-full border border-border px-2.5 py-0.5 text-xs text-ink-soft"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editSummaryRef.current?.insertPlayer()}
          >玩家</button>
        </div>
        <PlayerChipInput
          ref={editSummaryRef}
          className="w-full rounded-xl border border-border bg-bg-soft px-3 py-2.5 text-sm text-ink outline-none focus:border-border-strong"
          rows={2}
          value={novel.summary}
          onChange={(v) => setNovel(prev => prev ? { ...prev, summary: v } : prev)}
          onBlur={(text) => handleUpdateField('summary', text)}
        />

        {/* 世界观 / 玩家身份 */}
        {FIELD_DEFS.map(def => (
          <div key={def.snake} className="mt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-semibold text-ink">{def.label}</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-ink-soft"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => fieldRefs.current[def.snake]?.insertPlayer()}
                >玩家</button>
                <button
                  className="rounded-full frosted-glass border border-border px-3 py-1 text-xs text-ink-soft disabled:opacity-50"
                  onClick={() => handleRollField(def.snake)}
                  disabled={!!rollingField}
                >
                  {rollingField === def.snake ? '生成中...' : '🎲 随机'}
                </button>
              </div>
            </div>
            <PlayerChipInput
              ref={(el) => { fieldRefs.current[def.snake] = el; }}
              className="w-full rounded-xl border border-border bg-bg-soft px-3 py-2.5 text-sm text-ink outline-none focus:border-border-strong"
              rows={3}
              placeholder={def.placeholder}
              value={(novel as any)[def.camel] ?? ''}
              onChange={(v) => setNovel(prev => prev ? { ...prev, [def.camel]: v } : prev)}
              onBlur={(text) => handleUpdateField(def.snake, text)}
            />
          </div>
        ))}

        {/* 角色 */}
        <div className="mt-5 flex items-center justify-between">
          <label className="text-sm font-semibold text-ink">角色（{characters.length}）</label>
        </div>
        {characters.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {characters.map(c => (
              <div key={c.id} className="rounded-xl border border-border frosted-glass p-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-ink">{c.name}{c.gender === 'female' ? '（女）' : c.gender === 'male' ? '（男）' : ''}</span>
                  <div className="flex gap-2">
                    <button className="text-xs text-ink-soft" onClick={() => handleEditCharacter(c)}>编辑</button>
                    <button className="text-xs text-status-red" onClick={() => handleDeleteCharacter(c.id)}>删除</button>
                  </div>
                </div>
                {c.persona && <p className="mt-1 text-xs text-ink-soft" style={{ lineHeight: 1.5 }}>{c.persona}</p>}
                {c.appearance && <p className="mt-0.5 text-xs text-ink-faint" style={{ lineHeight: 1.5 }}>外貌：{c.appearance}</p>}
              </div>
            ))}
          </div>
        )}

        {/* 角色编辑/添加表单 */}
        <div className="mt-3 rounded-xl border border-border bg-bg-soft/50 p-3">
          <div className="mb-1.5 text-xs font-semibold text-ink">{editingCharId ? `编辑 ${charName || '角色'}` : '添加角色'}</div>
          <input
            className="w-full rounded-lg border border-border bg-bg-soft px-2.5 py-2 text-sm text-ink outline-none"
            placeholder="名字"
            value={charName}
            onChange={(e) => setCharName(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-xs text-ink-soft">性别</span>
            {([['', '不限'], ['female', '女'], ['male', '男']] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={`rounded-full px-2.5 py-1 text-xs ${charGender === val ? 'bg-rose text-ink-on' : 'border border-border text-ink-soft'}`}
                onClick={() => setCharGender(val)}
              >{label}</button>
            ))}
          </div>
          <div className="mt-2 mb-1 flex items-center justify-between">
            <span className="text-xs text-ink-soft">人设</span>
            <button
              type="button"
              className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-soft"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => charPersonaRef.current?.insertPlayer()}
            >玩家</button>
          </div>
          <PlayerChipInput
            ref={charPersonaRef}
            className="w-full rounded-lg border border-border bg-bg-soft px-2.5 py-2 text-sm text-ink outline-none"
            placeholder="性格 / 说话风格 / 与主角的关系，一两句"
            rows={2}
            value={charPersona}
            onChange={setCharPersona}
          />
          <div className="mt-2 mb-1 flex items-center justify-between">
            <span className="text-xs text-ink-soft">情绪锚点</span>
          </div>
          <textarea
            className="w-full rounded-lg border border-border bg-bg-soft px-2.5 py-2 text-sm text-ink outline-none resize-none"
            placeholder="负面情绪下的具体身体语言（极端 / 愤怒 / 紧张 / 防御），可留空"
            rows={3}
            value={charAnchor}
            onChange={(e) => setCharAnchor(e.target.value)}
          />
          <input
            className="mt-2 w-full rounded-lg border border-border bg-bg-soft px-2.5 py-2 text-sm text-ink outline-none"
            placeholder="外貌描述（一句话）"
            value={charAppearance}
            onChange={(e) => setCharAppearance(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowAvatarMenu((v) => !v)}
                disabled={busy || uploadingAvatar || generatingAvatar}
                className="w-16 h-16 rounded-xl bg-bg-muted/90 hover:bg-bg-muted-2/80 border border-border-strong flex flex-col items-center justify-center text-ink transition disabled:opacity-50"
              >
                {charAvatar ? (
                  <img src={imageUrl(charAvatar)} alt="头像" className="w-full h-full object-cover rounded-xl" referrerPolicy="no-referrer" />
                ) : (
                  <>
                    <span className="text-base leading-none">{uploadingAvatar || generatingAvatar ? '⏳' : '＋'}</span>
                    <span className="text-[9px] text-ink-muted mt-0.5">头像</span>
                  </>
                )}
              </button>
              {showAvatarMenu && (
                <div className="absolute left-0 top-full mt-1 z-20 bg-panel rounded-lg border border-border shadow-lg py-1 min-w-[128px]">
                  <button
                    type="button"
                    onClick={() => { setShowAvatarMenu(false); avatarFileRef.current?.click(); }}
                    className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
                  >
                    <span>🖼</span>上传图片
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateAvatar}
                    className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
                  >
                    <span>🎨</span>{generatingAvatar ? '生成中…' : '生成图片'}
                  </button>
                  {charAvatar && (
                    <button
                      type="button"
                      onClick={() => { setShowAvatarMenu(false); setCharAvatar(''); }}
                      className="w-full px-3 py-2 text-left text-xs text-ink hover:bg-bg-soft flex items-center gap-2 transition"
                    >
                      <span>✕</span>清除头像
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="flex-1 text-[11px] text-ink-muted leading-relaxed">
              上传本地图片，或点「＋」选「生成图片」按外貌生成。
            </div>
          </div>
          <input
            ref={avatarFileRef}
            type="file"
            accept="image/*"
            onChange={handleAvatarFile}
            className="hidden"
          />
          {(generatingAvatar || pendingAvatar) && (
            <div className="mt-3 rounded-xl border border-border bg-bg-soft/50 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-ink">生成头像</span>
                {pendingAvatar && (
                  <button
                    type="button"
                    onClick={() => setPendingAvatar(null)}
                    className="w-6 h-6 rounded flex items-center justify-center text-ink-muted hover:text-ink transition"
                    aria-label="关闭预览"
                  >✕</button>
                )}
              </div>
              {generatingAvatar ? (
                <div className="flex flex-col items-center gap-2 py-8">
                  <div className="w-6 h-6 border-2 border-ink/20 border-t-ink rounded-full animate-spin" />
                  <span className="text-xs text-ink-muted">生成中…（约 10 秒）</span>
                </div>
              ) : pendingAvatar ? (
                <>
                  <img
                    src={imageUrl(pendingAvatar)}
                    alt="生成的头像"
                    className="w-full max-w-[260px] mx-auto rounded-xl border border-border"
                    referrerPolicy="no-referrer"
                  />
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={applyPendingAvatar}
                      className="px-4 py-2 rounded-lg bg-solid text-solid-contrast text-xs font-semibold hover:opacity-90 transition"
                    >使用</button>
                    <button
                      type="button"
                      onClick={handleGenerateAvatar}
                      disabled={generatingAvatar}
                      className="px-4 py-2 rounded-lg frosted-glass border border-border text-xs text-ink hover:bg-bg-soft transition disabled:opacity-50"
                    >重新生成</button>
                  </div>
                </>
              ) : null}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            {editingCharId ? (
              <>
                <button className="flex-1 rounded-lg bg-rose py-2 text-xs font-semibold text-ink-on" onClick={handleSaveCharacter} disabled={busy}>保存</button>
                <button className="rounded-lg border border-border px-3 py-2 text-xs text-ink-soft" onClick={handleCancelEdit}>取消</button>
              </>
            ) : (
              <button className="flex-1 rounded-lg bg-solid py-2 text-xs font-semibold text-solid-contrast" onClick={handleAddCharacter} disabled={busy}>添加</button>
            )}
          </div>
        </div>

        {/* roll 角色 */}
        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs text-ink-soft">一次 roll 几个角色（1-6）</label>
            <input
              className="w-full rounded-lg border border-border bg-bg-soft px-2.5 py-2 text-sm text-ink outline-none"
              type="number" min={1} max={6}
              value={rollCount}
              onChange={(e) => setRollCount(Math.max(1, Math.min(6, Number(e.target.value) || 3)))}
            />
          </div>
          <div className="flex-[2]">
            <label className="mb-1 block text-xs text-ink-soft">方向（可选，如「全员都是学长」）</label>
            <input
              className="w-full rounded-lg border border-border bg-bg-soft px-2.5 py-2 text-sm text-ink outline-none"
              value={rollDirection}
              onChange={(e) => setRollDirection(e.target.value)}
            />
          </div>
          <button
            className="rounded-lg frosted-glass border border-border px-3 py-2 text-xs text-ink-soft disabled:opacity-50"
            onClick={handleRollCharacters}
            disabled={busy}
          >
            {busy ? '生成中...' : '🎲 随机角色'}
          </button>
        </div>

        {/* 开场 */}
        <div className="mt-5">
          <div className="mb-1.5 flex items-center justify-between">
            <label className="text-sm font-semibold text-ink">开场</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-full border border-border px-2.5 py-1 text-xs text-ink-soft"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => openingRef.current?.insertPlayer()}
              >玩家</button>
              <button
                className="rounded-full frosted-glass border border-border px-3 py-1 text-xs text-ink-soft disabled:opacity-50"
                onClick={handleRollOpening}
                disabled={busy}
              >
                {busy ? '生成中...' : '🎲 随机'}
              </button>
            </div>
          </div>
          <PlayerChipInput
            ref={openingRef}
            className="w-full rounded-xl border border-border bg-bg-soft px-3 py-2.5 text-sm text-ink outline-none focus:border-border-strong"
            rows={6}
            placeholder="故事的开场（玩家进入即读到，故事起点）"
            value={novel.opening}
            onChange={(v) => setNovel(prev => prev ? { ...prev, opening: v } : prev)}
            onBlur={(text) => handleUpdateField('opening', text)}
          />
        </div>

        <div className="mt-5 flex gap-2">
          <button
            className="flex-1 rounded-xl bg-rose py-3 text-sm font-semibold text-ink-on disabled:opacity-50"
            onClick={handlePublish}
            disabled={busy}
          >
            {novel.status === 'published' ? '进入写作' : '发布并开始写作'}
          </button>
        </div>
      </div>
    </div>
  );
}
