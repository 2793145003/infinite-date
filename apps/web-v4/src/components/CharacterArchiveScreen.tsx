import React from 'react';
import { ChevronLeft, Plus, Upload, Search, Edit3, MessageCircle, Check, Trash2, UserMinus, RotateCcw } from 'lucide-react';
import { Character } from '../types';
import { getAnimeMaleAvatar } from '../data/animeAvatars';

interface CharacterArchiveScreenProps {
  characters: Character[];
  activeCharacterId: string;
  onBack: () => void;
  onSelectActiveCharacter: (character: Character) => void;
  onEditCharacter: (character: Character) => void;
  onNewCharacter: () => void;
  onDeleteCharacter: (characterId: string) => void;
  onDeleteFriend: (characterId: string) => void;
  onResetFork: (characterId: string) => void;
  onImportCharacter: (jsonText: string) => Promise<void>;
  onStartChat: (character: Character) => void;
}

export const CharacterArchiveScreen: React.FC<CharacterArchiveScreenProps> = ({
  characters,
  activeCharacterId,
  onBack,
  onSelectActiveCharacter,
  onEditCharacter,
  onNewCharacter,
  onDeleteCharacter,
  onDeleteFriend,
  onResetFork,
  onImportCharacter,
  onStartChat,
}) => {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [showImportModal, setShowImportModal] = React.useState(false);
  const [importJsonText, setImportJsonText] = React.useState('');
  const [importError, setImportError] = React.useState('');

  const filteredCharacters = characters
    .filter((c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.nickname.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.identity.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.tag.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      // 按与玩家的关系排序：固定在主页 > 好友 > 非好友，同组按名字
      const aActive = a.id === activeCharacterId ? 0 : 1;
      const bActive = b.id === activeCharacterId ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const aFriend = a.tag === '好友' ? 0 : 1;
      const bFriend = b.tag === '好友' ? 0 : 1;
      if (aFriend !== bFriend) return aFriend - bFriend;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

  const handleImportSubmit = async () => {
    try {
      setImportError('');
      // 本地先校验 JSON 可解析 + 含 name（其余字段后端 buildCharacterData 兜底）
      const parsed = JSON.parse(importJsonText);
      if (!parsed.name) {
        throw new Error('导入数据中必须包含角色姓名(name)');
      }
      await onImportCharacter(importJsonText);
      setShowImportModal(false);
      setImportJsonText('');
    } catch (err: any) {
      setImportError(err.message || '导入失败，请检查数据格式');
    }
  };

  return (
    <div className="w-full max-w-md mx-auto min-h-full px-3.5 pt-3 pb-24">
      {/* Header */}
      <header className="flex items-center justify-between py-1.5 mb-2.5">
        <button
          id="btn-archive-back"
          onClick={onBack}
          className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition"
          aria-label="返回"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <h1 className="text-sm font-bold text-ink tracking-tight">角色档案</h1>

        <button
          id="btn-archive-import"
          onClick={() => setShowImportModal(true)}
          className="px-3 py-1 rounded-md frosted-glass border border-border text-xs font-medium text-ink hover:bg-bg-muted transition flex items-center gap-1"
        >
          <Upload className="w-3 h-3" />
          <span>导入</span>
        </button>
      </header>

      {/* Search Bar + New Character Button */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-ink absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            id="input-search-character"
            type="text"
            placeholder="搜索人设名字..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-border frosted-glass text-xs text-ink placeholder-ink-faint outline-none focus:border-border-dark"
          />
        </div>

        <button
          id="btn-archive-new"
          onClick={onNewCharacter}
          className="px-3 py-1.5 rounded-lg bg-solid text-solid-contrast text-xs font-medium hover:bg-solid-soft transition flex items-center gap-1 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>新建</span>
        </button>
      </div>

      {/* Character Cards List (Compact Monochrome) */}
      <div className="space-y-2.5">
        {filteredCharacters.map((char) => {
          const isActive = char.id === activeCharacterId;
          const charInitial = char.name?.slice(-1) || '伴';

          return (
            <div
              key={char.id}
              id={`character-card-${char.id}`}
              onClick={() => onEditCharacter(char)}
              className={`glass-panel rounded-xl p-3 border transition cursor-pointer group ${
                isActive
                  ? 'border-border-dark frosted-glass shadow-xs ring-1 ring-ink/10'
                  : 'border-border frosted-glass hover:border-border-strong hover:shadow-xs'
              }`}
            >
              {/* Card Header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-xs font-bold text-ink group-hover:text-ink transition">{char.name}</h2>
                  <span className="text-[9px] text-ink-faint">{char.gender}</span>
                  {isActive && (
                    <span className="text-[9px] bg-solid text-solid-contrast px-1.5 py-0.2 rounded font-medium flex items-center gap-0.5">
                      <Check className="w-2.5 h-2.5" /> 固定在主页
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-ink opacity-0 group-hover:opacity-100 transition">
                    编辑 →
                  </span>
                </div>
              </div>

              {/* Card Body: Left Monogram + Right Profile */}
              <div className="flex gap-3 items-start">
                <div className="w-16 h-22 rounded-xl bg-bg-muted border border-border overflow-hidden flex items-center justify-center text-base font-bold text-ink shrink-0 group-hover:scale-[1.02] transition shadow-2xs">
                  <img
                    src={char.avatarUrl || getAnimeMaleAvatar(char.name || char.id)}
                    alt={char.name}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-ink leading-relaxed bg-bg-soft px-2.5 py-2 rounded-lg border border-border-strong space-y-1">
                    <div className="line-clamp-2">
                      <span className="text-ink-muted">关系 </span>
                      {char.relationshipWithPlayer || '与玩家有着深刻且宿命般的羁绊'}
                    </div>
                    {char.strengths ? (
                      <div className="line-clamp-2">
                        <span className="text-ink-muted">擅长 </span>
                        {char.strengths}
                      </div>
                    ) : null}
                    {char.personalitySurface ? (
                      <div className="line-clamp-2">
                        <span className="text-ink-muted">性格 </span>
                        {char.personalitySurface}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* Card Actions Footer */}
              <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-border-soft">
                <div className="flex items-center gap-1">
                  {characters.length > 1 && (
                    <button
                      id={`btn-delete-char-${char.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`确定要删除角色【${char.name}】吗？`)) {
                          onDeleteCharacter(char.id);
                        }
                      }}
                      className="p-1 rounded-md text-ink hover:text-rose transition cursor-pointer"
                      aria-label="删除角色"
                      title="删除角色档案"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {!isActive && (
                    <button
                      id={`btn-set-active-${char.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectActiveCharacter(char);
                      }}
                      className="px-2.5 py-1 rounded-md border border-border-strong text-[10px] font-medium text-ink hover:bg-bg-muted transition cursor-pointer"
                    >
                      固定在主页
                    </button>
                  )}

                  {char.tag === '好友' && (
                    <button
                      id={`btn-chat-char-${char.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectActiveCharacter(char);
                        onStartChat(char);
                      }}
                      className="px-3 py-1 rounded-md bg-solid text-solid-contrast text-[10px] font-semibold hover:bg-solid-soft transition flex items-center gap-1 cursor-pointer shadow-2xs"
                    >
                      <MessageCircle className="w-3 h-3" />
                      <span>聊天</span>
                    </button>
                  )}

                  {char.tag === '好友' && (
                    <button
                      id={`btn-unfriend-char-${char.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`确定删除好友【${char.name}】吗？删除后将从你的好友列表移除。`)) {
                          onDeleteFriend(char.id);
                        }
                      }}
                      className="p-1 rounded-md text-ink-soft hover:text-rose transition cursor-pointer"
                      aria-label="删除好友"
                      title="删除好友"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                    </button>
                  )}

                  {char.hasFork && (
                    <button
                      id={`btn-reset-fork-${char.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`确定恢复【${char.name}】为原版吗？你编辑过的个人版本会被清除。`)) {
                          onResetFork(char.id);
                        }
                      }}
                      className="p-1 rounded-md text-ink-soft hover:text-rose transition cursor-pointer"
                      aria-label="恢复原版"
                      title="恢复原版（清除个人编辑）"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {filteredCharacters.length === 0 && (
          <div className="text-center py-8 glass-panel rounded-xl p-4 frosted-glass border border-border">
            <p className="text-xs text-ink">未找到匹配的角色人设</p>
            <button
              onClick={onNewCharacter}
              className="mt-2 px-3 py-1 rounded-md bg-solid text-solid-contrast text-[11px] font-medium"
            >
              新建人设
            </button>
          </div>
        )}
      </div>

      {/* Import Character Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="glass-panel w-full max-w-sm rounded-2xl p-4 shadow-xl frosted-glass border border-border">
            <h3 className="text-xs font-bold text-ink mb-1 flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5 text-ink" />
              <span>导入角色数据</span>
            </h3>
            <p className="text-[11px] text-ink mb-2.5">
              粘贴标准 JSON 角色卡（CharacterData 格式，与创建/编辑共用同一套字段）。仅 <code className="font-mono">name</code> 必填，其余可省略。
            </p>

            <textarea
              value={importJsonText}
              onChange={(e) => setImportJsonText(e.target.value)}
              placeholder={`{\n  "name": "陆沉",\n  "gender": "male",\n  "age": "28",\n  "appearance": "……",\n  "personality": { "surface": "……", "core": "……", "extreme": "……" },\n  "speechStyle": { "description": "……", "examples": [{ "context": "……", "line": "……" }] },\n  "textingStyle": { "description": "……", "examples": ["……"] },\n  "background": { "origin": "……", "shaping": "……", "current": "……" },\n  "emotional_signals": { "nervous": "……", "happy": "……", "angry": "……", "moved": "……", "defensive": "……" },\n  "likes": ["……"],\n  "dislikes": ["……"],\n  "boundaries": "……",\n  "goals": "……",\n  "quirks": "……",\n  "backstory_milestones": [{ "label": "……", "time_description": "……", "summary": "……", "diff": {}, "dramatic_potential": "medium" }],\n  "player_relation": "……",\n  "skills": "……",\n  "ineptitudes": "……",\n  "sleepType": "night_owl"\n}`}
              rows={6}
              className="w-full p-2.5 rounded-lg border border-border text-xs font-mono text-ink outline-none mb-2 focus:border-border-dark"
            />

            {importError && (
              <p className="text-[11px] text-ink mb-2 font-medium">{importError}</p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setShowImportModal(false)}
                className="px-3 py-1 rounded-md bg-bg-muted text-xs font-medium text-ink hover:bg-bg-muted-2"
              >
                取消
              </button>
              <button
                onClick={handleImportSubmit}
                className="px-3.5 py-1 rounded-md bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft"
              >
                确认导入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
