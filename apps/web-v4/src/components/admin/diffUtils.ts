import type { Draft, FieldVersion } from './types';

// ─── Diff 工具函数 ─────────────────────────────────────────────

/** 将角色数据扁平化为 path→string 映射，便于逐字段比较 */
export function flattenFields(obj: any, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (!obj || typeof obj !== 'object') return result;
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'string') {
      result.set(path, val);
    } else if (typeof val === 'number') {
      result.set(path, String(val));
    } else if (Array.isArray(val)) {
      if (val.length === 0) continue;
      if (typeof val[0] === 'string') {
        result.set(path, val.join('、'));
      } else if (typeof val[0] === 'object') {
        if (path === 'speechStyle.examples') {
          // 台词逐条对比
          val.forEach((item: any, i: number) => {
            if (item && typeof item === 'object') {
              for (const [k, v] of Object.entries(item)) {
                if (typeof v === 'string') result.set(`${path}[${i}].${k}`, v);
              }
            }
          });
        } else {
          // likes/dislikes 等：拼成字符串对比
          const joined = val.map((item: any) =>
            typeof item === 'string' ? item :
            `${item.item ?? ''}${item.reason ? `（${item.reason}）` : ''}`
          ).filter(Boolean).join('、');
          if (joined) result.set(path, joined);
        }
      }
    } else if (val && typeof val === 'object') {
      const nested = flattenFields(val, path);
      for (const [k, v] of nested) result.set(k, v);
    }
  }
  return result;
}

const FIELD_LABELS: Record<string, string> = {
  name: '名字', age: '年龄', appearance: '外貌',
  'personality.surface': '性格·表层', 'personality.core': '性格·内核', 'personality.extreme': '性格·极端',
  'speechStyle.description': '说话风格·概述',
  'textingStyle.description': '短信风格·概述',
  'emotional_signals.nervous': '情绪·紧张', 'emotional_signals.happy': '情绪·开心',
  'emotional_signals.angry': '情绪·愤怒', 'emotional_signals.moved': '情绪·感动',
  'emotional_signals.defensive': '情绪·防御',
  'background.origin': '背景·出身', 'background.shaping': '背景·经历', 'background.current': '背景·现状',
  boundaries: '底线', goals: '目标', quirks: '怪癖', player_relation: '与玩家关系',
  skills: '擅长', ineptitudes: '不擅长', likes: '喜好', dislikes: '厌恶',
};

export function fieldLabel(path: string): string {
  let m = path.match(/^speechStyle\.examples\[(\d+)\]\.line$/);
  if (m && m[1]) return `台词${parseInt(m[1]) + 1}`;
  m = path.match(/^speechStyle\.examples\[(\d+)\]\.context$/);
  if (m && m[1]) return `台词${parseInt(m[1]) + 1}·语境`;
  m = path.match(/^textingStyle\.examples\[(\d+)\]$/);
  if (m && m[1]) return `短信${parseInt(m[1]) + 1}`;
  return FIELD_LABELS[path] ?? path;
}

export function computeDiff(original: Draft, override: Draft): { label: string; oldVal: string; newVal: string }[] {
  const origFlat = flattenFields(original);
  const overFlat = flattenFields(override);
  const allPaths = new Set([...origFlat.keys(), ...overFlat.keys()]);
  const diffs: { label: string; oldVal: string; newVal: string }[] = [];
  for (const path of allPaths) {
    const oldVal = origFlat.get(path) ?? '';
    const newVal = overFlat.get(path) ?? '';
    if (oldVal.trim() !== newVal.trim()) {
      diffs.push({ label: fieldLabel(path), oldVal, newVal });
    }
  }
  return diffs;
}

// ─── 字段版本收集 ─────────────────────────────────────────────

/** 将原版+所有玩家override扁平化，按字段路径收集去重版本 */
export function collectFieldVersions(
  original: Draft | null,
  overrides: { playerName: string; characterData: string; updatedAt: number }[],
): Map<string, FieldVersion[]> {
  const result = new Map<string, FieldVersion[]>();

  const addVersion = (path: string, version: FieldVersion, allowEmpty = false) => {
    if (!allowEmpty && !version.value.trim()) return;
    const list = result.get(path) ?? [];
    // 去重：同值只保留第一个来源
    if (!list.some(v => v.value.trim() === version.value.trim())) {
      list.push(version);
    }
    result.set(path, list);
  };

  // 原版：空值也收录，玩家fork有值时才能凑够2个版本显示选择器
  const origFlat = original ? flattenFields(original) : new Map<string, string>();
  for (const [path, val] of origFlat) {
    addVersion(path, { source: '原版', value: val }, true);
  }

  for (const o of overrides) {
    try {
      const data = JSON.parse(o.characterData) as Draft;
      const overFlat = flattenFields(data);
      // 玩家override有但原版没有的字段，补一个空的原版版本
      for (const [path] of overFlat) {
        if (!origFlat.has(path) && !result.has(path)) {
          addVersion(path, { source: '原版', value: '' }, true);
        }
      }
      for (const [path, val] of overFlat) {
        addVersion(path, { source: o.playerName, value: val, updatedAt: o.updatedAt });
      }
    } catch { /* skip invalid */ }
  }

  return result;
}

/** 预解析 overrides 供 collectFieldVersions 使用 */
export function parseOverrideData(
  overrides: { id: string; playerId: string; playerName: string; characterData: string; updatedAt: number }[],
): { playerName: string; characterData: string; updatedAt: number }[] {
  return overrides.map(o => ({ playerName: o.playerName, characterData: o.characterData, updatedAt: o.updatedAt }));
}
