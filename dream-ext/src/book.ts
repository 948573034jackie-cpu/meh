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
import { cloudEngine, resolveVoice, VoiceWithBackup, WithVolume, sliderGain, OPENAI_VOICES, ELEVEN_VOICES, AZURE_VOICES } from './voice';
import { unknownChance, phraseSig, type LevelMeta } from './level-db';
import { buildItemsPrompt, parseItems, type AiItem } from './level-check';
import { scoreSentences, selectStopsByLevel, keepHardest, kindWith, itemsToHits, stopKindOf, type SentenceScore, type StopCaps } from './level-stops';
import { RuleGuard, type RuleRequest } from './level-rule';
import { buildHardSentencesPrompt, parseHardSentences } from './hard-sentences';
import { rawFromPlain, rawFromTextFile, chapterOf, charsBefore, pdfToText } from './reader-text';
import { parseEpub, type RawBook, type RawChapter } from './epub';
import { bookStore, shelfOf, percentOf, sortShelf, type ShelfBook, type StoredText } from './book-store';
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---- quiet line icons ------------------------------------------------------------------------------------------
const ic = (d: string, fill = false) => `<svg class="ic" viewBox="0 0 24 24"${fill ? ' style="fill:currentColor;stroke:none"' : ''}>${d}</svg>`;
const ICON = {
  gear: ic('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  back: ic('<path d="M15 5l-7 7 7 7"/>'),
  prev: ic('<path d="M14 6l-6 6 6 6"/>'),
  next: ic('<path d="M10 6l6 6-6 6"/>'),
  play: ic('<path d="M8 5.2v13.600l11-6.800z"/>', true),
  pause: ic('<path d="M7 5h3.600v14H7zM13.400 5H17v14h-3.600z"/>', true),
  sback: ic('<path d="M11 7l-6 5 6 5z"/><path d="M19 7l-6 5 6 5z"/>'),
  sfwd: ic('<path d="M13 7l6 5-6 5z"/><path d="M5 7l6 5-6 5z"/>'),
  book: ic('<path d="M4 5.500A2.500 2.500 0 0 1 6.500 3H20v15H6.500A2.500 2.500 0 0 0 4 20.500z"/><path d="M4 20.500A2.500 2.500 0 0 0 6.500 23H20"/>'),
  ear: ic('<path d="M4 14.500V12a8 8 0 0 1 16 0v2.500"/><rect x="3" y="14" width="4.500" height="6.500" rx="1.800"/><rect x="16.500" y="14" width="4.500" height="6.500" rx="1.800"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  tutor: ic('<path d="M4 6h16v10H9l-5 4z"/><path d="M8.500 10h7M8.500 13h4"/>'),
  more: ic('<circle cx="5" cy="12" r="1.400"/><circle cx="12" cy="12" r="1.400"/><circle cx="19" cy="12" r="1.400"/>', true),
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
let voiceKind: 'mac' | 'openai' | 'elevenlabs' | 'azure' = 'mac';
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
  });
}

// ---- the look ----------------------------------------------------------------------------------------------------
function applyLook(relayout = true): void {
  const root = document.documentElement;
  const theme = themeOf(look, systemDark());
  for (const [k, v] of Object.entries({ ...paletteOf(theme), ...textVars(look) })) root.style.setProperty(k, v);
  root.dataset.align = look.align;
  root.dataset.dark = theme.dark ? '1' : '0';
  root.dataset.marks = extras.stopItemsOn === false ? '0' : '1';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.bg);
  if (relayout && shelf) layout(true);
  debug();
}
let lookSave: ReturnType<typeof setTimeout> | null = null;
function setLook(patch: Partial<Look>): void {
  look = readLook({ ...look, ...patch });
  applyLook();
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
      <span class="p" style="display:flex;justify-content:space-between;align-items:center"><span>${x.percent}%</span><button data-a="more" aria-label="More for ${esc(x.title)}" style="width:44px;height:28px;display:grid;place-items:center;margin:-6px -12px -6px 0">${ICON.more}</button></span></div>`).join('')
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
  delete document.body.dataset.sentences;
  void paintLibrary();
}

const hex = async (data: BufferSource): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
/** very long chapters are cut into parts of about 250 paragraphs: a page of the book turns fast, whatever the file */
function partsOf(chapters: RawChapter[]): RawChapter[] {
  const out: RawChapter[] = [];
  for (const c of chapters) {
    if (c.blocks.length <= 320) { out.push(c); continue; }
    const n = Math.ceil(c.blocks.length / 250);
    for (let i = 0; i < n; i++) out.push({ title: `${c.title || 'Part'} (${i + 1} of ${n})`, blocks: c.blocks.slice(i * 250, (i + 1) * 250) });
  }
  return out;
}
async function addBook(id: string, kind: ShelfBook['kind'], raw: RawBook, then: 'read' | 'listen' = 'read'): Promise<void> {
  const chapters = partsOf(raw.chapters.filter((c) => c.blocks.some((b) => b.text.trim())));
  if (!chapters.length) throw new Error('No readable text was found in it.');
  const st = await bookStore();
  const had = await st.get(id).catch(() => null);
  if (!had) await st.add(shelfOf(id, kind, { ...raw, chapters }), { id, chapters });
  await openBook(id, then);
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
async function openBook(id: string, then: 'read' | 'listen' | 'same' = 'same'): Promise<void> {
  const got = await (await bookStore()).get(id);
  if (!got) throw new Error('This book is not in the library any more.');
  busy('Opening…');
  try {
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
function render(): void {
  const ch = book.chapters[chapter];
  const parts: string[] = [];
  const many = (stored?.chapters.length ?? 1) > 1;
  if (many && ch.title && !/^\s*$/.test(ch.title)) parts.push(`<p class="chap">${esc(ch.title)}</p>`);
  for (const para of ch.paragraphs) {
    let html = '', cursor = 0;
    for (const s of para.sentences) {
      html += esc(para.text.slice(cursor, s.start));
      html += `<span class="s" data-key="${ch.index}.${para.index}.${s.index}">`;
      let at = s.start;
      for (const t of s.tokens) {
        html += esc(para.text.slice(at, t.start));
        html += t.kind === 'word' ? `<span class="w" data-lemma="${esc(dict.lemmaOf(t.text))}">${esc(t.text)}</span>` : esc(t.text);
        at = t.end;
      }
      html += `${esc(para.text.slice(at, s.end))}</span>`;
      cursor = s.end;
    }
    parts.push(`<p${para.kind !== 'p' ? ` class="${para.kind}"` : ''}>${html}${esc(para.text.slice(cursor))}</p>`);
  }
  $('flow').innerHTML = parts.join('');
}

function showChapter(c: number, place: { paragraph: number; sentence: number } | null, atEnd = false): void {
  if (!stored) return;
  closeCard();
  chapter = clamp(c, 0, stored.chapters.length - 1);
  if (!cut.has(chapter)) {
    book.chapters[chapter] = chapterOf(stored.chapters[chapter], chapter, segmenter);
    cut.add(chapter);
    for (const n of detectNames({ chapters: [book.chapters[chapter]] }, dict)) names.add(n);
  }
  order = []; wordsBefore = [];
  let w = 0;
  for (const p of book.chapters[chapter].paragraphs) for (const s of p.sentences) { order.push({ chapter, paragraph: p.index, sentence: s.index }); wordsBefore.push(w); w += s.tokens.filter((t) => t.kind === 'word').length; }
  phrases = {}; hardSet = new Set(); aiStarted = null;
  stops = 0; heardKeys.clear(); stopped.clear(); rankWords = null; rankDone = null;
  const at = place ? order.findIndex((p) => p.paragraph === place.paragraph && p.sentence === place.sentence) : -1;
  index = Math.max(0, at);
  render();
  recompute();
  paintChapters();
  document.body.dataset.sentences = String(order.length);
  document.body.dataset.chapter = String(chapter);
  anchorPos = null;
  layout(false);
  if (atEnd) goPage(pages - 1, false);
  else if (at > 0) { const el = sentenceEl(order[at]); goPage(el ? pageOf(el) : 0, false, false); anchorPos = order[at]; }
  else goPage(0, false);
  if (mode === 'listen' && tutorOn()) void startAi();
}
function paintChapters(): void {
  const n = stored?.chapters.length ?? 0;
  const sel = $<HTMLSelectElement>('chapters');
  if (sel.options.length !== n || sel.dataset.book !== (shelf?.id ?? '')) {
    sel.dataset.book = shelf?.id ?? '';
    sel.textContent = '';
    stored!.chapters.forEach((c, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = n > 1 ? `${i + 1}. ${c.title || `Chapter ${i + 1}`}`.slice(0, 60) : (shelf?.title ?? '').slice(0, 60); sel.append(o); });
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
const sentenceEl = (pos: Position) => document.querySelector<HTMLElement>(`#flow .s[data-key="${sentenceKey(pos)}"]`);
/** the page an element starts on */
function pageOf(el: HTMLElement): number {
  const f = $('flow').getBoundingClientRect();
  const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
  return clamp(Math.floor((r.left - f.left + 2) / pageW), 0, pages - 1);
}
/** the first sentence that starts on the page now (or the one that runs into it) */
const firstOnPage = (): number => firstOnPageOf(page);
function firstOnPageOf(pg: number): number {
  const els = document.querySelectorAll<HTMLElement>('#flow .s');
  let lo = 0, hi = els.length - 1, ans = els.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (pageOf(els[mid]) >= pg) { ans = mid; hi = mid - 1; } else lo = mid + 1; }
  return clamp(ans, 0, Math.max(0, order.length - 1));
}
/** the page is measured again (the size, the margins, the screen changed); `keep`: stay at the same sentence */
function layout(keep: boolean): void {
  if (!shelf) return;
  const anchor = keep && order.length ? (playing ? order[index] : anchorPos ?? order[firstOnPage()]) : null;
  const pg = $('page'), flow = $('flow');
  const W = pg.clientWidth;
  // (an iPad: a column of about 34 em in the middle, never a line across the whole screen)
  const col = Math.max(120, Math.min(W - 2 * look.margin, Math.round(look.size * 34)));
  const root = document.documentElement.style;
  root.setProperty('--col', `${col}px`);
  root.setProperty('--gap', `${W - col}px`);
  pageW = W;
  flow.classList.add('jump');
  root.setProperty('--shift', '0px');
  // (the width of all the columns: the last child's right edge tells how many pages there are)
  const last = flow.lastElementChild as HTMLElement | null;
  const f = flow.getBoundingClientRect();
  const rects = last?.getClientRects();
  const right = rects?.length ? rects[rects.length - 1].right : f.right;
  pages = Math.max(1, Math.ceil((right - f.left - 1) / W));
  const el = anchor ? sentenceEl(anchor) : null;
  goPage(el ? pageOf(el) : Math.min(page, pages - 1), false, false);
  if (anchor && !anchorPos) anchorPos = anchor;
}
function goPage(n: number, animate = true, moved = true): void {
  page = clamp(n, 0, pages - 1);
  if (moved) anchorPos = order.length ? order[firstOnPageOf(page)] : null;
  const flow = $('flow');
  flow.classList.toggle('jump', !animate);
  document.documentElement.style.setProperty('--shift', `${-page * pageW}px`);
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
  const pos = order[playing ? index : firstOnPage()];
  const ch = book.chapters[chapter];
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
  $('t-voice').textContent = voiceKind === 'azure' ? 'Microsoft' : voiceKind === 'openai' ? 'OpenAI' : voiceKind === 'elevenlabs' ? 'ElevenLabs' : 'iPhone';
}

// ---- the voice -----------------------------------------------------------------------------------------------------
async function prepareVoice(): Promise<void> {
  if (extras.fakeVoice) useFakeEngine(2);
  const mac = getEngine('webspeech');
  macVoices = (await mac.listVoices().catch(() => [])).filter((v) => /^en/i.test(v.lang ?? '')).map((v) => ({ id: v.id, name: v.name, lang: v.lang ?? '' }));
  const macVoice = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
  // (the tutor off: the device's own voice only, never a paid one)
  voiceKind = tutorOn() ? resolveVoice(extras.voice, keys) : 'mac';
  const base: TtsEngine = voiceKind === 'mac' ? mac : new VoiceWithBackup(cloudEngine(voiceKind, 'en'), mac, () => macVoice, (e) => { lastVoiceError = e.message; toast(`The ${voiceKind === 'azure' ? 'Microsoft' : voiceKind} voice had a problem: ${e.message}`, 6000); });
  voiceId = voiceKind === 'mac' ? macVoice : voiceKind === 'openai' ? extras.openaiVoice : voiceKind === 'azure' ? extras.azureVoice : extras.elevenVoice;
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
  return h.done.then((o) => { if (speaking === h) speaking = null; return o === 'ended'; }, () => false);
}
function cancelSpeech(): void { speaking?.cancel(); explaining?.cancel(); tts?.cancelAll(); }
const textOf = (pos: Position): string => getSentence(book, pos)?.text ?? '';
const idxOf = (pos: Position): number => order.findIndex((p) => p.paragraph === pos.paragraph && p.sentence === pos.sentence);

// ---- what is hard: my level, how much of each kind, my own words (the same rule as I Know) ------------------------
function recompute(): void {
  if (!order.length || !dict) return;
  const done = new Set<string>();
  for (const [k, st] of Object.entries(vocab.words)) if (k.includes(' ') && (st === 'known' || st === 'ignored')) done.add(phraseSig(dict, k));
  rankWords ??= { ...vocab.words } as Record<string, WordStatus>;
  rankDone ??= done;
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
  const kept = keepHardest(all, pcts(), (lemma, kind) => numbers.get(`${kind}:${lemma}`) ?? 0, (lemma) => atStart[lemma] === 'learning');
  const gone = (l: string) => vocab.words[l] === 'known' || vocab.words[l] === 'ignored' || done.has(phraseSig(dict, l));
  const list = kept.map((sc) => {
    const idx = sc.lemmas.map((_, i) => i).filter((i) => !gone(sc.lemmas[i]));
    if (idx.length === sc.lemmas.length) return sc;
    const kinds = idx.map((i) => sc.kinds[i]);
    return { ...sc, items: idx.map((i) => sc.items[i]), lemmas: idx.map((i) => sc.lemmas[i]), kinds, kind: stopKindOf(kinds) };
  });
  scores = new Map(list.map((s) => [s.key, s]));
  stopSet = selectStopsByLevel(list, caps());
  // the quiet marks in the text: harder than my level and not known; still learning = a full line
  const ctx = { dict, zipf, words: vocab.words, myLevel: mine, names };
  for (const el of document.querySelectorAll<HTMLElement>('#flow .w[data-lemma]')) {
    const m = markOf(el.textContent ?? '', ctx);
    el.classList.toggle('learning', m === 'learning');
    el.classList.toggle('hard', m === 'hard');
  }
  debug();
}
interface StopNow { items: { kind: 'word' | 'phrase'; target: string; lemma: string }[]; sentence: boolean }
/** does the reading stop after this sentence, and for what (nothing is changed by asking) */
function stopFor(pos: Position): StopNow | null {
  const key = sentenceKey(pos);
  // (the tutor off: the book is read like any audiobook, no stop by itself)
  if (!tutorOn() || !stopSet.has(key) || stopped.has(key)) return null;
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
const aiId = (): string => ((stored?.chapters.length ?? 1) > 1 ? `${book.id}#${chapter}` : book.id);
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
      if (items) { phrases = itemsToHits(book, order, items, dict); recompute(); }
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
      recompute();
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
interface CardNow { kind: CardKind; target: string; lemma: string; pos: Position; openedAt: number; big: boolean; said: string; /** only looked up by hand, nothing explains it: a tap closes it */ only: boolean }
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
  cardNow = { kind, target, lemma, pos, openedAt: Date.now(), big: cardBig(), said: '', only };
  paintCard();
}
function closeCard(): void {
  $('card').hidden = true; $('small').hidden = true; $('caption').hidden = true;
  $('card').querySelector('.wait')!.classList.remove('run');
  cardNow = null;
  document.querySelectorAll('#flow .w.pick').forEach((e) => e.classList.remove('pick'));
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
/** a tap on the card = "I know" (not in its first 450 ms: that tap was meant for the page under it) */
function cardKnow(): void {
  const c = cardNow;
  if (!c || Date.now() - c.openedAt < 450) return;
  // (a word that was only looked up, with no tutor behind it: the tap closes its card. It stays a word I am learning.)
  if (c.only) { dropCard(); return; }
  verdict = 'know';
  if (answer) { answer('know'); return; }
  cancelSpeech();
  if (!teaching) knowCard(c);
}
function knowCard(c: CardNow): void {
  if (c.kind !== 'sentence') markKnownNow(c.lemma, c.target);
  else void store.setWordStatus(c.lemma, 'known', { word: c.target.slice(0, 80) }).catch(() => undefined);
  closeCard();
}
function markKnownNow(lemma: string, word: string): void {
  vocab.words[lemma] = 'known';
  void store.setWordStatus(lemma, 'known', { word }).catch(() => undefined);
  recompute();
}

// ---- the tutor explains ----------------------------------------------------------------------------------------------
function requestFor(kind: CardKind, target: string, pos: Position): RuleRequest {
  const ctx = contextAround(book, pos, 80, 40);
  const known = new Set<string>();
  for (const t of getSentence(book, pos)?.sentence.tokens ?? []) if (t.kind === 'word' && vocab.words[dict.lemmaOf(t.text)] === 'known') known.add(t.text.toLowerCase());
  const teachLen = (() => { const l = settings.ai.explanationLength as string; return l === 'short' || l === 'long' ? l : 'normal'; })();
  return {
    kind: kind as RuleRequest['kind'], target, sentence: textOf(pos) || target, before: ctx.before, after: ctx.after,
    book: { title: book.title, chapter: book.chapters[chapter]?.title ?? '' }, history: [], position: pos,
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
  const known = () => { if (kind !== 'sentence') markKnownNow(lemma, target); else void store.setWordStatus(lemma, 'known', { word: target.slice(0, 80) }).catch(() => undefined); closeCard(); return 'known' as const; };
  openCard(kind, target, lemma, pos, !o.wait && (!tutorOn() || !hasAi()));
  if (kind !== 'sentence' && !vocab.words[lemma]) { vocab.words[lemma] = 'learning'; void store.setWordStatus(lemma, 'learning', { word: target, sentence }).catch(() => undefined); recompute(); }
  if (kind !== 'sentence') { heard.ask(lemma, wordsBefore[idxOf(pos)] ?? 0); saveHeardSoon(); }
  const times = async (n: number): Promise<boolean> => {
    for (let i = 0; i < n; i++) {
      if (i > 0) await sleep(350);
      if (!alive()) return false;
      if (verdict) return true;
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
    void saveExplained({ lemma, word: target, sentence, explanation, chinese: zhFor(kind, target, lemma, pos).zh, bookId: book.id, bookTitle: book.title, chapter: book.chapters[chapter]?.title ?? '', position: pos }, extras.knownAfter ?? 7)
      .then((r) => { if (r?.nowKnown) { vocab.words[lemma] = 'known'; recompute(); toast(`“${target}” was explained ${r.times} times: it counts as known now.`, 5000); } }, () => undefined);
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
  document.querySelector('#flow .s.cur')?.classList.remove('cur');
  const el = pos && sentenceEl(pos);
  if (!el) return;
  el.classList.add('cur');
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
    tts.readAhead?.(order.slice(index + 1, index + 3).map(textOf).filter(Boolean), voiceId, rateNow());
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
  document.querySelectorAll('#flow .w.pick').forEach((e) => e.classList.remove('pick'));
  el.classList.add('pick');
  const word = (el.textContent ?? '').trim();
  void teachByHand('word', word, el.dataset.lemma || word.toLowerCase(), { chapter: c, paragraph: p, sentence: s });
}
function wireSelection(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = '';
  document.addEventListener('selectionchange', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const sel = window.getSelection();
      const t = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (!sel || sel.isCollapsed || !t || t === last || t.length > 700) { if (!t) last = ''; return; }
      const from = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>('#flow .s');
      if (!from) return;
      const words = t.split(' ').filter(Boolean);
      if (words.length < 2) return;
      last = t;
      const [c, p, s] = from.dataset.key!.split('.').map(Number);
      const pos = { chapter: c, paragraph: p, sentence: s };
      sel.removeAllRanges();
      // (a few words = a phrase; more, or a whole sentence = the sentence card: its translation, no pronunciation)
      if (words.length <= 6) void teachByHand('phrase', t, t.toLowerCase(), pos);
      else void teachByHand('sentence', t, sentenceLemma(t), pos);
    }, 900);
  });
}

// ---- fingers: a swipe turns the page, a tap on a word explains it, a tap in the middle calls the bars ----------------
function wirePage(): void {
  // (the whole reading screen: the narrow bands above and under the text belong to it too)
  const pg = $('rd');
  const inBars = (t: HTMLElement | null): boolean => !!t?.closest('.chrome, #mini');
  let down: { x: number; y: number; at: number } | null = null;
  let lastTouch = 0;
  const tap = (x: number, y: number, target: HTMLElement | null) => {
    if (sheetOpen()) { closeSheet(); return; }
    if (cardNow && !cardNow.big) { dropCard(); return; }
    const w = innerWidth;
    // (the band above the text and the band under it: the bars come and go. On a page full of words this is the sure
    // place to tap; a tap on a word explains the word.)
    { const r = $('page').getBoundingClientRect(); if (y < r.top + 6 || y > r.bottom - 6) { setChrome(!chromeOn()); return; } }
    const strip = look.tapEdges ? 64 : Math.max(look.margin, 30);
    const edge = x < strip ? -1 : x > w - strip ? 1 : 0;
    // (the bars are showing: a tap on the page sends them away, nothing else)
    if (chromeOn() && !playing) { setChrome(false); return; }
    const word = target?.closest<HTMLElement>('#flow .w[data-lemma]') ?? null;
    if (edge && (look.tapEdges || !word)) { turn(edge as 1 | -1); return; }
    if (word) { tappedWord(word); return; }
    // (beside the text: the left third goes back, the right third goes on, the middle calls the bars)
    if (x < w * 0.28) turn(-1); else if (x > w * 0.72) turn(1); else setChrome(!chromeOn());
  };
  pg.addEventListener('touchstart', (ev) => { const t = ev.touches[0]; down = ev.touches.length === 1 && !inBars(ev.target as HTMLElement) ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; }, { passive: true });
  pg.addEventListener('touchend', (ev) => {
    const d = down; down = null;
    lastTouch = Date.now();
    const t = ev.changedTouches[0];
    if (!d || !t) return;
    const dx = t.clientX - d.x, dy = t.clientY - d.y, dt = Date.now() - d.at;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 900) { window.getSelection()?.removeAllRanges(); turn(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 420 && !window.getSelection()?.toString().trim()) tap(t.clientX, t.clientY, ev.target as HTMLElement);
  }, { passive: true });
  // (a mouse, on a computer)
  pg.addEventListener('click', (ev) => { if (Date.now() - lastTouch < 700 || inBars(ev.target as HTMLElement)) return; if (!window.getSelection()?.toString().trim()) tap(ev.clientX, ev.clientY, ev.target as HTMLElement); });
  const cardTap = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); cardKnow(); };
  let cardTouch = 0;
  let cardDown: { x: number; y: number; at: number } | null = null;
  $('card').addEventListener('touchstart', (ev) => { const t = ev.touches[0]; cardDown = t && ev.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null; }, { passive: true });
  $('card').addEventListener('touchend', (ev) => {
    cardTouch = Date.now();
    const d = cardDown; cardDown = null;
    const t = ev.changedTouches[0];
    if (!d || !t || Math.abs(t.clientX - d.x) > 10 || Math.abs(t.clientY - d.y) > 10 || Date.now() - d.at > 600) { ev.stopPropagation(); return; }
    cardTap(ev);
  });
  $('card').addEventListener('click', (ev) => { if (Date.now() - cardTouch < 700) return; cardTap(ev); });
  $('small').addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    const c = cardNow;
    if (!a || !c) return;
    if (a === 'close') dropCard();
    else if (a === 'know') { verdict = 'know'; if (answer) answer('know'); else { cancelSpeech(); if (!teaching) knowCard(c); } }
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
  const lpl = () => { const n = lettersPerLine(Math.min($('page').clientWidth, look.size * 34 + 2 * look.margin), look); $('lpl').textContent = `About ${n} letters on a line${n < 30 ? ' (short lines: try smaller text or margins)' : n > 78 ? ' (long lines: try bigger text or margins)' : ''}.`; };
  lpl();
  body.oninput = (ev) => {
    const t = ev.target as HTMLInputElement;
    const name = t.dataset.name as keyof Look | undefined;
    if (!name) return;
    if (t.type === 'color') { setLook({ [name]: t.value, theme: 'custom' } as Partial<Look>); return; }
    const v = Number(t.value);
    setLook({ [name]: v } as Partial<Look>);
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
    ${opts('voice', extras.voice, [['auto', 'Auto'], ['azure', 'Microsoft'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], ['mac', 'iPhone']])}
    ${missing ? `<p class="warn">No ${missing} key is saved, so you hear the iPhone voice now. Paste your ${missing} key and press Save.</p>${keyBox(wants as store.KeyName, `${missing} key`)}${wants === 'azure' ? `<div class="key"><input type="text" class="field" data-name="azureRegion" value="${esc(extras.azureRegion ?? 'eastus')}" placeholder="Region, for example eastus" autocapitalize="off" autocorrect="off" spellcheck="false"><button data-a="test-azure">Test</button></div>` : ''}` : ''}
    ${voiceList}
    <button class="big" data-a="test-voice">Hear the voice</button>
    ${range('teacherVolume', 'Volume', extras.teacherVolume ?? 60, { min: 0, max: 100, step: 5 }, `${extras.teacherVolume ?? 60}%`)}
    ${range('rate', 'Speed', Math.round(rateNow() * 20) / 20, { min: 0.6, max: 1.4, step: 0.05 }, `${rateNow().toFixed(2)}×`)}
    <h4>Keys</h4>
    ${keyBox('anthropic', 'Claude')}${keyBox('azure', 'Microsoft voice')}${keyBox('openai', 'OpenAI')}${keyBox('elevenlabs', 'ElevenLabs')}
    <p class="note">Keys stay on this device (in its Keychain). Claude explains; the Microsoft key (free) gives the natural voice.</p>
    ${inApp() ? '<button class="big" data-a="app-settings">My word file, and more settings</button>' : ''}`, true);
  const again = () => { if (sheetKind === 'tutor') { const top = body.scrollTop; tutorSheet(); $('sheet-body').scrollTop = top; } };
  const afterVoice = async () => { const was = reading(); if (was) setPlaying(false); else cancelSpeech(); await prepareVoice(); again(); if (was && !playing && shelf) setPlaying(true); };
  body.oninput = (ev) => {
    const t = ev.target as HTMLInputElement;
    const name = t.dataset.name;
    if (!name || t.type !== 'range') return;
    const v = Number(t.value);
    const out = t.parentElement?.querySelector('output');
    if (name === 'pctWords' || name === 'pctPhrases' || name === 'pctSentences') { if (out) out.textContent = `${v}%`; void patchX({ [name]: clampPct(v) }).then(recompute); }
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
    if (group === 'tutorOn') void patchX({ tutorOn: v === 'on' }).then(async () => { await prepareVoice(); recompute(); again(); });
    else if (group === 'learnerLevel') { settings = { ...settings, learnerLevel: v as Settings['learnerLevel'] }; rankWords = null; void store.updateSettings(() => ({ learnerLevel: v as Settings['learnerLevel'] })).catch(() => undefined); void patchX({ myLevel: cefrToLevel(v), levelAuto: false }).then(() => { recompute(); again(); }); }
    else if (group === 'stopItemsOn' || group === 'stopPhrasesOn' || group === 'stopHardOn') void patchX({ [group]: v === 'on' }).then(() => { applyLook(false); recompute(); again(); });
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
        recompute();
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
  const body = openSheet('book', `<h4>${esc(title)}</h4><button class="big go" data-a="open">Read</button><button class="big" data-a="listen">Listen</button><button class="big" data-a="remove" style="color:#b3261e">Remove from my books</button><p class="note">Removing a book keeps the words you learned from it.</p>`, true);
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
  wireChrome(); wirePage(); wireSelection();
  const o = await chrome.storage.local.get([LOOK_KEY, OPEN_KEY, MODE_KEY]).catch(() => ({} as Record<string, unknown>));
  [extras, settings, keys] = await Promise.all([store.getExtras(), store.getSettings(), store.getKeys()]);
  look = o[LOOK_KEY] ? readLook(o[LOOK_KEY]) : { ...DEFAULT_LOOK, size: innerWidth >= 700 ? 20 : 18 };
  mode = o[MODE_KEY] === 'listen' ? 'listen' : 'read';
  applyLook(false);
  try { window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyLook(false)); } catch { /* an old browser */ }
  let resizeT: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => { if (resizeT) clearTimeout(resizeT); resizeT = setTimeout(() => layout(true), 120); });
  window.addEventListener('pagehide', () => savePlaceNow());
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlaceNow(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch[store.STORAGE_KEYS.extras]) { extras = { ...store.DEFAULT_EXTRAS, ...(ch[store.STORAGE_KEYS.extras].newValue as Partial<store.YtExtras> | undefined) }; if (shelf) { applyLook(false); recompute(); } }
    if (ch[store.STORAGE_KEYS.keys]) void store.getKeys().then(async (k) => { keys = k; await prepareVoice(); if (shelf) recompute(); });
    if (shelf && ch[store.STORAGE_KEYS.vocab]) { vocab = { words: { ...((ch[store.STORAGE_KEYS.vocab].newValue as VocabState | undefined)?.words ?? {}) }, marked: {} }; recompute(); }
    if (shelf && ch[store.STORAGE_KEYS.settings]) void store.getSettings().then((s) => { settings = s; recompute(); paintPlay(); });
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
