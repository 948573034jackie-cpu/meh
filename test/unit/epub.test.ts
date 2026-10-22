import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { epubImporter, xhtmlToParagraphs, parseXml, decodeEntities, resolvePath, DRM_ERROR_MESSAGE } from '@core/import/epub';
import type { ImportContext } from '@core/import/types';
import type { Segmenter } from '@core/segment';
import type { Book, Sentence, Token } from '@core/model';

// ---------------------------------------------------------------------------------------------
// Test segmenter stub (the real one is written concurrently): sentences on . ! ?, tokens by regex.
// ---------------------------------------------------------------------------------------------

function stubSegmenter(): Segmenter {
  const tokenize = (text: string, base: number): Token[] => {
    const out: Token[] = [];
    const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*|[^\s\p{L}\p{N}]+/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const kind = /^\p{L}/u.test(m[0]) ? 'word' : /^\p{N}/u.test(m[0]) ? 'number' : 'punct';
      out.push({ start: base + m.index, end: base + m.index + m[0].length, text: m[0], kind });
    }
    return out;
  };
  return {
    segmentParagraph(text: string): Sentence[] {
      const out: Sentence[] = [];
      const re = /[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const raw = m[0];
        const start = m.index + (raw.length - raw.trimStart().length);
        const end = m.index + raw.trimEnd().length;
        if (end <= start) continue;
        out.push({ index: out.length, start, end, tokens: tokenize(text.slice(start, end), start) });
      }
      return out;
    },
    tokenize(text: string): Token[] { return tokenize(text, 0); },
  };
}

const ctx = (): ImportContext => ({ segmenter: stubSegmenter(), id: 'abc123', sourcePath: '/books/test.epub' });

// ---------------------------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------------------------

interface FixtureFile { path: string; content: string | Uint8Array; store?: boolean }

async function buildZip(files: FixtureFile[], opts: { mimetype?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  if (opts.mimetype !== false) zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  for (const f of files) zip.file(f.path, f.content, { compression: f.store ? 'STORE' : 'DEFLATE' });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const CONTAINER = (opf: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${opf}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const xhtml = (body: string, title = 'doc'): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title><style>p { color: red; }</style><link rel="stylesheet" href="../style.css"/></head>
<body>${body}</body>
</html>`;

/** EPUB 3 with: %-encoded href, a cover without heading (TOC label), a no-heading/no-TOC item, a linear=no item, an empty item. */
function epub3Fixture(extra: { encryption?: string } = {}): FixtureFile[] {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:1</dc:identifier>
    <dc:title>Fixture &amp; Friends</dc:title>
    <dc:creator>Ann Author</dc:creator>
    <dc:creator>Bob Coauthor</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="font" href="fonts/Serif.otf" media-type="font/otf"/>
    <item id="img" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="./text/../text/ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="empty" href="text/empty.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="nav" linear="yes"/>
    <itemref idref="ch1"/>
    <itemref idref="empty"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
    <itemref idref="notes" linear="no"/>
    <itemref idref="missing-id"/>
  </spine>
</package>`;

  const nav = xhtml(`
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
  <li><a href="text/cover.xhtml">Cover</a></li>
  <li><a href="text/ch%201.xhtml">Chapter One (TOC)</a><ol><li><a href="text/ch%201.xhtml#s1">Section 1</a></li></ol></li>
  <li><a href="text/ch2.xhtml">Second (TOC)</a></li>
</ol></nav>
<nav epub:type="landmarks" hidden="hidden"><ol><li><a epub:type="bodymatter" href="text/ch%201.xhtml">Start</a></li></ol></nav>`);

  const cover = xhtml(`<div class="cover"><img src="../images/cover.jpg" alt="cover art"/>Fixture &amp; Friends</div>`);

  const ch1 = xhtml(`
<section epub:type="chapter">
  <h1>Chapter   One</h1>
  <p>Hello,
     world!\tThis&nbsp;is   a <i>test</i>. Prefix<i>italic</i>suffix and <b>bold <em>nested</em></b> text.</p>
  <p>Entities: &amp; &mdash; &#8217; &#x201C;quoted&#x201D; &rsquo;</p>
  <p>Line one<br/>line two<br>line three</p>
  <p>Numbers<sup><a href="#fn1">1</a></sup> and E=mc<sup>2</sup>.</p>
  <p>Page<span epub:type="pagebreak" id="p12">12</span>break and a note<a epub:type="noteref" href="#fn1">[1]</a> ref.</p>
  <ul><li>First item</li><li>Second <i>item</i></li></ul>
  <blockquote><p>Quoted paragraph.</p><p>Second quoted.</p></blockquote>
  <pre>  code   block  </pre>
  <figure><img src="x.png"/><figcaption>A caption.</figcaption></figure>
  <p>Unclosed paragraph with a stray < sign
  <p>After the malformed one.</p>
  <div>Loose text in a div.<p>Inner para.</p></div>
  <p>   </p>
  <p><span> </span></p>
  <aside epub:type="footnote" id="fn1"><p>The footnote text.</p></aside>
  <div epub:type="footnotes"><p>Another note block.</p></div>
</section>`);

  const ch2 = xhtml(`<h2>Second</h2><p>Second chapter body.</p><h4>Deep heading</h4><p>More.</p>`);
  const ch3 = xhtml(`<p>No heading here. Just text.</p>`);
  const empty = xhtml(`<div><img src="../images/cover.jpg"/></div><script>var x = "<p>not text</p>";</script>`);
  const notes = xhtml(`<h1>Notes</h1><p>Not linear.</p>`);

  const files: FixtureFile[] = [
    { path: 'META-INF/container.xml', content: CONTAINER('OEBPS/content.opf') },
    { path: 'OEBPS/content.opf', content: opf },
    { path: 'OEBPS/nav.xhtml', content: nav },
    { path: 'OEBPS/style.css', content: 'p{}' },
    { path: 'OEBPS/fonts/Serif.otf', content: new Uint8Array([0, 1, 0, 0]) },
    { path: 'OEBPS/images/cover.jpg', content: new Uint8Array([0xff, 0xd8, 0xff]) },
    { path: 'OEBPS/text/cover.xhtml', content: cover },
    { path: 'OEBPS/text/ch 1.xhtml', content: ch1 },
    { path: 'OEBPS/text/ch2.xhtml', content: ch2 },
    { path: 'OEBPS/text/ch3.xhtml', content: ch3 },
    { path: 'OEBPS/text/empty.xhtml', content: empty },
    { path: 'OEBPS/text/notes.xhtml', content: notes },
  ];
  if (extra.encryption) files.push({ path: 'META-INF/encryption.xml', content: extra.encryption });
  return files;
}

/** EPUB 2 with an NCX, text/html chapters, a UTF-8 BOM, and a manifest href whose case differs from the zip entry. */
function epub2Fixture(): FixtureFile[] {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Old Style</dc:title>
    <dc:creator opf:role="aut">Carol Classic</dc:creator>
    <dc:language>en-GB</dc:language>
    <dc:identifier id="BookId">id-2</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="Text/chapter1.html" media-type="text/html"/>
    <item id="c2" href="Text/Chapter2.html" media-type="text/html"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="id-2"/></head>
  <docTitle><text>Old Style</text></docTitle>
  <navMap>
    <navPoint id="n1" playOrder="1"><navLabel><text>The  Beginning</text></navLabel><content src="Text/chapter1.html"/></navPoint>
    <navPoint id="n2" playOrder="2"><navLabel><text>The Middle</text></navLabel><content src="Text/Chapter2.html#top"/>
      <navPoint id="n2a" playOrder="3"><navLabel><text>Nested</text></navLabel><content src="Text/Chapter2.html#part"/></navPoint>
    </navPoint>
  </navMap>
</ncx>`;
  const c1 = '﻿' + xhtml(`<p>Chapter one without a heading.</p>`);
  const c2 = xhtml(`<h1>Visible Heading</h1><p>Chapter two.</p>`);
  return [
    { path: 'META-INF/container.xml', content: CONTAINER('content.opf') },
    { path: 'content.opf', content: opf },
    { path: 'toc.ncx', content: ncx },
    { path: 'Text/chapter1.html', content: c1 },
    { path: 'Text/chapter2.html', content: c2 },
  ];
}

const encryptionXml = (entries: { algorithm: string; uri: string }[]): string => `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
${entries.map((e) => `  <enc:EncryptedData><enc:EncryptionMethod Algorithm="${e.algorithm}"/><enc:CipherData><enc:CipherReference URI="${e.uri}"/></enc:CipherData></enc:EncryptedData>`).join('\n')}
</encryption>`;

const AES = 'http://www.w3.org/2001/04/xmlenc#aes128-cbc';

/** Structural invariants every imported book must satisfy. */
function checkBook(book: Book): void {
  expect(book.names).toEqual([]);
  let paragraphs = 0, sentences = 0, words = 0;
  book.chapters.forEach((ch, ci) => {
    expect(ch.index).toBe(ci);
    expect(ch.title.length).toBeGreaterThan(0);
    expect(ch.paragraphs.length).toBeGreaterThan(0);
    ch.paragraphs.forEach((p, pi) => {
      expect(p.index).toBe(pi);
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.text).toBe(p.text.trim());
      expect(p.text).not.toMatch(/\s\s|[\t\n ]/);
      expect(p.sentences.length).toBeGreaterThan(0);
      paragraphs++;
      sentences += p.sentences.length;
      for (const s of p.sentences) for (const t of s.tokens) if (t.kind === 'word' || t.kind === 'number') words++;
    });
  });
  expect(book.stats).toEqual({ words, paragraphs, sentences });
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('epubImporter: EPUB 3 fixture', () => {
  let book: Book;
  it('imports', async () => {
    book = await epubImporter.importBytes(await buildZip(epub3Fixture()), ctx());
    checkBook(book);
  });

  it('fills metadata and source from the OPF and the context', () => {
    expect(book.id).toBe('abc123');
    expect(book.title).toBe('Fixture & Friends');
    expect(book.author).toBe('Ann Author, Bob Coauthor');
    expect(book.language).toBe('en');
    expect(book.source.kind).toBe('epub');
    expect(book.source.path).toBe('/books/test.epub');
    expect(Date.parse(book.source.importedAt)).not.toBeNaN();
    expect(book.names).toEqual([]);
  });

  it('keeps linear spine items that have text, in order, and drops empty, nav and linear=no items', () => {
    expect(book.chapters.map((c) => c.title)).toEqual(['Cover', 'Chapter One', 'Second', 'Chapter 4']);
    expect(book.chapters.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    const all = book.chapters.flatMap((c) => c.paragraphs.map((p) => p.text));
    expect(all).not.toContain('Not linear.');
    expect(all).not.toContain('Contents');
  });

  it('titles chapters from the first heading, else the TOC label, else "Chapter N"', () => {
    expect(book.chapters[0].title).toBe('Cover'); // no heading -> nav label (href %-decoded and resolved)
    expect(book.chapters[1].title).toBe('Chapter One'); // heading beats the TOC label "Chapter One (TOC)"
    expect(book.chapters[2].title).toBe('Second'); // h2 counts
    expect(book.chapters[3].title).toBe('Chapter 4'); // neither
  });

  it('produces the right paragraph kinds and texts for chapter one', () => {
    const paras = book.chapters[1].paragraphs.map((p) => [p.kind, p.text]);
    expect(paras).toEqual([
      ['h1', 'Chapter One'],
      ['p', 'Hello, world! This is a test. Prefixitalicsuffix and bold nested text.'],
      ['p', 'Entities: & — ’ “quoted” ’'],
      ['p', 'Line one line two line three'],
      ['p', 'Numbers and E=mc2.'],
      ['p', 'Pagebreak and a note ref.'],
      ['li', 'First item'],
      ['li', 'Second item'],
      ['blockquote', 'Quoted paragraph.'],
      ['blockquote', 'Second quoted.'],
      ['pre', 'code block'],
      ['caption', 'A caption.'],
      ['p', 'Unclosed paragraph with a stray < sign'],
      ['p', 'After the malformed one.'],
      ['p', 'Loose text in a div.'],
      ['p', 'Inner para.'],
    ]);
  });

  it('maps h4+ to h3 and keeps the cover text as a chapter', () => {
    expect(book.chapters[2].paragraphs.map((p) => p.kind)).toEqual(['h2', 'p', 'h3', 'p']);
    expect(book.chapters[0].paragraphs).toEqual([expect.objectContaining({ kind: 'p', text: 'Fixture & Friends' })]);
  });

  it('segments every paragraph with the context segmenter', () => {
    const p = book.chapters[1].paragraphs[1];
    expect(p.sentences.map((s) => p.text.slice(s.start, s.end))).toEqual(['Hello, world!', 'This is a test.', 'Prefixitalicsuffix and bold nested text.']);
    expect(p.sentences[0].tokens.map((t) => t.text)).toEqual(['Hello', ',', 'world', '!']);
  });

  it('computes stats across all chapters', () => {
    expect(book.stats.paragraphs).toBe(1 + 16 + 4 + 1);
    expect(book.stats.sentences).toBeGreaterThan(book.stats.paragraphs);
    expect(book.stats.words).toBeGreaterThan(50);
  });
});

describe('epubImporter: EPUB 2 with NCX', () => {
  it('reads text/html chapters, NCX labels, a BOM, and resolves hrefs case-insensitively', async () => {
    const book = await epubImporter.importBytes(await buildZip(epub2Fixture()), ctx());
    checkBook(book);
    expect(book.title).toBe('Old Style');
    expect(book.author).toBe('Carol Classic');
    expect(book.language).toBe('en-GB');
    expect(book.chapters.map((c) => c.title)).toEqual(['The Beginning', 'Visible Heading']);
    expect(book.chapters[0].paragraphs[0].text).toBe('Chapter one without a heading.');
    expect(book.chapters[1].paragraphs.map((p) => p.text)).toEqual(['Visible Heading', 'Chapter two.']);
  });
});

describe('epubImporter: errors', () => {
  it('throws the DRM error when encryption.xml covers a content document', async () => {
    const enc = encryptionXml([{ algorithm: 'http://www.idpf.org/2008/embedding', uri: 'OEBPS/fonts/Serif.otf' }, { algorithm: AES, uri: 'OEBPS/text/ch2.xhtml' }]);
    await expect(epubImporter.importBytes(await buildZip(epub3Fixture({ encryption: enc })), ctx())).rejects.toThrow(DRM_ERROR_MESSAGE);
    expect(DRM_ERROR_MESSAGE).toBe('This EPUB is protected by DRM and cannot be opened');
  });

  it('throws the DRM error for a %-encoded content reference too', async () => {
    const enc = encryptionXml([{ algorithm: AES, uri: 'OEBPS/text/ch%201.xhtml' }]);
    await expect(epubImporter.importBytes(await buildZip(epub3Fixture({ encryption: enc })), ctx())).rejects.toThrow(/DRM/);
  });

  it('accepts font obfuscation (IDPF and Adobe algorithms) and encrypted non-text resources', async () => {
    const enc = encryptionXml([
      { algorithm: 'http://www.idpf.org/2008/embedding', uri: 'OEBPS/fonts/Serif.otf' },
      { algorithm: 'http://ns.adobe.com/pdf/enc#RC', uri: 'OEBPS/fonts/Serif.otf' },
      { algorithm: AES, uri: 'OEBPS/images/cover.jpg' },
    ]);
    const book = await epubImporter.importBytes(await buildZip(epub3Fixture({ encryption: enc })), ctx());
    expect(book.chapters.length).toBe(4);
  });

  it('throws a clear error when container.xml is missing', async () => {
    const files = epub3Fixture().filter((f) => f.path !== 'META-INF/container.xml');
    await expect(epubImporter.importBytes(await buildZip(files), ctx())).rejects.toThrow(/container\.xml/);
  });

  it('throws a clear error when the package document is missing', async () => {
    const files = epub3Fixture().filter((f) => f.path !== 'OEBPS/content.opf');
    await expect(epubImporter.importBytes(await buildZip(files), ctx())).rejects.toThrow(/package document/);
  });

  it('throws a clear error for a file that is not a zip', async () => {
    await expect(epubImporter.importBytes(new Uint8Array([1, 2, 3, 4, 5]), ctx())).rejects.toThrow(/Not a valid EPUB/);
  });

  it('throws when no spine item has any text', async () => {
    const files = epub3Fixture().filter((f) => !/OEBPS\/text\/(cover|ch 1|ch2|ch3)\.xhtml/.test(f.path));
    await expect(epubImporter.importBytes(await buildZip(files), ctx())).rejects.toThrow(/no readable text/);
  });
});

const SAMPLE = path.resolve(__dirname, '../fixtures/book.epub');

describe.skipIf(!fs.existsSync(SAMPLE))('epubImporter: pandoc sample book.epub', () => {
  it('imports the title page and two chapters with the expected kinds', async () => {
    const book = await epubImporter.importBytes(new Uint8Array(fs.readFileSync(SAMPLE)), { segmenter: stubSegmenter(), id: 'sample' });
    checkBook(book);
    expect(book.title).toBe('The Test Book');
    expect(book.author).toBe('Spike Author');
    expect(book.language).toBe('en-GB');
    expect(book.source.path).toBeUndefined();
    expect(book.chapters.map((c) => c.title)).toEqual(['The Test Book', 'Chapter One: Arrival', 'Chapter Two: The Letter']);
    expect(book.chapters[0].paragraphs.map((p) => [p.kind, p.text])).toEqual([['h1', 'The Test Book'], ['p', 'Spike Author']]);
    expect(book.chapters[1].paragraphs.map((p) => p.kind)).toEqual(['h1', 'p', 'p']);
    expect(book.chapters[1].paragraphs[1].text).toMatch(/^Mr\. Darcy arrived at 5 p\.m\. on Tuesday\. “Is it true,” she asked/);
    expect(book.chapters[2].paragraphs.map((p) => [p.kind, p.text])).toEqual([
      ['h1', 'Chapter Two: The Letter'],
      ['p', 'The letter arrived the next morning. It contained a single, perplexing sentence—“Meet me where the river bends.” Elizabeth read it twice (and then a third time) before folding it away.'],
      ['li', 'A list item that should still be read.'],
      ['li', 'Another item.'],
      ['blockquote', 'A quoted paragraph, which is quite ordinary.'],
    ]);
    expect(book.stats.paragraphs).toBe(10);
  });
});

describe('epubImporter: performance', () => {
  it('imports a 3 MB EPUB in under 3 seconds', async () => {
    const sentences = [
      'The quick brown fox jumps over the lazy dog.', 'Mr. Darcy arrived at five in the afternoon, soaked to the skin.',
      '“Is it true,” she asked, “that you never dance?”', 'He said nothing and looked out at the rain for a long while.',
      'It was an inauspicious beginning, but the evening improved.',
    ];
    const chapterCount = 30;
    const files: FixtureFile[] = [{ path: 'META-INF/container.xml', content: CONTAINER('OEBPS/content.opf') }];
    let items = '', refs = '', total = 0;
    for (let c = 0; c < chapterCount; c++) {
      const paras: string[] = [`<h1>Chapter ${c + 1}</h1>`];
      for (let p = 0; p < 420; p++) {
        const s = sentences[(p + c) % sentences.length] + ' ' + sentences[(p * 7 + c) % sentences.length] + ' <i>' + sentences[(p * 3) % sentences.length] + '</i> ' + sentences[(p * 11 + 1) % sentences.length];
        paras.push(`<p class="body" id="p${p}">${s}</p>`);
      }
      const content = xhtml(paras.join('\n'), `Chapter ${c + 1}`);
      total += Buffer.byteLength(content);
      files.push({ path: `OEBPS/text/c${c}.xhtml`, content, store: true });
      items += `<item id="c${c}" href="text/c${c}.xhtml" media-type="application/xhtml+xml"/>`;
      refs += `<itemref idref="c${c}"/>`;
    }
    files.push({ path: 'OEBPS/content.opf', content: `<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Big</dc:title></metadata><manifest>${items}</manifest><spine>${refs}</spine></package>` });
    const bytes = await buildZip(files);
    expect(total).toBeGreaterThan(3 * 1024 * 1024);
    expect(bytes.byteLength).toBeGreaterThan(3 * 1024 * 1024);

    const t0 = performance.now();
    const book = await epubImporter.importBytes(bytes, ctx());
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect(book.chapters.length).toBe(chapterCount);
    expect(book.stats.paragraphs).toBe(chapterCount * 421);
    expect(book.chapters[5].title).toBe('Chapter 6');
  });
});

// ---------------------------------------------------------------------------------------------
// Parser and extraction unit tests
// ---------------------------------------------------------------------------------------------

const paras = (body: string): [string, string][] => xhtmlToParagraphs(`<html><body>${body}</body></html>`).map((p) => [p.kind, p.text]);

describe('xhtmlToParagraphs', () => {
  it('never merges blocks and never adds spaces between inline elements', () => {
    expect(paras('<p>Hello</p><p>World</p>')).toEqual([['p', 'Hello'], ['p', 'World']]);
    expect(paras('<p>word<i>italic</i>word</p>')).toEqual([['p', 'worditalicword']]);
    expect(paras('<p>one <b>two</b> three</p>')).toEqual([['p', 'one two three']]);
    expect(paras('<p><span>a</span><span>b</span></p>')).toEqual([['p', 'ab']]);
  });

  it('normalises whitespace', () => {
    expect(paras('<p>\n  Hello\t\t world  again ​\n</p>')).toEqual([['p', 'Hello world again']]);
    expect(paras('<p>Line<br/>break<br>here</p>')).toEqual([['p', 'Line break here']]);
  });

  it('drops empty and whitespace-only paragraphs', () => {
    expect(paras('<p></p><p> \n </p><p><i> </i></p><div></div><hr/><p>Kept</p>')).toEqual([['p', 'Kept']]);
  });

  it('maps element names to paragraph kinds', () => {
    expect(paras('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>')).toEqual([['h1', 'A'], ['h2', 'B'], ['h3', 'C'], ['h3', 'D'], ['h3', 'E'], ['h3', 'F']]);
    expect(paras('<ul><li>One</li><li><p>Two</p></li></ul><ol><li>Three<ul><li>Nested</li></ul></li></ol>')).toEqual([['li', 'One'], ['li', 'Two'], ['li', 'Three'], ['li', 'Nested']]);
    expect(paras('<blockquote>Direct</blockquote><blockquote><p>Inner</p><div>Div</div></blockquote>')).toEqual([['blockquote', 'Direct'], ['blockquote', 'Inner'], ['blockquote', 'Div']]);
    expect(paras('<pre><code>x = 1\ny = 2</code></pre>')).toEqual([['pre', 'x = 1 y = 2']]);
    expect(paras('<figure><figcaption>Cap</figcaption></figure><table><caption>TCap</caption><tr><td>C1</td><th>C2</th></tr></table>')).toEqual([['caption', 'Cap'], ['caption', 'TCap'], ['p', 'C1'], ['p', 'C2']]);
    expect(paras('<dl><dt>Term</dt><dd>Definition</dd></dl>')).toEqual([['p', 'Term'], ['p', 'Definition']]);
    expect(paras('<li><h2>Heading in item</h2><p>Body</p></li>')).toEqual([['h2', 'Heading in item'], ['li', 'Body']]);
  });

  it('turns loose text in containers into paragraphs', () => {
    expect(paras('<div>Loose<p>Para</p>more loose<section>deep</section></div>')).toEqual([['p', 'Loose'], ['p', 'Para'], ['p', 'more loose'], ['p', 'deep']]);
    expect(paras('Text straight in body<p>P</p>')).toEqual([['p', 'Text straight in body'], ['p', 'P']]);
  });

  it('skips scripts, styles, navigation, notes, page breaks, hidden elements and media', () => {
    expect(paras('<style>p{}</style><script>if (a < b) { x = "<p>no</p>"; }</script><p>Visible</p>')).toEqual([['p', 'Visible']]);
    expect(paras('<nav epub:type="toc"><ol><li><a href="#c">Chapter</a></li></ol></nav><p>Body</p>')).toEqual([['p', 'Body']]);
    expect(paras('<p>Text<aside epub:type="footnote">note</aside></p><aside epub:type="rearnotes"><p>r</p></aside>')).toEqual([['p', 'Text']]);
    expect(paras('<p>A<span epub:type="pagebreak" title="3"/>B<div role="doc-pagebreak">4</div>C</p>')).toEqual([['p', 'AB'], ['p', 'C']]);
    expect(paras('<p>Vis<span hidden="hidden">hidden</span>ible</p><nav hidden=""><p>x</p></nav>')).toEqual([['p', 'Visible']]);
    expect(paras('<p>Img<img alt="alt text"/>and<svg><text>svg</text></svg><math><mi>x</mi></math>.</p>')).toEqual([['p', 'Imgand.']]);
    expect(paras('<p><ruby>漢<rt>kan</rt></ruby></p>')).toEqual([['p', '漢']]);
  });

  it('removes footnote markers but keeps real superscripts', () => {
    expect(paras('<p>House<sup><a href="#fn1">1</a></sup> and<sup>*</sup> E=mc<sup>2</sup>.</p>')).toEqual([['p', 'House and* E=mc2.']]);
    expect(paras('<p>Ref<a epub:type="noteref" href="#n">[1]</a>.</p><p>Ref<a role="doc-noteref" href="#n"><sup>2</sup></a>.</p>')).toEqual([['p', 'Ref.'], ['p', 'Ref.']]);
  });

  it('adds quotation marks around <q>', () => {
    expect(paras('<p>She said <q>hello</q>.</p>')).toEqual([['p', 'She said “hello”.']]);
  });

  it('tolerates malformed markup', () => {
    expect(paras('<p>One<p>Two</p>')).toEqual([['p', 'One'], ['p', 'Two']]);
    expect(paras('<p>a <b>b <i>c</p><p>d</p>')).toEqual([['p', 'a b c'], ['p', 'd']]);
    expect(paras('<ul><li>A<li>B</ul>')).toEqual([['li', 'A'], ['li', 'B']]);
    expect(paras('<p>x < y and z > w</p>')).toEqual([['p', 'x < y and z > w']]);
    expect(paras('<p>unterminated <span class="x>text</p><p>next</p>')).toEqual([['p', 'unterminated text'], ['p', 'next']]);
    expect(paras('<p>unterminated <span class="x>text</p><p class="y">next</p>')).toEqual([['p', 'unterminated text'], ['p', 'next']]);
    expect(paras('<p><a title="a > b">gt in value</a></p>')).toEqual([['p', 'gt in value']]);
    expect(paras('<p>stray</span></div> end</p>')).toEqual([['p', 'stray end']]);
    expect(paras('<p>no end tag at all')).toEqual([['p', 'no end tag at all']]);
    expect(paras('<p>cut off <b')).toEqual([['p', 'cut off']]);
    expect(paras('<p>comment <!-- <p>hidden</p> --> kept</p>')).toEqual([['p', 'comment kept']]);
    expect(paras('<p><![CDATA[a < b & c]]></p>')).toEqual([['p', 'a < b & c']]);
    expect(paras('<P CLASS="X">Upper<BR/>case</P>')).toEqual([['p', 'Upper case']]);
  });

  it('survives absurd nesting without overflowing the stack', () => {
    const deep = '<span>'.repeat(20000) + 'deep' + '</span>'.repeat(20000);
    expect(paras(`<p>${deep}</p>`)).toEqual([['p', 'deep']]);
    const unclosed = '<b>'.repeat(50000) + 'text';
    expect(paras(`<p>${unclosed}</p><p>after</p>`)).toEqual([['p', 'text'], ['p', 'after']]);
  });

  it('decodes character references', () => {
    expect(paras('<p>&amp; &lt;b&gt; &quot;q&quot; &apos;a&apos; &mdash; &hellip; &eacute; &#233; &#xE9; &#146; &unknown; &#0; &#xD800;</p>')).toEqual([['p', '& <b> "q" \'a\' — … é é é ’ &unknown; � �']]);
  });

  it('falls back to the whole document when there is no body', () => {
    expect(xhtmlToParagraphs('<head><title>T</title></head><p>No body</p>').map((p) => p.text)).toEqual(['No body']);
  });
});

describe('parseXml', () => {
  it('builds a tree with lower-cased names and decoded attributes', () => {
    const doc = parseXml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "x">]><Root a="1 &amp; 2" B=\'q\' c=d e><dc:Title>T</dc:Title><void/></Root>');
    const root = doc.children[0];
    expect(root.type).toBe('element');
    if (root.type !== 'element') return;
    expect(root.name).toBe('root');
    expect([...root.attrs]).toEqual([['a', '1 & 2'], ['b', 'q'], ['c', 'd'], ['e', '']]);
    expect(root.children.map((c) => (c.type === 'element' ? c.name : c.text))).toEqual(['dc:title', 'void']);
  });

  it('does not apply HTML rules in xml mode (OPF <meta> has content)', () => {
    const doc = parseXml('<metadata><meta property="x">value</meta><link href="y"/></metadata>');
    const meta = doc.children[0].type === 'element' ? doc.children[0].children[0] : null;
    expect(meta && meta.type === 'element' && meta.children[0].type === 'text' ? meta.children[0].text : null).toBe('value');
  });

  it('keeps the first of duplicate attributes and uses null-safe keys', () => {
    const doc = parseXml('<a x="1" x="2" __proto__="p" constructor="c"/>');
    const a = doc.children[0];
    expect(a.type === 'element' ? a.attrs.get('x') : null).toBe('1');
    expect(a.type === 'element' ? a.attrs.get('__proto__') : null).toBe('p');
  });
});

describe('decodeEntities and resolvePath', () => {
  it('decodes numeric and named references, leaving unknown ones alone', () => {
    expect(decodeEntities('a&amp;b &#65;&#x42; &nbsp;x &bogus; &amp')).toBe('a&b AB  x &bogus; &amp');
    expect(decodeEntities('plain')).toBe('plain');
  });

  it('resolves hrefs relative to a directory with %-decoding and .. segments', () => {
    expect(resolvePath('OEBPS/', 'text/ch%201.xhtml#frag')).toBe('OEBPS/text/ch 1.xhtml');
    expect(resolvePath('OEBPS/text/', '../images/a.png?x=1')).toBe('OEBPS/images/a.png');
    expect(resolvePath('a/b/', './c/../d.xhtml')).toBe('a/b/d.xhtml');
    expect(resolvePath('a/', '/root.xhtml')).toBe('root.xhtml');
    expect(resolvePath('', 'bad%zz.xhtml')).toBe('bad%zz.xhtml');
    expect(resolvePath('', 'win\\style.xhtml')).toBe('win/style.xhtml');
  });
});
