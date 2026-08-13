// Shared types for admin panels

export type AdminTab = 'npcs' | 'invites' | 'locations';

export interface NpcEntry {
  id: string;
  name: string;
  avatar: string;
  creator: string | null;
  createdAt: number;
  updatedAt: number;
  characterData: string;
}

export interface InviteCodeEntry {
  code: string;
  playerId: string;
  playerName: string;
  isAdmin: boolean;
  permissionBalance: number;
  createdAt: number;
  revokedAt: number | null;
  active: boolean;
  lastLoginAt: number | null;
}

// 新地图(scene_locations)地点 —— 管理端「地点」页签
export interface SceneNpc {
  id: string;
  role: string;
  name: string;
  persona: string;
}

export interface SceneLocationEntry {
  id: string;
  name: string;
  summary: string;
  creatorType: string;
  creatorId: string | null;
  isPublic: boolean;
  parentId: string | null;
  home_of: string | null;
  homeResidents: { characterId: string; name: string }[];
  childrenCount: number;
  createdAt: number;
  npcs: SceneNpc[];
  activities: string[];
  background: string;
  submissions: { uploaderId: string; image: string; at: number }[];
}

// 编辑用的松散类型，兼容各种历史数据
export type Draft = Record<string, any>;

export interface FieldVersion {
  source: string;       // '原版' | 玩家名
  value: string;
  updatedAt?: number;
}
