/**
 * I Know Book: the reading and listening app (16 Nov 2026). One calm page with the book's text in pages.
 *
 * READING (silent): swipe to turn the page, tap a word = its card and the tutor's explanation, select a few words or a
 * sentence = the same for them. After an explanation nothing plays by itself.
 * LISTENING: the book is read aloud, sentence by sentence, the page follows. The stop is the one of I Know (YouTube):
 * the sentence ends → a hard word's big card (the word, how it sounds, what it means HERE) → the word once → 5 seconds
 * to tap "I know" → the explanation → the word three times → the card closes → the sentence again → on.
 * What is hard is decided exactly as in I Know: my level (A1 … C2), how much of each kind to explain, the switches,
 * my own word list, and not again within 1,000 words heard. The words, the level and the keys are the same store.
 *
 * COST: nothing is asked of the AI when a book opens or a page turns. Listening asks once per chapter for its phrases
 * and hard sentences (kept); a card asks for one small meaning (kept) and, when not "I know", one explanation.
 */
import type { Book, Position } from '@core/model';
import { sentenceKey } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { PhraseHit } from '@shared/api';
import type { TtsEngine, SpeakHandle } from '@core/tts/engine';
import type { Settings, VocabState, WordStatus } from '@shared/settings';
import { getEngine, useFakeEngine, defaultVoiceFor } from '@core/tts/registry';
import { getSentence, contextAround } from '@core/nav';
import { detectNames } from '@core/dict/names';
import { createSegmenter } from '@core/segment';
import { StreamSentenceSplitter } from '@core/listen/sentences';
import { explain as aiExplain, complete, getDictionary, getZipf } from './ai-client';
import * as store from './store';
import { icon } from './icons';
import { cloudEngine, resolveVoice, VoiceWithBackup, WithVolume, sliderGain, OPENAI_VOICES, ELEVEN_VOICES, AZURE_VOICES, type VoiceKind } from './voice';
import { speechifyRowsHtml, wireSpeechifyRows, SPEECHIFY_CHOICE, SPEECHIFY_CSS } from './speechify-rows';
import { unknownChance, phraseSig, type LevelMeta } from './level-db';
import { buildItemsPrompt, parseItems, type AiItem } from './level-check';
import { scoreSentences, selectStopsByLevel, keepHardest, kindWith, itemsToHits, stopKindOf, type SentenceScore, type StopCaps } from './level-stops';
import { RuleGuard, type RuleRequest } from './level-rule';
import { buildHardSentencesPrompt, parseHardSentences } from './hard-sentences';
import { rawFromPlain, rawFromTextFile, chapterOf, charsBefore, pdfToText } from './reader-text';
import { parseEpub, type RawBook, type RawChapter } from './epub';
import { bookStore, shelfOf, percentOf, sortShelf, charsOf, type ShelfBook, type StoredText } from './book-store';
import { splitChapters, needsSplit, wasCut, recut, partTitle, blockOfParagraph, readLetters, storedLetter, SPLIT_VERSION } from './book-split';
import { markOf, cardOf } from './word-level';
import { myLevelOf, cefrToLevel, wordNumber, phraseDifficulty, harderThan, belowLevel, clampPct, DEFAULT_EXPLAIN_PCT, CEFR_MID } from './level100';
import { HeardCounter, readHeard } from './heard';
import { buildWordPrompt, parseWordMeanings } from './zh';
import { saveExplained } from './word-save';
import { nativeTranslate, appPost, inApp } from './native-bridge';
import { readLook, themeOf, paletteOf, textVars, lettersPerLine, coverOf, DEFAULT_LOOK, THEMES, FONTS, LIMITS, type Look } from './book-look';
import { SAMPLE_TITLE, SAMPLE_AUTHOR, SAMPLE_TEXT } from './book-sample';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const segmenter = createSegmenter();
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * After the next frame is on the screen: work that must never sit between a tap and what the tap shows (a write to
 * the store, a pass over the whole part). In the order it was asked. A hidden page gets no frames: it is done all the same.
 */
const laterQ: (() => void)[] = [];
let laterGen = 0, laterSet = false;
function runLater(): void { laterSet = false; for (const f of laterQ.splice(0)) { try { f(); } catch { /* the next one still runs */ } } }
function afterPaint(fn: () => void): void {
  laterQ.push(fn);
  if (laterSet) return;
  laterSet = true;
  const my = ++laterGen;
  const run = () => { if (my === laterGen && laterSet) runLater(); };
  requestAnimationFrame(() => setTimeout(run, 0));
  setTimeout(run, 80);
}

// ---- quiet line icons ------------------------------------------------------------------------------------------
// the one icon set (SF Symbols' names; the same symbols as the native views)
const ICON = {
  gear: icon('slider.horizontal.3'), back: icon('chevron.left'), prev: icon('chevron.left'), next: icon('chevron.right'),
  play: icon('play.fill'), pause: icon('pause.fill'), sback: icon('backward.fill'), sfwd: icon('forward.fill'),
  book: icon('book'), ear: icon('headphones'), plus: icon('plus'), tutor: icon('slider.horizontal.3'), more: icon('ellipsis'),
};

// ---- what is open ------------------------------------------------------------------------------------------------
let shelf: ShelfBook | null = null;
let stored: StoredText | null = null;
let book: Book;
let chapter = 0;
const cut = new Set<number>();
let order: Position[] = [];
/** the words before each sentence of the chapter (for the "words heard" counter) */
let wordsBefore: number[] = [];
let dict: Dictionary;
let names = new Set<string>();
let zipf: (w: string) => number | null = () => null;
let vocab: VocabState = { words: {}, marked: {} };
let level: LevelMeta;
let extras: store.YtExtras = store.DEFAULT_EXTRAS;
let settings: Settings;
let keys: store.Keys = {};
let look: Look = DEFAULT_LOOK;
const LOOK_KEY = 'bkLook', OPEN_KEY = 'bkOpen', MODE_KEY = 'bkMode';
let mode: 'read' | 'listen' = 'read';

// the voice
let tts: TtsEngine;
let voiceId = '';
let voiceKind: VoiceKind = 'mac';
let macVoices: { id: string; name: string; lang: string }[] = [];
const spokenLog: string[] = [];

// listening
let index = 0;
let playing = false;
let loop = 0;
let speaking: SpeakHandle | null = null;
let explaining: { cancel(): void } | null = null;
const heardKeys = new Set<string>();
const stopped = new Set<string>();
let stops = 0;
let heard = new HeardCounter();

// what is hard in this chapter
let phrases: Record<string, PhraseHit[]> = {};
let hardSet = new Set<string>();
/** the part's hard sentences as the heavy pass left them (rescore); `scores` and `stopSet` are these without what I know now */
let kept: SentenceScore[] = [];
let scores = new Map<string, SentenceScore>();
let stopSet = new Set<string>();
let rankWords: Record<string, WordStatus> | null = null;
let rankDone: Set<string> | null = null;
let aiStarted: Promise<void> | null = null;
let aiCalls = 0;

const tutorOn = (): boolean => extras.tutorOn !== false;
const hasAi = (): boolean => !!(keys.anthropic || keys.openai);
const cardBig = (): boolean => extras.cardSize !== 'small';
const pcts = (): StopCaps => { const all = clampPct(extras.explainPct ?? DEFAULT_EXPLAIN_PCT); return { word: clampPct(extras.pctWords ?? all), phrase: clampPct(extras.pctPhrases ?? all), sentence: clampPct(extras.pctSentences ?? all) }; };
const caps = (): StopCaps => { const c = (on: boolean | undefined) => (on === false ? 0 : 1); return { word: c(extras.stopItemsOn), phrase: c(extras.stopPhrasesOn), sentence: c(extras.stopHardOn) }; };
const systemDark = (): boolean => { try { return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches; } catch { return false; } };

// ---- small things on the screen --------------------------------------------------------------------------------
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string, ms = 3200): void {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text: string | null): void { const b = $('busy'); b.hidden = text === null; b.textContent = text ?? ''; }

function debug(): void {
  if (!extras.fakeVoice) return;
  const c = $('card'), sm = $('small');
  const shown = (el: HTMLElement) => !el.hidden && getComputedStyle(el).display !== 'none';
  document.documentElement.dataset.drDebug = JSON.stringify({
    open: shelf?.id ?? null, chapter, chapters: stored?.chapters.length ?? 0, sentences: order.length, page, pages, mode, playing, index, stops, chosen: stopSet.size,
    spoken: spokenLog.slice(-40), stopsAt: [...stopSet].slice(0, 8).map((k) => `${k}:${(scores.get(k)?.items ?? []).join('+')}${scores.get(k)?.hard ? '(hard)' : ''}`), place: shelf?.place ?? null, percent: shelf?.percent ?? 0, aiCalls, voice: voiceKind,
    card: shown(c) ? { big: true, kind: c.classList.contains('sentence') ? 'sentence' : 'word', word: c.querySelector('.word')!.textContent, zh: c.querySelector('.zh')!.textContent, ipa: c.querySelector('.ipa')!.textContent }
      : shown(sm) ? { big: false, kind: 'word', word: sm.querySelector('.word')!.textContent, zh: sm.querySelector('.zh')!.textContent, ipa: sm.querySelector('.ipa')!.textContent } : null,
    marks: { hard: document.querySelectorAll('#flow .w.hard').length, learning: document.querySelectorAll('#flow .w.learning').length },
    look: { theme: themeOf(look, systemDark()).id, size: look.size, font: look.font }, chrome: !$('rd').classList.contains('plain'), waiting: !!answer,
    ai: shelf && book ? aiId() : '', split: shelf?.split ?? 0, heavy,
    deviceSaid: fakeDevice ? fakeDevice.spoken.slice(-12).map((x) => x.text) : [], voiceError: lastVoiceError,
  });
}

// ---- the look ----------------------------------------------------------------------------------------------------
/** what of the look moves the text (a colour does not: the page is not measured again for it) */
let lookShape = '';
function applyLook(relayout = true): void {
  const root = document.documentElement;
  const theme = themeOf(look, systemDark());
  // (only what changed is written: a value written again would have every word of the page styled again)
  for (const [k, v] of Object.entries({ ...paletteOf(theme), ...textVars(look) })) if (root.style.getPropertyValue(k) !== v) root.style.setProperty(k, v);
  // (theme: the bars, buttons and sheets (theme.css) are light on a light page, dark on a dark one)
  for (const [k, v] of Object.entries({ align: look.align, dark: theme.dark ? '1' : '0', theme: theme.dark ? 'dark' : 'light', marks: extras.stopItemsOn === false ? '0' : '1' })) if (root.dataset[k] !== v) root.dataset[k] = v;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
  const shape = JSON.stringify({ ...look, theme: '', bg: '', fg: '', tapEdges: false });
  const moved = shape !== lookShape;
  lookShape = shape;
  if (relayout && shelf && moved) layout(true);
  debug();
}
let lookSave: ReturnType<typeof setTimeout> | null = null;
let lookSoon: ReturnType<typeof setTimeout> | null = null;
/** `soon`: a slider is being moved: the page follows within 150 ms (one layout, not one for every step of the slider) */
function setLook(patch: Partial<Look>, soon = false): void {
  look = readLook({ ...look, ...patch });
  if (soon) lookSoon ??= setTimeout(() => { lookSoon = null; applyLook(); }, 150);
  else { if (lookSoon) { clearTimeout(lookSoon); lookSoon = null; } applyLook(); }
  if (lookSave) clearTimeout(lookSave);
  lookSave = setTimeout(() => { lookSave = null; void chrome.storage.local.set({ [LOOK_KEY]: look }).catch(() => undefined); }, 300);
}

// ---- the library ---------------------------------------------------------------------------------------------------
function coverHtml(b: Pick<ShelfBook, 'title' | 'author'>): string {
  const c = coverOf(b.title || 'Untitled');
  return `<div class="cover" style="background:${c.ink}"><span class="ct">${esc(b.title || 'Untitled')}</span><span class="ca">${esc(b.author || '')}</span></div>`;
}
async function paintLibrary(): Promise<void> {
  const list = sortShelf(await (await bookStore()).list().catch(() => [] as ShelfBook[]));
  $('empty').hidden = list.length > 0;
  const hero = $('hero'), shelfBox = $('shelf');
  hero.hidden = !list.length; shelfBox.hidden = !list.length;
  if (list.length) {
    const b = list[0];
    const n = b.chapterTitles.length;
    hero.dataset.id = b.id;
    hero.innerHTML = `<button data-a="open" aria-label="Continue ${esc(b.title)}">${coverHtml(b)}</button>
      <div class="info"><span class="eyebrow">${b.percent > 0 ? 'Continue' : 'Start'}</span><h2>${esc(b.title || 'Untitled')}</h2>
        <span class="by">${esc([b.author, n > 1 ? `chapter ${Math.min(n, b.place.chapter + 1)} of ${n}` : '', `${b.percent}%`].filter(Boolean).join(' · '))}</span>
        <div class="bar-prog"><i style="width:${b.percent}%"></i></div>
        <div class="acts"><button class="pill go" data-a="open">${ICON.book} Read</button><button class="pill" data-a="listen">${ICON.ear} Listen</button><button class="round" data-a="more" aria-label="More for ${esc(b.title)}">${ICON.more}</button></div><span class="t" hidden>${esc(b.title || 'Untitled')}</span></div>`;
    // (the book in the big card above is not shown a second time)
    $('grid').innerHTML = list.slice(1).map((x) => `<div class="tile" data-id="${esc(x.id)}"><button data-a="open" aria-label="Open ${esc(x.title)}">${coverHtml(x)}</button><span class="t">${esc(x.title || 'Untitled')}</span>
      <span class="p" style="display:flex;justify-content:space-between;align-items:center"><span>${x.percent}%</span><button data-a="more" aria-label="More for ${esc(x.title)}" style="width:44px;height:44px;display:grid;place-items:center;margin:-14px -12px -14px 0">${ICON.more}</button></span></div>`).join('')
      + `<div class="tile add"><button data-a="add" aria-label="Add a book"><div class="cover">${ICON.plus}</div></button><span class="t">Add a book</span><span class="p">EPUB · PDF · text</span></div>`;
  }
  document.body.dataset.books = String(list.length);
  debug();
}
function showLibrary(): void {
  setPlaying(false);
  savePlaceNow();
  closeCard();
  closeSheet();
  void chrome.storage.local.set({ [OPEN_KEY]: '' }).catch(() => undefined);
  $('rd').hidden = true; $('caption').hidden = true;
  $('lib').hidden = false;
  shelf = null; stored = null;
  clearFlow();
  delete document.body.dataset.sentences;
  void paintLibrary();
}

const hex = async (data: BufferSource): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
async function addBook(id: string, kind: ShelfBook['kind'], raw: RawBook, then: 'read' | 'listen' = 'read'): Promise<void> {
  const whole = raw.chapters.filter((c) => c.blocks.some((b) => b.text.trim()));
  // (long paragraphs and long chapters are cut into light parts: a page turns and a tap answers fast, whatever the file)
  const chapters = splitChapters(whole);
  if (!chapters.length) throw new Error('No readable text was found in it.');
  const st = await bookStore();
  if (await st.has(id).catch(() => false)) { const had = await st.get(id).catch(() => null); if (had) { await openBook(id, then, had); return; } }
  const fresh: ShelfBook = { ...shelfOf(id, kind, { ...raw, chapters }), ...(wasCut(whole, chapters) ? { split: SPLIT_VERSION } : {}) };
  const text: StoredText = { id, chapters };
  await st.add(fresh, text);
  // (the text is in hand: it is not read back from the store)
  await openBook(id, then, { shelf: fresh, text });
}
async function openFile(f: File): Promise<void> {
  const msg = $('lib-msg');
  msg.textContent = '';
  busy('Opening the book…');
  try {
    const title = f.name.replace(/\.[^.]+$/, '');
    const bytes = await f.arrayBuffer();
    if (/\.(azw3?|mobi|kfx|prc|ibooks)$/i.test(f.name)) throw new Error('Kindle and Apple Books files cannot be opened. Use an EPUB without a lock, a PDF or a text file.');
    if (/\.epub$/i.test(f.name) || f.type === 'application/epub+zip') {
      const raw = parseEpub(new Uint8Array(bytes));
      await addBook(`epub-${await hex(bytes)}`, 'epub', raw.title === 'Untitled book' ? { ...raw, title } : raw);
    } else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      const text = await pdfToText(bytes.slice(0));
      await addBook(`text-${await hex(new TextEncoder().encode(text))}`, 'pdf', rawFromPlain(title, text));
    } else {
      const text = new TextDecoder().decode(bytes);
      await addBook(`text-${await hex(new TextEncoder().encode(text))}`, 'text', await rawFromTextFile(title, text));
    }
  } catch (e) { msg.textContent = (e as Error).message || 'This file could not be opened.'; }
  busy(null);
  $<HTMLInputElement>('file').value = '';
}
async function openPasted(title: string, text: string, author = ''): Promise<void> {
  const raw = rawFromPlain(title, text);
  await addBook(`text-${await hex(new TextEncoder().encode(text))}`, 'text', author ? { ...raw, author } : raw);
}

// ---- a book opens ------------------------------------------------------------------------------------------------
/** the sentences of one stored paragraph (where each starts, in the letters the reader has) */
const sentencesIn = (b: RawChapter['blocks'][number]) => chapterOf({ title: '', blocks: [b] }, 0, segmenter).paragraphs[0]?.sentences ?? [];
/**
 * A book stored the old, heavy way (a whole PDF as one chapter) is cut into light parts when it is opened, and stored
 * again. The reader's place goes with it by letter count: the same sentence is on the page.
 */
async function lighter(got: { shelf: ShelfBook; text: StoredText }): Promise<{ shelf: ShelfBook; text: StoredText }> {
  // (the "Opening…" line is on the screen before the work starts)
  await new Promise<void>((r) => afterPaint(r));
  const old = got.text.chapters, at = got.shelf.place;
  const oldBlock = old[at.chapter]?.blocks[blockOfParagraph(old[at.chapter], at.paragraph)];
  const start = at.sentence > 0 && oldBlock ? storedLetter(oldBlock.text, sentencesIn(oldBlock)[at.sentence]?.start ?? 0) : 0;
  const now = recut(old, at, start);
  if (!wasCut(old, now.chapters)) return got;
  const ch = now.chapters[now.place.chapter];
  const block = ch?.blocks[blockOfParagraph(ch, now.place.paragraph)];
  let sentence = 0;
  if (block && now.place.within > 0) { const letter = readLetters(block.text, now.place.within); sentencesIn(block).forEach((x, i) => { if (x.start <= letter) sentence = i; }); }
  const fresh: ShelfBook = { ...got.shelf, chapterChars: now.chapters.map(charsOf), chapterTitles: now.chapters.map((c) => c.title), place: { chapter: now.place.chapter, paragraph: now.place.paragraph, sentence }, split: SPLIT_VERSION };
  const text: StoredText = { ...got.text, chapters: now.chapters };
  await (await bookStore()).add(fresh, text).catch(() => undefined);
  // (the meanings kept for this book were named by the old places)
  void chrome.storage.local.remove(`bkHere:${fresh.id}`).catch(() => undefined);
  return { shelf: fresh, text };
}
async function openBook(id: string, then: 'read' | 'listen' | 'same' = 'same', given?: { shelf: ShelfBook; text: StoredText }): Promise<void> {
  let got = given ?? await (await bookStore()).get(id);
  if (!got) throw new Error('This book is not in the library any more.');
  busy('Opening…');
  try {
    if (needsSplit(got.text.chapters)) got = await lighter(got);
    shelf = got.shelf; stored = got.text;
    dict ??= await getDictionary();
    zipf = await getZipf();
    [vocab, level, extras, settings, keys] = await Promise.all([store.getVocab(), store.getLevel(), store.getExtras(), store.getSettings(), store.getKeys()]);
    heard = new HeardCounter(readHeard(await store.getHeard().catch(() => null)));
    hereZh = new Map(Object.entries(((await chrome.storage.local.get(`bkHere:${id}`).catch(() => ({} as Record<string, unknown>)))[`bkHere:${id}`] as Record<string, string> | undefined) ?? {}));
    book = {
      id, title: shelf.title, ...(shelf.author ? { author: shelf.author } : {}), source: { kind: shelf.kind === 'web' ? 'text' : shelf.kind, importedAt: shelf.addedAt },
      chapters: stored.chapters.map((c, i) => ({ index: i, title: c.title, paragraphs: [] })), names: [], stats: { words: 0, paragraphs: 0, sentences: 0 },
    };
    cut.clear(); names = new Set(); rankWords = null; rankDone = null;
    await prepareVoice();
    // (the book before leaves the page first; the page is measured again once it is on the screen)
    clearFlow(); pageW = 0;
    $('lib').hidden = true;
    $('rd').hidden = false;
    $('ttl').textContent = shelf.title; $('head-t').textContent = shelf.title;
    if (then !== 'same') mode = then;
    paintMode();
    applyLook(false);
    showChapter(shelf.place.chapter, shelf.place);
    shelf = { ...shelf, openedAt: new Date().toISOString() };
    { const s = shelf; void bookStore().then((st) => st.update(s)).catch(() => undefined); }
    void chrome.storage.local.set({ [OPEN_KEY]: id }).catch(() => undefined);
    // (the bars show for a moment, then the page is the text alone)
    setChrome(true);
    setTimeout(() => { if (shelf?.id === id && !sheetOpen() && !playing) setChrome(false); }, 2600);
    if (then === 'listen') setPlaying(true);
  } finally { busy(null); }
}

// ---- the chapter on the page ---------------------------------------------------------------------------------------
/** the sentences of the part on the page (in the order of `order`) and its words by lemma: found once, when it is drawn */
let sEls: HTMLElement[] = [];
let wEls = new Map<string, HTMLElement[]>();
/** where each sentence of the part is in `order` */
let keyIdx = new Map<string, number>();
let curEl: HTMLElement | null = null, picked: HTMLElement | null = null;
const markCtx = () => ({ dict, zipf, words: vocab.words, myLevel: myLevelOf(extras, settings.learnerLevel), names });
function clearFlow(): void { $('flow').textContent = ''; sEls = []; wEls = new Map(); firstOf.clear(); curEl = null; picked = null; }
function render(): void {
  const ch = book.chapters[chapter];
  const parts: string[] = [];
  const many = (stored?.chapters.length ?? 1) > 1;
  // (a long chapter is kept in parts: its title stands over the first one only, the text goes on without a break)
  const title = partTitle(ch.title);
  if (many && title.part === 1 && title.base.trim()) parts.push(`<p class="chap">${esc(title.base)}</p>`);
  // (the quiet marks are written with the text; a word that comes again is looked up once)
  const ctx = markCtx();
  const seen = new Map<string, string>();
  const word = (t: string): string => {
    let w = seen.get(t);
    if (w === undefined) { const m = markOf(t, ctx); w = `<span class="w${m ? ` ${m}` : ''}" data-lemma="${esc(dict.lemmaOf(t))}">${esc(t)}</span>`; seen.set(t, w); }
    return w;
  };
  for (const para of ch.paragraphs) {
    let html = '', cursor = 0;
    for (const s of para.sentences) {
      html += esc(para.text.slice(cursor, s.start));
      html += `<span class="s" data-key="${ch.index}.${para.index}.${s.index}">`;
      let at = s.start;
      for (const t of s.tokens) {
        html += esc(para.text.slice(at, t.start));
        html += t.kind === 'word' ? word(t.text) : esc(t.text);
        at = t.end;
      }
      html += `${esc(para.text.slice(at, s.end))}</span>`;
      cursor = s.end;
    }
    parts.push(`<p${para.kind !== 'p' ? ` class="${para.kind}"` : ''}>${html}${esc(para.text.slice(cursor))}</p>`);
  }
  const flow = $('flow');
  flow.innerHTML = parts.join('');
  sEls = [...flow.querySelectorAll<HTMLElement>('.s')];
  wEls = new Map(); firstOf.clear(); curEl = null; picked = null;
  for (const el of flow.querySelectorAll<HTMLElement>('.w')) { const l = el.dataset.lemma ?? ''; const list = wEls.get(l); if (list) list.push(el); else wEls.set(l, [el]); }
}

/** a part's sentences and words are found (once; kept while the book is open) */
function cutChapter(c: number): void {
  if (!stored || cut.has(c) || !stored.chapters[c]) return;
  book.chapters[c] = chapterOf(stored.chapters[c], c, segmenter);
  cut.add(c);
  for (const n of detectNames({ chapters: [book.chapters[c]] }, dict)) names.add(n);
}
let warm: ReturnType<typeof setTimeout> | null = null;
/** the next part is made ready while this one is read: the page turn into it is as fast as any other */
function warmNext(): void {
  if (warm) clearTimeout(warm);
  const id = shelf?.id, next = chapter + 1;
  warm = setTimeout(() => { warm = null; if (shelf?.id === id && !cardNow) cutChapter(next); }, 700);
}
function showChapter(c: number, place: { paragraph: number; sentence: number } | null, atEnd = false): void {
  if (!stored) return;
  closeCard();
  chapter = clamp(c, 0, stored.chapters.length - 1);
  cutChapter(chapter);
  order = []; wordsBefore = []; keyIdx = new Map();
  let w = 0;
  for (const p of book.chapters[chapter].paragraphs) for (const s of p.sentences) {
    const pos = { chapter, paragraph: p.index, sentence: s.index };
    keyIdx.set(sentenceKey(pos), order.length);
    order.push(pos); wordsBefore.push(w); w += s.tokens.filter((t) => t.kind === 'word').length;
  }
  phrases = {}; hardSet = new Set(); aiStarted = null;
  stops = 0; heardKeys.clear(); stopped.clear(); rankWords = null; rankDone = null;
  // (the sentence I was at; when it is not there any more, the start of its paragraph)
  const at = place ? keyIdx.get(sentenceKey({ chapter, paragraph: place.paragraph, sentence: place.sentence })) ?? keyIdx.get(sentenceKey({ chapter, paragraph: place.paragraph, sentence: 0 })) ?? -1 : -1;
  index = Math.max(0, at);
  // (the column is set before the text is put in: the part is laid out once)
  measure();
  render();
  // (which sentences stop the reading is worked out after the page is on the screen, or when the reading asks)
  kept = []; scores = new Map(); stopSet = new Set(); sigs.clear();
  rescoreSoon();
  paintChapters();
  document.body.dataset.sentences = String(order.length);
  document.body.dataset.chapter = String(chapter);
  anchorPos = null;
  layout(false);
  if (atEnd) goPage(pages - 1, false);
  else if (at > 0) { const el = sentenceEl(order[at]); goPage(el ? pageOf(el) : 0, false, false); anchorPos = order[at]; }
  else goPage(0, false);
  if (mode === 'listen' && tutorOn()) void startAi();
  warmNext();
}
function paintChapters(): void {
  const n = stored?.chapters.length ?? 0;
  const sel = $<HTMLSelectElement>('chapters');
  if (sel.options.length !== n || sel.dataset.book !== (shelf?.id ?? '')) {
    sel.dataset.book = shelf?.id ?? '';
    sel.textContent = '';
    // (a part of a long chapter: the chapter's real title and "Part 2 of 7")
    const name = (c: RawChapter, i: number): string => { const t = partTitle(c.title); return t.of > 1 ? `${t.base ? `${t.base.slice(0, 40)} · ` : ''}Part ${t.part} of ${t.of}` : `${i + 1}. ${c.title || `Chapter ${i + 1}`}`.slice(0, 60); };
    stored!.chapters.forEach((c, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = n > 1 ? name(c, i) : (shelf?.title ?? '').slice(0, 60); sel.append(o); });
  }
  sel.value = String(chapter);
  $<HTMLButtonElement>('c-prev').disabled = chapter <= 0;
  $<HTMLButtonElement>('c-next').disabled = chapter >= n - 1;
  $('rd').dataset.chapters = String(n);
}

// ---- pages ---------------------------------------------------------------------------------------------------------
let page = 0, pages = 1, pageW = 0;
/** the sentence the reader is at: it stays on the page when the text is laid out again (a new size, a turned screen).
 *  Set when the reader turns a page; laying out again does not move it, however often the settings change. */
let anchorPos: Position | null = null;
const sentenceEl = (pos: Position): HTMLElement | null => sEls[keyIdx.get(sentenceKey(pos)) ?? -1] ?? null;
/** the page an element starts on */
function pageOf(el: HTMLElement): number {
  const f = $('flow').getBoundingClientRect();
  const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
  return clamp(Math.floor((r.left - f.left + 2) / (pageW || 1)), 0, pages - 1);
}
/** the first sentence that starts on the page now (or the one that runs into it) */
const firstOnPage = (): number => firstOnPageOf(page);
/** (found once for a page, until the text is laid out again) */
const firstOf = new Map<number, number>();
function firstOnPageOf(pg: number): number {
  const had = firstOf.get(pg);
  if (had !== undefined) return had;
  const els = sEls;
  let lo = 0, hi = els.length - 1, ans = els.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (pageOf(els[mid]) >= pg) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  const first = clamp(ans, 0, Math.max(0, order.length - 1));
  firstOf.set(pg, first);
  return first;
}
/**
 * The column of text, written on #flow itself (a variable on <html> would have every word of the page styled again).
 * `read`: the screen may have changed, its width is read again.
 */
function measure(read = false): void {
  if (read || !pageW) pageW = $('page').clientWidth;
  const flow = $('flow');
  // (an iPad: a column of about 34 em in the middle, never a line across the whole screen)
  const col = Math.max(120, Math.min(pageW - 2 * look.margin, Math.round(look.size * 34)));
  const w = `${col}px`, gap = `${Math.max(0, pageW - col)}px`;
  if (flow.style.columnWidth !== w) { flow.style.width = w; flow.style.columnWidth = w; }
  if (flow.style.columnGap !== gap) flow.style.columnGap = gap;
}
/** the page is measured again (the size, the margins, the screen changed); `keep`: stay at the same sentence */
function layout(keep: boolean, read = false): void {
  if (!shelf) return;
  const anchor = keep && order.length ? (playing ? order[index] : anchorPos ?? order[firstOnPage()]) : null;
  measure(read);
  firstOf.clear();
  const flow = $('flow');
  // (the width of all the columns: the last child's right edge tells how many pages there are. This is the one layout.)
  const last = flow.lastElementChild as HTMLElement | null;
  const f = flow.getBoundingClientRect();
  const rects = last?.getClientRects();
  const right = rects?.length ? rects[rects.length - 1].right : f.right;
  pages = pageW > 0 ? Math.max(1, Math.ceil((right - f.left - 1) / pageW)) : 1;
  const el = anchor ? sentenceEl(anchor) : null;
  goPage(el ? pageOf(el) : Math.min(page, pages - 1), false, false);
  if (anchor && !anchorPos) anchorPos = anchor;
}
function goPage(n: number, animate = true, moved = true): void {
  page = clamp(n, 0, pages - 1);
  if (moved) anchorPos = order.length ? order[firstOnPageOf(page)] : null;
  const flow = $('flow');
  flow.classList.toggle('jump', !animate);
  // (the shift is written on #flow itself: only it moves, no word is styled again)
  flow.style.transform = `translate3d(${-page * pageW}px,0,0)`;
  if (!animate) { void flow.offsetWidth; flow.classList.remove('jump'); }
  paintFoot();
  if (!playing) savePlaceSoon();
  debug();
}
/** the book is being read aloud and the reader went to another page: the reading goes on from there */
function readFromThisPage(): void {
  if (!playing) return;
  playing = false; loop++; flowId++;
  cancelSpeech(); closeCard();
  index = firstOnPage();
  playing = true;
  void readOn();
}
function turn(dir: 1 | -1): void {
  if (!stored) return;
  const inside = (dir > 0 && page < pages - 1) || (dir < 0 && page > 0);
  if (!inside && (dir > 0 ? chapter >= stored.chapters.length - 1 : chapter <= 0)) { if (dir > 0) toast('The end of the book.'); return; }
  const was = reading();
  // (a word asked by hand was holding the reading: the page turn lets it go)
  if (held) setPlaying(false);
  if (playing && inside) { goPage(page + dir); readFromThisPage(); return; }
  if (inside) goPage(page + dir);
  else { setPlaying(false); showChapter(chapter + dir, null, dir < 0); }
  // (the book was being read: it goes on from the page that is shown now)
  if (was && !playing) setPlaying(true);
}
function paintFoot(): void {
  $('foot-l').textContent = pages > 1 ? `${page + 1} / ${pages}` : '';
  $('foot-r').textContent = shelf ? `${percentNow()}%` : '';
}
function percentNow(): number {
  if (!shelf || !stored || !order.length) return shelf?.percent ?? 0;
  // (the place a page turn has just found: the text is not measured again for the small line)
  const pos = playing ? order[index] : anchorPos ?? order[firstOnPage()];
  const ch = book.chapters[chapter];
  if (!pos) return shelf.percent;
  if (chapter === stored.chapters.length - 1 && page === pages - 1 && pages > 1) return 100;
  return percentOf(shelf.chapterChars, chapter, charsBefore(ch, pos.paragraph) + (ch.paragraphs[pos.paragraph]?.sentences[pos.sentence]?.start ?? 0));
}

// ---- the place, remembered ---------------------------------------------------------------------------------------
let placeTimer: ReturnType<typeof setTimeout> | null = null;
function savePlaceSoon(): void { if (!placeTimer) placeTimer = setTimeout(() => { placeTimer = null; savePlaceNow(); }, 600); }
function savePlaceNow(): void {
  if (placeTimer) { clearTimeout(placeTimer); placeTimer = null; }
  if (!shelf || !stored || $('rd').hidden || !order.length) return;
  const pos = playing ? order[index] : anchorPos ?? order[firstOnPage()];
  if (!pos) return;
  const percent = percentNow();
  if (shelf.place.chapter === chapter && shelf.place.paragraph === pos.paragraph && shelf.place.sentence === pos.sentence && shelf.percent === percent) return;
  shelf = { ...shelf, place: { chapter, paragraph: pos.paragraph, sentence: pos.sentence }, percent, openedAt: new Date().toISOString() };
  const s = shelf;
  void bookStore().then((st) => st.update(s)).catch(() => undefined);
  debug();
}

// ---- the bars ------------------------------------------------------------------------------------------------------
function setChrome(on: boolean): void { $('rd').classList.toggle('plain', !on); debug(); }
const chromeOn = (): boolean => !$('rd').classList.contains('plain');
function paintMode(): void {
  $('rd').dataset.mode = mode;
  $('mode-read').classList.toggle('on', mode === 'read');
  $('mode-listen').classList.toggle('on', mode === 'listen');
  paintPlay();
}
function setMode(m: 'read' | 'listen'): void {
  if (m === mode) return;
  mode = m;
  if (m === 'read') setPlaying(false);
  paintMode();
  // (Listening keeps room for the small player under the text)
  if (stored && !$('rd').hidden) layout(true);
  void chrome.storage.local.set({ [MODE_KEY]: m }).catch(() => undefined);
  if (m === 'listen' && tutorOn()) void startAi();
  debug();
}
function paintPlay(): void {
  for (const id of ['t-play', 'm-play']) { $(id).innerHTML = reading() ? ICON.pause : ICON.play; $(id).setAttribute('aria-label', reading() ? 'Pause' : 'Play'); }
  $('t-speed').textContent = `${(settings?.voice.rate ?? 1).toFixed(1)}×`;
  $('t-voice').textContent = voiceName(voiceKind);
}

// ---- the voice -----------------------------------------------------------------------------------------------------
const voiceName = (k: VoiceKind): string => (k === 'azure' ? 'Microsoft' : k === 'openai' ? 'OpenAI' : k === 'elevenlabs' ? 'ElevenLabs' : k === 'speechify' ? 'Speechify' : 'iPhone');
/** (tests only, extras.fakeVoice: the stand-in for the device's voice, to see what IT said) */
let fakeDevice: { spoken: { text: string }[] } | null = null;
async function prepareVoice(): Promise<void> {
  if (extras.fakeVoice) fakeDevice = useFakeEngine(2);
  const mac = getEngine('webspeech');
  macVoices = (await mac.listVoices().catch(() => [])).filter((v) => /^en/i.test(v.lang ?? '')).map((v) => ({ id: v.id, name: v.name, lang: v.lang ?? '' }));
  const macVoice = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
  // (the tutor off: the device's own voice only, never a paid one)
  voiceKind = tutorOn() ? resolveVoice(extras.voice, keys, { speechifyUrl: extras.speechifyUrl ?? '' }) : 'mac';
  // (a Speechify problem says itself once, in its own words: no server, today's limit; the iPhone voice reads at once)
  const trouble = (e: Error) => { lastVoiceError = e.message; toast(voiceKind === 'speechify' ? e.message : `The ${voiceName(voiceKind)} voice had a problem: ${e.message}`, 6000); };
  const base: TtsEngine = voiceKind === 'mac' ? mac : new VoiceWithBackup(cloudEngine(voiceKind, 'en'), mac, () => macVoice, trouble);
  voiceId = voiceKind === 'mac' ? macVoice : voiceKind === 'openai' ? extras.openaiVoice : voiceKind === 'azure' ? extras.azureVoice : voiceKind === 'speechify' ? extras.speechifyVoice ?? '' : extras.elevenVoice;
  tts = new WithVolume(() => base, () => sliderGain(extras.teacherVolume ?? 60));
  paintPlay();
}
let lastVoiceError = '';
const rateNow = (): number => clamp(settings?.voice.rate || 1, 0.5, 1.6);
function say(text: string, slower = false): Promise<boolean> {
  if (!text.trim()) return Promise.resolve(true);
  spokenLog.push(text);
  if (spokenLog.length > 200) spokenLog.splice(0, 100);
  debug();
  const h = tts.speak(text, { voiceId, rate: slower ? Math.min(rateNow(), 0.9) : rateNow() });
  speaking = h;
  // (the test page's look at itself follows: which voice said it)
  return h.done.then((o) => { if (speaking === h) speaking = null; debug(); return o === 'ended'; }, () => false);
}
/** a pause in what the tutor says; whatever stops the voice (a tap on the card, a new word, Pause) ends it at once */
let napEnd: (() => void) | null = null;
function nap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); if (napEnd === done) napEnd = null; resolve(); };
    const t = setTimeout(done, ms);
    napEnd = done;
  });
}
function cancelSpeech(): void { speaking?.cancel(); explaining?.cancel(); tts?.cancelAll(); napEnd?.(); }
const textOf = (pos: Position): string => getSentence(book, pos)?.text ?? '';
const idxOf = (pos: Position): number => keyIdx.get(sentenceKey(pos)) ?? -1;

// ---- what is hard: my level, how much of each kind, my own words (the same rule as I Know) ------------------------
// Two passes. rescore() is the heavy one (every word of the part goes through the dictionary): only when the part, my
// level, the "how much" or the switches change, and after the frame. restatus() is the light one, for a tap: one word's
// status changed, so the stops lose what I know now and only THAT word's marks in the text are set again.
let needScore = false, scoreAsked = false, marksOld = false;
/** how often the heavy pass ran (for the tests: a tap must not start one) */
let heavy = 0;
/** the heavy pass is wanted: it runs after the frame (or sooner, when the reading needs the stops). `marks`: all the marks too */
function rescoreSoon(marks = false): void {
  needScore = true;
  if (marks) marksOld = true;
  if (scoreAsked) return;
  scoreAsked = true;
  afterPaint(() => { scoreAsked = false; scoresNow(); });
}
function scoresNow(): void {
  if (!needScore || !shelf) return;
  rescore();
  if (marksOld) { marksOld = false; remark(null); }
  debug();
}
/** the phrases I know now, by their words (the vocabulary is read once, not for every sentence) */
let doneNow = new Set<string>();
const sigs = new Map<string, string>();
const sigOf = (l: string): string => { let g = sigs.get(l); if (g === undefined) { g = phraseSig(dict, l); sigs.set(l, g); } return g; };
function donePhrases(): Set<string> {
  const done = new Set<string>();
  for (const [k, st] of Object.entries(vocab.words)) if (k.includes(' ') && (st === 'known' || st === 'ignored')) done.add(sigOf(k));
  return done;
}
function rescore(): void {
  needScore = false;
  if (!order.length || !dict) return;
  heavy++;
  doneNow = donePhrases();
  rankWords ??= { ...vocab.words } as Record<string, WordStatus>;
  rankDone ??= doneNow;
  const atStart = rankWords, doneAtStart = rankDone;
  const mine = myLevelOf(extras, settings.learnerLevel), cefr = settings.learnerLevel;
  const hardNumber = Math.min(98, (CEFR_MID[cefr as keyof typeof CEFR_MID] ?? 56) + 10);
  const numbers = new Map<string, number>();
  const all = scoreSentences({
    book, order, dict, names, status: (l) => atStart[l], phraseDone: (s) => doneAtStart.has(s), phrases,
    hard: harderThan(hardNumber, mine) ? hardSet : new Set<string>(), chance: unknownChance(level.tests), zipf,
    harder: (kind, text, lemma, lv) => {
      if (belowLevel(lv, cefr)) return false;
      const n = kind === 'phrase' ? phraseDifficulty(lv) : wordNumber(zipf(text.toLowerCase()), zipf(lemma), lv);
      if (n === null || !harderThan(n, mine)) return false;
      numbers.set(`${kind}:${lemma}`, Math.max(n, numbers.get(`${kind}:${lemma}`) ?? 0));
      return true;
    },
  });
  kept = keepHardest(all, pcts(), (lemma, kind) => numbers.get(`${kind}:${lemma}`) ?? 0, (lemma) => atStart[lemma] === 'learning');
  refilter();
}
/** the stops without what I know now (no dictionary, no look at the text: a few hundred sentences at most) */
function refilter(): void {
  const gone = (l: string) => vocab.words[l] === 'known' || vocab.words[l] === 'ignored' || doneNow.has(sigOf(l));
  const list = kept.map((sc) => {
    const idx = sc.lemmas.map((_, i) => i).filter((i) => !gone(sc.lemmas[i]));
    if (idx.length === sc.lemmas.length) return sc;
    const kinds = idx.map((i) => sc.kinds[i]);
    return { ...sc, items: idx.map((i) => sc.items[i]), lemmas: idx.map((i) => sc.lemmas[i]), kinds, kind: stopKindOf(kinds) };
  });
  scores = new Map(list.map((s) => [s.key, s]));
  stopSet = selectStopsByLevel(list, caps());
}
/** the quiet marks in the text: harder than my level and not known; still learning = a full line. `els` null = every word */
function remark(els: Iterable<HTMLElement> | null | undefined): void {
  if (els === undefined) return;
  const ctx = markCtx();
  const one = (el: HTMLElement) => { const m = markOf(el.textContent ?? '', ctx); el.classList.toggle('learning', m === 'learning'); el.classList.toggle('hard', m === 'hard'); };
  if (els) for (const el of els) one(el);
  else for (const list of wEls.values()) for (const el of list) one(el);
}
/** the status of these words changed (a tap, "I know", another window): the light pass */
function restatus(lemmas: readonly string[]): void {
  if (lemmas.some((l) => l.includes(' '))) doneNow = donePhrases();
  if (!needScore) refilter();
  for (const l of lemmas) remark(wEls.get(l));
  debug();
}
/** the words whose new status this page is still writing to the store (what comes back meanwhile does not undo them) */
const writing = new Map<string, number>();
/** a word's status: at once on the page (light), in the store after the frame */
function setStatus(lemma: string, status: 'learning' | 'known', met: { word?: string; sentence?: string }): void {
  vocab.words[lemma] = status;
  writing.set(lemma, (writing.get(lemma) ?? 0) + 1);
  restatus([lemma]);
  const written = () => { const n = (writing.get(lemma) ?? 1) - 1; if (n > 0) writing.set(lemma, n); else writing.delete(lemma); };
  afterPaint(() => void store.setWordStatus(lemma, status, met).then(written, written));
}
interface StopNow { items: { kind: 'word' | 'phrase'; target: string; lemma: string }[]; sentence: boolean }
/** does the reading stop after this sentence, and for what (nothing is changed by asking) */
function stopFor(pos: Position): StopNow | null {
  const key = sentenceKey(pos);
  // (the tutor off: the book is read like any audiobook, no stop by itself)
  if (!tutorOn()) return null;
  scoresNow();
  if (!stopSet.has(key) || stopped.has(key)) return null;
  const sc = scores.get(key);
  if (!sc) return null;
  const c = caps(), here = wordsBefore[idxOf(pos)] ?? 0, win = extras.repeatWords ?? 1000;
  const items = sc.lemmas.map((lemma, i) => ({ kind: sc.kinds[i], target: sc.items[i], lemma }))
    .filter((it) => c[it.kind] > 0 && vocab.words[it.lemma] !== 'known' && vocab.words[it.lemma] !== 'ignored' && !heard.lately(it.lemma, here, win));
  // (no key: only the dictionary can answer, so only words stop the reading: their card, the word once, a moment to say "I know")
  if (!hasAi()) { const words = items.filter((it) => it.kind === 'word'); return words.length ? { items: words, sentence: false } : null; }
  const sentenceStop = kindWith(sc, c) === 'sentence';
  if (!items.length && !sentenceStop) return null;
  return { items, sentence: !items.length };
}

// ---- the chapter's phrases and hard sentences: asked once, when Listening starts, and kept --------------------------
// (a book that was cut into light parts keeps its work under the cut's version: what was kept for the old parts is not used)
const aiId = (): string => { const id = shelf?.split ? `${book.id}~${shelf.split}` : book.id; return (stored?.chapters.length ?? 1) > 1 ? `${id}#${chapter}` : id; };
function startAi(): Promise<void> {
  if (aiStarted) return aiStarted;
  if (!tutorOn() || !hasAi() || !order.length) return Promise.resolve();
  const id = aiId(), forChapter = chapter, forBook = book.id, title = book.title;
  const lines = order.map(textOf);
  const fresh = () => forChapter === chapter && shelf?.id === forBook;
  aiStarted = (async () => {
    try {
      let items: AiItem[] | null = await store.getLevelItems(id).catch(() => null);
      if (!items) { aiCalls++; items = await complete(buildItemsPrompt(lines, title)).then((raw) => parseItems(raw, lines)).catch(() => null); if (items) void store.setLevelItems(id, items).catch(() => undefined); }
      if (!fresh()) return;
      if (items) { phrases = itemsToHits(book, order, items, dict); rescoreSoon(); }
      const kept = await store.getAnalysis(`${id}|hard`).catch(() => ({} as Record<string, string>));
      let list: number[] = [];
      if (typeof kept.list === 'string' && kept.n === String(lines.length)) { try { list = JSON.parse(kept.list) as number[]; } catch { list = []; } }
      else {
        for (let from = 0; from < lines.length; from += 60) {
          const slice = lines.slice(from, from + 60);
          const max = Math.max(1, Math.round(slice.length / 4));
          aiCalls++;
          try { list.push(...parseHardSentences(await complete(buildHardSentencesPrompt(slice, { level: settings.learnerLevel, title, max })), slice.length, max).map((i) => from + i)); } catch { /* no sentence stops from this part */ }
          if (!fresh()) return;
        }
        void store.setAnalysis(`${id}|hard`, { list: JSON.stringify(list), n: String(lines.length) }).catch(() => undefined);
      }
      if (!fresh()) return;
      hardSet = new Set(list.filter((i) => order[i]).map((i) => sentenceKey(order[i])));
      rescoreSoon();
    } catch { /* the reading goes on without them */ }
  })();
  return aiStarted;
}

// ---- the meaning on the card: what the word means HERE (asked once, kept with the book) ----------------------------
let hereZh = new Map<string, string>();
const hereAsked = new Set<string>();
let hereSave: ReturnType<typeof setTimeout> | null = null;
function zhFor(kind: CardKind, target: string, lemma: string, pos: Position): { zh: string; sure: boolean } {
  const key = sentenceKey(pos);
  const asked = hereZh.get(`${lemma}@${key}`);
  if (asked) return { zh: asked, sure: true };
  if (kind === 'phrase') { const z = phrases[key]?.find((p) => p.lemma === lemma)?.zh; if (z) return { zh: z, sure: true }; }
  if (kind === 'sentence') return { zh: '', sure: false };
  return { zh: (cardOf(target, dict).zh.split('；')[0] ?? '').split(/[,，]/)[0].trim(), sure: false };
}
function askHere(kind: CardKind, target: string, lemma: string, pos: Position): void {
  const k = `${lemma}@${sentenceKey(pos)}`;
  if (hereAsked.has(k) || hereZh.has(k)) return;
  hereAsked.add(k);
  const sentence = textOf(pos);
  const take = (zh: string | null) => {
    if (!zh) { hereAsked.delete(k); return; }
    hereZh.set(k, zh);
    if (hereSave) clearTimeout(hereSave);
    const id = book.id;
    hereSave = setTimeout(() => { hereSave = null; void chrome.storage.local.set({ [`bkHere:${id}`]: Object.fromEntries([...hereZh].slice(-800)) }).catch(() => undefined); }, 1500);
    if (cardNow && cardNow.lemma === lemma && sentenceKey(cardNow.pos) === sentenceKey(pos)) paintCard();
  };
  // (the tutor off, or no key: a sentence is translated by the device itself; a word keeps the dictionary's meaning)
  if (!tutorOn() || !hasAi()) { if (kind === 'sentence') void nativeTranslate(target).then(take, () => take(null)); else hereAsked.delete(k); return; }
  aiCalls++;
  const prompt = kind === 'sentence'
    ? { system: 'You translate one English sentence into natural Simplified Chinese for a learner of English. Answer only with the Chinese sentence.', user: target, maxTokens: 400 }
    : buildWordPrompt(target, sentence);
  void complete(prompt).then((full) => take(kind === 'sentence' ? (full.trim().split('\n')[0] || null) : (parseWordMeanings(full)?.[0] ?? null)), () => take(null));
}

// ---- the card ------------------------------------------------------------------------------------------------------
type CardKind = 'word' | 'phrase' | 'sentence';
interface CardNow { kind: CardKind; target: string; lemma: string; pos: Position; big: boolean; said: string; /** only looked up by hand, nothing explains it: a tap closes it */ only: boolean }
let cardNow: CardNow | null = null;
/** the 5 seconds after the word was said: a tap = I know */
let answer: ((a: 'know' | 'timeout') => void) | null = null;
let verdict: 'know' | null = null;
let flowId = 0;
/** the flow (one word, phrase or sentence being taught) that runs now; 0 = none */
let teaching = 0;
/** the book was being read aloud when something was asked by hand: the reading goes on when its card is gone */
let held = false;
let afterCard: (() => void) | null = null;
const reading = (): boolean => playing || held;
function paintCard(): void {
  const c = cardNow;
  if (!c) return;
  const el = c.big ? $('card') : $('small');
  const info = c.kind === 'word' ? cardOf(c.target, dict) : { ipa: '', zh: '', lemma: c.lemma };
  const z = zhFor(c.kind, c.target, c.lemma, c.pos);
  el.querySelector<HTMLElement>('.word')!.textContent = c.target;
  const ipa = el.querySelector<HTMLElement>('.ipa')!;
  ipa.textContent = info.ipa; ipa.hidden = !info.ipa;
  const zh = el.querySelector<HTMLElement>('.zh')!;
  zh.textContent = z.zh; zh.hidden = !z.zh;
  const said = el.querySelector<HTMLElement>('.said')!;
  said.textContent = c.said; said.hidden = !(c.said && (extras.showSay || !c.big));
  el.classList.toggle('sentence', c.kind !== 'word');
  if (c.big) el.querySelector<HTMLElement>('.hint')!.textContent = c.only ? 'Tap anywhere to close' : 'Tap anywhere = I know';
  if (!c.big) el.querySelector<HTMLElement>('[data-a="explain"]')!.hidden = !(tutorOn() && hasAi());
  el.hidden = false;
  (c.big ? $('small') : $('card')).hidden = true;
  if (!z.sure) askHere(c.kind, c.target, c.lemma, c.pos);
  debug();
}
function openCard(kind: CardKind, target: string, lemma: string, pos: Position, only = false): void {
  cardNow = { kind, target, lemma, pos, big: cardBig(), said: '', only };
  paintCard();
}
function closeCard(): void {
  $('card').hidden = true; $('small').hidden = true; $('caption').hidden = true;
  $('card').querySelector('.wait')!.classList.remove('run');
  cardNow = null;
  picked?.classList.remove('pick'); picked = null;
  const then = afterCard; afterCard = null;
  debug();
  then?.();
}
/** the card is dismissed by hand (✕, a tap on the page): whatever the tutor was doing for it stops */
function dropCard(): void {
  flowId++;
  const a = answer; answer = null;
  cancelSpeech();
  closeCard();
  a?.('timeout');
}
function waitAnswer(ms: number): Promise<'know' | 'timeout'> {
  const bar = $('card').querySelector<HTMLElement>('.wait')!;
  bar.classList.remove('run');
  if (cardNow?.big) { void bar.offsetWidth; bar.style.animationDuration = `${ms}ms`; bar.classList.add('run'); }
  return new Promise((resolve) => {
    const t = setTimeout(() => done('timeout'), ms);
    const done = (a: 'know' | 'timeout') => { clearTimeout(t); if (answer === done) answer = null; bar.classList.remove('run'); debug(); resolve(a); };
    answer = done;
    debug();
  });
}
/** a tap on the big card = "I know" (a card that was only looked up: the tap closes it) */
function cardKnow(): void {
  const c = cardNow;
  if (!c) return;
  // (a word that was only looked up, with no tutor behind it: the tap closes its card. It stays a word I am learning.)
  if (c.only) { dropCard(); return; }
  knowNow(c);
}
/**
 * "I know": the card is gone in the tap itself and the voice stops. Then the light bookkeeping (the word's marks, the
 * stops); the store is written after the frame. A flow that was teaching the word ends by itself ('known').
 */
function knowNow(c: CardNow): void {
  verdict = 'know';
  const a = answer;
  cancelSpeech();
  closeCard();
  if (c.kind !== 'sentence') setStatus(c.lemma, 'known', { word: c.target });
  else afterPaint(() => void store.setWordStatus(c.lemma, 'known', { word: c.target.slice(0, 80) }).catch(() => undefined));
  a?.('know');
}

// ---- the tutor explains ----------------------------------------------------------------------------------------------
function requestFor(kind: CardKind, target: string, pos: Position): RuleRequest {
  const ctx = contextAround(book, pos, 80, 40);
  const known = new Set<string>();
  for (const t of getSentence(book, pos)?.sentence.tokens ?? []) if (t.kind === 'word' && vocab.words[dict.lemmaOf(t.text)] === 'known') known.add(t.text.toLowerCase());
  if (kind === 'sentence') scoresNow();
  const teachLen = (() => { const l = settings.ai.explanationLength as string; return l === 'short' || l === 'long' ? l : 'normal'; })();
  return {
    kind: kind as RuleRequest['kind'], target, sentence: textOf(pos) || target, before: ctx.before, after: ctx.after,
    book: { title: book.title, chapter: partTitle(book.chapters[chapter]?.title ?? '').base }, history: [], position: pos,
    levelRule: { items: kind === 'sentence' ? (scores.get(sentenceKey(pos))?.items ?? []) : [target], known: [...known], level: settings.learnerLevel || 'B2', length: teachLen },
  };
}
/** the explanation, said sentence by sentence as it comes; '' when it was stopped or failed */
async function explainThis(req: RuleRequest, alive: () => boolean): Promise<string> {
  const guard = new RuleGuard({ sentence: req.sentence, items: req.kind === 'sentence' ? req.levelRule!.items : [req.target] });
  const splitter = new StreamSentenceSplitter();
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false, failed = '';
  const show = (t: string) => { if (cardNow) { cardNow.said = t.trim(); const el = (cardNow.big ? $('card') : $('small')).querySelector<HTMLElement>('.said')!; el.textContent = cardNow.said; el.hidden = !(cardNow.said && (extras.showSay || !cardNow.big)); } };
  aiCalls++;
  const job = aiExplain(req, (full) => { const t = guard.push(full); show(t); queue.push(...splitter.push(t)); wake?.(); });
  explaining = job;
  let final = '';
  void job.done.then((r) => { final = guard.finish(r.text); show(final); queue.push(...splitter.flush(final)); }, (e: Error) => { failed = e.message; }).finally(() => { finished = true; wake?.(); });
  for (;;) {
    if (!alive() || verdict) { job.cancel(); explaining = null; return ''; }
    const next = queue.shift();
    if (next !== undefined) { await say(next); continue; }
    if (finished) break;
    await new Promise<void>((r) => { wake = r; });
    wake = null;
  }
  explaining = null;
  if (failed) { toast(failed.length > 140 ? `${failed.slice(0, 138)}…` : failed, 6000); return ''; }
  debug();
  return final;
}

let heardSave: ReturnType<typeof setTimeout> | null = null;
function saveHeardSoon(): void {
  if (heardSave) return;
  heardSave = setTimeout(() => { heardSave = null; if (heard.dirty) { heard.dirty = false; void store.setHeard(heard.state(extras.repeatWords ?? 1000)).catch(() => undefined); } }, 4000);
}

/**
 * One word, phrase or sentence is taught, the same way at a stop and by hand:
 * its card → (a word or phrase: said once) → `wait`: 5 seconds, a tap = I know → the explanation → a word three times
 * (a phrase once) → the card closes → `replay`: the sentence again.
 */
async function teach(kind: CardKind, target: string, lemma: string, pos: Position, o: { wait: boolean; replay: boolean; ok: () => boolean }): Promise<'known' | 'explained' | 'cancelled'> {
  const me = ++flowId;
  teaching = me;
  try { return await teachFlow(me, kind, target, lemma, pos, o); } finally { if (teaching === me) teaching = 0; }
}
async function teachFlow(me: number, kind: CardKind, target: string, lemma: string, pos: Position, o: { wait: boolean; replay: boolean; ok: () => boolean }): Promise<'known' | 'explained' | 'cancelled'> {
  verdict = null;
  const alive = () => me === flowId && o.ok();
  const sentence = textOf(pos);
  // ("I know" was tapped: knowNow closed the card and marked the word in that very tap; the flow only ends here)
  const known = () => { closeCard(); return 'known' as const; };
  openCard(kind, target, lemma, pos, !o.wait && (!tutorOn() || !hasAi()));
  // (the card is on the screen first: the word's new status costs a few marks now, the store is written after the frame)
  if (kind !== 'sentence' && !vocab.words[lemma]) setStatus(lemma, 'learning', { word: target, sentence });
  if (kind !== 'sentence') { heard.ask(lemma, wordsBefore[idxOf(pos)] ?? 0); saveHeardSoon(); }
  const times = async (n: number): Promise<boolean> => {
    for (let i = 0; i < n; i++) {
      if (!alive()) return false;
      if (verdict) return true;
      // (the pause between two times ends at once when the card is tapped)
      if (i > 0) { await nap(350); if (!alive()) return false; if (verdict) return true; }
      await say(target, true);
      if (!alive()) return false;
    }
    return true;
  };
  if (kind !== 'sentence' && !(await times(clamp(extras.sayBefore ?? 1, 0, 10)))) return 'cancelled';
  if (!verdict && o.wait) { await waitAnswer(extras.fakeVoice ? Math.min(2500, settings.listen.commandWindowMs || 5000) : (settings.listen.commandWindowMs || 5000)); if (!alive()) return 'cancelled'; }
  if (verdict === 'know') return known();
  // (the tutor off, or no key: only the card; at a stop it goes after its moment, by hand it stays until it is closed)
  if (!tutorOn() || !hasAi()) { if (o.wait) closeCard(); return 'explained'; }
  const explanation = await explainThis(requestFor(kind, target, pos), alive);
  if (!alive()) return 'cancelled';
  if (verdict === 'know') return known();
  if (explanation && kind !== 'sentence') {
    void saveExplained({ lemma, word: target, sentence, explanation, chinese: zhFor(kind, target, lemma, pos).zh, bookId: book.id, bookTitle: book.title, chapter: partTitle(book.chapters[chapter]?.title ?? '').base, position: pos }, extras.knownAfter ?? 7)
      .then((r) => { if (r?.nowKnown) { vocab.words[lemma] = 'known'; restatus([lemma]); toast(`“${target}” was explained ${r.times} times: it counts as known now.`, 5000); } }, () => undefined);
  }
  if (kind !== 'sentence' && !(await times(kind === 'word' ? clamp(extras.sayAfter ?? 3, 0, 10) : 1))) return 'cancelled';
  if (verdict === 'know') return known();
  // the card closes NOW, before the sentence is heard again
  closeCard();
  if (o.replay && sentence) { markCurrent(pos); await say(sentence); if (!alive()) return 'cancelled'; }
  return 'explained';
}
const sentenceLemma = (text: string): string => `sentence: ${text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120)}`;

// ---- listening: the book is read aloud ---------------------------------------------------------------------------
function markCurrent(pos: Position | null): void {
  curEl?.classList.remove('cur'); curEl = null;
  const el = pos && sentenceEl(pos);
  if (!el) return;
  el.classList.add('cur'); curEl = el;
  const p = pageOf(el);
  if (p !== page) goPage(p);
}
async function readOn(): Promise<void> {
  const mine = ++loop;
  let silent = 0;
  const ok = () => playing && mine === loop;
  // (the chapter's phrases and hard sentences come while the book is already being read)
  void startAi().catch(() => undefined);
  while (ok()) {
    if (index >= order.length) {
      if (stored && chapter < stored.chapters.length - 1) { showChapter(chapter + 1, null); void startAi().catch(() => undefined); if (!ok()) return; continue; }
      // 2: (the place stays on the last sentence, so Play and the step buttons still have one)
      index = Math.max(0, order.length - 1);
      setPlaying(false); markCurrent(null); toast('The end of the book.');
      return;
    }
    const pos = order[index], key = sentenceKey(pos), text = textOf(pos);
    heardKeys.add(key);
    heard.hear(`${book.id}:${key}`, wordsBefore[index] ?? 0, (wordsBefore[index + 1] ?? wordsBefore[index] ?? 0) - (wordsBefore[index] ?? 0));
    markCurrent(pos);
    paintFoot();
    savePlaceSoon(); saveHeardSoon();
    // (the next sentences are made ready while this one is said; the meaning of the next card too)
    // (Speechify: only the next sentence of the SAME paragraph, nothing across a paragraph's end: each clip is paid)
    const next = order.slice(index + 1, index + 3);
    tts.readAhead?.((voiceKind === 'speechify' ? next.slice(0, 1).filter((q) => q.chapter === pos.chapter && q.paragraph === pos.paragraph) : next).map(textOf).filter(Boolean), voiceId, rateNow());
    const coming = stopFor(pos);
    if (coming) { const it = coming.items[0]; if (it) askHere(it.kind, it.target, it.lemma, pos); else askHere('sentence', text, sentenceLemma(text), pos); }
    const ended = await say(text);
    if (!ok()) return;
    // (a sentence the voice could not say: on to the next one; three in a row = the reading stops and says why)
    if (ended) silent = 0;
    else if (++silent >= 3) { setPlaying(false); toast(lastVoiceError ? `The voice stopped: ${lastVoiceError}` : 'The voice could not read. Check the voice in the tutor settings.', 7000); return; }
    const st = stopFor(pos);
    if (st) {
      stopped.add(key); stops++;
      let explained = false;
      for (const it of st.items) {
        if (!ok()) return;
        if (vocab.words[it.lemma] === 'known') continue;
        const r = await teach(it.kind, it.target, it.lemma, pos, { wait: true, replay: true, ok });
        if (!ok()) return;
        // (explained, or its card was closed by hand: on with the book)
        if (r !== 'known') { explained = true; break; }
      }
      if (!explained && st.sentence) await teach('sentence', text, sentenceLemma(text), pos, { wait: true, replay: true, ok });
      if (!ok()) return;
    }
    index++;
  }
}
function setPlaying(on: boolean): void {
  if (on && playing) return;
  held = false; afterCard = null;
  if (on) {
    if (!shelf || !order.length) return;
    if (mode !== 'listen') { mode = 'listen'; paintMode(); layout(true); void chrome.storage.local.set({ [MODE_KEY]: 'listen' }).catch(() => undefined); }
    // (reading starts on the page the reader is looking at)
    index = clamp(index, 0, order.length - 1);
    const el = sentenceEl(order[index]);
    if (!el || pageOf(el) !== page) index = firstOnPage();
    // (whatever was being said for a word asked by hand stops: one voice at a time)
    flowId++; cancelSpeech(); closeCard();
    playing = true;
    paintPlay();
    void readOn();
    setTimeout(() => { if (playing && !sheetOpen()) setChrome(false); }, 1400);
  } else {
    if (playing && order[index]) anchorPos = order[index];
    playing = false; loop++; flowId++;
    const a = answer; answer = null; a?.('timeout');
    cancelSpeech();
    tts?.stopReadAhead?.();
    closeCard();
    paintPlay();
    savePlaceNow(); saveHeardSoon();
  }
  debug();
}
function stepSentence(dir: 1 | -1): void {
  if (!order.length) return;
  const was = reading();
  held = false; afterCard = null;
  index = clamp(index, 0, order.length - 1);
  if (was) { playing = false; loop++; flowId++; cancelSpeech(); closeCard(); }
  else { const el = sentenceEl(order[index]); if (!el || pageOf(el) !== page) index = firstOnPage(); }
  index = clamp(index + dir, 0, order.length - 1);
  markCurrent(order[index]);
  if (was) { playing = true; void readOn(); }
  else { anchorPos = order[index]; savePlaceSoon(); }
  paintPlay();
}

// ---- by hand: a tapped word, a few selected words, a selected sentence ---------------------------------------------
async function teachByHand(kind: CardKind, target: string, lemma: string, pos: Position): Promise<void> {
  if (playing) { held = true; playing = false; loop++; tts?.stopReadAhead?.(); }
  afterCard = null;
  // (one voice at a time: what was being said for the word before stops)
  cancelSpeech();
  const at = idxOf(pos);
  await teach(kind, target, lemma, pos, { wait: false, replay: false, ok: () => true });
  // (the book was being read: it goes on from this sentence, when the card is gone. It was silent: nothing plays by itself.)
  if (!held || teaching || playing) return;
  const goOn = () => { if (!held || teaching || playing || $('rd').hidden) return; held = false; if (at >= 0) index = at; playing = true; paintPlay(); void readOn(); };
  if (cardNow) afterCard = goOn; else goOn();
}
function tappedWord(el: HTMLElement): void {
  const sEl = el.closest<HTMLElement>('.s');
  if (!sEl) return;
  const [c, p, s] = sEl.dataset.key!.split('.').map(Number);
  picked?.classList.remove('pick');
  el.classList.add('pick'); picked = el;
  const word = (el.textContent ?? '').trim();
  void teachByHand('word', word, el.dataset.lemma || word.toLowerCase(), { chapter: c, paragraph: p, sentence: s });
}
/** what is selected, as one line ('' = nothing) */
const selText = (): string => window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
/**
 * What is selected in the text is asked: one word (a long press selects it) = a tap on that word, a few words = a
 * phrase, more = the sentence card. False when nothing in the text is selected.
 */
function takeSelection(): boolean {
  const sel = window.getSelection();
  const t = selText();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !t || t.length > 700 || $('rd').hidden || sheetOpen()) return false;
  const r = sel.getRangeAt(0);
  const elOf = (n: Node | null): Element | null => (n instanceof Element ? n : n?.parentElement ?? null);
  const top = elOf(r.commonAncestorContainer);
  if (!top?.closest('#flow')) return false;
  const words = t.split(' ').filter(Boolean);
  if (words.length < 2) {
    const one = top.closest<HTMLElement>('.w[data-lemma]') ?? [...top.querySelectorAll<HTMLElement>('.w[data-lemma]')].find((w) => r.intersectsNode(w) && !!w.textContent && t.includes(w.textContent)) ?? null;
    sel.removeAllRanges();
    if (one) tappedWord(one);
    return true;
  }
  const from = elOf(r.startContainer)?.closest<HTMLElement>('#flow .s') ?? elOf(r.endContainer)?.closest<HTMLElement>('#flow .s') ?? sEls.find((x) => r.intersectsNode(x)) ?? null;
  if (!from) return false;
  const [c, p, s] = from.dataset.key!.split('.').map(Number);
  const pos = { chapter: c, paragraph: p, sentence: s };
  sel.removeAllRanges();
  // (a few words = a phrase; more, or a whole sentence = the sentence card: its translation, no pronunciation)
  if (words.length <= 6) void teachByHand('phrase', t, t.toLowerCase(), pos);
  else void teachByHand('sentence', t, sentenceLemma(t), pos);
  return true;
}
/** a finger (or the mouse button) is down on the page: what it selects is asked when it lifts */
let fingerDown = false;
let selTimer: ReturnType<typeof setTimeout> | null = null;
/** the selection changed with no finger on the page (its handles were moved, or iOS took the long press): asked a moment later */
function selectionSoon(): void {
  if (selTimer) clearTimeout(selTimer);
  selTimer = setTimeout(() => { selTimer = null; if (!fingerDown) takeSelection(); }, 250);
}
function wireSelection(): void {
  document.addEventListener('selectionchange', selectionSoon);
  window.addEventListener('mousedown', () => { fingerDown = true; });
  window.addEventListener('mouseup', () => { fingerDown = false; });
}

// ---- fingers: a swipe turns the page, a tap on a word explains it, a tap in the middle calls the bars ----------------
function wirePage(): void {
  // (the whole reading screen: the narrow bands above and under the text belong to it too)
  const pg = $('rd');
  const inBars = (t: HTMLElement | null): boolean => !!t?.closest('.chrome, #mini');
  let down: { x: number; y: number; at: number; sel: string } | null = null;
  // (when the last touch ended, and where it began: the click a browser may send after a touch is never taken twice)
  let lastTouch = 0, touchOn = '', lastX = 0, lastY = 0;
  const tap = (x: number, y: number, target: HTMLElement | null) => {
    if (sheetOpen()) { closeSheet(); return; }
    const word = target?.closest<HTMLElement>('#flow .w[data-lemma]') ?? null;
    // (the small card is open: it goes; a word under the finger opens in the same tap. A book that was being read
    // stays held for the new word.)
    if (cardNow && !cardNow.big) { if (word) afterCard = null; dropCard(); if (!word) return; }
    const w = innerWidth;
    // (the band above the text and the band under it: the bars come and go. On a page full of words this is the sure
    // place to tap; a tap on a word explains the word.)
    { const r = $('page').getBoundingClientRect(); if (y < r.top + 6 || y > r.bottom - 6) { setChrome(!chromeOn()); return; } }
    const strip = look.tapEdges ? 64 : Math.max(look.margin, 30);
    const edge = x < strip ? -1 : x > w - strip ? 1 : 0;
    // (the bars are showing: a tap on the page sends them away; a tap on a word opens the word as well, in the same tap)
    if (chromeOn() && !playing) { setChrome(false); if (!word) return; }
    if (edge && (look.tapEdges || !word)) { turn(edge as 1 | -1); return; }
    if (word) { tappedWord(word); return; }
    // (beside the text: the left third goes back, the right third goes on, the middle calls the bars)
    if (x < w * 0.28) turn(-1); else if (x > w * 0.72) turn(1); else setChrome(!chromeOn());
  };
  pg.addEventListener('touchstart', (ev) => {
    const t = ev.touches[0];
    fingerDown = true; touchOn = 'page';
    down = ev.touches.length === 1 && !inBars(ev.target as HTMLElement) ? { x: t.clientX, y: t.clientY, at: Date.now(), sel: selText() } : null;
  }, { passive: true });
  // (iOS took the touch for itself, e.g. a long press that selects a word: the selection is asked a moment later)
  pg.addEventListener('touchcancel', () => { down = null; fingerDown = false; selectionSoon(); }, { passive: true });
  // (not passive: a touch the page has taken sends no click after it, so nothing "taps" the card that just opened)
  pg.addEventListener('touchend', (ev) => {
    const d = down; down = null;
    fingerDown = (ev.touches?.length ?? 0) > 0;
    lastTouch = Date.now();
    const t = ev.changedTouches[0];
    if (!d || !t) return;
    lastX = t.clientX; lastY = t.clientY;
    const dx = t.clientX - d.x, dy = t.clientY - d.y, dt = Date.now() - d.at;
    const sel = selText();
    // (this finger selected something and lifts: it is asked now, not a moment later)
    if (sel && sel !== d.sel) { if (takeSelection() && ev.cancelable) ev.preventDefault(); return; }
    // (a selection left from before never blocks the tap)
    if (sel) window.getSelection()?.removeAllRanges();
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 900) { if (ev.cancelable) ev.preventDefault(); turn(dx < 0 ? 1 : -1); return; }
    // (a tap may be slow or a little unsure: up to 0.8 s and 14 px)
    if (Math.abs(dx) < 14 && Math.abs(dy) < 14 && dt < 800) { if (ev.cancelable) ev.preventDefault(); tap(t.clientX, t.clientY, ev.target as HTMLElement); }
  }, { passive: false });
  // (a mouse, on a computer)
  pg.addEventListener('click', (ev) => {
    if (Date.now() - lastTouch < 700 || inBars(ev.target as HTMLElement)) return;
    if (selText() && takeSelection()) return;
    window.getSelection()?.removeAllRanges();
    tap(ev.clientX, ev.clientY, ev.target as HTMLElement);
  });
  const cardTap = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); cardKnow(); };
  let cardDown: { x: number; y: number } | null = null;
  $('card').addEventListener('touchstart', (ev) => { const t = ev.touches[0]; touchOn = 'card'; cardDown = t && ev.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null; }, { passive: true });
  $('card').addEventListener('touchend', (ev) => {
    lastTouch = Date.now();
    const d = cardDown; cardDown = null;
    const t = ev.changedTouches[0];
    // (any touch that did not move, however long it was; one that moved was reading a long sentence on the card)
    if (!d || !t || Math.abs(t.clientX - d.x) > 20 || Math.abs(t.clientY - d.y) > 20) { ev.stopPropagation(); return; }
    cardTap(ev);
  });
  // (a mouse; never the click that comes after a touch, nor the second click of a double click)
  $('card').addEventListener('click', (ev) => { if (Date.now() - lastTouch < 700 || ev.detail > 1) return; cardTap(ev); });
  $('small').addEventListener('touchstart', () => { touchOn = 'small'; }, { passive: true });
  $('small').addEventListener('touchend', () => { lastTouch = Date.now(); }, { passive: true });
  $('small').addEventListener('click', (ev) => {
    // (the click a browser may send after a touch on the page, at the same spot, was meant for the page)
    if (touchOn !== 'small' && Date.now() - lastTouch < 700 && Math.abs(ev.clientX - lastX) < 30 && Math.abs(ev.clientY - lastY) < 30) return;
    const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    const c = cardNow;
    if (!a || !c) return;
    if (a === 'close') dropCard();
    else if (a === 'know') knowNow(c);
    else if (a === 'explain') { if (answer) answer('timeout'); else void teachByHand(c.kind, c.target, c.lemma, c.pos); }
  });
  window.addEventListener('keydown', (ev) => {
    if ($('rd').hidden || sheetOpen() || /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target as HTMLElement).tagName)) return;
    if (ev.key === 'ArrowRight') turn(1); else if (ev.key === 'ArrowLeft') turn(-1); else if (ev.key === ' ') { ev.preventDefault(); setPlaying(!reading()); }
  });
}

// ---- sheets --------------------------------------------------------------------------------------------------------
let sheetKind = '';
const sheetOpen = (): boolean => !$('sheet').hidden;
function openSheet(kind: string, html: string, dim = false): HTMLElement {
  sheetKind = kind;
  const body = $('sheet-body');
  body.innerHTML = html;
  $('veil').hidden = false; $('veil').classList.toggle('dim', dim);
  $('sheet').hidden = false;
  body.scrollTop = 0;
  debug();
  return body;
}
function closeSheet(): void { $('sheet').hidden = true; $('veil').hidden = true; sheetKind = ''; debug(); }
const opts = (name: string, value: string, list: [string, string][]) => `<div class="opts" data-name="${name}">${list.map(([v, l]) => `<button data-v="${esc(v)}" class="${v === value ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;
const range = (name: string, label: string, v: number, lim: { min: number; max: number; step: number }, show: string) => `<div class="ctl"><label>${label}</label><input type="range" data-name="${name}" min="${lim.min}" max="${lim.max}" step="${lim.step}" value="${v}"><output>${show}</output></div>`;

function lookSheet(): void {
  const cur = themeOf(look, systemDark());
  const sw = (id: string, name: string, bg: string, fg: string) => `<button class="sw${look.theme === id ? ' on' : ''}" data-theme="${id}"><i style="background:${bg};color:${fg}">A</i>${name}</button>`;
  const autoT = themeOf({ ...look, theme: 'auto' }, systemDark());
  const body = openSheet('look', `
    <h4>Page</h4>
    <div class="swatches">${sw('auto', 'Auto', `linear-gradient(135deg,#FAF6EC 50%,#1B1A1E 50%)`, autoT.fg)}${THEMES.map((t) => sw(t.id, t.name, t.bg, t.fg)).join('')}${sw('custom', 'My own', look.bg, look.fg)}</div>
    <div class="colors" id="own"${look.theme === 'custom' ? '' : ' hidden'}><label><input type="color" data-name="bg" value="${look.bg}"> Page</label><label><input type="color" data-name="fg" value="${look.fg}"> Text</label></div>
    <h4>Font</h4>
    <div class="fonts">${FONTS.map((f) => `<button data-font="${f.id}" class="${look.font === f.id ? 'on' : ''}" style="font-family:${esc(f.css)}">${f.name}</button>`).join('')}</div>
    <h4>Text</h4>
    ${range('size', 'Size', look.size, LIMITS.size, `${look.size}`)}
    ${range('line', 'Line spacing', look.line, LIMITS.line, look.line.toFixed(2))}
    ${range('margin', 'Margins', look.margin, LIMITS.margin, `${look.margin}`)}
    ${range('letter', 'Letters', look.letter, LIMITS.letter, look.letter.toFixed(2))}
    ${range('word', 'Words', look.word, LIMITS.word, look.word.toFixed(2))}
    ${range('para', 'Paragraphs', look.para, LIMITS.para, look.para.toFixed(1))}
    <p class="note" id="lpl"></p>
    <div class="rowline"><span>Lines</span>${opts('align', look.align, [['left', 'Left'], ['justify', 'Even edges']])}</div>
    <div class="rowline"><span>Bolder letters</span>${opts('bold', look.bold ? 'on' : 'off', [['on', 'On'], ['off', 'Off']])}</div>
    <div class="rowline"><span>Wide tap edges<small>a tap near the left or right edge turns the page</small></span>${opts('tapEdges', look.tapEdges ? 'on' : 'off', [['on', 'On'], ['off', 'Off']])}</div>
    <button class="big" data-a="reset">Back to the usual look</button>`);
  void cur;
  const lpl = () => { const n = lettersPerLine(Math.min(pageW || innerWidth, look.size * 34 + 2 * look.margin), look); $('lpl').textContent = `About ${n} letters on a line${n < 30 ? ' (short lines: try smaller text or margins)' : n > 78 ? ' (long lines: try bigger text or margins)' : ''}.`; };
  lpl();
  body.oninput = (ev) => {
    const t = ev.target as HTMLInputElement;
    const name = t.dataset.name as keyof Look | undefined;
    if (!name) return;
    if (t.type === 'color') { setLook({ [name]: t.value, theme: 'custom' } as Partial<Look>); return; }
    const v = Number(t.value);
    // (the number beside the slider follows the finger; the page follows within 150 ms)
    setLook({ [name]: v } as Partial<Look>, true);
    const out = t.parentElement?.querySelector('output');
    if (out) out.textContent = name === 'line' || name === 'letter' || name === 'word' ? v.toFixed(2) : name === 'para' ? v.toFixed(1) : String(v);
    lpl();
  };
  body.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.theme) { setLook({ theme: b.dataset.theme as Look['theme'] }); lookSheet(); return; }
    if (b.dataset.font) { setLook({ font: b.dataset.font }); body.querySelectorAll('.fonts button').forEach((x) => x.classList.toggle('on', x === b)); return; }
    const group = b.parentElement?.classList.contains('opts') ? b.parentElement.dataset.name : '';
    if (group === 'align') setLook({ align: b.dataset.v === 'justify' ? 'justify' : 'left' });
    else if (group === 'bold') setLook({ bold: b.dataset.v === 'on' });
    else if (group === 'tapEdges') setLook({ tapEdges: b.dataset.v === 'on' });
    else if (b.dataset.a === 'reset') { setLook({ ...DEFAULT_LOOK, size: innerWidth >= 700 ? 20 : 18 }); lookSheet(); return; }
    if (group) b.parentElement!.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  };
}

const pctSoon: Record<string, ReturnType<typeof setTimeout>> = {};
async function patchX(p: Partial<store.YtExtras>): Promise<void> { extras = { ...extras, ...p }; await store.patchExtras(p).catch(() => undefined); }
function tutorSheet(): void {
  const p = pcts();
  const kind = (sw: keyof store.YtExtras, name: string, label: string, on: boolean, pct: number) => `<div class="rowline"><span>${label}</span>${opts(sw as string, on ? 'on' : 'off', [['on', 'On'], ['off', 'Off']])}</div>
    <div class="ctl"><label>How much</label><input type="range" data-name="${name}" min="0" max="100" step="5" value="${pct}"${on ? '' : ' disabled'}><output>${pct}%</output></div>`;
  const wants: store.KeyName | '' = extras.voice === 'elevenlabs' ? 'elevenlabs' : extras.voice === 'openai' ? 'openai' : extras.voice === 'azure' || extras.voice === 'auto' ? 'azure' : '';
  const missing = tutorOn() && voiceKind === 'mac' && wants ? (wants === 'azure' ? 'Microsoft' : wants === 'openai' ? 'OpenAI' : 'ElevenLabs') : '';
  const keyBox = (k: store.KeyName, label: string) => `<div class="key"><input type="password" data-key="${k}" placeholder="${keys[k] ? `${label}: saved (…${esc(keys[k]!.slice(-4))})` : `${label}: paste your key`}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"><button data-a="save-key" data-k="${k}">Save</button></div>`;
  const select = (name: string, list: { id: string; name: string }[], val: string) => `<select class="field" data-name="${name}" style="width:100%;margin:6px 0">${list.map((v) => `<option value="${esc(v.id)}"${v.id === val ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`;
  const voiceList = voiceKind === 'azure' ? select('azureVoice', AZURE_VOICES.map((v) => ({ id: v.id, name: `${v.name} · ${v.accent} · ${v.gender}` })), extras.azureVoice)
    : voiceKind === 'openai' ? select('openaiVoice', OPENAI_VOICES, extras.openaiVoice)
    : voiceKind === 'elevenlabs' ? select('elevenVoice', ELEVEN_VOICES, extras.elevenVoice)
    : macVoices.length ? select('macVoice', macVoices.map((v) => ({ id: v.id, name: `${v.name} (${v.lang})` })), settings.voice.voiceId || voiceId) : '';
  const body = openSheet('tutor', `
    <h4>My tutor</h4>
    <div class="rowline"><span>My tutor<small>off = only the dictionary, no AI, nothing paid</small></span>${opts('tutorOn', tutorOn() ? 'on' : 'off', [['on', 'On'], ['off', 'Off']])}</div>
    ${tutorOn() && !hasAi() ? `<p class="warn">No Claude key is saved: the tutor cannot explain. Paste your Claude key and press Save.</p>${keyBox('anthropic', 'Claude key')}` : ''}
    <div class="rowline"><span>My level</span></div>${opts('learnerLevel', settings.learnerLevel, [['A1', 'A1'], ['A2', 'A2'], ['B1', 'B1'], ['B2', 'B2'], ['C1', 'C1'], ['C2', 'C2']])}
    <h4>Explain by itself when listening</h4>
    ${kind('stopItemsOn', 'pctWords', 'Words', extras.stopItemsOn !== false, p.word)}
    ${kind('stopPhrasesOn', 'pctPhrases', 'Phrases', extras.stopPhrasesOn !== false, p.phrase)}
    ${kind('stopHardOn', 'pctSentences', 'Sentences', extras.stopHardOn !== false, p.sentence)}
    <p class="note">Nothing below your level is explained by itself, and nothing you know. 100 % = everything at your level or above, a low number = only the hardest. A tap on any word always explains it.</p>
    <h4>The card</h4>
    <div class="rowline"><span>Size</span>${opts('cardSize', cardBig() ? 'big' : 'small', [['big', 'Big (whole screen)'], ['small', 'Small']])}</div>
    <div class="rowline"><span>Show the explanation as text</span>${opts('showSay', extras.showSay ? 'on' : 'off', [['on', 'On'], ['off', 'Off']])}</div>
    <h4>Voice</h4>
    ${opts('voice', extras.voice, [['auto', 'Auto'], ['azure', 'Microsoft'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], SPEECHIFY_CHOICE, ['mac', 'iPhone']])}
    ${missing ? `<p class="warn">No ${missing} key is saved, so you hear the iPhone voice now. Paste your ${missing} key and press Save.</p>${keyBox(wants as store.KeyName, `${missing} key`)}${wants === 'azure' ? `<div class="key"><input type="text" class="field" data-name="azureRegion" value="${esc(extras.azureRegion ?? 'eastus')}" placeholder="Region, for example eastus" autocapitalize="off" autocorrect="off" spellcheck="false"><button data-a="test-azure">Test</button></div>` : ''}` : ''}
    ${extras.voice === 'speechify' || voiceKind === 'speechify' ? speechifyRowsHtml(extras, keys) : voiceList}
    <button class="big" data-a="test-voice">Hear the voice</button>
    ${range('teacherVolume', 'Volume', extras.teacherVolume ?? 60, { min: 0, max: 100, step: 5 }, `${extras.teacherVolume ?? 60}%`)}
    ${range('rate', 'Speed', Math.round(rateNow() * 20) / 20, { min: 0.6, max: 1.4, step: 0.05 }, `${rateNow().toFixed(2)}×`)}
    <h4>Keys</h4>
    ${keyBox('anthropic', 'Claude')}${keyBox('azure', 'Microsoft voice')}${keyBox('openai', 'OpenAI')}${keyBox('elevenlabs', 'ElevenLabs')}
    <p class="note">Keys stay on this device (in its Keychain). Claude explains; the Microsoft key (free) gives the natural voice.</p>
    ${inApp() ? '<button class="big" data-a="app-settings">My word file, and more settings</button>' : ''}`, true);
  const again = () => { if (sheetKind === 'tutor') { const top = body.scrollTop; tutorSheet(); $('sheet-body').scrollTop = top; } };
  const afterVoice = async () => { const was = reading(); if (was) setPlaying(false); else cancelSpeech(); await prepareVoice(); again(); if (was && !playing && shelf) setPlaying(true); };
  wireSpeechifyRows(body, { toast, changed: () => void Promise.all([store.getExtras(), store.getKeys()]).then(([x, k]) => { extras = x; keys = k; return afterVoice(); }) });
  body.oninput = (ev) => {
    const t = ev.target as HTMLInputElement;
    const name = t.dataset.name;
    if (!name || t.type !== 'range') return;
    const v = Number(t.value);
    const out = t.parentElement?.querySelector('output');
    // ("how much": the number follows the finger; it is stored, and the stops worked out, a moment after the last step)
    if (name === 'pctWords' || name === 'pctPhrases' || name === 'pctSentences') { if (out) out.textContent = `${v}%`; clearTimeout(pctSoon[name]); pctSoon[name] = setTimeout(() => void patchX({ [name]: clampPct(v) }).then(() => rescoreSoon()), 200); }
    else if (name === 'teacherVolume') { if (out) out.textContent = `${v}%`; void patchX({ teacherVolume: v, wordVolume: v }); }
    else if (name === 'rate') { if (out) out.textContent = `${v.toFixed(2)}×`; settings = { ...settings, voice: { ...settings.voice, rate: v } }; void store.updateSettings((cur) => ({ voice: { ...cur.voice, rate: v } })).catch(() => undefined); paintPlay(); }
  };
  body.onchange = (ev) => {
    const t = ev.target as HTMLSelectElement | HTMLInputElement;
    const name = t.dataset.name;
    if (name === 'azureVoice' || name === 'openaiVoice' || name === 'elevenVoice') void patchX({ [name]: t.value }).then(afterVoice);
    else if (name === 'macVoice') { settings = { ...settings, voice: { ...settings.voice, voiceId: t.value } }; void store.updateSettings((cur) => ({ voice: { ...cur.voice, voiceId: t.value } })).then(afterVoice, () => undefined); }
    else if (name === 'azureRegion') void patchX({ azureRegion: store.azureRegionOf(t.value) || 'eastus' });
  };
  body.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    const group = b.parentElement?.classList.contains('opts') ? b.parentElement.dataset.name : '';
    const v = b.dataset.v ?? '';
    if (group === 'tutorOn') void patchX({ tutorOn: v === 'on' }).then(async () => { await prepareVoice(); debug(); again(); });
    else if (group === 'learnerLevel') { settings = { ...settings, learnerLevel: v as Settings['learnerLevel'] }; rankWords = null; void store.updateSettings(() => ({ learnerLevel: v as Settings['learnerLevel'] })).catch(() => undefined); void patchX({ myLevel: cefrToLevel(v), levelAuto: false }).then(() => { rescoreSoon(true); again(); }); }
    else if (group === 'stopItemsOn' || group === 'stopPhrasesOn' || group === 'stopHardOn') void patchX({ [group]: v === 'on' }).then(() => { applyLook(false); rescoreSoon(); again(); });
    else if (group === 'cardSize') void patchX({ cardSize: v === 'small' ? 'small' : 'big' }).then(again);
    else if (group === 'showSay') void patchX({ showSay: v === 'on' }).then(again);
    else if (group === 'voice') void patchX({ voice: v as store.VoiceChoice }).then(afterVoice);
    else if (b.dataset.a === 'test-voice') { if (reading()) setPlaying(false); else cancelSpeech(); void say('Hello! I am your English tutor. Let us read this book together.'); }
    else if (b.dataset.a === 'test-azure') void (chrome.runtime.sendMessage({ type: 'dream-test-azure' }) as Promise<{ ok: boolean; message: string } | undefined>).then(async (r) => { toast(r?.message ?? 'No answer.', 7000); extras = await store.getExtras(); await afterVoice(); }, () => toast('No answer.'));
    else if (b.dataset.a === 'save-key') {
      const k = b.dataset.k as store.KeyName;
      const inp = b.closest('.key')?.querySelector<HTMLInputElement>('input[data-key]');
      const val = inp?.value.trim() ?? '';
      if (!val) { toast('Paste the key first.'); return; }
      void store.setKey(k, val).then(async () => {
        keys = await store.getKeys();
        if (k === 'azure') { await patchX({ voice: 'azure' }); const r = (await chrome.runtime.sendMessage({ type: 'dream-test-azure' }).catch(() => null)) as { ok: boolean; message: string } | null; extras = await store.getExtras(); toast(r ? (r.ok ? `Key saved. ${r.message}` : `Key saved, but: ${r.message}`) : 'Key saved.', 7000); }
        else toast('Key saved.');
        await afterVoice();
        debug();
      });
    }
    else if (b.dataset.a === 'app-settings') { closeSheet(); void appPost({ kind: 'appSettings' }); }
  };
}

function addSheet(paste = false): void {
  const body = openSheet('add', paste ? `
    <h4>Paste a text</h4>
    <input class="field" id="p-title" type="text" placeholder="Its title" style="width:100%;margin-bottom:10px">
    <textarea class="field" id="p-text" placeholder="Paste the text here"></textarea>
    <button class="big go" data-a="paste-go">Read this text</button>` : `
    <h4>Add a book</h4>
    <button class="big go" data-a="file">Choose a file (EPUB, PDF, text)</button>
    <button class="big" data-a="paste">Paste a text</button>
    <button class="big" data-a="sample">Try a short story</button>
    <p class="note">Books bought in Kindle or Apple Books are locked and cannot be opened. Your books stay on this device.</p>`, true);
  body.oninput = null; body.onchange = null;
  body.onclick = (ev) => {
    const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'file') { closeSheet(); $<HTMLInputElement>('file').click(); }
    else if (a === 'paste') addSheet(true);
    else if (a === 'sample') { closeSheet(); void openSample(); }
    else if (a === 'paste-go') {
      const text = $<HTMLTextAreaElement>('p-text').value;
      if (!text.trim()) { toast('Paste a text first.'); return; }
      const title = $<HTMLInputElement>('p-title').value.trim() || text.trim().split(/\s+/).slice(0, 6).join(' ');
      closeSheet();
      void openPasted(title, text).catch((e: Error) => { $('lib-msg').textContent = e.message; });
    }
  };
}
const openSample = (): Promise<void> => openPasted(SAMPLE_TITLE, SAMPLE_TEXT, SAMPLE_AUTHOR).catch((e: Error) => { $('lib-msg').textContent = e.message; });
function bookSheet(id: string, title: string): void {
  const body = openSheet('book', `<h4>${esc(title)}</h4><button class="big go" data-a="open">Read</button><button class="big" data-a="listen">Listen</button><button class="big danger" data-a="remove">Remove from my books</button><p class="note">Removing a book keeps the words you learned from it.</p>`, true);
  body.oninput = null; body.onchange = null;
  body.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]');
    const a = b?.dataset.a;
    if (a === 'open' || a === 'listen') { closeSheet(); void openBook(id, a === 'listen' ? 'listen' : 'read').catch((e: Error) => { $('lib-msg').textContent = e.message; }); }
    else if (a === 'remove' && b) {
      if (b.dataset.sure) { closeSheet(); void bookStore().then((st) => st.remove(id)).then(() => chrome.storage.local.remove(`bkHere:${id}`).catch(() => undefined)).then(paintLibrary); }
      else { b.dataset.sure = '1'; b.textContent = 'Tap again to remove'; }
    }
  };
}

// ---- start ---------------------------------------------------------------------------------------------------------
function wireChrome(): void {
  $('lib-set').innerHTML = ICON.gear; $('b-lib').innerHTML = ICON.back; $('b-tutor').innerHTML = ICON.tutor;
  $('c-prev').innerHTML = ICON.prev; $('c-next').innerHTML = ICON.next;
  for (const id of ['t-back', 'm-back']) $(id).innerHTML = ICON.sback;
  for (const id of ['t-fwd', 'm-fwd']) $(id).innerHTML = ICON.sfwd;
  $('mode-read').innerHTML = `${ICON.book} Read`; $('mode-listen').innerHTML = `${ICON.ear} Listen`;
  $('lib-set').onclick = () => tutorSheet();
  $('b-lib').onclick = () => showLibrary();
  $('b-look').onclick = () => (sheetKind === 'look' ? closeSheet() : lookSheet());
  $('b-tutor').onclick = () => (sheetKind === 'tutor' ? closeSheet() : tutorSheet());
  $('veil').onclick = () => closeSheet();
  $('c-prev').onclick = () => { setPlaying(false); showChapter(chapter - 1, null); };
  $('c-next').onclick = () => { setPlaying(false); showChapter(chapter + 1, null); };
  $('chapters').onchange = () => { setPlaying(false); showChapter(Number($<HTMLSelectElement>('chapters').value) || 0, null); };
  $('modes').onclick = (ev) => { const m = (ev.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode; if (m === 'read' || m === 'listen') setMode(m); };
  for (const id of ['t-play', 'm-play']) $(id).onclick = () => setPlaying(!reading());
  for (const id of ['t-back', 'm-back']) $(id).onclick = () => stepSentence(-1);
  for (const id of ['t-fwd', 'm-fwd']) $(id).onclick = () => stepSentence(1);
  $('t-speed').onclick = () => { const steps = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3]; const cur = rateNow(); const next = steps.find((s) => s > cur + 0.01) ?? steps[0]; settings = { ...settings, voice: { ...settings.voice, rate: next } }; void store.updateSettings((c) => ({ voice: { ...c.voice, rate: next } })).catch(() => undefined); paintPlay(); };
  $('t-voice').onclick = () => tutorSheet();
  $('file').addEventListener('change', () => { const f = $<HTMLInputElement>('file').files?.[0]; if (f) void openFile(f); });
  $('e-file').onclick = () => $<HTMLInputElement>('file').click();
  $('e-paste').onclick = () => addSheet(true);
  $('e-sample').onclick = () => void openSample();
  const libClick = (ev: Event) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!b) return;
    const holder = b.closest<HTMLElement>('[data-id]');
    const a = b.dataset.a;
    if (a === 'add') { addSheet(); return; }
    const id = holder?.dataset.id;
    if (!id) return;
    if (a === 'more') bookSheet(id, holder!.querySelector('.t')?.textContent ?? 'This book');
    else void openBook(id, a === 'listen' ? 'listen' : 'read').catch((e: Error) => { $('lib-msg').textContent = e.message; });
  };
  $('hero').addEventListener('click', libClick);
  $('grid').addEventListener('click', libClick);
}

async function boot(): Promise<void> {
  { const st = document.createElement('style'); st.textContent = SPEECHIFY_CSS; document.head.append(st); }
  wireChrome(); wirePage(); wireSelection();
  const o = await chrome.storage.local.get([LOOK_KEY, OPEN_KEY, MODE_KEY]).catch(() => ({} as Record<string, unknown>));
  [extras, settings, keys] = await Promise.all([store.getExtras(), store.getSettings(), store.getKeys()]);
  look = o[LOOK_KEY] ? readLook(o[LOOK_KEY]) : { ...DEFAULT_LOOK, size: innerWidth >= 700 ? 20 : 18 };
  mode = o[MODE_KEY] === 'listen' ? 'listen' : 'read';
  applyLook(false);
  try { window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyLook(false)); } catch { /* an old browser */ }
  let resizeT: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => { if (resizeT) clearTimeout(resizeT); resizeT = setTimeout(() => layout(true, true), 120); });
  // (leaving: what was waiting for the next frame is written now)
  window.addEventListener('pagehide', () => { runLater(); savePlaceNow(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { runLater(); savePlaceNow(); } });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    // (what this page wrote itself comes back here too: it is the same as what the page has, and costs nothing)
    if (ch[store.STORAGE_KEYS.extras]) {
      const next = { ...store.DEFAULT_EXTRAS, ...(ch[store.STORAGE_KEYS.extras].newValue as Partial<store.YtExtras> | undefined) };
      const a = extras as unknown as Record<string, unknown>, b = next as unknown as Record<string, unknown>;
      const same = [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => a[k] === b[k] || JSON.stringify(a[k]) === JSON.stringify(b[k]));
      extras = next;
      if (shelf && !same) { applyLook(false); rescoreSoon(true); }
    }
    if (ch[store.STORAGE_KEYS.keys]) void store.getKeys().then(async (k) => { keys = k; await prepareVoice(); debug(); });
    if (shelf && ch[store.STORAGE_KEYS.vocab]) {
      const next = (ch[store.STORAGE_KEYS.vocab].newValue as VocabState | undefined)?.words ?? {};
      const changed: string[] = [];
      for (const k of Object.keys(next)) if (vocab.words[k] !== next[k] && !writing.has(k)) changed.push(k);
      for (const k of Object.keys(vocab.words)) if (!(k in next) && !writing.has(k)) changed.push(k);
      // (another window changed my words: the light pass, for those words only)
      if (changed.length) {
        const words = { ...next };
        for (const k of writing.keys()) if (vocab.words[k]) words[k] = vocab.words[k];
        vocab = { words, marked: {} };
        restatus(changed);
      }
    }
    if (shelf && ch[store.STORAGE_KEYS.settings]) void store.getSettings().then((s) => { const lvl = s.learnerLevel !== settings.learnerLevel; settings = s; if (lvl) { rankWords = null; rescoreSoon(true); } paintPlay(); });
  });
  await paintLibrary();
  // (the tutor's settings can be opened from the library, before any book: the voice is known by then)
  await prepareVoice().catch(() => undefined);
  // back where you stopped: the book that was open opens again, on its page
  const id = o[OPEN_KEY];
  if (typeof id === 'string' && id) await openBook(id).catch(() => void chrome.storage.local.set({ [OPEN_KEY]: '' }));
  document.body.dataset.ready = '1';
  debug();
}

/** for the app itself and for tests */
(window as unknown as { __iknowBook?: unknown }).__iknowBook = {
  openText: (title: string, text: string, author = '') => openPasted(title, text, author).then(() => true, () => false),
  sample: () => openSample(),
  library: () => showLibrary(),
  quiet: () => { if (shelf) { setPlaying(false); savePlaceNow(); } },
  save: () => savePlaceNow(),
  play: (on: boolean) => setPlaying(on),
  turn: (d: 1 | -1) => turn(d),
};
void boot();
