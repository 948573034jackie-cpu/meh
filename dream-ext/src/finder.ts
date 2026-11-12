/**
 * "Find me a video": the learner says (voice note) or types what they want to learn or know. Several YouTube searches
 * are made from their words by fixed patterns (no AI) and run on the YouTube page itself; ONE AI request then picks
 * the 10 best of the 30-40 videos found and ranks them, each with a reason and a guessed level 0-100. The level is
 * then measured from each video's subtitles (no AI: finder-list.ts textDifficulty), a few at a time, cached per video.
 * The list can be ordered again by level (only an order: no AI, no new search), it is kept (it is there again when the
 * finder opens, also after the app was closed) and it is a playlist. With the tutor off or no key: no AI at all, the
 * first 10 in YouTube's order. Full screen over the page (shadow DOM), big buttons for the phone, day and night.
 */
import type { Dictionary } from '@core/dict/types';
import { detectNames } from '@core/dict/names';
import { buildVideoBook, type TimedSentence } from './video-book';
import { clampLevel } from './level100';
import {
  buildRankPrompt, parseRankReply, makeSearches, pickCandidates, makeList, textDifficulty, orderedVideos, orderLevel, fitLabel, minutes,
  loadList, saveList, playFromList, finderNext, finderPrev,
  type FoundVideo, type FinderLevel, type FinderList, type ListVideo, type ListOrder, type RankPick,
} from './finder-list';

export type { FoundVideo, FinderLevel } from './finder-list';

export interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((e: { results: { length: number; [i: number]: { 0: { transcript: string }; isFinal: boolean } } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
}

export interface FinderDeps {
  /** one AI completion (ai-client.ts complete): asked ONCE per search */
  complete(prompt: { system: string; user: string; maxTokens: number }): Promise<string>;
  /** the AI may be used now: the tutor is on and there is a key (false = no AI at all) */
  aiOn(): boolean | Promise<boolean>;
  /** YouTube search on the page (window.__ytcApi.searchVideos) */
  search(q: string): Promise<FoundVideo[]>;
  /** any video's subtitles (window.__ytcApi.cuesFor); [] = none */
  cuesFor(id: string): Promise<unknown[]>;
  /** cues -> sentences with word times (window.__ytcApi.buildSentences) */
  buildSentences(cues: unknown[]): TimedSentence[];
  getDictionary(): Promise<Dictionary>;
  getZipf?(): Promise<(word: string) => number | null>;
  /** the learner's level, 0-100 */
  myLevel(): number;
  /** the "Text size" setting in px (the finder's text follows it) */
  textSize?(): number;
  /** the video on the page now (its row is marked) */
  currentId?(): string | null;
  /** the SpeechRecognition constructor, or null (then only typing) */
  speech(): (new () => SpeechRecognitionLike) | null;
  cache: { get(id: string): Promise<FinderLevel | null>; set(id: string, level: FinderLevel): Promise<void> | void };
  /** the finder uses the microphone now (true) / not any more (false): pause the page's other listening meanwhile */
  micBusy?(on: boolean): void;
  /** the finder was closed */
  onClose?(): void;
}

/** how many videos have their subtitles read at the same time, and how often a video is asked for them at most */
const AT_ONCE = 2, MAX_TRIES = 2;

const CSS = `:host{all:initial;position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);font:16px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%;
--bg:#fff;--fg:#1f2328;--muted:#5f6368;--soft:#f3f5f7;--line:#e3e6ea;--chip:#e8ebee;--blue:#1a73e8;--on-blue:#fff;--ok:#137333;--ok-bg:#e0f2e6;--easy:#5f6368;--easy-bg:#e8ebee;--hard:#b3541e;--hard-bg:#fbe9dd;--bar:#c9ced4;--now:#e8f0fe}
@media (prefers-color-scheme:dark){:host{--bg:#17191e;--fg:#e6e3dc;--muted:#a4a19a;--soft:#22252c;--line:#30343c;--chip:#2c3038;--blue:#8ab4f8;--on-blue:#10141b;--ok:#81c995;--ok-bg:#1d3324;--easy:#b6b3ac;--easy-bg:#2c3038;--hard:#f5b98a;--hard-bg:#3b2a1e;--bar:#444a54;--now:#25324a}}
*{box-sizing:border-box}
.card{background:var(--bg);color:var(--fg);border-radius:14px;width:min(720px,100vw);height:min(100dvh,940px);display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.45);overflow:hidden;font-size:var(--fs,16px)}
@media (max-width:740px),(max-height:600px){.card{border-radius:0;height:100dvh;width:100vw}}
header{display:flex;align-items:center;gap:10px;padding:max(10px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) 8px max(14px,env(safe-area-inset-left));border-bottom:1px solid var(--line);flex:none}
h2{margin:0;font-size:1.15em;flex:1}
button{font:inherit;cursor:pointer;border:0;border-radius:12px;padding:10px 14px;min-height:48px;color:inherit;background:var(--chip);touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.x{min-width:48px;font-size:18px;font-weight:600}
.scroll{overflow-y:auto;flex:1;min-height:0;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:10px max(14px,env(safe-area-inset-right)) calc(44px + env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}
.newrow{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--soft);min-height:60px;margin:0 0 8px}
.newrow b{flex:none}
.newrow .q{flex:1;min-width:0;color:var(--muted);font-size:.8em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.newrow[hidden],.askbox[hidden],.order[hidden],.pl[hidden]{display:none}
.ask{display:grid;grid-template-columns:1fr;gap:8px}
@media (min-width:640px) and (max-height:520px){.ask{grid-template-columns:minmax(200px,38%) 1fr;align-items:stretch}}
.speak{background:#d93025;color:#fff;font-size:1.1em;font-weight:700;min-height:64px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.speak[aria-pressed=true]{background:#1e8e3e}
.speak:disabled{background:#9aa0a6}
textarea{font:inherit;width:100%;min-height:72px;border:1px solid var(--line);border-radius:12px;padding:10px 12px;resize:vertical;color:var(--fg);background:var(--bg)}
.hint{margin:4px 0 8px;color:var(--muted);font-size:.8em}
.go{background:var(--blue);color:var(--on-blue);font-weight:700;font-size:1.05em;width:100%;min-height:60px}
.go:disabled{opacity:.55}
.status{margin:10px 0 8px;color:var(--muted);font-size:.85em;min-height:1.4em}
.order{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:4px 0 8px}
.order .lab{color:var(--muted);font-size:.8em}
.ob{min-height:48px;min-width:72px;border-radius:24px;font-weight:600}
.ob[aria-pressed=true]{background:var(--blue);color:var(--on-blue)}
.pick{display:flex;align-items:center;gap:6px;flex:1;min-width:240px}
.pick button{min-width:48px;font-size:1.2em;font-weight:700;padding:6px}
.pick input{flex:1;min-width:80px;height:44px;margin:0;accent-color:var(--blue)}
.pick output{min-width:5.2em;font-size:.85em;font-weight:600;text-align:right}
.pick[data-on="1"] output{color:var(--blue)}
.pl{display:flex;gap:8px;margin:0 0 10px}
.pl button{flex:1;min-height:60px;font-weight:600}
.pl button:disabled{opacity:.45}
.list{display:grid;grid-template-columns:1fr;gap:10px}
.vid{display:flex;gap:10px;text-align:left;background:var(--soft);padding:8px;border-radius:12px;align-items:flex-start;width:100%;min-height:76px;border:2px solid transparent}
.vid.now{border-color:var(--blue);background:var(--now)}
.rk{flex:none;width:1.7em;height:1.7em;border-radius:50%;background:var(--chip);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.9em;margin-top:2px}
.vid.now .rk{background:var(--blue);color:var(--on-blue)}
.vid img{width:30%;max-width:200px;min-width:84px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;background:var(--chip);flex:none}
.meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.t{font-weight:600;font-size:.9em;line-height:1.3;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.c{color:var(--muted);font-size:.72em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:.74em}
.lv .num{font-weight:700}
.lv .bar{width:64px;height:6px;border-radius:3px;background:var(--bar);overflow:hidden;flex:none}
.lv .bar i{display:block;height:100%;background:var(--blue);border-radius:3px}
.lv .fit{border-radius:10px;padding:1px 8px;font-weight:600}
.fit.ok{background:var(--ok-bg);color:var(--ok)}
.fit.easy{background:var(--easy-bg);color:var(--easy)}
.fit.hard{background:var(--hard-bg);color:var(--hard)}
.why{font-size:.8em;line-height:1.35}
.nowtag{font-size:.72em;font-weight:700;color:var(--blue)}`;

let current: Finder | null = null;

/** Opens the finder over the page (one at a time). It stays until the learner closes it or opens a video. */
export function openFinder(deps: FinderDeps): { close(): void } {
  if (!current) { current = new Finder(deps); current.show(); }
  const f = current;
  return { close: () => f.close() };
}
/** the finder is on screen (e.g. so the page's own listening leaves the microphone alone) */
export function finderIsOpen(): boolean { return !!current; }

class Finder {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private run = 0;
  private list: FinderList | null = null;
  private rows = new Map<string, HTMLButtonElement>();
  private queue: string[] = [];
  /** the videos whose subtitles are still to be read (or are being read) */
  private pending = new Set<string>();
  private active = 0;
  private busy = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dictP: Promise<Dictionary | null> | null = null;
  private zipfP: Promise<((w: string) => number | null) | null> | null = null;
  private rec: SpeechRecognitionLike | null = null;
  private wantMic = false;
  private heard = '';
  private blocked = false;
  private pressAt = 0;
  private micTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: FinderDeps) {}

  private $<T extends Element>(sel: string): T { return this.root!.querySelector<T>(sel)!; }
  private my(): number { try { return clampLevel(this.deps.myLevel()); } catch { return 55; } }
  private nowId(): string | null { try { return this.deps.currentId?.() ?? null; } catch { return null; } }

  show(): void {
    const host = document.createElement('div');
    host.id = 'dr-finder-host';
    const root = host.attachShadow({ mode: 'open' });
    (document.body ?? document.documentElement).appendChild(host);
    this.host = host; this.root = root;
    // (the page's own keys and clicks stay out of it: typing here must not start YouTube's shortcuts)
    for (const type of ['keydown', 'keyup', 'keypress', 'click']) host.addEventListener(type, (e) => e.stopPropagation());
    const canTalk = !!this.safeSpeech();
    let fs = 16;
    try { fs = Math.max(14, Math.min(30, Math.round(this.deps.textSize?.() ?? 16))); } catch { /* 16 */ }
    const my = this.my();
    root.innerHTML = `<style>${CSS}</style><div class="card" role="dialog" aria-label="Find a video" style="--fs:${fs}px">
<header><h2>Find a video</h2><button class="x" data-a="close" aria-label="Close">✕</button></header>
<div class="scroll">
<button class="newrow" data-a="new" aria-expanded="true" hidden><b>🔎 New search</b><span class="q"></span></button>
<div class="askbox">
<div class="ask">
<button class="speak" data-a="speak" aria-pressed="false"${canTalk ? '' : ' disabled'}>${canTalk ? '🎤 Speak' : '🎤 Voice not available'}</button>
<textarea rows="3" placeholder="Or type here: anything you want to learn or know…" aria-label="What do you want to learn?"></textarea>
</div>
<p class="hint">${canTalk ? 'Tap 🎤 and talk, tap again to stop (or hold it while you talk). Say any topic: what you want to learn or know.' : 'Type any topic: what you want to learn or know.'}</p>
<button class="go" data-a="find">Find the 10 best videos</button>
</div>
<p class="status" aria-live="polite"></p>
<div class="order" role="group" aria-label="Order of the list" hidden>
<span class="lab">Order:</span>
<button class="ob" data-o="best" aria-pressed="true">Best</button>
<button class="ob" data-o="mine" aria-pressed="false">My level</button>
<span class="pick"><button data-o="down" aria-label="Easier">−</button><input type="range" min="0" max="100" step="5" value="${my}" aria-label="Order by this level"><button data-o="up" aria-label="Harder">+</button><output>Level ${my}</output></span>
</div>
<div class="pl" hidden><button data-a="prev">⏮ Back</button><button data-a="next">Next ⏭</button></div>
<div class="list"></div>
</div></div>`;
    this.$('[data-a=close]').addEventListener('click', () => this.close());
    this.$('[data-a=find]').addEventListener('click', () => void this.find());
    this.$('[data-a=new]').addEventListener('click', () => this.showAsk(this.$<HTMLElement>('.askbox').hidden));
    this.$('[data-a=prev]').addEventListener('click', () => { finderPrev(); });
    this.$('[data-a=next]').addEventListener('click', () => { finderNext(); });
    for (const b of root.querySelectorAll<HTMLButtonElement>('.ob')) b.addEventListener('click', () => this.setOrder(b.dataset.o as 'best' | 'mine'));
    const slider = this.$<HTMLInputElement>('.pick input');
    slider.addEventListener('input', () => this.setOrder(clampLevel(Number(slider.value))));
    const nudge = (d: number) => { const base = orderLevel(this.list?.order ?? 'mine', this.my()) ?? this.my(); this.setOrder(clampLevel(Math.round((base + d) / 5) * 5)); };
    this.$('[data-o=down]').addEventListener('click', () => nudge(-5));
    this.$('[data-o=up]').addEventListener('click', () => nudge(5));
    const speak = this.$<HTMLButtonElement>('[data-a=speak]');
    // tap = start / stop; hold = talk while holding; a keyboard press (click with detail 0) = start / stop
    speak.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.wantMic) { this.pressAt = 0; this.stopListening(); } else { this.pressAt = Date.now(); this.listen(); }
    });
    const release = () => { if (this.pressAt && Date.now() - this.pressAt > 700 && this.wantMic) this.stopListening(); this.pressAt = 0; };
    speak.addEventListener('pointerup', release);
    speak.addEventListener('pointercancel', release);
    speak.addEventListener('contextmenu', (e) => e.preventDefault());
    speak.addEventListener('click', (e) => { if (e.detail === 0) { if (this.wantMic) this.stopListening(); else this.listen(); } });
    host.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    this.$<HTMLTextAreaElement>('textarea').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.find(); } });
    // the list of the last search is there again (it stays until a new search)
    const run = this.run;
    void loadList().then((l) => { if (l && run === this.run && this.root && !this.list) this.useList(l, false); });
  }

  close(): void {
    if (!this.host) return;
    this.run++;
    this.wantMic = false;
    if (this.micTimer) clearTimeout(this.micTimer);
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; if (this.list) void saveList(this.list); }
    const r = this.rec; this.rec = null;
    if (r) { r.onend = null; r.onresult = null; r.onerror = null; try { r.stop(); } catch { /* over */ } }
    this.deps.micBusy?.(false);
    this.host.remove();
    this.host = null; this.root = null;
    if (current === this) current = null;
    try { this.deps.onClose?.(); } catch { /* the page's problem */ }
  }

  private status(text: string): void {
    if (this.root) this.$<HTMLElement>('.status').textContent = text;
  }

  private safeSpeech(): (new () => SpeechRecognitionLike) | null { try { return this.deps.speech(); } catch { return null; } }

  // ---------- the voice note ----------
  private listen(): void {
    const SR = this.safeSpeech();
    if (!SR || !this.root) { this.status('Voice is not available here. Please type.'); return; }
    this.wantMic = true;
    this.heard = '';
    this.blocked = false;
    const startedAt = Date.now();
    let restarts = 0;
    const btn = this.$<HTMLButtonElement>('[data-a=speak]');
    const box = this.$<HTMLTextAreaElement>('textarea');
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '● Listening… tap to stop';
    box.value = '';
    this.status('I am listening. Talk freely.');
    this.deps.micBusy?.(true);
    const once = () => {
      if (!this.wantMic || !this.root) return;
      let part = '';
      // (the iPhone app sends each piece at its own number, the earlier ones left out: they are kept here)
      const pieces: string[] = [];
      const r = new SR();
      r.lang = 'en-US'; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
      r.onresult = (e) => {
        for (let i = 0; i < e.results.length; i++) { const x = e.results[i]; if (x && x[0]) pieces[i] = x[0].transcript; }
        part = pieces.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        box.value = (this.heard + ' ' + part).trim();
      };
      r.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.wantMic = false; this.blocked = true; }
      };
      r.onend = () => {
        if (this.rec !== r) return;
        this.rec = null;
        this.heard = (this.heard + ' ' + part).replace(/\s+/g, ' ').trim();
        // the recognizer stops by itself after a pause: go on listening until the learner stops (at most 90 s)
        if (this.wantMic && restarts++ < 8 && Date.now() - startedAt < 90000) { setTimeout(once, 150); return; }
        this.doneListening();
      };
      this.rec = r;
      try { r.start(); } catch { this.rec = null; this.wantMic = false; this.doneListening(); }
    };
    // (a moment for the page's own listening to let go of the microphone)
    setTimeout(once, 300);
    if (this.micTimer) clearTimeout(this.micTimer);
    this.micTimer = setTimeout(() => { if (this.wantMic) this.stopListening(); }, 90000);
  }

  private stopListening(): void {
    this.wantMic = false;
    if (this.micTimer) clearTimeout(this.micTimer);
    const r = this.rec;
    if (r) {
      try { r.stop(); } catch { r.onend?.(); }
      // a recognizer that never says it ended
      setTimeout(() => { if (this.rec === r) { this.rec = null; r.onend = null; this.doneListening(); } }, 2000);
    } else this.doneListening();
  }

  private doneListening(): void {
    this.deps.micBusy?.(false);
    this.wantMic = false;
    if (!this.root) return;
    const btn = this.$<HTMLButtonElement>('[data-a=speak]');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = '🎤 Speak';
    const box = this.$<HTMLTextAreaElement>('textarea');
    if (this.heard && box.value.trim().length < this.heard.length) box.value = this.heard;
    if (box.value.trim()) void this.find(); // the voice note is "sent"
    else this.status(this.blocked ? 'The microphone is blocked. Allow it for YouTube, or type here.' : 'I did not hear anything. Tap 🎤 and try again, or type.');
  }

  // ---------- the search: several YouTube searches (no AI), then ONE AI request that picks and ranks ----------
  private showAsk(on: boolean): void {
    if (!this.root) return;
    this.$<HTMLElement>('.askbox').hidden = !on;
    const row = this.$<HTMLButtonElement>('[data-a=new]');
    row.hidden = !this.list;
    row.setAttribute('aria-expanded', String(on));
    if (on && this.list) this.$<HTMLTextAreaElement>('textarea').focus({ preventScroll: true });
  }

  private async find(): Promise<void> {
    if (!this.root || this.busy) return;
    if (this.wantMic) { this.stopListening(); return; } // (that finds when the voice note ends)
    const said = this.$<HTMLTextAreaElement>('textarea').value.trim();
    const searches = makeSearches(said);
    if (!searches.length) { this.status('Say or type what you want to find.'); return; }
    const run = ++this.run;
    const go = this.$<HTMLButtonElement>('[data-a=find]');
    const done = () => { this.busy = false; if (this.root) go.disabled = false; };
    this.busy = true;
    go.disabled = true;
    this.status('Searching YouTube…');
    const lists = await Promise.all(searches.map((q) => this.deps.search(q).then((l) => (Array.isArray(l) ? l : []), () => [] as FoundVideo[])));
    if (run !== this.run || !this.root) { this.busy = false; return; }
    const cands = pickCandidates(lists, said);
    // (nothing found: the list of the last search stays)
    if (!cands.length) { done(); this.status('No videos found. Try other words (in English).'); return; }
    let picks: RankPick[] = [];
    let note = '';
    let ai = false;
    try { ai = !!(await this.deps.aiOn()); } catch { ai = false; }
    if (ai) {
      this.status(`${cands.length} videos found. Choosing the 10 best for you…`);
      // (the one AI request of this search: it is never asked again)
      try { picks = parseRankReply(await this.deps.complete(buildRankPrompt(said, cands, this.my())), cands.length); } catch { picks = []; }
      if (!picks.length) note = 'The AI could not rank them now: this is YouTube\'s own order. ';
    } else note = 'My tutor is off (or there is no API key): this is YouTube\'s own order, with no AI. ';
    if (run !== this.run || !this.root) { this.busy = false; return; }
    done();
    const list = makeList(said, cands, picks);
    void saveList(list);
    this.useList(list, true, note);
  }

  // ---------- the list ----------
  private useList(list: FinderList, fresh: boolean, note = ''): void {
    if (!this.root) return;
    this.list = list;
    this.queue = list.videos.filter((v) => v.levelFrom !== 'subs' && (v.tried ?? 0) < MAX_TRIES).map((v) => v.id);
    this.pending = new Set(this.queue);
    this.rows.clear();
    const box = this.$<HTMLElement>('.list');
    box.textContent = '';
    for (const v of list.videos) {
      const el = document.createElement('button');
      el.className = 'vid';
      el.dataset.id = v.id;
      el.innerHTML = '<span class="rk"></span><img alt="" loading="lazy" referrerpolicy="no-referrer"><span class="meta"><span class="t"></span><span class="c"></span><span class="lv"></span><span class="why"></span><span class="nowtag" hidden>▶ Playing now</span></span>';
      el.querySelector('.rk')!.textContent = String(v.rank);
      el.querySelector('img')!.src = v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
      el.querySelector('.t')!.textContent = v.title || 'YouTube video';
      el.querySelector('.c')!.textContent = [v.channel, minutes(v.lengthSeconds)].filter(Boolean).join(' · ');
      el.querySelector('.why')!.textContent = v.why;
      el.setAttribute('aria-label', `Number ${v.rank}: ${v.title}`);
      el.addEventListener('click', () => this.play(v.id));
      this.rows.set(v.id, el);
      this.paintLevel(v);
      box.appendChild(el);
    }
    this.$<HTMLElement>('.order').hidden = false;
    this.$<HTMLElement>('.newrow .q').textContent = list.query;
    this.showAsk(false);
    this.paintOrder();
    this.paintNow();
    this.statusNote = note;
    this.listStatus();
    if (fresh) this.$<HTMLElement>('.scroll').scrollTop = 0;
    // (the list of before: the video that plays now is on the screen)
    else { const id = this.nowId(); const el = id && list.playing === id ? this.rows.get(id) : null; try { el?.scrollIntoView({ block: 'center' }); } catch { /* an old engine */ } }
    this.pump();
  }

  private statusNote = '';
  private listStatus(): void {
    if (!this.list) return;
    const checking = this.pending.size > 0;
    this.status(`${this.statusNote}Tap a video to watch it. The next one plays by itself.${checking ? ' Checking the levels…' : ''}`);
  }

  private paintLevel(v: ListVideo): void {
    const lv = this.rows.get(v.id)?.querySelector<HTMLElement>('.lv');
    if (!lv) return;
    lv.textContent = '';
    if (v.level === null) {
      const s = document.createElement('span');
      s.textContent = this.pending.has(v.id) ? 'Level: checking…' : 'Level not known (no subtitles)';
      lv.appendChild(s);
      return;
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = v.levelFrom === 'subs' ? `Level ${v.level}` : `Level about ${v.level}`;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(4, v.level)}%`;
    bar.appendChild(fill);
    const f = fitLabel(v.level, this.my());
    const fit = document.createElement('span');
    fit.className = `fit ${f.kind}`;
    fit.textContent = f.text;
    lv.append(num, bar, fit);
  }

  /** the rows in the order now chosen (only moved: nothing is asked again) */
  private paintOrder(): void {
    const list = this.list;
    if (!this.root || !list) return;
    const box = this.$<HTMLElement>('.list');
    for (const v of orderedVideos(list, this.my())) { const el = this.rows.get(v.id); if (el) box.appendChild(el); }
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.ob')) b.setAttribute('aria-pressed', String(b.dataset.o === list.order));
    const lv = orderLevel(list.order, this.my()) ?? this.my();
    const pick = this.$<HTMLElement>('.pick');
    pick.dataset.on = typeof list.order === 'number' ? '1' : '0';
    const slider = this.$<HTMLInputElement>('.pick input');
    if (Number(slider.value) !== lv) slider.value = String(lv);
    this.$<HTMLElement>('.pick output').textContent = `Level ${lv}`;
    this.paintNow();
  }

  private setOrder(order: ListOrder): void {
    if (!this.list) return;
    this.list = { ...this.list, order };
    this.paintOrder();
    this.saveSoon();
  }

  /** the row of the video that plays now, and Back / Next */
  private paintNow(): void {
    const list = this.list;
    if (!this.root || !list) return;
    const now = this.nowId();
    const playing = now && list.playing === now ? now : null;
    for (const [id, el] of this.rows) {
      el.classList.toggle('now', id === playing);
      el.querySelector<HTMLElement>('.nowtag')!.hidden = id !== playing;
      if (id === playing) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
    }
    const pl = this.$<HTMLElement>('.pl');
    pl.hidden = !playing;
    if (playing) {
      const o = orderedVideos(list, this.my());
      const i = o.findIndex((v) => v.id === playing);
      this.$<HTMLButtonElement>('[data-a=prev]').disabled = i <= 0;
      this.$<HTMLButtonElement>('[data-a=next]').disabled = i < 0 || i >= o.length - 1;
    }
  }

  private play(id: string): void {
    const list = this.list;
    if (!list) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    // (the list is saved with "this one plays", then the page goes to the video; the finder goes with the page)
    playFromList(list, id);
  }

  private saveSoon(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; if (this.list) void saveList(this.list); }, 400);
  }

  // ---------- the levels: from the subtitles, a few at a time, no AI ----------
  private pump(): void {
    const run = this.run;
    while (this.active < AT_ONCE && this.queue.length) {
      const id = this.queue.shift()!;
      const v = this.list?.videos.find((x) => x.id === id);
      if (!v) continue;
      this.active++;
      void this.levelOf(v).then((r) => {
        this.active--;
        if (run !== this.run || !this.root || !this.list) return;
        this.pending.delete(id);
        const videos = this.list.videos.map((x) => (x.id !== id ? x : r && r.n !== null ? { ...x, level: r.n, levelFrom: 'subs' as const } : { ...x, tried: (x.tried ?? 0) + 1 }));
        this.list = { ...this.list, videos };
        this.paintLevel(videos.find((x) => x.id === id)!);
        // (ordered by level: the measured level may move it)
        if (this.list.order !== 'best') this.paintOrder();
        this.saveSoon();
        this.pump();
        this.listStatus();
      });
    }
  }

  private dict(): Promise<Dictionary | null> {
    this.dictP ??= this.deps.getDictionary().catch(() => null);
    return this.dictP;
  }
  private zipf(): Promise<((w: string) => number | null) | null> {
    this.zipfP ??= (this.deps.getZipf ? this.deps.getZipf().catch(() => null) : Promise.resolve(null));
    return this.zipfP;
  }

  /** one video's level: from the cache, else from its subtitles (2 requests to YouTube, no AI); null = not this time */
  private async levelOf(v: FoundVideo): Promise<FinderLevel | null> {
    try {
      const cached = await Promise.resolve(this.deps.cache.get(v.id)).catch(() => null);
      if (cached && (typeof cached.n === 'number' || cached.note)) return cached;
      const cues = await this.deps.cuesFor(v.id).catch(() => [] as unknown[]);
      if (!Array.isArray(cues) || !cues.length) return null; // (not cached: it may be a passing failure)
      const dict = await this.dict();
      if (!dict) return null;
      const zipf = await this.zipf();
      await new Promise((r) => setTimeout(r, 0)); // (let the page breathe between videos)
      const vb = buildVideoBook({ id: v.id, title: v.title }, this.deps.buildSentences(cues));
      let names = new Set<string>();
      try { names = new Set(detectNames(vb.book, dict)); } catch { /* no names */ }
      const r = textDifficulty(vb.book, dict, names, zipf);
      const out: FinderLevel = r ? { n: r.level, words: r.words } : { n: null, note: 'too short' };
      try { await this.deps.cache.set(v.id, out); } catch { /* not kept */ }
      return out;
    } catch { return null; }
  }
}
