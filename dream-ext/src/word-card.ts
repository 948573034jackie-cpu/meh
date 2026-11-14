/**
 * The word card of the reader and of the browser: the word, its pronunciation, its Chinese meaning, big and simple.
 * A tap on the card = "I know this word". One button under it explains (or translates) the whole sentence.
 * It lives in a CLOSED shadow root on one empty element, so a web page cannot read it or restyle it, and nothing of
 * the page is changed. The browser's "Open link" bubble is here too.
 */
export interface CardView {
  /** 'word': a tap on the card = I know; 'sentence' / 'note': a tap closes it */
  kind: 'word' | 'sentence' | 'note';
  word: string;
  ipa?: string;
  zh?: string;
  /** the explanation or the translation, as text */
  text?: string;
  /** the small line under the word ("Tap here = I know this word") */
  hint?: string;
  /** the button's words ('' = no button) */
  button?: string;
  /** the tutor is thinking or talking */
  busy?: boolean;
}
export interface CardHooks {
  /** a tap on a word's card */
  onKnow(): void;
  /** the button under the word */
  onButton(): void;
  /** a tap on a sentence / note card, or its × */
  onClose(): void;
  /** the bubble came or went */
  onBubble?(): void;
}
export interface CardLook { sizePx: number; look: 'day' | 'night' | 'auto' }

const CSS = `
:host{all:initial}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.card{position:fixed;left:8px;right:8px;bottom:12px;margin:0 auto;max-width:640px;max-height:62vh;overflow:auto;-webkit-overflow-scrolling:touch;
  border-radius:18px;padding:14px 16px 12px;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
  background:var(--bg);color:var(--fg);box-shadow:0 6px 28px rgba(0,0,0,.35);border:1px solid var(--line);cursor:pointer;
  font-size:calc(var(--size) * 1px);line-height:1.4;touch-action:manipulation;-webkit-user-select:none;user-select:none}
.card[hidden],.bubble[hidden]{display:none !important}
.top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-right:44px}
.word{font-size:1.5em;font-weight:700;letter-spacing:.01em;word-break:break-word}
.card.sentence .word,.card.note .word{font-size:1em;font-weight:600;color:var(--muted)}
.ipa{font-size:1em;color:var(--muted);font-family:"Lucida Sans Unicode","Doulos SIL",-apple-system,sans-serif}
.zh{font-size:1.15em;margin-top:4px;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:var(--zh)}
.text{font-size:.9em;margin-top:8px;white-space:pre-wrap}
.hint{font-size:14px;color:var(--muted);margin-top:8px}
.busy{display:inline-block;margin-left:6px;color:var(--muted);font-size:.8em}
.row{display:flex;gap:8px;margin-top:10px}
button{font:inherit;font-size:max(16px,.8em);min-height:48px;min-width:48px;border-radius:12px;border:1px solid var(--line);background:var(--btn);color:var(--fg);padding:8px 16px;cursor:pointer;touch-action:manipulation}
.x{position:absolute;right:6px;top:6px;border:0;background:transparent;font-size:24px;line-height:1;color:var(--muted);padding:0;width:48px;height:48px}
.wrap{position:relative}
.bubble{position:fixed;min-height:48px;min-width:120px;padding:10px 18px;border-radius:24px;border:0;background:#1a73e8;color:#fff;font:600 17px -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
  box-shadow:0 4px 18px rgba(0,0,0,.35)}
.root{--bg:#ffffff;--fg:#111418;--muted:#5f6670;--line:rgba(0,0,0,.14);--btn:#f1f3f5;--zh:#0b57d0}
.root.night{--bg:#1c1f25;--fg:#f2eee6;--muted:#a09b92;--line:rgba(255,255,255,.18);--btn:#2a2f38;--zh:#ffd666}
@media (prefers-color-scheme: dark){.root.auto{--bg:#1c1f25;--fg:#f2eee6;--muted:#a09b92;--line:rgba(255,255,255,.18);--btn:#2a2f38;--zh:#ffd666}}
`;

export class WordCard {
  readonly host: HTMLElement;
  private root: ShadowRoot;
  private wrap: HTMLElement;
  private card: HTMLElement;
  private bubbleEl: HTMLButtonElement;
  private view: CardView | null = null;
  private bubbleRun: (() => void) | null = null;
  private bubbleTimer: ReturnType<typeof setTimeout> | null = null;

  /** `trustedOnly`: only real touches count (a web page cannot press the card by script) */
  constructor(private doc: Document, private hooks: CardHooks, look: CardLook, private trustedOnly = false) {
    const host = doc.createElement('div');
    host.setAttribute('style', 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647');
    this.host = host;
    this.root = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    this.wrap = doc.createElement('div');
    this.wrap.className = 'root';
    this.card = doc.createElement('div');
    this.card.className = 'card';
    this.card.hidden = true;
    this.card.setAttribute('role', 'dialog');
    this.bubbleEl = doc.createElement('button');
    this.bubbleEl.className = 'bubble';
    this.bubbleEl.hidden = true;
    this.wrap.append(this.card, this.bubbleEl);
    this.root.append(style, this.wrap);
    this.setLook(look);
    const ok = (e: Event) => !this.trustedOnly || e.isTrusted;
    this.card.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ok(e) || !this.view) return;
      const t = e.target as HTMLElement;
      if (t.closest('[data-a=button]')) { this.hooks.onButton(); return; }
      if (t.closest('[data-a=x]') || this.view.kind !== 'word') { this.hooks.onClose(); return; }
      this.hooks.onKnow();
    });
    this.bubbleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!ok(e)) return;
      const run = this.bubbleRun;
      this.hideBubble();
      run?.();
    });
    // (the page under it never sees what happens on the card)
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'dblclick', 'contextmenu']) host.addEventListener(type, (e) => e.stopPropagation());
  }

  private mount(): void { if (!this.host.isConnected) (this.doc.body ?? this.doc.documentElement).appendChild(this.host); }

  setLook(look: CardLook): void {
    this.wrap.className = `root ${look.look}`;
    this.wrap.style.setProperty('--size', String(Math.max(16, Math.min(40, look.sizePx))));
  }

  get open(): boolean { return !!this.view; }
  get current(): CardView | null { return this.view; }

  show(view: CardView): void {
    this.view = { ...view };
    this.mount();
    this.paint();
  }

  /** the open card changes (the Chinese came, the explanation grows) */
  update(patch: Partial<CardView>): void {
    if (!this.view) return;
    this.view = { ...this.view, ...patch };
    this.paint();
  }

  hide(): void {
    this.view = null;
    this.card.hidden = true;
    this.card.textContent = '';
  }

  private paint(): void {
    const v = this.view;
    if (!v) return;
    const d = this.doc;
    const el = (tag: string, cls: string, text?: string): HTMLElement => { const e = d.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const box = el('div', 'wrap');
    const top = el('div', 'top');
    top.append(el('span', 'word', v.word));
    if (v.ipa) top.append(el('span', 'ipa', v.ipa));
    if (v.busy) top.append(el('span', 'busy', '…'));
    box.append(top);
    if (v.zh) box.append(el('div', 'zh', v.zh));
    if (v.text) box.append(el('div', 'text', v.text));
    if (v.hint) box.append(el('div', 'hint', v.hint));
    if (v.button) {
      const row = el('div', 'row');
      const b = el('button', '', v.button);
      b.dataset.a = 'button';
      row.append(b);
      box.append(row);
    }
    const x = el('button', 'x', '×');
    x.dataset.a = 'x';
    x.setAttribute('aria-label', 'Close');
    box.append(x);
    this.card.className = `card ${v.kind}`;
    this.card.replaceChildren(box);
    this.card.hidden = false;
  }

  /** a small button near the finger for `ms` milliseconds ("Open link") */
  bubble(x: number, y: number, label: string, run: () => void, ms = 4000): void {
    this.mount();
    this.hideBubble();
    const vw = this.doc.documentElement.clientWidth || 320, vh = this.doc.defaultView?.innerHeight ?? 600;
    this.bubbleEl.textContent = label;
    this.bubbleEl.hidden = false;
    const w = this.bubbleEl.offsetWidth || 140, h = this.bubbleEl.offsetHeight || 48;
    // above the finger when there is room, else under it; never over the card's place at the bottom
    const top = y - h - 14 >= 8 ? y - h - 14 : Math.min(vh - h - 8, y + 18);
    this.bubbleEl.style.left = `${Math.max(8, Math.min(vw - w - 8, x - w / 2))}px`;
    this.bubbleEl.style.top = `${Math.max(8, top)}px`;
    this.bubbleRun = run;
    this.bubbleTimer = setTimeout(() => this.hideBubble(), ms);
    this.hooks.onBubble?.();
  }

  hideBubble(): void {
    if (this.bubbleTimer) { clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
    this.bubbleRun = null;
    if (this.bubbleEl.hidden) return;
    this.bubbleEl.hidden = true;
    this.hooks.onBubble?.();
  }

  get bubbleOpen(): boolean { return !this.bubbleEl.hidden; }

  /** where the card and the bubble are on the screen (the tests tap there) */
  rects(): { card: number[] | null; bubble: number[] | null } {
    const r = (e: HTMLElement) => { if (e.hidden) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    return { card: r(this.card), bubble: r(this.bubbleEl) };
  }

  /** the button's place (the tests tap there) */
  buttonRect(): number[] | null {
    const b = this.card.querySelector<HTMLElement>('[data-a=button]');
    if (!b || this.card.hidden) return null;
    const r = b.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }

  remove(): void { this.hide(); this.hideBubble(); this.host.remove(); }
}
