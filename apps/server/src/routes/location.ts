/**
 * 地点路由
 * 玩家消耗权限创建主城地点（公开/私有）
 *
 * 设计文档（DESIGN.md 2.3）：
 * - 公开地点：消耗较多权限，所有人可见，进入公共行程池，不归创建者
 * - 私有地点：消耗较少权限，仅自己可见，仅自己的NPC会去
 * - NPC创建的地点绑定character_instance_id，Phase 4任务系统时实现
 *
 * 嵌套地图：地点可有 parent_id 形成树形结构（像文件夹）。
 * 顶层地点 parent_id IS NULL，进入大地点后可看到/创建子地点。
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db';
import { requireAuth } from '../lib/auth';

// hub world的ID（db/index.ts初始化写入）
const HUB_WORLD_ID = 'default-world';

/**
 * 获取地点的完整路径（从根到当前节点），如 "星河公园 › 湖边长椅"
 * 递归向上查 parent_id，最多20层防循环引用
 */
export function getLocationPath(locationId: string): string {
  const parts: string[] = [];
  let curId: string | null = locationId;
  let depth = 0;
  while (curId && depth < 20) {
    const row = db.prepare('SELECT name, parent_id FROM locations WHERE id = ?').get(curId) as
      { name: string; parent_id: string | null } | undefined;
    if (!row) break;
    parts.unshift(row.name);
    curId = row.parent_id;
    depth++;
  }
  return parts.join(' › ');
}

export async function locationRoutes(app: FastifyInstance): Promise<void> {
  // 获取单个地点信息
  app.get('/locations/:id', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const { id } = req.params as { id: string };
    const row = db.prepare(`
      SELECT id, world_id, name, summary, creator_type, creator_id, is_public, parent_id, created_at
      FROM locations WHERE id = ?
    `).get(id) as {
      id: string; name: string; summary: string;
      creator_type: string; creator_id: string | null; is_public: number;
      parent_id: string | null; created_at: number;
    } | undefined;

    if (!row) {
      return reply.code(404).send({ error: '地点不存在' });
    }
    // 权限检查：私有地点只有创建者可见
    if (!row.is_public && row.creator_type === 'player' && row.creator_id !== playerId) {
      return reply.code(403).send({ error: '无权访问' });
    }

    const isHome = db.prepare('SELECT 1 FROM location_homes WHERE location_id = ?').get(id) ? true : false;

    return reply.send({
      location: {
        id: row.id,
        name: row.name,
        summary: row.summary,
        creatorType: row.creator_type,
        isPublic: !!row.is_public,
        isMine: row.creator_id === playerId,
        isHome,
        parentId: row.parent_id,
        path: getLocationPath(row.id),
        createdAt: row.created_at,
      },
    });
  });

  // 获取地点列表
  // parentId 参数控制返回哪一层：
  //   不传或 null → 顶层地点（地图首页）
  //   传 locationId → 该地点下的子地点（进入大地点后）
  app.get('/locations', async (req, reply) => {
    const playerId = requireAuth(req, reply);
    if (!playerId) return;

    const parentId = (req.query as { parentId?: string }).parentId ?? null;

    const rows = db.prepare(`
      SELECT id, world_id, name, summary, creator_type, creator_id, is_public, parent_id, created_at
      FROM locations
      WHERE world_id = ?
        AND character_instance_id IS NULL
        AND parent_id IS ${parentId ? 'NOT NULL' : 'NULL'}
        ${parentId ? 'AND parent_id = ?' : ''}
        AND (
          creator_type = 'system'
          OR is_public = 1
          OR creator_id = ?
        )
      ORDER BY creator_type ASC, created_at ASC
    `).all(...(parentId ? [HUB_WORLD_ID, parentId, playerId] : [HUB_WORLD_ID, playerId])) as Array<{
      id: string; world_id: string; name: string; summary: string;
      creator_type: string; creator_id: string | null; is_public: number;
      parent_id: string | null; created_at: number;
    }>;

    // 家地点只在夜间显示（23:00-06:00）
    const hour = new Date().getHours();
    const isNight = hour >= 23 || hour < 6;

    // 批量查每个地点是否有子地点（决定是否显示"进入"箭头）
    const locationIds = rows.map(r => r.id);
    const childCounts = new Map<string, number>();
    if (locationIds.length > 0) {
      const placeholders = locationIds.map(() => '?').join(',');
      const childRows = db.prepare(
        `SELECT parent_id, COUNT(*) AS cnt FROM locations WHERE parent_id IN (${placeholders}) GROUP BY parent_id`
      ).all(...locationIds) as { parent_id: string; cnt: number }[];
      for (const r of childRows) childCounts.set(r.parent_id, r.cnt);
    }

    // 批量查哪些地点是家地点
    const homeLocIds = new Set<string>();
    if (locationIds.length > 0) {
      const placeholders = locationIds.map(() => '?').join(',');
      const homeRows = db.prepare(`SELECT DISTINCT location_id FROM location_homes WHERE location_id IN (${placeholders})`).all(...locationIds) as { location_id: string }[];
      for (const r of homeRows) homeLocIds.add(r.location_id);
    }

    const locations = rows
      .filter(r => {
        // 系统家地点：夜间显示
        if (homeLocIds.has(r.id) && r.creator_type === 'system') return isNight;
        return true;
      })
      .map(r => ({
        id: r.id,
        name: r.name,
        summary: r.summary,
        creatorType: r.creator_type,
        isPublic: !!r.is_public,
        isMine: r.creator_id === playerId,
        isHome: homeLocIds.has(r.id),
        parentId: r.parent_id,
        path: getLocationPath(r.id),
        hasChildren: (childCounts.get(r.id) ?? 0) > 0,
        createdAt: r.created_at,
      }));

    return reply.send({ locations });
  });

  // 创建地点
  // ⛔ 已下线：旧地图地点表已被新地图(scene_locations)替代，玩家在新地图建地点。
  // 同时禁用写入旧 locations 表，杜绝新旧两表分叉（见 MIGRATION_DESIGN §12）。
  app.post('/locations', async (_req, reply) => {
    return reply.code(403).send({
      error: '旧地图已归档，请到「新地图」中创建地点',
    });
  });

  // 删除地点（仅创建者可删自己的私有地点；公开地点不归创建者，不能删）
  // 级联删除所有子地点（由 ON DELETE CASCADE 保证）
  // ⛔ 已下线：旧地图已归档，禁用删除旧 locations 表（见 POST /locations 说明）
  app.delete('/locations/:id', async (_req, reply) => {
    return reply.code(403).send({
      error: '旧地图已归档，不能再删除地点',
    });
  });
}
