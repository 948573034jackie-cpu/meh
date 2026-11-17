import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfTextBuilder, pagesToText, pdfPages, pdfToText, looksScanned, HOLD, AHEAD, type PdfItem, type PdfPage } from '../src/pdf-text';
import { pagesToText as fromReaderText, paragraphsOf } from '../src/reader-text';

// ---------------------------------------------------------------------------------------------------------------
// made-up pages: 400 x 600, text from x = 50 to 350, lines 12 apart from y = 540, letters 10 high and 5 wide

const SIZE = { width: 400, height: 600 };
const LEFT = 50, RIGHT = 350, TOP = 540, LEAD = 12, CH = 5;
interface Opt { h?: number; eol?: boolean; w?: number }
const item = (str: string, x: number, y: number, o: Opt = {}): PdfItem => { const h = o.h ?? 10; return { str, hasEOL: o.eol ?? true, transform: [h, 0, 0, h, x, y], height: h, width: o.w ?? str.length * h * 0.5 }; };
/** lines one under the other from the top: a string = a full line at the left edge, [text, x] = a line that starts at x */
const lines = (ls: (string | [string, number])[], top = TOP): PdfItem[] => ls.map((l, i) => (typeof l === 'string' ? item(l, LEFT, top - i * LEAD, { w: RIGHT - LEFT }) : item(l[0], l[1], top - i * LEAD)));
const texts = (blocks: readonly { text: string }[]): string[] => blocks.map((b) => b.text);
function build(pages: readonly PdfItem[][], size: { width?: number; height?: number } = SIZE): { kind: string; text: string; page: number }[] {
  const b = new PdfTextBuilder(), out = [];
  for (const p of pages) out.push(...b.addPage(p, size));
  out.push(...b.flush());
  return out;
}

/** made-up prose: `n` paragraphs of plain sentences (always the same for the same seed) */
function prose(n: number, seed = 7): string[] {
  const words = 'the old house stood at end of road and nobody went there any more because it was said that a strange light moved behind its windows when rain came over hills'.split(' ');
  let s = seed;
  const rnd = (k: number): number => { s = (s * 1103515245 + 12345) % 2147483648; return Math.floor((s / 2147483648) * k); };
  const sentence = (): string => { const w = Array.from({ length: 6 + rnd(9) }, () => words[rnd(words.length)]); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(' ')}.`; };
  return Array.from({ length: n }, () => Array.from({ length: 1 + rnd(6) }, sentence).join(' '));
}
function wrap(text: string, first: number, rest: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur && cur.length + 1 + w.length > (out.length ? rest : first)) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  out.push(cur);
  return out;
}
interface Setting { indent?: number; gap?: number; perPage?: number; head?: (page: number) => PdfItem | null; foot?: (page: number) => PdfItem | null }
/** paragraphs set like a book: justified lines, a first-line indent and / or a gap, running heads and feet */
function typeset(paras: readonly string[], o: Setting = {}): PdfItem[][] {
  const indent = o.indent ?? 12, gap = o.gap ?? 0, per = o.perPage ?? 20;
  const pages: PdfItem[][] = [[]];
  let y = TOP, n = 0;
  for (const p of paras) {
    const ls = wrap(p, (RIGHT - LEFT - indent) / CH, (RIGHT - LEFT) / CH);
    ls.forEach((l, i) => {
      if (n === per) { pages.push([]); y = TOP; n = 0; }
      if (i === 0 && n > 0) y -= gap;
      const x = LEFT + (i === 0 ? indent : 0);
      pages[pages.length - 1].push(item(l, x, y, { w: i === ls.length - 1 ? l.length * CH : RIGHT - x }));
      y -= LEAD; n++;
    });
  }
  return pages.map((body, i) => { const h = o.head?.(i + 1), f = o.foot?.(i + 1); return [...(h ? [h] : []), ...body, ...(f ? [f] : [])]; });
}

describe('PdfTextBuilder: paragraphs', () => {
  it('a book with first-line indents and no gaps: every paragraph is found', () => {
    const page = lines([
      ['The first paragraph starts with an indent and it goes', 62], 'on over a second line that is a full one, and then it', ['ends on a third.', LEFT],
      ['The second one has two lines, the first of them being', 62], ['full and this one short.', LEFT],
      ['“Did you see it?” he asked.', 62],
      ['“No.”', 62],
      ['A last paragraph follows the two short lines of talk', 62], ['and ends the page here.', LEFT],
    ]);
    expect(build([page])).toEqual([
      { kind: 'p', page: 1, text: 'The first paragraph starts with an indent and it goes on over a second line that is a full one, and then it ends on a third.' },
      { kind: 'p', page: 1, text: 'The second one has two lines, the first of them being full and this one short.' },
      { kind: 'p', page: 1, text: '“Did you see it?” he asked.' },
      { kind: 'p', page: 1, text: '“No.”' },
      { kind: 'p', page: 1, text: 'A last paragraph follows the two short lines of talk and ends the page here.' },
    ]);
  });

  it('a book set with indents comes back paragraph for paragraph, over 9 pages', () => {
    const paras = prose(60);
    const pages = typeset(paras);
    expect(pages.length).toBeGreaterThan(8);
    expect(texts(build(pages))).toEqual(paras);
    // (a small indent, and an indent with a gap too)
    expect(texts(build(typeset(paras, { indent: 6 })))).toEqual(paras);
    expect(texts(build(typeset(paras, { indent: 15, gap: 6 })))).toEqual(paras);
  });

  it('a book set with gaps between the paragraphs (no indent) comes back the same on one long page', () => {
    const paras = prose(12, 3);
    expect(texts(build(typeset(paras, { indent: 0, gap: 8, perPage: 1000 })))).toEqual(paras);
  });

  it('the normal line distance is the median: one tight pair of lines does not cut the page into lines', () => {
    const page = [
      item('The first line of a paragraph that goes on', LEFT, 540), item('over this line and the next one,', LEFT, 528),
      item('which sits a bit too close,', LEFT, 520), item('and this is its last line.', LEFT, 508),
      item('A second paragraph comes after a real gap', LEFT, 488), item('and has two lines.', LEFT, 476),
    ];
    expect(texts(build([page], {}))).toEqual([
      'The first line of a paragraph that goes on over this line and the next one, which sits a bit too close, and this is its last line.',
      'A second paragraph comes after a real gap and has two lines.',
    ]);
  });

  it('a block of lines that all start further right is one paragraph (no indent at every line)', () => {
    const page = lines([
      'A paragraph of the book that fills its lines from the left', ['edge and ends here:', LEFT],
      ['a quoted piece of text set further to the right, in', 80], ['lines that all start at the same place and end', 80], ['only with the last of them.', 80],
      'Then the book goes on at the left edge with a new and full', ['line and a short one.', LEFT],
    ]);
    expect(texts(build([page]))).toEqual([
      'A paragraph of the book that fills its lines from the left edge and ends here:',
      'a quoted piece of text set further to the right, in lines that all start at the same place and end only with the last of them.',
      'Then the book goes on at the left edge with a new and full line and a short one.',
    ]);
  });
});

describe('PdfTextBuilder: marks above the line, drop caps', () => {
  // (the items are what pdf.js really gives for such a line: see the same case on a real PDF below)
  it('a footnote mark stays in its line and the lines after it stay one paragraph', () => {
    const page = [
      item('The first claim', LEFT, 540, { eol: false }), item('1', 125, 544, { h: 6, eol: false }), { str: ' ', hasEOL: false, transform: [6, 0, 0, 6, 128, 544], height: 0, width: 3 },
      item('is made here and the line goes on', 131, 540),
      item('to its second line with a claim', LEFT, 528, { eol: false }), item('2', 205, 532, { h: 6, eol: false }), { str: '', hasEOL: true, transform: [10, 0, 0, 10, LEFT, 516], height: 0, width: 0 },
      item('and a third line, and a fourth', LEFT, 516), item('line that ends it all.', LEFT, 504),
    ];
    expect(texts(build([page]))).toEqual(['The first claim1 is made here and the line goes on to its second line with a claim2 and a third line, and a fourth line that ends it all.']);
  });

  it('also when pdf.js says "end of line" at the mark, with no space after it', () => {
    const page = [
      item('The first claim', LEFT, 540, { eol: false }), item('1', 125, 544, { h: 6, eol: true }), item('is made here and the line goes on', 131, 540),
      item('to its second line, and', LEFT, 528), item('to a third and a fourth', LEFT, 516), item('line that ends it all.', LEFT, 504),
    ];
    const got = build([page]);
    expect(texts(got)).toEqual(['The first claim1 is made here and the line goes on to its second line, and to a third and a fourth line that ends it all.']);
  });

  it('the old way (smallest distance) made a paragraph of every line after a mark: not any more, and a real gap still counts', () => {
    const page = [
      item('A line with a mark', LEFT, 540, { eol: false }), item('3', 140, 544, { h: 6 }),
      item('and five more lines', LEFT, 528), item('that belong to it', LEFT, 516), item('down to this one.', LEFT, 504),
      item('After a gap a new one', LEFT, 480), item('starts here.', LEFT, 468),
    ];
    expect(texts(build([page]))).toEqual(['A line with a mark3 and five more lines that belong to it down to this one.', 'After a gap a new one starts here.']);
  });

  it('a drop cap joins its word, and the lines beside it are no new paragraphs', () => {
    const page = [
      item('T', LEFT, 516, { h: 30, eol: false, w: 18 }), { str: ' ', hasEOL: false, transform: [30, 0, 0, 30, 68, 516], height: 0, width: 5 },
      item('he old house stood at the end of the road and', 73, 540, { w: RIGHT - 73 }), item('nobody went there any more, because it was', 73, 528, { w: RIGHT - 73 }), item('said that a strange light moved behind its', 73, 516, { w: RIGHT - 73 }),
      item('windows when the rain came over the hills at night.', LEFT, 504),
      item('The second paragraph has its indent as before and', 62, 492, { w: RIGHT - 62 }), item('ends here.', LEFT, 480),
    ];
    expect(texts(build([page]))).toEqual([
      'The old house stood at the end of the road and nobody went there any more, because it was said that a strange light moved behind its windows when the rain came over the hills at night.',
      'The second paragraph has its indent as before and ends here.',
    ]);
  });
});

describe('PdfTextBuilder: running heads, feet, page numbers, the page break', () => {
  const head = (n: number): PdfItem | null => (n === 1 ? null : n % 2 ? item(`Chapter One: The Start   ${n}`, 220, 572) : item(`${n}   The Great Book`, LEFT, 572));
  const foot = (n: number): PdfItem => item(n === 3 ? 'iii' : n % 5 === 0 ? `— ${n} —` : `${n}`, 195, 28);

  it('heads, feet and page numbers are dropped; the paragraphs are whole over every page break', () => {
    const paras = prose(110, 11);
    const pages = typeset(paras, { head, foot });
    expect(pages.length).toBeGreaterThanOrEqual(16);
    const got = build(pages);
    expect(texts(got)).toEqual(paras);
    const all = texts(got).join('\n');
    expect(all).not.toMatch(/Great Book|Chapter One|\d|—|\biii\b/);
  });

  it('a line at the top that is different on every page is text: it stays (not everything in the edge is dropped)', () => {
    const names = 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliett Kilo Lima Mike November Oscar Papa Quebec Romeo'.split(' ');
    const pages = typeset(prose(110, 11), { head: (n) => item(`${names[n - 1]} is the name of this page`, LEFT, 572) });
    expect(pages.length).toBeGreaterThanOrEqual(16);
    const all = texts(build(pages)).join('\n');
    for (const n of names.slice(0, pages.length)) expect(all).toContain(`${n} is the name of this page`);
  });

  it('a head must be on 3 pages near each other; a line in the body is never dropped', () => {
    const body = (n: number): PdfItem[] => lines([`${'ABCD'[n - 1]} begins a page with this full line of its own text and`, ['ends with a short one.', LEFT], ['12', LEFT], ['The Great Book', LEFT]]);
    // (the head is on pages 1 and 2 only; "12" and "The Great Book" are also lines in the middle of every page)
    const pages = [1, 2, 3, 4].map((n) => [...(n < 3 ? [item('A Rare Head', LEFT, 572)] : []), ...body(n), item(`${n}`, 195, 28)]);
    const all = texts(build(pages)).join('\n');
    expect(all).toMatch(/A Rare Head/);
    expect(all.match(/The Great Book/g)?.length).toBe(4);
    expect(all.match(/\b12\b/g)?.length).toBe(4);
    expect(all).not.toMatch(/\b[1-4]\b/);
  });

  it('a sentence that goes on over the page break stays one paragraph (page numbers between)', () => {
    const one = [...lines(['The paragraph at the end of the first page has a sentence', 'that does not end with the page but goes on and on']), item('17', 195, 28)];
    const two = [item('18', 195, 572), ...lines(['over to the next page, where it ends at last.', ['A new paragraph follows it there.', 62]])];
    expect(build([one, two])).toEqual([
      { kind: 'p', page: 1, text: 'The paragraph at the end of the first page has a sentence that does not end with the page but goes on and on over to the next page, where it ends at last.' },
      { kind: 'p', page: 2, text: 'A new paragraph follows it there.' },
    ]);
  });

  it('a page that ends with a full stop: an indent on the next page is a new paragraph, no indent goes on', () => {
    const end = lines([['A paragraph that ends with the page and whose last', 62], 'lines are a full one that runs to the right edge and a', ['third that is a short one.', LEFT]]);
    const full = lines([['A paragraph with a sentence that fills the last line', 62], 'of its page, which is the third of three lines here, and', 'runs right to the edge, where it ends, just like this.']);
    expect(texts(build([end, lines([['The next page starts a new one.', 62]])]))).toEqual(['A paragraph that ends with the page and whose last lines are a full one that runs to the right edge and a third that is a short one.', 'The next page starts a new one.']);
    expect(texts(build([end, lines([['The next page starts at the left edge, after a short line.', LEFT]])])).length).toBe(2);
    expect(texts(build([full, lines(['It goes on here with a new sentence of the same paragraph,', ['and ends.', LEFT]])]))).toEqual(['A paragraph with a sentence that fills the last line of its page, which is the third of three lines here, and runs right to the edge, where it ends, just like this. It goes on here with a new sentence of the same paragraph, and ends.']);
  });

  it('a word cut with a hyphen is joined: in a page, over a page break, a soft hyphen; a real hyphen stays', () => {
    const one = lines(['This is an exam-', ['ple of a well-known thing: a word cut in two, an Anglo-', LEFT], ['Saxon one, a co\u00AD', LEFT], ['operation, and a well-', LEFT], ['known one, cut at the end of the page, which is a prob-', LEFT]]);
    const two = lines([['lem no more.', LEFT]]);
    expect(texts(build([one, two]))).toEqual(['This is an example of a well-known thing: a word cut in two, an Anglo-Saxon one, a cooperation, and a well-known one, cut at the end of the page, which is a problem no more.']);
  });
});

describe('PdfTextBuilder: headings', () => {
  const body = ['The text of the chapter starts here with a full line and it', 'goes on for a second full line of words that mean little,', ['and then it ends.', LEFT]] as (string | [string, number])[];

  it('a line clearly bigger than the body text is a heading; two such lines are one', () => {
    const page = [item('The River Bank', 120, 540, { h: 18 }), ...lines(body, 510), item('A Much Longer Title That', 80, 440, { h: 16 }), item('Needs Two Lines', 110, 420, { h: 16 }), ...lines(body, 390)];
    expect(build([page]).map((b) => [b.kind, b.text])).toEqual([
      ['h2', 'The River Bank'], ['p', body.map((l) => (typeof l === 'string' ? l : l[0])).join(' ')],
      ['h2', 'A Much Longer Title That Needs Two Lines'], ['p', body.map((l) => (typeof l === 'string' ? l : l[0])).join(' ')],
    ]);
  });

  it('"Chapter 3", "CHAPTER III", "Part Two" in the body size are headings; a sentence that starts so is not', () => {
    const text = body.map((l) => (typeof l === 'string' ? l : l[0])).join(' ');
    const page = [
      item('Chapter 3', 170, 540), ...lines(body, 516),
      item('CHAPTER III', 165, 468), ...lines(body, 444),
      item('Part Two', 175, 396), ...lines(['Part two of the plan was that he would go there in the night', ['and look for himself.', LEFT]], 372),
      item('Chapter 4: The Road Home', 140, 336), ...lines(body, 312),
    ];
    expect(build([page]).map((b) => [b.kind, b.text])).toEqual([
      ['h2', 'Chapter 3'], ['p', text], ['h2', 'CHAPTER III'], ['p', text],
      ['h2', 'Part Two'], ['p', 'Part two of the plan was that he would go there in the night and look for himself.'],
      ['h2', 'Chapter 4: The Road Home'], ['p', text],
    ]);
  });

  it('text set in big letters (more than three lines of it) is text, not a heading', () => {
    const big = ['A whole paragraph that is', 'set in bigger letters than', 'the rest of the book, line', 'after line, to the end.'];
    const page = [...big.map((t, i) => item(t, LEFT, 540 - i * 18, { h: 15 })), ...lines(body, 450), ...lines(body, 400), ...lines(body, 350)];
    const got = build([page]);
    expect([got[0].kind, got[0].text]).toEqual(['p', big.join(' ')]);
    expect(got.filter((b) => b.kind === 'h2')).toEqual([]);
  });
});

describe('PdfTextBuilder: two columns', () => {
  it('two clear columns are read left first, then right, also when the PDF gives them line by line', () => {
    const left = ['The left column starts here', 'and it has ten lines in all', 'which run down the page as', 'they should, one after the', 'other, and none of them is', 'to be mixed with the words', 'that stand beside them, in', 'the other column, which is', 'a text of its own until we', 'reach the last line, where'];
    const right = ['the sentence goes on at the', 'top of the right column and', 'ends there. The right column', 'has ten lines too, they come', 'after all the lines of the', 'left one, and they are read', 'down to the bottom, to this', 'last sentence of the page,', 'which is a short one and so', 'it ends the paragraph.'];
    const page = left.flatMap((l, i) => [item(l, 30, 540 - i * LEAD, { w: 160, eol: false }), item(right[i], 210, 540 - i * LEAD, { w: 160 })]);
    expect(texts(build([[item('A Title Over Both Columns Of The Page, From Side To Side', 30, 566, { w: 340 }), ...page, item('4', 198, 28)]]))).toEqual(['A Title Over Both Columns Of The Page, From Side To Side', `${left.join(' ')} ${right.join(' ')}`]);
  });

  it('one column with a list of numbers at its right (a contents page) is left as it is', () => {
    const page = Array.from({ length: 14 }, (_, i) => [item(`The name of chapter ${i + 1}`, LEFT, 540 - i * LEAD, { eol: false }), item(`${i * 12 + 3}`, 330, 540 - i * LEAD)]).flat();
    expect(texts(build([page])).join(' ')).toMatch(/^The name of chapter 1\s*3 The name of chapter 2\s*15 /);
  });
});

describe('PdfTextBuilder: page by page', () => {
  it('holds the first pages back, gives finished paragraphs only, and the same text as all at once', () => {
    const paras = prose(140, 5);
    const pages = typeset(paras, { foot: (n) => item(`${n}`, 195, 28) });
    expect(pages.length).toBeGreaterThan(HOLD + AHEAD);
    const b = new PdfTextBuilder();
    const got: string[] = [];
    const sizes: number[] = [];
    pages.forEach((p, i) => {
      const blocks = b.addPage(p, SIZE);
      sizes.push(blocks.length);
      // (nothing from a page that is less than AHEAD pages back; nothing at all before page HOLD)
      for (const k of blocks) expect(k.page).toBeLessThanOrEqual(i + 1 - AHEAD);
      got.push(...texts(blocks));
      // (what was given is final: always the first paragraphs of the book, whole)
      expect(got).toEqual(paras.slice(0, got.length));
    });
    expect(sizes.slice(0, HOLD - 1).every((n) => n === 0)).toBe(true);
    expect(sizes[HOLD - 1]).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(paras.length);
    got.push(...texts(b.flush()));
    expect(got).toEqual(paras);
    expect(b.flush()).toEqual([]);
    expect(b.pages).toBe(pages.length);
    expect(b.chars).toBe(pages.flat().reduce((n, x) => n + x.str.replace(/\s/g, '').length, 0));
  });

  it('pagesToText (the old call, items only) still gives paragraphs with an empty line between', () => {
    const old = (str: string, y: number): PdfItem => ({ str, transform: [1, 0, 0, 1, 0, y], hasEOL: true });
    const text = pagesToText([[old('First line of', 700), old('the paragraph.', 686), old('Second paragraph starts', 650), old('and goes on to the', 636)], [old('next page here.', 700)]]);
    expect(text).toBe('First line of the paragraph.\n\nSecond paragraph starts and goes on to the next page here.');
    expect(paragraphsOf(text)).toEqual(['First line of the paragraph.', 'Second paragraph starts and goes on to the next page here.']);
    expect(fromReaderText).toBe(pagesToText);
  });
});

describe('scans', () => {
  it('looksScanned: most of the first 10 pages have no text', () => {
    expect(looksScanned(Array(10).fill(0))).toBe(true);
    expect(looksScanned([0, 3, 0, 0, 19, 0, 0, 0, 2400, 1800])).toBe(true);
    // (not known yet: fewer than 10 pages read)
    expect(looksScanned(Array(9).fill(0))).toBe(false);
    // (a real book: cover, empty pages, a short title, then text)
    expect(looksScanned([0, 0, 16, 0, 45, 600, 12, 0, 300, 0])).toBe(false);
    expect(looksScanned([1500, 1400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(true);
    expect(looksScanned([900, 1400, 1200, 0, 0, 1300, 1100, 0, 0, 0])).toBe(false);
    // (a short file: all its pages)
    expect(looksScanned([0, 0, 0], 3)).toBe(true);
    expect(looksScanned([0, 0], 3)).toBe(false);
    expect(looksScanned([0, 0, 500], 3)).toBe(false);
    expect(looksScanned([], 0)).toBe(false);
  });

  it('the builder counts the pages without text and the pages that failed', () => {
    const b = new PdfTextBuilder();
    b.addPage([], SIZE);
    b.addPage([{ str: ' ', transform: [10, 0, 0, 10, 50, 500] }, { str: '', hasEOL: true, transform: [10, 0, 0, 10, 50, 488] }], SIZE);
    b.addPage(lines(['One page with a line of text.']), SIZE);
    const failed: PdfPage = { page: 4, pages: 4, items: [], width: 0, height: 0, chars: 0, failed: true };
    b.add(failed);
    expect(texts(b.flush())).toEqual(['One page with a line of text.']);
    expect([b.pages, b.emptyPages, b.failedPages]).toEqual([4, 2, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// pdf.js itself, on small real PDFs written here by hand (no file, no network)

/** `contents` = the drawing commands of each page (Helvetica as /F1) */
function makePdf(contents: string[], o: { box?: string; page?: (i: number) => string; bad?: number } = {}): Uint8Array {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${contents.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${contents.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  contents.forEach((text, i) => {
    // (`bad`: this page is a branch of the page tree whose only leaf is the number 42: the file opens, the page throws)
    if (i === o.bad) { objs.push(`<< /Type /Pages /Parent 2 0 R /Kids [${5 + i * 2} 0 R] /Count 1 >>`, '42'); return; }
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${o.box ?? '0 0 612 792'}] ${o.page?.(i) ?? ''} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const at: number[] = [];
  objs.forEach((obj, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
/** lines of text from (72, 700) down, 12 apart */
const pageOf = (ls: string[]): string => (ls.length ? `BT /F1 10 Tf 72 700 Td ${ls.map((l) => `(${l}) Tj 0 -12 Td`).join(' ')} ET` : '');
async function all(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfPage[]> {
  const out: PdfPage[] = [];
  for await (const p of pdfPages(bytes, { signal })) out.push(p);
  return out;
}

describe('pdfPages (pdf.js on PDFs written by hand)', () => {
  // (pdf.js writes its warnings with console.log: "use the legacy build in Node", "standardFontDataUrl")
  let quiet: ReturnType<typeof vi.spyOn>;
  beforeAll(() => { quiet = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterAll(() => { quiet.mockRestore(); });

  it('gives every page with its items, size and letters; an empty page too; takes the bytes over without a copy', async () => {
    const bytes = makePdf([pageOf(['First page, line one.', 'Line two.']), '', pageOf(['Third page.'])]);
    const buffer = bytes.buffer;
    const got = await all(bytes);
    expect(got.map((p) => [p.page, p.pages, p.width, p.height, p.chars, p.items.map((i) => i.str).filter(Boolean)])).toEqual([
      [1, 3, 612, 792, 26, ['First page, line one.', 'Line two.']], [2, 3, 612, 792, 0, []], [3, 3, 612, 792, 10, ['Third page.']],
    ]);
    expect(got[0].items[0].transform.slice(4)).toEqual([72, 700]);
    expect(got[0].items[0].height).toBe(10);
    expect(got[0].items[0].width).toBeGreaterThan(50);
    expect(got.some((p) => p.failed || p.scan)).toBe(false);
    // (the buffer went to pdf.js: nothing of the file is left here, so no second copy was made)
    expect(buffer.byteLength).toBe(0);
  });

  it('a page that cannot be read is given as failed and the pages after it still come', async () => {
    const got = await all(makePdf([pageOf(['One.']), pageOf(['Two.']), pageOf(['Three.'])], { bad: 1 }));
    expect(got.map((p) => [p.page, !!p.failed, p.chars])).toEqual([[1, false, 4], [2, true, 0], [3, false, 6]]);
    const b = new PdfTextBuilder();
    for (const p of got) b.add(p);
    expect(texts(b.flush())).toEqual(['One.', 'Three.']);
    expect([b.pages, b.emptyPages, b.failedPages]).toEqual([3, 0, 1]);
  });

  it('other tasks get their turn between two pages', async () => {
    const bytes = makePdf(Array.from({ length: 8 }, (_, i) => pageOf([`Page ${i + 1}.`])));
    let ticks = 0, on = true;
    const spin = (): void => { ticks++; if (on) setImmediate(spin); };
    spin();
    const seen: number[] = [];
    for await (const p of pdfPages(bytes)) { seen.push(ticks); expect(p.chars).toBeGreaterThan(0); }
    on = false;
    expect(seen.length).toBe(8);
    // (a task that was waiting ran between every two pages: the page loop is not one long task)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
  });

  it('a long page is read in pieces with turns between them, and nothing is lost', async () => {
    const long = Array.from({ length: 50 }, (_, i) => `Line ${i + 1} of a long page.`);
    // (every look at the clock is 100 ms later: the builder must take a turn at each piece)
    let t = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (t += 100));
    try {
      const got = await all(makePdf([pageOf(long), pageOf(['Last.'])]));
      expect(got[0].items.map((i) => i.str).filter(Boolean)).toEqual(long);
      expect(got[1].chars).toBe(5);
    } finally { clock.mockRestore(); }
  });

  it('stops when the signal says so', async () => {
    const pdf = (): Uint8Array => makePdf(Array.from({ length: 6 }, (_, i) => pageOf([`Page ${i + 1}.`])));
    const ctl = new AbortController();
    const got: number[] = [];
    for await (const p of pdfPages(pdf(), { signal: ctl.signal })) { got.push(p.page); if (p.page === 2) ctl.abort(); }
    expect(got).toEqual([1, 2]);
    const before = new AbortController();
    before.abort();
    expect(await all(pdf(), before.signal)).toEqual([]);
    // (leaving the loop early is fine too, and the next file still opens)
    for await (const p of pdfPages(pdf())) { if (p.page === 3) break; }
    expect((await all(pdf())).length).toBe(6);
  });

  it('a file that is no PDF throws', async () => {
    await expect(all(new TextEncoder().encode('this is not a pdf at all'))).rejects.toThrow();
  });

  it('pictures of pages: "scan" is said at page 10, after a look at the rest of the file', async () => {
    const scan = await all(makePdf(Array.from({ length: 30 }, () => '')));
    expect(scan.filter((p) => p.scan).map((p) => p.page)).toEqual([10]);
    // (a cover page with text in front of a scan: still a scan)
    const cover = await all(makePdf(Array.from({ length: 30 }, (_, i) => (i === 0 ? pageOf(['Got from a library. Terms of use and so on.']) : ''))));
    expect(cover.filter((p) => p.scan).map((p) => p.page)).toEqual([10]);
    // (ten empty pages and then a real book: no scan)
    const book = await all(makePdf(Array.from({ length: 30 }, (_, i) => (i < 10 ? '' : pageOf([`Page ${i + 1} has a line of real text.`])))));
    expect(book.some((p) => p.scan)).toBe(false);
    expect(book.length).toBe(30);
    // (a short file without any text)
    const short = await all(makePdf(['', '', '']));
    expect(short.map((p) => !!p.scan)).toEqual([false, false, true]);
    expect(await pdfToText(makePdf(Array.from({ length: 30 }, () => '')))).toBe('');
  });

  it('a page box that does not start at 0 and a page shown turned: the places are those of the page as it is seen', async () => {
    const moved = await all(makePdf(['BT /F1 10 Tf 172 800 Td (Moved box) Tj ET'], { box: '100 100 712 892' }));
    expect([moved[0].width, moved[0].height]).toEqual([612, 792]);
    expect(moved[0].items[0].transform.slice(4).map(Math.round)).toEqual([72, 700]);
    // (the page is shown turned by 90 degrees and its text is written turned, so it reads upright)
    const turned = await all(makePdf(['BT /F1 10 Tf 0 1 -1 0 300 72 Tm (Sideways line one) Tj 0 1 -1 0 312 72 Tm (Sideways line two) Tj ET'], { page: () => '/Rotate 90' }));
    expect([turned[0].width, turned[0].height]).toEqual([792, 612]);
    expect(turned[0].items.filter((i) => i.str).map((i) => [i.str, ...i.transform.slice(4).map(Math.round)])).toEqual([['Sideways line one', 72, 312], ['Sideways line two', 72, 300]]);
    const b = new PdfTextBuilder();
    expect(texts([...b.add(turned[0]), ...b.flush()])).toEqual(['Sideways line one Sideways line two']);
  });

  it('the PDFs of the browser tests (the older reader page) still give every sentence, in order, nothing else', async () => {
    // (tests/level-check-e2e.js and tests/safari-tutor-webkit-test.js make these files and count the sentences on the page)
    const tl = (ls: string[]): string => `BT /F1 12 Tf 72 720 Td 14 TL ${ls.map((l) => (l === '' ? 'T*' : `(${l}) Tj T*`)).join(' ')} ET`;
    const two = [
      ['My friend was very meticulous about her work, and she', 'checked it twice.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', '', 'The children played in the garden after school.', 'My uncle is an obsequious man who', 'loves big parties.'],
      ['We had a nice dinner with our family.', 'The ubiquitous noise made him feel pensive.', 'The bad man did threaten them with violence.', 'We will talk about it again very soon.'],
    ];
    const sentences = ['My friend was very meticulous about her work, and she checked it twice.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', 'The children played in the garden after school.', 'My uncle is an obsequious man who loves big parties.', 'We had a nice dinner with our family.', 'The ubiquitous noise made him feel pensive.', 'The bad man did threaten them with violence.', 'We will talk about it again very soon.'];
    expect(paragraphsOf(await pdfToText(makePdf(two.map(tl)))).join(' ')).toBe(sentences.join(' '));
    const one = ['My friend was very meticulous about her work.', 'She walked to the shop and bought some bread.', 'It was a lugubrious moment of joy.', 'The children played in the garden after school.', 'We will talk about it again very soon.', 'My uncle is an obsequious man.'];
    expect(paragraphsOf(await pdfToText(makePdf([tl(one)]))).join(' ')).toBe(one.join(' '));
  });

  it('pdf.js and the builder together: a mark above the line, a drop cap, a page number, a word cut in two', async () => {
    const mark = 'BT /F1 10 Tf 72 700 Td (The first claim) Tj /F1 6 Tf 4 Ts (1) Tj /F1 10 Tf 0 Ts ( is made here and the line goes on) Tj 0 -12 Td (to its second line with a claim) Tj /F1 6 Tf 4 Ts (2) Tj /F1 10 Tf 0 Ts 0 -12 Td (and a third line that is cut at an exam-) Tj ET BT /F1 10 Tf 300 40 Td (7) Tj ET';
    // (the way TeX writes: every piece is placed, there are no space characters)
    const placed = 'BT /F1 10 Tf 1 0 0 1 300 750 Tm (8) Tj 1 0 0 1 72 700 Tm (ple) Tj 1 0 0 1 90 700 Tm (of) Tj 1 0 0 1 102 700 Tm (a) Tj 1 0 0 1 110 700 Tm (claim) Tj /F1 6 Tf 1 0 0 1 134 704 Tm (3) Tj /F1 10 Tf 1 0 0 1 141 700 Tm (and) Tj 1 0 0 1 160 700 Tm (its) Tj 1 0 0 1 174 700 Tm (end.) Tj ET';
    const cap = 'BT /F1 30 Tf 1 0 0 1 72 676 Tm (T) Tj /F1 10 Tf 1 0 0 1 95 700 Tm (he old house stood at the end of) Tj 1 0 0 1 95 688 Tm (the road, and for years nobody) Tj 1 0 0 1 95 676 Tm (went there any more, because) Tj 1 0 0 1 72 664 Tm (of the light behind its windows.) Tj ET';
    const b = new PdfTextBuilder(), out = [];
    for await (const p of pdfPages(makePdf([mark, placed, cap]))) out.push(...b.add(p));
    out.push(...b.flush());
    expect(texts(out)).toEqual([
      'The first claim1 is made here and the line goes on to its second line with a claim2 and a third line that is cut at an example of a claim3 and its end.',
      'The old house stood at the end of the road, and for years nobody went there any more, because of the light behind its windows.',
    ]);
    expect(await pdfToText(makePdf([mark, placed, cap]))).toBe(texts(out).join('\n\n'));
  });
});
