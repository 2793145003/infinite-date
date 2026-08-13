/**
 * 功能建议 & 更新日志路由
 *
 * 建议页：匿名提建议、点赞、评论、管理员标记状态
 * 日志页：更新日志，只有管理员能编辑
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth, requireAdmin } from '../lib/auth';
import { genId, now } from '../lib/util';

// ─── 路由 ────────────────────────────────────────────────────

export async function feedbackRoutes(app: FastifyInstance): Promise<void> {

  // ═══ 功能建议 ════════════════════════════════════════════

  // 列出所有建议（按最新排序）
  app.get('/suggestions', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const rows = db.prepare(`
      SELECT id, player_id, is_anonymous, title, body, category, status, admin_note, created_at, updated_at
      FROM suggestions
      ORDER BY created_at DESC
    `).all() as Array<{
      id: string; player_id: string | null; is_anonymous: number; title: string; body: string;
      category: string; status: string; admin_note: string; created_at: number; updated_at: number;
    }>;

    // 检查当前用户是否管理员（决定是否显示提交者）
    const myRow = db.prepare('SELECT is_admin FROM players WHERE id = ?').get(playerId) as { is_admin: number } | undefined;
    const isAdmin = !!myRow?.is_admin;

    const result = rows.map(s => {
      const interactions = db.prepare(`
        SELECT id, player_id, interaction_type, body, created_at
        FROM suggestion_interactions
        WHERE suggestion_id = ?
        ORDER BY created_at ASC
      `).all(s.id) as Array<{
        id: string; player_id: string; interaction_type: string; body: string; created_at: number;
      }>;

      const likes = interactions.filter(i => i.interaction_type === 'like');
      const comments = interactions.filter(i => i.interaction_type === 'comment');

      // 解析提交者名（匿名且非管理员 → 不显示）
      let authorName: string | null = null;
      if (!s.is_anonymous || isAdmin) {
        if (s.player_id) {
          const p = db.prepare('SELECT name FROM players WHERE id = ?').get(s.player_id) as { name: string } | undefined;
          authorName = p?.name ?? '未知';
        }
      }

      // 评论/点赞默认匿名——非管理员只看到"匿名用户"（自己的显示"我"）
      // 不向非管理员返回 playerId，防止跨建议关联身份
      const resolveName = (pid: string): string => {
        const p = db.prepare('SELECT name FROM players WHERE id = ?').get(pid) as { name: string } | undefined;
        return p?.name ?? '匿名用户';
      };
      const maskName = (pid: string): string => {
        if (isAdmin) return resolveName(pid);
        return pid === playerId ? '我' : '匿名用户';
      };

      return {
        id: s.id,
        authorName,          // null = 匿名
        isAnonymous: !!s.is_anonymous,
        title: s.title,
        body: s.body,
        category: s.category,
        status: s.status,
        adminNote: s.admin_note,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        likes: likes.map(l => ({
          id: l.id,
          authorName: maskName(l.player_id),
          isMine: l.player_id === playerId,
          createdAt: l.created_at,
        })),
        comments: comments.map(c => ({
          id: c.id,
          authorName: maskName(c.player_id),
          isMine: c.player_id === playerId,
          body: c.body,
          createdAt: c.created_at,
        })),
        myLiked: likes.some(l => l.player_id === playerId),
      };
    });

    return reply.send({ suggestions: result, isAdmin, serverTime: now() });
  });

  // 未读数 = since之后新建的建议数 + 别人评论了我提交的建议数
  app.get('/suggestions/unread-count', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const since = Number((req.query as { since?: string }).since ?? 0);

    // 检查是否管理员
    const myRow = db.prepare('SELECT is_admin FROM players WHERE id = ?').get(playerId) as { is_admin: number } | undefined;
    const isAdmin = !!myRow?.is_admin;

    let count = 0;

    // 新建议：仅管理员能看到（普通玩家不因别人提了新建议而收到红点）
    if (isAdmin) {
      const newRow = db.prepare(`
        SELECT COUNT(*) as c FROM suggestions WHERE created_at > ?
      `).get(since) as { c: number };
      count += newRow.c;
    }

    // 别人评论了我的建议：管理员和普通玩家都适用
    const myCommentRow = db.prepare(`
      SELECT COUNT(*) as c
      FROM suggestion_interactions si
      JOIN suggestions s ON si.suggestion_id = s.id
      WHERE s.player_id = ?
        AND si.player_id != ?
        AND si.interaction_type = 'comment'
        AND si.created_at > ?
    `).get(playerId, playerId, since) as { c: number };
    count += myCommentRow.c;

    return reply.send({ count });
  });

  // 提交建议
  app.post('/suggestions', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { title, body, category, isAnonymous } = req.body as {
      title?: string; body?: string; category?: string; isAnonymous?: boolean;
    };

    if (!title?.trim()) {
      return reply.code(400).send({ error: '标题不能为空' });
    }

    const validCategories = ['general', 'bug', 'feature', 'improvement'];
    const cat = validCategories.includes(category ?? '') ? category! : 'general';

    const id = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO suggestions (id, player_id, is_anonymous, title, body, category, status, admin_note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', '', ?, ?)
    `).run(id, playerId, isAnonymous === false ? 0 : 1, title.trim(), (body ?? '').trim(), cat, ts, ts);

    return reply.send({ ok: true, suggestionId: id });
  });

  // 点赞 / 取消点赞
  app.post('/suggestions/:suggestionId/like', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { suggestionId } = req.params as { suggestionId: string };
    const exists = db.prepare('SELECT 1 FROM suggestions WHERE id = ?').get(suggestionId);
    if (!exists) {
      return reply.code(404).send({ error: '建议不存在' });
    }

    const existing = db.prepare(`
      SELECT id FROM suggestion_interactions
      WHERE suggestion_id = ? AND player_id = ? AND interaction_type = 'like'
    `).get(suggestionId, playerId) as { id: string } | undefined;

    if (existing) {
      db.prepare('DELETE FROM suggestion_interactions WHERE id = ?').run(existing.id);
      return reply.send({ ok: true, liked: false });
    }

    db.prepare(`
      INSERT INTO suggestion_interactions (id, suggestion_id, player_id, interaction_type, body, created_at)
      VALUES (?, ?, ?, 'like', '', ?)
    `).run(genId(), suggestionId, playerId, now());

    return reply.send({ ok: true, liked: true });
  });

  // 评论
  app.post('/suggestions/:suggestionId/comment', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { suggestionId } = req.params as { suggestionId: string };
    const { text } = req.body as { text?: string };
    if (!text?.trim()) {
      return reply.code(400).send({ error: '评论不能为空' });
    }

    const exists = db.prepare('SELECT 1 FROM suggestions WHERE id = ?').get(suggestionId);
    if (!exists) {
      return reply.code(404).send({ error: '建议不存在' });
    }

    const commentId = genId();
    db.prepare(`
      INSERT INTO suggestion_interactions (id, suggestion_id, player_id, interaction_type, body, created_at)
      VALUES (?, ?, ?, 'comment', ?, ?)
    `).run(commentId, suggestionId, playerId, text.trim(), now());

    return reply.send({ ok: true, commentId });
  });

  // 删除自己的评论
  app.delete('/suggestions/:suggestionId/comment/:commentId', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { suggestionId, commentId } = req.params as { suggestionId: string; commentId: string };
    const comment = db.prepare(`
      SELECT player_id FROM suggestion_interactions
      WHERE id = ? AND suggestion_id = ? AND interaction_type = 'comment'
    `).get(commentId, suggestionId) as { player_id: string } | undefined;

    if (!comment) {
      return reply.code(404).send({ error: '评论不存在' });
    }

    // 管理员或评论者本人可以删
    const myRow = db.prepare('SELECT is_admin FROM players WHERE id = ?').get(playerId) as { is_admin: number } | undefined;
    if (comment.player_id !== playerId && !myRow?.is_admin) {
      return reply.code(403).send({ error: '无权删除' });
    }

    db.prepare('DELETE FROM suggestion_interactions WHERE id = ?').run(commentId);
    return reply.send({ ok: true });
  });

  // ─── 管理员：修改建议状态 ─────────────────────────────────
  app.patch('/admin/suggestions/:suggestionId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const { suggestionId } = req.params as { suggestionId: string };
    const { status, adminNote } = req.body as { status?: string; adminNote?: string };

    const validStatuses = ['open', 'planned', 'done', 'declined'];
    if (status && !validStatuses.includes(status)) {
      return reply.code(400).send({ error: '无效状态' });
    }

    const exists = db.prepare('SELECT 1 FROM suggestions WHERE id = ?').get(suggestionId);
    if (!exists) {
      return reply.code(404).send({ error: '建议不存在' });
    }

    const ts = now();
    if (status) {
      db.prepare('UPDATE suggestions SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, suggestionId);
    }
    if (adminNote !== undefined) {
      db.prepare('UPDATE suggestions SET admin_note = ?, updated_at = ? WHERE id = ?').run(adminNote.trim(), ts, suggestionId);
    }

    return reply.send({ ok: true });
  });

  // ─── 管理员：删除建议 ─────────────────────────────────────
  app.delete('/admin/suggestions/:suggestionId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const { suggestionId } = req.params as { suggestionId: string };
    db.prepare('DELETE FROM suggestions WHERE id = ?').run(suggestionId);
    return reply.send({ ok: true });
  });

  // ═══ 更新日志 ════════════════════════════════════════════

  // 列出所有日志（所有人可看）
  app.get('/changelog', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const rows = db.prepare(`
      SELECT id, version, title, body, created_at, updated_at
      FROM changelog
      ORDER BY created_at DESC
    `).all() as Array<{
      id: string; version: string; title: string; body: string; created_at: number; updated_at: number;
    }>;

    const myRow = db.prepare('SELECT is_admin FROM players WHERE id = ?').get(playerId) as { is_admin: number } | undefined;
    const isAdmin = !!myRow?.is_admin;

    return reply.send({
      entries: rows.map(r => ({
        id: r.id,
        version: r.version,
        title: r.title,
        body: r.body,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      isAdmin,
    });
  });

  // 管理员：创建日志
  app.post('/admin/changelog', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const { version, title, body } = req.body as { version?: string; title?: string; body?: string };
    if (!title?.trim()) {
      return reply.code(400).send({ error: '标题不能为空' });
    }

    const id = genId();
    const ts = now();
    db.prepare(`
      INSERT INTO changelog (id, version, title, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, (version ?? '').trim(), title.trim(), (body ?? '').trim(), ts, ts);

    return reply.send({ ok: true, entryId: id });
  });

  // 管理员：编辑日志
  app.patch('/admin/changelog/:entryId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const { entryId } = req.params as { entryId: string };
    const { version, title, body } = req.body as { version?: string; title?: string; body?: string };

    const exists = db.prepare('SELECT 1 FROM changelog WHERE id = ?').get(entryId);
    if (!exists) {
      return reply.code(404).send({ error: '日志不存在' });
    }

    const ts = now();
    if (version !== undefined) {
      db.prepare('UPDATE changelog SET version = ?, updated_at = ? WHERE id = ?').run(version.trim(), ts, entryId);
    }
    if (title !== undefined) {
      db.prepare('UPDATE changelog SET title = ?, updated_at = ? WHERE id = ?').run(title.trim(), ts, entryId);
    }
    if (body !== undefined) {
      db.prepare('UPDATE changelog SET body = ?, updated_at = ? WHERE id = ?').run(body.trim(), ts, entryId);
    }

    return reply.send({ ok: true });
  });

  // 管理员：删除日志
  app.delete('/admin/changelog/:entryId', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const { entryId } = req.params as { entryId: string };
    db.prepare('DELETE FROM changelog WHERE id = ?').run(entryId);
    return reply.send({ ok: true });
  });
}
