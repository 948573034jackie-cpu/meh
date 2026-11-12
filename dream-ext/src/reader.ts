/**
 * The reader (books, PDFs, texts, web articles): a small library, one chapter on the page at a time, the hard words
 * marked by the learner's one level (level100.ts), a tap on a word = its card (pronunciation + Chinese) and, with My
 * tutor on, the explanation aloud; a tap on the card = "I know". The same vocabulary as the videos.
 * Read aloud: the tutor reads sentence by sentence; with Level Check it stops at the hard sentences, explains, shows
 * the sentence again and goes on (the same database and the same 50 % rule as the video).
 * COST: nothing is asked of the AI when a book opens or a chapter is turned. The one analysis of a chapter starts when
 * the learner starts the reading aloud (or the Level Check test) and is saved; a tap asks for one explanation.
 * Free mode (My tutor off): no AI at all, the card shows the dictionary, a sentence is translated on the device.
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
import { explain as aiExplain, complete, completeStream, getDictionary, getZipf } from './ai-client';
import * as store from './store';
import { cloudEngine, resolveVoice, VoiceWithBackup } from './voice';
import { unknownChance, phraseSig, type LevelMeta } from './level-db';
import { buildItemsPrompt, parseItems, collectItems, pickForScreen, type AiItem } from './level-check';
import { scoreSentences, selectStops, mayStop, counterText, itemsToHits, type SentenceScore } from './level-stops';
import { RuleGuard, type RuleRequest } from './level-rule';
import { LevelGate } from './level-gate';
import { Analysis, analysisId, type AnalysisStop } from './level-analysis';
import { buildHardSentencesPrompt, parseHardSentences } from './hard-sentences';
import { rawFromPlain, rawFromTextFile, chapterOf, charsBefore, pdfToText } from './reader-text';
import { parseEpub, type RawBook } from './epub';
import { bookStore, bookStoreKind, shelfOf, percentOf, type ShelfBook, type StoredText } from './book-store';
import { markOf, cardOf } from './word-level';
import { myLevelOf } from './level100';
import { WordCard } from './word-card';
import { saveExplained } from './word-save';
import { nativeTranslate } from './native-bridge';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const segmenter = createSegmenter();

let shelf: ShelfBook | null = null;
let stored: StoredText | null = null;
let book: Book;
/** the chapter on the page */
let chapter = 0;
/** which chapters are cut into sentences already */
const cut = new Set<number>();
/** the sentences of the chapter on the page, in order */
let order: Position[] = [];
let dict: Dictionary;
let names = new Set<string>();
let zipf: (w: string) => number | null = () => null;
let vocab: VocabState = { words: {}, marked: {} };
let level: LevelMeta;
let extras: store.YtExtras;
let settings: Settings;
/** short / mid / long (Settings), read when the page starts */
let teachLen: 'short' | 'normal' | 'long' = 'normal';
const readLength = () => teachLen;
let tts: TtsEngine;
let voiceId = '';
let rate = 1;
let phrases: Record<string, PhraseHit[]> = {};
let hard = new Set<string>();
let scores = new Map<string, SentenceScore>();
let stopSet = new Set<string>();
let index = 0;
let playing = false;
let speaking: SpeakHandle | null = null;
let stops = 0;
const heard = new Set<string>();
const stopped = new Set<string>();
const spokenLog: string[] = [];
let explaining: { cancel(): void } | null = null;
let rejected = 0;
let loop = 0;
let analysis: Analysis | null = null;
/** the chapter's one analysis was started (by Play or by the test), and its AI items */
let aiStarted: Promise<void> | null = null;
let ask: Promise<AiItem[] | null> = Promise.resolve(null);
let card: WordCard | null = null;
/** the word or sentence the card is about */
let cardFor: { lemma: string; word: string; pos: Position } | null = null;
let aiCallsByTap = 0;

/** My tutor is on (off = free mode: no AI, nothing paid) */
const tutor = (): boolean => extras?.tutorOn !== false;
const night = (): boolean => (extras?.readLook ? extras.readLook === 'night' : !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);

function debug(): void {
  if (!extras?.fakeVoice) return;
  const marks = { hard: document.querySelectorAll('#text .w.hard').length, learning: document.querySelectorAll('#text .w.learning').length };
  document.documentElement.dataset.drDebug = JSON.stringify({
    index, playing, stops, heard: heard.size, total: order.length, chosen: stopSet.size, spoken: spokenLog.slice(-40), rejected: rejected + (analysis?.rejected ?? 0), say: $('say').textContent, aiCalls: analysis?.calls ?? 0,
    chapter, chapters: stored?.chapters.length ?? 0, place: shelf?.place ?? null, percent: shelf?.percent ?? 0, marks, store: bookStoreKind, tapCalls: aiCallsByTap,
    card: card?.current ?? null, cardRect: card?.rects().card ?? null, buttonRect: card?.buttonRect() ?? null,
  });
}
const paintCounter = () => { $('counter').textContent = stops || playing ? counterText(stops, heard.size) : ''; debug(); };

// ---- the library ---------------------------------------------------------------------------------------------------
async function paintShelf(): Promise<void> {
  const list = await (await bookStore()).list().catch(() => [] as ShelfBook[]);
  const box = $('shelf');
  box.textContent = '';
  for (const b of list) {
    const row = document.createElement('div');
    row.className = 'book';
    row.dataset.id = b.id;
    const go = document.createElement('button');
    go.className = 'go';
    go.dataset.a = 'open';
    const t = document.createElement('b');
    t.textContent = b.title || 'Untitled';
    const sub = document.createElement('span');
    const n = b.chapterTitles.length;
    sub.textContent = `${b.percent}% read${n > 1 ? ` · chapter ${Math.min(n, b.place.chapter + 1)} of ${n}` : ''}${b.author ? ` · ${b.author}` : ''}`;
    go.append(t, sub);
    const rm = document.createElement('button');
    rm.className = 'rm danger';
    rm.dataset.a = 'remove';
    rm.textContent = 'Remove';
    rm.setAttribute('aria-label', `Remove ${b.title}`);
    row.append(go, rm);
    box.append(row);
  }
  $('shelf-box').hidden = !list.length;
  document.body.dataset.books = String(list.length);
}

function showLibrary(): void {
  setPlaying(false);
  savePlaceNow();
  closeCard();
  $('reader').hidden = true;
  $('say').hidden = true;
  $('open').hidden = false;
  shelf = null; stored = null;
  delete document.body.dataset.sentences;
  void paintShelf();
}

// ---- the page ------------------------------------------------------------------------------------------------------
function applyLook(): void {
  document.body.classList.toggle('day', !night());
  document.body.style.setProperty('--read-size', `${Math.max(14, Math.min(44, extras?.phoneSizePx ?? 21))}px`);
  $('look').textContent = night() ? '☀' : '☾';
  card?.setLook({ sizePx: extras?.phoneSizePx ?? 21, look: night() ? 'night' : 'day' });
}

function recompute(): void {
  const done = new Set<string>();
  for (const [k, st] of Object.entries(vocab.words)) if (k.includes(' ') && (st === 'known' || st === 'ignored')) done.add(phraseSig(dict, k));
  const list = scoreSentences({ book, order, dict, names, status: (l) => vocab.words[l], phraseDone: (s) => done.has(s), phrases, hard, chance: unknownChance(level.tests), zipf });
  scores = new Map(list.map((s) => [s.key, s]));
  stopSet = selectStops(list);
  // the marks: THE RULE of the one level (harder than my level and not known; still learning = marked stronger)
  const ctx = { dict, zipf, words: vocab.words, myLevel: myLevelOf(extras, settings.learnerLevel), names };
  for (const el of document.querySelectorAll<HTMLElement>('#text .w[data-lemma]')) {
    const m = markOf(el.textContent ?? '', ctx);
    el.classList.toggle('learning', m === 'learning');
    el.classList.toggle('hard', m === 'hard');
  }
  paintCounter();
}

/** the chapter as it is: every character of its paragraphs, the words and sentences only marked */
function render(): void {
  const ch = book.chapters[chapter];
  const parts: string[] = [];
  for (const para of ch.paragraphs) {
    let html = '', cursor = 0;
    for (const s of para.sentences) {
      html += esc(para.text.slice(cursor, s.start));
      html += `<span class="s" data-key="${ch.index}.${para.index}.${s.index}">`;
      let at = s.start;
      for (const t of s.tokens) {
        html += esc(para.text.slice(at, t.start));
        html += t.kind === 'word' ? `<span class="w" data-t="${t.start}" data-lemma="${esc(dict.lemmaOf(t.text)).replace(/"/g, '&quot;')}">${esc(t.text)}</span>` : esc(t.text);
        at = t.end;
      }
      html += `${esc(para.text.slice(at, s.end))}</span>`;
      cursor = s.end;
    }
    parts.push(`<p${para.kind !== 'p' ? ` class="${para.kind}"` : ''}>${html}${esc(para.text.slice(cursor))}</p>`);
  }
  $('text').innerHTML = parts.join('');
}

function paintChapters(): void {
  const n = stored?.chapters.length ?? 0;
  $('chapnav').hidden = n < 2;
  if (n < 2) return;
  const sel = $<HTMLSelectElement>('chapters');
  if (sel.options.length !== n) {
    sel.textContent = '';
    stored!.chapters.forEach((c, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${i + 1}. ${c.title || `Chapter ${i + 1}`}`.slice(0, 70); sel.append(o); });
  }
  sel.value = String(chapter);
  $<HTMLButtonElement>('chap-prev').disabled = chapter <= 0;
  $<HTMLButtonElement>('chap-next').disabled = chapter >= n - 1;
}

/** a chapter comes onto the page (cut into sentences now, once); `place` = where to stand in it */
function showChapter(c: number, place: { paragraph: number; sentence: number } | null): void {
  if (!stored) return;
  setPlaying(false);
  closeCard();
  chapter = Math.max(0, Math.min(stored.chapters.length - 1, c));
  if (!cut.has(chapter)) {
    book.chapters[chapter] = chapterOf(stored.chapters[chapter], chapter, segmenter);
    cut.add(chapter);
    for (const n of detectNames({ chapters: [book.chapters[chapter]] }, dict)) names.add(n);
  }
  order = [];
  for (const p of book.chapters[chapter].paragraphs) for (const s of p.sentences) order.push({ chapter, paragraph: p.index, sentence: s.index });
  // (a new chapter: its own stops, its own analysis, nothing asked yet)
  phrases = {}; hard = new Set(); analysis = null; aiStarted = null; ask = Promise.resolve(null);
  stops = 0; heard.clear(); stopped.clear();
  const at = place ? order.findIndex((p) => p.paragraph === place.paragraph && p.sentence === place.sentence) : -1;
  index = Math.max(0, at);
  render();
  recompute();
  paintChapters();
  document.body.dataset.sentences = String(order.length);
  document.body.dataset.chapter = String(chapter);
  const el = at > 0 ? sentenceEl(order[at]) : null;
  if (el) el.scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
  // (the sticky bar covers the top of the page)
  if (el) window.scrollBy(0, -($('bar').offsetHeight + 12));
  savePlaceSoon();
}

const sentenceEl = (pos: Position) => document.querySelector<HTMLElement>(`.s[data-key="${sentenceKey(pos)}"]`);
function markCurrent(pos: Position | null): void {
  document.querySelector('.s.cur')?.classList.remove('cur');
  const el = pos && sentenceEl(pos);
  if (el) { el.classList.add('cur'); el.scrollIntoView({ block: 'center', behavior: extras.fakeVoice ? 'auto' : 'smooth' }); }
}

// ---- the place (chapter + sentence), remembered ------------------------------------------------------------------
/** the first sentence in view under the bar */
function firstVisible(): number {
  const top = $('bar').getBoundingClientRect().bottom + 2;
  const els = document.querySelectorAll<HTMLElement>('#text .s');
  for (let i = 0; i < els.length; i++) if (els[i].getBoundingClientRect().bottom > top) return i;
  return Math.max(0, els.length - 1);
}
let placeTimer: ReturnType<typeof setTimeout> | null = null;
function savePlaceSoon(): void {
  if (placeTimer) return;
  placeTimer = setTimeout(() => { placeTimer = null; savePlaceNow(); }, 700);
}
function savePlaceNow(): void {
  if (placeTimer) { clearTimeout(placeTimer); placeTimer = null; }
  if (!shelf || !stored || $('reader').hidden || !order.length) return;
  const pos = playing ? order[index] : order[Math.min(order.length - 1, firstVisible())];
  if (!pos) return;
  const ch = book.chapters[chapter];
  // (the end of the last chapter in view = the whole book read)
  const atEnd = chapter === stored.chapters.length - 1 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4 && pos !== order[0];
  const percent = atEnd ? 100 : percentOf(shelf.chapterChars, chapter, charsBefore(ch, pos.paragraph) + (ch.paragraphs[pos.paragraph]?.sentences[pos.sentence]?.start ?? 0));
  const same = shelf.place.chapter === chapter && shelf.place.paragraph === pos.paragraph && shelf.place.sentence === pos.sentence && shelf.percent === percent;
  if (same) return;
  shelf = { ...shelf, place: { chapter, paragraph: pos.paragraph, sentence: pos.sentence }, percent, openedAt: new Date().toISOString() };
  const s = shelf;
  void bookStore().then((st) => st.update(s)).catch(() => undefined);
  debug();
}

// ---- the voice -----------------------------------------------------------------------------------------------------
function say(text: string): Promise<boolean> {
  spokenLog.push(text);
  debug();
  const h = tts.speak(text, { voiceId, rate });
  speaking = h;
  return h.done.then((o) => { if (speaking === h) speaking = null; return o === 'ended'; });
}

/** an explanation: shown while it comes in (on the card, else on the panel), read sentence by sentence; only what passed the rule */
async function explainThis(req: RuleRequest, onShow?: (t: string) => void): Promise<string> {
  const guard = new RuleGuard({ sentence: req.sentence, items: req.kind === 'sentence' ? req.levelRule!.items : [req.target] });
  const splitter = new StreamSentenceSplitter();
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false, failed = '';
  const panel = $('say');
  if (!onShow) { panel.hidden = false; panel.textContent = '…'; }
  const show = (t: string) => { if (!t.trim()) return; if (onShow) onShow(t.trim()); else panel.textContent = t; };
  const job = aiExplain(req, (full) => { const t = guard.push(full); show(t); queue.push(...splitter.push(t)); wake?.(); });
  explaining = job;
  let final = '';
  void job.done.then((r) => { final = guard.finish(r.text); rejected += guard.rejected; show(final); queue.push(...splitter.flush(final)); }, (e: Error) => { failed = e.message; }).finally(() => { finished = true; wake?.(); });
  const mine = loop;
  for (;;) {
    if (mine !== loop) { job.cancel(); explaining = null; return ''; }
    const next = queue.shift();
    if (next !== undefined) { if (!(await say(next))) { job.cancel(); explaining = null; return ''; } continue; }
    if (finished) break;
    await new Promise<void>((r) => { wake = r; });
    wake = null;
  }
  explaining = null;
  if (failed) { show(failed); if (!onShow) await new Promise((r) => setTimeout(r, 2500)); return ''; }
  debug();
  return final;
}

/** an explanation from the one analysis: shown and read, sentence by sentence */
async function readSaved(text: string): Promise<void> {
  const panel = $('say');
  panel.hidden = false;
  panel.textContent = text;
  const mine = loop;
  for (const s of new StreamSentenceSplitter().flush(text)) if (mine !== loop || !(await say(s))) return;
}

function requestFor(kind: 'word' | 'sentence', target: string, pos: Position): RuleRequest {
  const ctx = contextAround(book, pos, 80, 40);
  const known = new Set<string>();
  for (const t of getSentence(book, pos)?.sentence.tokens ?? []) if (t.kind === 'word' && vocab.words[dict.lemmaOf(t.text)] === 'known') known.add(t.text.toLowerCase());
  return {
    kind, target, sentence: getSentence(book, pos)?.text ?? target, before: ctx.before, after: ctx.after,
    book: { title: book.title, chapter: book.chapters[chapter]?.title ?? '' }, history: [], position: pos,
    levelRule: { items: scores.get(sentenceKey(pos))?.items ?? [], known: [...known], level: level.currentLevel || 'B2', length: readLength() },
  };
}

/** the stop after a sentence: the explanation, then the sentence again on the page */
async function stopAt(pos: Position): Promise<void> {
  const key = sentenceKey(pos);
  stopped.add(key);
  stops++;
  paintCounter();
  const sc = scores.get(key);
  const text = getSentence(book, pos)?.text ?? '';
  sc?.lemmas.forEach((lemma, i) => { if (!vocab.words[lemma]) { vocab.words[lemma] = 'learning'; void store.setWordStatus(lemma, 'learning', { word: sc.items[i], sentence: text }); } });
  // written once, ahead of the stop: no AI call here
  const saved = analysis ? await analysis.wait(analysisId(text)) : null;
  if (saved) await readSaved(saved);
  else await explainThis(requestFor('sentence', text, pos));
  const el = sentenceEl(pos);
  el?.classList.add('again');
  el?.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, extras.fakeVoice ? 200 : Math.min(6000, 1500 + text.length * 25)));
  el?.classList.remove('again');
  $('say').hidden = true;
}

async function readOn(): Promise<void> {
  const mine = ++loop;
  while (playing && mine === loop && index < order.length) {
    const pos = order[index];
    heard.add(sentenceKey(pos));
    markCurrent(pos);
    paintCounter();
    savePlaceSoon();
    analysis?.plan(index);
    const ended = await say(getSentence(book, pos)?.text ?? '');
    if (mine !== loop || !playing || !ended) return;
    const key = sentenceKey(pos);
    // (free mode: it only reads; nothing is explained)
    if (tutor() && stopSet.has(key) && !stopped.has(key) && mayStop(stops, heard.size)) {
      await stopAt(pos);
      if (mine !== loop || !playing) return;
    }
    index++;
  }
  if (mine === loop && index >= order.length) {
    setPlaying(false); markCurrent(null);
    index = 0;
  }
}

function cancelAll(): void { loop++; speaking?.cancel(); explaining?.cancel(); tts?.cancelAll(); }
function setPlaying(on: boolean): void {
  if (on === playing && !on) return;
  if (on && !playing && order.length) {
    // (reading starts where the learner is on the page, when the sentence being read is not in view)
    const cur = sentenceEl(order[index]);
    const r = cur?.getBoundingClientRect();
    if (!r || r.bottom < 0 || r.top > window.innerHeight) index = Math.min(order.length - 1, firstVisible());
    closeCard();
  }
  playing = on;
  $('play').textContent = on ? '⏸ Stop' : '▶ Play';
  if (on) { const mine = loop; void startAi().then(() => { if (playing && mine === loop) void readOn(); }); }
  else { cancelAll(); $('say').hidden = true; }
  debug();
}

// ---- a tap on a word: its card; My tutor on = the explanation aloud; a tap on the card = I know -------------------
function ensureCard(): WordCard {
  card ??= new WordCard(document, { onKnow: () => void cardKnown(), onButton: () => void cardSentence(), onClose: () => closeCard() }, { sizePx: extras.phoneSizePx ?? 21, look: night() ? 'night' : 'day' });
  return card;
}
function closeCard(): void {
  if (!card?.open) return;
  cancelAll();
  card.hide();
  cardFor = null;
  debug();
}
const posOf = (el: HTMLElement): Position => { const [c, p, s] = el.closest<HTMLElement>('.s')!.dataset.key!.split('.').map(Number); return { chapter: c, paragraph: p, sentence: s }; };

async function tapped(el: HTMLElement): Promise<void> {
  const pos = posOf(el);
  const lemma = el.dataset.lemma!;
  const word = el.textContent ?? lemma;
  const text = getSentence(book, pos)?.text ?? '';
  const was = playing;
  playing = false; cancelAll();
  $('play').textContent = '▶ Play';
  $('say').hidden = true;
  const info = cardOf(word, dict);
  const on = tutor();
  cardFor = { lemma, word, pos };
  ensureCard().show({ kind: 'word', word, ipa: info.ipa, zh: info.zh, hint: 'Tap here = I know this word', button: on ? 'Explain the sentence' : 'Translate the sentence', busy: on });
  if (vocab.words[lemma] !== 'known') { vocab.words[lemma] = 'learning'; void store.setWordStatus(lemma, 'learning', { word, sentence: text }); }
  recompute();
  if (!on) { debug(); return; }   // free mode: the card only, nothing asked of the AI
  aiCallsByTap++;
  const mine = cardFor;
  const explanation = await explainThis(requestFor('word', word, pos), (t) => { if (cardFor === mine) card?.update({ text: t }); debug(); });
  if (cardFor === mine) card?.update({ busy: false });
  if (explanation) {
    const r = await saveExplained({ lemma, word, sentence: text, explanation, chinese: info.zh, bookId: book.id, bookTitle: book.title, chapter: book.chapters[chapter]?.title ?? '', position: pos }, extras.knownAfter ?? 7).catch(() => null);
    if (r?.nowKnown) { vocab.words[lemma] = 'known'; recompute(); if (cardFor === mine) card?.update({ hint: `“${word}” was explained ${r.times} times: it counts as known now.` }); }
  }
  debug();
  // the reading goes on from the sentence where it was
  if (was && explanation && cardFor === mine) { card?.hide(); cardFor = null; setPlaying(true); }
}

/** a tap on the card: I know this word */
async function cardKnown(): Promise<void> {
  const c = cardFor;
  closeCard();
  if (!c) return;
  vocab.words[c.lemma] = 'known';
  recompute();
  await store.setWordStatus(c.lemma, 'known', { word: c.word });
}

/** the card's button: the whole sentence, explained (My tutor) or translated on the device (free mode) */
async function cardSentence(): Promise<void> {
  const c = cardFor;
  if (!c) return;
  await explainSentence(c.pos, getSentence(book, c.pos)?.text ?? '');
}

async function explainSentence(pos: Position, target: string): Promise<void> {
  if (!target.trim()) return;
  playing = false; cancelAll();
  $('play').textContent = '▶ Play';
  const on = tutor();
  const mine = { lemma: '', word: '', pos };
  cardFor = mine;
  ensureCard().show({ kind: 'sentence', word: on ? 'This sentence' : 'In Chinese', text: on ? '' : '…', busy: on, hint: target.length > 160 ? `${target.slice(0, 158)}…` : target });
  debug();
  if (!on) {
    const zh = await nativeTranslate(target);
    if (cardFor === mine) card?.update({ zh: zh ?? '', text: zh ? '' : 'The translation is not here (it needs iOS 18 and the Chinese language downloaded). Turn My tutor on for an explanation.' });
    debug();
    return;
  }
  aiCallsByTap++;
  const req = requestFor('sentence', target, pos);
  await explainThis(req, (t) => { if (cardFor === mine) card?.update({ text: t }); debug(); });
  if (cardFor === mine) card?.update({ busy: false });
  debug();
}

function wireText(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const text = $('text');
  text.addEventListener('click', (ev) => {
    const w = (ev.target as HTMLElement).closest<HTMLElement>('.w[data-lemma]');
    if (!w) { if (card?.open && !window.getSelection()?.toString().trim()) closeCard(); return; }
    if (timer) { clearTimeout(timer); timer = null; return; }
    timer = setTimeout(() => { timer = null; void tapped(w); }, 260);
  });
  text.addEventListener('dblclick', (ev) => {
    const w = (ev.target as HTMLElement).closest<HTMLElement>('.w[data-lemma]');
    if (!w) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const lemma = w.dataset.lemma!;
    vocab.words[lemma] = 'known';
    void store.setWordStatus(lemma, 'known', { word: w.textContent ?? lemma });
    recompute();
  });
  // a finished selection of more than one word = that text is explained (or translated)
  let selTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSel = '';
  document.addEventListener('selectionchange', () => {
    if (selTimer) clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      selTimer = null;
      const sel = window.getSelection();
      const t = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (!sel || sel.isCollapsed || !t || t === lastSel || t.split(' ').length < 2 || t.length > 700) { if (!t) lastSel = ''; return; }
      const from = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>('#text .s');
      if (!from) return;
      lastSel = t;
      void explainSentence(posOf(from), t);
    }, 900);
  });
}

async function prepareVoice(): Promise<void> {
  if (extras.fakeVoice) useFakeEngine(2);
  const mac = getEngine('webspeech');
  const macVoice = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
  rate = settings.voice.rate;
  { const l = settings.ai.explanationLength as string; teachLen = l === 'short' || l === 'long' ? l : 'normal'; }
  // (free mode: the device's own voice only, never a paid one)
  const kind = tutor() ? resolveVoice(extras.voice, await store.getKeys()) : 'mac';
  if (kind === 'mac') { tts = mac; voiceId = macVoice; return; }
  tts = new VoiceWithBackup(cloudEngine(kind, 'en'), mac, () => macVoice, () => undefined);
  voiceId = kind === 'openai' ? extras.openaiVoice : kind === 'azure' ? extras.azureVoice : extras.elevenVoice;
}

// ---- the one analysis of a chapter (for the reading aloud): started by Play or by the test, saved -------------------
/** the name the chapter's analysis is saved under (a text of one chapter keeps the name it always had) */
const aiId = (): string => ((stored?.chapters.length ?? 1) > 1 ? `${book.id}#${chapter}` : book.id);
const linesNow = (): string[] => order.map((p) => getSentence(book, p)?.text ?? '');

function startAi(): Promise<void> {
  if (aiStarted) return aiStarted;
  if (!tutor()) return Promise.resolve();
  const id = aiId(), forChapter = chapter, title = book.title;
  aiStarted = (async () => {
    const keys = await store.getKeys();
    if (!keys.anthropic && !keys.openai) return;
    const lines = linesNow();
    const cached = await store.getLevelItems(id).catch(() => null);
    // the AI's idioms and slang: for the test, and for the stops
    ask = cached ? Promise.resolve(cached)
      : complete(buildItemsPrompt(lines, title)).then((raw) => { const it = parseItems(raw, lines); void store.setLevelItems(id, it).catch(() => undefined); return it; }).catch(() => null);
    // the explanations are written once, ahead of the stops, and saved with this text
    analysis = new Analysis({
      // (the learner's own rules, in their length: saved apart from older explanations)
      load: () => store.getAnalysis(`${id}|v2|${readLength()}`),
      save: (texts) => store.setAnalysis(`${id}|v2|${readLength()}`, texts),
      length: () => readLength(),
      stops: readerStops,
      lineAt: (i) => getSentence(book, order[i])?.text ?? '',
      total: () => order.length,
      title: () => book.title,
      level: () => level.currentLevel || 'B2',
      stream: (prompt, onDelta) => completeStream(prompt, onDelta, true),
    });
    void aiJobs(ask, id, forChapter);
  })();
  return aiStarted;
}

async function aiJobs(asked: Promise<AiItem[] | null>, id: string, forChapter: number): Promise<void> {
  const items = await asked;
  if (forChapter !== chapter || !stored) return;
  if (items) { phrases = itemsToHits(book, order, items, dict); recompute(); }
  const lines = linesNow();
  // (the hard sentences are asked once per chapter and kept)
  const kept = await store.getAnalysis(`${id}|hard`).catch(() => ({} as Record<string, string>));
  let list: number[] = [];
  if (typeof kept.list === 'string' && kept.n === String(lines.length)) { try { list = JSON.parse(kept.list) as number[]; } catch { list = []; } }
  else {
    for (let from = 0; from < lines.length; from += 60) {
      const slice = lines.slice(from, from + 60);
      const max = Math.max(1, Math.round(slice.length / 3));
      try { list.push(...parseHardSentences(await complete(buildHardSentencesPrompt(slice, { level: level.currentLevel || 'B2', title: book.title, max })), slice.length, max).map((i) => from + i)); } catch { /* no sentence stops from this part */ }
      if (forChapter !== chapter || !stored) return;
    }
    void store.setAnalysis(`${id}|hard`, { list: JSON.stringify(list), n: String(lines.length) }).catch(() => undefined);
  }
  if (forChapter !== chapter || !stored) return;
  hard = new Set(list.filter((i) => order[i]).map((i) => sentenceKey(order[i])));
  recompute();
  analysis?.plan(index);
}

function readerStops(): AnalysisStop[] {
  const out: AnalysisStop[] = [];
  order.forEach((pos, i) => {
    const key = sentenceKey(pos);
    if (!stopSet.has(key)) return;
    const text = getSentence(book, pos)?.text ?? '';
    out.push({ id: analysisId(text), index: i, text, items: scores.get(key)?.items ?? [] });
  });
  return out;
}

// ---- opening -------------------------------------------------------------------------------------------------------
const hex = async (data: BufferSource): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');

/** a new text goes into the library (the same text again: the book that is there, at its place) and opens */
async function addBook(id: string, kind: ShelfBook['kind'], raw: RawBook): Promise<void> {
  const chapters = raw.chapters.filter((c) => c.blocks.some((b) => b.text.trim()));
  if (!chapters.length) throw new Error('No readable text was found in it.');
  const st = await bookStore();
  const had = await st.get(id).catch(() => null);
  if (!had) await st.add(shelfOf(id, kind, { ...raw, chapters }), { id, chapters });
  await openBook(id, !had);
}

/** `fresh`: just put in (it starts at the beginning, and Level Check comes first when it is on) */
async function openBook(id: string, fresh: boolean): Promise<void> {
  const got = await (await bookStore()).get(id);
  if (!got) throw new Error('This book is not in the library any more.');
  shelf = got.shelf; stored = got.text;
  dict = await getDictionary();
  zipf = await getZipf();
  [vocab, level, extras, settings] = await Promise.all([store.getVocab(), store.getLevel(), store.getExtras(), store.getSettings()]);
  const title = shelf.title;
  book = {
    id, title, ...(shelf.author ? { author: shelf.author } : {}), source: { kind: shelf.kind === 'web' ? 'text' : shelf.kind, importedAt: shelf.addedAt },
    chapters: stored.chapters.map((c, i) => ({ index: i, title: c.title, paragraphs: [] })), names: [], stats: { words: 0, paragraphs: 0, sentences: 0 },
  };
  cut.clear();
  names = new Set();
  await prepareVoice();
  $('open').hidden = true;
  $('shelf-box').hidden = true;
  $('reader').hidden = false;
  $('title').textContent = title;
  applyLook();
  const place = fresh ? null : shelf.place;
  showChapter(place?.chapter ?? 0, place);
  shelf = { ...shelf, openedAt: new Date().toISOString() };
  { const s = shelf; void bookStore().then((st) => st.update(s)).catch(() => undefined); }
  if (!fresh || extras.levelAsk === false) return;
  const gate = new LevelGate({
    build: async () => {
      // (the test is the learner's choice: the chapter's one analysis starts here, not when the book opens)
      await startAi();
      const ai = await Promise.race([ask, new Promise<null>((r) => setTimeout(() => r(null), 15000))]);
      const sigs = new Set<string>();
      for (const k of Object.keys(vocab.words)) if (k.includes(' ')) sigs.add(phraseSig(dict, k));
      return pickForScreen(collectItems({ book: { ...book, chapters: [book.chapters[chapter]] }, dict, names, inDatabase: (k, s) => !!vocab.words[k] || sigs.has(s), ai: ai ?? [], zipf }), { width: window.innerWidth, height: window.innerHeight });
    },
    save: async (shown, known, scoresNow) => (await store.saveTestResult(shown, known, title, scoresNow)).label,
    done: () => setPlaying(true),
  }, title);
  gate.show();
}

async function openFile(f: File): Promise<void> {
  const msg = $('open-msg');
  msg.textContent = 'Opening…';
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
    msg.textContent = '';
  } catch (e) { msg.textContent = (e as Error).message || 'This file could not be opened.'; }
  $<HTMLInputElement>('file').value = '';
}

async function openPasted(title: string, text: string, kind: 'text' | 'web' = 'text'): Promise<void> {
  await addBook(`text-${await hex(new TextEncoder().encode(text))}`, kind, rawFromPlain(title, text));
}

/** the browser's "Reader" button: the article's text comes as a book (title = the page's title) */
(window as unknown as { __iknowReader?: unknown }).__iknowReader = {
  openText: (title: string, text: string) => openPasted(title.trim() || text.trim().split(/\s+/).slice(0, 6).join(' '), text, 'web').then(() => true, (e: Error) => { $('open-msg').textContent = e.message; return false; }),
  library: () => showLibrary(),
  /** the app's reader goes away (Done): nothing is read aloud behind the video; the place is kept */
  quiet: () => { if (shelf) { setPlaying(false); cancelAll(); savePlaceNow(); } },
};

$('file').addEventListener('change', () => { const f = $<HTMLInputElement>('file').files?.[0]; if (f) void openFile(f); });
$('paste-go').addEventListener('click', () => {
  const t = $<HTMLTextAreaElement>('paste').value;
  if (t.trim()) void openPasted($<HTMLInputElement>('paste-title').value.trim() || t.trim().split(/\s+/).slice(0, 6).join(' '), t).then(() => { $<HTMLTextAreaElement>('paste').value = ''; $<HTMLInputElement>('paste-title').value = ''; }, (e: Error) => { $('open-msg').textContent = e.message; });
});
$('shelf').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-a]');
  const id = b?.closest<HTMLElement>('.book')?.dataset.id;
  if (!b || !id) return;
  if (b.dataset.a === 'open') void openBook(id, false).catch((e: Error) => { $('open-msg').textContent = e.message; });
  // (asked once more: a book taken out is gone, its words stay in My Vocabulary)
  else if (b.dataset.a === 'remove') {
    if (b.dataset.sure) void bookStore().then((st) => st.remove(id)).then(paintShelf);
    else { b.dataset.sure = '1'; b.textContent = 'Really?'; setTimeout(() => { if (b.isConnected) { delete b.dataset.sure; b.textContent = 'Remove'; } }, 4000); }
  }
});
$('play').addEventListener('click', () => setPlaying(!playing));
$('back').addEventListener('click', () => showLibrary());
$('look').addEventListener('click', () => { const next = night() ? 'day' : 'night'; extras.readLook = next; void store.patchExtras({ readLook: next }); applyLook(); });
$('chap-prev').addEventListener('click', () => showChapter(chapter - 1, null));
$('chap-next').addEventListener('click', () => showChapter(chapter + 1, null));
$('chapters').addEventListener('change', () => showChapter(Number($<HTMLSelectElement>('chapters').value) || 0, null));
window.addEventListener('scroll', () => { if (!playing) savePlaceSoon(); }, { passive: true });
window.addEventListener('pagehide', () => savePlaceNow());
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlaceNow(); });
wireText();
void paintShelf();
void store.getExtras().then((x) => { extras = x; applyLook(); });
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch[store.STORAGE_KEYS.extras]) {
    const before = extras;
    extras = { ...store.DEFAULT_EXTRAS, ...(ch[store.STORAGE_KEYS.extras].newValue as Partial<store.YtExtras> | undefined) };
    applyLook();
    if (shelf && before && (before.myLevel !== extras.myLevel)) recompute();
  }
  if (!shelf) return;
  if (ch[store.STORAGE_KEYS.vocab]) { vocab = { words: { ...(ch[store.STORAGE_KEYS.vocab].newValue?.words ?? {}) as Record<string, WordStatus> }, marked: {} }; recompute(); }
  if (ch[store.LEVEL_KEY]) { void store.getLevel().then((m) => { level = m; recompute(); }); }
});
