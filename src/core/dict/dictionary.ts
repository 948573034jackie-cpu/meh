import type { CefrLevel } from '@core/model';
import { CEFR_LEVELS } from '@core/model';
import type { DictData, DictRaw } from '@shared/api';
import type { Dictionary, DictEntry, LookupResult } from './types';

/**
 * Offline dictionary over the ECDICT-derived data in resources/dict/dict.json.gz.
 *
 * Lookup strategy (see `createDictionary`): the token is normalised, then tried as an exact headword,
 * with a possessive stripped, through the inflection map, through English suffix-stripping rules, and
 * finally with accents folded (and hyphens removed) — the first hit wins and `via` records which step
 * produced it. Everything is O(1) hash lookups per candidate; no per-headword variants are precomputed.
 */

/** Longest phrase in the data is 4 words; the API accepts up to 5. */
export const MAX_PHRASE_WORDS = 5;

const LEVEL_SOURCES: ReadonlySet<string> = new Set(['cefrj', 'oct', 'est']);

/* ------------------------------------------------------------------------------------------------
 * Text normalisation helpers (exported for reuse by names/analysis and for unit tests)
 * ---------------------------------------------------------------------------------------------- */

const isAlnum = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);

/**
 * Normalises a token as it appears in text: trims, straightens curly apostrophes, lower-cases, collapses
 * internal whitespace and strips surrounding punctuation/quotes. A trailing apostrophe is kept only when
 * it directly follows a letter ("parents'", "goin'") so possessive handling can see it.
 */
export function normalizeToken(token: string): string {
  let t = token.replace(/[‘’ʼ′`]/g, "'").trim().toLowerCase().replace(/\s+/g, ' ');
  let start = 0;
  while (start < t.length && !isAlnum(t[start])) start++;
  let end = t.length;
  while (end > start) {
    const ch = t[end - 1];
    if (isAlnum(ch)) break;
    if (ch === "'" && end - 2 >= start && isAlnum(t[end - 2])) break;
    end--;
  }
  t = t.slice(start, end);
  return t;
}

/** Removes diacritics and maps the few Latin ligatures/special letters ECDICT spells with plain ASCII. */
export function foldAccents(s: string): string {
  if (!/[^\x00-\x7f]/.test(s)) return s;
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o')
    .replace(/ð/g, 'd').replace(/þ/g, 'th').replace(/ł/g, 'l').replace(/đ/g, 'd');
}

/** "darcy's" -> "darcy", "parents'" -> "parents", "goin'" -> "goin"; null when there is nothing to strip. */
export function stripPossessive(t: string): string | null {
  if (t.length > 2 && t.endsWith("'s")) return t.slice(0, -2);
  if (t.length > 1 && t.endsWith("'")) return t.slice(0, -1);
  return null;
}

/**
 * Candidate stems for a token that is neither a headword nor a listed inflection, most specific first.
 * Candidates are only *proposed* here; the caller accepts the first one that is a headword, which is what
 * makes "-ly only if the stem exists" (and every other rule) safe. Deliberately not stripped: -ness, -ment,
 * -tion, -ful, -less — those are separate words and ECDICT lists them on their own.
 */
export function suffixCandidates(t: string): string[] {
  const out: string[] = [];
  const n = t.length;
  if (n < 3 || !/^[a-z][a-z'-]*$/.test(t)) return out;
  const push = (c: string): void => { if (c.length >= 2 && !out.includes(c)) out.push(c); };
  const end = (s: string): boolean => t.endsWith(s);
  // 'runn' -> 'run', 'stopp' -> 'stop', 'controll' -> 'control'. Not for ss/ff/zz, which end real words (kiss,
  // stuff, buzz) and are never doubled; 'll' words ('fill', 'smell') are found at the plain-stem step first.
  const undouble = (stem: string): string | null => {
    const a = stem[stem.length - 1];
    return stem.length >= 3 && a === stem[stem.length - 2] && /[bdgklmnprtv]/.test(a) ? stem.slice(0, -1) : null;
  };
  const stemVariants = (stem: string): void => {
    push(stem);            // walk-ed, fast-er, quick-ly
    push(stem + 'e');      // hop(e)-ed, nic(e)-er, mak(e)-ing, gentl(e)-y
    const u = undouble(stem);
    if (u) push(u);        // stopp-ed -> stop, bigg-er -> big, runn-ing -> run
  };

  // plurals / third person: -ies -> -ie|-y, -es after sibilants and -o, else -s
  if (end('ies') && n > 4) { push(t.slice(0, -1)); push(t.slice(0, -3) + 'y'); }            // movies -> movie, cities -> city
  else if (end('es') && n > 3) {
    if (/(?:[sxz]|ch|sh|o)es$/.test(t)) { push(t.slice(0, -2)); push(t.slice(0, -1)); }      // boxes -> box, goes -> go, shoes -> shoe
    else { push(t.slice(0, -1)); push(t.slice(0, -2)); }                                      // makes -> make
  } else if (end('s') && !end('ss') && n > 2) push(t.slice(0, -1));                           // cats -> cat

  // past tense / participle
  if (end('ied') && n > 4) { push(t.slice(0, -1)); push(t.slice(0, -3) + 'y'); }             // tried -> try (died -> die via -ed below)
  else if (end('ed') && n > 3) stemVariants(t.slice(0, -2));                                 // walked, hoped, stopped

  // progressive / gerund
  if (end('ing') && n > 4) {
    if (end('ying')) push(t.slice(0, -4) + 'ie');                                             // lying -> lie, dying -> die
    stemVariants(t.slice(0, -3));                                                             // walking, making, running
  }

  // comparative / superlative (also agent nouns such as 'worker' -> 'work')
  if (end('iest') && n > 5) push(t.slice(0, -4) + 'y');                                       // happiest -> happy
  else if (end('est') && n > 4) stemVariants(t.slice(0, -3));                                 // fastest, nicest, biggest
  if (end('ier') && n > 4) push(t.slice(0, -3) + 'y');                                        // happier -> happy
  else if (end('er') && n > 3) stemVariants(t.slice(0, -2));                                  // faster, nicer, bigger

  // adverbs: accepted only when the stem is itself a headword
  if (end('ly') && n > 4) {
    if (end('ily')) push(t.slice(0, -3) + 'y');                                               // happily -> happy
    if (end('ically')) push(t.slice(0, -4));                                                  // basically -> basic
    const stem = t.slice(0, -2);
    push(stem); push(stem + 'e'); push(stem + 'l');                                           // quickly, truly (true), fully (full)
    push(t.slice(0, -1) + 'e');                                                               // gently -> gentle, despicably -> despicable
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Gloss helpers
 * ---------------------------------------------------------------------------------------------- */

/** Leading part-of-speech tags: "n.", "vt.", "vt.& vi.", "a. & n.", "[医]", "[网络]", "<法>" ... */
const POS_RE = /^((?:[a-z]+\.)(?:\s*&?\s*[a-z]+\.)*|\[[^\]]*\]|<[^>]{1,12}>)\s*/;

/** Splits an ECDICT Chinese gloss into lines of {pos, zh}; lines without a tag get pos ''. */
export function parseGloss(t: string): { pos: string; zh: string }[] {
  const out: { pos: string; zh: string }[] = [];
  for (const raw of t.split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = POS_RE.exec(line);
    if (m) out.push({ pos: m[1].replace(/\s+/g, ''), zh: line.slice(m[0].length).trim() });
    else out.push({ pos: '', zh: line });
  }
  return out;
}

/** First gloss line ("n. 房子, 住宅…") cut to at most `maxChars` characters at a sense boundary where possible. */
export function firstGloss(entry: Pick<DictEntry, 'zh'> | null | undefined, maxChars = 40): string {
  if (!entry) return '';
  const g = parseGloss(entry.zh).find((x) => x.zh.length > 0);
  if (!g) return '';
  const s = g.pos ? `${g.pos} ${g.zh}` : g.zh;
  if (maxChars <= 0 || s.length <= maxChars) return s;
  const cut = s.slice(0, Math.max(1, maxChars - 1));
  let sep = -1;
  for (const d of [', ', ',', '，', '; ', ';', '；', '、']) sep = Math.max(sep, cut.lastIndexOf(d));
  const head = sep >= Math.floor(maxChars / 3) ? cut.slice(0, sep) : cut;
  return `${head.trimEnd()}…`;
}

/* ------------------------------------------------------------------------------------------------
 * Dictionary
 * ---------------------------------------------------------------------------------------------- */

function toLevel(l: string): CefrLevel {
  return (CEFR_LEVELS as string[]).includes(l) ? (l as CefrLevel) : 'C2';
}

function toIpa(i: string): string {
  const s = i.trim().replace(/^\/+|\/+$/g, '');
  return s ? `/${s}/` : '';
}

export function createDictionary(data: DictData): Dictionary {
  // Maps rather than the raw objects: no prototype keys ("constructor" is a real headword, "__proto__" must not be)
  // and predictable hash performance for 50k keys.
  const words = new Map<string, DictRaw>(Object.entries(data.w));
  const forms = new Map<string, string>(Object.entries(data.f));
  const entries = new Map<string, DictEntry>();
  // First words of multi-word headwords, so phrase scans over ordinary prose can fail fast.
  const phraseStarts = new Set<string>();
  for (const key of words.keys()) {
    const sp = key.indexOf(' ');
    if (sp > 0) phraseStarts.add(key.slice(0, sp));
  }

  const entry = (headword: string): DictEntry => {
    let e = entries.get(headword);
    if (!e) {
      const raw = words.get(headword)!;
      e = {
        word: headword,
        ipa: toIpa(raw.i ?? ''),
        zh: (raw.t ?? '').replace(/\r/g, '').trim(),
        tags: raw.g ? raw.g.split(/\s+/).filter(Boolean) : [],
        frq: raw.f | 0,
        bnc: raw.b | 0,
        collins: raw.c | 0,
        oxford: raw.o === 1,
        level: toLevel(raw.l),
        levelSource: LEVEL_SOURCES.has(raw.s) ? (raw.s as DictEntry['levelSource']) : 'est',
      };
      entries.set(headword, e);
    }
    return e;
  };

  /**
   * Builds the result for a matched headword `h`. When `h` is itself a listed inflection of another headword
   * ('running' -> 'run', 'children' -> 'child', 'better' -> 'good') the vocabulary lemma is always that base
   * form, so that knowing "run" covers "running". The entry shown is h's own when it comes from a real CEFR
   * list (it is then a vocabulary item in its own right: 'boring' A1 vs 'bore' B1); when h's level is only
   * estimated the base entry is far more reliable ('children' est B2 vs 'child' A1, 'stopped' est C2).
   */
  const resolve = (h: string, via: LookupResult['via']): LookupResult => {
    const base = forms.get(h);
    if (base !== undefined && base !== h && words.has(base)) {
      if (words.get(h)!.s === 'est') return { entry: entry(base), lemma: base, via: via === 'exact' ? 'form' : via };
      return { entry: entry(h), lemma: base, via };
    }
    return { entry: entry(h), lemma: h, via };
  };

  /** The exact -> possessive -> forms -> suffix chain on an already normalised token. */
  const lookupCore = (t: string): LookupResult | null => {
    if (!t) return null;
    if (words.has(t)) return resolve(t, 'exact');
    const poss = stripPossessive(t);
    if (poss !== null) {
      const r = lookupCore(poss);
      if (r) return r.via === 'exact' ? { ...r, via: 'possessive' } : r;
    }
    const base = forms.get(t);
    if (base !== undefined && words.has(base)) return { entry: entry(base), lemma: base, via: 'form' };
    for (const c of suffixCandidates(t)) if (words.has(c)) return resolve(c, 'suffix');
    return null;
  };

  const lookup = (token: string): LookupResult | null => {
    const t = normalizeToken(token);
    if (!t) return null;
    const r = lookupCore(t);
    if (r) return r;
    const folded = foldAccents(t);
    if (folded !== t) {
      const r2 = lookupCore(folded);
      if (r2) return { ...r2, via: 'fold' };
    }
    // Old-fashioned hyphenation ("to-morrow", "co-operate") — the joined spelling is the modern headword.
    if (folded.includes('-')) {
      const r3 = lookupCore(folded.replace(/-/g, ''));
      if (r3) return { ...r3, via: 'fold' };
    }
    return null;
  };

  const lemmaOf = (token: string): string => {
    const r = lookup(token);
    if (r) return r.lemma;
    const t = foldAccents(normalizeToken(token));
    return stripPossessive(t) ?? t;
  };

  const lookupPhrase = (ws: string[]): LookupResult | null => {
    if (ws.length < 2 || ws.length > MAX_PHRASE_WORDS) return null;
    const norm = ws.map(normalizeToken);
    if (norm.some((x) => !x || x.includes(' '))) return null;
    const first = norm[0];
    if (!phraseStarts.has(first) && !phraseStarts.has(foldAccents(first)) && !phraseStarts.has(lemmaOf(first))) return null;
    const exact = norm.join(' ');
    if (words.has(exact)) return { entry: entry(exact), lemma: exact, via: 'exact' };
    const folded = norm.map(foldAccents).join(' ');
    if (folded !== exact && words.has(folded)) return { entry: entry(folded), lemma: folded, via: 'fold' };
    // "looking forward to" -> "look forward to", "gave up" -> "give up"
    const lemmatised = norm.map(lemmaOf).join(' ');
    if (lemmatised !== exact && words.has(lemmatised)) return { entry: entry(lemmatised), lemma: lemmatised, via: 'form' };
    return null;
  };

  return { size: words.size, lookup, lookupPhrase, lemmaOf };
}
