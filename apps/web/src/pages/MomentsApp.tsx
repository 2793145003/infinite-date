import { useState, useEffect, useCallback, useRef } from 'react';
import { api, imageUrl } from '../lib/api';
import type { MomentInfo } from '../lib/api';
import { AutoTextarea } from '../components/AutoTextarea';
import { ImageUploadButton } from '../components/ImageUploadButton';

function formatTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day}天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

export function MomentsApp({ onBack }: { onBack: () => void }) {
  const [moments, setMoments] = useState<MomentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [newPost, setNewPost] = useState('');
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');

  const loadMoments = useCallback(async () => {
    const reqId = ++loadMomentsReqId.current;
    try {
      const data = await api.getMoments();
      if (reqId !== loadMomentsReqId.current) return; // 过期请求，丢弃
      setMoments(data.moments);
      // 更新最后查看时间（用服务器时间，避免客户端时钟偏差）
      localStorage.setItem('idate_moments_seen', String(data.serverTime));
    } catch { /* ignore */ }
    if (reqId === loadMomentsReqId.current) setLoading(false);
  }, []);

  const loadMomentsReqId = useRef(0);

  useEffect(() => {
    loadMoments();
    // 每30秒刷新一次（NPC异步评论/发帖后自动更新）
    const interval = setInterval(loadMoments, 30000);
    return () => clearInterval(interval);
  }, [loadMoments]);

  const handlePost = async () => {
    if ((!newPost.trim() && !pendingImage) || posting) return;
    setPosting(true);
    try {
      await api.createMoment(newPost.trim(), pendingImage ?? undefined);
      setNewPost('');
      setPendingImage(null);
      await loadMoments();
    } catch { /* ignore */ }
    setPosting(false);
  };

  const handleLike = async (momentId: string) => {
    try {
      await api.likeMoment(momentId);
      await loadMoments();
    } catch { /* ignore */ }
  };

  const handleComment = async (momentId: string) => {
    if (!commentText.trim()) return;
    try {
      await api.commentMoment(momentId, commentText.trim());
      setCommentText('');
      setCommentingId(null);
      await loadMoments();
    } catch { /* ignore */ }
  };

  const handleDelete = async (momentId: string) => {
    try {
      await api.deleteMoment(momentId);
      await loadMoments();
    } catch { /* ignore */ }
  };

  return (
    <div className="id-app">
      <div className="id-appbar">
        <button className="id-appbar-back" onClick={onBack}>←</button>
        <span className="id-appbar-title">朋友圈</span>
      </div>
      <div className="id-app-scroll no-pad">
        {/* 发帖框 */}
        <div className="id-moment-compose">
          <AutoTextarea
            className="id-autotextarea"
            value={newPost}
            onChange={e => setNewPost(e.target.value)}
            placeholder="发条朋友圈……"
            rows={1}
          />
          <div className="id-moment-compose-bottom">
            <ImageUploadButton
              onUploaded={(p) => setPendingImage(p)}
              onClear={() => setPendingImage(null)}
              disabled={posting}
            />
            <button
              className="id-moment-post-btn"
              onClick={handlePost}
              disabled={(!newPost.trim() && !pendingImage) || posting}
            >
              发布
            </button>
          </div>
        </div>

        {/* Feed */}
        {loading ? (
          <div className="id-loading">加载中…</div>
        ) : moments.length === 0 ? (
          <div className="id-empty"><span>🌙</span><span>朋友圈还空空的</span></div>
        ) : (
          <div className="id-moment-list">
            {moments.map((m) => (
              <div key={m.id} className="id-moment-card">
                <div className="id-moment-header">
                  <div className={`id-moment-avatar ${m.authorType === 'character' ? 'is-npc' : 'is-player'}`}>
                    {m.authorAvatar ? (
                      <img src={imageUrl(m.authorAvatar)} alt="" className="id-moment-avatar-img" />
                    ) : (
                      m.authorName.charAt(0)
                    )}
                  </div>
                  <div className="id-moment-meta">
                    <div className={`id-moment-author ${m.authorType === 'character' ? 'is-npc' : ''}`}>
                      {m.authorName}
                    </div>
                    <div className="id-moment-time">
                      {formatTime(m.createdAt)}
                      {m.locationName && ` · 📍 ${m.locationName}`}
                    </div>
                  </div>
                  {m.authorType === 'player' && (
                    <button className="id-moment-delete" onClick={() => handleDelete(m.id)}>删除</button>
                  )}
                </div>

                <div className="id-moment-content">
                  {m.content}
                  {m.imagePath && (
                    <img
                      src={imageUrl(m.imagePath)}
                      alt="图片"
                      className="id-moment-image"
                      loading="lazy"
                      onClick={(e) => (e.target as HTMLImageElement).classList.toggle('id-moment-image-expanded')}
                    />
                  )}
                </div>

                {/* 互动栏 */}
                <div className="id-moment-actions">
                  <button
                    className={`id-moment-action ${m.likes.some(l => l.authorType === 'player') ? 'is-liked' : ''}`}
                    onClick={() => handleLike(m.id)}
                  >
                    {m.likes.some(l => l.authorType === 'player') ? '❤️' : '🤍'} {m.likes.length || ''}
                  </button>
                  <button
                    className="id-moment-action"
                    onClick={() => {
                      setCommentingId(commentingId === m.id ? null : m.id);
                      setCommentText('');
                    }}
                  >
                    💬 {m.comments.length || ''}
                  </button>
                </div>

                {/* 点赞列表 */}
                {m.likes.length > 0 && (
                  <div className="id-moment-likes">
                    {m.likes.map((l, i) => (
                      <span key={l.id}>
                        {i > 0 && '、'}
                        {l.authorName}
                      </span>
                    ))}
                  </div>
                )}

                {/* 评论列表 */}
                {m.comments.length > 0 && (
                  <div className="id-moment-comments">
                    {m.comments.map((c) => (
                      <div key={c.id} className="id-moment-comment">
                        <span className={`id-moment-comment-author ${c.authorType === 'character' ? 'is-npc' : ''}`}>
                          {c.authorName}：
                        </span>
                        <span className="id-moment-comment-body">{c.body}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* 评论输入框 */}
                {commentingId === m.id && (
                  <div className="id-moment-comment-input">
                    <AutoTextarea
                      className="id-autotextarea"
                      value={commentText}
                      onChange={e => setCommentText(e.target.value)}
                      placeholder="写评论……"
                      rows={1}
                    />
                    <button
                      className="id-moment-comment-btn"
                      onClick={() => handleComment(m.id)}
                      disabled={!commentText.trim()}
                    >
                      发送
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
