/**
 * Lyrics mode, the page (the stage of yt.ts, in its shadow DOM): what this module adds to the lines the renderer drew.
 * - "About this song" at the top (it opens and closes with a tap; its text is as big as the page's);
 * - a small bar: where the lyrics come from ("timing guessed" when the times are not the source's own) and
 *   "Paste the lyrics" (always there; when no lyrics were found the bar says so);
 * - the headings of the song's parts between the lines: [Verse 1] [Chorus] … (not tappable);
 * - one line of the song per line of the page; the lines that have a note get a soft background. A tap on such a
 *   line opens its note right under it (and the tutor's voice reads it), a second tap closes it. Nothing is asked
 *   of the AI at a tap: the notes were written once for the whole song (lyrics-notes.ts).
 * The lines themselves, the words and their taps stay yt.ts's: a tap on a word the page marks as hard for you
 * (or still to learn) is the word's tap as before, also in a line with a note.
 */
import { lyricsNote, type Lyrics } from './lyrics';
import { notesByLine, sectionStarts, type SongNotes } from './lyrics-notes';

const STYLE_ID = 'dr-lyr-style';
const CSS = `
.stage[data-lyrics="1"] .page .s { display: block !important; margin: 0 !important; padding: 0.1em 0.3em; border-radius: 6px; }
.stage[data-lyrics="1"] .page .s::after { content: none !important; }
.stage[data-lyrics="1"] .page .para { margin: 0 0 0.9em; }
.stage .page .lyr-about { margin: 0 0 0.8em; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-elevated); font-family: var(--font-sans); overflow: hidden; }
.stage .page .lyr-about-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 48px; padding: 8px 14px; border: 0; border-radius: 0; background: transparent; color: var(--accent); font-size: 0.74em; font-weight: 700; text-align: left; cursor: pointer; }
.stage .page .lyr-about-h i { font-style: normal; color: var(--fg-muted); transition: transform 160ms; }
.stage .page .lyr-about[data-open="0"] .lyr-about-h i { transform: rotate(-90deg); }
.stage .page .lyr-about-t { padding: 0 14px 12px; font-size: 0.8em; line-height: 1.5; color: var(--fg); white-space: pre-wrap; }
.stage .page .lyr-about[data-open="0"] .lyr-about-t { display: none; }
.stage .page .lyr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 0.8em; margin: 0 0 0.9em; font-family: var(--font-sans); font-size: 0.66em; line-height: 1.35; color: var(--fg-muted); }
.stage .page .lyr-bar .lyr-src { flex: 1 1 12em; min-width: 0; }
.stage .page .lyr-bar .lyr-src.none { color: var(--fg); font-weight: 600; }
.stage .page .lyr-bar button { flex: none; min-height: 44px; min-width: 44px; padding: 8px 14px; border-radius: 22px; font-size: 1em; }
.stage .page .lyr-h { display: block; margin: 1.1em 0 0.25em; padding: 0 0.3em; font-family: var(--font-sans); font-size: 0.62em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-muted); cursor: default; -webkit-user-select: none; user-select: none; }
.stage .page .para:first-of-type > .lyr-h:first-child, .stage .page .lyr-h.top { margin-top: 0.2em; }
.stage[data-lyrics="1"] .page .s.lyr-noted { background: color-mix(in srgb, var(--fg) 13%, transparent); opacity: 0.8; }
.stage[data-lyrics="1"] .page .s.lyr-noted.cur { opacity: 1; background: color-mix(in srgb, var(--fg) 20%, transparent); }
.stage[data-lyrics="1"] .page .s.lyr-noted.lyr-open { opacity: 1; background: color-mix(in srgb, var(--accent) 26%, transparent); }
.stage .page .lyr-note { display: block; margin: 0.3em 0 0.7em; padding: 0.65em 0.85em; border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0; background: var(--bg-elevated); color: var(--fg); font-family: var(--font-sans); font-size: 0.78em; line-height: 1.5; cursor: pointer; }
.stage .page .lyr-note b { display: block; margin-bottom: 0.2em; font-size: 0.8em; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent); }
`;

export interface LyricsPageDeps {
  /** the lyrics on the page; null = none were found (the video's subtitles are shown) */
  lyrics: Lyrics | null;
  /** the song's story, parts and notes (null = not there: the tutor is off, or not written yet) */
  notes?: SongNotes | null;
  /** the page's sentence keys in the order of the lyrics' lines (line i = keys[i]) */
  keys?: readonly string[];
  /** the learner tapped "Paste the lyrics" */
  paste(): void;
  /** the tutor's voice reads this note now (null = no voice now); cancel() stops it */
  say?(text: string, line: number): { cancel(): void } | null;
}

interface State { deps: LyricsPageDeps; notes: Map<number, string>; open: number | null; voice: { cancel(): void } | null }
type Doc = HTMLElement & { __lyr?: State };

/** "About this song" stays as the learner left it (open or closed) while the page is drawn again */
let aboutOpen = true;

const lineEl = (doc: HTMLElement, st: State, line: number): HTMLElement | null => {
  const key = st.deps.keys?.[line];
  return key ? doc.querySelector<HTMLElement>(`.s[data-key="${key}"]`) : null;
};

/**
 * Called after the page's lines were drawn, and again whenever something changed (the notes came in): adds this
 * module's parts to the stage. `stage` is the stage element inside its shadow root.
 */
export function decorateLyricsPage(stage: HTMLElement, deps: LyricsPageDeps): void {
  const doc = stage.querySelector<Doc>('.page .doc-inner');
  if (!doc) return;
  if (!stage.querySelector(`#${STYLE_ID}`)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    stage.appendChild(st);
  }
  const before = doc.__lyr;
  before?.voice?.cancel();
  if (!before) doc.addEventListener('click', (ev) => onClick(doc, ev));
  const usable = !!deps.lyrics && !!deps.keys && deps.keys.length === deps.lyrics.lines.length;
  const st: State = { deps, notes: usable ? notesByLine(deps.notes ?? null, deps.lyrics) : new Map(), open: null, voice: null };
  doc.__lyr = st;
  doc.querySelectorAll('.lyr-about, .lyr-bar, .lyr-h, .lyr-note').forEach((e) => e.remove());
  doc.querySelectorAll<HTMLElement>('.s.lyr-noted').forEach((e) => { e.classList.remove('lyr-noted', 'lyr-open'); delete e.dataset.lyrLine; });

  // the bar: the source, "timing guessed", "Paste the lyrics"
  const bar = document.createElement('div');
  bar.className = 'lyr-bar';
  const src = document.createElement('span');
  src.className = `lyr-src${deps.lyrics ? '' : ' none'}`;
  src.textContent = deps.lyrics ? `${deps.lyrics.title}${deps.lyrics.artist ? ` — ${deps.lyrics.artist}` : ''} · ${lyricsNote(deps.lyrics)}` : 'No lyrics were found for this song. These are the video\'s subtitles.';
  const paste = document.createElement('button');
  paste.type = 'button';
  paste.dataset.lyr = 'paste';
  paste.textContent = deps.lyrics ? 'Paste other lyrics' : 'Paste the lyrics';
  bar.append(src, paste);
  doc.prepend(bar);

  // "About this song"
  const about = usable ? (deps.notes?.about ?? '').trim() : '';
  if (about) {
    const box = document.createElement('div');
    box.className = 'lyr-about';
    box.dataset.open = aboutOpen ? '1' : '0';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'lyr-about-h';
    head.dataset.lyr = 'about';
    head.setAttribute('aria-expanded', String(aboutOpen));
    head.innerHTML = '<span>About this song</span><i aria-hidden="true">▾</i>';
    const body = document.createElement('div');
    body.className = 'lyr-about-t';
    body.textContent = about;
    box.append(head, body);
    doc.prepend(box);
  }
  if (!usable) return;

  // the headings of the parts
  for (const [line, name] of sectionStarts(deps.notes ?? null)) {
    const el = lineEl(doc, st, line);
    if (!el) continue;
    const h = document.createElement('span');
    h.className = 'lyr-h';
    h.setAttribute('role', 'heading');
    h.setAttribute('aria-level', '3');
    h.textContent = `[${name}]`;
    el.before(h);
  }
  // the lines with a note
  for (const line of st.notes.keys()) {
    const el = lineEl(doc, st, line);
    if (!el) continue;
    el.classList.add('lyr-noted');
    el.dataset.lyrLine = String(line);
  }
  // (the page was drawn again while a note was open: it is open again, without the voice)
  if (before && before.open !== null && st.notes.has(before.open)) openNote(doc, st, before.open, false);
}

function closeNote(doc: HTMLElement, st: State): void {
  st.voice?.cancel();
  st.voice = null;
  st.open = null;
  doc.querySelectorAll('.lyr-note').forEach((e) => e.remove());
  doc.querySelectorAll('.s.lyr-open').forEach((e) => e.classList.remove('lyr-open'));
}

function openNote(doc: HTMLElement, st: State, line: number, voice: boolean): void {
  const el = lineEl(doc, st, line);
  const note = st.notes.get(line);
  if (!el || !note) return;
  closeNote(doc, st);
  const box = document.createElement('span');
  box.className = 'lyr-note';
  box.setAttribute('role', 'note');
  box.dataset.lyrNote = String(line);
  const head = document.createElement('b');
  head.textContent = 'What it means';
  const body = document.createElement('span');
  body.textContent = note;
  box.append(head, body);
  el.after(box);
  el.classList.add('lyr-open');
  st.open = line;
  // (all of the note on the screen)
  try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* an old engine */ }
  if (voice) { try { st.voice = st.deps.say?.(note, line) ?? null; } catch { st.voice = null; } }
}

/** a tap on a word that the page marks as hard for the learner (or still to learn): the word's own tap, as before */
const isHardWord = (t: HTMLElement): boolean => !!t.closest('.w.hl-unknown, .w.hl-learning, .ph.hl-unknown, .ph.hl-learning');

function onClick(doc: Doc, ev: MouseEvent): void {
  const st = doc.__lyr;
  const t = ev.target as HTMLElement | null;
  if (!st || !t?.closest) return;
  const mine = () => { ev.stopPropagation(); ev.preventDefault(); };
  if (t.closest('[data-lyr="paste"]')) { mine(); st.deps.paste(); return; }
  const head = t.closest<HTMLElement>('[data-lyr="about"]');
  if (head) {
    mine();
    aboutOpen = !aboutOpen;
    const box = head.closest<HTMLElement>('.lyr-about');
    if (box) box.dataset.open = aboutOpen ? '1' : '0';
    head.setAttribute('aria-expanded', String(aboutOpen));
    return;
  }
  if (t.closest('.lyr-about, .lyr-bar, .lyr-h')) { mine(); return; }
  if (t.closest('.lyr-note')) { mine(); closeNote(doc, st); return; }
  const s = t.closest<HTMLElement>('.s.lyr-noted');
  if (!s || t.closest('.sx') || isHardWord(t)) return;
  // (words being selected with the finger are not a tap)
  const sel = (doc.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ?? document.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 1) return;
  const line = Number(s.dataset.lyrLine);
  if (!Number.isInteger(line)) return;
  mine();
  if (st.open === line) closeNote(doc, st);
  else openNote(doc, st, line, true);
}
