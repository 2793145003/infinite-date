/**
 * 主题系统 — 纯前端，localStorage 持久化
 */

export type ThemeId = 'dark-night' | 'warm-dusk' | 'deep-forest' | 'light-paper' | 'pure-white';

export const THEMES: { id: ThemeId; name: string; desc: string; swatch: string[] }[] = [
  { id: 'dark-night',  name: '暗夜', desc: '深蓝底 · 青色气泡', swatch: ['#0d1117', '#5dade2', '#e8a838'] },
  { id: 'warm-dusk',   name: '暖暮', desc: '暖棕底 · 玫粉气泡', swatch: ['#1a120f', '#e88aa6', '#e8a838'] },
  { id: 'deep-forest', name: '深森', desc: '墨绿底 · 翠绿气泡', swatch: ['#0a1410', '#7dcf9f', '#e8a838'] },
  { id: 'light-paper', name: '浅纸', desc: '米白底 · 蓝色气泡', swatch: ['#f5f1ea', '#4a8db8', '#c4942a'] },
  { id: 'pure-white',  name: '纯白', desc: '纯白底 · 蓝色气泡', swatch: ['#ffffff', '#4a8db8', '#c4942a'] },
];

/* === 字体大小 === */
export type FontScaleId = 'small' | 'normal' | 'large' | 'xlarge';

export const FONT_SCALES: { id: FontScaleId; name: string; desc: string; scale: number }[] = [
  { id: 'small',  name: '小', desc: '紧凑',   scale: 0.875 },
  { id: 'normal', name: '标准', desc: '默认', scale: 1.0 },
  { id: 'large',  name: '大', desc: '舒适',   scale: 1.125 },
  { id: 'xlarge', name: '特大', desc: '易读', scale: 1.25 },
];

const STORAGE_KEY = 'idate_theme';
const FONT_SCALE_KEY = 'idate_font_scale';

export function getTheme(): ThemeId {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && THEMES.some(t => t.id === saved)) return saved as ThemeId;
  return 'dark-night';
}

export function setTheme(theme: ThemeId): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  if (theme === 'dark-night') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

/** 初始化：页面加载时立即应用已存的主题，避免闪烁 */
export function initTheme(): void {
  applyTheme(getTheme());
  applyFontScale(getFontScale());
}

/* === 字体大小 === */
export function getFontScale(): FontScaleId {
  const saved = localStorage.getItem(FONT_SCALE_KEY);
  if (saved && FONT_SCALES.some(f => f.id === saved)) return saved as FontScaleId;
  return 'normal';
}

export function setFontScale(id: FontScaleId): void {
  localStorage.setItem(FONT_SCALE_KEY, id);
  applyFontScale(id);
}

export function applyFontScale(id: FontScaleId): void {
  const config = FONT_SCALES.filter(f => f.id === id)[0] ?? FONT_SCALES[1] ?? FONT_SCALES[0];
  if (!config) return;
  document.documentElement.style.setProperty('--font-scale', String(config.scale));
}

/* === 摸鱼开关（工作模式按钮是否显示） === */
const FISH_TOGGLE_KEY = 'idate_fish_toggle';

export function getFishToggle(): boolean {
  return localStorage.getItem(FISH_TOGGLE_KEY) === '1';
}

export function setFishToggle(enabled: boolean): void {
  localStorage.setItem(FISH_TOGGLE_KEY, enabled ? '1' : '0');
}
