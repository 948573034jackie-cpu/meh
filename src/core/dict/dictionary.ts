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

/* ------------------------------------------------------------------------------------------------
 * Phrase list hygiene
 * ---------------------------------------------------------------------------------------------- */

/** Placeholder slots in a headword ("pick sth up", "tell sb off"): never literal text, so never matchable. */
const PLACEHOLDER_RE = /(?:^| )(?:sth|sb)(?: |$)/;

/** Gloss markers that make a two-word entry an idiom rather than a free combination ("high ground": phr.). */
const IDIOM_MARKER_RE = /phr\.|习语|成语|俗语|谚|喻/;

/**
 * Comparatives/superlatives whose lemma is a different word ("better" -> "good"). Lemmatising them inside a
 * phrase would turn "better for" into the entry "good for", so they only ever match as written.
 */
const SUPPLETIVE = new Set(['better', 'best', 'worse', 'worst', 'more', 'most', 'less', 'least', 'further', 'furthest', 'farther', 'farthest']);

const EASY: ReadonlySet<string> = new Set(['A1', 'A2']);

/** CJK characters too common in glosses to show that a translation is built from a word's own gloss. */
const GLOSS_STOP = new Set('的地得之一个人者性化物有于为在了是等或与和及其用'.split(''));

function glossChars(t: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const g of parseGloss(t ?? '')) for (const ch of g.zh) if (/\p{Script=Han}/u.test(ch) && !GLOSS_STOP.has(ch)) out.add(ch);
  return out;
}

const shares = (a: Set<string>, b: Set<string>): boolean => { for (const x of a) if (b.has(x)) return true; return false; };

function posTags(t: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const g of parseGloss(t ?? '')) for (const p of g.pos.split('&')) if (p) out.add(p);
  return out;
}

export type PhraseClass = 'ok' | 'placeholder' | 'free-combination';

/**
 * Whether a multi-word headword is a learnable phrase. ECDICT lists many transparent compounds ("old man",
 * "old lady", "big city") whose level is only *estimated* (C1 by default for a phrase with no Collins rating),
 * which made the reader flag them as advanced phrases. Rule — a free combination, not offered as a phrase, is:
 *   - a phrase whose level does not come from a CEFR list (source 'est'),
 *   - of exactly two words, adjective (not also a preposition: "in case", "on board") + noun,
 *   - both words themselves A1-A2,
 *   - with no idiom marker in its gloss, and
 *   - whose Chinese gloss is built from the two words' own glosses ("old man" 老头儿/丈夫 from old 老的 and
 *     man 丈夫; "big city" 大城市): the meaning is the sum of the parts. Idioms whose translation shares
 *     nothing with a part ("red tape" 官样文章, "big deal", "small print") are kept.
 * Entries with a placeholder slot ("pick sth up") can never match running text and are skipped too.
 * Single-word lookups are unaffected.
 */
export function classifyPhrase(key: string, w: ReadonlyMap<string, DictRaw>): PhraseClass {
  if (PLACEHOLDER_RE.test(key)) return 'placeholder';
  const raw = w.get(key);
  if (!raw || raw.s === 'cefrj' || raw.s === 'oct') return 'ok';
  if (IDIOM_MARKER_RE.test(raw.t ?? '')) return 'ok';
  const parts = key.split(' ');
  if (parts.length !== 2) return 'ok';
  const a = w.get(parts[0]);
  const n = w.get(parts[1]);
  if (!a || !n || !EASY.has(a.l) || !EASY.has(n.l)) return 'ok';
  const aPos = posTags(a.t);
  if (!aPos.has('a.') && !aPos.has('adj.') || aPos.has('prep.')) return 'ok';
  if (!posTags(n.t).has('n.')) return 'ok';
  const own = glossChars(raw.t);
  return shares(own, glossChars(a.t)) && shares(own, glossChars(n.t)) ? 'free-combination' : 'ok';
}

/** The multi-word headwords dropped from phrase matching, with the reason (for reporting and tests). */
export function droppedPhrases(data: DictData): { key: string; reason: Exclude<PhraseClass, 'ok'> }[] {
  const w = new Map<string, DictRaw>(Object.entries(data.w));
  const out: { key: string; reason: Exclude<PhraseClass, 'ok'> }[] = [];
  for (const k of w.keys()) {
    if (!k.includes(' ')) continue;
    const c = classifyPhrase(k, w);
    if (c !== 'ok') out.push({ key: k, reason: c });
  }
  return out;
}

export function createDictionary(data: DictData): Dictionary {
  // Maps rather than the raw objects: no prototype keys ("constructor" is a real headword, "__proto__" must not be)
  // and predictable hash performance for 50k keys.
  const words = new Map<string, DictRaw>(Object.entries(data.w));
  const forms = new Map<string, string>(Object.entries(data.f));
  const entries = new Map<string, DictEntry>();
  // Learnable multi-word headwords (see classifyPhrase), and their first words so phrase scans over
  // ordinary prose can fail fast.
  const phrases = new Set<string>();
  const phraseStarts = new Set<string>();
  for (const key of words.keys()) {
    const sp = key.indexOf(' ');
    if (sp <= 0 || classifyPhrase(key, words) !== 'ok') continue;
    phrases.add(key);
    phraseStarts.add(key.slice(0, sp));
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

  /**
   * Phrase lookup is token-for-token: the n words given must spell an n-word headword, so a phrase is never
   * matched with extra words around it. Lemmatisation is allowed only where an inflected entry form is
   * plausible: the first word (the verb of "gave up", "looking forward to") and the last word (the plural of
   * "human beings"), never a middle word and never a suppletive comparative ("better for" is not "good for").
   */
  const lookupPhrase = (ws: string[]): LookupResult | null => {
    if (ws.length < 2 || ws.length > MAX_PHRASE_WORDS) return null;
    const norm = ws.map(normalizeToken);
    if (norm.some((x) => !x || x.includes(' '))) return null;
    const first = norm[0];
    const lemFirst = SUPPLETIVE.has(first) ? first : lemmaOf(first);
    if (!phraseStarts.has(first) && !phraseStarts.has(foldAccents(first)) && !phraseStarts.has(lemFirst)) return null;
    const exact = norm.join(' ');
    if (phrases.has(exact)) return { entry: entry(exact), lemma: exact, via: 'exact' };
    const foldedWs = norm.map(foldAccents);
    const folded = foldedWs.join(' ');
    if (folded !== exact && phrases.has(folded)) return { entry: entry(folded), lemma: folded, via: 'fold' };
    const lastIdx = foldedWs.length - 1;
    const last = foldedWs[lastIdx];
    const lemLast = SUPPLETIVE.has(last) ? last : lemmaOf(last);
    const middle = foldedWs.slice(1, lastIdx);
    for (const [a, b] of [[lemFirst, last], [foldedWs[0], lemLast], [lemFirst, lemLast]]) {
      const cand = [a, ...middle, b].join(' ');
      if (cand !== folded && phrases.has(cand)) return { entry: entry(cand), lemma: cand, via: 'form' };
    }
    return null;
  };

  return { size: words.size, lookup, lookupPhrase, lemmaOf };
}
