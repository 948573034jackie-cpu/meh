/**
 * The reading mode (books, PDFs, texts): Level Check before it starts, then the tutor reads aloud, sentence by sentence.
 * The same database and the same 50 % rule as the video: at a stop it reads to the end of the sentence, shows and reads
 * the explanation, then shows the sentence again and goes on. A tap on a word = don't know (explained), a double tap = known.
 */
import type { Book, Position } from '@core/model';
import { sentenceKey } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import type { PhraseHit } from '@shared/api';
import type { TtsEngine, SpeakHandle } from '@core/tts/engine';
import type { VocabState, WordStatus } from '@shared/settings';
import { getEngine, useFakeEngine, defaultVoiceFor } from '@core/tts/registry';
import { getSentence, contextAround } from '@core/nav';
import { detectNames } from '@core/dict/names';
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
import { textBook, orderOf, pdfToText } from './reader-text';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let book: Book;
let order: Position[] = [];
let dict: Dictionary;
let names = new Set<string>();
let zipf: (w: string) => number | null = () => null;
let vocab: VocabState = { words: {}, marked: {} };
let level: LevelMeta;
let extras: store.YtExtras;
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

function debug(): void {
  if (!extras?.fakeVoice) return;
  document.documentElement.dataset.drDebug = JSON.stringify({ index, playing, stops, heard: heard.size, total: order.length, chosen: stopSet.size, spoken: spokenLog.slice(-40), rejected: rejected + (analysis?.rejected ?? 0), say: $('say').textContent, aiCalls: analysis?.calls ?? 0 });
}
const paintCounter = () => { $('counter').textContent = counterText(stops, heard.size); debug(); };

function recompute(): void {
  const done = new Set<string>();
  for (const [k, st] of Object.entries(vocab.words)) if (k.includes(' ') && (st === 'known' || st === 'ignored')) done.add(phraseSig(dict, k));
  const list = scoreSentences({ book, order, dict, names, status: (l) => vocab.words[l], phraseDone: (s) => done.has(s), phrases, hard, chance: unknownChance(level.tests), zipf });
  scores = new Map(list.map((s) => [s.key, s]));
  stopSet = selectStops(list);
  for (const el of document.querySelectorAll<HTMLElement>('.w[data-lemma]')) {
    const st = vocab.words[el.dataset.lemma!];
    el.classList.toggle('learning', st === 'learning');
    el.classList.toggle('hard', !st && !!scores.get(el.closest<HTMLElement>('.s')!.dataset.key!)?.lemmas.includes(el.dataset.lemma!));
  }
  paintCounter();
}

/** the text as it is: every character of the paragraph, the words and sentences only marked */
function render(): void {
  const parts: string[] = [];
  for (const ch of book.chapters) for (const para of ch.paragraphs) {
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
    parts.push(`<p>${html}${esc(para.text.slice(cursor))}</p>`);
  }
  $('text').innerHTML = parts.join('');
}

const sentenceEl = (pos: Position) => document.querySelector<HTMLElement>(`.s[data-key="${sentenceKey(pos)}"]`);
function markCurrent(pos: Position | null): void {
  document.querySelector('.s.cur')?.classList.remove('cur');
  const el = pos && sentenceEl(pos);
  if (el) { el.classList.add('cur'); el.scrollIntoView({ block: 'center', behavior: extras.fakeVoice ? 'auto' : 'smooth' }); }
}

function say(text: string): Promise<boolean> {
  spokenLog.push(text);
  debug();
  const h = tts.speak(text, { voiceId, rate });
  speaking = h;
  return h.done.then((o) => { if (speaking === h) speaking = null; return o === 'ended'; });
}

/** an explanation: shown while it comes in, read sentence by sentence; only what passed the rule */
async function explainThis(req: RuleRequest): Promise<string> {
  const guard = new RuleGuard({ sentence: req.sentence, items: req.kind === 'sentence' ? req.levelRule!.items : [req.target] });
  const splitter = new StreamSentenceSplitter();
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let finished = false, failed = '';
  const panel = $('say');
  panel.hidden = false;
  panel.textContent = '…';
  const show = (t: string) => { if (t.trim()) panel.textContent = t; };
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
  if (failed) { panel.textContent = failed; await new Promise((r) => setTimeout(r, 2500)); }
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
    book: { title: book.title, chapter: '' }, history: [], position: pos,
    levelRule: { items: scores.get(sentenceKey(pos))?.items ?? [], known: [...known], level: level.currentLevel || 'B2' },
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
    analysis?.plan(index);
    const ended = await say(getSentence(book, pos)?.text ?? '');
    if (mine !== loop || !playing || !ended) return;
    const key = sentenceKey(pos);
    if (stopSet.has(key) && !stopped.has(key) && mayStop(stops, heard.size)) {
      await stopAt(pos);
      if (mine !== loop || !playing) return;
    }
    index++;
  }
  if (mine === loop && index >= order.length) { setPlaying(false); markCurrent(null); }
}

function cancelAll(): void { loop++; speaking?.cancel(); explaining?.cancel(); tts.cancelAll(); }
function setPlaying(on: boolean): void {
  playing = on;
  $('play').textContent = on ? '⏸ Pause' : '▶ Play';
  if (on) void readOn(); else cancelAll();
  debug();
}

async function tapped(el: HTMLElement): Promise<void> {
  const key = el.closest<HTMLElement>('.s')!.dataset.key!;
  const [c, p, s] = key.split('.').map(Number);
  const pos: Position = { chapter: c, paragraph: p, sentence: s };
  const lemma = el.dataset.lemma!;
  const text = getSentence(book, pos)?.text ?? '';
  const was = playing;
  playing = false; cancelAll();
  if (vocab.words[lemma] !== 'known') { vocab.words[lemma] = 'learning'; void store.setWordStatus(lemma, 'learning', { word: el.textContent ?? lemma, sentence: text }); }
  recompute();
  const explanation = await explainThis(requestFor('word', el.textContent ?? lemma, pos));
  if (explanation) void store.upsertEntry({ lemma, word: el.textContent ?? lemma, sentence: text, explanation, bookId: book.id, bookTitle: book.title, chapter: '', position: pos });
  $('say').hidden = true;
  // the reading goes on from the sentence where it was
  if (was) setPlaying(true);
}

function wireText(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const text = $('text');
  text.addEventListener('click', (ev) => {
    const w = (ev.target as HTMLElement).closest<HTMLElement>('.w[data-lemma]');
    if (!w) return;
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
}

async function prepareVoice(): Promise<void> {
  if (extras.fakeVoice) useFakeEngine(2);
  const mac = getEngine('webspeech');
  const macVoice = (await store.getSettings()).voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
  const keys = await store.getKeys();
  const kind = resolveVoice(extras.voice, keys);
  rate = (await store.getSettings()).voice.rate;
  if (kind === 'mac') { tts = mac; voiceId = macVoice; return; }
  tts = new VoiceWithBackup(cloudEngine(kind, 'en'), mac, () => macVoice, () => undefined);
  voiceId = kind === 'openai' ? extras.openaiVoice : kind === 'azure' ? extras.azureVoice : extras.elevenVoice;
}

async function aiJobs(ask: Promise<AiItem[] | null>): Promise<void> {
  const keys = await store.getKeys();
  if (!keys.anthropic && !keys.openai) return;
  const items = await ask;
  if (items) { phrases = itemsToHits(book, order, items, dict); recompute(); }
  const list: number[] = [];
  const lines = order.map((p) => getSentence(book, p)?.text ?? '');
  for (let from = 0; from < lines.length; from += 60) {
    const slice = lines.slice(from, from + 60);
    const max = Math.max(1, Math.round(slice.length / 3));
    try { list.push(...parseHardSentences(await complete(buildHardSentencesPrompt(slice, { level: level.currentLevel || 'B2', title: book.title, max })), slice.length, max).map((i) => from + i)); } catch { /* no sentence stops from this part */ }
  }
  hard = new Set(list.map((i) => sentenceKey(order[i])));
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

async function open(title: string, text: string, kind: 'pdf' | 'text'): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const id = `text-${[...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  dict = await getDictionary();
  book = textBook(id, title, text, kind);
  book.names = detectNames(book, dict);
  names = new Set(book.names);
  order = orderOf(book);
  zipf = await getZipf();
  [vocab, level, extras] = await Promise.all([store.getVocab(), store.getLevel(), store.getExtras()]);
  await prepareVoice();
  $('open').hidden = true;
  $('reader').hidden = false;
  $('title').textContent = title;
  render();
  recompute();
  document.body.dataset.sentences = String(order.length);
  index = 0;
  // the AI's idioms and slang: for the test, and for the stops
  const keys = await store.getKeys();
  const lines = order.map((p) => getSentence(book, p)?.text ?? '');
  const cached = await store.getLevelItems(id).catch(() => null);
  const ask: Promise<AiItem[] | null> = cached ? Promise.resolve(cached) : keys.anthropic || keys.openai
    ? complete(buildItemsPrompt(lines, title)).then((raw) => { const it = parseItems(raw, lines); void store.setLevelItems(id, it).catch(() => undefined); return it; }).catch(() => null)
    : Promise.resolve(null);
  // the explanations are written once, ahead of the stops, and saved with this text
  analysis = keys.anthropic || keys.openai ? new Analysis({
    load: () => store.getAnalysis(id),
    save: (texts) => store.setAnalysis(id, texts),
    stops: readerStops,
    lineAt: (i) => getSentence(book, order[i])?.text ?? '',
    total: () => order.length,
    title: () => book.title,
    level: () => level.currentLevel || 'B2',
    stream: (prompt, onDelta) => completeStream(prompt, onDelta, true),
  }) : null;
  void aiJobs(ask);
  if (extras.levelAsk === false) { setPlaying(true); return; }
  const gate = new LevelGate({
    build: async () => {
      const ai = await Promise.race([ask, new Promise<null>((r) => setTimeout(() => r(null), 15000))]);
      const sigs = new Set<string>();
      for (const k of Object.keys(vocab.words)) if (k.includes(' ')) sigs.add(phraseSig(dict, k));
      return pickForScreen(collectItems({ book, dict, names, inDatabase: (k, s) => !!vocab.words[k] || sigs.has(s), ai: ai ?? [], zipf }), { width: window.innerWidth, height: window.innerHeight });
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
    const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    await open(title, isPdf ? await pdfToText(await f.arrayBuffer()) : await f.text(), isPdf ? 'pdf' : 'text');
    msg.textContent = '';
  } catch (e) { msg.textContent = (e as Error).message; }
}

$('file').addEventListener('change', () => { const f = $<HTMLInputElement>('file').files?.[0]; if (f) void openFile(f); });
$('paste-go').addEventListener('click', () => {
  const t = $<HTMLTextAreaElement>('paste').value;
  if (t.trim()) void open($<HTMLInputElement>('paste-title').value.trim() || t.trim().split(/\s+/).slice(0, 6).join(' '), t, 'text').catch((e: Error) => { $('open-msg').textContent = e.message; });
});
$('play').addEventListener('click', () => setPlaying(!playing));
$('prev').addEventListener('click', () => { const on = playing; setPlaying(false); index = Math.max(0, index - 1); markCurrent(order[index]); if (on) setPlaying(true); });
$('next').addEventListener('click', () => { const on = playing; setPlaying(false); index = Math.min(order.length - 1, index + 1); markCurrent(order[index]); if (on) setPlaying(true); });
wireText();
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !book) return;
  if (ch[store.STORAGE_KEYS.vocab]) { vocab = { words: { ...(ch[store.STORAGE_KEYS.vocab].newValue?.words ?? {}) as Record<string, WordStatus> }, marked: {} }; recompute(); }
  if (ch[store.LEVEL_KEY]) { void store.getLevel().then((m) => { level = m; recompute(); }); }
});
