/**
 * Text preparation for Kokoro: splits the original text into word / punctuation pieces that keep their
 * character offsets, and normalises each word the way kokoro-js does (titles, currency, decimals, years,
 * clock times) so espeak-ng reads them naturally. Offsets stay those of the ORIGINAL text, which is what
 * the renderer highlights.
 */

export interface Piece {
  /** 'word' pieces are spoken; 'punct' pieces become prosody tokens; 'break' separates chunks (sentence end) */
  kind: 'word' | 'punct';
  /** text to phonemize (normalised); for punct: the vocab character(s) */
  spoken: string;
  /** offsets in the original text (UTF-16 units) */
  charIndex: number;
  charLength: number;
}

/** Punctuation characters Kokoro's vocabulary knows (prosody tokens). */
const VOCAB_PUNCT = new Set([';', ':', ',', '.', '!', '?', '—', '…', '"', '«', '»', '“', '”', '(', ')', '{', '}', '[', ']']);

const PUNCT_MAP: Record<string, string> = { '‘': '', '’': '', '(': '«', ')': '»', '[': '«', ']': '»', '{': '«', '}': '»', '“': '"', '”': '"', '«': '"', '»': '"', '、': ',', '。': '.', '！': '!', '，': ',', '：': ':', '；': ';', '？': '?', '–': '—', '-': '—', ';': ';' };

const TITLES: Record<string, string> = { mr: 'Mister', mrs: 'Missus', ms: 'Miss', dr: 'Doctor', st: 'Saint', prof: 'Professor', jr: 'Junior', sr: 'Senior', vs: 'versus', etc: 'etcetera' };

/** Words (letters/digits with inner apostrophes/hyphens, optional currency prefix, decimals and clock times) or single punctuation marks. */
const PIECE_RE = /[$£]?\p{N}[\p{N},]*(?:[.:]\p{N}+)?(?:s\b)?|[\p{L}\p{N}][\p{L}\p{N}'’]*(?:-[\p{L}\p{N}][\p{L}\p{N}'’]*)*\.?|[;:,.!?¡¿—–…"«»“”(){}\[\]]/gu;

export function splitPieces(text: string): Piece[] {
  const out: Piece[] = [];
  let m: RegExpExecArray | null;
  PIECE_RE.lastIndex = 0;
  while ((m = PIECE_RE.exec(text))) {
    const raw = m[0];
    if (/^[\p{L}\p{N}$£]/u.test(raw)) {
      let word = raw;
      let len = raw.length;
      // a trailing full stop belongs to the sentence unless the word is an abbreviation (Mr. Dr. etc.)
      if (word.endsWith('.')) {
        const base = word.slice(0, -1);
        if (TITLES[base.toLowerCase()] || /^(?:[A-Za-z]\.)+[A-Za-z]$/.test(base)) { word = base; }
        else { word = base; len -= 1; PIECE_RE.lastIndex -= 1; }
      }
      const spoken = normalizeWord(word, text.slice(m.index + raw.length, m.index + raw.length + 2));
      if (spoken) out.push({ kind: 'word', spoken, charIndex: m.index, charLength: len });
      continue;
    }
    const mapped = PUNCT_MAP[raw] ?? raw;
    if (mapped && VOCAB_PUNCT.has(mapped)) {
      const last = out[out.length - 1];
      // collapse runs of sentence punctuation ("?!", "...") into one token so the model sees a single pause
      if (last && last.kind === 'punct' && last.charIndex + last.charLength === m.index && /[.!?…]/.test(mapped) && /[.!?…]/.test(last.spoken)) { last.charLength += raw.length; if (mapped !== '.') last.spoken = mapped; continue; }
      out.push({ kind: 'punct', spoken: mapped, charIndex: m.index, charLength: raw.length });
    }
  }
  return out;
}

/** Expands a single word the way a reader would say it. `after` is the next two characters (for "Dr. X"). */
export function normalizeWord(word: string, after = ''): string {
  const w = word.replace(/[’]/g, "'");
  const lower = w.toLowerCase();
  if (TITLES[lower] && (lower !== 'st' || /^ [A-Z]/.test(after))) return TITLES[lower];
  if (/^[$£]/.test(w)) return money(w);
  if (/^\d+:\d\d$/.test(w)) return clock(w);
  if (/^\d[\d,]*(?:\.\d+)?s?$/.test(w)) return w.includes(',') ? w.replace(/,/g, '') : number(w);
  if (/^(?:[A-Za-z]\.)+[A-Za-z]\.?$/.test(w)) return w.replace(/\./g, ' ').trim().split(' ').join(' ');
  if (/^[A-Z]{2,5}$/.test(w) && !/^(?:OK|TV|UK|USA|US|UN|EU|NATO|NASA|BBC|CNN|DNA|FBI|CIA|GPS|PhD|AM|PM)$/.test(w)) return w.split('').join(' ');
  return w;
}

function number(w: string): string {
  const plural = w.endsWith('s') ? 's' : '';
  const n = plural ? w.slice(0, -1) : w;
  if (n.includes('.')) { const [a, b] = n.split('.'); return `${a} point ${b.split('').join(' ')}${plural}`; }
  const v = parseInt(n, 10);
  // years: 1100..1999 and 2010..2099 read in pairs ("nineteen ninety-nine", "twenty twenty")
  if (n.length === 4 && ((v >= 1100 && v <= 1999) || (v >= 2010 && v <= 2099)) && v % 100 !== 0) {
    const hi = n.slice(0, 2), lo = parseInt(n.slice(2), 10);
    return lo < 10 ? `${hi} oh ${lo}${plural}` : `${hi} ${lo}${plural}`;
  }
  if (n.length === 4 && v >= 1100 && v <= 1999 && v % 100 === 0) return `${n.slice(0, 2)} hundred${plural}`;
  return n + (plural ? ' s' : '');
}

function clock(w: string): string {
  const [h, m] = w.split(':').map(Number);
  if (m === 0) return `${h} o'clock`;
  if (m < 10) return `${h} oh ${m}`;
  return `${h} ${m}`;
}

function money(w: string): string {
  const unit = w[0] === '$' ? 'dollar' : 'pound';
  const cents = w[0] === '$' ? ['cent', 'cents'] : ['penny', 'pence'];
  const rest = w.slice(1).replace(/,/g, '');
  if (!/^\d/.test(rest)) return w;
  if (!rest.includes('.')) return `${rest} ${unit}${rest === '1' ? '' : 's'}`;
  const [a, b] = rest.split('.');
  const c = parseInt(b.padEnd(2, '0').slice(0, 2), 10);
  return `${a} ${unit}${a === '1' ? '' : 's'}${c ? ` and ${c} ${c === 1 ? cents[0] : cents[1]}` : ''}`;
}

/** Sentence-end punctuation, where long texts are cut into model-sized chunks. */
export function isBreak(piece: Piece): boolean { return piece.kind === 'punct' && /[.!?…]/.test(piece.spoken); }
