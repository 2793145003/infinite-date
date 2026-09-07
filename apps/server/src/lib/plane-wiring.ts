/**
 * plane-wiring —— 位面崽（恋爱智能体）的独立身份读取层。
 *
 * 位面崽独立于主城 characters 角色卡，存 plane_characters 表。
 * 这里提供场景引擎所需的「名字 / 角色卡」读取，供 scene-wiring 的
 * scene_type='plane' 分支注入，替代 getCharacterName / buildCharacterCard。
 *
 * 纯读取，无副作用。对外简介 summary 不进 prompt（大厅展示用）；
 * 对内人设 persona 进 prompt，空则复制 summary。
 */
import { db } from '../db';

export interface PlaneCharacter {
  id: string;
  creator_id: string;
  name: string;
  gender: string;
  summary: string;
  persona: string;
  greeting: string;
  avatar: string;
  appearance: string;
  goal: string;
  published: number;
  play_count: number;
  created_at: number;
  updated_at: number;
}

export function getPlaneCharacter(id: string): PlaneCharacter | undefined {
  return db.prepare('SELECT * FROM plane_characters WHERE id = ?').get(id) as any;
}

export function getPlaneCharacterName(id: string): string {
  return getPlaneCharacter(id)?.name ?? '崽';
}

/**
 * 位面崽角色卡：只给「名字 + 性别 + 人设」。
 * persona 空则复制 summary（对内人设），保证 LLM 有东西可演。
 */
/**
 * 把 LLM 输出的占位符变体归一成标准 token。
 * gemma 长输出里会把 {{character_name}} 擅自缩成 {{char_name}}（或 {{char}}/{{player}}/{{user}} 等），
 * 导致 expandPlaneText / 前端胶囊识别不到 → 字面显示 {{char_name}}。
 * 这里统一归一：存库前归一 + 展开前归一，双保险。
 */
export function normalizePlaneTokens(s: string): string {
  return s
    .replace(/\{\{\s*char_name\s*\}\}/g, '{{character_name}}')
    .replace(/\{\{\s*character\s*\}\}/g, '{{character_name}}')
    .replace(/\{\{\s*char\s*\}\}/g, '{{character_name}}')
    .replace(/\{\{\s*角色名\s*\}\}/g, '{{character_name}}')
    .replace(/\{\{\s*player_name\s*\}\}/g, '{{player_name}}')
    .replace(/\{\{\s*user_name\s*\}\}/g, '{{player_name}}')
    .replace(/\{\{\s*player\s*\}\}/g, '{{player_name}}')
    .replace(/\{\{\s*user\s*\}\}/g, '{{player_name}}')
    .replace(/\{\{\s*玩家\s*\}\}/g, '{{player_name}}')
    // 清理占位符前后多余空格（LLM 常写成「对 {{player_name}} 特别」）
    .replace(/\s*\{\{\s*character_name\s*\}\}\s*/g, '{{character_name}}')
    .replace(/\s*\{\{\s*player_name\s*\}\}\s*/g, '{{player_name}}');
}

/**
 * 展开位面角色字段里的胶囊占位符。
 *   {{character_name}} → 角色名；{{player_name}} → 玩家昵称（无上下文兜底「玩家」）。
 * 存库保持占位符原文（作者改名字后全局生效），注入 prompt / 展示给玩家前再展开。
 */
export function expandPlaneText(s: string, charName: string, playerName: string): string {
  return normalizePlaneTokens(s)
    .replace(/\{\{character_name\}\}/g, charName)
    .replace(/\{\{player_name\}\}/g, playerName || '玩家');
}

export function buildPlaneCharacterCard(id: string, playerName = '玩家'): string {
  const c = getPlaneCharacter(id);
  if (!c) return '';
  const charName = c.name;
  const lines: string[] = [];
  lines.push(`【角色】${charName}${c.gender ? `（${c.gender}）` : ''}`);
  const persona = c.persona || c.summary;
  if (persona) lines.push(`【人设】${expandPlaneText(persona, charName, playerName)}`);
  if (c.appearance) lines.push(`【外貌】${expandPlaneText(c.appearance, charName, playerName)}`);
  return lines.join('\n');
}
