/**
 * I Know Book: how the page looks. The reader's own choices (theme, font, size, spacing, margins, colours), their
 * limits and the CSS they become. Everything here is plain data and arithmetic (tested without a browser).
 *
 * The defaults come from the research of 16 Nov 2026 (reports/I Know Book app design.md): about 20 px body text,
 * line height about 1.5, a line of about 55 to 65 letters, left-aligned text, soft page colours with a contrast of
 * at least 7:1, and only fonts that are already on an iPhone.
 */

import { TOKENS } from './theme';

export type ThemeId = 'auto' | 'white' | 'paper' | 'sepia' | 'green' | 'grey' | 'night' | 'black' | 'custom';
export interface Theme { id: ThemeId; name: string; bg: string; fg: string; dark: boolean }

/** page / text pairs (hex). Paper is the usual day page, Night the usual dark one. */
export const THEMES: Theme[] = [
  { id: 'white', name: 'White', bg: '#FFFFFF', fg: '#1A1A1C', dark: false },
  { id: 'paper', name: 'Paper', bg: '#FAF6EC', fg: '#23201A', dark: false },
  { id: 'sepia', name: 'Sepia', bg: '#F4ECD8', fg: '#4A3A2A', dark: false },
  // (the soft green many Chinese readers choose for their eyes, 豆沙绿)
  { id: 'green', name: 'Green', bg: '#CFE8CC', fg: '#1F2E1F', dark: false },
  { id: 'grey', name: 'Grey', bg: '#E4E4E6', fg: '#1C1C1E', dark: false },
  { id: 'night', name: 'Night', bg: '#1B1A1E', fg: '#DAD5CA', dark: true },
  { id: 'black', name: 'Black', bg: '#000000', fg: '#B9B5AC', dark: true },
];

export interface FontChoice { id: string; name: string; css: string; kind: 'serif' | 'sans' }
/** fonts an iPhone already has (no file is added to the app); each falls back to the system's own */
export const FONTS: FontChoice[] = [
  { id: 'charter', name: 'Charter', css: 'Charter, "Bitstream Charter", ui-serif, Georgia, serif', kind: 'serif' },
  { id: 'newyork', name: 'New York', css: 'ui-serif, "New York", "Iowan Old Style", Georgia, serif', kind: 'serif' },
  { id: 'georgia', name: 'Georgia', css: 'Georgia, ui-serif, serif', kind: 'serif' },
  { id: 'palatino', name: 'Palatino', css: 'Palatino, "Palatino Linotype", "Book Antiqua", ui-serif, serif', kind: 'serif' },
  { id: 'iowan', name: 'Iowan', css: '"Iowan Old Style", Charter, ui-serif, Georgia, serif', kind: 'serif' },
  { id: 'baskerville', name: 'Baskerville', css: 'Baskerville, "Baskerville Old Face", ui-serif, Georgia, serif', kind: 'serif' },
  { id: 'system', name: 'San Francisco', css: 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif', kind: 'sans' },
  { id: 'avenir', name: 'Avenir Next', css: '"Avenir Next", Avenir, system-ui, sans-serif', kind: 'sans' },
  { id: 'verdana', name: 'Verdana', css: 'Verdana, system-ui, sans-serif', kind: 'sans' },
  { id: 'rounded', name: 'Rounded', css: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", system-ui, sans-serif', kind: 'sans' },
];

export interface Look {
  theme: ThemeId;
  /** the reader's own colours (theme 'custom') */
  bg: string; fg: string;
  font: string;
  /** px */
  size: number;
  /** line height, times the size */
  line: number;
  /** the white at each side of the text, px (a wider margin = a narrower line) */
  margin: number;
  /** em, added between letters / between words */
  letter: number; word: number;
  /** the space after a paragraph, em */
  para: number;
  align: 'left' | 'justify';
  bold: boolean;
  /** a tap near the left / right edge turns the page (a swipe always does) */
  tapEdges: boolean;
}

export const LIMITS = {
  size: { min: 14, max: 40, step: 1 },
  line: { min: 1.15, max: 2.2, step: 0.05 },
  margin: { min: 8, max: 72, step: 2 },
  letter: { min: -0.02, max: 0.14, step: 0.01 },
  word: { min: -0.08, max: 0.4, step: 0.02 },
  para: { min: 0, max: 1.6, step: 0.1 },
} as const;

export const DEFAULT_LOOK: Look = { theme: 'auto', bg: '#FAF6EC', fg: '#23201A', font: 'charter', size: 19, line: 1.5, margin: 24, letter: 0, word: 0, para: 0.7, align: 'left', bold: false, tapEdges: false };

const clampTo = (v: unknown, lim: { min: number; max: number }, dflt: number): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(Math.max(lim.min, Math.min(lim.max, n)) * 100) / 100 : dflt;
};
const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

/** whatever was saved, made safe (unknown values = the defaults) */
export function readLook(raw: unknown): Look {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Look>;
  const d = DEFAULT_LOOK;
  const theme = r.theme === 'custom' || r.theme === 'auto' || THEMES.some((t) => t.id === r.theme) ? (r.theme as ThemeId) : d.theme;
  return {
    theme, bg: isHex(r.bg) ? r.bg : d.bg, fg: isHex(r.fg) ? r.fg : d.fg,
    font: FONTS.some((f) => f.id === r.font) ? (r.font as string) : d.font,
    size: clampTo(r.size, LIMITS.size, d.size), line: clampTo(r.line, LIMITS.line, d.line), margin: clampTo(r.margin, LIMITS.margin, d.margin),
    letter: clampTo(r.letter, LIMITS.letter, d.letter), word: clampTo(r.word, LIMITS.word, d.word), para: clampTo(r.para, LIMITS.para, d.para),
    align: r.align === 'justify' ? 'justify' : 'left', bold: r.bold === true, tapEdges: r.tapEdges === true,
  };
}

// ---- colours ---------------------------------------------------------------------------------------------------
const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const toHex = (c: readonly number[]): string => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const lum = (hex: string): number => {
  const [r, g, b] = rgb(hex).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** the contrast of two colours, 1 (the same) … 21 (black on white) */
export function contrast(a: string, b: string): number {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** a colour between two others (0 = a, 1 = b) */
export const mix = (a: string, b: string, t: number): string => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
export const isDark = (bg: string): boolean => lum(bg) < 0.2;

/**
 * The reader's own two colours, made readable: when the text is too close to the page (under 4.5:1), the text is
 * moved towards black or white until it can be read. The page colour is never changed.
 */
export function readable(bg: string, fg: string, min = 4.5): string {
  if (contrast(bg, fg) >= min) return fg;
  const to = isDark(bg) ? '#FFFFFF' : '#000000';
  for (let t = 0.1; t <= 1.0001; t += 0.1) { const c = mix(fg, to, t); if (contrast(bg, c) >= min) return c; }
  return to;
}

/** the theme that shows now (`systemDark`: the device is set to dark; Auto follows it) */
export function themeOf(look: Look, systemDark: boolean): Theme {
  if (look.theme === 'custom') return { id: 'custom', name: 'My colours', bg: look.bg, fg: readable(look.bg, look.fg), dark: isDark(look.bg) };
  const id = look.theme === 'auto' ? (systemDark ? 'night' : 'paper') : look.theme;
  return THEMES.find((t) => t.id === id) ?? THEMES[1];
}

/** every colour of the page, from its two: quiet greys for the small things, one warm accent */
export function paletteOf(theme: Theme): Record<string, string> {
  const { bg, fg, dark } = theme;
  // (the accent and the two word marks are the one look's, design/theme.json)
  const t = dark ? TOKENS.dark : TOKENS.light;
  const accent = t.accent;
  return {
    '--bk-bg': bg, '--bk-fg': fg,
    '--bk-muted': mix(fg, bg, 0.42), '--bk-faint': mix(fg, bg, 0.66),
    '--bk-line': mix(fg, bg, 0.86), '--bk-soft': mix(fg, bg, 0.93),
    '--bk-raised': dark ? mix(bg, '#FFFFFF', 0.07) : mix(bg, '#FFFFFF', 0.55),
    '--bk-accent': readable(bg, accent, 3.2), '--bk-accent-soft': mix(readable(bg, accent, 3.2), bg, 0.82),
    '--bk-hard': t.hard, '--bk-learning': t.learning,
    '--bk-on-accent': t.accentText,
  };
}

/** the text's own CSS variables */
export function textVars(look: Look): Record<string, string> {
  const font = FONTS.find((f) => f.id === look.font) ?? FONTS[0];
  return {
    '--bk-font': font.css, '--bk-size': `${look.size}px`, '--bk-line-height': String(look.line), '--bk-margin': `${look.margin}px`,
    '--bk-letter': `${look.letter}em`, '--bk-word': `${look.word}em`, '--bk-para': `${look.para}em`,
    '--bk-align': look.align, '--bk-weight': look.bold ? '600' : '400',
  };
}

/** about how many letters fit on one line (a guide shown in the settings: 45 to 75 reads best) */
export function lettersPerLine(pageWidth: number, look: Look): number {
  const usable = Math.max(60, pageWidth - 2 * look.margin);
  const avg = look.size * (0.46 + look.letter);
  return Math.max(1, Math.round(usable / Math.max(1, avg)));
}

// ---- covers for books that have none -------------------------------------------------------------------------------
const COVER_INKS = ['#2F4858', '#5B3A29', '#3E4A3D', '#4A3F6B', '#7A3B3B', '#2E5E5A', '#6B5B2A', '#3A4F7A', '#5E2F4F', '#3F3F46'];
/** a calm cover from the title alone: one deep colour and a lighter band (the same title = the same cover) */
export function coverOf(title: string): { ink: string; band: string; initial: string } {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) { h ^= title.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const ink = COVER_INKS[h % COVER_INKS.length];
  return { ink, band: mix(ink, '#FFFFFF', 0.82), initial: (title.trim()[0] ?? 'B').toUpperCase() };
}
