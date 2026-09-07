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
export function loadCharacterDataRaw(playerId: string, characterId: string): CharacterData | null {
  let data: CharacterData | null = null;

  // 1. 玩家 fork（公共角色的个人副本）
  const fork = db.prepare(
    'SELECT character_data FROM character_player_data WHERE player_id = ? AND source_character_id = ?'
  ).get(playerId, characterId) as { character_data: string } | undefined;
  if (fork) data = jsonParse<CharacterData | null>(fork.character_data, null);

  // 2. 公共角色模板
  if (!data) {
    const pubChar = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
    if (pubChar) data = jsonParse<CharacterData | null>(pubChar.character_data, null);
  }

  // 3. 私有角色（by ID，必须归属当前玩家——否则是越权读取他人私有角色卡）
  if (!data) {
    const privChar = db.prepare('SELECT character_data FROM character_player_data WHERE id = ? AND player_id = ?').get(characterId, playerId) as { character_data: string } | undefined;
    if (privChar) data = jsonParse<CharacterData | null>(privChar.character_data, null);
  }

  return data;
}

/**
 * 加载角色数据（玩家视角，fork 优先），并在返回前展开胶囊占位符（{{character_name}}/{{player_name}}）。
 * 编辑界面不要用这个（会展开成真实名字，诱导作者写死名字），请用 loadCharacterDataRaw 直读胶囊原文。
 */
export function loadCharacterData(playerId: string, characterId: string): CharacterData | null {
  const data = loadCharacterDataRaw(playerId, characterId);
  if (!data) return null;
  return expandCapsules(data, getPlayerName(playerId));
}

/**
 * 人设人称统一清洗的配套：展开胶囊占位符。
 *   {{character_name}} → 角色名；{{player_name}} → 玩家昵称。
 * 清洗把人称代词统一成了胶囊（存库层）；注入 prompt 前在这里展开成真实名字。
 * 台词类字段（speechStyle.examples.line / textingStyle.examples）清洗时豁免人称替换、不含胶囊，展开不影响它们。
 */
export function expandCapsules(data: CharacterData, playerName: string): CharacterData {
  const charName = data.name || '角色';
  const pn = playerName || '玩家';
  const expand = (s: string): string =>
    s.replace(/\{\{character_name\}\}/g, charName).replace(/\{\{player_name\}\}/g, pn);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return expand(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(node as Record<string, unknown>)) {
        out[k] = walk((node as Record<string, unknown>)[k]);
      }
      return out;
    }
    return node;
  };
  return walk(data) as CharacterData;
}

/** 查玩家昵称（无 player 上下文时兜底「玩家」） */
export function getPlayerName(playerId: string): string {
  if (!playerId) return '玩家';
  return (db.prepare('SELECT name FROM players WHERE id = ?').get(playerId) as { name: string } | undefined)?.name || '玩家';
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
export function getCharacterAvatar(playerId: string, characterId: string, charData?: CharacterData | null): string {
  // 调用方可传入已加载的角色数据（loadCharacterData 结果），避免重复查库（短信列表 N+1 优化）。
  // loadCharacterData 本身即 fork 优先，与原「先查 fork」路径等价。
  const data = charData !== undefined ? charData : loadCharacterData(playerId, characterId);
  if (data?.avatar?.trim()) return safeAvatar(data.avatar.trim());

  // 头像为空（玩家 fork 了但头像留空 / 未设）→ 回退公共角色模板头像
  const pub = db.prepare('SELECT character_data FROM characters WHERE id = ?').get(characterId) as { character_data: string } | undefined;
  if (pub) {
    const pd = jsonParse<CharacterData | null>(pub.character_data, null);
    if (pd?.avatar?.trim()) return safeAvatar(pd.avatar.trim());
  }
  return '';
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
