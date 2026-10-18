/**
 * EPUB importer (EPUB 2 and EPUB 3). Runs in the Electron main process.
 *
 * Pipeline: unzip (JSZip) -> META-INF/container.xml -> package document (OPF: metadata, manifest, spine)
 * -> DRM check (META-INF/encryption.xml) -> TOC labels (EPUB 3 nav document and/or EPUB 2 NCX)
 * -> every linear spine content document is parsed with the tolerant XML/XHTML parser below and its
 * <body> is flattened into plain-text paragraphs -> paragraphs are segmented and the Book assembled.
 *
 * The parser is hand-written because htmlparser2 is not a dependency of the app. It never throws on
 * malformed input: unmatched end tags are ignored, unclosed elements close implicitly, a stray '<' is
 * text, and in html mode HTML's implied end tags for <p>, <li>, <dt>/<dd>, <tr>, <td>/<th> apply.
 */
import JSZip from 'jszip';
import type { Book, Chapter, ParagraphKind } from '@core/model';
import type { ImportContext, Importer } from './types';
import { assembleParagraphs, computeStats, decodeTextBytes, normalizeWhitespace, type RawParagraph } from './text';

// ---------------------------------------------------------------------------------------------
// Tolerant XML / XHTML parser
// ---------------------------------------------------------------------------------------------

export interface XmlElement {
  type: 'element';
  /** lower-cased qualified name as written, e.g. 'p', 'dc:title', 'epub:switch' */
  name: string;
  /** lower-cased attribute name -> entity-decoded value; the first occurrence of a duplicate wins */
  attrs: Map<string, string>;
  children: XmlNode[];
}
export interface XmlText { type: 'text'; text: string }
export type XmlNode = XmlElement | XmlText;

/** HTML void elements never have content, so no end tag is expected (html mode only). */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Content is raw text up to the matching end tag, so '<' inside is not markup (html mode only). */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);
/** Block-level elements: they start a new paragraph and their start tag implicitly closes an open <p>. */
const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'colgroup', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);
/** Deeper nesting than this is flattened (a malformed document with thousands of unclosed tags must not blow the stack). */
const MAX_DEPTH = 512;

/** An implied end tag: a start tag of `closes` while one is open (without passing a `stopAt` ancestor) closes it. */
interface ImpliedEnd { closes: Set<string>; stopAt: Set<string> }
const LIST_ITEM_END: ImpliedEnd = { closes: new Set(['li']), stopAt: new Set(['ul', 'ol', 'menu']) };
const DEFINITION_END: ImpliedEnd = { closes: new Set(['dt', 'dd']), stopAt: new Set(['dl']) };
const ROW_END: ImpliedEnd = { closes: new Set(['tr', 'td', 'th']), stopAt: new Set(['table', 'tbody', 'thead', 'tfoot']) };
const CELL_END: ImpliedEnd = { closes: new Set(['td', 'th']), stopAt: new Set(['tr', 'table']) };
const PARAGRAPH_END: ImpliedEnd = { closes: new Set(['p']), stopAt: BLOCK_ELEMENTS };
const IMPLIED_ENDS = new Map<string, ImpliedEnd>([
  ['li', LIST_ITEM_END], ['dt', DEFINITION_END], ['dd', DEFINITION_END], ['tr', ROW_END], ['td', CELL_END], ['th', CELL_END],
]);

const CH_BANG = 0x21, CH_SLASH = 0x2f, CH_QUESTION = 0x3f, CH_GT = 0x3e, CH_EQ = 0x3d, CH_DQUOTE = 0x22, CH_SQUOTE = 0x27;

function isWhitespace(c: number): boolean { return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c; }
function isNameStart(c: number): boolean { return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a || c >= 0x80; }
function isNameEnd(c: number): boolean { return isWhitespace(c) || c === CH_SLASH || c === CH_GT; }
function isAttrNameEnd(c: number): boolean { return isNameEnd(c) || c === CH_EQ; }

/** Pops the stack down to (and including) the innermost element the rule closes, if any. */
function applyImpliedEnd(stack: XmlElement[], rule: ImpliedEnd): void {
  let cut = -1;
  for (let k = stack.length - 1; k > 0; k--) {
    const name = stack[k].name;
    if (rule.closes.has(name)) cut = k;
    else if (rule.stopAt.has(name)) break;
  }
  if (cut !== -1) stack.length = cut;
}

/** End tag: pops to the nearest open element with that name; an unmatched end tag is ignored. */
function closeElement(stack: XmlElement[], name: string): void {
  for (let k = stack.length - 1; k > 0; k--) {
    if (stack[k].name === name) { stack.length = k; return; }
  }
}

/** Skips '<!DOCTYPE ...>' including an internal subset in [ ]. Returns the index after '>'. */
function skipDeclaration(src: string, start: number): number {
  let depth = 0;
  for (let k = start + 2; k < src.length; k++) {
    const c = src.charCodeAt(k);
    if (c === 0x5b) depth++; // [
    else if (c === 0x5d) depth--; // ]
    else if (c === CH_GT && depth <= 0) return k + 1;
  }
  return src.length;
}

/** Index of '</name' (case-insensitive, followed by a delimiter) at or after `from`, or -1. */
function findEndTag(src: string, from: number, name: string): number {
  let k = from;
  for (;;) {
    k = src.indexOf('</', k);
    if (k === -1) return -1;
    const after = k + 2 + name.length;
    if (src.slice(k + 2, after).toLowerCase() === name && (after >= src.length || isNameEnd(src.charCodeAt(after)))) return k;
    k += 2;
  }
}

interface StartTag { name: string; attrs: Map<string, string>; selfClosing: boolean; end: number }

/** Reads a start tag beginning at `start` ('<'). Tolerates unquoted/valueless attributes, '>' inside quotes, EOF. */
function readStartTag(src: string, start: number): StartTag {
  const n = src.length;
  let i = start + 1;
  const nameStart = i;
  while (i < n && !isNameEnd(src.charCodeAt(i))) i++;
  const name = src.slice(nameStart, i).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  for (;;) {
    while (i < n && isWhitespace(src.charCodeAt(i))) i++;
    if (i >= n) return { name, attrs, selfClosing, end: n };
    const c = src.charCodeAt(i);
    if (c === CH_GT) return { name, attrs, selfClosing, end: i + 1 };
    if (c === CH_SLASH) { selfClosing = true; i++; continue; }
    const attrStart = i;
    while (i < n && !isAttrNameEnd(src.charCodeAt(i))) i++;
    if (i === attrStart) { i++; continue; } // stray character such as a lone quote
    const attrName = src.slice(attrStart, i).toLowerCase();
    selfClosing = false;
    while (i < n && isWhitespace(src.charCodeAt(i))) i++;
    let value = '';
    if (i < n && src.charCodeAt(i) === CH_EQ) {
      i++;
      while (i < n && isWhitespace(src.charCodeAt(i))) i++;
      const q = src.charCodeAt(i);
      if (q === CH_DQUOTE || q === CH_SQUOTE) {
        let close = src.indexOf(String.fromCharCode(q), i + 1);
        // A raw '<' cannot occur inside an attribute value, so the quote was never closed: the "value"
        // would swallow the following markup. Recover at the end of the tag instead.
        if (close !== -1 && src.slice(i + 1, close).indexOf('<') !== -1) close = -1;
        if (close === -1) {
          const gt = src.indexOf('>', i + 1);
          value = src.slice(i + 1, gt === -1 ? n : gt);
          i = gt === -1 ? n : gt;
        } else {
          value = src.slice(i + 1, close);
          i = close + 1;
        }
      } else {
        const valueStart = i;
        while (i < n && !isWhitespace(src.charCodeAt(i)) && src.charCodeAt(i) !== CH_GT) i++;
        value = src.slice(valueStart, i);
      }
    }
    if (!attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
  }
}

/**
 * Parses XML or XHTML into a tree rooted at a synthetic '#document' element. Never throws.
 * `html` enables HTML rules: void elements, raw-text <script>/<style>, implied end tags.
 */
export function parseXml(src: string, html = false): XmlElement {
  const root: XmlElement = { type: 'element', name: '#document', attrs: new Map(), children: [] };
  const stack: XmlElement[] = [root];
  const n = src.length;
  let i = 0;

  const addText = (text: string, raw: boolean): void => {
    if (text.length === 0) return;
    stack[stack.length - 1].children.push({ type: 'text', text: raw ? text : decodeEntities(text) });
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { addText(src.slice(i), false); break; }
    if (lt > i) addText(src.slice(i, lt), false);
    i = lt;
    const next = src.charCodeAt(i + 1);
    if (next === CH_BANG) {
      if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i + 4);
        i = e === -1 ? n : e + 3;
      } else if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i + 9);
        addText(src.slice(i + 9, e === -1 ? n : e), true);
        i = e === -1 ? n : e + 3;
      } else {
        i = skipDeclaration(src, i);
      }
      continue;
    }
    if (next === CH_QUESTION) { // <?xml ...?> and other processing instructions
      const e = src.indexOf('?>', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (next === CH_SLASH) {
      const e = src.indexOf('>', i + 2);
      if (e === -1) { addText(src.slice(i), false); break; }
      const name = src.slice(i + 2, e).trim().toLowerCase().split(/\s/, 1)[0];
      closeElement(stack, name);
      i = e + 1;
      continue;
    }
    if (!isNameStart(next)) { addText('<', false); i++; continue; } // "a < b" in text

    const tag = readStartTag(src, i);
    i = tag.end;
    if (html) {
      if (BLOCK_ELEMENTS.has(tag.name)) applyImpliedEnd(stack, PARAGRAPH_END);
      const rule = IMPLIED_ENDS.get(tag.name);
      if (rule) applyImpliedEnd(stack, rule);
    }
    const el: XmlElement = { type: 'element', name: tag.name, attrs: tag.attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (tag.selfClosing || (html && VOID_ELEMENTS.has(tag.name))) continue;
    if (html && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const close = findEndTag(src, i, tag.name);
      el.children.push({ type: 'text', text: src.slice(i, close === -1 ? n : close) });
      if (close === -1) i = n;
      else { const e = src.indexOf('>', close); i = e === -1 ? n : e + 1; }
      continue;
    }
    if (stack.length < MAX_DEPTH) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------------------------------------
// Character references
// ---------------------------------------------------------------------------------------------

const NAMED_ENTITIES = new Map<string, string>(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', hellip: '…', bull: '•', middot: '·', dagger: '†', Dagger: '‡', permil: '‰',
  prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', oline: '‾', frasl: '⁄',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º',
  not: '¬', brvbar: '¦', uml: '¨', macr: '¯', acute: '´', cedil: '¸', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  ETH: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', THORN: 'Þ', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', omega: 'ω',
  infin: '∞', ne: '≠', le: '≤', ge: '≥', asymp: '≈', equiv: '≡', radic: '√', sum: '∑', loz: '◊', hearts: '♥',
}));

/** Browsers map numeric references in the C1 range to Windows-1252 glyphs ("&#146;" is a right single quote). */
const CP1252_C1: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{0,31});/g;

/** Decodes numeric and the common named character references; unknown references stay as written. */
export function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(ENTITY, (match: string, body: string): string => {
    if (body.charCodeAt(0) === 0x23) {
      const hex = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58;
      let cp = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (cp >= 0x80 && cp <= 0x9f && CP1252_C1[cp] !== undefined) cp = CP1252_C1[cp];
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES.get(body);
    return named !== undefined ? named : match;
  });
}

// ---------------------------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------------------------

/** 'dc:title' -> 'title' */
export function localName(name: string): string {
  const i = name.lastIndexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

function findFirst(root: XmlElement, local: string): XmlElement | null {
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el !== root && localName(el.name) === local) return el;
    for (let k = el.children.length - 1; k >= 0; k--) {
      const c = el.children[k];
      if (c.type === 'element') stack.push(c);
    }
  }
  return null;
}

/** All descendants with that local name, in document order. */
function findAll(root: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el !== root && localName(el.name) === local) out.push(el);
    for (let k = el.children.length - 1; k >= 0; k--) {
      const c = el.children[k];
      if (c.type === 'element') stack.push(c);
    }
  }
  return out;
}

function childElements(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (c.type === 'element' && localName(c.name) === local) out.push(c);
  return out;
}

function textContent(el: XmlElement): string {
  const parts: string[] = [];
  const stack: XmlNode[] = [el];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'text') { parts.push(node.text); continue; }
    for (let k = node.children.length - 1; k >= 0; k--) stack.push(node.children[k]);
  }
  return parts.join('');
}

function hasDescendant(el: XmlElement, local: string): boolean { return findFirst(el, local) !== null; }

// ---------------------------------------------------------------------------------------------
// XHTML -> paragraphs
// ---------------------------------------------------------------------------------------------

/** Elements whose content is never read: metadata, code, media, ruby annotations, EPUB switch cases. */
const SKIP_ELEMENTS = new Set([
  'script', 'style', 'head', 'title', 'template', 'svg', 'math', 'rt', 'rp', 'img', 'audio', 'video', 'object', 'iframe',
  'noscript', 'canvas', 'map', 'input', 'select', 'textarea', 'button', 'epub:case',
]);
/** epub:type tokens that mark navigation lists and notes (whole element skipped). */
const SKIP_EPUB_TYPES = new Set(['toc', 'landmarks', 'page-list', 'lot', 'loi', 'loa', 'lov', 'pagebreak', 'noteref']);
const SKIP_EPUB_TYPE_PREFIXES = ['footnote', 'endnote', 'rearnote'];
const SKIP_ROLES = new Set(['doc-pagebreak', 'doc-footnote', 'doc-endnote', 'doc-noteref', 'doc-toc', 'doc-pagelist']);
const HEADING_KIND: Record<string, ParagraphKind> = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };
const FOOTNOTE_MARKER = /^[\d*†‡§¶]{1,4}$/;

function skipEpubType(value: string): boolean {
  for (const token of value.toLowerCase().split(/\s+/)) {
    if (SKIP_EPUB_TYPES.has(token)) return true;
    for (const prefix of SKIP_EPUB_TYPE_PREFIXES) if (token.startsWith(prefix)) return true;
  }
  return false;
}

function shouldSkip(el: XmlElement): boolean {
  if (SKIP_ELEMENTS.has(el.name) || SKIP_ELEMENTS.has(localName(el.name))) return true;
  if (el.attrs.has('hidden')) return true;
  const role = el.attrs.get('role');
  if (role && role.toLowerCase().split(/\s+/).some((r) => SKIP_ROLES.has(r))) return true;
  for (const [name, value] of el.attrs) {
    if (name === 'epub:type' || (name.endsWith(':type') && name !== 'xlink:type')) {
      if (skipEpubType(value)) return true;
    }
  }
  // "<sup><a href="#fn1">1</a></sup>": an EPUB 2 style footnote marker; "mc<sup>2</sup>" is kept.
  if (localName(el.name) === 'sup' && hasDescendant(el, 'a') && FOOTNOTE_MARKER.test(normalizeWhitespace(textContent(el)))) return true;
  return false;
}

/** The kind for inline text directly inside a block element; `inherited` comes from an enclosing li/blockquote. */
function looseKindFor(name: string, inherited: ParagraphKind): ParagraphKind {
  const heading = HEADING_KIND[name];
  if (heading) return heading;
  if (name === 'pre') return 'pre';
  if (name === 'figcaption' || name === 'caption') return 'caption';
  if (name === 'li') return 'li';
  if (name === 'blockquote') return 'blockquote';
  return inherited;
}

/** The kind that p/div descendants of this block inherit: li and blockquote (innermost wins) and the strong kinds. */
function inheritedKindFor(name: string, own: ParagraphKind, inherited: ParagraphKind): ParagraphKind {
  if (name === 'li' || name === 'blockquote' || name === 'pre' || name === 'figcaption' || name === 'caption' || HEADING_KIND[name]) return own;
  return inherited;
}

/**
 * Flattens an XHTML document's <body> into paragraphs. Blocks never merge; inline elements concatenate
 * without added spaces ('word<i>italic</i>word' -> 'worditalicword'); <br> is a space; whitespace is
 * collapsed. Loose text directly inside a container (div, section, body) becomes its own paragraph.
 */
export function xhtmlToParagraphs(html: string): RawParagraph[] {
  const doc = parseXml(html, true);
  const out: RawParagraph[] = [];
  let pieces: string[] = [];
  let runKind: ParagraphKind = 'p';

  const flush = (): void => {
    if (pieces.length === 0) return;
    const text = normalizeWhitespace(pieces.join(''));
    pieces = [];
    if (text.length > 0) out.push({ kind: runKind, text });
  };

  const walkBlock = (el: XmlElement, loose: ParagraphKind, inherited: ParagraphKind): void => {
    flush();
    runKind = loose;
    for (const child of el.children) {
      if (child.type === 'text') { pieces.push(child.text); continue; }
      if (shouldSkip(child)) continue;
      const name = localName(child.name);
      if (BLOCK_ELEMENTS.has(name)) {
        const kind = looseKindFor(name, inherited);
        walkBlock(child, kind, inheritedKindFor(name, kind, inherited));
        runKind = loose;
      } else {
        walkInline(child, loose, inherited);
      }
    }
    flush();
  };

  const walkInline = (el: XmlElement, loose: ParagraphKind, inherited: ParagraphKind): void => {
    const name = localName(el.name);
    if (name === 'br') { pieces.push(' '); return; }
    if (name === 'q') pieces.push('“');
    for (const child of el.children) {
      if (child.type === 'text') { pieces.push(child.text); continue; }
      if (shouldSkip(child)) continue;
      const childName = localName(child.name);
      if (BLOCK_ELEMENTS.has(childName)) { // a block inside an inline (valid for <a>, common in sloppy markup)
        const kind = looseKindFor(childName, inherited);
        walkBlock(child, kind, inheritedKindFor(childName, kind, inherited));
        runKind = loose;
      } else {
        walkInline(child, loose, inherited);
      }
    }
    if (name === 'q') pieces.push('”');
  };

  walkBlock(findFirst(doc, 'body') ?? doc, 'p', 'p');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Paths and zip access
// ---------------------------------------------------------------------------------------------

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

/** Resolves an href against a directory inside the zip: strips fragment/query, %-decodes, normalises '.' and '..'. */
export function resolvePath(baseDir: string, href: string): string {
  let h = href.trim();
  const hash = h.indexOf('#');
  if (hash !== -1) h = h.slice(0, hash);
  const query = h.indexOf('?');
  if (query !== -1) h = h.slice(0, query);
  try { h = decodeURIComponent(h); } catch { /* malformed %-sequence: keep as written */ }
  h = h.replace(/\\/g, '/');
  const joined = h.startsWith('/') ? h.slice(1) : baseDir + h;
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}

/** Decodes an XML/XHTML entry: BOM-aware UTF-8/UTF-16, honouring a legacy encoding named in the XML declaration. */
function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return decodeTextBytes(bytes);
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 160)));
  const m = /^\s*<\?xml[^>]*encoding=["']([\w.:-]+)["']/i.exec(head);
  if (m && !/^utf-?8$/i.test(m[1])) {
    try { return new TextDecoder(m[1]).decode(bytes); } catch { /* unknown label: fall through to UTF-8 */ }
  }
  return decodeTextBytes(bytes);
}

/** Zip entries by path, with a case-insensitive fallback for packages whose hrefs disagree with the entry names. */
class ZipFiles {
  private lower: Map<string, string> | null = null;
  constructor(private readonly zip: JSZip) {}

  entry(path: string): JSZip.JSZipObject | null {
    const direct = this.zip.file(path);
    if (direct) return direct;
    if (!this.lower) {
      this.lower = new Map();
      for (const name of Object.keys(this.zip.files)) if (!this.zip.files[name].dir) this.lower.set(name.toLowerCase(), name);
    }
    const alt = this.lower.get(path.toLowerCase());
    return alt ? this.zip.file(alt) : null;
  }

  async readText(path: string): Promise<string | null> {
    const e = this.entry(path);
    if (!e) return null;
    return decodeXmlBytes(await e.async('uint8array'));
  }
}

// ---------------------------------------------------------------------------------------------
// Package document (OPF)
// ---------------------------------------------------------------------------------------------

interface ManifestItem { id: string; path: string; mediaType: string; properties: string[] }

interface EpubPackage {
  title?: string;
  author?: string;
  language?: string;
  manifest: ManifestItem[];
  byId: Map<string, ManifestItem>;
  byPath: Map<string, ManifestItem>;
  /** linear spine items, in reading order */
  spine: ManifestItem[];
  /** spine@toc: the NCX item id (EPUB 2) */
  tocId?: string;
}

const CONTENT_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html', 'application/xml', 'text/xml']);
const CONTENT_EXTENSION = /\.(xhtml|html|htm|xml)$/i;

function isContentDocument(item: ManifestItem): boolean {
  if (item.mediaType === 'application/xhtml+xml' || item.mediaType === 'text/html') return true;
  return (item.mediaType === '' || CONTENT_MEDIA_TYPES.has(item.mediaType)) && CONTENT_EXTENSION.test(item.path);
}

function findRootfile(container: XmlElement): string | null {
  const rootfiles = findAll(container, 'rootfile');
  const opf = rootfiles.find((r) => (r.attrs.get('media-type') ?? '').toLowerCase() === 'application/oebps-package+xml') ?? rootfiles[0];
  const fullPath = opf?.attrs.get('full-path');
  return fullPath ? resolvePath('', fullPath) : null;
}

function parsePackage(doc: XmlElement, opfDir: string): EpubPackage {
  const pkg: EpubPackage = { manifest: [], byId: new Map(), byPath: new Map(), spine: [] };

  const metadata = findFirst(doc, 'metadata');
  if (metadata) {
    const text = (local: string): string[] => findAll(metadata, local).map((el) => normalizeWhitespace(textContent(el))).filter((t) => t.length > 0);
    pkg.title = text('title')[0];
    const creators = [...new Set(text('creator'))];
    if (creators.length) pkg.author = creators.join(', ');
    pkg.language = text('language')[0];
  }

  const manifest = findFirst(doc, 'manifest');
  if (manifest) {
    for (const item of childElements(manifest, 'item')) {
      const id = item.attrs.get('id');
      const href = item.attrs.get('href');
      if (!id || !href) continue;
      const entry: ManifestItem = {
        id,
        path: resolvePath(opfDir, href),
        mediaType: (item.attrs.get('media-type') ?? '').trim().toLowerCase(),
        properties: (item.attrs.get('properties') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
      };
      pkg.manifest.push(entry);
      if (!pkg.byId.has(id)) pkg.byId.set(id, entry);
      if (!pkg.byPath.has(entry.path)) pkg.byPath.set(entry.path, entry);
    }
  }

  const spine = findFirst(doc, 'spine');
  if (spine) {
    pkg.tocId = spine.attrs.get('toc');
    const seen = new Set<string>();
    for (const ref of childElements(spine, 'itemref')) {
      if ((ref.attrs.get('linear') ?? 'yes').trim().toLowerCase() === 'no') continue;
      const idref = ref.attrs.get('idref');
      const item = idref ? pkg.byId.get(idref) : undefined;
      if (!item || seen.has(item.path)) continue;
      seen.add(item.path);
      pkg.spine.push(item);
    }
  }
  return pkg;
}

// ---------------------------------------------------------------------------------------------
// DRM detection
// ---------------------------------------------------------------------------------------------

/** Font obfuscation is not DRM: the text stays readable. */
const FONT_OBFUSCATION_ALGORITHMS = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

export const DRM_ERROR_MESSAGE = 'This EPUB is protected by DRM and cannot be opened';

/** Throws when META-INF/encryption.xml encrypts any content document (Adobe ADEPT, Apple FairPlay, LCP, ...). */
async function assertNotDrm(files: ZipFiles, pkg: EpubPackage): Promise<void> {
  const xml = await files.readText('META-INF/encryption.xml');
  if (xml === null) return;
  const spinePaths = new Set(pkg.spine.map((it) => it.path));
  for (const data of findAll(parseXml(xml), 'encrypteddata')) {
    const method = findFirst(data, 'encryptionmethod');
    const algorithm = method?.attrs.get('algorithm') ?? '';
    if (FONT_OBFUSCATION_ALGORITHMS.has(algorithm)) continue;
    const uri = findFirst(data, 'cipherreference')?.attrs.get('uri');
    if (!uri) continue;
    const path = resolvePath('', uri);
    const item = pkg.byPath.get(path);
    const isContent = item ? isContentDocument(item) : CONTENT_EXTENSION.test(path);
    if (isContent || spinePaths.has(path)) throw new Error(DRM_ERROR_MESSAGE);
  }
}

// ---------------------------------------------------------------------------------------------
// Table of contents labels
// ---------------------------------------------------------------------------------------------

/** EPUB 3 navigation document: <nav epub:type="toc"> links, resolved against the nav document's directory. */
function collectNavLabels(doc: XmlElement, navDir: string, labels: Map<string, string>): void {
  const navs = findAll(doc, 'nav');
  let tocs = navs.filter((nav) => [...nav.attrs].some(([k, v]) => k.endsWith('type') && v.toLowerCase().split(/\s+/).includes('toc')));
  if (tocs.length === 0) tocs = navs.slice(0, 1);
  for (const nav of tocs) {
    for (const a of findAll(nav, 'a')) {
      const href = a.attrs.get('href');
      if (!href) continue;
      const path = resolvePath(navDir, href);
      const label = normalizeWhitespace(textContent(a));
      if (label && !labels.has(path)) labels.set(path, label); // the first (outermost) entry for a document wins
    }
  }
}

/** EPUB 2 NCX: navPoint/navLabel/text + content@src, in document order (parents before children). */
function collectNcxLabels(doc: XmlElement, ncxDir: string, labels: Map<string, string>): void {
  for (const point of findAll(doc, 'navpoint')) {
    const label = childElements(point, 'navlabel')[0];
    const src = childElements(point, 'content')[0]?.attrs.get('src');
    if (!label || !src) continue;
    const text = normalizeWhitespace(textContent(label));
    const path = resolvePath(ncxDir, src);
    if (text && !labels.has(path)) labels.set(path, text);
  }
}

async function readTocLabels(files: ZipFiles, pkg: EpubPackage): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const nav = pkg.manifest.find((it) => it.properties.includes('nav'));
  if (nav) {
    const html = await files.readText(nav.path);
    if (html !== null) collectNavLabels(parseXml(html, true), dirOf(nav.path), labels);
  }
  const ncx = (pkg.tocId ? pkg.byId.get(pkg.tocId) : undefined) ?? pkg.manifest.find((it) => it.mediaType === 'application/x-dtbncx+xml');
  if (ncx) {
    const xml = await files.readText(ncx.path);
    if (xml !== null) collectNcxLabels(parseXml(xml), dirOf(ncx.path), labels);
  }
  return labels;
}

// ---------------------------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------------------------

function isHeading(kind: ParagraphKind): boolean { return kind === 'h1' || kind === 'h2' || kind === 'h3'; }

export const epubImporter: Importer = {
  kind: 'epub',
  async importBytes(bytes: Uint8Array, ctx: ImportContext): Promise<Book> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new Error('Not a valid EPUB: the file is not a readable zip archive');
    }
    const files = new ZipFiles(zip);

    const containerXml = await files.readText('META-INF/container.xml');
    if (containerXml === null) throw new Error('Not a valid EPUB: META-INF/container.xml is missing');
    const opfPath = findRootfile(parseXml(containerXml));
    if (!opfPath) throw new Error('Not a valid EPUB: container.xml names no package document');
    const opfXml = await files.readText(opfPath);
    if (opfXml === null) throw new Error(`Not a valid EPUB: package document "${opfPath}" is missing`);
    const pkg = parsePackage(parseXml(opfXml), dirOf(opfPath));

    await assertNotDrm(files, pkg);
    const tocLabels = await readTocLabels(files, pkg);

    const chapters: Chapter[] = [];
    for (const item of pkg.spine) {
      if (!isContentDocument(item)) continue;
      const html = await files.readText(item.path);
      if (html === null) continue;
      const paragraphs = assembleParagraphs(xhtmlToParagraphs(html), ctx.segmenter);
      if (paragraphs.length === 0) continue; // nothing to read: the item contributes no chapter
      const index = chapters.length;
      const heading = paragraphs.find((p) => isHeading(p.kind));
      const title = heading?.text ?? tocLabels.get(item.path) ?? `Chapter ${index + 1}`;
      chapters.push({ index, title, paragraphs });
    }
    if (chapters.length === 0) throw new Error('This EPUB contains no readable text');

    const book: Book = {
      id: ctx.id,
      title: pkg.title ?? chapters[0].title,
      source: { kind: 'epub', importedAt: new Date().toISOString() },
      chapters,
      names: [],
      stats: computeStats(chapters),
    };
    if (pkg.author) book.author = pkg.author;
    if (pkg.language) book.language = pkg.language;
    if (ctx.sourcePath) book.source.path = ctx.sourcePath;
    return book;
  },
};
