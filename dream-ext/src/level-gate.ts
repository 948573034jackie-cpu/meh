/**
 * The "Level Check" screen before a video, book, PDF or text: "Check my words" (a tap test built from this text) or
 * "Skip, just play". Tapped chips = known, the others = don't know. After "Done": the % per group and the level, then it plays.
 */
import { GROUP_LABEL, type GroupId, type GroupScores } from './level-db';
import { scoreTest, type TestGroups } from './level-check';

export interface GateHooks {
  /** the test of this text; null = it could not be read */
  build(): Promise<TestGroups | null>;
  /** the result is saved; what the level is now */
  save(shown: TestGroups, known: ReadonlySet<string>, scores: GroupScores): Promise<string>;
  /** the gate is closed: playing may start */
  done(how: 'skip' | 'test'): void;
}

const CSS = `:host{all:initial;position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);font:14px/1.35 -apple-system,system-ui,"Segoe UI",sans-serif;color:#1f2328}
*{box-sizing:border-box}
.card{background:#fff;border-radius:14px;width:min(520px,100vw);max-height:100dvh;display:flex;flex-direction:column;padding:12px 14px;box-shadow:0 8px 40px rgba(0,0,0,.45)}
h2{margin:0 0 2px;font-size:17px}
.sub{color:#5f6368;font-size:12px;margin:0 0 8px}
.main{display:flex;flex-direction:column;gap:8px;margin-top:6px}
button{font:inherit;cursor:pointer;border:0;border-radius:10px;padding:10px 12px}
.go{background:#1a73e8;color:#fff;font-weight:600}
.skip{background:#eef0f2;color:#1f2328}
.scroll{overflow-y:auto;flex:1;min-height:0}
h3{margin:4px 0 3px;font-size:12px;line-height:18px;color:#5f6368;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{padding:4px 10px;height:26px;line-height:18px;border-radius:13px;background:#eef0f2;color:#1f2328;font-size:13px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.chip[aria-pressed=true]{background:#1e8e3e;color:#fff}
.done{margin-top:8px;background:#1a73e8;color:#fff;font-weight:600;flex:none}
table{border-collapse:collapse;width:100%;margin:6px 0}
td{padding:4px 2px;border-top:1px solid #eef0f2}
td:last-child{text-align:right;font-weight:600}
.level{font-size:16px;font-weight:600;margin:6px 0}`;

export class LevelGate {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private hooks: GateHooks, private title: string) {}

  get open(): boolean { return !!this.host; }

  show(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.id = 'dr-level-host';
    const root = host.attachShadow({ mode: 'open' });
    (document.body ?? document.documentElement).appendChild(host);
    this.host = host; this.root = root;
    // (the page's own keys and clicks stay out of it)
    for (const type of ['keydown', 'keyup', 'click']) host.addEventListener(type, (e) => e.stopPropagation());
    this.ask();
  }

  setTitle(title: string): void { this.title = title; const el = this.root?.querySelector('.sub[data-title]'); if (el) el.textContent = title; }

  close(how?: 'skip' | 'test'): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.host?.remove();
    this.host = null; this.root = null;
    if (how) this.hooks.done(how);
  }

  private page(html: string): void {
    if (this.root) this.root.innerHTML = `<style>${CSS}</style><div class="card">${html}</div>`;
  }

  private ask(): void {
    this.page(`<h2>Level Check</h2><p class="sub" data-title></p><div class="main"><button class="go" data-a="check">Check my words</button><button class="skip" data-a="skip">Skip, just play</button></div>`);
    this.setTitle(this.title);
    this.root!.querySelector('[data-a=check]')!.addEventListener('click', () => void this.test());
    this.root!.querySelector('[data-a=skip]')!.addEventListener('click', () => this.close('skip'));
  }

  private async test(): Promise<void> {
    this.page(`<h2>Level Check</h2><p class="sub">Finding the words of this text…</p><div class="main"><button class="skip" data-a="skip">Skip, just play</button></div>`);
    this.root!.querySelector('[data-a=skip]')!.addEventListener('click', () => this.close('skip'));
    let shown: TestGroups | null = null;
    try { shown = await this.hooks.build(); } catch { /* below */ }
    if (!this.root) return;
    if (!shown || !(shown.b2.length + shown.c1.length + shown.c2.length)) {
      this.page(`<h2>Level Check</h2><p class="sub">${shown ? 'This text has no new words to test: everything above B2 in it is already in your database.' : 'The text could not be read for a test.'}</p><div class="main"><button class="go" data-a="skip">Play</button></div>`);
      this.root.querySelector('[data-a=skip]')!.addEventListener('click', () => this.close('skip'));
      return;
    }
    this.chips(shown);
  }

  private chips(shown: TestGroups): void {
    const known = new Set<string>();
    const group = (id: GroupId) => (shown[id].length ? `<h3>${GROUP_LABEL[id]}</h3><div class="chips">${shown[id].map((it, i) => `<button class="chip" data-g="${id}" data-i="${i}" aria-pressed="false"></button>`).join('')}</div>` : '');
    this.page(`<h2>Tap the ones you know</h2><div class="scroll">${group('b2')}${group('c1')}${group('c2')}</div><button class="done">Done</button>`);
    const root = this.root!;
    for (const b of root.querySelectorAll<HTMLButtonElement>('.chip')) {
      const it = shown[b.dataset.g as GroupId][Number(b.dataset.i)];
      b.textContent = it.text;
      b.title = it.text;
      b.addEventListener('click', () => {
        if (known.has(it.key)) known.delete(it.key); else known.add(it.key);
        b.setAttribute('aria-pressed', String(known.has(it.key)));
      });
    }
    root.querySelector('.done')!.addEventListener('click', () => void this.finish(shown, known));
  }

  private async finish(shown: TestGroups, known: ReadonlySet<string>): Promise<void> {
    const scores = scoreTest(shown, known);
    const level = await this.hooks.save(shown, known, scores).catch(() => '');
    if (!this.root) return;
    const row = (id: GroupId) => (scores[id] === null ? '' : `<tr><td>${GROUP_LABEL[id]}</td><td>${scores[id]}%</td></tr>`);
    this.page(`<h2>Your result</h2><table>${row('b2')}${row('c1')}${row('c2')}</table>${level ? `<p class="level">Estimated level: ${level}</p>` : ''}<button class="go" data-a="play">Play</button>`);
    this.root.querySelector('[data-a=play]')!.addEventListener('click', () => this.close('test'));
    this.timer = setTimeout(() => this.close('test'), 3500);
  }
}
