/**
 * 角色数据加载 helper
 *
 * fork 优先级：玩家fork > 公共模板 > 私有角色
 *
 * fork 机制：
 * - 公共角色存在 characters 表（共享模板）
 * - 玩家编辑后存到 character_player_data（source_character_id 指向原角色）
 * - 加载时优先读 fork，没有 fork 才读原模板
 * - 私有角色 source_character_id IS NULL，id 即为 characterId
 */
import { db } from '../db';
import { jsonParse } from './util';
import type { CharacterData } from '@idate/shared';

/**
 * 加载角色数据（玩家视角，fork 优先）
 */
export function loadCharacterData(playerId: string, characterId: string): CharacterData | null {
  // 1. 玩家 fork（公共角色的个人副本）
  const fork = db.prepare(
    'SELECT character_data FROM character_player_data WHERE player_id = ? AND source_character_id = ?'
  ).get(playerId, characterId) as { character_data: string } | undefined;
  if (fork) {
    return jsonParse<CharacterData | null>(fork.character_data, null);
  }

  // 2. 公共角色模板
  const pubChar = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
  if (pubChar) {
    return jsonParse<CharacterData | null>(pubChar.character_data, null);
  }

  // 3. 私有角色（by ID）
  const privChar = db.prepare('SELECT character_data FROM character_player_data WHERE id = ?').get(characterId) as { character_data: string } | undefined;
  if (privChar) {
    return jsonParse<CharacterData | null>(privChar.character_data, null);
  }

  return null;
}

/**
 * 获取角色名（不需要 player 上下文，用于记忆等无玩家视角的场景）
 */
export function getCharacterName(characterId: string): string {
  const pubChar = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
  if (pubChar) {
    const data = jsonParse<CharacterData | null>(pubChar.character_data, null);
    if (data?.name) return data.name;
  }
  const privChar = db.prepare('SELECT character_data FROM character_player_data WHERE id = ?').get(characterId) as { character_data: string } | undefined;
  if (privChar) {
    const data = jsonParse<CharacterData | null>(privChar.character_data, null);
    if (data?.name) return data.name;
  }
  return '角色';
}

/**
 * 获取角色头像文件名（uploads/ 下文件名，经 imageUrl() 访问）。
 * 没有 / 未设 → 返回空字符串（前端用名字首字占位）。无需 player 上下文时传空字符串。
 *
 * 回退规则（对齐 fork 读取统一原则：COALESCE(玩家版, 公共版)）：
 *   fork 头像为空字符串 → 回退查公共角色模板头像，避免「只改了性格没动头像就丢公共头像」。
 *   仅头像读取回退，不动 loadCharacterData 全局行为（其他字段仍 fork 优先整体覆盖）。
 */
export function getCharacterAvatar(playerId: string, characterId: string): string {
  // 1. 玩家 fork 头像（优先）
  const fork = db.prepare(
    'SELECT character_data FROM character_player_data WHERE player_id = ? AND source_character_id = ?'
  ).get(playerId, characterId) as { character_data: string } | undefined;
  if (fork) {
    const fd = jsonParse<CharacterData | null>(fork.character_data, null);
    if (fd) {
      if (fd.avatar?.trim()) return safeAvatar(fd.avatar.trim());
      // fork 头像为空 → 落到公共版（不回退私有角色，因私有角色就是自身）
      const pub = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
      if (pub) {
        const pd = jsonParse<CharacterData | null>(pub.character_data, null);
        if (pd?.avatar?.trim()) return safeAvatar(pd.avatar.trim());
      }
      return '';
    }
  }

  // 2. 公共角色模板 / 私有角色（现有 loadCharacterData 路径保底）
  const data = loadCharacterData(playerId, characterId);
  return data?.avatar?.trim() ? safeAvatar(data.avatar.trim()) : '';
}

/**
 * 头像文件存在性兜底：文件名在 image_blobs 中不存在（文件缺失）→ 返回空串，
 * 让前端回退到首字头像，避免 <img> 指向破图/404。
 *
 * 这是全局统一的头像兜底出口：所有需要把头像展示给前端的地方，
 * 无论是文件名还是空串，都必须经过这里，确保任何坏图都不会漏成裂图。
 */
export function safeAvatar(filename: string): string {
  if (!filename || typeof filename !== 'string') return '';
  const exists = db.prepare('SELECT 1 FROM image_blobs WHERE id = ?').get(filename.trim());
  return exists ? filename.trim() : '';
}

/**
 * 取公共角色模板头像（无需 player 上下文，管理端公共NPC列表等用）。
 * 返回 safeAvatar 兜底后的值：存在→文件名，缺失/未设→空串。
 */
export function getPublicAvatar(characterId: string): string {
  const pub = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
  if (!pub) return '';
  const pd = jsonParse<CharacterData | null>(pub.character_data, null);
  return safeAvatar(pd?.avatar?.trim() ?? '');
}
