import React, { useState, useEffect } from 'react';
import {
  ChevronLeft,
  Camera,
  Sparkles,
  Heart,
  MessageCircle,
  ThumbsUp,
  MapPin,
  MoreHorizontal,
  Send,
  X,
  Globe,
  Lock,
  Users,
  Image as ImageIcon,
  Check,
  Smartphone,
} from 'lucide-react';
import { Character, MomentPost, MomentComment } from '../types';
import { getAnimeMaleAvatar } from '../data/animeAvatars';
import { api, type ApiMoment } from '../lib/api';
import { ImageViewer } from './ImageViewer';

interface MomentsScreenProps {
  activeCharacter: Character;
  allCharacters: Character[];
  onBack: () => void;
  userAvatar?: string;
  userName?: string;
}

const INITIAL_MOMENT_POSTS: MomentPost[] = [
  {
    id: 'post-1',
    authorName: '屿白',
    authorAvatar: getAnimeMaleAvatar('屿白'),
    content:
      '“人的眼泪总是向下坠落，要怎么仰望才能接住悲伤呢。” 无论何时回头，我都永远捧着你的脸。💫',
    location: '星光初遇咖啡馆',
    timeStr: '今天 03:45',
    device: 'iPhone 17 Pro',
    likes: ['阿言', '厉承渊', '顾砚', '林溯', '沈星回'],
    comments: [
      {
        id: 'c-1',
        authorName: '阿言',
        content: '所以安慰的时候才要捧起对方的脸。',
        timestamp: '03:48',
      },
      {
        id: 'c-2',
        authorName: '屿白',
        replyTo: '阿言',
        content: '因为那天姐姐笑得最甜了，想每天点进主页第一眼就看到 (>ω<)',
        timestamp: '03:50',
      },
      {
        id: 'c-3',
        authorName: '顾砚',
        content: '原来这就是你最近天天捧着手机傻笑的原因。',
        timestamp: '04:12',
      },
    ],
    visibility: '仅彼此可见',
  },
  {
    id: 'post-2',
    authorName: '阿言',
    authorAvatar: getAnimeMaleAvatar('阿言'),
    content:
      '偷拍一张在书房专注整理黑胶唱片的小狗。戴着同款降噪耳机，随手挑了一张唱片就说要单曲循环一整天~ 🎧💿',
    location: '私人视听黑胶馆',
    timeStr: '今天 01:20',
    device: 'iPhone 17 Pro',
    likes: ['屿白', '苏烬', '沈星回'],
    comments: [
      {
        id: 'c-4',
        authorName: '苏烬',
        content: '耳机音量不要开太大，对耳朵不好。',
        timestamp: '01:25',
      },
      {
        id: 'c-5',
        authorName: '阿言',
        replyTo: '苏烬',
        content: '收到！已经调小了，今晚还有热牛奶吗？',
        timestamp: '01:30',
      },
    ],
    visibility: '全部公开',
  },
  {
    id: 'post-3',
    authorName: '苏烬',
    authorAvatar: getAnimeMaleAvatar('苏烬'),
    content:
      '夜班巡查结束。路过转角的面包房，新出炉的栗子欧包还冒着热气。带了一份回去，留给你明早当早餐。',
    location: '第四分区 · 街角烘焙坊',
    timeStr: '昨天 23:40',
    device: '专用终端',
    likes: ['屿白', '阿言', '顾砚'],
    comments: [
      {
        id: 'c-6',
        authorName: '顾砚',
        content: '顺便给队里也捎两袋。',
        timestamp: '23:45',
      },
    ],
    visibility: '仅彼此可见',
  },
];

// ─── 后端 ApiMoment → 前端 MomentPost 映射 ────────────────

function formatMomentTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - thatDay.getTime()) / 86400000);
  if (diffDays === 0) return `今天 ${hh}:${mm}`;
  if (diffDays === 1) return `昨天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

function mapMomentToPost(m: ApiMoment): MomentPost {
  const visLabel: Record<string, string> = {
    public: '全部公开',
    partner: '仅彼此可见',
    friends: '部分好友可见',
    private: '私密',
  };
  return {
    id: m.id,
    authorName: m.authorName,
    authorAvatar: m.authorAvatar ? `/v4/api/uploads/${m.authorAvatar}` : undefined,
    content: m.content,
    images: m.imagePath ? [`/v4/api/uploads/${m.imagePath}`] : undefined,
    location: m.locationName || undefined,
    visibility: m.visibility ? visLabel[m.visibility] ?? m.visibility : undefined,
    timeStr: formatMomentTime(m.createdAt),
    likes: m.likes.map((l) => l.authorName),
    comments: m.comments.map((c) => ({
      id: c.id,
      authorName: c.authorName,
      content: c.body,
      timestamp: formatMomentTime(c.createdAt),
    })),
  };
}

const INSPIRATION_TEMPLATES = [
  '“ 那些共度的静谧时光，最为震耳欲聋。 ”',
  '“ 无论走过多远的荒原，只要你在身旁，就是最好的安歇处。 ”',
  '“ 晚风吹过街道，你在我身旁便是一切归宿。 ”',
  '“ 所有的心动与偏爱，都只为你一人写就。 ”',
  '今天天气很好，阳光刚好落在你的发梢，偷偷拍下了你笑起来的模样✨',
  '只要牵着你的手，哪怕是无目的漫步在街角，都像是在经历一场盛大的冒险。',
];

const LOCATION_PRESETS = [
  '星光初遇咖啡馆',
  '第四分区 · 避风港',
  '私人视听黑胶馆',
  '私人影院 · 独享包厢',
  '暮色海岸 · 潮汐漫步',
  '静谧厨房 · 烘焙时光',
  '大学城 · 林荫道漫步',
  '金融中心 · 云端大厦',
];

export const MomentsScreen: React.FC<MomentsScreenProps> = ({
  activeCharacter,
  allCharacters,
  onBack,
  userAvatar,
  userName = '张琴',
}) => {
  // 朋友圈动态：从后端 /moments 加载
  const [posts, setPosts] = useState<MomentPost[]>([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);

  const loadMoments = async () => {
    try {
      const { moments, serverTime } = await api.listMoments();
      setPosts(moments.map(mapMomentToPost));
      // 记录「已看到这个时间点」，下次未读角标只统计此后的新内容
      localStorage.setItem('idate_moments_seen', String(serverTime));
    } catch (e) {
      console.error('加载朋友圈失败', e);
    } finally {
      setPostsLoading(false);
    }
  };

  useEffect(() => {
    loadMoments();
  }, []);

  // 地图公开地点：作为发布框「位置」的可选项（替换硬编码 LOCATION_PRESETS）
  const [mapLocations, setMapLocations] = useState<string[]>([]);

  useEffect(() => {
    fetch('/v4/api/scene/locations')
      .then((r) => r.json())
      .then((data) => {
        const locs: any[] = data.locations ?? [];
        // 排除私人住宅/室内细节地点，只留公开的、适合发朋友圈的地点
        const blocked = /(家|私宅|loft|卧室|浴室|厨房|客厅|餐厅|餐桌|衣帽间|沙发|床边|镜子|座位|台面|阅读区|主卫|扶手椅|内部|二层|包间|温室|角落|办公室|教室)/;
        const names = locs
          .filter((l: any) => l.isPublic && l.name && !blocked.test(l.name))
          .map((l: any) => l.name);
        setMapLocations(names);
        // 默认地点落到真实地图位置（无限主城优先，否则取第一个）
        if (names.length > 0) {
          setPublishLocation((cur) =>
            cur === '无限主城' && !names.includes('无限主城') ? names[0] : cur
          );
        }
      })
      .catch(() => {});
  }, []);

  // Publish Modal State
  const [isPublishModalOpen, setIsPublishModalOpen] = useState(false);
  const [publishContent, setPublishContent] = useState('');
  const [publishLocation, setPublishLocation] = useState('无限主城');
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [publishVisibility, setPublishVisibility] = useState('全部公开');
  const [visibleToIds, setVisibleToIds] = useState<string[]>([]);
  const [showVisibilityDropdown, setShowVisibilityDropdown] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<string[]>([]);

  // Comment input per post
  const [commentInputs, setCommentInputs] = useState<Record<string, string>>({});
  const [activeCommentPostId, setActiveCommentPostId] = useState<string | null>(null);
  // 每条动态右上角「···」菜单：当前展开的 post id
  const [menuPostId, setMenuPostId] = useState<string | null>(null);

  // Delete Post（删除自己 feed 里的动态，含 NPC 发的，操作后重拉）
  const handleDeletePost = async (postId: string) => {
    try {
      await api.deleteMoment(postId);
      setMenuPostId(null);
      await loadMoments();
    } catch (e) {
      console.error('删除动态失败', e);
    }
  };

  // Like Toggle（后端 toggle，操作后重拉）
  const handleToggleLike = async (postId: string) => {
    try {
      await api.likeMoment(postId);
      await loadMoments();
    } catch (e) {
      console.error('点赞失败', e);
    }
  };

  // Submit Comment（走后端，操作后重拉）
  const handleSendComment = async (postId: string) => {
    const text = commentInputs[postId]?.trim();
    if (!text) return;
    try {
      await api.commentMoment(postId, text);
      setCommentInputs((prev) => ({ ...prev, [postId]: '' }));
      setActiveCommentPostId(null);
      await loadMoments();
    } catch (e) {
      console.error('评论失败', e);
    }
  };

  // Publish Post（content + 图片 + 地点 + 可见性都落库）
  const handlePublishPost = async () => {
    if (!publishContent.trim()) return;
    const visMap: Record<string, string> = {
      '全部公开': 'public',
      '仅彼此可见': 'partner',
      '部分好友可见': 'friends',
      '私密 (仅自己)': 'private',
    };
    const vis = visMap[publishVisibility] ?? 'public';
    // 可见对象：伴侣→当前主页角色；部分好友→勾选列表；公开/私密→空
    const visTo =
      publishVisibility === '仅彼此可见'
        ? [activeCharacter.id]
        : publishVisibility === '部分好友可见'
          ? visibleToIds
          : [];
    try {
      await api.createMoment(
        publishContent.trim(),
        uploadedImages.length > 0 ? uploadedImages[0] : undefined,
        vis,
        visTo,
        publishLocation,
      );
      setPublishContent('');
      setUploadedImages([]);
      setVisibleToIds([]);
      setIsPublishModalOpen(false);
      await loadMoments();
    } catch (e) {
      console.error('发布失败', e);
    }
  };

  // 部分好友可见：勾选/取消勾选某个好友
  const toggleFriend = (id: string) => {
    setVisibleToIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  // Random Inspiration
  const handleApplyInspiration = () => {
    const random = INSPIRATION_TEMPLATES[Math.floor(Math.random() * INSPIRATION_TEMPLATES.length)];
    setPublishContent(random);
  };

  // Image Upload handler（真正上传到后端，存文件名用于落库）
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      try {
        const res = await api.uploadImage(files[0]);
        setUploadedImages((prev) => [...prev, res.imagePath]);
      } catch (err) {
        console.error('图片上传失败', err);
      }
      e.target.value = '';
    }
  };

  return (
    <div
      id="moments-screen-container"
      className="w-full max-w-md mx-auto min-h-full px-3.5 pt-3 pb-24 flex flex-col select-none"
    >
      {/* 1. Top Navigation Bar (Consistent with Character Archive style) */}
      <header className="flex items-center justify-between py-1.5 mb-2.5">
        <div className="flex items-center gap-2">
          <button
            id="btn-moments-back"
            onClick={onBack}
            className="w-8 h-8 rounded-lg frosted-glass border border-border flex items-center justify-center text-ink hover:bg-bg-muted transition active:scale-95 cursor-pointer shadow-xs"
            aria-label="返回"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <h1 className="text-sm font-bold text-ink tracking-tight">朋友圈</h1>
        </div>
      </header>

      {/* 动态 FEED */}
        <div className="space-y-3">
          {/* Quick Publish Bar */}
          <div
            id="moments-quick-publish-bar"
            onClick={() => setIsPublishModalOpen(true)}
            className="frosted-glass rounded-xl px-3.5 py-2.5 border border-border shadow-xs flex items-center justify-between cursor-pointer hover:border-border-strong transition"
          >
            <span className="text-xs text-ink font-normal">分享新鲜事...</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-ink hover:text-ink transition"
                title="拍照/添加照片"
              >
                <Camera className="w-4 h-4" />
              </button>
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-amber bg-bg-amber-soft border border-amber/80 px-2 py-0.5 rounded-md font-medium"
              >
                <span>灵感</span>
                <Sparkles className="w-3 h-3 text-amber" />
              </button>
            </div>
          </div>

          {/* Moments Posts Feed List */}
          <div className="space-y-3">
            {postsLoading && (
              <p className="text-center text-xs text-ink-faint py-8">加载中...</p>
            )}
            {!postsLoading && posts.length === 0 && (
              <p className="text-center text-xs text-ink-faint py-8">还没有动态，去发布第一条吧</p>
            )}
            {posts.map((post) => {
              const myName = userName || '我';
              const isLiked = post.likes.includes(myName);
              const authorChar = allCharacters.find((c) => c.name === post.authorName);

              return (
                <div
                  key={post.id}
                  id={`post-card-${post.id}`}
                  className="frosted-glass rounded-xl p-3.5 border border-border shadow-xs space-y-2.5"
                >
                  {/* Post Author Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-lg bg-solid text-solid-contrast flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden border border-border shadow-2xs">
                        {authorChar ? (
                          <img
                            src={authorChar.avatarUrl || getAnimeMaleAvatar(post.authorName)}
                            alt={post.authorName}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : post.authorAvatar ? (
                          <img
                            src={post.authorAvatar}
                            alt={post.authorName}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span>{post.authorName.charAt(0)}</span>
                        )}
                      </div>
                      <div>
                        <h3 className="text-xs font-bold text-ink">{post.authorName}</h3>
                        {post.visibility && (
                          <span className="text-[9px] text-ink font-normal">
                            {post.visibility}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="relative">
                      <button
                        className="text-ink hover:text-ink p-1 rounded-md transition cursor-pointer"
                        aria-label="更多操作"
                        onClick={() => setMenuPostId(menuPostId === post.id ? null : post.id)}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>

                      {menuPostId === post.id && (
                        <div className="absolute right-0 top-8 z-20 min-w-24 rounded-lg border border-border bg-panel shadow-lg p-1">
                          <button
                            id={`btn-delete-post-${post.id}`}
                            onClick={() => handleDeletePost(post.id)}
                            className="w-full text-left px-2.5 py-1.5 rounded-md text-xs text-rose hover:bg-bg-muted transition cursor-pointer"
                          >
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Post Content */}
                  <p className="text-xs text-ink leading-relaxed whitespace-pre-wrap font-sans">
                    {post.content}
                  </p>

                  {/* Attached Images */}
                  {post.images && post.images.length > 0 && (
                    <div className="grid grid-cols-3 gap-1.5 pt-1">
                      {post.images.map((img, idx) => (
                        <div
                          key={idx}
                          className="aspect-square rounded-lg overflow-hidden border border-border bg-bg-muted"
                        >
                          <img
                            src={img}
                            alt="Post attachment"
                            className="w-full h-full object-cover cursor-zoom-in"
                            onClick={() => setViewerSrc(img)}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Location & Time & Actions Footer */}
                  <div className="space-y-1.5 pt-1 border-t border-border-soft">
                    {post.location && (
                      <div className="flex items-center gap-1 text-[10px] font-medium text-ink">
                        <MapPin className="w-3 h-3 text-ink" />
                        <span>{post.location}</span>
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-[10px] text-ink">
                        <span>{post.timeStr}</span>
                        {post.device && (
                          <span className="flex items-center gap-0.5">
                            <Smartphone className="w-2.5 h-2.5" />
                            <span>{post.device}</span>
                          </span>
                        )}
                      </div>

                      {/* Like & Comment Buttons */}
                      <div className="flex items-center gap-3">
                        <button
                          id={`btn-like-post-${post.id}`}
                          onClick={() => handleToggleLike(post.id)}
                          className={`flex items-center gap-1 text-xs transition cursor-pointer ${
                            isLiked ? 'text-rose font-bold' : 'text-ink hover:text-ink'
                          }`}
                        >
                          <ThumbsUp className={`w-3.5 h-3.5 ${isLiked ? 'fill-rose text-rose' : ''}`} />
                        </button>

                        <button
                          id={`btn-toggle-comment-${post.id}`}
                          onClick={() =>
                            setActiveCommentPostId(
                              activeCommentPostId === post.id ? null : post.id
                            )
                          }
                          className="flex items-center gap-1 text-xs text-ink hover:text-ink transition cursor-pointer"
                        >
                          <MessageCircle className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Likes Box */}
                  {post.likes.length > 0 && (
                    <div className="bg-bg-soft rounded-lg px-2.5 py-1.5 border border-border-strong flex items-start gap-1.5 text-[11px] text-ink">
                      <ThumbsUp className="w-3 h-3 text-rose fill-rose shrink-0 mt-0.5" />
                      <span className="font-medium">{post.likes.join('、')}</span>
                    </div>
                  )}

                  {/* Comments Box */}
                  {post.comments.length > 0 && (
                    <div className="bg-bg-soft rounded-lg p-2.5 border border-border-strong space-y-2 text-[11px] leading-relaxed">
                      {post.comments.map((comment) => {
                        const cChar = allCharacters.find((c) => c.name === comment.authorName);
                        return (
                          <div key={comment.id} className="flex items-start gap-2 text-ink">
                            <div className="w-5 h-5 rounded-md overflow-hidden shrink-0 mt-0.5 border border-border bg-solid flex items-center justify-center text-[9px] font-bold text-solid-contrast">
                              {cChar ? (
                                <img
                                  src={cChar.avatarUrl || getAnimeMaleAvatar(comment.authorName)}
                                  alt={comment.authorName}
                                  className="w-full h-full object-cover"
                                  referrerPolicy="no-referrer"
                                />
                              ) : (
                                <span>{comment.authorName.charAt(0)}</span>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="font-bold text-ink mr-1">
                                {comment.authorName}
                                {comment.replyTo && (
                                  <span className="font-normal text-ink">
                                    {' '}
                                    回复 <span className="font-semibold text-ink">{comment.replyTo}</span>
                                  </span>
                                )}
                                :
                              </span>
                              <span className="text-ink">{comment.content}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Comment Input Row */}
                  {(activeCommentPostId === post.id || post.comments.length > 0) && (
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="text"
                        placeholder="说点什么吧..."
                        value={commentInputs[post.id] || ''}
                        onChange={(e) =>
                          setCommentInputs({
                            ...commentInputs,
                            [post.id]: e.target.value,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSendComment(post.id);
                        }}
                        className="flex-1 bg-bg-soft border border-border rounded-lg px-2.5 py-1 text-xs text-ink placeholder-ink-faint outline-none focus:border-border-dark"
                      />
                      <button
                        onClick={() => handleSendComment(post.id)}
                        className="p-1.5 rounded-lg bg-solid text-solid-contrast hover:bg-solid-soft transition active:scale-95 cursor-pointer"
                        title="发送评论"
                      >
                        <Send className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      {/* 3. Publish Moment Modal (Image 3) */}
      {isPublishModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-sm rounded-xl p-4 shadow-xl bg-panel border border-border animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[90vh] overflow-y-auto">
            {/* Modal Header: 取消 on left, 发布 on right */}
            <div className="flex items-center justify-between pb-3 border-b border-border-soft mb-3">
              <button
                id="btn-cancel-publish"
                onClick={() => setIsPublishModalOpen(false)}
                className="text-xs font-medium text-ink hover:text-ink transition cursor-pointer"
              >
                取消
              </button>

              <h3 className="text-xs font-bold text-ink">发布动态</h3>

              <button
                id="btn-submit-publish"
                onClick={handlePublishPost}
                className="px-3 py-1 rounded-full bg-solid text-solid-contrast text-xs font-semibold hover:bg-solid-soft transition active:scale-95 cursor-pointer shadow-xs"
              >
                发布
              </button>
            </div>

            {/* Textarea Input with Inspiration Button */}
            <div className="relative mb-3">
              <textarea
                id="textarea-publish-content"
                rows={4}
                placeholder="这一刻的想法..."
                value={publishContent}
                onChange={(e) => setPublishContent(e.target.value)}
                className="w-full p-3 rounded-xl border border-border bg-bg-soft text-xs text-ink placeholder-ink-faint outline-none focus:border-border-dark resize-none font-sans leading-relaxed"
              />

              {/* Inspiration Button inside textarea */}
              <button
                id="btn-inspiration-copy"
                type="button"
                onClick={handleApplyInspiration}
                className="absolute right-2.5 bottom-3 flex items-center gap-1 px-2 py-0.5 rounded-md bg-bg-amber-soft border border-amber text-amber text-[10px] font-semibold hover:bg-bg-amber-soft transition cursor-pointer"
              >
                <Sparkles className="w-3 h-3 text-amber" />
                <span>灵感文案</span>
              </button>
            </div>

            {/* Photos Upload Area */}
            <div className="mb-3.5">
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {/* Upload Button */}
                <label className="w-16 h-16 rounded-xl border-2 border-dashed border-border-strong bg-bg-soft hover:bg-bg-muted flex flex-col items-center justify-center text-ink cursor-pointer shrink-0 transition">
                  <Camera className="w-4 h-4 mb-0.5" />
                  <span className="text-[9px] font-medium">添加照片</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>

                {/* Uploaded Images preview */}
                {uploadedImages.map((img, i) => (
                  <div
                    key={i}
                    className="w-16 h-16 rounded-xl relative overflow-hidden border border-border shrink-0"
                  >
                    <img src={`/v4/api/uploads/${img}`} alt="preview" className="w-full h-full object-cover" />
                    <button
                      onClick={() =>
                        setUploadedImages(uploadedImages.filter((_, idx) => idx !== i))
                      }
                      className="absolute top-1 right-1 w-4 h-4 rounded-full bg-black/60 text-white flex items-center justify-center text-[10px]"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Location Selector */}
            <div className="mb-3">
              <button
                id="btn-choose-publish-location"
                type="button"
                onClick={() => setShowLocationPicker(!showLocationPicker)}
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-bg-soft flex items-center justify-between text-xs text-ink hover:bg-bg-muted transition cursor-pointer"
              >
                <div className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-ink" />
                  <span>{publishLocation || '添加地点'}</span>
                </div>
                <ChevronLeft className="w-3.5 h-3.5 rotate-180 text-ink" />
              </button>

              {showLocationPicker && (
                <div className="mt-1.5 p-2 rounded-xl border border-border frosted-glass space-y-1">
                  {(mapLocations.length > 0 ? mapLocations : LOCATION_PRESETS).map((loc) => (
                    <button
                      key={loc}
                      onClick={() => {
                        setPublishLocation(loc);
                        setShowLocationPicker(false);
                      }}
                      className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition cursor-pointer ${
                        publishLocation === loc
                          ? 'bg-solid text-solid-contrast font-medium'
                          : 'hover:bg-bg-muted text-ink'
                      }`}
                    >
                      {loc}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Visibility Selector (给谁看？) */}
            <div className="mb-2">
              <div className="p-3 rounded-xl border border-border-strong bg-bg-soft space-y-2">
                <div
                  onClick={() => setShowVisibilityDropdown(!showVisibilityDropdown)}
                  className="flex items-center justify-between cursor-pointer"
                >
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                    <Users className="w-3.5 h-3.5 text-ink" />
                    <span>给谁看？</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-cyan font-medium">
                    <span>
                      {publishVisibility === '全部公开' && '全部公开'}
                      {publishVisibility === '仅彼此可见' && `仅彼此可见 (${activeCharacter.name} & 我)`}
                      {publishVisibility === '部分好友可见' && `部分好友可见 (${visibleToIds.length} 位好友)`}
                      {publishVisibility === '私密 (仅自己)' && '私密 (仅自己)'}
                    </span>
                    <ChevronLeft className={`w-3 h-3 text-cyan transition-transform ${showVisibilityDropdown ? 'rotate-90' : '-rotate-90'}`} />
                  </div>
                </div>

                {showVisibilityDropdown && (
                  <div className="pt-2 border-t border-border/70 space-y-1">
                    {[
                      { label: '全部公开', icon: Globe },
                      { label: '仅彼此可见', icon: Heart },
                      { label: '部分好友可见', icon: Users },
                      { label: '私密 (仅自己)', icon: Lock },
                    ].map((item) => (
                      <button
                        key={item.label}
                        onClick={() => {
                          setPublishVisibility(item.label);
                          if (item.label === '仅彼此可见') {
                            setVisibleToIds([activeCharacter.id]);
                            setShowVisibilityDropdown(false);
                          } else if (item.label === '部分好友可见') {
                            // 保持下拉展开，进入好友勾选
                          } else {
                            setVisibleToIds([]);
                            setShowVisibilityDropdown(false);
                          }
                        }}
                        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer ${
                          publishVisibility === item.label
                            ? 'bg-bg-muted-2/80 font-semibold text-ink'
                            : 'hover:bg-bg-muted text-ink'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <item.icon className="w-3.5 h-3.5 text-ink" />
                          <span>{item.label}</span>
                        </div>
                        {publishVisibility === item.label && (
                          <Check className="w-3.5 h-3.5 text-ink" />
                        )}
                      </button>
                    ))}

                    {/* 部分好友可见：好友勾选列表 */}
                    {publishVisibility === '部分好友可见' && (
                      <div className="pt-2 mt-1 border-t border-border/70 space-y-0.5 max-h-40 overflow-y-auto">
                        {allCharacters
                          .filter((c) => c.id !== activeCharacter.id)
                          .map((c) => {
                            const checked = visibleToIds.includes(c.id);
                            return (
                              <button
                                key={c.id}
                                onClick={() => toggleFriend(c.id)}
                                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition cursor-pointer ${
                                  checked ? 'bg-bg-muted-2/80 font-medium text-ink' : 'hover:bg-bg-muted text-ink'
                                }`}
                              >
                                <span>{c.name}</span>
                                {checked && <Check className="w-3.5 h-3.5 text-cyan" />}
                              </button>
                            );
                          })}
                        {allCharacters.filter((c) => c.id !== activeCharacter.id).length === 0 && (
                          <p className="px-2.5 py-1.5 text-xs text-ink-faint">暂无其他好友可选</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {viewerSrc && <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </div>
  );
};
