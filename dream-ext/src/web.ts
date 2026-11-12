/**
 * The tutor on any web page, in the browser of the iPhone / iPad app (wish 29). The app puts this file into a page
 * ONLY while Explanation mode is on, and only into its own private script world (WKContentWorld): the page's own
 * JavaScript cannot see it, the bridge, the storage or the keys. It runs in the main frame only.
 *
 * Mode ON:  a tap on a word = its card (word, pronunciation, Chinese) and, with My tutor on, the explanation aloud
 *           (its meaning in THIS sentence); a double tap on a word, or a finished selection of several words = the
 *           sentence; a tap on a link does not follow it: a small "Open link" bubble (4 s) does; the hard words in
 *           view are marked (CSS Custom Highlight API: nothing of the page's DOM is changed); "Explain" / "hello" =
 *           what is on the screen now, in ONE request; "stop" / a second tap on Explain = quiet at once.
 * Mode OFF: nothing at all (a normal browser).
 *
 * COST: one request per tap / double tap / selection / Explain. Nothing is asked when a page loads or scrolls: the
 * marks come from the built-in dictionary. Free mode (My tutor off): never the AI; the card shows the dictionary, the
 * device says the word once, a sentence is translated on the device.
 * SAFETY: only real touches count (event.isTrusted); the card and the bubble live in a closed shadow root; the page's
 * text goes to the AI as quoted content with the line that it is never an instruction; nothing of the vocabulary,
 * the settings or the keys is written into the page.
 */
import './web-flag';
import { installWebBackground } from './web-bg';
import type { Dictionary } from '@core/dict/types';
import type { Settings, VocabState, WordStatus } from '@shared/settings';
import { getDictionary, getZipf } from './ai-client';
import * as store from './store';
import { WordCard } from './word-card';
import { TutorSay } from './tutor-say';
import { markOf, cardOf } from './word-level';
import { myLevelOf, levelToCefr } from './level100';
import { markLearning, markKnown, saveExplained } from './word-save';
import { appPost, inApp, nativeTranslate } from './native-bridge';
import { wordAt, wordsIn, sentenceAt, visibleText, tapDecision, articleText, screenPrompt, voiceCommand, type ScreenBlock, type PageBlock } from './web-text';
import type { RuleRequest } from './level-rule';
import type { TeachLength } from './teacher-text';

interface Hit { word: string; sentence: string; before: string; after: string; x: number; y: number }
interface WebApi {
  setMode(on: boolean): void;
  explainScreen(): void;
  stop(): void;
  heard(ev: { type?: string; text?: string; final?: boolean }): void;
  article(): { title: string; text: string } | null;
  state(): { mode: boolean; busy: boolean };
}
type HighlightCtor = new (...ranges: Range[]) => unknown;
type Registry = { set(name: string, h: unknown): void; delete(name: string): void };

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'CODE', 'PRE', 'KBD', 'SAMP', 'SVG', 'MATH', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'TEMPLATE', 'OBJECT']);
const BLOCK = new Set(['P', 'LI', 'DIV', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'ARTICLE', 'SECTION', 'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'MAIN', 'BODY', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'SUMMARY', 'DETAILS', 'FORM', 'UL', 'OL', 'TABLE', 'TR']);
/** what must keep working as the site made it: a tap there is the site's, not the tutor's */
const CONTROL = 'button, input, textarea, select, option, label, summary, video, audio, [contenteditable=""], [contenteditable="true"], [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="slider"], [role="textbox"], [role="combobox"], [role="option"]';
/** the parts of a page that are not what it says (for "what is on the screen" and the article) */
const CHROME = 'nav, aside, footer, form, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-hidden="true"], [hidden]';
const HARD = 'iknow-hard', LEARNING = 'iknow-learning';
const MARK_CSS = `::highlight(${HARD}){text-decoration:underline;text-decoration-style:dotted;text-decoration-color:#1a73e8;text-decoration-thickness:2px;text-underline-offset:.2em;background-color:rgba(26,115,232,.10)}
::highlight(${LEARNING}){text-decoration:underline;text-decoration-color:#c98a00;text-decoration-thickness:2px;text-underline-offset:.2em;background-color:rgba(255,214,102,.42)}`;

const pageTitle = (): string => (document.title || location.hostname || 'Web page').replace(/\s+/g, ' ').trim().slice(0, 160);

class WebTutor {
  private mode = false;
  private loaded: Promise<void> | null = null;
  private ready = false;
  private dict: Dictionary | null = null;
  private zipf: (w: string) => number | null = () => null;
  private vocab: VocabState = { words: {}, marked: {} };
  private extras: store.YtExtras = store.DEFAULT_EXTRAS;
  private settings: Settings | null = null;
  private card: WordCard | null = null;
  private cardFor: { lemma: string; word: string; zh: string; hit: Hit | null } | null = null;
  // (the tutor's cloud voice is played by the app itself: a website's own rules cannot silence it)
  private say = new TutorSay((busy) => { void appPost({ kind: 'webState', busy }); this.debug(); }, inApp());
  private pending: { at: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private lastDouble = 0;
  /** the bubble follows a link: the click made here is the site's own */
  private pass = false;
  private lastTouch = 0;
  private down: { x: number; y: number; at: number; id: number } | null = null;
  private lastTap = { at: 0, x: 0, y: 0, prevent: false };
  private lastSelection = '';
  private lastSelectionAt = 0;
  private selTimer: ReturnType<typeof setTimeout> | null = null;
  private markTimer: ReturnType<typeof setTimeout> | null = null;
  private sheet: CSSStyleSheet | null = null;
  private styleEl: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private counts = { hard: 0, learning: 0 };
  /** requests made to the AI by this page (the tests read it) */
  private asked = 0;

  readonly api: WebApi = {
    setMode: (on) => this.setMode(!!on),
    explainScreen: () => void this.explainScreen(),
    stop: () => this.stop(),
    heard: (ev) => this.heard(ev),
    article: () => this.article(),
    state: () => ({ mode: this.mode, busy: this.say.busy }),
  };

  private free(): boolean { return this.extras.tutorOn === false; }
  private level(): string { return levelToCefr(myLevelOf(this.extras, this.settings?.learnerLevel)); }
  private length(): TeachLength { const l = this.settings?.ai.explanationLength as string | undefined; return l === 'short' || l === 'long' ? l : 'normal'; }

  private debug(): void {
    if (!this.extras.fakeVoice) return;
    const r = this.card?.rects() ?? { card: null, bubble: null };
    document.documentElement.dataset.iknowWeb = JSON.stringify({ mode: this.mode, ready: this.ready, busy: this.say.busy, card: this.card?.current ?? null, cardRect: r.card, bubbleRect: r.bubble, buttonRect: this.card?.buttonRect() ?? null, spoken: this.say.spoken.slice(-30), marks: this.counts, asked: this.asked, free: this.free() });
  }

  // ---- on / off ------------------------------------------------------------------------------------------------
  setMode(on: boolean): void {
    if (on === this.mode) return;
    this.mode = on;
    this.listen(on);
    if (on) void this.load().then(() => { this.remark(); this.debug(); });
    else {
      this.say.stop();
      if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
      this.card?.remove();
      this.card = null;
      this.cardFor = null;
      this.clearMarks();
      if (this.extras.fakeVoice) delete document.documentElement.dataset.iknowWeb;
    }
    this.debug();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      [this.extras, this.settings, this.vocab] = await Promise.all([store.getExtras(), store.getSettings(), store.getVocab()]);
      await this.say.prepare(this.free());
      try { [this.dict, this.zipf] = await Promise.all([getDictionary(), getZipf()]); } catch { this.dict = null; }
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== 'local') return;
        if (ch[store.STORAGE_KEYS.vocab]) { this.vocab = { words: { ...((ch[store.STORAGE_KEYS.vocab].newValue as VocabState | undefined)?.words ?? {}) as Record<string, WordStatus> }, marked: {} }; this.remarkSoon(); }
        if (ch[store.STORAGE_KEYS.extras]) { this.extras = { ...store.DEFAULT_EXTRAS, ...(ch[store.STORAGE_KEYS.extras].newValue as Partial<store.YtExtras> | undefined) }; void this.say.prepare(this.free()); this.card?.setLook({ sizePx: this.extras.phoneSizePx ?? 21, look: 'auto' }); this.remarkSoon(); }
        if (ch[store.STORAGE_KEYS.settings]) this.settings = store.mergeSettings(ch[store.STORAGE_KEYS.settings].newValue as Partial<Settings>);
        if (ch[store.STORAGE_KEYS.keys]) void this.say.prepare(this.free());
      });
      this.ready = true;
    })();
    return this.loaded;
  }

  private listen(on: boolean): void {
    const f = on ? 'addEventListener' : 'removeEventListener';
    // a tap is a finger (or the mouse) going down and up at the same place: an iPhone sends no "click" for a tap on
    // plain text, only for links and buttons, so the taps are taken from the pointer events
    document[f]('pointerdown', this.onDown as EventListener, { capture: true, passive: true } as AddEventListenerOptions);
    document[f]('pointerup', this.onUp as EventListener, { capture: true, passive: true } as AddEventListenerOptions);
    document[f]('pointercancel', this.onCancel, { capture: true, passive: true } as AddEventListenerOptions);
    document[f]('click', this.onClick as EventListener, true);
    document[f]('dblclick', this.onDouble as EventListener, true);
    document[f]('selectionchange', this.onSelection);
    window[f]('scroll', this.onScroll, { capture: true, passive: true } as AddEventListenerOptions);
    window[f]('resize', this.onScroll);
    this.observer?.disconnect();
    this.observer = null;
    if (on && document.body && typeof MutationObserver === 'function') {
      // (a page that loads more text by itself: the marks follow, slowly)
      let wait: ReturnType<typeof setTimeout> | null = null;
      this.observer = new MutationObserver(() => { if (wait) return; wait = setTimeout(() => { wait = null; if (this.mode) this.remarkSoon(); }, 1500); });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  private onDown = (e: PointerEvent): void => {
    if (!e.isTrusted) return;
    this.lastTouch = Date.now();
    // (a second finger: a pinch, not a tap)
    this.down = e.isPrimary && (e.pointerType !== 'mouse' || e.button === 0) ? { x: e.clientX, y: e.clientY, at: Date.now(), id: e.pointerId } : null;
  };
  private onUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!this.mode || !e.isTrusted || !d || d.id !== e.pointerId) return;
    if (Date.now() - d.at > 600 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;   // a long press, a scroll
    this.tapAt(e.clientX, e.clientY);
  };
  private onCancel = (): void => { this.down = null; };
  private onScroll = (): void => { this.card?.hideBubble(); this.remarkSoon(); };

  // ---- the word under a finger ---------------------------------------------------------------------------------
  private caret(x: number, y: number): { node: Node; offset: number } | null {
    const d = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null; caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null };
    try {
      if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(x, y); if (r) return { node: r.startContainer, offset: r.startOffset }; }
      if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); if (p) return { node: p.offsetNode, offset: p.offset }; }
    } catch { /* not here */ }
    return null;
  }

  private inRects(range: Range, x: number, y: number): boolean {
    for (const q of Array.from(range.getClientRects())) if (x >= q.left - 3 && x <= q.right + 3 && y >= q.top - 3 && y <= q.bottom + 3) return true;
    return false;
  }

  /** the word in this text node under the point, when the finger is really on it */
  private wordIn(node: Text, offset: number, x: number, y: number): { start: number; end: number; word: string } | null {
    const w = wordAt(node.data, offset);
    if (!w || w.word.length < 2) return null;
    const r = document.createRange();
    r.setStart(node, w.start);
    r.setEnd(node, w.end);
    return this.inRects(r, x, y) ? w : null;
  }

  private hitAt(x: number, y: number): Hit | null {
    let node: Text | null = null;
    let w: { start: number; end: number; word: string } | null = null;
    const c = this.caret(x, y);
    if (c && c.node.nodeType === Node.TEXT_NODE) { node = c.node as Text; w = this.wordIn(node, c.offset, x, y); }
    if (!w) {
      // (text that cannot be selected gives no caret: look through the words of the element under the finger)
      const el = document.elementFromPoint(x, y);
      if (!el || el === this.card?.host) return null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode() as Text | null; n && seen < 4000 && !w; n = walker.nextNode() as Text | null) {
        seen += n.data.length;
        const box = document.createRange();
        box.selectNodeContents(n);
        if (!this.inRects(box, x, y)) continue;
        for (const cand of wordsIn(n.data)) {
          const r = document.createRange();
          r.setStart(n, cand.start); r.setEnd(n, cand.end);
          if (cand.word.length >= 2 && this.inRects(r, x, y)) { node = n; w = cand; break; }
        }
      }
    }
    if (!node || !w) return null;
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, textarea, input, select, [contenteditable=""], [contenteditable="true"]')) return null;
    // the sentence: in the text of the paragraph (the nearest block) around the word
    let block: Element = parent;
    while (block.parentElement && !BLOCK.has(block.tagName)) block = block.parentElement;
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(node, w.start);
    let at = pre.toString().length;
    let text = block.textContent ?? node.data;
    if (text.length > 6000) { const from = Math.max(0, at - 3000); text = text.slice(from, at + 3000); at -= from; }
    const s = sentenceAt(text, at + 1);
    return { word: w.word, sentence: s.sentence || w.word, before: s.before, after: s.after, x, y };
  }

  // ---- taps ------------------------------------------------------------------------------------------------------
  /** a real tap at this place of the screen; what it did (the "click" that may follow is then the tutor's, not the site's) */
  private tapAt(x: number, y: number): { prevent: boolean } {
    const target = document.elementFromPoint(x, y);
    const own = !!this.card && target === this.card.host;
    const control = !!target?.closest(CONTROL);
    const a = target?.closest<HTMLAnchorElement>('a[href], area[href]') ?? null;
    const hit = !own && !control ? this.hitAt(x, y) : null;
    const d = tapDecision({ mode: this.mode, trusted: true, own, control, link: a ? a.href || '#' : '', word: !!hit });
    this.lastTap = { at: Date.now(), x, y, prevent: d.prevent };
    if (own) return d;
    if (d.bubble && a) this.ensureCard().bubble(x, y, 'Open link', () => this.follow(a));
    else this.card?.hideBubble();
    if (d.explain && hit) this.tap(hit);
    else if (!control && !d.bubble && this.card?.open && !this.say.busy) this.closeCard();
    this.debug();
    return d;
  }

  /** the "click" after a tap (links, buttons; a mouse): in Explanation mode a link is not followed, a word tap is the tutor's */
  private onClick = (e: MouseEvent): void => {
    if (!this.mode || this.pass || !e.isTrusted) return;
    if (e.target === this.card?.host) return;
    // (a click with no place: the keyboard on a link or button of the site, which keeps working)
    if (e.detail === 0 && e.clientX === 0 && e.clientY === 0) return;
    const t = this.lastTap;
    const same = Date.now() - t.at < 900 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30;
    const d = same ? t : this.tapAt(e.clientX, e.clientY);
    if (d.prevent) { e.preventDefault(); e.stopPropagation(); }
  };

  /** (the second tap already made it "the sentence": the page gets no double click of its own for it) */
  private onDouble = (e: MouseEvent): void => {
    if (this.mode && e.isTrusted && Date.now() - this.lastDouble < 900) { e.preventDefault(); e.stopPropagation(); }
  };

  private whenReady(run: () => unknown): Promise<void> { return this.load().then(() => { if (this.mode) run(); }); }

  /** one tap = the word (after a moment: a second tap makes it the sentence) */
  private tap(hit: Hit): void {
    const now = Date.now();
    const p = this.pending;
    if (p && now - p.at < 450 && Math.hypot(hit.x - p.x, hit.y - p.y) < 40) {
      clearTimeout(p.timer);
      this.pending = null;
      this.lastDouble = now;
      void this.whenReady(() => this.explainSentence(hit.sentence, hit));
      return;
    }
    if (p) { clearTimeout(p.timer); this.pending = null; }
    this.pending = { at: now, x: hit.x, y: hit.y, timer: setTimeout(() => { this.pending = null; void this.whenReady(() => this.explainWord(hit)); }, 320) };
    // (the card comes at once: the dictionary is free)
    if (this.ready) this.showWord(hit);
  }

  private ensureCard(): WordCard {
    this.card ??= new WordCard(document, { onKnow: () => void this.cardKnown(), onButton: () => this.cardButton(), onClose: () => this.closeCard(), onBubble: () => this.debug() }, { sizePx: this.extras.phoneSizePx ?? 21, look: 'auto' }, true);
    return this.card;
  }

  private closeCard(): void {
    this.say.stop();
    this.card?.hide();
    this.cardFor = null;
    this.debug();
  }

  private showWord(hit: Hit): { lemma: string; word: string; zh: string; hit: Hit | null } {
    this.say.stop();
    const info = this.dict ? cardOf(hit.word, this.dict) : { lemma: hit.word.toLowerCase(), ipa: '', zh: '' };
    const free = this.free();
    const mine = { lemma: info.lemma, word: hit.word, zh: info.zh, hit };
    this.cardFor = mine;
    this.ensureCard().show({ kind: 'word', word: hit.word, ipa: info.ipa, zh: info.zh, hint: 'Tap here = I know this word', button: free ? 'Translate the sentence' : 'Explain the sentence', busy: !free });
    this.debug();
    return mine;
  }

  private async explainWord(hit: Hit): Promise<void> {
    const mine = this.cardFor?.hit === hit ? this.cardFor : this.showWord(hit);
    const { lemma, word } = mine;
    if (this.vocab.words[lemma] !== 'known') { this.vocab.words[lemma] = 'learning'; this.remarkSoon(); }
    void markLearning(lemma, word, hit.sentence).catch(() => undefined);
    if (this.free()) {
      // free mode: the card only; the device's own voice says the word once (nothing asked of the AI, nothing paid)
      void this.say.say(word);
      return;
    }
    const req: RuleRequest = {
      kind: 'word', target: word, sentence: hit.sentence, before: hit.before, after: hit.after, book: { title: pageTitle(), chapter: '' }, history: [],
      levelRule: { items: [], known: [], level: this.level(), length: this.length(), web: true },
    };
    this.asked++;
    const r = await this.say.explain(req, (t) => { if (this.cardFor === mine) this.card?.update({ text: t }); this.debug(); });
    if (this.cardFor === mine) this.card?.update({ busy: false, ...(r.error ? { text: r.error } : {}) });
    if (r.text) {
      const s = await saveExplained({ lemma, word, sentence: hit.sentence, explanation: r.text, chinese: mine.zh, bookId: `web:${location.hostname}`, bookTitle: pageTitle(), chapter: '', position: null }, this.extras.knownAfter ?? 7).catch(() => null);
      if (s?.nowKnown) { this.vocab.words[lemma] = 'known'; this.remarkSoon(); if (this.cardFor === mine) this.card?.update({ hint: `“${word}” was explained ${s.times} times: it counts as known now.` }); }
    }
    this.debug();
  }

  /** a tap on the word's card: I know it */
  private async cardKnown(): Promise<void> {
    const c = this.cardFor;
    this.closeCard();
    if (!c?.lemma) return;
    this.vocab.words[c.lemma] = 'known';
    this.remarkSoon();
    await markKnown(c.lemma, c.word).catch(() => undefined);
    this.debug();
  }

  private cardButton(): void {
    const hit = this.cardFor?.hit;
    if (hit) void this.explainSentence(hit.sentence, hit);
  }

  /** a sentence (a double tap, the card's button) or the selected words: explained, or translated on the device */
  private async explainSentence(text: string, hit: Hit | null): Promise<void> {
    const target = text.replace(/\s+/g, ' ').trim();
    if (!target) return;
    this.say.stop();
    const free = this.free();
    const mine = { lemma: '', word: '', zh: '', hit: null };
    this.cardFor = mine;
    this.ensureCard().show({ kind: 'sentence', word: free ? 'In Chinese' : 'This sentence', hint: target.length > 160 ? `${target.slice(0, 158)}…` : target, busy: !free, text: free ? '…' : '' });
    this.debug();
    if (free) {
      const zh = await nativeTranslate(target);
      if (this.cardFor === mine) this.card?.update({ zh: zh ?? '', text: zh ? '' : 'The translation is not here (it needs iOS 18 and the Chinese language downloaded). Turn My tutor on for an explanation.' });
      this.debug();
      return;
    }
    const req: RuleRequest = {
      kind: 'sentence', target, sentence: target, before: hit?.before ?? '', after: hit?.after ?? '', book: { title: pageTitle(), chapter: '' }, history: [],
      levelRule: { items: [], known: [], level: this.level(), length: this.length(), web: true },
    };
    this.asked++;
    const r = await this.say.explain(req, (t) => { if (this.cardFor === mine) this.card?.update({ text: t }); this.debug(); });
    if (this.cardFor === mine) this.card?.update({ busy: false, ...(r.error ? { text: r.error } : {}) });
    this.debug();
  }

  /** the bubble was tapped: the link is followed the way the site itself would */
  private follow(a: HTMLAnchorElement): void {
    this.closeCard();
    this.pass = true;
    try { a.click(); } finally { this.pass = false; }
  }

  // ---- a finished selection of several words -----------------------------------------------------------------------
  private onSelection = (): void => {
    if (this.selTimer) clearTimeout(this.selTimer);
    this.selTimer = setTimeout(() => {
      this.selTimer = null;
      if (!this.mode) return;
      const sel = window.getSelection();
      const t = sel?.toString().replace(/\s+/g, ' ').trim() ?? '';
      if (!sel || sel.isCollapsed || !t) { this.lastSelection = ''; return; }
      const now = Date.now();
      // (only after a real touch, and not again for the same words: a page's script cannot make the tutor talk)
      if (t === this.lastSelection || now - this.lastTouch > 20_000 || now - this.lastSelectionAt < 2000) return;
      if (t.split(' ').length < 2 || t.length > 700 || !/[A-Za-z]{2}/.test(t)) return;
      const el = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
      if (!el || el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return;
      this.lastSelection = t;
      this.lastSelectionAt = now;
      void this.whenReady(() => this.explainSentence(t, null));
    }, 900);
  };

  // ---- what is on the screen now -----------------------------------------------------------------------------------
  /** the biggest article / main part of the page, else the whole page */
  private mainRoot(): Element {
    let best: Element | null = null, size = 500;
    for (const el of Array.from(document.querySelectorAll('article, main, [role="main"]'))) {
      const n = (el.textContent ?? '').length;
      if (n > size) { best = el; size = n; }
    }
    return best ?? document.body ?? document.documentElement;
  }

  private visible(el: Element): boolean {
    const check = (el as Element & { checkVisibility?(o?: object): boolean }).checkVisibility;
    try { if (typeof check === 'function' && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false; } catch { /* not here */ }
    return true;
  }

  /** the text nodes that are in view (with a margin), each with the place of its text */
  private textInView(root: Element, margin: number, skipChrome: boolean, max: number): { node: Text; top: number; bottom: number }[] {
    const out: { node: Text; top: number; bottom: number }[] = [];
    const vh = window.innerHeight;
    const seen = new Map<Element, boolean>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let visited = 0;
    for (let n = walker.nextNode() as Text | null; n && visited < 20_000 && out.length < max; n = walker.nextNode() as Text | null) {
      visited++;
      const p = n.parentElement;
      if (!p || SKIP.has(p.tagName) || !/[A-Za-z]{2}/.test(n.data)) continue;
      let ok = seen.get(p);
      if (ok === undefined) {
        const r = p.getBoundingClientRect();
        ok = r.width > 0 && r.height > 0 && r.bottom > -margin && r.top < vh + margin && p !== this.card?.host && !p.closest('script, style, noscript, textarea, [contenteditable=""], [contenteditable="true"]') && !(skipChrome && p.closest(CHROME)) && this.visible(p);
        seen.set(p, ok);
      }
      if (!ok) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom <= -margin || r.top >= vh + margin) continue;
      out.push({ node: n, top: r.top, bottom: r.bottom });
    }
    return out;
  }

  private screenText(): string {
    const blocks: (ScreenBlock & { el: Element })[] = [];
    for (const t of this.textInView(this.mainRoot(), 0, true, 400)) {
      let block: Element = t.node.parentElement!;
      while (block.parentElement && !BLOCK.has(block.tagName)) block = block.parentElement;
      const last = blocks[blocks.length - 1];
      if (last && last.el === block) { last.text += ` ${t.node.data}`; last.top = Math.min(last.top, t.top); last.bottom = Math.max(last.bottom, t.bottom); }
      else blocks.push({ el: block, text: t.node.data, top: t.top, bottom: t.bottom });
    }
    return visibleText(blocks, window.innerHeight, 1500);
  }

  /** the Explain button / "hello": ONE request for what can be read on the screen; while the tutor talks = stop */
  private async explainScreen(): Promise<void> {
    if (!this.mode) return;
    await this.load();
    if (this.say.busy) { this.stop(); return; }
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
    const mine = { lemma: '', word: '', zh: '', hit: null };
    this.cardFor = mine;
    if (this.free()) {
      this.ensureCard().show({ kind: 'note', word: 'My tutor is off', text: 'Turn My tutor on to hear an explanation. A tap on a word still shows its meaning.' });
      this.debug();
      return;
    }
    const text = this.screenText();
    if (text.length < 40) {
      this.ensureCard().show({ kind: 'note', word: 'Nothing to explain', text: 'There is no English text on the screen now.' });
      this.debug();
      return;
    }
    this.ensureCard().show({ kind: 'note', word: 'On the screen', busy: true });
    this.asked++;
    const r = await this.say.tell(screenPrompt({ text, title: pageTitle(), level: this.level(), length: this.length() }), (t) => { if (this.cardFor === mine) this.card?.update({ text: t }); this.debug(); });
    if (this.cardFor === mine) this.card?.update({ busy: false, ...(r.error ? { text: r.error } : {}) });
    this.debug();
  }

  private stop(): void {
    this.say.stop();
    if (this.pending) { clearTimeout(this.pending.timer); this.pending = null; }
    this.card?.update({ busy: false });
    this.debug();
  }

  /** what the app's microphone heard (only while Explanation mode is on): "hello" and "stop" */
  private heard(ev: { type?: string; text?: string; final?: boolean }): void {
    if (!this.mode || !ev || ev.type !== 'result' || typeof ev.text !== 'string') return;
    const c = voiceCommand(ev.text, !!ev.final);
    if (c === 'stop') {
      // (the tutor's own voice saying "stop" is not the learner)
      if (this.say.busy && !/\bstop\b/i.test(this.say.nowSaying)) this.stop();
    } else if (c === 'hello' && !this.say.busy) void this.explainScreen();
  }

  // ---- the hard words in view, marked (no AI; the page's DOM is not changed) ---------------------------------------
  private remarkSoon(): void {
    if (this.markTimer || !this.mode) return;
    this.markTimer = setTimeout(() => { this.markTimer = null; this.remark(); }, 450);
  }

  private registry(): { reg: Registry; make: HighlightCtor } | null {
    const reg = (globalThis as { CSS?: { highlights?: Registry } }).CSS?.highlights;
    const make = (globalThis as { Highlight?: HighlightCtor }).Highlight;
    return reg && typeof make === 'function' ? { reg, make } : null;
  }

  private remark(): void {
    const h = this.registry();
    if (!h || !this.mode || !this.dict || !document.body) return;
    const ctx = { dict: this.dict, zipf: this.zipf, words: this.vocab.words, myLevel: myLevelOf(this.extras, this.settings?.learnerLevel) };
    const hard: Range[] = [], learning: Range[] = [];
    const verdict = new Map<string, 'hard' | 'learning' | null>();
    for (const t of this.textInView(document.body, 300, false, 1500)) {
      if (hard.length + learning.length > 600) break;
      for (const w of wordsIn(t.node.data)) {
        let m = verdict.get(w.word);
        if (m === undefined) { m = markOf(w.word, ctx); verdict.set(w.word, m); }
        if (!m) continue;
        const r = document.createRange();
        r.setStart(t.node, w.start);
        r.setEnd(t.node, w.end);
        (m === 'hard' ? hard : learning).push(r);
      }
    }
    try {
      this.ensureStyle();
      h.reg.set(HARD, new h.make(...hard));
      h.reg.set(LEARNING, new h.make(...learning));
      this.counts = { hard: hard.length, learning: learning.length };
    } catch { /* this WebKit has no highlights: no marks */ }
    this.debug();
  }

  private ensureStyle(): void {
    if (this.sheet || this.styleEl) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(MARK_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      this.sheet = sheet;
    } catch {
      const el = document.createElement('style');
      el.textContent = MARK_CSS;
      (document.head ?? document.documentElement).appendChild(el);
      this.styleEl = el;
    }
  }

  private clearMarks(): void {
    if (this.markTimer) { clearTimeout(this.markTimer); this.markTimer = null; }
    const h = this.registry();
    try { h?.reg.delete(HARD); h?.reg.delete(LEARNING); } catch { /* none */ }
    try { if (this.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.sheet); } catch { /* gone */ }
    this.sheet = null;
    this.styleEl?.remove();
    this.styleEl = null;
    this.counts = { hard: 0, learning: 0 };
  }

  // ---- the article of the page, for the reader -----------------------------------------------------------------------
  private article(): { title: string; text: string } | null {
    const root = this.mainRoot();
    const SEL = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, figcaption, dd, dt';
    const blocks: PageBlock[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(SEL))) {
      if (el.closest(CHROME) || el.querySelector(SEL) || !this.visible(el)) continue;
      // (the words of the text only: not what is written on the site's buttons)
      let text = '';
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) if (!n.parentElement?.closest('button, select, textarea, script, style, noscript, svg')) text += n.data;
      let links = 0;
      for (const a of Array.from(el.querySelectorAll('a'))) links += (a.textContent ?? '').length;
      blocks.push({ tag: el.tagName, text, linkChars: links });
    }
    let text = articleText(blocks);
    if (text.length < 200) text = ((document.body as HTMLElement | null)?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 400_000);
    return text.length >= 20 ? { title: pageTitle(), text } : null;
  }
}

(() => {
  const w = window as unknown as { __iknowWeb?: WebApi; __ytcWebMode?: boolean };
  // (the main frame only, once per page)
  let top = false;
  try { top = window.top === window; } catch { top = false; }
  if (!top || w.__iknowWeb) return;
  installWebBackground();
  const tutor = new WebTutor();
  w.__iknowWeb = tutor.api;
  // (the app says with the page's start whether Explanation mode is on)
  if (w.__ytcWebMode) tutor.setMode(true);
})();
