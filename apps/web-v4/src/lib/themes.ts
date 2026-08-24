/**
 * 主题系统 — 纯前端，localStorage 持久化
 *
 * 预置主题：dark-night / warm-dusk / deep-forest / light-paper / pure-white
 *   → 通过 <html data-theme="xxx"> 命中 index.css 里的 [data-theme="xxx"] 变量块
 *
 * 自定义主题：ThemeId = 'custom'
 *   → 玩家在设置页选 3 个颜色（背景/强调/次强调）+ 亮暗，前端用 HSL 派生整套 CSS 变量，
 *     直接 setProperty 写到 documentElement 的 inline style。
 *   → 只对当前玩家生效（localStorage），不改 index.css、不新增公共主题。
 */

import { imageUrl } from './api';
import butterflyWallpaperImg from '../assets/images/butterfly_ripple_wallpaper_1786953401075.jpg';

export type ThemeId = 'dark-night' | 'warm-dusk' | 'deep-forest' | 'light-paper' | 'pure-white' | 'watercolor' | 'custom';

export const THEMES: { id: ThemeId; name: string; desc: string; swatch: string[] }[] = [
  { id: 'dark-night',  name: '暗夜', desc: '深蓝底 · 青色气泡', swatch: ['#0d1117', '#5dade2', '#e8a838'] },
  { id: 'warm-dusk',   name: '暖暮', desc: '暖棕底 · 玫粉气泡', swatch: ['#1a120f', '#e88aa6', '#e8a838'] },
  { id: 'deep-forest', name: '深森', desc: '墨绿底 · 翠绿气泡', swatch: ['#0a1410', '#7dcf9f', '#e8a838'] },
  { id: 'light-paper', name: '浅纸', desc: '米白底 · 蓝色气泡', swatch: ['#f5f1ea', '#4a8db8', '#c4942a'] },
  { id: 'pure-white',  name: '纯白', desc: '纯白底 · 蓝色气泡', swatch: ['#ffffff', '#4a8db8', '#c4942a'] },
  { id: 'watercolor', name: '心动水彩', desc: '浅蓝水彩 · 白毛玻璃', swatch: ['#dfe7f5', '#5b7fd6', '#d9a63a'] },
];

/* === 字体大小 === */
export type FontScaleId = 'small' | 'normal' | 'large' | 'xlarge';

export const FONT_SCALES: { id: FontScaleId; name: string; desc: string; scale: number }[] = [
  { id: 'small',  name: '小', desc: '紧凑',   scale: 0.875 },
  { id: 'normal', name: '标准', desc: '默认', scale: 1.0 },
  { id: 'large',  name: '大', desc: '舒适',   scale: 1.125 },
  { id: 'xlarge', name: '特大', desc: '易读', scale: 1.25 },
];

const STORAGE_KEY = 'idate_theme_v2';
const FONT_SCALE_KEY = 'idate_font_scale';

export function getTheme(): ThemeId {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'custom') return 'custom';
  if (saved && THEMES.some(t => t.id === saved)) return saved as ThemeId;
  return 'watercolor';
}

export function setTheme(theme: ThemeId): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  clearCustomVars(root); // 无论切到哪，先清掉自定义 inline 变量，避免残留覆盖
  if (theme === 'custom') {
    root.removeAttribute('data-theme');
    const c = getCustomTheme();
    applyCustomVars(root, c);
  } else if (theme === 'dark-night') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  // 背景蒙版透明度是用户偏好，clearCustomVars 会清掉 --bg-overlay，这里重新应用
  applyBgOverlay(getBgOverlay());
  // 地图页默认背景：随主题选一张预设壁纸（--map-bg-image）
  applyMapBg(theme);
}

/** 初始化：页面加载时立即应用已存的主题，避免闪烁 */
export function initTheme(): void {
  applyTheme(getTheme());
  applyFontScale(getFontScale());
  applyHomeBg(getHomeBg());
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

/* ═══════════════════════════════════════════════════════════
 * 自定义皮肤
 * ═══════════════════════════════════════════════════════════ */

export interface CustomTheme {
  /** 背景主色（app 最底层） */
  base: string;
  /** 强调色（玩家气泡 + 高亮按钮） */
  accent: string;
  /** 次强调色（徽章、图标、第二点缀） */
  accent2: string;
  /** 亮/暗：决定文字是浅色还是深色、面板往亮还是往暗走 */
  isDark: boolean;
}

const CUSTOM_KEY = 'idate_custom_theme';

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  base: '#0d1117',
  accent: '#5dade2',
  accent2: '#e8a838',
  isDark: true,
};

export function getCustomTheme(): CustomTheme {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (!raw) return { ...DEFAULT_CUSTOM_THEME };
    const parsed = JSON.parse(raw) as Partial<CustomTheme>;
    // 容错：字段缺失/非法则回落默认值
    return {
      base: isHexColor(parsed.base) ? parsed.base! : DEFAULT_CUSTOM_THEME.base,
      accent: isHexColor(parsed.accent) ? parsed.accent! : DEFAULT_CUSTOM_THEME.accent,
      accent2: isHexColor(parsed.accent2) ? parsed.accent2! : DEFAULT_CUSTOM_THEME.accent2,
      isDark: typeof parsed.isDark === 'boolean' ? parsed.isDark : true,
    };
  } catch {
    return { ...DEFAULT_CUSTOM_THEME };
  }
}

export function setCustomTheme(c: CustomTheme): void {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(c));
}

/** 保存并立即应用自定义皮肤（设置页颜色选择器实时预览用） */
export function applyCustomTheme(c: CustomTheme): void {
  setCustomTheme(c);
  localStorage.setItem(STORAGE_KEY, 'custom'); // 让刷新后 getTheme() 也返回 'custom'
  const root = document.documentElement;
  root.removeAttribute('data-theme'); // 自定义不依赖 data-theme，走 inline 变量
  applyCustomVars(root, c);
}

/* ── 颜色工具（纯函数，无依赖） ── */

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (x: number) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return rgbToHex(r, g, b);
}

/** 调整亮度（amount 为相对增量，-1~1） */
function shiftLightness(hex: string, amount: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.max(0, Math.min(1, l + amount)));
}

/** 带 alpha 的 rgba 字符串 */
function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** 以 hex 的色相、指定饱和度/亮度生成新色 */
function hslColor(hex: string, s: number, l: number): string {
  const [h] = hexToHsl(hex);
  return hslToHex(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l)));
}

/* ── 派生：3 个色 + 亮暗 → 整套 CSS 变量 ── */

/** 语义色（跨主题基本固定）：rose 亲密 / ember 危险 / plum 神秘 / sage 正向 */
const SEMANTIC = { rose: '#e88aa6', ember: '#e07a82', plum: '#b27ce2', sage: '#7dcf9f' };

/** 所有会被自定义皮肤写入的变量名，用于切回预置主题时清理 */
const CUSTOM_VAR_NAMES = [
  '--ink', '--ink-2', '--panel', '--panel-2',
  '--border', '--border-soft', '--border-bright',
  '--text', '--text-dim', '--text-mute',
  '--accent', '--accent-2', '--amber', '--amber-dim', '--cyan',
  '--rose', '--sage', '--ember', '--plum',
  '--player-bubble-bg', '--player-bubble-border',
  '--npc-bubble-bg', '--npc-bubble-border',
  '--bg-glow-1', '--bg-glow-2',
  '--phone-bg', '--phone-border', '--phone-inset', '--boot-bg',
  '--scrollbar-thumb',
  '--overlay-bg', '--overlay-bg-hover', '--bg-overlay',
  '--tile-cyan-c1', '--tile-cyan-c2', '--tile-cyan-bd',
  '--tile-amber-c1', '--tile-amber-c2', '--tile-amber-bd',
  '--tile-rose-c1', '--tile-rose-c2', '--tile-rose-bd',
  '--tile-sage-c1', '--tile-sage-c2', '--tile-sage-bd',
  '--tile-plum-c1', '--tile-plum-c2', '--tile-plum-bd',
  '--tile-ember-c1', '--tile-ember-c2', '--tile-ember-bd',
  '--card-bg', '--card-bg-hover', '--card-bg-alt', '--card-bg-strong',
  '--btn-bg', '--btn-bg-hover',
  '--shadow', '--shadow-sm',
];

function buildCustomThemeVars(c: CustomTheme): Record<string, string> {
  const { base, accent, accent2, isDark } = c;

  // 背景色阶：暗色往亮走，亮色往暗走（边框方向相反）
  const ink = base;
  const ink2 = isDark ? shiftLightness(base, 0.04) : shiftLightness(base, -0.04);
  const panel = isDark ? shiftLightness(base, 0.07) : shiftLightness(base, 0.02);
  const panel2 = isDark ? shiftLightness(base, 0.11) : shiftLightness(base, -0.04);
  const borderSoft = isDark ? shiftLightness(base, 0.11) : shiftLightness(base, -0.08);
  const border = isDark ? shiftLightness(base, 0.15) : shiftLightness(base, -0.14);
  const borderBright = isDark ? shiftLightness(base, 0.22) : shiftLightness(base, -0.22);

  // 文字三档：暗底浅字，亮底深字；带背景色相避免死白/死黑
  const text = isDark ? hslColor(base, 0.18, 0.88) : hslColor(base, 0.45, 0.16);
  const textDim = isDark ? hslColor(base, 0.22, 0.68) : hslColor(base, 0.35, 0.40);
  const textMute = isDark ? hslColor(base, 0.25, 0.48) : hslColor(base, 0.28, 0.56);

  // 磁贴（图标底）：用主色/强调色/语义色做暗底
  const tile = (color: string) => ({
    c1: isDark ? shiftLightness(color, -0.55) : shiftLightness(color, 0.32),
    c2: isDark ? shiftLightness(color, -0.62) : shiftLightness(color, 0.42),
    bd: withAlpha(color, isDark ? 0.3 : 0.35),
  });
  const tileCyan = tile(accent);
  const tileAmber = tile(accent2);
  const tileRose = tile(SEMANTIC.rose);
  const tileSage = tile(SEMANTIC.sage);
  const tilePlum = tile(SEMANTIC.plum);
  const tileEmber = tile(SEMANTIC.ember);

  const shadowAlpha = isDark ? 0.6 : 0.22;
  const shadowSmAlpha = isDark ? 0.42 : 0.14;

  return {
    '--ink': ink,
    '--ink-2': ink2,
    '--panel': panel,
    '--panel-2': panel2,
    '--border': border,
    '--border-soft': borderSoft,
    '--border-bright': borderBright,
    '--text': text,
    '--text-dim': textDim,
    '--text-mute': textMute,
    '--accent': accent,
    '--accent-2': accent2,
    '--amber': accent2,
    '--amber-dim': shiftLightness(accent2, isDark ? -0.15 : 0.1),
    '--cyan': accent,
    '--rose': SEMANTIC.rose,
    '--sage': SEMANTIC.sage,
    '--ember': SEMANTIC.ember,
    '--plum': SEMANTIC.plum,
    '--player-bubble-bg': withAlpha(accent, isDark ? 0.4 : 0.18),
    '--player-bubble-border': withAlpha(accent, isDark ? 0.5 : 0.35),
    '--npc-bubble-bg': withAlpha(panel, isDark ? 0.88 : 0.92),
    '--npc-bubble-border': borderSoft,
    '--bg-glow-1': withAlpha(accent2, isDark ? 0.2 : 0.14),
    '--bg-glow-2': withAlpha(accent, isDark ? 0.16 : 0.10),
    '--phone-bg': shiftLightness(base, isDark ? -0.04 : 0.03),
    '--phone-border': border,
    '--phone-inset': ink2,
    '--boot-bg': shiftLightness(base, isDark ? -0.04 : 0.03),
    '--scrollbar-thumb': withAlpha(accent, 0.15),
    '--overlay-bg': withAlpha(ink, 0.6),
    '--overlay-bg-hover': withAlpha(ink, 0.75),
    '--bg-overlay': withAlpha(ink, isDark ? 0.55 : 0.4),
    '--tile-cyan-c1': tileCyan.c1, '--tile-cyan-c2': tileCyan.c2, '--tile-cyan-bd': tileCyan.bd,
    '--tile-amber-c1': tileAmber.c1, '--tile-amber-c2': tileAmber.c2, '--tile-amber-bd': tileAmber.bd,
    '--tile-rose-c1': tileRose.c1, '--tile-rose-c2': tileRose.c2, '--tile-rose-bd': tileRose.bd,
    '--tile-sage-c1': tileSage.c1, '--tile-sage-c2': tileSage.c2, '--tile-sage-bd': tileSage.bd,
    '--tile-plum-c1': tilePlum.c1, '--tile-plum-c2': tilePlum.c2, '--tile-plum-bd': tilePlum.bd,
    '--tile-ember-c1': tileEmber.c1, '--tile-ember-c2': tileEmber.c2, '--tile-ember-bd': tileEmber.bd,
    '--card-bg': withAlpha(panel, 0.5),
    '--card-bg-hover': withAlpha(panel2, 0.6),
    '--card-bg-alt': withAlpha(panel, 0.4),
    '--card-bg-strong': withAlpha(panel, 0.6),
    '--btn-bg': withAlpha(borderBright, 0.25),
    '--btn-bg-hover': withAlpha(borderBright, 0.4),
    '--shadow': `0 22px 50px rgba(0,0,0,${shadowAlpha})`,
    '--shadow-sm': `0 8px 22px rgba(0,0,0,${shadowSmAlpha})`,
  };
}

function applyCustomVars(root: HTMLElement, c: CustomTheme): void {
  const vars = buildCustomThemeVars(c);
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}

function clearCustomVars(root: HTMLElement): void {
  for (const name of CUSTOM_VAR_NAMES) {
    root.style.removeProperty(name);
  }
}

/* ═══════════════════════════════════════════════════════════
 * 主页背景图（桌面壁纸）
 * ═══════════════════════════════════════════════════════════ */

export type HomeBgType = 'none' | 'preset' | 'upload';

export interface HomeBg {
  type: HomeBgType;
  /** preset：预设 id；upload：图片文件名；none：空串 */
  value: string;
}

export interface HomeBgPreset {
  id: string;
  name: string;
  desc: string;
  /** CSS background-image 渐变字符串（不含 url 包裹） */
  css: string;
  /** 深浅：浅色预设用深色边框标记，避免在暗色 UI 里看不见 */
  light: boolean;
}

export const HOME_BG_PRESETS: HomeBgPreset[] = [
  {
    id: 'starry', name: '星夜', desc: '深蓝夜空 · 星点', light: false,
    css: 'radial-gradient(circle at 25% 25%, rgba(120,160,220,0.18), transparent 45%), radial-gradient(circle at 75% 60%, rgba(178,124,226,0.15), transparent 50%), radial-gradient(circle at 55% 15%, rgba(232,168,56,0.08), transparent 40%), linear-gradient(165deg, #0a0f1e 0%, #0d1526 45%, #141c34 100%)',
  },
  {
    id: 'aurora', name: '极光', desc: '青绿极光 · 冷调', light: false,
    css: 'radial-gradient(ellipse at 30% 20%, rgba(125,207,159,0.35), transparent 55%), radial-gradient(ellipse at 70% 55%, rgba(93,173,226,0.3), transparent 55%), linear-gradient(150deg, #081220 0%, #0d2030 50%, #0a1622 100%)',
  },
  {
    id: 'sunset', name: '晚霞', desc: '橙粉霞光 · 暖调', light: false,
    css: 'radial-gradient(circle at 70% 80%, rgba(232,138,166,0.3), transparent 55%), radial-gradient(circle at 30% 20%, rgba(232,168,56,0.18), transparent 50%), linear-gradient(160deg, #1a1226 0%, #341a30 45%, #3d1e2a 100%)',
  },
  {
    id: 'forest', name: '深森', desc: '墨绿林雾 · 沉静', light: false,
    css: 'radial-gradient(circle at 80% 20%, rgba(125,207,159,0.22), transparent 55%), linear-gradient(160deg, #061210 0%, #0a1c14 45%, #0e2418 100%)',
  },
  {
    id: 'mist', name: '晨雾', desc: '灰白薄雾 · 亮色', light: true,
    css: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.5), transparent 55%), linear-gradient(160deg, #e9edf2 0%, #d9dfe8 45%, #ccd5e0 100%)',
  },
  {
    id: 'butterfly', name: '水畔蝶影', desc: '水彩蝴蝶 · 原画', light: false,
    css: `url(${butterflyWallpaperImg})`,
  },
  {
    id: 'mist-blue', name: '冰晶薄雾蓝', desc: '渐变蓝紫 · 冷调', light: false,
    css: 'url("https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=800&q=80")',
  },
  {
    id: 'deep-blue-ocean', name: '深蓝海洋之境', desc: '碧蓝海水 · 通透', light: false,
    css: 'url("https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=800&q=80")',
  },
  {
    id: 'starlit-night', name: '星光梦境晚风', desc: '雪山星空 · 静谧', light: false,
    css: 'url("https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=800&q=80")',
  },
];

/** v3 首页壁纸（照抄心动终端 presetWallpapers：水畔蝶影原画 + 3 张 unsplash 渐变图） */
export interface WallpaperPreset {
  id: string;
  name: string;
  /** 缩略图 img src */
  url: string;
}

export const V3_WALLPAPERS: WallpaperPreset[] = [
  { id: 'butterfly', name: '水畔蝶影 · 原画', url: butterflyWallpaperImg },
  { id: 'mist-blue', name: '冰晶薄雾蓝', url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=800&q=80' },
  { id: 'deep-blue-ocean', name: '深蓝海洋之境', url: 'https://images.unsplash.com/photo-1544551763-46a013bb70d5?auto=format&fit=crop&w=800&q=80' },
  { id: 'starlit-night', name: '星光梦境晚风', url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=800&q=80' },
];

/* === 地图页默认背景：随主题选一张预设壁纸 === */

/** 主题 → 预设壁纸 id 映射（按色调对应） */
const THEME_MAP_BG: Record<Exclude<ThemeId, 'custom'>, string> = {
  'dark-night': 'starry',   // 暗夜 → 星夜
  'warm-dusk': 'sunset',    // 暖暮 → 晚霞
  'deep-forest': 'forest',  // 深森 → 深森
  'light-paper': 'mist',    // 浅纸 → 晨雾
  'pure-white': 'mist',     // 纯白 → 晨雾
  'watercolor': 'mist',    // 心动水彩 → 晨雾
};

function getThemeMapBg(theme: ThemeId): string {
  if (theme === 'custom') {
    return getCustomTheme().isDark ? 'starry' : 'mist';
  }
  return THEME_MAP_BG[theme] ?? 'starry';
}

/** 把主题对应的默认壁纸写到 --map-bg-image 变量（地图页背景用） */
export function applyMapBg(theme: ThemeId): void {
  const root = document.documentElement;
  const preset = HOME_BG_PRESETS.find((x) => x.id === getThemeMapBg(theme));
  if (preset) {
    root.style.setProperty('--map-bg-image', preset.css);
  } else {
    root.style.removeProperty('--map-bg-image');
  }
}

/* === 背景图蒙版透明度（用户可调滑杆） === */

const BG_OVERLAY_KEY = 'idate_bg_overlay';
/** 默认蒙版透明度（0 = 无蒙版，壁纸原样透亮，与心动终端一致；深色壁纸时玩家可自行调高滑杆保证可读） */
export const DEFAULT_BG_OVERLAY = 0;
/** 蒙版透明度上限（80%，再高背景图几乎被遮没） */
export const BG_OVERLAY_MAX = 0.8;

export function getBgOverlay(): number {
  try {
    const raw = localStorage.getItem(BG_OVERLAY_KEY);
    if (raw === null) return DEFAULT_BG_OVERLAY;
    const v = parseFloat(raw);
    if (!isFinite(v)) return DEFAULT_BG_OVERLAY;
    return Math.max(0, Math.min(BG_OVERLAY_MAX, v));
  } catch {
    return DEFAULT_BG_OVERLAY;
  }
}

export function setBgOverlay(alpha: number): void {
  const clamped = Math.max(0, Math.min(BG_OVERLAY_MAX, alpha));
  localStorage.setItem(BG_OVERLAY_KEY, String(clamped));
  applyBgOverlay(clamped);
}

/** 用当前主题的 ink 色 + 指定透明度，覆盖 --bg-overlay（背景图蒙版颜色跟随主题，只调透明度） */
export function applyBgOverlay(alpha: number): void {
  const root = document.documentElement;
  const ink = getComputedStyle(root).getPropertyValue('--ink').trim();
  const rgb = isHexColor(ink) ? hexToRgb(ink) : [13, 17, 23];
  root.style.setProperty('--bg-overlay', `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`);
}

const HOME_BG_KEY = 'idate_home_bg';

export function getHomeBg(): HomeBg {
  try {
    const raw = localStorage.getItem(HOME_BG_KEY);
    if (!raw) return { type: 'none', value: '' };
    const p = JSON.parse(raw) as Partial<HomeBg>;
    if (p.type === 'preset' && typeof p.value === 'string' && HOME_BG_PRESETS.some(x => x.id === p.value)) {
      return { type: 'preset', value: p.value };
    }
    if (p.type === 'upload' && typeof p.value === 'string' && p.value) {
      return { type: 'upload', value: p.value };
    }
    return { type: 'none', value: '' };
  } catch {
    return { type: 'none', value: '' };
  }
}

export function setHomeBg(bg: HomeBg): void {
  localStorage.setItem(HOME_BG_KEY, JSON.stringify(bg));
  applyHomeBg(bg);
}

export function clearHomeBg(): void {
  localStorage.removeItem(HOME_BG_KEY);
  applyHomeBg({ type: 'none', value: '' });
}

/** 把背景转成 CSS background-image 字符串，写到 --home-bg-image 变量（无背景则移除） */
export function applyHomeBg(bg: HomeBg): void {
  const root = document.documentElement;
  let css = '';
  if (bg.type === 'preset') {
    const p = HOME_BG_PRESETS.find(x => x.id === bg.value);
    css = p?.css ?? '';
  } else if (bg.type === 'upload' && bg.value) {
    css = `url("${imageUrl(bg.value)}")`;
  }
  if (css) {
    root.style.setProperty('--home-bg-image', css);
  } else {
    root.style.removeProperty('--home-bg-image');
  }
}

/** 当前是否有壁纸：以 DOM 的 --home-bg-image 为准（applyHomeBg 统一设置，v3 默认蝴蝶/玩家选择都走这里，不依赖 localStorage） */
export function hasHomeBgImage(): boolean {
  if (typeof document === 'undefined') return false;
  const v = getComputedStyle(document.documentElement).getPropertyValue('--home-bg-image').trim();
  return v !== '' && v !== 'none';
}
