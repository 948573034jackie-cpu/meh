import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Book, Position, CefrLevel } from '@core/model';
import type { WordStatus, MarkedRange, TtsEngineId, ReadMode } from '@shared/settings';
import type { TtsVoice } from '@core/tts/engine';
import type { HintMap, ExplainRequest, PhraseHit } from '@shared/api';
import { Playback, type PlaybackState } from '@core/listen/playback';
import { ListenController, type TranscriptEntry, type CommandWindow } from '@core/listen/controller';
import { getEngine, useFakeEngine, cancelAllEngines, defaultVoiceFor, chineseVoiceId } from '@core/tts/registry';
import { explain as aiExplain } from '@core/ai/client';
import { firstPosition, getSentence, percentAt, nextPosition, prevPosition } from '@core/nav';
import { skippedSentences, stripInline } from '@core/import/skip';
import { sentenceKey } from '@core/model';
import { useApp } from '../state/store';
import { useDictionary } from './useDictionary';
import { renderChapter, renderSentence, restyleLemma, type TokenMeta } from './render';
import { hintText } from './hints';
import { indexBook, positionAtTime, timeAt, wordsPerMinute, clampRate, type BookIndex } from './progress';
import { WordCard, type CardData } from './WordCard';
import { HelpSheet } from './HelpSheet';
import { ReadingScreen, type ReadingPopover } from './ReadingScreen';
import { ListeningScreen } from './ListeningScreen';
import { Transcript } from './Transcript';
import { matchesShortcut, isTypingTarget, LISTEN_KEYS, shortcutLabel } from './shortcuts';
import { VoiceChat, type VoiceSnapshot } from '../voice/VoiceChat';
import { VoiceChatUI, type VoiceExchange } from '../voice/VoiceChatUI';
import { MicCapture, SilentMic } from '../voice/mic';
import { sttBridge, e2eSttBridge, installE2eHooks } from '../voice/bridge';
import { Tip } from '../ui/Tip';
import { toChapterPhraseMap, type ChapterPhraseMap } from './phrases';

const E2E = typeof location !== 'undefined' && new URLSearchParams(location.search).has('e2e');
if (E2E) useFakeEngine(2);
/** e2e: every AI request the reader sent (the spec checks kinds, questions and "again") */
const e2eRequests: ExplainRequest[] = [];

export const keyOf = (p: Position) => `${p.chapter}.${p.paragraph}.${p.sentence}`;

/** How long the word card stays after its explanation ended. */
const CARD_LINGER_MS = 1500;

export type Card = CardData & { pos: Position; tokenIndex: number; entryId: number | null };
export interface SelBar { x: number; y: number; text: string; kind: 'word' | 'phrase' | 'sentence' | 'passage'; ranges: MarkedRange[]; pos: Position }

/** What both screens get from the reader: the rendered chapter, the shared position and the shared actions. */
export interface ScreenShared {
  book: Book;
  index: BookIndex;
  chapter: number;
  position: Position;
  playState: PlaybackState;
  /** the chapter's HTML (word spans, hints); the screen injects it and calls onRendered */
  html: string;
  docRef: React.MutableRefObject<HTMLDivElement | null>;
  /** the screen registers how it brings a sentence into view */
  ensureRef: React.MutableRefObject<(pos: Position, force?: boolean) => void>;
  onRendered: () => void;
  /** a tap on a word: opens the card and starts the spoken explanation */
  tapWord: (el: HTMLElement) => void;
  /** a tap on a sentence (not a word): the reading moves there */
  tapSentence: (el: Element) => boolean;
  /** closes the card / selection bar if one is open; true when something was closed (the tap is used up) */
  closeOverlays: () => boolean;
  onDoubleClick: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  posOf: (el: Element) => Position | null;
  playPause: () => void;
  prev: () => void;
  next: () => void;
  seek: (pos: Position) => void;
  goToChapter: (i: number) => void;
  setRate: (r: number) => void;
  switchMode: () => void;
  explainLast: () => void;
  dontKnow: () => void;
  explainSentenceAt: (pos: Position) => void;
  seekSeconds: (delta: number) => void;
  openHelp: () => void;
  wpm: number;
  busy: boolean;
}

export function ReaderView({ book }: { book: Book }): JSX.Element {
  const dict = useDictionary();
  const settings = useApp((s) => s.settings);
  const vocab = useApp((s) => s.vocab);
  const library = useApp((s) => s.library);
  const mode = useApp((s) => s.mode);
  const showToast = useApp((s) => s.showToast);

  const rootRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement | null>(null);
  const ensureRef = useRef<(pos: Position, force?: boolean) => void>(() => undefined);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const vocabRef = useRef(vocab); vocabRef.current = vocab;
  const modeRef = useRef<ReadMode>(mode); modeRef.current = mode;
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
  const cardRef = useRef<Card | null>(null);
  const cardCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** the Dream voice (Kokoro) is downloaded and loaded; until then a Mac voice reads */
  const kokoroReadyRef = useRef(false);
  const macVoiceIdRef = useRef<string>('');
  /** The engine that actually reads: Kokoro only once its model is ready (tests always use the fake Mac voice). */
  const readEngineId = (): TtsEngineId => { const id = settingsRef.current.voice.engine; return id === 'kokoro' && (E2E || !kokoroReadyRef.current) ? 'webspeech' : id; };
  const readVoiceId = (): string => (readEngineId() === settingsRef.current.voice.engine ? voiceIdRef.current : macVoiceIdRef.current);

  const [chapter, setChapter] = useState<number>(() => (library.find((b) => b.id === book.id)?.position ?? firstPosition(book))?.chapter ?? 0);
  const [position, setPosition] = useState<Position>(posRef.current);
  const [playState, setPlayState] = useState<PlaybackState>('idle');
  const [card, _setCard] = useState<Card | null>(null);
  const setCard = (c: Card | null) => { cardRef.current = c; _setCard(c); };
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [selBar, setSelBar] = useState<SelBar | null>(null);
  const [ready, setReady] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [autoStop, setAutoStop] = useState(true);
  const [popover, setPopover] = useState<ReadingPopover>(null);
  // ---- voice chat ----
  const voiceRef = useRef<VoiceChat | null>(null);
  const [voiceSnap, setVoiceSnap] = useState<VoiceSnapshot | null>(null);
  const [voicePop, setVoicePop] = useState(false);
  const savedEntriesRef = useRef(new Set<number>());
  const [heard, setHeard] = useState<{ text: string; command: 'know' | 'dont_know' | 'bye' } | null>(null);
  /** the AI's chapter hints (lemma -> [meaning as used here, other meaning]); null until the job has run */
  const [hints, setHints] = useState<HintMap | null>(null);
  const hintsRef = useRef<HintMap | null>(null); hintsRef.current = hints;
  /** the commands window of a stop (or after an explanation) is open: the bottom bar with I know / I don't know / Go on */
  const [cmdWin, setCmdWin] = useState<(CommandWindow & { id: number }) | null>(null);
  const cmdWinRef = useRef<CommandWindow | null>(null);
  const cmdSeq = useRef(0);
  /** chapter -> the chapter phrase job's hits per sentence (window.readalong.hintsPhrases, when that bridge exists) */
  const phrasesRef = useRef(new Map<number, ChapterPhraseMap>());
  /** bumps when chapter phrases arrive, so the chapter is rendered again with them highlighted */
  const [phrasesVersion, setPhrasesVersion] = useState(0);
  const hintOverrides = useMemo(() => { const out: Record<string, string> = {}; for (const [lemma, pair] of Object.entries(hints ?? {})) if (pair?.[0]) out[lemma] = pair[0]; return out; }, [hints]);

  const names = useMemo(() => new Set(book.names), [book]);
  /** sentences the voice leaves out (Skip settings: footnotes, captions, ...) */
  const skippedRef = useRef(new Set<string>());
  useEffect(() => { skippedRef.current = skippedSentences(book, settings.skip); }, [book, settings.skip]);
  const index = useMemo(() => indexBook(book), [book]);
  const playing = playState === 'playing' || playState === 'explaining';
  const wpm = wordsPerMinute(mode, settings.voice.rate, playing);

  // ---- voices ---------------------------------------------------------------------------------
  useEffect(() => {
    let on = true;
    (async () => {
      const s = settingsRef.current;
      voiceIdRef.current = s.voice.voiceId || (await defaultVoiceFor(s.voice.engine));
      macVoiceIdRef.current = await defaultVoiceFor('webspeech');
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

  // ---- playback + listening controller (shared by both screens) ---------------------------------
  useEffect(() => {
    if (!dict) return;
    const start = library.find((b) => b.id === book.id)?.position ?? firstPosition(book) ?? { chapter: 0, paragraph: 0, sentence: 0 };
    posRef.current = start; setPosition(start); setChapter(start.chapter);
    const playback = new Playback(book, {
      engine: () => getEngine(readEngineId()),
      voice: () => ({ voiceId: readVoiceId(), rate: settingsRef.current.voice.rate }),
      pauseMs: () => settingsRef.current.voice.pauseBetweenSentencesMs,
      shouldSkip: (p) => skippedRef.current.has(sentenceKey(p)),
      strip: (t) => stripInline(t, settingsRef.current.skip),
    }, start);
    const controller = new ListenController(playback, {
      book, dict, names,
      settings: () => settingsRef.current,
      vocab: () => vocabRef.current,
      marked: () => markedRef.current,
      engine: () => getEngine(readEngineId()),
      explainEngine: () => { const ee = settingsRef.current.voice.explainEngine ?? settingsRef.current.voice.engine; return getEngine(ee === 'kokoro' && (E2E || !kokoroReadyRef.current) ? 'webspeech' : ee); },
      zhEngine: () => getEngine('webspeech'),
      voice: () => ({ voiceId: readVoiceId(), rate: settingsRef.current.voice.rate }),
      explainVoice: () => { const ee = settingsRef.current.voice.explainEngine ?? settingsRef.current.voice.engine; const fallback = ee === 'kokoro' && (E2E || !kokoroReadyRef.current); return { voiceId: fallback ? macVoiceIdRef.current : explainVoiceIdRef.current, rate: Math.min(settingsRef.current.voice.rate, 1.2) }; },
      zhVoiceId: () => (settingsRef.current.ai.speakChinese ? zhVoiceRef.current : null),
      contextZh: (lemma) => hintsRef.current?.[lemma],
      explain: (req, onDelta) => { if (E2E) e2eRequests.push(structuredClone(req)); const h = aiExplain(req, (_d, full) => onDelta(full)); return { done: h.done, cancel: h.cancel }; },
      mode: () => modeRef.current,
      onWaiting: (w) => setWaiting(w),
      onPauseWindow: (open) => voiceRef.current?.pauseWindow(open),
      onCommandWindow: (w) => { cmdWinRef.current = w; setCmdWin(w ? { ...w, id: ++cmdSeq.current } : null); },
      chapterPhrases: (pos) => phrasesRef.current.get(pos.chapter)?.[sentenceKey(pos)],
      // the dictionary card shows under the word while it is said 3 times and explained; it goes away afterwards
      onStopTarget: (t) => {
        if (!t) { closeCard(); return; }
        cancelCardClose();
        const c = anchorCard(t.kind, t.target);
        if (c) setCard(t.kind === 'phrase' ? { ...c, word: t.target } : c);
      },
      onTranscript: (entry) => {
        setTranscript((prev) => (prev.some((e) => e.id === entry.id) ? prev.map((e) => (e.id === entry.id ? entry : e)) : [...prev.slice(-40), entry]));
        setBusy(controller.busy);
        voiceRef.current?.setTutorState(!controller.busy ? 'idle' : entry.status === 'thinking' ? 'thinking' : 'speaking');
        if (entry.kind === 'question' && entry.status === 'thinking') setHeard(null);
        // every explained word or phrase goes into My Vocabulary (and the CSV), with its sentence and explanation
        if (entry.lemma && (entry.kind === 'word' || entry.kind === 'phrase') && entry.status === 'done' && entry.text && !savedEntriesRef.current.has(entry.id)) {
          savedEntriesRef.current.add(entry.id);
          const ch = book.chapters[entry.position?.chapter ?? 0];
          void window.readalong.vocabUpsertEntry({
            lemma: entry.lemma, word: entry.target, sentence: entry.sentence, explanation: entry.text, chinese: entry.chinese ?? '',
            bookId: book.id, bookTitle: book.title, chapter: ch?.title ?? '', position: entry.position, level: entry.level as never, again: entry.again,
          }).catch(() => undefined);
        }
        followEntry(entry);
      },
      onMarkLearning: (lemma) => { if (!vocabRef.current.words[lemma]) void changeStatus(lemma, 'learning', false); },
      onBudget: (daily, monthly) => {
        const s = settingsRef.current; const today = new Date().toISOString().slice(0, 10);
        if (s.ai.dailyWarnUsd > 0 && daily >= s.ai.dailyWarnUsd && warnedRef.current !== today) { warnedRef.current = today; showToast(`AI spending today: $${daily.toFixed(2)} (monthly $${monthly.toFixed(2)})`); }
      },
    });
    controller.enabled = modeRef.current === 'listening';
    playbackRef.current = playback; controllerRef.current = controller;
    const offs = [
      playback.on('sentence', (pos) => { posRef.current = pos; setPosition(pos); setChapter((c) => (c === pos.chapter ? c : pos.chapter)); highlightSentence(pos); scheduleSave(pos); prepareAhead(pos); }),
      playback.on('word', (pos, ti) => highlightWord(pos, ti)),
      playback.on('state', (st) => { setPlayState(st); setBusy(controller.busy); if (!controller.busy) voiceRef.current?.setTutorState('idle'); }),
      playback.on('finished', () => showToast('End of the book.')),
      playback.on('error', (e) => {
        const eng = readEngineId();
        if (eng === 'kokoro') {
          // the Dream voice failed: read on with a Mac voice; the choice in Settings stays, it is tried again when it reports ready
          kokoroReadyRef.current = false;
          showToast(`The Dream voice failed (${e.message}). Using a Mac voice for now.`);
          playback.play();
        } else if (eng !== 'webspeech') {
          const names: Partial<Record<TtsEngineId, string>> = { edge: 'Microsoft', openai: 'OpenAI', elevenlabs: 'ElevenLabs', azure: 'Azure', google: 'Google' };
          showToast(`${names[eng] ?? 'The'} voice failed (${e.message}). Switching to the Mac voice.`);
          void useApp.getState().patchSettings({ voice: { ...settingsRef.current.voice, engine: 'webspeech', voiceId: '' } }).then(async () => { voiceIdRef.current = await defaultVoiceFor('webspeech'); playback.play(); });
        } else showToast(`Voice error: ${e.message}`);
      }),
    ];
    setReady(true);
    return () => { offs.forEach((f) => f()); controller.dispose(); playback.stop(); cancelAllEngines(); playbackRef.current = null; controllerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict, book]);

  // ---- voice chat: the learner talks with the tutor (mic -> local speech-to-text -> questions / commands) ----------
  useEffect(() => {
    if (!ready) return;
    const chat = new VoiceChat({
      stt: E2E ? e2eSttBridge() : sttBridge(),
      mic: E2E ? new SilentMic() : new MicCapture(),
      alwaysOn: settingsRef.current.voiceChat?.alwaysOn ?? false,
      tutor: {
        know: () => answerKnow(),
        dontKnow: () => answerDontKnow(),
        ask: (text, spoken) => {
          // in the window right after the word was said, anything the learner says goes with its explanation
          if (ctl()?.answerWindow({ text })) return;
          const cur = getSentence(book, posRef.current); void ctl()?.explainNow('question', cur?.text ?? '', posRef.current, null, undefined, text, undefined, undefined, spoken);
        },
        hold: () => { ctl()?.hold(); },
        release: () => ctl()?.release(modeRef.current === 'listening'),
        keepWaiting: () => ctl()?.keepWaiting(),
        windowSpeechEnded: () => ctl()?.windowSpeechEnded(),
        continueBook: () => { const c = ctl(); if (c && !c.answerWindow('bye') && modeRef.current === 'listening') c.continueNow(); },
      },
    });
    voiceRef.current = chat;
    setVoiceSnap(chat.snapshot);
    const offs = [
      chat.on('change', (snap) => setVoiceSnap(snap)),
      chat.on('heard', (h) => setHeard(h.command ? { text: h.text, command: h.command } : null)),
    ];
    const uninstall = E2E ? installE2eHooks(chat, e2eRequests) : () => undefined;
    return () => { offs.forEach((f) => f()); uninstall(); chat.dispose(); if (voiceRef.current === chat) voiceRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, book]);
  // the consent card and errors live in the popover: show it
  useEffect(() => { if (voiceSnap?.consent || voiceSnap?.error) setVoicePop(true); }, [voiceSnap?.consent, voiceSnap?.error]);
  // entering Listening mode without the speech model: offer the download once, so the windows at hard words can hear
  const hasVoice = voiceSnap !== null;
  useEffect(() => {
    const chat = voiceRef.current;
    if (mode !== 'listening' || !chat || settingsRef.current.voiceChat?.modelOffered) return;
    void chat.offerModel().then((shown) => {
      if (shown) void useApp.getState().patchSettings({ voiceChat: { ...settingsRef.current.voiceChat, modelOffered: true } });
    });
  }, [mode, hasVoice]);
  const setAlwaysOn = (on: boolean) => {
    voiceRef.current?.setAlwaysOn(on);
    void useApp.getState().patchSettings({ voiceChat: { ...settingsRef.current.voiceChat, alwaysOn: on } });
  };
  /** what the popover shows: the last question and its answer, or the last command heard */
  const voiceLast: VoiceExchange | null = useMemo(() => {
    if (heard) return { you: heard.text, tutor: heard.command === 'know' ? 'Good, marked as known.' : heard.command === 'dont_know' ? 'Once more, from another angle.' : 'Bye bye! Talk to me any time.', status: 'done' };
    const q = [...transcript].reverse().find((e) => e.kind === 'question');
    return q ? { you: q.question ?? '', tutor: q.parts?.free ?? q.text, status: q.status, error: q.error } : null;
  }, [heard, transcript]);

  // ---- the Dream voice (Kokoro): download on first use, read with a Mac voice meanwhile --------------
  useEffect(() => {
    if (E2E || (settings.voice.engine !== 'kokoro' && settings.voice.explainEngine !== 'kokoro') || typeof window.readalong.kokoroStatus !== 'function') return;
    let on = true;
    let announced = false;
    const apply = (st: { state: string; error: string | null }) => {
      if (!on) return;
      const ready = st.state === 'ready';
      if (ready !== kokoroReadyRef.current) {
        kokoroReadyRef.current = ready; // the next sentence is read with the new engine
        if (ready && announced) showToast('The Dream voice is ready.');
      }
      if (st.state === 'error' && st.error && !announced) { announced = true; showToast(`The Dream voice could not be downloaded (${st.error}). Using a Mac voice.`); }
    };
    const off = window.readalong.onKokoroProgress(apply);
    void window.readalong.kokoroStatus().then((st) => {
      if (!on) return;
      apply(st);
      if (st.state === 'missing' || st.state === 'error') {
        announced = true;
        showToast('Downloading the Dream voice (192 MB)… using a Mac voice meanwhile');
        void window.readalong.kokoroDownload().then(apply).catch((e: Error) => showToast(`The Dream voice could not be downloaded (${e.message}). Using a Mac voice.`));
      }
    }).catch(() => undefined);
    return () => { on = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.voice.engine, settings.voice.explainEngine]);

  /** While Kokoro reads, the next five sentences are synthesized ahead so each one starts without a wait. */
  function prepareAhead(pos: Position): void {
    if (readEngineId() !== 'kokoro' || typeof window.readalong.kokoroPrepare !== 'function') return;
    // exactly what Playback will ask for: Skip-panel sentences left out, the stripped text, speed 1 (the main
    // process always synthesizes Kokoro at speed 1; the rate is applied on playback), so the cache key matches
    const items: { text: string; voice?: string; speed?: number }[] = [];
    let p: Position | null = pos;
    for (let i = 0; i < 5 && p; ) {
      p = nextPosition(book, p);
      if (!p) break;
      if (skippedRef.current.has(sentenceKey(p))) continue;
      i++;
      const s = getSentence(book, p);
      const text = s ? (stripInline(s.text, settingsRef.current.skip)?.text ?? s.text) : '';
      if (text.trim()) items.push({ text, voice: readVoiceId() || undefined, speed: 1 });
    }
    if (items.length) void window.readalong.kokoroPrepare(items).catch(() => undefined);
  }

  // ---- chapter hints: cached by the main process; this chapter and the next are requested when missing ------
  useEffect(() => {
    const api = window.readalong;
    if (E2E || typeof api.hintsGet !== 'function') return;
    let on = true;
    setHints(null);
    const fetch = () => api.hintsGet(book.id, chapter).then((m) => { if (on) setHints(m); return m; }).catch(() => null);
    void fetch().then((m) => {
      if (!on) return;
      if (!m) void api.hintsRequest(book.id, chapter).catch(() => undefined);
      if (book.chapters[chapter + 1]) void api.hintsRequest(book.id, chapter + 1).catch(() => undefined);
    });
    const off = api.onHintsProgress((ev) => { if (ev.bookId === book.id && ev.chapter === chapter && ev.state === 'done') void fetch(); });
    return () => { on = false; off(); };
  }, [book, chapter]);

  // ---- chapter phrases (idioms, phrasal verbs, slang) found by the chapter job: Listening stops at them like words ----
  useEffect(() => {
    const api = window.readalong as unknown as { hintsPhrases?: (bookId: string, chapter: number) => Promise<unknown>; onHintsProgress?: typeof window.readalong.onHintsProgress };
    if (typeof api.hintsPhrases !== 'function') return;
    let on = true;
    const load = (ch: number) => { void api.hintsPhrases!(book.id, ch).then((d) => { if (!on) return; phrasesRef.current.set(ch, toChapterPhraseMap(d, ch)); if (ch === chapter) setPhrasesVersion((v) => v + 1); }, () => undefined); };
    load(chapter);
    if (book.chapters[chapter + 1]) load(chapter + 1);
    const off = typeof api.onHintsProgress === 'function' ? api.onHintsProgress((ev) => { if (ev.bookId === book.id && ev.state === 'done' && (ev.chapter === chapter || ev.chapter === chapter + 1)) load(ev.chapter); }) : () => undefined;
    return () => { on = false; off(); };
  }, [book, chapter]);
  useEffect(() => { phrasesRef.current = new Map(); }, [book]);

  // the controller stops at hard words only on the Listening screen (and only while auto-stop is on)
  useEffect(() => { const c = controllerRef.current; if (c) c.enabled = mode === 'listening' && autoStop; }, [mode, autoStop, ready]);

  // ---- rendering the chapter ------------------------------------------------------------------
  /** the chapter phrase job's hits of a sentence, in the shape annotateSentence takes */
  function phraseHitsOf(key: string): PhraseHit[] {
    const ch = Number(key.split('.')[0]);
    return (phrasesRef.current.get(ch)?.[key] ?? []).map((h) => ({ sentenceKey: key, start: h.start, end: h.end, text: h.text, lemma: h.lemma, level: h.level as CefrLevel, zh: h.zh ?? '' }));
  }
  const renderOpts = useCallback(() => ({ dict: dict!, names, learner: settingsRef.current.learnerLevel as CefrLevel, vocab: vocabRef.current.words, marked: markedRef.current, hints: settingsRef.current.appearance.showHints !== false, hintOverrides, phrases: phraseHitsOf }), [dict, names, hintOverrides]);

  const html = useMemo(() => {
    if (!dict) return '';
    const ch = book.chapters[chapter];
    if (!ch) return '';
    const { html, meta } = renderChapter(ch, renderOpts());
    metaRef.current = meta;
    // the small chapter label is for chapters whose text does not start with its own heading
    const label = ch.paragraphs[0]?.kind.startsWith('h') ? '' : `<div class="chapter-title">${ch.title.replace(/</g, '&lt;')}</div>`;
    return `<div class="doc-inner">${label}${html}</div>`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dict, chapter, book, renderOpts, settings.learnerLevel, settings.appearance.showHints, vocab.marked, phrasesVersion]);
  useEffect(() => { markedRef.current = vocab.marked[book.id] ?? []; }, [vocab.marked, book.id]);

  /** the screen injected the chapter: put the highlight back and bring the sentence into view */
  const onRendered = useCallback(() => {
    highlightSentence(posRef.current);
    requestAnimationFrame(() => ensureRef.current(posRef.current, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- highlighting -------------------------------------------------------------------------------
  function highlightSentence(pos: Position): void {
    const root = docRef.current; if (!root) return;
    root.querySelectorAll('.s.cur').forEach((e) => e.classList.remove('cur'));
    root.querySelectorAll('.s.past').forEach((e) => e.classList.remove('past'));
    const el = root.querySelector(`.s[data-key="${keyOf(pos)}"]`);
    el?.classList.add('cur');
    if (modeRef.current === 'listening' && el) {
      // lines before the current one are dimmed more than the ones to come
      for (const s of root.querySelectorAll('.s')) { if (s === el) break; s.classList.add('past'); }
    }
    clearWord();
    ensureRef.current(pos);
  }
  function clearWord(): void { for (const el of currentWordRef.current) el.classList.remove('cur-w'); currentWordRef.current = []; }
  function highlightWord(pos: Position, tokenIndex: number): void {
    clearWord();
    const el = docRef.current?.querySelector<HTMLElement>(`.s[data-key="${keyOf(pos)}"] .w[data-t="${tokenIndex}"]`);
    if (el) { el.classList.add('cur-w'); currentWordRef.current.push(el); }
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
    // keep the My Vocabulary entry (if the word has one) in step: known words are saved as known
    if (status === 'known' || status === 'learning') void window.readalong.vocabSetEntryStatus(lemma, status).catch(() => undefined);
    const hint = !status && dict && settingsRef.current.appearance.showHints !== false ? (hintsRef.current?.[lemma]?.[0] || hintText(dict.lookup(lemma)?.entry.zh ?? '')) : undefined;
    if (docRef.current) restyleLemma(docRef.current, lemma, status, settingsRef.current.learnerLevel, hint);
    if (toast && status === 'known') showToast(`“${lemma}” marked known`, { label: 'Undo', run: () => void changeStatus(lemma, prev ?? null, false) });
  }

  async function setMarked(ranges: MarkedRange[]): Promise<void> {
    markedRef.current = ranges;
    useApp.getState().setVocab({ ...vocabRef.current, marked: { ...vocabRef.current.marked, [book.id]: ranges } });
    await window.readalong.setMarkedRanges(book.id, ranges);
  }

  // ---- the word card ------------------------------------------------------------------------------
  function metaFor(pos: Position, tokenIndex: number): TokenMeta | null {
    const list = metaRef.current.get(keyOf(pos));
    if (list) return list[tokenIndex] ?? null;
    const cur = getSentence(book, pos);
    if (!cur || !dict) return null;
    renderSentence(cur.para, cur.sentence, pos.chapter, renderOpts(), metaRef.current);
    return metaRef.current.get(keyOf(pos))?.[tokenIndex] ?? null;
  }
  function posOf(el: Element): Position | null {
    const s = el.closest<HTMLElement>('.s'); if (!s?.dataset.key) return null;
    const [c, p, sIdx] = s.dataset.key.split('.').map(Number);
    return { chapter: c, paragraph: p, sentence: sIdx };
  }
  function cancelCardClose(): void { if (cardCloseTimer.current) { clearTimeout(cardCloseTimer.current); cardCloseTimer.current = null; } }
  function closeCard(): void { cancelCardClose(); setCard(null); }
  /** Builds the card for a word span (anchored under it) without starting anything. */
  function cardFor(wordEl: HTMLElement): Card | null {
    const pos = posOf(wordEl); if (!pos) return null;
    const ti = Number(wordEl.dataset.t);
    const meta = metaFor(pos, ti); if (!meta) return null;
    const container = rootRef.current!.getBoundingClientRect();
    const r = wordEl.getBoundingClientRect();
    const above = container.bottom - r.bottom < (modeRef.current === 'listening' ? 300 : 230);
    const pair = hintsRef.current?.[meta.lemma];
    return { word: wordEl.firstChild?.textContent ?? wordEl.textContent ?? '', lemma: meta.lemma, ipa: meta.ipa, zh: meta.zh, here: pair?.[0] || undefined, other: pair?.[1] || undefined, level: meta.level, isName: meta.isName, status: vocabRef.current.words[meta.lemma], x: r.left - container.left + r.width / 2, y: (above ? r.top : r.bottom) - container.top, above, explain: { status: 'idle', text: '' }, pos, tokenIndex: ti, entryId: null };
  }
  /** A tap on a word: the card opens and the explanation starts at once (Reading mode: the audio stays paused after). */
  function tapWord(wordEl: HTMLElement, explain = true): void {
    const c = cardFor(wordEl); if (!c) return;
    cancelCardClose();
    setCard(c); setSelBar(null);
    if (!explain) return;
    const d = c.zh || c.ipa ? { ipa: c.ipa, zh: c.zh.split('\n')[0], level: c.level ?? undefined } : null;
    void ctl()?.explainNow('word', c.word, c.pos, d, c.isName ? undefined : c.lemma);
  }
  /** Keeps the card in step with the explanation it belongs to; opens one when listening stopped on a hard word. */
  /** Opens the dictionary card under a word or phrase of the current sentence (Listening stops). */
  function anchorCard(kind: string, target: string): Card | null {
    if (!docRef.current) return null;
    const cur = docRef.current.querySelector(`.s[data-key="${keyOf(posRef.current)}"]`) ?? docRef.current.querySelector('.s.cur');
    const spans = Array.from(cur?.querySelectorAll<HTMLElement>(kind === 'word' ? '.w[data-lemma]' : '.ph, [data-phrase]') ?? []);
    const el = spans.find((w) => (w.firstChild?.textContent ?? w.textContent ?? '').trim() === target) ?? spans.find((w) => (w.textContent ?? '').trim().toLowerCase() === target.toLowerCase());
    const wordEl = el?.classList.contains('w') ? el : el?.querySelector<HTMLElement>('.w') ?? null;
    if (!wordEl) return null;
    return cardFor(wordEl);
  }

  function followEntry(entry: TranscriptEntry): void {
    let c = cardRef.current;
    const isWordish = entry.kind === 'word' || entry.kind === 'phrase';
    if (!c && isWordish && entry.status === 'thinking') {
      // an automatic stop (or an explanation started from elsewhere): anchor a card to the word in the current sentence
      c = anchorCard(entry.kind, entry.target); if (!c) return;
      cancelCardClose();
    }
    if (!c) return;
    if (c.entryId === null) {
      if (!(isWordish && entry.status === 'thinking' && entry.target.toLowerCase() === c.word.toLowerCase())) return;
      cancelCardClose();
    } else if (c.entryId !== entry.id) {
      // a newer explanation of the same word ("I don't know") takes over the card
      if (!(isWordish && entry.status === 'thinking' && entry.target.toLowerCase() === c.word.toLowerCase())) return;
      cancelCardClose();
    }
    const next: Card = { ...c, entryId: entry.id, explain: { status: entry.status, text: entry.parts?.free ?? entry.text, error: entry.error } };
    setCard(next);
    if (entry.status === 'done' || entry.status === 'skipped' || entry.status === 'error') {
      cancelCardClose();
      cardCloseTimer.current = setTimeout(() => { if (cardRef.current?.entryId === entry.id) setCard(null); cardCloseTimer.current = null; }, CARD_LINGER_MS);
    }
  }
  useEffect(() => () => cancelCardClose(), []);

  /** A tap on a sentence (not on a word): the reading moves there. */
  function tapSentence(el: Element): boolean {
    const pos = posOf(el); if (!pos) return false;
    closeCard(); setSelBar(null);
    seek(pos);
    return true;
  }
  const onDoubleClick = (e: React.MouseEvent) => {
    const w = (e.target as HTMLElement).closest<HTMLElement>('.w');
    if (w?.dataset.lemma && !w.classList.contains('name')) { e.preventDefault(); window.getSelection()?.removeAllRanges(); closeCard(); setSelBar(null); ctl()?.markKnown(w.dataset.lemma); void changeStatus(w.dataset.lemma, 'known'); }
  };
  const onMouseUp = () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const root = docRef.current;
      if (!sel || sel.isCollapsed || !root || !sel.anchorNode || !root.contains(sel.anchorNode)) { setSelBar(null); return; }
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 2000) { setSelBar(null); return; }
      const a = (sel.anchorNode.parentElement)?.closest('.s'), f = (sel.focusNode?.parentElement)?.closest('.s');
      const posA = a ? posOf(a) : null, posF = f ? posOf(f) : null;
      const rect = sel.getRangeAt(0).getBoundingClientRect(); const c = rootRef.current!.getBoundingClientRect();
      const words = text.split(/\s+/).length;
      let kind: SelBar['kind'] = 'phrase';
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
          p = nextPosition(book, p);
          if (ranges.length > 40) break;
        }
      }
      if (words === 1) return; // a single word: the tap already opened its card
      setSelBar({ x: rect.left - c.left + rect.width / 2, y: rect.top - c.top, text, kind, ranges, pos: posA ?? posRef.current });
      closeCard();
    }, 0);
  };

  // ---- actions ------------------------------------------------------------------------------------
  const pb = () => playbackRef.current;
  const ctl = () => controllerRef.current;
  /** navigation always interrupts a running explanation first */
  const nav = (fn: (p: Playback) => void) => { const p = pb(); if (!p) return; ctl()?.skip(); fn(p); };
  const seek = (pos: Position) => { posRef.current = pos; setPosition(pos); setChapter(pos.chapter); nav((p) => p.seek(pos)); if (pb()?.state === 'idle') { highlightSentence(pos); scheduleSave(pos); } };
  const playPause = () => {
    const p = pb(); if (!p) return;
    if (ctl()?.busy) { ctl()!.skip(); return; }
    if (p.state === 'playing' || p.state === 'explaining') p.pause(); else p.play(p.state === 'idle' ? posRef.current : undefined);
  };
  const switchMode = () => { closeCard(); setSelBar(null); setPopover(null); useApp.getState().setMode(modeRef.current === 'reading' ? 'listening' : 'reading'); };
  const explainSentenceAt = (pos: Position) => { const cur = getSentence(book, pos); if (cur) void ctl()?.explainNow('sentence', cur.text, pos, null, undefined, undefined, true); };
  const explainCurrentSentence = () => { const cur = getSentence(book, posRef.current); if (cur) void ctl()?.explainNow('sentence', cur.text, posRef.current, null); };
  const explainLast = () => void ctl()?.explainLast(settingsRef.current.listen.lastSecondsWindow);
  /** "I don't know": the last explanation again, deeper; else the first hard word of the sentence, else the sentence. */
  const dontKnow = () => {
    const c = ctl(); if (!c) return;
    const open = cardRef.current;
    if (open) { void changeStatus(open.lemma, 'learning', false); if (!c.busy) void c.explainAgain(); return; }
    const hard = docRef.current?.querySelector<HTMLElement>(`.s[data-key="${keyOf(posRef.current)}"] .w.hl-unknown, .s[data-key="${keyOf(posRef.current)}"] .w.hl-learning`);
    if (hard) tapWord(hard); else if (!c.busy && transcript.length && transcript[transcript.length - 1].status !== 'thinking') void c.explainAgain(); else explainCurrentSentence();
  };
  const sayCard = () => { const c = cardRef.current; if (!c) return; ctl()?.skip(); const e = getEngine(readEngineId()); e.cancelAll(); e.speak(c.word, { voiceId: readVoiceId(), rate: 0.8 }); };
  const markSentence = (pos: Position) => { const cur = getSentence(book, pos); if (!cur) return; const r: MarkedRange = { ...pos, start: cur.sentence.start, end: cur.sentence.end, text: cur.text }; const exists = markedRef.current.some((m) => keyOf(m) === keyOf(pos) && m.start === r.start && m.end === r.end); void setMarked(exists ? markedRef.current.filter((m) => !(keyOf(m) === keyOf(pos) && m.start === r.start && m.end === r.end)) : [...markedRef.current, r]); showToast(exists ? 'Sentence unmarked' : 'Sentence marked: it will be explained in Listening mode'); };
  const setRate = (r: number) => { void useApp.getState().patchSettings({ voice: { ...settingsRef.current.voice, rate: clampRate(r) } }).then(() => pb()?.rateChanged()); };
  const seekSeconds = (delta: number) => {
    const w = wordsPerMinute(modeRef.current, settingsRef.current.voice.rate, true);
    const target = positionAtTime(index, timeAt(index, posRef.current, w) + delta, w);
    if (target) seek(target);
  };
  const goToChapter = (i: number) => { const ch = book.chapters[i]; if (!ch) return; const p = { chapter: i, paragraph: 0, sentence: 0 }; const real = getSentence(book, p) ? p : nextPosition(book, { ...p, sentence: -1 }) ?? p; seek(real); };
  const jumpHard = (dir: 1 | -1) => {
    const all = Array.from(docRef.current?.querySelectorAll<HTMLElement>('.w.hl-unknown, .ph.hl-unknown') ?? []);
    if (!all.length) return;
    const curEl = docRef.current?.querySelector(`.s[data-key="${keyOf(posRef.current)}"]`);
    let idx = dir === 1 ? all.findIndex((el) => curEl ? (curEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !curEl.contains(el) : true) : all.length - 1;
    if (dir === -1) { const rev = [...all].reverse(); idx = all.length - 1 - rev.findIndex((el) => curEl ? (curEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0 : true); }
    const el = all[idx] ?? all[0];
    const w = el.classList.contains('w') ? el : el.querySelector<HTMLElement>('.w');
    const pos = posOf(el);
    if (pos) seek(pos);
    if (w) tapWord(w);
  };
  /** "I know" (voice, K during a window, the button): known for good; a stop ends without (more) explanation. */
  function answerKnow(): void {
    const c = ctl(); if (!c) return;
    const l = c.lastExplained;
    // the window first: markKnown() of the stop's word would end its window as "I know" by itself
    const inWindow = c.answerWindow('know');
    if (l?.lemma) { c.markKnown(l.lemma); void changeStatus(l.lemma, 'known'); if (cardRef.current?.lemma === l.lemma) closeCard(); }
    if (!inWindow) c.continueNow();
  }
  /** "I don't know" (voice, D during a window, the button): before the explanation it simply starts; after it, again and deeper. */
  function answerDontKnow(): void {
    const c = ctl(); if (!c) return;
    if (c.answerWindow('dont_know')) return;
    const l = c.lastExplained;
    if (l?.lemma) void changeStatus(l.lemma, 'learning', false);
    void c.explainAgain();
  }
  /** "Go on" (Esc during a window, the button, "bye bye"): no (more) explanation; Listening re-reads the sentence and goes on. */
  function answerGoOn(): void {
    const c = ctl(); if (!c) return;
    if (!c.answerWindow('bye')) c.continueNow();
  }
  const cardStatus = (s: WordStatus) => { const c = cardRef.current; if (!c) return; if (s === 'known') ctl()?.markKnown(c.lemma); void changeStatus(c.lemma, c.status === s ? null : s); closeCard(); };

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (help) { if (e.code === 'Escape' || matchesShortcut(e, settingsRef.current.shortcuts.help)) { e.preventDefault(); setHelp(false); } return; }
      const sc = settingsRef.current.shortcuts;
      const is = (name: string) => matchesShortcut(e, sc[name]);
      const listening = modeRef.current === 'listening';
      // during a commands window K / D / Esc answer it (before the card and popup meanings of those keys)
      if (cmdWinRef.current && (is('markKnown') || is('dontKnow') || is('closePopup'))) {
        e.preventDefault();
        if (is('markKnown')) answerKnow();
        else if (is('dontKnow')) answerDontKnow();
        else { setSelBar(null); answerGoOn(); }
        return;
      }
      if (matchesShortcut(e, settingsRef.current.voiceChat?.pushToTalkKey || 'KeyM')) { e.preventDefault(); voiceRef.current?.toggle(); }
      else if (is('help')) { e.preventDefault(); setHelp(true); }
      else if (is('switchMode')) { e.preventDefault(); switchMode(); }
      else if (is('playPause')) { e.preventDefault(); playPause(); }
      else if (is('closePopup')) { if (cardRef.current) closeCard(); else if (selBar) setSelBar(null); else if (popover) setPopover(null); else ctl()?.skip(); }
      else if (listening && matchesShortcut(e, LISTEN_KEYS._listenBack)) { e.preventDefault(); seekSeconds(-30); }
      else if (listening && matchesShortcut(e, LISTEN_KEYS._listenFwd)) { e.preventDefault(); seekSeconds(30); }
      else if (listening && matchesShortcut(e, LISTEN_KEYS._listenUp)) { e.preventDefault(); const p = prevPosition(book, posRef.current); if (p) explainSentenceAt(p); }
      else if (listening && matchesShortcut(e, LISTEN_KEYS._listenDown)) { e.preventDefault(); const p = nextPosition(book, posRef.current); if (p) explainSentenceAt(p); }
      else if (is('nextSentence')) { e.preventDefault(); nav((p) => p.next()); }
      else if (is('prevSentence')) { e.preventDefault(); nav((p) => p.prev()); }
      else if (is('nextParagraph')) nav((p) => p.nextParagraph());
      else if (is('prevParagraph')) nav((p) => p.prevParagraph());
      else if (is('nextPage') || is('prevPage')) { e.preventDefault(); window.dispatchEvent(new CustomEvent('reader:page', { detail: is('nextPage') ? 1 : -1 })); }
      else if (is('replaySentence')) nav((p) => p.replay());
      else if (is('explainLast')) { e.preventDefault(); explainLast(); }
      else if (is('dontKnow')) { e.preventDefault(); dontKnow(); }
      else if (is('explain')) { e.preventDefault(); if (cardRef.current) { if (!ctl()?.busy) void ctl()?.explainAgain(); } else if (selBar) { void ctl()?.explainNow(selBar.kind, selBar.text, selBar.pos, null); setSelBar(null); } else explainCurrentSentence(); }
      else if (is('markKnown')) { if (cardRef.current) cardStatus('known'); }
      else if (is('markLearning')) { if (cardRef.current) cardStatus('learning'); }
      else if (is('ignore')) { if (cardRef.current) cardStatus('ignored'); }
      else if (is('toggleListen')) { if (listening) { setAutoStop((v) => { showToast(v ? 'Pause at hard words: off.' : 'Pause at hard words: on.'); return !v; }); } }
      else if (is('toggleHints')) void useApp.getState().patchSettings({ appearance: { ...settingsRef.current.appearance, showHints: settingsRef.current.appearance.showHints === false } });
      else if (is('goTo')) { if (!listening) setPopover((p) => (p === 'goto' ? null : 'goto')); }
      else if (is('sayWord')) sayCard();
      else if (is('speedUp')) setRate(settingsRef.current.voice.rate + 0.1);
      else if (is('speedDown')) setRate(settingsRef.current.voice.rate - 0.1);
      else if (is('speedReset')) setRate(1);
      else if (is('nextHard')) { e.preventDefault(); jumpHard(1); }
      else if (is('prevHard')) { e.preventDefault(); jumpHard(-1); }
      else if (is('markPhrase')) { if (selBar) { void setMarked([...markedRef.current, ...selBar.ranges]); setSelBar(null); } else markSentence(cardRef.current?.pos ?? posRef.current); }
      else return;
    };
    window.addEventListener('keydown', onKey);
    const onMenu = (ev: Event) => { const a = (ev as CustomEvent).detail; if (a === 'playPause') playPause(); };
    window.addEventListener('readalong:menu', onMenu);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('readalong:menu', onMenu); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selBar, help, popover, transcript]);

  if (!dict) return <div className="reader loading"><div className="empty">Loading dictionary…</div></div>;

  const shared: ScreenShared = {
    book, index, chapter, position, playState, html, docRef, ensureRef, onRendered,
    tapWord: (el) => tapWord(el), tapSentence, onDoubleClick, onMouseUp, posOf,
    closeOverlays: () => { const had = !!cardRef.current || !!selBar; closeCard(); setSelBar(null); return had; },
    playPause, prev: () => nav((p) => p.prev()), next: () => nav((p) => p.next()), seek, goToChapter, setRate, switchMode,
    explainLast, dontKnow, explainSentenceAt, seekSeconds, openHelp: () => setHelp(true), wpm, busy,
  };

  return (
    <div className={`reader mode-${mode}${voicePop ? ' voice-open' : ''}`} data-testid="reader" data-mode={mode} ref={rootRef} onClick={() => { if (cardRef.current) closeCard(); if (selBar) setSelBar(null); }}>
      {mode === 'reading' ? (
        <ReadingScreen shared={shared} settings={settings} popover={popover} setPopover={setPopover} />
      ) : (
        <ListeningScreen shared={shared} settings={settings} voices={voices} autoStop={autoStop} onAutoStop={() => setAutoStop((v) => !v)} transcriptOpen={transcriptOpen} onTranscript={() => setTranscriptOpen((v) => !v)}
          waiting={waiting} onContinue={() => ctl()?.continueNow()}
          onVoice={(engine, voiceId) => void useApp.getState().patchSettings({ voice: { ...settingsRef.current.voice, engine, voiceId } })}
          onWindow={(w) => void useApp.getState().patchSettings({ listen: { ...settingsRef.current.listen, lastSecondsWindow: w } })}
          transcript={transcriptOpen ? <Transcript entries={transcript} onSkip={() => ctl()?.skip()} onClose={() => setTranscriptOpen(false)} onAsk={(q) => { if (voiceRef.current) { voiceRef.current.askTyped(q); return; } const cur = getSentence(book, posRef.current); void ctl()?.explainNow('question', cur?.text ?? '', posRef.current, null, undefined, q); }} /> : null} />
      )}
      {card && (
        <WordCard data={card} onClose={closeCard} onSay={sayCard}
          onKnown={() => cardStatus('known')} onIgnore={() => cardStatus('ignored')}
          chineseOn={settings.ai.speakChinese} onToggleChinese={() => void useApp.getState().patchSettings({ ai: { ...settingsRef.current.ai, speakChinese: !settingsRef.current.ai.speakChinese } })}
          onDontKnow={() => { const c = cardRef.current; if (!c) return; void changeStatus(c.lemma, 'learning', false); setCard({ ...c, status: 'learning' }); if (!ctl()?.busy) void ctl()?.explainAgain(); }} />
      )}
      {selBar && (
        <div className="selection-bar" style={{ left: Math.max(8, selBar.x - 110), top: Math.max(4, selBar.y - 44) }} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} data-testid="selection-bar">
          <button className="primary" onClick={() => { void ctl()?.explainNow(selBar.kind, selBar.text, selBar.pos, null); setSelBar(null); window.getSelection()?.removeAllRanges(); }}>Explain</button>
          {selBar.kind !== 'word' && <Tip text="Explain it when listening reaches it"><button onClick={() => { void setMarked([...markedRef.current, ...selBar.ranges]); setSelBar(null); window.getSelection()?.removeAllRanges(); showToast('Marked: it will be explained in Listening mode'); }}>Mark</button></Tip>}
          <button className="quiet" onClick={() => { void navigator.clipboard.writeText(selBar.text); setSelBar(null); }}>Copy</button>
        </div>
      )}
      {voiceSnap && (
        <VoiceChatUI snap={voiceSnap} last={voiceLast} popover={voicePop} onPopover={setVoicePop}
          onToggle={() => voiceRef.current?.toggle()} onAlwaysOn={setAlwaysOn} onAsk={(t) => voiceRef.current?.askTyped(t)}
          onAcceptDownload={() => voiceRef.current?.acceptDownload()} onDeclineDownload={() => voiceRef.current?.declineDownload()} onDismissError={() => voiceRef.current?.dismissError()}
          keyLabel={shortcutLabel(settings.voiceChat?.pushToTalkKey || 'KeyM')} shifted={mode === 'listening' && transcriptOpen} />
      )}
      {cmdWin && (
        <div className={`command-bar in-${mode}`} data-testid="command-bar" data-phase={cmdWin.phase} role="group" aria-label="Your answer" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <div className="command-buttons">
            <button className="cmd know" data-testid="cmd-know" onClick={answerKnow}>I know <kbd>{shortcutLabel(settings.shortcuts.markKnown || 'KeyK')}</kbd></button>
            <button className="cmd dont-know" data-testid="cmd-dont-know" onClick={answerDontKnow}>I don’t know <kbd>{shortcutLabel(settings.shortcuts.dontKnow || 'KeyD')}</kbd></button>
            <button className="cmd go-on" data-testid="cmd-go-on" onClick={answerGoOn}>Go on <kbd>{shortcutLabel(settings.shortcuts.closePopup || 'Escape')}</kbd></button>
          </div>
          <div className="command-countdown" aria-hidden="true"><span key={cmdWin.id} style={{ animationDuration: `${cmdWin.ms}ms` }} /></div>
        </div>
      )}
      {help && <HelpSheet shortcuts={{ ...settings.shortcuts, pushToTalk: settings.voiceChat?.pushToTalkKey || 'KeyM' }} mode={mode} onClose={() => setHelp(false)} />}
      {!ready && <div className="reader-preparing">Preparing…</div>}
    </div>
  );
}
