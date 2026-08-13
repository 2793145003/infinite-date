/**
 * 权限消耗/奖励配置
 * 从 src/config/permission_costs.json 读取，改文件重启即可调，不改代码。
 *
 * 设计原则（DESIGN.md）：不设魔法数字——先跑起来对负载有概念后再用数据决定。
 * 所有数值都是占位值，实测后调整这个JSON文件即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

interface PermissionCosts {
  // 任务奖励
  mission_base_reward: number;
  mission_obsession_bonus: number;
  mission_coop_bonus: { poor: number; decent: number; excellent: number };

  // 消耗
  create_public_npc: number;
  create_private_npc: number;
  override: number;
  create_location_public: number;
  create_location_private: number;
  instance_replace: number;
  undo_message: number;
  internal_view: number;
}

const configPath = path.join(config.configDir, 'permission_costs.json');

function loadCosts(): PermissionCosts {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as PermissionCosts;
  } catch {
    // 配置文件缺失或解析失败时使用默认值
    return DEFAULT_COSTS;
  }
}

const DEFAULT_COSTS: PermissionCosts = {
  mission_base_reward: 50,
  mission_obsession_bonus: 30,
  mission_coop_bonus: { poor: 10, decent: 25, excellent: 50 },
  create_public_npc: 20,
  create_private_npc: 10,
  override: 5,
  create_location_public: 15,
  create_location_private: 8,
  instance_replace: 10,
  undo_message: 2,
  internal_view: 3,
};

// 启动时加载，不需要热更新——改文件后重启服务即可
let _costs: PermissionCosts | null = null;

export function getCosts(): PermissionCosts {
  if (!_costs) _costs = loadCosts();
  return _costs;
}

/** 清除缓存（测试用） */
export function clearCostCache(): void {
  _costs = null;
}
