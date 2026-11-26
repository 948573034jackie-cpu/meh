/**
 * The Speechify voice's rows in Settings, the same in both apps (I Know: the tutor's settings; I Know Book: its
 * Settings page and sheet). The Speechify KEY is never here: it lives only in the learner's own small server (the
 * Cloudflare Worker, speech-proxy/). Here are only the server's address (extras.speechifyUrl), the app code (the
 * Keychain, with the other keys: store.setKey('speechify'), never shown again), the voice (extras.speechifyVoice,
 * '' = the server's natural British default), Test, the counter (today / this month) and the daily limit.
 *
 * The rows are plain HTML (speechifyRowsHtml) and wire themselves (wireSpeechifyRows): every element has a
 * data-sfy / data-sfy-act name, never data-name / data-act, so the page around them (quick.ts, book.ts) never
 * handles them a second time.
 */
import * as store from './store';
import { speechifyVoiceList, speechifyVoiceName, type SpeechifyVoiceOption } from './voice';

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** the voice choice's button: next to Auto, Microsoft, OpenAI, ElevenLabs and the device's voice (all kept) */
export const SPEECHIFY_CHOICE: ['speechify', string] = ['speechify', 'Speechify (natural)'];
export const SPEECHIFY_ADDRESS_HINT = 'https://iknow-speech.yourname.workers.dev';
export const SPEECHIFY_HELP = 'Your Speechify key is NOT typed here: it is kept on your own small server. See the steps in Setup.';
/** the address and the app code are both saved: the Speechify voice can speak */
export const speechifyReady = (x: Pick<store.YtExtras, 'speechifyUrl'>, keys: store.Keys): boolean => !!x.speechifyUrl?.trim() && !!keys.speechify?.trim();

/** speech-proxy/SETUP.md in short, for "How to set up Speechify" (the owner reads it in the app) */
export const SPEECHIFY_STEPS: string[] = [
  'Make a free Cloudflare account: dash.cloudflare.com/sign-up (no website and no credit card needed).',
  'Make a Speechify API account: platform.speechify.ai → API Keys → Create key → Copy. The key starts with sk_. Keep the page open.',
  'On the Mac, open Terminal, type cd and a space, drag the speech-proxy folder (in the meh folder) into Terminal, press Return.',
  'Type npm install and press Return (one time, about 1 minute).',
  'Type npx wrangler login, sign in to Cloudflare in the browser, click Allow.',
  'Type npx wrangler secret put SPEECHIFY_API_KEY and paste your Speechify key. THIS is the only place for the key (you do not see it: that is normal).',
  'Type openssl rand -hex 24: that is your app code. Keep it in Notes. Then npx wrangler secret put APP_CODE and paste it.',
  'Type npx wrangler deploy. It prints your server address, like https://iknow-speech.yourname.workers.dev. Keep it in Notes. (It also makes the character counter by itself.)',
  'Open that address in Safari: "App code missing or wrong" means it works.',
  'Here, in both apps: paste the address into Server address and press Save, paste the app code into App code and press Save, then Test. Choose Speechify (or keep Auto).',
  'The other way for the key: dash.cloudflare.com → Workers & Pages → iknow-speech → Settings → Variables and Secrets → Add → Type Secret, name SPEECHIFY_API_KEY, paste the key, Deploy.',
];

// ---- the voice list from the server: asked once, kept 5 minutes (the settings are drawn again after every change) ----
let listMemo: { key: string; at: number; p: Promise<{ voices: SpeechifyVoiceOption[]; default: string | null }> } | null = null;
function voicesFor(key: string): Promise<{ voices: SpeechifyVoiceOption[]; default: string | null }> {
  if (listMemo && listMemo.key === key && Date.now() - listMemo.at < 5 * 60_000) return listMemo.p;
  const p = speechifyVoiceList();
  listMemo = { key, at: Date.now(), p };
  // (a failure is not kept long: the learner fixes the address and the list comes at the next look)
  p.catch(() => { if (listMemo?.p === p) listMemo = { ...listMemo, at: Date.now() - 5 * 60_000 + 8_000 }; });
  return p;
}
/** for tests and after a new address or app code: the next look asks the server again */
export function forgetSpeechifyVoices(): void { listMemo = null; }

/** The rows (the voice list, the counter and the test answer fill in by themselves once wired). */
export function speechifyRowsHtml(x: store.YtExtras, keys: store.Keys, o: { device?: string } = {}): string {
  const device = o.device ?? 'iPhone';
  const ready = speechifyReady(x, keys);
  const limit = Math.max(0, Math.floor(x.speechifyDailyChars ?? 20_000));
  const steps = SPEECHIFY_STEPS.map((s) => `<li>${esc(s)}</li>`).join('');
  return `<div class="sfy" data-sfy-box="1">
  <p class="sfy-title">Speechify</p>
  ${ready ? '' : `<p class="sfy-warn">Add the server address and the app code: until then you hear the ${esc(device)} voice.</p>`}
  <div class="sfy-row"><label class="sfy-l" for="sfy-url">Server address</label><div class="sfy-in"><input id="sfy-url" type="url" data-sfy="url" value="${esc(x.speechifyUrl ?? '')}" placeholder="${SPEECHIFY_ADDRESS_HINT}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"><button type="button" data-sfy-act="save-url">Save</button></div></div>
  <div class="sfy-row"><label class="sfy-l" for="sfy-code">App code</label><div class="sfy-in"><input id="sfy-code" type="password" data-sfy="code" value="" placeholder="${keys.speechify ? 'saved (hidden): paste a new one to change it' : 'paste your app code'}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"><button type="button" data-sfy-act="save-code">Save</button><button type="button" class="sfy-small" data-sfy-act="remove-code"${keys.speechify ? '' : ' hidden'}>Remove</button></div></div>
  <div class="sfy-row"><label class="sfy-l" for="sfy-voice">Voice</label><div class="sfy-in"><select id="sfy-voice" data-sfy="voice"><option value="">Default (British)</option>${x.speechifyVoice ? `<option value="${esc(x.speechifyVoice)}" selected>${esc(x.speechifyVoice)}</option>` : ''}</select></div></div>
  <p class="sfy-note" data-sfy-out="voices">${ready ? 'Asking your server for the voices…' : 'The voices come from your server once the address and the app code are saved.'}</p>
  <div class="sfy-row sfy-test"><button type="button" data-sfy-act="test">Test</button><span class="sfy-msg" data-sfy-out="test" role="status"></span></div>
  <p class="sfy-usage" data-sfy-out="usage">Speechify today: … · this month: …</p>
  <div class="sfy-row"><label class="sfy-l" for="sfy-limit">Daily limit</label><div class="sfy-in"><input id="sfy-limit" type="number" data-sfy="limit" min="0" step="1000" value="${limit}" inputmode="numeric"><span class="sfy-unit">characters</span><button type="button" data-sfy-act="save-limit">Save</button></div></div>
  <p class="sfy-note">Then the free ${esc(device)} voice until tomorrow. Your server has its own limit too (DAILY_CHAR_LIMIT).</p>
  <p class="sfy-help">${esc(SPEECHIFY_HELP)}</p>
  <button type="button" class="sfy-steps-btn" data-sfy-act="steps" aria-expanded="false">How to set up Speechify</button>
  <ol class="sfy-steps" data-sfy-out="steps" hidden>${steps}</ol>
</div>`;
}

export interface SpeechifyHost {
  toast(text: string, ms?: number): void;
  /** the address, the app code or the voice changed: the page makes its voice again (and may draw itself again) */
  changed?(): void;
}

/** the counter line: this device's count; and the server's own (both apps together) when it answers */
async function paintUsage(box: HTMLElement, ready: boolean): Promise<void> {
  const out = box.querySelector<HTMLElement>('[data-sfy-out="usage"]');
  if (!out) return;
  const u = await store.getSpeechifyUsage().catch(() => null);
  if (u) out.textContent = store.speechifyUsageText(u);
  if (!ready) return;
  const r = (await chrome.runtime.sendMessage({ type: 'dream-speechify-usage' }).catch(() => null)) as { server?: { today: number; monthChars: number } | null } | null;
  if (r?.server && out.isConnected) out.textContent = `${out.textContent} · your server (both apps): today ${r.server.today.toLocaleString('en-US')}, this month ${r.server.monthChars.toLocaleString('en-US')}`;
}

/** the voice picker: the server's list, the British default first (as the server sends it) and marked ★ */
async function paintVoices(box: HTMLElement, x: store.YtExtras, ready: boolean): Promise<void> {
  const sel = box.querySelector<HTMLSelectElement>('[data-sfy="voice"]');
  const note = box.querySelector<HTMLElement>('[data-sfy-out="voices"]');
  if (!sel || !note || !ready) return;
  try {
    const r = await voicesFor(`${x.speechifyUrl.trim()}`);
    if (!sel.isConnected) return;
    const cur = x.speechifyVoice ?? '';
    const list = r.voices;
    sel.innerHTML = `<option value=""${cur ? '' : ' selected'}>Default (British)</option>${list.map((v) => `<option value="${esc(v.id)}"${v.id === cur ? ' selected' : ''}>${esc(speechifyVoiceName(v))}</option>`).join('')}`;
    note.textContent = list.length ? `${list.length} English voices from your server. ★ = the natural British default.` : 'Your server sent no voices: the default is used.';
  } catch (e) {
    if (note.isConnected) note.textContent = `No voice list: ${(e as Error).message}`;
  }
}

/** handles the rows inside `root` (call it after every drawing of them) */
export function wireSpeechifyRows(root: ParentNode, host: SpeechifyHost): void {
  const box = root.querySelector<HTMLElement>('[data-sfy-box]');
  if (!box) return;
  void (async () => {
    const [x, keys] = await Promise.all([store.getExtras(), store.getKeys()]);
    const ready = speechifyReady(x, keys);
    void paintUsage(box, ready);
    void paintVoices(box, x, ready);
  })();
  const input = (name: string) => box.querySelector<HTMLInputElement>(`[data-sfy="${name}"]`);
  const say = (text: string, good: boolean) => { const m = box.querySelector<HTMLElement>('[data-sfy-out="test"]'); if (m) { m.textContent = text; m.classList.toggle('bad', !good); m.classList.toggle('ok', good); } };
  const saveLimit = async () => {
    const v = input('limit')?.value.trim() ?? '';
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) { host.toast('Type a number of characters (0 = no Speechify).'); return; }
    const chars = Math.max(0, Math.round(n));
    const before = Math.max(0, Math.floor((await store.getExtras()).speechifyDailyChars ?? 20_000));
    await store.patchExtras({ speechifyDailyChars: chars });
    // (a higher limit: "done for today" is forgotten, Speechify may speak again)
    if (chars > before) await store.clearSpeechifyStop().catch(() => undefined);
    host.toast(chars ? `Daily limit: ${chars.toLocaleString('en-US')} characters.` : 'Daily limit 0: the Speechify voice stays quiet, the free voice reads.');
    void paintUsage(box, speechifyReady(await store.getExtras(), await store.getKeys()));
  };
  box.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-sfy-act]');
    if (!b) return;
    ev.stopPropagation();
    ev.preventDefault();
    const act = b.dataset.sfyAct;
    if (act === 'save-url') {
      const v = (input('url')?.value ?? '').trim().replace(/\/+$/, '');
      if (v && !/^https:\/\//i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(v)) { host.toast('The address starts with https://'); return; }
      forgetSpeechifyVoices();
      void store.patchExtras({ speechifyUrl: v }).then(() => { host.toast(v ? 'Server address saved.' : 'Server address removed.'); host.changed?.(); });
    } else if (act === 'save-code') {
      const el = input('code');
      const v = (el?.value ?? '').trim();
      // (the code goes to the Keychain with the other keys; the box is emptied at once and never shows it again)
      if (el) el.value = '';
      // (an empty box never removes the saved code: that is the Remove button)
      if (!v) { void store.getKeys().then((k) => host.toast(k.speechify ? 'The box is empty: the saved app code is kept.' : 'Paste the app code first.')); return; }
      forgetSpeechifyVoices();
      void store.setKey('speechify', v).then(() => {
        if (el) el.placeholder = 'saved (hidden): paste a new one to change it';
        const rm = box.querySelector<HTMLElement>('[data-sfy-act="remove-code"]');
        if (rm) rm.hidden = false;
        host.toast('App code saved (in the Keychain).');
        host.changed?.();
      });
    } else if (act === 'remove-code') {
      const el = input('code');
      if (el) el.value = '';
      forgetSpeechifyVoices();
      void store.setKey('speechify', '').then(() => {
        if (el) el.placeholder = 'paste your app code';
        b.hidden = true;
        host.toast('App code removed.');
        host.changed?.();
      });
    } else if (act === 'save-limit') void saveLimit();
    else if (act === 'test') {
      say('Testing…', true);
      void (chrome.runtime.sendMessage({ type: 'dream-speechify-test' }) as Promise<{ ok: boolean; message: string } | undefined>).then(
        (r) => { say(r?.message ?? 'No answer.', !!r?.ok); host.toast(r?.message ?? 'No answer.', 7000); },
        () => say('No answer.', false));
    } else if (act === 'steps') {
      const ol = box.querySelector<HTMLElement>('[data-sfy-out="steps"]');
      if (!ol) return;
      ol.hidden = !ol.hidden;
      b.setAttribute('aria-expanded', String(!ol.hidden));
    }
  });
  box.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if (!(t instanceof HTMLElement) || !t.dataset.sfy) return;
    ev.stopPropagation();
    if (t.dataset.sfy === 'voice') void store.patchExtras({ speechifyVoice: (t as HTMLSelectElement).value }).then(() => { host.toast('Voice changed.'); host.changed?.(); });
    else if (t.dataset.sfy === 'limit') void saveLimit();
  });
  // (typing here never reaches the page's own keys, nor the page around: input events stay in the rows)
  box.addEventListener('input', (ev) => ev.stopPropagation());
  for (const name of ['keydown', 'keyup', 'keypress']) box.addEventListener(name, (ev) => ev.stopPropagation());
}

/** the rows' look, for a page or a shadow root (the one look's tokens only) */
export const SPEECHIFY_CSS = `.sfy{display:flex;flex-direction:column;gap:var(--t-space-s);padding:var(--t-space-s) 0 var(--t-space-xs);border-top:1px solid var(--t-line);margin-top:var(--t-space-s)}
.sfy .sfy-title{margin:var(--t-space-xs) 0 0;font:600 var(--t-size-caption)/1.2 var(--t-font-ui);letter-spacing:.1em;text-transform:uppercase;color:var(--t-muted)}
.sfy .sfy-row{display:flex;flex-direction:column;gap:var(--t-space-xs)}
.sfy .sfy-row.sfy-test{flex-direction:row;align-items:center;flex-wrap:wrap;gap:var(--t-space-s)}
.sfy .sfy-l{font:500 var(--t-size-footnote)/1.3 var(--t-font-ui);color:var(--t-muted)}
.sfy .sfy-in{display:flex;gap:var(--t-space-s);align-items:center;min-width:0}
.sfy input,.sfy select{flex:1;min-width:0;width:auto;max-width:none;min-height:var(--t-control);border-radius:var(--t-radius-control);border:1px solid var(--t-line);background:var(--t-sunken);color:var(--t-text);font:400 var(--t-size-body)/1.2 var(--t-font-ui);padding:0 var(--t-space-m);-webkit-user-select:text;user-select:text}
.sfy select{-webkit-appearance:none;appearance:none;padding-right:36px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23857F73' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 10l5 5 5-5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;background-size:18px}
.sfy input[type=number]{flex:0 1 140px}
.sfy .sfy-unit{color:var(--t-muted);font-size:var(--t-size-footnote)}
.sfy button{flex:none;min-height:var(--t-control);padding:0 var(--t-space-l);border-radius:var(--t-radius-control);border:1px solid var(--t-line-strong);background:var(--t-raised);color:var(--t-text);font:var(--t-weight-button) var(--t-size-button)/1 var(--t-font-ui);cursor:pointer}
.sfy button:active{background:var(--t-hover)}
.sfy button.sfy-small{padding:0 var(--t-space-m);border-color:transparent;background:transparent;color:var(--t-muted)}
.sfy .sfy-steps-btn{align-self:flex-start;border-color:transparent;background:transparent;color:var(--t-accent);padding:0}
.sfy p{margin:0}
.sfy .sfy-note,.sfy .sfy-help,.sfy .sfy-usage{font:400 var(--t-size-footnote)/1.45 var(--t-font-ui);color:var(--t-muted)}
.sfy .sfy-usage{color:var(--t-text)}
.sfy .sfy-help{color:var(--t-text)}
.sfy .sfy-warn{font:400 var(--t-size-footnote)/1.4 var(--t-font-ui);color:var(--t-off)}
.sfy .sfy-msg{font:400 var(--t-size-footnote)/1.4 var(--t-font-ui);color:var(--t-muted);flex:1;min-width:160px}
.sfy .sfy-msg.ok{color:var(--t-on)}.sfy .sfy-msg.bad{color:var(--t-off)}
.sfy .sfy-steps{margin:0;padding-left:1.3em;font:400 var(--t-size-footnote)/1.5 var(--t-font-ui);color:var(--t-text)}
.sfy .sfy-steps li{margin:0 0 var(--t-space-s)}
.sfy [hidden]{display:none !important}`;
