import { describe, it, expect } from 'vitest';
import { readLook, DEFAULT_LOOK, THEMES, FONTS, contrast, readable, themeOf, paletteOf, textVars, lettersPerLine, coverOf, LIMITS } from '../src/book-look';

describe('I Know Book: the look of the page', () => {
  it('every ready theme can be read well (contrast 7:1 or more), and its small grey text too (3:1 or more)', () => {
    for (const t of THEMES) {
      expect(contrast(t.bg, t.fg), t.id).toBeGreaterThanOrEqual(7);
      const p = paletteOf(t);
      expect(contrast(t.bg, p['--bk-muted']), `${t.id} muted`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.bg, p['--bk-accent']), `${t.id} accent`).toBeGreaterThanOrEqual(3);
    }
  });
  it('what was saved is made safe: unknown values become the defaults, numbers stay inside their limits', () => {
    expect(readLook(null)).toEqual(DEFAULT_LOOK);
    const l = readLook({ theme: 'nope', font: 'comic', size: 500, line: 0.2, margin: -4, letter: 3, word: -3, align: 'centre', bg: 'red', bold: 'yes' });
    expect(l.theme).toBe('auto'); expect(l.font).toBe('charter');
    expect(l.size).toBe(LIMITS.size.max); expect(l.line).toBe(LIMITS.line.min); expect(l.margin).toBe(LIMITS.margin.min);
    expect(l.letter).toBe(LIMITS.letter.max); expect(l.word).toBe(LIMITS.word.min); expect(l.align).toBe('left'); expect(l.bg).toBe(DEFAULT_LOOK.bg); expect(l.bold).toBe(false);
    expect(readLook({ theme: 'sepia', font: 'georgia', size: 23, line: 1.7, align: 'justify', bold: true }).size).toBe(23);
  });
  it('Auto follows the device: the paper page by day, the night page when the device is dark', () => {
    expect(themeOf(DEFAULT_LOOK, false).id).toBe('paper');
    expect(themeOf(DEFAULT_LOOK, true).id).toBe('night');
    expect(themeOf({ ...DEFAULT_LOOK, theme: 'black' }, false).id).toBe('black');
  });
  it('my own colours: text too close to the page is moved until it can be read; the page colour is kept', () => {
    expect(readable('#FFFFFF', '#EEEEEE')).not.toBe('#EEEEEE');
    expect(contrast('#FFFFFF', readable('#FFFFFF', '#EEEEEE'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#101010', readable('#101010', '#202020'))).toBeGreaterThanOrEqual(4.5);
    expect(readable('#FAF6EC', '#23201A')).toBe('#23201A');
    const t = themeOf({ ...DEFAULT_LOOK, theme: 'custom', bg: '#102030', fg: '#203040' }, false);
    expect(t.bg).toBe('#102030'); expect(t.dark).toBe(true); expect(contrast(t.bg, t.fg)).toBeGreaterThanOrEqual(4.5);
  });
  it('the text settings become CSS: font, size, line height, margins, letter and word spacing', () => {
    const v = textVars({ ...DEFAULT_LOOK, font: 'charter', size: 22, line: 1.6, margin: 30, letter: 0.02, word: 0.1, bold: true, align: 'justify' });
    expect(v['--bk-font']).toMatch(/^Charter/); expect(v['--bk-size']).toBe('22px'); expect(v['--bk-line-height']).toBe('1.6'); expect(v['--bk-margin']).toBe('30px');
    expect(v['--bk-letter']).toBe('0.02em'); expect(v['--bk-word']).toBe('0.1em'); expect(v['--bk-weight']).toBe('600'); expect(v['--bk-align']).toBe('justify');
    expect(FONTS.every((f) => /serif|sans-serif/.test(f.css))).toBe(true);
  });
  it('the usual page on an iPhone has a comfortable line (about 35 to 45 letters), an iPad never an endless one', () => {
    const phone = lettersPerLine(390, DEFAULT_LOOK);
    expect(phone).toBeGreaterThanOrEqual(32); expect(phone).toBeLessThanOrEqual(48);
    expect(lettersPerLine(390, { ...DEFAULT_LOOK, margin: 60 })).toBeLessThan(phone);
  });
  it('a book without a cover gets a calm one from its title, always the same', () => {
    expect(coverOf('The Happy Prince')).toEqual(coverOf('The Happy Prince'));
    expect(coverOf('The Happy Prince').initial).toBe('T');
    expect(coverOf('').initial).toBe('B');
  });
});
