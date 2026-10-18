import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Book, Position, CefrLevel } from '@core/model';
import type { WordStatus, MarkedRange, TtsEngineId } from '@shared/settings';
import type { TtsVoice } from '@core/tts/engine';
import { Playback, type PlaybackState } from '@core/listen/playback';
import { ListenController, type TranscriptEntry } from '@core/listen/controller';
import { getEngine, useFakeEngine, cancelAllEngines, defaultVoiceFor, chineseVoiceId } from '@core/tts/registry';
import { explain as aiExplain } from '@core/ai/client';
import { firstPosition, getSentence, percentAt } from '@core/nav';
import { useApp } from '../state/store';
import { useDictionary } from './useDictionary';
import { renderChapter, renderSentence, restyleLemma, type TokenMeta } from './render';
import { Popup, type PopupData } from './Popup';
import { Transport } from './Transport';
import { Transcript } from './Transcript';
import { matchesShortcut, isTypingTarget } from './shortcuts';

const E2E = typeof location !== 'undefined' && new URLSearchParams(location.search).has('e2e');
if (E2E) useFakeEngine(2);

const keyOf = (p: Position) => `${p.chapter}.${p.paragraph}.${p.sentence}`;

export function ReaderView({ book }: { book: Book }): JSX.Element {
  const dict = useDictionary();
  const settings = useApp((s) => s.settings);
  const vocab = useApp((s) => s.vocab);
  const library = useApp((s) => s.library);
  const showToast = useApp((s) => s.showToast);

  const docRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const vocabRef = useRef(vocab); vocabRef.current = vocab;
  const metaRef = useRef(new Map<string, (TokenMeta | null)[]>());
  const playbackRef = useRef<Playback | null>(null);
  const controllerRef = useRef<ListenController | null>(null);
  const voiceIdRef = useRef<string>('');
  const explainVoiceIdRef = useRef<string>('');
  const zhVoiceRef = useRef<string | null>(null);
  const markedRef = useRef<MarkedRange[]>(vocab.marked[book.id] ?? []);
  const warnedRef = useRef<string>('');
  const posRef = useRef<Position>(firstPosition(book) ?? { chapter: 0, paragraph: 0, sentence: 0 });
  const currentWordRef = useRef<HTMLElement[]>([]);
  const resumeAfterPopupRef = useRef(false);

  const [chapter, setChapter] = useState<number>(() => (library.find((b) => b.id === book.id)?.position ?? firstPosition(book))?.chapter ?? 0);
  const [position, setPosition] = useState<Position>(posRef.current);
  const [playState, setPlayState] = useState<PlaybackState>('idle');
  const [listenOn, setListenOn] = useState(false);
  const [popup, setPopup] = useState<PopupData & { pos: Position; tokenIndex: number } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [page, setPage] = useState({ index: 0, count: 1 });
  const [stops, setStops] = useState<number | null>(null);
  const [selBar, setSelBar] = useState<{ x: number; y: number; text: string; kind: 'word' | 'phrase' | 'sentence' | 'passage'; ranges: MarkedRange[]; pos: Position } | null>(null);
  const [ready, setReady] = useState(false);

  const names = useMemo(() => new Set(book.names), [book]);
  const isPage = settings.appearance.layout === 'page';

  // ---- voices ---------------------------------------------------------------------------------
  useEffect(() => {
    let on = true;
    (async () => {
      const s = settingsRef.current;
      voiceIdRef.current = s.voice.voiceId || (await defaultVoiceFor(s.voice.engine));
      const ee = s.voice.explainEngine ?? s.voice.engine;
      explainVoiceIdRef.current = s.voice.explainVoiceId || (ee === s.voice.engine ? voiceIdRef.current : await defaultVoiceFor(ee));
      zhVoiceRef.current = await chineseVoiceId();
      const list: TtsVoice[] = [];
      for (const id of ['webspeech', s.voice.engine, s.voice.explainEngine].filter(Boolean) as TtsEngineId[]) {
        if (list.some((v) => v.engine === id)) continue;
        try { list.push(...(await getEngine(id).listVoices())); } catch { /* engine not configured */ }
      }
      if (on) setVoices(list);
    })();
    return () => { on = false; };
  }, [settings.voice.engine, settings.voice.voiceId, settings.voice.explainEngine, settings.voice.explainVoiceId]);

  // ---- playback + listening controller --------------------------------------------------------
  useEffect(() => {
    if (!dict) return;
    const start = library.find((b) => b.id === book.id)?.position ?? firstPosition(book) ?? { chapter: 0, paragraph: 0, sentence: 0 };
    posRef.current = start; setPosition(start); setChapter(start.chapter);
    const playback = new Playback(book, {
      engine: () => getEngine(settingsRef.current.voice.engine),
      voice: () => ({ voiceId: voiceIdRef.current, rate: settingsRef.current.voice.rate }),
      pauseMs: () => settingsRef.current.voice.pauseBetweenSentencesMs,
    }, start);
    const controller = new ListenController(playback, {
      book, dict, names,
      settings: () => settingsRef.current,
      vocab: () => vocabRef.current,
      marked: () => markedRef.current,
      engine: () => getEngine(settingsRef.current.voice.engine),
      explainEngine: () => getEngine(settingsRef.current.voice.explainEngine ?? settingsRef.current.voice.engine),
      zhEngine: () => getEngine('webspeech'),
      voice: () => ({ voiceId: voiceIdRef.current, rate: settingsRef.current.voice.rate }),
      explainVoice: () => ({ voiceId: explainVoiceIdRef.current, rate: Math.min(settingsRef.current.voice.rate, 1.2) }),
      zhVoiceId: () => (settingsRef.current.ai.speakChinese ? zhVoiceRef.current : null),
      explain: (req, onDelta) => { const h = aiExplain(req, (_d, full) => onDelta(full)); return { done: h.done, cancel: h.cancel }; },
      onTranscript: (entry) => {
        setTranscript((prev) => (prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev.slice(-40), entry]));
        setTranscriptOpen(true);
      },
      onMarkLearning: (lemma) => { if (!vocabRef.current.words[lemma]) void changeStatus(lemma, 'learning', false); },
      onBudget: (daily, monthly) => {
        const s = settingsRef.current; const today = new Date().toISOString().slice(0, 10);
        if (s.ai.dailyWarnUsd > 0 && daily >= s.ai.dailyWarnUsd && warnedRef.current !== today) { warnedRef.current = today; showToast(`AI spending today: $${daily.toFixed(2)} (monthly $${monthly.toFixed(2)})`); }
      },
    });
    playbackRef.current = playback; controllerRef.current = controller;
    const offs = [
      playback.on('sentence', (pos) => { posRef.current = pos; setPosition(pos); setChapter((c) => (c === pos.chapter ? c : pos.chapter)); highlightSentence(pos); scheduleSave(pos); }),
      playback.on('word', (pos, ti) => highlightWord(pos, ti)),
      playback.on('state', (st) => setPlayState(st)),
      playback.on('finished', () => showToast('End of the book.')),
      playback.on('error', (e) => {
        const eng = settingsRef.current.voice.engine;
        if (eng !== 'webspeech') {
          showToast(`${eng === 'edge' ? 'Microsoft' : eng === 'openai' ? 'OpenAI' : 'ElevenLabs'} voice failed (${e.message}). Switching to the Mac voice.`);
          void useApp.getState().patchSettings({ voice: { ...settingsRef.current.voice, engine: 'webspeech', voiceId: '' } }).then(async () => { voiceIdRef.current = await defaultVoiceFor('webspeech'); playback.play(); });
        } else showToast(`Voice error: ${e.message}`);
      }),
    ];
    setReady(true);
    return () => { offs.forEach((f) => f()); controller.skip(); playback.stop(); cancelAllEngines(); playbackRef.current = null; controllerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict, book]);

  // ---- rendering the chapter ------------------------------------------------------------------
  const renderOpts = useCallback(() => ({ dict: dict!, names, learner: settingsRef.current.learnerLevel as CefrLevel, vocab: vocabRef.current.words, marked: markedRef.current }), [dict, names]);

  const renderCurrentChapter = useCallback(() => {
    if (!dict || !pagesRef.current) return;
    const ch = book.chapters[chapter];
    if (!ch) return;
    const { html, meta } = renderChapter(ch, renderOpts());
    metaRef.current = meta;
    pagesRef.current.innerHTML = `<div class="doc-inner"><div class="chapter-title">${ch.title.replace(/</g, '&lt;')}</div>${html}</div>`;
    layoutPages();
    highlightSentence(posRef.current);
    requestAnimationFrame(() => ensureVisible(posRef.current, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict, chapter, book, renderOpts, settings.appearance.layout, settings.learnerLevel]);

  useEffect(() => { renderCurrentChapter(); }, [renderCurrentChapter]);
  useEffect(() => { markedRef.current = vocab.marked[book.id] ?? []; }, [vocab.marked, book.id]);

  // band content for the current paragraph
  const bandHtml = useMemo(() => {
    if (!dict) return '';
    const para = book.chapters[position.chapter]?.paragraphs[position.paragraph];
    if (!para) return '';
    return para.sentences.map((s) => renderSentence(para, s, position.chapter, renderOpts())).join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict, book, position.chapter, position.paragraph, vocab.words, settings.learnerLevel, vocab.marked]);
  useEffect(() => { if (bandRef.current) { bandRef.current.innerHTML = bandHtml; highlightSentence(posRef.current); } }, [bandHtml]);

  // ---- layout: pages ------------------------------------------------------------------------------
  const pageStep = useRef({ w: 0, gap: 48 });
  const layoutPages = useCallback(() => {
    const doc = docRef.current, pages = pagesRef.current;
    if (!doc || !pages) return;
    if (settingsRef.current.appearance.layout !== 'page') { pages.style.cssText = ''; setPage({ index: 0, count: 1 }); return; }
    const w = doc.clientWidth, h = doc.clientHeight, gap = Math.max(32, settingsRef.current.appearance.marginPx);
    pageStep.current = { w, gap };
    pages.style.cssText = `width:${w}px;height:${h}px;column-width:${w}px;column-gap:${gap}px;`;
    const count = Math.max(1, Math.round((pages.scrollWidth + gap) / (w + gap)));
    setPage((p) => ({ index: Math.min(p.index, count - 1), count }));
  }, []);
  useEffect(() => {
    const doc = docRef.current; if (!doc) return;
    const ro = new ResizeObserver(() => { layoutPages(); requestAnimationFrame(() => ensureVisible(posRef.current, true)); });
    ro.observe(doc);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutPages]);
  useEffect(() => {
    const pages = pagesRef.current; if (!pages) return;
    pages.style.transform = isPage ? `translateX(${-page.index * (pageStep.current.w + pageStep.current.gap)}px)` : '';
  }, [page, isPage]);

  function pageOfElement(el: Element): number {
    const rect = el.getClientRects()[0] ?? el.getBoundingClientRect();
    const docRect = docRef.current!.getBoundingClientRect();
    const step = pageStep.current.w + pageStep.current.gap;
    const abs = rect.left - docRect.left + page.index * step;
    return Math.max(0, Math.floor((abs + 2) / step));
  }
  const pageRef = useRef(page); pageRef.current = page;
  function ensureVisible(pos: Position, force = false): void {
    const el = docRef.current?.querySelector(`.s[data-key="${keyOf(pos)}"]`);
    if (!el) return;
    if (settingsRef.current.appearance.layout === 'page') {
      const rect = el.getClientRects()[0] ?? el.getBoundingClientRect();
      const docRect = docRef.current!.getBoundingClientRect();
      const step = pageStep.current.w + pageStep.current.gap;
      const abs = rect.left - docRect.left + pageRef.current.index * step;
      const target = Math.max(0, Math.floor((abs + 2) / step));
      if (target !== pageRef.current.index || force) setPage((p) => ({ ...p, index: Math.min(target, p.count - 1) }));
    } else {
      const r = el.getBoundingClientRect(); const d = docRef.current!.getBoundingClientRect();
      if (force || r.top < d.top + 40 || r.bottom > d.bottom - 40) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
    }
  }

  // ---- highlighting -------------------------------------------------------------------------------
  function highlightSentence(pos: Position): void {
    for (const root of [docRef.current, bandRef.current]) {
      if (!root) continue;
      root.querySelectorAll('.s.cur').forEach((e) => e.classList.remove('cur'));
      root.querySelector(`.s[data-key="${keyOf(pos)}"]`)?.classList.add('cur');
    }
    clearWord();
    ensureVisible(pos);
    bandRef.current?.querySelector('.s.cur')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function clearWord(): void { for (const el of currentWordRef.current) el.classList.remove('cur-w'); currentWordRef.current = []; }
  function highlightWord(pos: Position, tokenIndex: number): void {
    clearWord();
    for (const root of [docRef.current, bandRef.current]) {
      const el = root?.querySelector<HTMLElement>(`.s[data-key="${keyOf(pos)}"] .w[data-t="${tokenIndex}"]`);
      if (el) { el.classList.add('cur-w'); currentWordRef.current.push(el); }
    }
  }

  // ---- progress -----------------------------------------------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleSave(pos: Position): void {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void window.readalong.saveProgress(book.id, pos, percentAt(book, pos)); }, 1500);
  }
  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); void window.readalong.saveProgress(book.id, posRef.current, percentAt(book, posRef.current)); } }, [book]);

  // ---- vocabulary changes -------------------------------------------------------------------------
  async function changeStatus(lemma: string, status: WordStatus | null, toast = true): Promise<void> {
    const prev = vocabRef.current.words[lemma];
    const words = { ...vocabRef.current.words };
    if (status) words[lemma] = status; else delete words[lemma];
    useApp.getState().setVocab({ ...vocabRef.current, words });
    await window.readalong.setWordStatus(lemma, status);
    for (const root of [docRef.current, bandRef.current]) if (root) restyleLemma(root, lemma, status, settingsRef.current.learnerLevel);
    if (toast && status === 'known') showToast(`“${lemma}” marked known`, { label: 'Undo', run: () => void changeStatus(lemma, prev ?? null, false) });
    if (listenOn) setStops(controllerRef.current?.countStops(chapter) ?? null);
  }

  async function setMarked(ranges: MarkedRange[]): Promise<void> {
    markedRef.current = ranges;
    useApp.getState().setVocab({ ...vocabRef.current, marked: { ...vocabRef.current.marked, [book.id]: ranges } });
    await window.readalong.setMarkedRanges(book.id, ranges);
    renderCurrentChapter();
  }

  // ---- clicks -------------------------------------------------------------------------------------
  function metaFor(pos: Position, tokenIndex: number): TokenMeta | null {
    const list = metaRef.current.get(keyOf(pos));
    if (list) return list[tokenIndex] ?? null;
    const cur = getSentence(book, pos);
    if (!cur || !dict) return null;
    const html = renderSentence(cur.para, cur.sentence, pos.chapter, renderOpts(), metaRef.current);
    void html;
    return metaRef.current.get(keyOf(pos))?.[tokenIndex] ?? null;
  }
  function posOf(el: Element): Position | null {
    const s = el.closest<HTMLElement>('.s'); if (!s?.dataset.key) return null;
    const [c, p, sIdx] = s.dataset.key.split('.').map(Number);
    return { chapter: c, paragraph: p, sentence: sIdx };
  }
  function openPopupFor(wordEl: HTMLElement): void {
    const pos = posOf(wordEl); if (!pos) return;
    const ti = Number(wordEl.dataset.t);
    const meta = metaFor(pos, ti); if (!meta) return;
    const container = docRef.current!.parentElement!.getBoundingClientRect();
    const r = wordEl.getBoundingClientRect();
    const placeBelow = r.top - container.top < 240;
    setPopup({ word: wordEl.textContent ?? '', lemma: meta.lemma, ipa: meta.ipa, zh: meta.zh, level: meta.level, isName: meta.isName, status: vocabRef.current.words[meta.lemma], x: r.left - container.left + r.width / 2, y: (placeBelow ? r.bottom : r.top) - container.top, placeBelow, pos, tokenIndex: ti });
    setSelBar(null);
  }
  const onDocClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const w = target.closest<HTMLElement>('.w');
    if (w && w.dataset.lemma) {
      if (e.detail === 2) { e.preventDefault(); return; }
      const playing = playState === 'playing' || playState === 'explaining';
      if (listenOn && playing && settingsRef.current.listen.tapHighlightCancels && (w.classList.contains('hl-unknown') || w.classList.contains('hl-learning'))) {
        void changeStatus(w.dataset.lemma, 'known');
        controllerRef.current?.dismiss(w.dataset.lemma);
        return;
      }
      // looking a word up pauses the reading; closing the popup resumes it
      if (playing && !ctl()?.busy) { playbackRef.current?.pause(); resumeAfterPopupRef.current = true; }
      openPopupFor(w);
      return;
    }
    const pos = posOf(target);
    if (pos && !target.closest('.popup')) { closePopup(false); nav((p) => p.seek(pos)); if (playbackRef.current?.state === 'idle') { posRef.current = pos; setPosition(pos); highlightSentence(pos); } }
    else closePopup();
  };
  const onDocDoubleClick = (e: React.MouseEvent) => {
    const w = (e.target as HTMLElement).closest<HTMLElement>('.w');
    if (w?.dataset.lemma && (w.classList.contains('hl-unknown') || w.classList.contains('hl-learning'))) { setPopup(null); void changeStatus(w.dataset.lemma, 'known'); }
  };
  const onMouseUp = () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !docRef.current || !sel.anchorNode || !docRef.current.contains(sel.anchorNode)) { setSelBar(null); return; }
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 2000) { setSelBar(null); return; }
      const a = (sel.anchorNode.parentElement)?.closest('.s'), f = (sel.focusNode?.parentElement)?.closest('.s');
      const posA = a ? posOf(a) : null, posF = f ? posOf(f) : null;
      const rect = sel.getRangeAt(0).getBoundingClientRect(); const c = docRef.current.parentElement!.getBoundingClientRect();
      const words = text.split(/\s+/).length;
      let kind: 'word' | 'phrase' | 'sentence' | 'passage' = 'phrase';
      const ranges: MarkedRange[] = [];
      if (posA && posF && keyOf(posA) === keyOf(posF)) {
        const cur = getSentence(book, posA)!;
        const whole = text.length >= cur.text.trim().length - 2;
        kind = words === 1 ? 'word' : whole ? 'sentence' : 'phrase';
        const startIdx = cur.text.indexOf(text);
        ranges.push({ ...posA, start: whole || startIdx < 0 ? cur.sentence.start : cur.sentence.start + startIdx, end: whole || startIdx < 0 ? cur.sentence.end : cur.sentence.start + startIdx + text.length, text });
      } else if (posA && posF) {
        kind = 'passage';
        const [from, to] = [posA, posF].sort((x, y) => x.chapter - y.chapter || x.paragraph - y.paragraph || x.sentence - y.sentence);
        let p: Position | null = from;
        while (p && (p.chapter < to.chapter || p.paragraph < to.paragraph || (p.paragraph === to.paragraph && p.sentence <= to.sentence))) {
          const cur = getSentence(book, p); if (cur) ranges.push({ ...p, start: cur.sentence.start, end: cur.sentence.end, text: cur.text });
          const next: Position | null = getSentence(book, { ...p, sentence: p.sentence + 1 }) ? { ...p, sentence: p.sentence + 1 } : book.chapters[p.chapter]?.paragraphs[p.paragraph + 1] ? { chapter: p.chapter, paragraph: p.paragraph + 1, sentence: 0 } : null;
          p = next;
          if (ranges.length > 40) break;
        }
      }
      setSelBar({ x: rect.left - c.left + rect.width / 2, y: rect.top - c.top, text, kind, ranges, pos: posA ?? posRef.current });
      setPopup(null);
    }, 0);
  };

  // ---- actions ------------------------------------------------------------------------------------
  const pb = () => playbackRef.current;
  const ctl = () => controllerRef.current;
  /** navigation always interrupts a running explanation first */
  const nav = (fn: (p: Playback) => void) => { const p = pb(); if (!p) return; resumeAfterPopupRef.current = false; ctl()?.skip(); fn(p); };
  const closePopup = (resume = true) => {
    setPopup(null);
    if (resume && resumeAfterPopupRef.current) { resumeAfterPopupRef.current = false; pb()?.play(); }
    else resumeAfterPopupRef.current = false;
  };
  const playPause = () => {
    const p = pb(); if (!p) return;
    resumeAfterPopupRef.current = false;
    if (ctl()?.busy) { ctl()!.skip(); return; }
    if (p.state === 'playing' || p.state === 'explaining') p.pause(); else p.play(p.state === 'idle' ? posRef.current : undefined);
  };
  const toggleListen = () => {
    const on = !listenOn; setListenOn(on);
    if (ctl()) { ctl()!.enabled = on; setStops(on ? ctl()!.countStops(chapter) : null); }
    showToast(on ? 'Listening mode on: hard words will be explained automatically.' : 'Listening mode off.');
  };
  useEffect(() => { if (listenOn) setStops(ctl()?.countStops(chapter) ?? null); }, [listenOn, chapter, vocab.words, settings.learnerLevel, settings.listen]);
  const explainPopupWord = () => {
    if (!popup) return;
    const d = popup.zh || popup.ipa ? { ipa: popup.ipa, zh: popup.zh.split('\n')[0], level: popup.level ?? undefined } : null;
    const resume = resumeAfterPopupRef.current; resumeAfterPopupRef.current = false;
    void ctl()?.explainNow('word', popup.word, popup.pos, d, popup.isName ? undefined : popup.lemma, undefined, resume);
    setPopup(null);
  };
  const explainCurrentSentence = () => { const cur = getSentence(book, posRef.current); if (cur) void ctl()?.explainNow('sentence', cur.text, posRef.current, null); };
  const explainLast = () => void ctl()?.explainLast(settingsRef.current.listen.lastSecondsWindow);
  const sayPopup = () => { if (!popup) return; ctl()?.skip(); const e = getEngine(settingsRef.current.voice.engine); e.cancelAll(); e.speak(popup.word, { voiceId: voiceIdRef.current, rate: 0.8 }); };
  const markSentence = (pos: Position) => { const cur = getSentence(book, pos); if (!cur) return; const r: MarkedRange = { ...pos, start: cur.sentence.start, end: cur.sentence.end, text: cur.text }; const exists = markedRef.current.some((m) => keyOf(m) === keyOf(pos) && m.start === r.start && m.end === r.end); void setMarked(exists ? markedRef.current.filter((m) => !(keyOf(m) === keyOf(pos) && m.start === r.start && m.end === r.end)) : [...markedRef.current, r]); showToast(exists ? 'Sentence unmarked' : 'Sentence marked: it will be explained in listening mode'); };
  const setRate = (r: number) => { void useApp.getState().patchSettings({ voice: { ...settingsRef.current.voice, rate: Math.round(r * 10) / 10 } }).then(() => pb()?.rateChanged()); };
  const jumpHard = (dir: 1 | -1) => {
    const all = Array.from(docRef.current?.querySelectorAll<HTMLElement>('.w.hl-unknown, .ph.hl-unknown') ?? []);
    if (!all.length) return;
    const curEl = docRef.current?.querySelector(`.s[data-key="${keyOf(posRef.current)}"]`);
    let idx = dir === 1 ? all.findIndex((el) => curEl ? (curEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !curEl.contains(el) : true) : all.length - 1;
    if (dir === -1) { const rev = [...all].reverse(); idx = all.length - 1 - rev.findIndex((el) => curEl ? (curEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0 : true); }
    const el = all[idx] ?? all[0];
    const w = el.classList.contains('w') ? el : el.querySelector<HTMLElement>('.w');
    const pos = posOf(el);
    if (pos) { posRef.current = pos; setPosition(pos); nav((p) => p.seek(pos)); highlightSentence(pos); }
    if (w) openPopupFor(w);
  };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const sc = settingsRef.current.shortcuts;
      const is = (name: string) => matchesShortcut(e, sc[name]);
      if (is('playPause')) { e.preventDefault(); playPause(); }
      else if (is('closePopup')) { if (popup) closePopup(); else if (selBar) setSelBar(null); else ctl()?.skip(); }
      else if (is('nextSentence')) nav((p) => p.next());
      else if (is('prevSentence')) nav((p) => p.prev());
      else if (is('nextParagraph')) nav((p) => p.nextParagraph());
      else if (is('prevParagraph')) nav((p) => p.prevParagraph());
      else if (is('nextPage')) { e.preventDefault(); isPage ? setPage((p) => ({ ...p, index: Math.min(p.count - 1, p.index + 1) })) : docRef.current?.scrollBy({ top: docRef.current.clientHeight * 0.9, behavior: 'smooth' }); }
      else if (is('prevPage')) { e.preventDefault(); isPage ? setPage((p) => ({ ...p, index: Math.max(0, p.index - 1) })) : docRef.current?.scrollBy({ top: -docRef.current.clientHeight * 0.9, behavior: 'smooth' }); }
      else if (is('replaySentence')) nav((p) => p.replay());
      else if (is('explainLast')) { e.preventDefault(); explainLast(); }
      else if (is('explain')) { e.preventDefault(); if (popup) explainPopupWord(); else if (selBar) { void ctl()?.explainNow(selBar.kind, selBar.text, selBar.pos, null); setSelBar(null); } else explainCurrentSentence(); }
      else if (is('markKnown')) { if (popup) { void changeStatus(popup.lemma, 'known'); closePopup(); } }
      else if (is('markLearning')) { if (popup) { void changeStatus(popup.lemma, 'learning'); closePopup(); } }
      else if (is('ignore')) { if (popup) { void changeStatus(popup.lemma, 'ignored'); closePopup(); } }
      else if (is('toggleListen')) toggleListen();
      else if (is('toggleBand')) void useApp.getState().patchSettings({ appearance: { ...settingsRef.current.appearance, bandEnabled: !settingsRef.current.appearance.bandEnabled } });
      else if (is('sayWord')) sayPopup();
      else if (is('speedUp')) setRate(Math.min(2.5, settingsRef.current.voice.rate + 0.1));
      else if (is('speedDown')) setRate(Math.max(0.5, settingsRef.current.voice.rate - 0.1));
      else if (is('speedReset')) setRate(1);
      else if (is('nextHard')) { e.preventDefault(); jumpHard(1); }
      else if (is('prevHard')) { e.preventDefault(); jumpHard(-1); }
      else if (is('markPhrase')) { if (selBar) { void setMarked([...markedRef.current, ...selBar.ranges]); setSelBar(null); } else markSentence(popup?.pos ?? posRef.current); }
      else return;
    };
    window.addEventListener('keydown', onKey);
    const onMenu = (ev: Event) => { const a = (ev as CustomEvent).detail; if (a === 'playPause') playPause(); };
    window.addEventListener('readalong:menu', onMenu);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('readalong:menu', onMenu); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup, selBar, listenOn, isPage, playState]);

  // band resize
  const onBandDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY, startPct = settingsRef.current.appearance.bandHeightPct;
    const total = (docRef.current?.parentElement?.parentElement?.clientHeight ?? 600);
    const move = (ev: MouseEvent) => { const pct = Math.min(60, Math.max(15, startPct + ((startY - ev.clientY) / total) * 100)); document.documentElement.style.setProperty('--band-h', `${pct}%`); };
    const up = (ev: MouseEvent) => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); const pct = Math.min(60, Math.max(15, startPct + ((startY - ev.clientY) / total) * 100)); void useApp.getState().patchSettings({ appearance: { ...settingsRef.current.appearance, bandHeightPct: Math.round(pct) } }); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  if (!dict) return <div className="empty">Loading dictionary…</div>;

  return (
    <div className="reader" data-testid="reader" onClick={() => { if (popup) closePopup(); }}>
      <div className="reader-main">
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <div className={`reader-doc ${isPage ? 'page' : 'scroll'}`} ref={docRef} onClick={(e) => { e.stopPropagation(); onDocClick(e); }} onDoubleClick={onDocDoubleClick} onMouseUp={onMouseUp} data-testid="doc">
            <div className="pages" ref={pagesRef} />
            {isPage && page.count > 1 && <>
              <button className="page-nav left icon" onClick={(e) => { e.stopPropagation(); setPage((p) => ({ ...p, index: Math.max(0, p.index - 1) })); }}>‹</button>
              <button className="page-nav right icon" onClick={(e) => { e.stopPropagation(); setPage((p) => ({ ...p, index: Math.min(p.count - 1, p.index + 1) })); }}>›</button>
              <span className="page-indicator">{page.index + 1} / {page.count}</span>
            </>}
          </div>
          {settings.appearance.bandEnabled && (
            <div className="band" style={{ height: `var(--band-h, ${settings.appearance.bandHeightPct}%)` }} data-testid="band">
              <div className="band-handle" onMouseDown={onBandDrag} />
              <div className="band-body" ref={bandRef} onClick={(e) => { e.stopPropagation(); onDocClick(e); }} onDoubleClick={onDocDoubleClick} />
            </div>
          )}
          {popup && (
            <Popup data={popup} onClose={() => closePopup()} onSay={sayPopup} onAsk={explainPopupWord}
              onStatus={(s) => { void changeStatus(popup.lemma, s); closePopup(); }} onMarkSentence={() => { markSentence(popup.pos); closePopup(); }} />
          )}
          {selBar && (
            <div className="selection-bar" style={{ left: Math.max(8, selBar.x - 120), top: Math.max(4, selBar.y - 44) }} onClick={(e) => e.stopPropagation()} data-testid="selection-bar">
              <button className="primary" onClick={() => { void ctl()?.explainNow(selBar.kind, selBar.text, selBar.pos, null); setSelBar(null); window.getSelection()?.removeAllRanges(); }}>Explain {selBar.kind}</button>
              {selBar.kind !== 'word' && <button onClick={() => { void setMarked([...markedRef.current, ...selBar.ranges]); setSelBar(null); window.getSelection()?.removeAllRanges(); showToast('Marked: it will be explained in listening mode'); }}>Mark for listening</button>}
              <button onClick={() => { navigator.clipboard.writeText(selBar.text); setSelBar(null); }}>Copy</button>
            </div>
          )}
        </div>
        {transcriptOpen && <Transcript entries={transcript} onSkip={() => ctl()?.skip()} onClose={() => setTranscriptOpen(false)} onAsk={(q) => { const cur = getSentence(book, posRef.current); void ctl()?.explainNow('question', cur?.text ?? '', posRef.current, null, undefined, q); }} />}
      </div>
      <Transport book={book} state={playState} listenOn={listenOn} settings={settings} chapter={chapter} voices={voices} stops={stops} transcriptOpen={transcriptOpen}
        onPlayPause={playPause} onPrev={() => nav((p) => p.prev())} onNext={() => nav((p) => p.next())} onToggleListen={toggleListen} onExplainLast={explainLast} onRate={setRate}
        onVoice={(engine, voiceId) => void useApp.getState().patchSettings({ voice: { ...settingsRef.current.voice, engine, voiceId } })}
        onChapter={(i) => { const p = { chapter: i, paragraph: 0, sentence: 0 }; posRef.current = p; setPosition(p); setChapter(i); nav((pbk) => pbk.seek(p)); }}
        onLayout={() => void useApp.getState().patchSettings({ appearance: { ...settingsRef.current.appearance, layout: isPage ? 'scroll' : 'page' } })}
        onBand={() => void useApp.getState().patchSettings({ appearance: { ...settingsRef.current.appearance, bandEnabled: !settingsRef.current.appearance.bandEnabled } })}
        onTranscript={() => setTranscriptOpen((v) => !v)}
        onWindow={(w) => void useApp.getState().patchSettings({ listen: { ...settingsRef.current.listen, lastSecondsWindow: w } })} />
      {!ready && <div className="empty">Preparing…</div>}
    </div>
  );
}
