import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TOKENS, THEME_CSS, THEME_HOST_CSS, TYPE, CONTROL } from '../src/theme';
import { contrast } from '../src/book-look';

const repo = path.resolve(__dirname, '../..');
type Gen = { stale(): string[]; renderAll(): Record<string, string> };
const generator = (): Promise<Gen> => import(/* @vite-ignore */ path.join(repo, 'scripts/make-theme.mjs')) as Promise<Gen>;

describe('the one look (design/theme.json)', () => {
  it('the generated files (theme.css, theme.ts, Theme.swift) are up to date with design/theme.json', async () => {
    const gen = await generator();
    expect(gen.stale(), 'run: node scripts/make-theme.mjs').toEqual([]);
    expect(fs.readFileSync(path.join(repo, 'dream-ext/static/theme.css'), 'utf8')).toBe(THEME_CSS);
  });
  it('every page links theme.css before its own styles, and the iPhone app gets it', () => {
    for (const f of ['book.html', 'options.html', 'vocab.html', 'reader.html']) {
      const html = fs.readFileSync(path.join(repo, 'dream-ext/static', f), 'utf8');
      const at = html.indexOf('href="theme.css"');
      expect(at, f).toBeGreaterThan(0);
      const own = [html.indexOf('href="pages.css"'), html.indexOf('<style')].filter((i) => i >= 0);
      for (const i of own) expect(at, `${f}: theme.css first`).toBeLessThan(i);
    }
    expect(fs.readFileSync(path.join(repo, 'ios/sync-scripts.sh'), 'utf8')).toMatch(/ theme\.css /);
    // (the Xcode project takes every Swift file of the YTLearn folder: Theme.swift is in it)
    expect(fs.readFileSync(path.join(repo, 'ios/project.yml'), 'utf8')).toMatch(/- path: YTLearn\n/);
    expect(fs.existsSync(path.join(repo, 'ios/YTLearn/Theme.swift'))).toBe(true);
  });
  it('text can be read in light and dark: body, muted and accent text 4.5:1 or more on every surface (WCAG AA)', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const t = TOKENS[scheme];
      for (const surface of [t.bg, t.raised, t.sunken]) {
        for (const ink of [t.text, t.muted, t.accent, t.on, t.off]) expect(contrast(surface, ink), `${scheme} ${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(surface, t.faint), `${scheme} faint`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(t.accentSoft, t.accent), `${scheme} chosen option`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.accent, t.accentText), `${scheme} main button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.on, t.onText), `${scheme} on button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.off, t.offText), `${scheme} off button`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('one warm accent, no iOS blue; big readable sizes; 44 pt buttons', () => {
    expect(TOKENS.light.accent).toBe('#9A5B1E'); expect(TOKENS.dark.accent).toBe('#D9A066');
    const all = JSON.stringify(TOKENS).toUpperCase() + THEME_CSS.toUpperCase();
    for (const blue of ['#007AFF', '#0A84FF', '#1A73E8', '#0B57D0']) expect(all).not.toContain(blue);
    expect(TYPE.body).toBe(17); expect(TYPE.caption).toBe(13); expect(TYPE.button).toBe(17);
    expect(Math.min(...Object.values(TYPE))).toBe(13);
    expect(CONTROL.min).toBe(44); expect(CONTROL.main).toBe(52);
    // the shadow-root variant follows the device and the tutor's own Day / Night choice
    expect(THEME_HOST_CSS).toMatch(/:host\(\[data-look="night"\]\)/); expect(THEME_HOST_CSS).toMatch(/prefers-color-scheme: dark/);
  });
});
