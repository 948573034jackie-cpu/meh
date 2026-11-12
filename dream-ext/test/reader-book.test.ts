import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createSegmenter } from '@core/segment';
import { realDictionary } from './helpers';
import { parseEpub, htmlToBlocks, decodeEntities, attrsOf, resolvePath, LockedBookError, LOCKED_MESSAGE } from '../src/epub';
import { shelfOf, percentOf, sortShelf, charsOf } from '../src/book-store';
import { rawFromPlain, rawFromTextFile, chapterOf, charsBefore } from '../src/reader-text';
import { markOf, difficultyOf, cardOf, isWordToken } from '../src/word-level';

const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Tiny &amp; Brave Book</dc:title><dc:creator opf:role="aut">Ann Writer</dc:creator><dc:language>en</dc:language></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="pic" href="images/a.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx"><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
const NCX = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
<navPoint id="n1" playOrder="1"><navLabel><text>One: The Start</text></navLabel><content src="text/ch%201.xhtml"/>
  <navPoint id="n1a" playOrder="2"><navLabel><text>A part inside</text></navLabel><content src="text/ch%201.xhtml#p2"/></navPoint></navPoint>
<navPoint id="n2" playOrder="3"><navLabel><text>Two: The End</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
</navMap></ncx>`;
const page = (body: string) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>ignored title</title><style>p{color:red}</style></head><body>${body}</body></html>`;
const CH1 = page(`<h1>Chapter One</h1><div class="x"><p>My friend was very <i>meticulous</i> about her work. She said &ldquo;hello&rdquo; &amp; left.</p>
<p id="p2">It was a <b>lugu</b>brious<br/>moment&#8212;of joy.</p></div><ul><li>First thing</li><li>Second thing</li></ul><script>alert(1)</script><!-- a note --><blockquote><p>Quoted words.</p></blockquote>`);
const CH2 = page(`<h2>The second one</h2><p>We will talk about it again very soon.</p><p>   </p>`);
const COVER = page(`<div><img src="../images/a.png" alt="cover"/></div>`);
const files = (extra: Record<string, string> = {}, drop: string[] = []): Uint8Array => {
  const all: Record<string, string> = {
    mimetype: 'application/epub+zip', 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': OPF, 'OEBPS/toc.ncx': NCX,
    'OEBPS/text/cover.xhtml': COVER, 'OEBPS/text/ch 1.xhtml': CH1, 'OEBPS/text/ch2.xhtml': CH2, 'OEBPS/images/a.png': 'not really a picture', ...extra,
  };
  for (const d of drop) delete all[d];
  return zipSync(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, strToU8(v)])));
};

describe('an EPUB book', () => {
  it('opens: title, writer, the chapters in reading order with their titles, the text as paragraphs', () => {
    const b = parseEpub(files());
    expect(b.title).toBe('The Tiny & Brave Book');
    expect(b.author).toBe('Ann Writer');
    // (the cover page has no text: it is no chapter)
    expect(b.chapters.map((c) => c.title)).toEqual(['One: The Start', 'Two: The End']);
    expect(b.chapters[0].blocks).toEqual([
      { kind: 'h1', text: 'Chapter One' },
      { kind: 'p', text: 'My friend was very meticulous about her work. She said “hello” & left.' },
      { kind: 'p', text: 'It was a lugubrious moment—of joy.' },
      { kind: 'li', text: 'First thing' }, { kind: 'li', text: 'Second thing' },
      { kind: 'blockquote', text: 'Quoted words.' },
    ]);
    expect(b.chapters[1].blocks).toEqual([{ kind: 'h2', text: 'The second one' }, { kind: 'p', text: 'We will talk about it again very soon.' }]);
  });

  it('EPUB 3: the titles come from the nav file, which is no chapter itself; without a table of contents, from the first heading', () => {
    const nav = page(`<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="text/ch%201.xhtml">Beginning</a></li><li><a href="text/ch2.xhtml#x"><span>Ending</span></a></li></ol></nav>`);
    const opf3 = OPF.replace('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>', '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>').replace('<spine toc="ncx">', '<spine><itemref idref="nav"/>');
    const b = parseEpub(files({ 'OEBPS/content.opf': opf3, 'OEBPS/nav.xhtml': nav }, ['OEBPS/toc.ncx']));
    expect(b.chapters.map((c) => c.title)).toEqual(['Beginning', 'Ending']);
    const none = parseEpub(files({ 'OEBPS/content.opf': OPF.replace('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>', '').replace(' toc="ncx"', '') }, ['OEBPS/toc.ncx']));
    expect(none.chapters.map((c) => c.title)).toEqual(['Chapter One', 'The second one']);
  });

  it('a locked book (DRM) is refused with plain words; scrambled fonts alone are no lock', () => {
    const lock = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/text/ch2.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`;
    expect(() => parseEpub(files({ 'META-INF/encryption.xml': lock }))).toThrow(LockedBookError);
    expect(() => parseEpub(files({ 'META-INF/rights.xml': '<rights/>' }))).toThrow(LOCKED_MESSAGE);
    expect(() => parseEpub(files({ 'META-INF/sinf.xml': '<sinf/>' }))).toThrow(/locked/i);
    expect(LOCKED_MESSAGE).toMatch(/Kindle or Apple Books are locked and cannot be opened/);
    const fonts = lock.replace('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'http://www.idpf.org/2008/embedding').replace('OEBPS/text/ch2.xhtml', 'OEBPS/fonts/a.otf');
    expect(parseEpub(files({ 'META-INF/encryption.xml': fonts })).chapters.length).toBe(2);
  });

  it('a file that is no EPUB, or one without text, says so', () => {
    expect(() => parseEpub(strToU8('just some text, not a zip'))).toThrow(/not an EPUB/);
    expect(() => parseEpub(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow(/not an EPUB/);
    expect(() => parseEpub(files({ 'OEBPS/text/ch 1.xhtml': page('<p> </p>'), 'OEBPS/text/ch2.xhtml': page('') }))).toThrow(/No readable text/);
  });

  it('the small helpers', () => {
    expect(decodeEntities('a&nbsp;b &#233; &#xE9; &unknown; &lt;')).toBe('a b é é &unknown; <');
    expect(attrsOf(`<item id="a" href='b c.xhtml' opf:role="x">`)).toMatchObject({ id: 'a', href: 'b c.xhtml', role: 'x' });
    expect(resolvePath('OEBPS/text', '../images/a%20b.png#x')).toBe('OEBPS/images/a b.png');
    expect(resolvePath('', 'ch1.xhtml')).toBe('ch1.xhtml');
    expect(htmlToBlocks('<p>One<br>two</p>plain tail<h4>Small head</h4><td>cell</td>')).toEqual([{ kind: 'p', text: 'One two' }, { kind: 'p', text: 'plain tail' }, { kind: 'h3', text: 'Small head' }, { kind: 'p', text: 'cell' }]);
  });
});

describe('the library', () => {
  const raw = { title: 'T', author: '', chapters: [{ title: 'A', blocks: [{ kind: 'p' as const, text: 'x'.repeat(100) }] }, { title: 'B', blocks: [{ kind: 'p' as const, text: 'y'.repeat(300) }] }] };
  it('a new book: at its start, 0 %', () => {
    const s = shelfOf('id1', 'epub', raw, '2026-11-12T00:00:00.000Z');
    expect(s).toMatchObject({ id: 'id1', kind: 'epub', title: 'T', chapterChars: [100, 300], chapterTitles: ['A', 'B'], place: { chapter: 0, paragraph: 0, sentence: 0 }, percent: 0 });
    expect(charsOf(raw.chapters[1])).toBe(300);
  });
  it('how far: the letters before the place over all the letters', () => {
    expect(percentOf([100, 300], 0, 0)).toBe(0);
    expect(percentOf([100, 300], 0, 50)).toBe(13);
    expect(percentOf([100, 300], 1, 0)).toBe(25);
    expect(percentOf([100, 300], 1, 300)).toBe(100);
    expect(percentOf([100, 300], 1, 9999)).toBe(100);
    expect(percentOf([], 0, 0)).toBe(0);
  });
  it('the book opened last comes first', () => {
    const a = { ...shelfOf('a', 'text', raw, '2026-11-01T00:00:00.000Z') }, b = { ...shelfOf('b', 'text', raw, '2026-11-05T00:00:00.000Z') };
    expect(sortShelf([a, b]).map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('a pasted text is one chapter, every paragraph as it is; a chapter is cut into sentences when it is opened', () => {
    const r = rawFromPlain('My text', 'First line of it.\nStill the first.\n\nSecond paragraph here. And more.');
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0].blocks.map((b) => b.text)).toEqual(['First line of it. Still the first.', 'Second paragraph here. And more.']);
    const ch = chapterOf(r.chapters[0], 0, createSegmenter());
    expect(ch.paragraphs.map((p) => p.sentences.length)).toEqual([2, 2]);
    expect(charsBefore(ch, 0)).toBe(0);
    expect(charsBefore(ch, 1)).toBe('First line of it. Still the first.'.length);
  });
  it('a text or Markdown file: its headings make the chapters', async () => {
    const r = await rawFromTextFile('notes', '# One\n\nThe first chapter is short.\n\n# Two\n\nThe second chapter is short too.\n');
    expect(r.title).toBe('notes');
    expect(r.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(r.chapters[1].blocks.some((b) => b.text === 'The second chapter is short too.')).toBe(true);
  });
});

describe('hard words by the one level (0-100)', () => {
  const dict = realDictionary();
  const freq: Record<string, number> = { the: 7.4, work: 5.9, friend: 5.4, meticulous: 2.9, lugubrious: 1.8, london: 5.2, careful: 4.6 };
  const zipf = (w: string) => freq[w.toLowerCase()] ?? null;
  const ctx = (words: Record<string, 'known' | 'learning' | 'ignored'> = {}, myLevel = 55) => ({ dict, zipf, words, myLevel });
  it('a word harder than my level is marked; an easy one is not', () => {
    expect(markOf('meticulous', ctx())).toBe('hard');
    expect(markOf('lugubrious', ctx())).toBe('hard');
    expect(markOf('the', ctx())).toBeNull();
    expect(markOf('work', ctx())).toBeNull();
    expect(markOf('friend', ctx())).toBeNull();
    expect(difficultyOf('meticulous', ctx())!).toBeGreaterThan(55);
    expect(difficultyOf('the', ctx())!).toBeLessThan(20);
  });
  it('a known word is never marked; a word still being learned always is; the level decides the rest', () => {
    expect(markOf('meticulous', ctx({ meticulous: 'known' }))).toBeNull();
    expect(markOf('meticulous', ctx({ meticulous: 'ignored' }))).toBeNull();
    expect(markOf('work', ctx({ work: 'learning' }))).toBe('learning');
    expect(markOf('Meticulous', ctx({ meticulous: 'learning' }))).toBe('learning');
    expect(markOf('meticulous', ctx({}, 100))).toBeNull();
    expect(markOf('careful', ctx({}, 5))).toBe('hard');
  });
  it('names, numbers and unknown strings are left alone', () => {
    expect(markOf('London', ctx())).toBeNull();
    expect(markOf('Zxqvfield', ctx())).toBeNull();
    expect(markOf('qwrtzx', ctx())).toBeNull();
    expect(markOf('2026', ctx())).toBeNull();
    expect(markOf('a', ctx())).toBeNull();
    expect(markOf('meticulous', { ...ctx(), names: new Set(['meticulous']) })).toBeNull();
    expect(isWordToken("don't")).toBe(true);
    expect(isWordToken('x1')).toBe(false);
  });
  it('the card: pronunciation and Chinese from the dictionary', () => {
    const c = cardOf('meticulous', dict);
    expect(c.lemma).toBe('meticulous');
    expect(c.ipa).toMatch(/^\/.+\/$/);
    expect(c.zh).toMatch(/[一-鿿]/);
    expect(cardOf('qwrtzx', dict)).toEqual({ lemma: 'qwrtzx', ipa: '', zh: '' });
  });
});
