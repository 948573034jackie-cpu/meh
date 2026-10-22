import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Listening mode must stay cheap to paint while the voice reads (docs/HOW-IT-WORKS.md §4): the lines may only animate
 * their opacity, the spoken word is highlighted with paint-only properties, and nothing animates forever with a
 * property that repaints (box-shadow) or blurs what moves under it. Measured: renderer 18% of a core with the old
 * line transitions and bold word, 6% without them.
 */
const root = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule { selector: string; decls: Map<string, string> }

/** The innermost `selector { declarations }` blocks of a stylesheet (rules inside @media included, keyframe steps too). */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim());
    }
    out.push({ selector: m[1].trim().replace(/\s+/g, ' '), decls });
  }
  return out;
}

/** Every @keyframes block: name -> the properties its steps set. */
function keyframes(css: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
    const props = new Set<string>();
    for (const r of rules(m[2])) for (const k of r.decls.keys()) props.add(k);
    out.set(m[1], props);
  }
  return out;
}

const reader = rules(read('src/renderer/reader/reader.css'));
const main = rules(read('src/renderer/main.css'));
const voiceCss = read('src/renderer/voice/voice.css');

describe('Listening mode CSS stays paint-only', () => {
  it('the lines animate opacity only: no font-size, colour or background transition', () => {
    const lineRules = reader.filter((r) => r.selector.split(',').some((s) => /\.listen-lines \.s\b/.test(s)));
    expect(lineRules.length).toBeGreaterThan(0);
    for (const r of lineRules) {
      const t = r.decls.get('transition') ?? r.decls.get('transition-property') ?? '';
      expect(t, r.selector).not.toMatch(/font-size|font-weight|\bcolor\b|background|all\b|padding|margin|width|height/);
      expect(t === '' || /^opacity\b/.test(t), `${r.selector}: ${t}`).toBe(true);
    }
  });

  it('the spoken word is never made bold (bold re-lays out the line at every word)', () => {
    for (const r of [...reader, ...main].filter((x) => x.selector.includes('cur-w'))) {
      expect(r.decls.has('font-weight'), r.selector).toBe(false);
      expect(r.decls.has('font-size'), r.selector).toBe(false);
      expect(r.decls.has('letter-spacing'), r.selector).toBe(false);
    }
    // it still stands out: a colour and an underline
    const cur = reader.find((r) => r.selector === '.listen-lines .s.cur .w.cur-w');
    expect(cur?.decls.get('color')).toBeTruthy();
    expect(cur?.decls.get('text-decoration')).toMatch(/underline/);
  });

  it('the Listening bars have no backdrop blur', () => {
    for (const r of reader.filter((x) => /\.listen-(bottom|head)\b/.test(x.selector))) {
      expect(r.decls.has('backdrop-filter'), r.selector).toBe(false);
      expect(r.decls.has('-webkit-backdrop-filter'), r.selector).toBe(false);
    }
  });

  it('endless animations (the listening mic, dots, spinners) change only opacity and transform', () => {
    const all = [read('src/renderer/reader/reader.css'), read('src/renderer/main.css'), voiceCss].join('\n');
    const frames = keyframes(all);
    expect(frames.has('voice-pulse')).toBe(true);
    const infinite = rules(all).filter((r) => /infinite/.test(r.decls.get('animation') ?? ''));
    expect(infinite.some((r) => r.selector.includes('.voice-mic.on.listening'))).toBe(true);
    for (const r of infinite) {
      const name = (r.decls.get('animation') ?? '').split(/\s+/)[0];
      const props = frames.get(name);
      expect(props, `${r.selector}: keyframes ${name}`).toBeTruthy();
      for (const p of props!) expect(['opacity', 'transform'], `${name} animates ${p}`).toContain(p);
    }
  });
});
