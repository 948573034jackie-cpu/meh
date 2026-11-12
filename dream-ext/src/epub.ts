/**
 * An EPUB book -> its chapters as plain paragraphs (no DOM needed: it runs in the page and in the unit tests).
 * The file is a zip: META-INF/container.xml names the package file (.opf), whose manifest lists the files and whose
 * spine gives the reading order; the chapter titles come from the table of contents (nav.xhtml of EPUB 3, toc.ncx of
 * EPUB 2), else from the chapter's first heading. Only the text is read: no pictures, no styles.
 * A book with DRM (bought in Kindle, Apple Books, Kobo, Adobe) cannot be read: LockedBookError says so plainly.
 */
import { unzipSync, strFromU8 } from 'fflate';
import type { RawParagraph } from '@core/import/text';
import type { ParagraphKind } from '@core/model';

export interface RawChapter { title: string; blocks: RawParagraph[] }
export interface RawBook { title: string; author: string; chapters: RawChapter[] }

export const LOCKED_MESSAGE = 'This book is locked (DRM). Books bought in Kindle or Apple Books are locked and cannot be opened here.';
export class LockedBookError extends Error {
  constructor() { super(LOCKED_MESSAGE); this.name = 'LockedBookError'; }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', mdash: '—', ndash: '–', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', deg: '°',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', ccedil: 'ç', iuml: 'ï', ouml: 'ö', uuml: 'ü', auml: 'ä',
  ntilde: 'ñ', oacute: 'ó', uacute: 'ú', iacute: 'í', szlig: 'ß', pound: '£', euro: '€', shy: '', bull: '•', middot: '·', times: '×',
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : ''; } catch { return ''; }
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** the attributes of one tag: `<item id="a" href='b'>` -> { id: 'a', href: 'b' } (names without their prefix too) */
export function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const v = decodeEntities(m[2] ?? m[3] ?? '');
    out[m[1].toLowerCase()] = v;
    const bare = m[1].replace(/^[\w.-]+:/, '').toLowerCase();
    if (!(bare in out)) out[bare] = v;
  }
  return out;
}

/** "OEBPS/text" + "../images/a%20b.png#x" -> "OEBPS/images/a b.png" */
export function resolvePath(baseDir: string, href: string): string {
  let h = href.split('#')[0].split('?')[0];
  try { h = decodeURIComponent(h); } catch { /* as it is */ }
  const parts = h.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const p of h.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') parts.pop(); else parts.push(p);
  }
  return parts.join('/');
}

const BLOCKS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre',
  'table', 'tr', 'td', 'th', 'figure', 'figcaption', 'hr', 'body', 'html', 'nav', 'center', 'address', 'caption', 'title']);
const KIND: Record<string, ParagraphKind> = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3', li: 'li', blockquote: 'blockquote', pre: 'pre', figcaption: 'caption', caption: 'caption' };
const VOID = new Set(['hr', 'br', 'img', 'meta', 'link', 'input', 'col', 'wbr', 'source', 'area', 'base']);

/** One (X)HTML file of the book -> its paragraphs and headings, in order, as plain text. */
export function htmlToBlocks(html: string): RawParagraph[] {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(s);
  if (body) s = body[1];
  s = s.replace(/<(script|style|head|svg|math|rt|rp|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const out: RawParagraph[] = [];
  const stack: string[] = [];
  let buf = '';
  const kindNow = (): ParagraphKind => {
    for (let i = stack.length - 1; i >= 0; i--) { const k = KIND[stack[i]]; if (k) return k; }
    return 'p';
  };
  const flush = () => {
    const text = decodeEntities(buf).replace(/[​⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
    buf = '';
    if (text) out.push({ kind: kindNow(), text });
  };
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b[^>]*?(\/?)>|<[^>]*>|[^<]+/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[2] === undefined) { if (m[0][0] !== '<') buf += m[0]; continue; }
    const name = m[2].toLowerCase().replace(/^[\w-]+:/, '');
    if (name === 'br') { buf += ' '; continue; }
    if (!BLOCKS.has(name)) continue;
    flush();
    if (m[1]) { const i = stack.lastIndexOf(name); if (i >= 0) stack.length = i; }
    else if (!m[3] && !VOID.has(name)) stack.push(name);
  }
  flush();
  return out;
}

const plain = (xml: string): string => decodeEntities(xml.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** table of contents: file path -> the first title that points into it */
function tocTitles(doc: string, baseDir: string, ncx: boolean): Map<string, string> {
  const out = new Map<string, string>();
  const add = (href: string, title: string) => { const p = resolvePath(baseDir, href); const t = plain(title); if (p && t && !out.has(p)) out.set(p, t); };
  if (ncx) {
    for (const m of doc.matchAll(/<(?:\w+:)?navPoint\b[\s\S]*?<(?:\w+:)?text\b[^>]*>([\s\S]*?)<\/(?:\w+:)?text>[\s\S]*?(<(?:\w+:)?content\b[^>]*>)/gi)) add(attrsOf(m[2]).src ?? '', m[1]);
  } else {
    const nav = /<nav\b[^>]*(?:epub:)?type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i.exec(doc)?.[1] ?? doc;
    for (const m of nav.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) add(attrsOf(m[1]).href ?? '', m[2]);
  }
  return out;
}

/** which files of the zip are read at all (never the pictures, fonts, sounds) */
const wanted = (name: string): boolean => name === 'mimetype' || /^META-INF\//i.test(name) || /\.(opf|ncx|x?html?|xml)$/i.test(name);
/** font files may be scrambled in a free book: that is not a lock */
const FONT_ONLY = /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/i;

export function parseEpub(bytes: Uint8Array): RawBook {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes, { filter: (f) => wanted(f.name) }); }
  catch { throw new Error('This file is not an EPUB book that can be opened.'); }
  const names = Object.keys(files);
  const find = (path: string): string | undefined => (path in files ? path : names.find((n) => n.toLowerCase() === path.toLowerCase()));
  const read = (path: string): string | null => { const n = find(path); return n ? strFromU8(files[n]).replace(/^﻿/, '') : null; };

  // ---- locked? ----
  if (find('META-INF/rights.xml') || find('META-INF/sinf.xml')) throw new LockedBookError();
  const enc = read('META-INF/encryption.xml');
  if (enc) {
    for (const m of enc.matchAll(/<(?:\w+:)?EncryptedData\b[\s\S]*?<\/(?:\w+:)?EncryptedData>/gi)) {
      const algo = attrsOf(/<(?:\w+:)?EncryptionMethod\b[^>]*>/i.exec(m[0])?.[0] ?? '').algorithm ?? '';
      if (!FONT_ONLY.test(algo)) throw new LockedBookError();
    }
  }

  const container = read('META-INF/container.xml');
  const opfPath = container ? attrsOf(/<(?:\w+:)?rootfile\b[^>]*>/i.exec(container)?.[0] ?? '')['full-path'] : names.find((n) => /\.opf$/i.test(n));
  const opf = opfPath ? read(opfPath) : null;
  if (!opfPath || !opf) throw new Error('This file is not an EPUB book that can be opened.');
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const meta = (tag: string): string => plain(new RegExp(`<(?:dc:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:dc:)?${tag}>`, 'i').exec(opf)?.[1] ?? '');
  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const m of opf.matchAll(/<(?:\w+:)?item\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if (a.id && a.href) manifest.set(a.id, { href: resolvePath(dir, a.href), type: a['media-type'] ?? '', props: a.properties ?? '' });
  }
  const spineTag = /<(?:\w+:)?spine\b[^>]*>/i.exec(opf)?.[0] ?? '';
  const spine: string[] = [];
  for (const m of opf.matchAll(/<(?:\w+:)?itemref\b[^>]*>/gi)) { const a = attrsOf(m[0]); if (a.idref) spine.push(a.idref); }

  // ---- the chapter titles ----
  let titles = new Map<string, string>();
  const navItem = [...manifest.values()].find((i) => /\bnav\b/.test(i.props));
  const ncxItem = manifest.get(attrsOf(spineTag).toc ?? '') ?? [...manifest.values()].find((i) => /dtbncx/i.test(i.type) || /\.ncx$/i.test(i.href));
  const navDoc = navItem ? read(navItem.href) : null;
  if (navItem && navDoc) titles = tocTitles(navDoc, navItem.href.includes('/') ? navItem.href.slice(0, navItem.href.lastIndexOf('/')) : '', false);
  if (!titles.size && ncxItem) { const d = read(ncxItem.href); if (d) titles = tocTitles(d, ncxItem.href.includes('/') ? ncxItem.href.slice(0, ncxItem.href.lastIndexOf('/')) : '', true); }

  const chapters: RawChapter[] = [];
  let unreadable = 0;
  for (const id of spine) {
    const item = manifest.get(id);
    if (!item || item === navItem) continue;
    const doc = read(item.href);
    if (doc === null) { unreadable++; continue; }
    const blocks = htmlToBlocks(doc);
    if (!blocks.length) continue;
    const heading = blocks.find((b) => b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3');
    const title = titles.get(item.href) ?? (heading && heading.text.length <= 120 ? heading.text : '');
    chapters.push({ title, blocks });
  }
  if (!chapters.length) {
    // (every chapter file is missing or unreadable: a locked book looks like this too)
    if (unreadable || enc) throw new LockedBookError();
    throw new Error('No readable text was found in this book.');
  }
  return { title: meta('title') || 'Untitled book', author: meta('creator'), chapters };
}
