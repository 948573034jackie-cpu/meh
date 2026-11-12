/**
 * Lyrics mode: "Paste the lyrics". When no lyrics are found for a song (or the wrong ones), the learner pastes or types
 * them into a big box and taps "Use these lyrics"; they are timed and kept for this video (lyrics-find.ts).
 * Over the page, in its own shadow DOM (so it also opens when the video has no subtitles and no page was made).
 */
const CSS = `:host{all:initial;position:fixed;inset:0;z-index:2147483601;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);font:16px/1.4 -apple-system,system-ui,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%;
--bg:#fff;--fg:#1f2328;--muted:#5f6368;--line:#d5d9de;--chip:#e8ebee;--blue:#1a73e8;--on-blue:#fff}
@media (prefers-color-scheme:dark){:host{--bg:#17191e;--fg:#e6e3dc;--muted:#a4a19a;--line:#3a3f48;--chip:#2c3038;--blue:#8ab4f8;--on-blue:#10141b}}
*{box-sizing:border-box}
.card{background:var(--bg);color:var(--fg);border-radius:14px;width:min(680px,100vw);height:min(100dvh,860px);display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.45);overflow:hidden;font-size:var(--fs,16px)}
@media (max-width:700px),(max-height:600px){.card{border-radius:0;height:100dvh;width:100vw}}
header{display:flex;align-items:center;gap:10px;padding:max(10px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) 8px max(14px,env(safe-area-inset-left));border-bottom:1px solid var(--line);flex:none}
h2{margin:0;font-size:1.15em;flex:1}
button{font:inherit;cursor:pointer;border:0;border-radius:12px;padding:10px 14px;min-height:48px;color:inherit;background:var(--chip);touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.x{min-width:48px;font-size:18px;font-weight:600}
.body{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:10px max(14px,env(safe-area-inset-right)) calc(44px + env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left));overflow-y:auto;-webkit-overflow-scrolling:touch}
p{margin:0;color:var(--muted);font-size:.85em}
p.song{color:var(--fg);font-weight:600;font-size:.95em}
textarea{font:inherit;flex:1;min-height:160px;width:100%;border:1px solid var(--line);border-radius:12px;padding:10px 12px;resize:none;color:var(--fg);background:var(--bg);line-height:1.5}
.use{background:var(--blue);color:var(--on-blue);font-weight:700;font-size:1.05em;min-height:60px;flex:none}
.use:disabled{opacity:.55}
.status{min-height:1.4em;color:var(--fg)}`;

let open: { close(): void } | null = null;

export interface PasteBoxOptions {
  /** the song (or the video's title) the lyrics are for */
  title: string;
  /** why the box is here: "No lyrics were found for this song." */
  why?: string;
  /** the "Text size" setting in px */
  textSize?: number;
  /** the learner tapped "Use these lyrics": true = they are in use now (the box closes), false = there were no lines in it */
  use(text: string): Promise<boolean> | boolean;
}

/** the box is on the screen */
export const pasteBoxIsOpen = (): boolean => !!open;

/** Opens the box over the page (one at a time). */
export function openPasteBox(o: PasteBoxOptions): { close(): void } {
  if (open) return open;
  const host = document.createElement('div');
  host.id = 'dr-lyrics-paste-host';
  const root = host.attachShadow({ mode: 'open' });
  // (typing here must not start YouTube's shortcuts)
  for (const type of ['keydown', 'keyup', 'keypress', 'click']) host.addEventListener(type, (e) => e.stopPropagation());
  const fs = Math.max(14, Math.min(30, Math.round(o.textSize ?? 16)));
  root.innerHTML = `<style>${CSS}</style><div class="card" role="dialog" aria-label="Paste the lyrics" style="--fs:${fs}px">
<header><h2>Paste the lyrics</h2><button class="x" data-a="close" aria-label="Close">✕</button></header>
<div class="body">
<p class="song"></p>
<p class="why"></p>
<textarea placeholder="Paste or type the lyrics here, one line of the song on each line…" aria-label="The lyrics" autocapitalize="sentences" spellcheck="false"></textarea>
<button class="use" data-a="use">Use these lyrics</button>
<p class="status" aria-live="polite"></p>
</div></div>`;
  const $ = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;
  $<HTMLElement>('.song').textContent = o.title;
  $<HTMLElement>('.why').textContent = `${o.why ? `${o.why} ` : ''}Copy the song's lyrics from any place you like, paste them here (or type them), then tap the button. A blank line starts a new part. They are kept for this video.`;
  const me = {
    close: (): void => { host.remove(); if (open === me) open = null; },
  };
  const box = $<HTMLTextAreaElement>('textarea');
  const btn = $<HTMLButtonElement>('[data-a=use]');
  const status = $<HTMLElement>('.status');
  $('[data-a=close]').addEventListener('click', () => me.close());
  host.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') me.close(); });
  btn.addEventListener('click', () => {
    const text = box.value;
    if (!text.trim()) { status.textContent = 'Paste or type the lyrics first.'; return; }
    btn.disabled = true;
    status.textContent = 'Putting the lyrics in time with the song…';
    void Promise.resolve().then(() => o.use(text)).then((ok) => {
      if (ok) me.close();
      else { btn.disabled = false; status.textContent = 'I could not read any lines in this text. Try again.'; }
    }, () => { btn.disabled = false; status.textContent = 'That did not work. Try again.'; });
  });
  (document.body ?? document.documentElement).appendChild(host);
  open = me;
  return me;
}
