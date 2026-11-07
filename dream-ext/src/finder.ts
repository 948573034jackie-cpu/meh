/**
 * "Find a video": the learner says (voice note) or types what they want (their life, plans, interests), ONE AI call
 * turns it into 3-5 YouTube searches with a reason each, the searches run on the YouTube page itself, and the first
 * ~8 videos get their vocabulary level from their subtitles (no AI: video-level.ts), a few at a time, cached per video.
 * Full screen over the page (shadow DOM, like level-gate.ts), big buttons for the phone, portrait and landscape.
 */
import type { CefrLevel } from '@core/model';
import { CEFR_LEVELS, levelIndex } from '@core/model';
import type { Dictionary } from '@core/dict/types';
import { detectNames } from '@core/dict/names';
import { buildVideoBook, type TimedSentence } from './video-book';
import { videoLevel, suggestLevelFor, cefrOf, type Coverage } from './video-level';

export interface FoundVideo { id: string; title: string; channel: string; lengthSeconds?: number; thumb?: string }
/** a video's level as shown and cached; level null = no level (note says why) */
export interface FinderLevel { level: CefrLevel | null; note?: 'no subtitles' | 'too short' | 'unknown'; coverage?: Coverage; hardForYou?: number; words?: number }
export interface FinderQuery { q: string; why: string }

export interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((e: { results: { length: number; [i: number]: { 0: { transcript: string }; isFinal: boolean } } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
}

export interface FinderDeps {
  /** one AI completion (ai-client.ts complete) */
  complete(prompt: { system: string; user: string; maxTokens: number }): Promise<string>;
  /** YouTube search on the page (window.__ytcApi.searchVideos) */
  search(q: string): Promise<FoundVideo[]>;
  /** any video's subtitles (window.__ytcApi.cuesFor); [] = none */
  cuesFor(id: string): Promise<unknown[]>;
  /** cues -> sentences with word times (window.__ytcApi.buildSentences) */
  buildSentences(cues: unknown[]): TimedSentence[];
  getDictionary(): Promise<Dictionary>;
  getZipf?(): Promise<(word: string) => number | null>;
  /** "B2", "about lower B2 for reading", ... */
  learnerLevel(): string;
  /** the learner's known words (lemmas), or a test */
  knownWords(): ReadonlySet<string> | ((lemma: string) => boolean);
  /** the SpeechRecognition constructor, or null (then only typing) */
  speech(): (new () => SpeechRecognitionLike) | null;
  /** play this video (the finder closes itself) */
  open(videoId: string): void;
  cache: { get(id: string): Promise<FinderLevel | null>; set(id: string, level: FinderLevel): Promise<void> | void };
  /** the finder uses the microphone now (true) / not any more (false): pause the page's other listening meanwhile */
  micBusy?(on: boolean): void;
  /** the finder was closed */
  onClose?(): void;
}

export type LevelFilter = 'any' | CefrLevel;

/** how many video cards to show, and how many candidates to keep for a level filter */
const SHOW = 8, KEEP = 16, AT_ONCE = 3;

/** The AI's answer -> up to 5 searches. Strict JSON is asked for; code fences, extra text, a bare list and a cut-off answer are accepted too. */
export function parseFinderReply(text: string): FinderQuery[] {
  const s = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  const tryParse = (t: string): unknown => { try { return JSON.parse(t); } catch { return undefined; } };
  let data = tryParse(s);
  if (data === undefined) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) data = tryParse(s.slice(a, b + 1)); }
  if (data === undefined) { const a = s.indexOf('['), b = s.lastIndexOf(']'); if (a >= 0 && b > a) data = tryParse(s.slice(a, b + 1)); }
  let list: unknown = data;
  if (list && typeof list === 'object' && !Array.isArray(list)) {
    const o = list as Record<string, unknown>;
    list = o.queries ?? o.searches ?? o.results ?? o.videos ?? null;
  }
  const raw: { q: unknown; why: unknown }[] = [];
  if (Array.isArray(list)) {
    for (const it of list) {
      if (typeof it === 'string') raw.push({ q: it, why: '' });
      else if (it && typeof it === 'object') { const o = it as Record<string, unknown>; raw.push({ q: o.q ?? o.query ?? o.search, why: o.why ?? o.reason ?? '' }); }
    }
  } else {
    // a cut-off or broken answer: take the "q" / "why" pairs that are complete
    const re = /"(?:q|query)"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"(?:why|reason)"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;
    for (let m = re.exec(s); m; m = re.exec(s)) raw.push({ q: tryParse(`"${m[1]}"`) ?? m[1], why: m[2] !== undefined ? tryParse(`"${m[2]}"`) ?? m[2] : '' });
  }
  const out: FinderQuery[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r.q !== 'string') continue;
    const q = r.q.replace(/\s+/g, ' ').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 100).trim();
    if (!q || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push({ q, why: typeof r.why === 'string' ? r.why.replace(/\s+/g, ' ').trim().slice(0, 200) : '' });
    if (out.length >= 5) break;
  }
  return out;
}

/** The one AI request: what the learner said + their level + the level filter -> 3-5 searches with a reason each. */
export function buildFinderPrompt(said: string, learnerLevel: string, filter: LevelFilter): { system: string; user: string; maxTokens: number } {
  const mine = cefrOf(learnerLevel) ?? 'B1';
  const want = filter === 'any' ? suggestLevelFor(learnerLevel) : filter;
  const low = levelIndex(want) <= levelIndex('A2');
  const system = 'You help a Chinese-speaking English learner find YouTube videos to learn English from. Reply with JSON only: no other text, no code fences.';
  const user = [
    said.trim()
      ? `What the learner said (it may come from speech recognition, so small mistakes are possible):\n"""${said.trim().slice(0, 1500)}"""`
      : 'The learner did not say anything special: choose useful, interesting topics for everyday life.',
    `Their English level: about ${mine}. Videos should be at about level ${want}${filter === 'any' ? ' (a little higher is fine)' : ''}.`,
    'Write 3 to 5 YouTube search queries in English that find real videos with clear English speech that fit what they said: their life, their plans, their interests and what they want to learn.',
    'Prefer people talking (lessons, interviews, talks, podcasts, vlogs, explanations). Not music-only videos, not Shorts. Make the queries different from each other.',
    low ? 'For this level, add words like "easy English", "for beginners" or "slow English" to some queries.'
      : levelIndex(want) >= levelIndex('C1') ? 'For this level, interviews, talks, lectures, podcasts and documentaries are good.' : '',
    'For each query, write one short sentence in very easy English (for a B1 reader) saying why it fits them.',
    'JSON: {"queries":[{"q":"...","why":"..."}]}',
  ].filter(Boolean).join('\n');
  return { system, user, maxTokens: 500 };
}

/** no AI answer: search for what they said */
export function fallbackQueries(said: string, filter: LevelFilter): FinderQuery[] {
  const easy = filter !== 'any' && levelIndex(filter) <= levelIndex('A2') ? 'easy English ' : '';
  const q = said.replace(/\s+/g, ' ').trim().slice(0, 80);
  return [{ q: q ? `${easy}${q}` : `${easy}English conversation`, why: q ? 'It is what you asked for.' : 'Everyday English.' }];
}

/** the hits of several searches, taking turns, without repeats; each video keeps the reason of its search */
export function mergeHits(lists: FoundVideo[][], queries: FinderQuery[], max = KEEP): (FoundVideo & { why: string })[] {
  const out: (FoundVideo & { why: string })[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < max; i++) {
    let any = false;
    lists.forEach((l, k) => {
      const v = l?.[i];
      if (!v) return;
      any = true;
      if (!v.id || seen.has(v.id) || out.length >= max) return;
      seen.add(v.id);
      out.push({ ...v, why: queries[k]?.why ?? '' });
    });
    if (!any) break;
  }
  return out;
}

const CSS = `:host{all:initial;position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);font:16px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif;color:#1f2328;-webkit-text-size-adjust:100%}
*{box-sizing:border-box}
.card{background:#fff;border-radius:14px;width:min(680px,100vw);height:min(100dvh,920px);display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.45);overflow:hidden}
@media (max-width:700px),(max-height:600px){.card{border-radius:0;height:100dvh;width:100vw}}
header{display:flex;align-items:center;gap:10px;padding:max(10px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) 8px max(14px,env(safe-area-inset-left));border-bottom:1px solid #eef0f2;flex:none}
h2{margin:0;font-size:20px;flex:1}
button{font:inherit;cursor:pointer;border:0;border-radius:12px;padding:12px 14px;min-height:48px;color:inherit;touch-action:manipulation}
.x{background:#eef0f2;min-width:48px;font-size:18px;font-weight:600}
.scroll{overflow-y:auto;flex:1;min-height:0;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:10px max(14px,env(safe-area-inset-right)) max(14px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}
.you{margin:0 0 10px;font-size:16px}
.you b{font-size:18px}
.ask{display:grid;grid-template-columns:1fr;gap:8px}
@media (min-width:640px) and (max-height:520px){.ask{grid-template-columns:minmax(200px,38%) 1fr;align-items:stretch}}
.speak{background:#d93025;color:#fff;font-size:20px;font-weight:700;min-height:64px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.speak[aria-pressed=true]{background:#1e8e3e}
.speak:disabled{background:#9aa0a6}
textarea{font:inherit;font-size:16px;width:100%;min-height:72px;border:1px solid #c4c7c5;border-radius:12px;padding:10px 12px;resize:vertical;color:#1f2328;background:#fff}
.hint{margin:2px 0 0;color:#5f6368;font-size:14px}
.levels{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:12px 0 8px}
.levels span{color:#5f6368;font-size:14px;margin-right:2px}
.lv{background:#eef0f2;padding:8px 12px;min-height:44px;min-width:52px;border-radius:22px;font-weight:600}
.lv[aria-pressed=true]{background:#1a73e8;color:#fff}
.go{background:#1a73e8;color:#fff;font-weight:700;font-size:18px;width:100%}
.go:disabled{background:#9aa0a6}
.status{margin:10px 0 6px;color:#3c4043;font-size:15px;min-height:1.4em}
.status button{background:#eef0f2;margin-left:6px;min-height:40px;padding:6px 12px}
.list{display:grid;grid-template-columns:1fr;gap:10px}
@media (min-width:640px){.list{grid-template-columns:1fr 1fr}}
.vid{display:flex;gap:10px;text-align:left;background:#f6f8fa;padding:8px;border-radius:12px;align-items:flex-start;width:100%}
.vid[hidden]{display:none}
.vid img{width:42%;max-width:220px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;background:#dadce0;flex:none}
.meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.t{font-weight:600;font-size:16px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.c{color:#5f6368;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.why{font-size:14px;color:#3c4043}
.lvl{align-self:flex-start;font-size:14px;font-weight:700;border-radius:10px;padding:2px 9px;background:#eef0f2;color:#3c4043}
.lvl.ok{background:#1e8e3e;color:#fff}
.lvl.up{background:#e37400;color:#fff}
.lvl.far{background:#5f6368;color:#fff}
.new{font-size:13px;color:#5f6368}`;

let current: Finder | null = null;

/** Opens the finder over the page (one at a time). */
export function openFinder(deps: FinderDeps): { close(): void } {
  if (!current) { current = new Finder(deps); current.show(); }
  const f = current;
  return { close: () => f.close() };
}
/** the finder is on screen (e.g. so the page's own listening leaves the microphone alone) */
export function finderIsOpen(): boolean { return !!current; }

interface Card { v: FoundVideo & { why: string }; el: HTMLButtonElement; level: FinderLevel | null }

class Finder {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private filter: LevelFilter = 'any';
  private run = 0;
  private cards: Card[] = [];
  private candidates: (FoundVideo & { why: string })[] = [];
  private next = 0;
  private queue: Card[] = [];
  private active = 0;
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

  show(): void {
    const host = document.createElement('div');
    host.id = 'dr-finder-host';
    const root = host.attachShadow({ mode: 'open' });
    (document.body ?? document.documentElement).appendChild(host);
    this.host = host; this.root = root;
    // (the page's own keys and clicks stay out of it: typing here must not start YouTube's shortcuts)
    for (const type of ['keydown', 'keyup', 'keypress', 'click']) host.addEventListener(type, (e) => e.stopPropagation());
    const lvl = this.deps.learnerLevel();
    const mine = suggestLevelFor(lvl), up = suggestLevelFor(lvl, true);
    const canTalk = !!this.safeSpeech();
    root.innerHTML = `<style>${CSS}</style><div class="card" role="dialog" aria-label="Find a video">
<header><h2>Find a video</h2><button class="x" data-a="close" aria-label="Close">✕</button></header>
<div class="scroll">
<p class="you">Your level: about <b>${mine}</b>. Videos at ${mine} are good for you now.${up !== mine ? ` For a little challenge, try ${up}.` : ''}</p>
<div class="ask">
<button class="speak" data-a="speak" aria-pressed="false"${canTalk ? '' : ' disabled'}>${canTalk ? '🎤 Speak' : '🎤 Voice not available'}</button>
<textarea rows="3" placeholder="Or type here: your life, your plans, what you want to learn…" aria-label="What do you want to learn?"></textarea>
</div>
<p class="hint">${canTalk ? 'Tap 🎤 and talk, tap again to stop (or hold it while you talk). Tell me about your life, your plans and what you want to learn.' : 'Type what you want to learn: your life, your plans, your interests.'}</p>
<div class="levels" role="group" aria-label="Video level"><span>Video level:</span>${(['any', ...CEFR_LEVELS] as LevelFilter[]).map((l) => `<button class="lv" data-l="${l}" aria-pressed="${l === 'any'}">${l === 'any' ? 'Any' : l}</button>`).join('')}</div>
<button class="go" data-a="find">Find videos</button>
<p class="status" aria-live="polite"></p>
<div class="list"></div>
</div></div>`;
    this.$('[data-a=close]').addEventListener('click', () => this.close());
    this.$('[data-a=find]').addEventListener('click', () => void this.find());
    for (const b of root.querySelectorAll<HTMLButtonElement>('.lv')) b.addEventListener('click', () => this.setFilter(b.dataset.l as LevelFilter));
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
  }

  close(): void {
    if (!this.host) return;
    this.run++;
    this.wantMic = false;
    if (this.micTimer) clearTimeout(this.micTimer);
    const r = this.rec; this.rec = null;
    if (r) { r.onend = null; r.onresult = null; r.onerror = null; try { r.stop(); } catch { /* over */ } }
    this.deps.micBusy?.(false);
    this.host.remove();
    this.host = null; this.root = null;
    if (current === this) current = null;
    try { this.deps.onClose?.(); } catch { /* the page's problem */ }
  }

  private status(text: string, button?: { label: string; act(): void }): void {
    if (!this.root) return;
    const el = this.$<HTMLElement>('.status');
    el.textContent = text;
    if (button) {
      const b = document.createElement('button');
      b.textContent = button.label;
      b.addEventListener('click', () => button.act());
      el.appendChild(b);
    }
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

  // ---------- level filter ----------
  private setFilter(l: LevelFilter): void {
    this.filter = l;
    if (!this.root) return;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.lv')) b.setAttribute('aria-pressed', String(b.dataset.l === l));
    this.applyFilter();
    this.fill();
    this.pump();
    this.finalStatus();
  }

  private matches(c: Card): boolean {
    if (this.filter === 'any') return true;
    if (!c.level) return true; // still checking
    return c.level.level === this.filter;
  }

  private applyFilter(): void { for (const c of this.cards) c.el.hidden = !this.matches(c); }

  // ---------- search ----------
  private async find(): Promise<void> {
    if (!this.root) return;
    if (this.wantMic) { this.stopListening(); return; } // (that finds when the voice note ends)
    const run = ++this.run;
    const said = this.$<HTMLTextAreaElement>('textarea').value.trim();
    const go = this.$<HTMLButtonElement>('[data-a=find]');
    go.disabled = true;
    this.cards = []; this.candidates = []; this.queue = []; this.next = 0;
    this.$<HTMLElement>('.list').textContent = '';
    this.status('Thinking about good videos for you…');
    let queries: FinderQuery[] = [];
    try { queries = parseFinderReply(await this.deps.complete(buildFinderPrompt(said, this.deps.learnerLevel(), this.filter))); } catch { /* below */ }
    if (run !== this.run || !this.root) return;
    if (!queries.length) queries = fallbackQueries(said, this.filter);
    this.status('Searching YouTube…');
    const lists = await Promise.all(queries.map((q) => this.deps.search(q.q).then((l) => (Array.isArray(l) ? l : []), () => [] as FoundVideo[])));
    if (run !== this.run || !this.root) return;
    go.disabled = false;
    this.candidates = mergeHits(lists, queries, KEEP);
    if (!this.candidates.length) { this.status('No videos found. Try other words.'); return; }
    this.fill();
    this.pump();
    this.finalStatus();
  }

  /** shows more cards until SHOW are visible (a level filter hides some) */
  private fill(): void {
    if (!this.root) return;
    const list = this.$<HTMLElement>('.list');
    while (this.cards.filter((c) => !c.el.hidden).length < SHOW && this.next < this.candidates.length) {
      const v = this.candidates[this.next++];
      const el = document.createElement('button');
      el.className = 'vid';
      el.innerHTML = `<img alt="" loading="lazy" referrerpolicy="no-referrer"><div class="meta"><div class="t"></div><div class="c"></div><span class="lvl">Level: checking…</span><div class="why"></div><div class="new"></div></div>`;
      const img = el.querySelector('img')!;
      img.src = v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
      el.querySelector('.t')!.textContent = v.title || 'YouTube video';
      const mins = v.lengthSeconds ? Math.max(1, Math.round(v.lengthSeconds / 60)) : 0;
      el.querySelector('.c')!.textContent = [v.channel, mins ? `${mins} min` : ''].filter(Boolean).join(' · ');
      el.querySelector('.why')!.textContent = v.why;
      el.addEventListener('click', () => { const id = v.id; this.close(); this.deps.open(id); });
      const card: Card = { v, el, level: null };
      // (before the videos without a level, which stay last)
      list.insertBefore(el, this.cards.find((c) => c.level && !c.level.level)?.el ?? null);
      this.cards.push(card);
      this.queue.push(card);
    }
  }

  private pump(): void {
    const run = this.run;
    while (this.active < AT_ONCE && this.queue.length) {
      const card = this.queue.shift()!;
      this.active++;
      void this.levelOf(card.v).then((lv) => {
        this.active--;
        if (run !== this.run || !this.root) return;
        card.level = lv;
        this.paint(card);
        this.applyFilter();
        this.fill();
        this.pump();
        this.finalStatus();
      });
    }
  }

  private paint(card: Card): void {
    const lv = card.level!;
    const badge = card.el.querySelector<HTMLElement>('.lvl')!;
    const mine = suggestLevelFor(this.deps.learnerLevel());
    if (lv.level) {
      const d = levelIndex(lv.level) - levelIndex(mine);
      badge.textContent = d === 0 ? `${lv.level} · good for you` : d === 1 ? `${lv.level} · a little challenge` : d < 0 ? `${lv.level} · easy for you` : `${lv.level} · hard`;
      badge.className = 'lvl ' + (d === 0 || d < 0 ? 'ok' : d === 1 ? 'up' : 'far');
      if (typeof lv.hardForYou === 'number') card.el.querySelector('.new')!.textContent = `New words for you: about ${Math.max(lv.hardForYou > 0 ? 1 : 0, Math.round(lv.hardForYou * 100))}%`;
    } else {
      badge.textContent = lv.note === 'too short' ? 'Too little talking' : lv.note === 'unknown' ? 'Level unknown' : 'No subtitles';
      badge.className = 'lvl';
      card.el.parentElement?.appendChild(card.el); // videos without a level go last
    }
  }

  private finalStatus(): void {
    if (!this.root || !this.candidates.length) return;
    const checking = this.active + this.queue.length;
    const visible = this.cards.filter((c) => !c.el.hidden).length;
    if (visible === 0 && !checking) {
      this.status(`None of these videos is at ${this.filter}. Try other words, or choose Any.`, { label: 'Show all', act: () => this.setFilter('any') });
      return;
    }
    this.status(checking ? 'Tap a video to watch it. Checking the levels…' : 'Tap a video to watch it.');
  }

  private dict(): Promise<Dictionary | null> {
    this.dictP ??= this.deps.getDictionary().catch(() => null);
    return this.dictP;
  }
  private zipf(): Promise<((w: string) => number | null) | null> {
    this.zipfP ??= (this.deps.getZipf ? this.deps.getZipf().catch(() => null) : Promise.resolve(null));
    return this.zipfP;
  }

  /** one video's level: from the cache, else from its subtitles (2 requests, no AI) */
  private async levelOf(v: FoundVideo): Promise<FinderLevel> {
    try {
      const cached = await Promise.resolve(this.deps.cache.get(v.id)).catch(() => null);
      if (cached && (cached.level || cached.note)) return cached;
      const cues = await this.deps.cuesFor(v.id).catch(() => [] as unknown[]);
      if (!Array.isArray(cues) || !cues.length) return { level: null, note: 'no subtitles' }; // (not cached: it may be a passing failure)
      const dict = await this.dict();
      if (!dict) return { level: null, note: 'unknown' };
      const zipf = await this.zipf();
      await new Promise((r) => setTimeout(r, 0)); // (let the page breathe between videos)
      const vb = buildVideoBook({ id: v.id, title: v.title }, this.deps.buildSentences(cues));
      let names = new Set<string>();
      try { names = new Set(detectNames(vb.book, dict)); } catch { /* no names */ }
      let known: ReadonlySet<string> | ((l: string) => boolean) = new Set<string>();
      try { known = this.deps.knownWords(); } catch { /* none */ }
      const r = videoLevel(vb, dict, names, { zipf, learner: this.deps.learnerLevel(), known });
      const out: FinderLevel = r ? { level: r.level, coverage: r.coverage, hardForYou: r.hardForYou, words: r.words } : { level: null, note: 'too short' };
      try { await this.deps.cache.set(v.id, out); } catch { /* not kept */ }
      return out;
    } catch { return { level: null, note: 'unknown' }; }
  }
}
