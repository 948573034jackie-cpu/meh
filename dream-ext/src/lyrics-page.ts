/**
 * Lyrics mode, the page (the stage of yt.ts, in its shadow DOM): what this module adds to the lines the renderer drew.
 * - a small bar at the top: where the lyrics come from ("timing guessed" when the times are not the source's own) and
 *   "Paste the lyrics" (always there; when no lyrics were found the bar says so).
 * The lines themselves, the words and their taps stay yt.ts's.
 */
import { lyricsNote, type Lyrics } from './lyrics';

const STYLE_ID = 'dr-lyr-style';
const CSS = `
.stage .page .lyr-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 0.8em; margin: 0 0 0.9em; font-family: var(--font-sans); font-size: 0.72em; line-height: 1.35; color: var(--fg-muted); }
.stage .page .lyr-bar .lyr-src { flex: 1 1 12em; min-width: 0; }
.stage .page .lyr-bar .lyr-src.none { color: var(--fg); font-weight: 600; }
.stage .page .lyr-bar button { flex: none; min-height: 44px; min-width: 44px; padding: 8px 14px; border-radius: 22px; font-size: 1em; }
`;

export interface LyricsPageDeps {
  /** the lyrics on the page; null = none were found (the video's subtitles are shown) */
  lyrics: Lyrics | null;
  /** the learner tapped "Paste the lyrics" */
  paste(): void;
}

type Doc = HTMLElement & { __lyr?: LyricsPageDeps };

/**
 * Called after the page's lines were drawn (and again whenever something changed): adds this module's parts to the
 * stage. `stage` is the stage element inside its shadow root.
 */
export function decorateLyricsPage(stage: HTMLElement, deps: LyricsPageDeps): void {
  const doc = stage.querySelector<Doc>('.page .doc-inner');
  const root = stage.getRootNode() as ShadowRoot | Document;
  if (!doc) return;
  if (!(root as ShadowRoot).getElementById?.(STYLE_ID) && !stage.querySelector(`#${STYLE_ID}`)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    stage.appendChild(st);
  }
  const first = !doc.__lyr;
  doc.__lyr = deps;
  if (first) doc.addEventListener('click', (ev) => onClick(doc, ev));
  doc.querySelectorAll('.lyr-bar').forEach((e) => e.remove());
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
}

/** lyrics mode is over (another mode on the same page): this module's parts go */
export function clearLyricsPage(stage: HTMLElement): void {
  stage.querySelectorAll('.lyr-bar').forEach((e) => e.remove());
}

function onClick(doc: Doc, ev: MouseEvent): void {
  const deps = doc.__lyr;
  const t = ev.target as HTMLElement | null;
  if (!deps || !t?.closest) return;
  if (t.closest('[data-lyr="paste"]')) { ev.stopPropagation(); ev.preventDefault(); deps.paste(); }
}
