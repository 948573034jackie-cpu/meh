/**
 * I Know's Settings tab: the tutor's own settings, open WITHOUT a video (settings.html, in the app's web view).
 * The same rows as the tutor's quick settings on the video (quick.ts), one part at a time:
 *   #tutor  the card, the look, the mode, Advanced (everything else)
 *   #voice  the voice choice (Speechify too), its voice list, the Speechify rows, Test the voice
 * The tutor volume, the text size, My level, what to explain, "Explain the last" and the keys are native rows of the
 * Settings tab (one place for each setting, the most used two taps away).
 * Everything is saved at once in the same store: the YouTube page and the other windows follow.
 */
import css from './dream.css';
import { THEME_HOST_CSS } from './theme';
import { renderQuick } from './quick';
import { SPEECHIFY_CSS } from './speechify-rows';
import { voiceLog, readVoiceLog, forgetVoiceLog, voiceLogLineText, voiceLogText, VOICE_LOG_KEY } from './voice-log';
import * as store from './store';
import type { Settings } from '@shared/settings';
import type { TtsEngine } from '@core/tts/engine';
import { getEngine, useFakeEngine, defaultVoiceFor } from '@core/tts/registry';
import { cloudEngine, resolveVoice, VoiceWithBackup, WithVolume, sliderGain, type VoiceKind } from './voice';

declare global { interface Window { __ytcDevice?: string; __drSettings?: { show(part: string): void; diag(): unknown } } }

const TOUCH = window.__ytcDevice === 'phone' || window.__ytcDevice === 'pad' || navigator.maxTouchPoints > 1;
let part: 'tutor' | 'voice' = location.hash === '#voice' ? 'voice' : 'tutor';

// the page: one shadow root with the tutor's own look (the same CSS as on the YouTube page), as a page, not a panel
const PAGE_CSS = `.quick.page{position:static;inset:auto;width:auto;max-width:720px;max-height:none;margin:0 auto;border:0;border-radius:0;box-shadow:none;background:var(--t-bg);display:block}
.quick.page .q-body{overflow:visible;max-height:none;padding:var(--t-space-s) var(--t-space-l) 48px}
.quick.page section{border-color:var(--t-line)}
.ptoast{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:20;max-width:calc(100% - 32px);background:var(--t-text);color:var(--t-bg);font:500 var(--t-size-footnote)/1.35 var(--t-font-ui);padding:10px 16px;border-radius:var(--t-radius-control);text-align:center;box-shadow:var(--t-shadow)}
.ptoast[hidden]{display:none}
.vlog{max-width:720px;margin:0 auto;padding:0 var(--t-space-l) 56px}
.vlog[hidden]{display:none}
.vlog h3{font:600 var(--t-size-body)/1.3 var(--t-font-ui);margin:0 0 4px;color:var(--t-text)}
.vlog p{font:400 var(--t-size-footnote)/1.4 var(--t-font-ui);margin:0 0 8px;color:var(--t-muted)}
.vlog pre{font:400 var(--t-size-footnote)/1.45 var(--t-font-ui);white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 10px;padding:10px 12px;border:1px solid var(--t-line);border-radius:var(--t-radius-control);background:var(--t-sunken);color:var(--t-text);max-height:320px;overflow:auto}
.vlog .row{display:flex;gap:10px;flex-wrap:wrap}
.vlog button{min-height:44px;padding:0 16px;font:500 var(--t-size-body)/1 var(--t-font-ui);border:1px solid var(--t-line);border-radius:var(--t-radius-control);background:var(--t-raised);color:var(--t-text)}`;
const host = document.getElementById('dr-settings-host') as HTMLElement;
if (TOUCH) host.dataset.phone = '1';
if (window.__ytcDevice === 'pad') host.dataset.pad = '1';
const root = host.attachShadow({ mode: 'open' });
root.innerHTML = `<style>${THEME_HOST_CSS}${css}${SPEECHIFY_CSS}${PAGE_CSS}</style><div class="quick page" role="form" aria-label="My tutor's settings"></div>
<section class="vlog" aria-label="Voice log" hidden><h3>Voice log</h3><p>When the voice waits long, is stopped or does not speak, the reason is written here (the newest line is the last).</p><pre data-vlog></pre><div class="row"><button type="button" data-vlog-act="copy">Copy the log</button><button type="button" data-vlog-act="clear">Clear</button></div></section>
<div class="ptoast" role="status" hidden></div>`;
const q = root.querySelector<HTMLElement>('.quick')!;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string, ms = 3200): void {
  const t = root.querySelector<HTMLElement>('.ptoast')!;
  t.textContent = text; t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- the voice: Test the voice (and the word) say a sentence with the voice the tutor would use -------------------
let settings: Settings;
let extras: store.YtExtras;
let keys: store.Keys;
let voiceNow: VoiceKind = 'mac';
let voiceId = '';
let macVoice = '';
let macVoices: { id: string; name: string; lang: string }[] = [];
let teacher: TtsEngine | null = null, word: TtsEngine | null = null;
let voiceShape = '';
async function prepareVoice(): Promise<void> {
  const shape = JSON.stringify([extras.voice, extras.speechifyUrl, extras.speechifyVoice, extras.azureVoice, extras.openaiVoice, extras.elevenVoice, extras.tutorOn, settings.voice.voiceId, Object.keys(keys).filter((k) => (keys as Record<string, string | undefined>)[k]).sort()]);
  if (shape === voiceShape && teacher) return;
  voiceShape = shape;
  if (extras.fakeVoice) useFakeEngine(2);
  const mac = getEngine('webspeech');
  macVoices = (await mac.listVoices().catch(() => [])).filter((v) => /^en/i.test(v.lang ?? '')).map((v) => ({ id: v.id, name: v.name, lang: v.lang ?? '' }));
  macVoice = settings.voice.voiceId || (await defaultVoiceFor('webspeech').catch(() => ''));
  // (the tutor off = free mode: the device's own voice only, never a paid one)
  voiceNow = extras.tutorOn !== false ? resolveVoice(extras.voice, keys, { speechifyUrl: extras.speechifyUrl ?? '' }) : 'mac';
  // (the Speechify voice is the only voice, as on the video: never the device voice in its place)
  const base: TtsEngine = voiceNow === 'mac' ? mac
    : voiceNow === 'speechify' ? new VoiceWithBackup(cloudEngine(voiceNow, 'en', { steady: true }), mac, () => macVoice, (e) => toast(e.message, 6000), 12_000, undefined, { steady: true, log: voiceLog })
      : new VoiceWithBackup(cloudEngine(voiceNow, 'en'), mac, () => macVoice, (e) => toast(e.message, 6000));
  voiceId = voiceNow === 'mac' ? macVoice : voiceNow === 'openai' ? extras.openaiVoice : voiceNow === 'azure' ? extras.azureVoice : voiceNow === 'speechify' ? extras.speechifyVoice ?? '' : extras.elevenVoice;
  teacher = new WithVolume(() => base, () => sliderGain(extras.teacherVolume ?? 60));
  word = new WithVolume(() => base, () => sliderGain(extras.wordVolume ?? 80));
}
function test(which: 'teacher' | 'word'): void {
  const e = which === 'teacher' ? teacher : word;
  if (!e) return;
  e.cancelAll();
  e.speak(which === 'teacher' ? 'Hello! I am your English tutor. This is how I sound.' : 'meticulous', { voiceId, rate: which === 'teacher' ? settings.voice.rate : Math.min(settings.voice.rate, 0.9) });
}

// ---- the voice log (the Voice part): why the voice waited, was stopped or did not speak --------------------------------
const vlog = root.querySelector<HTMLElement>('.vlog')!;
async function renderVoiceLog(): Promise<void> {
  vlog.hidden = part !== 'voice';
  if (vlog.hidden) return;
  const all = await readVoiceLog();
  const pre = vlog.querySelector<HTMLElement>('[data-vlog]')!;
  pre.textContent = all.length ? all.slice(-15).map(voiceLogLineText).join('\n') : 'Nothing yet: no problem was seen.';
  pre.scrollTop = pre.scrollHeight;
}
vlog.addEventListener('click', (ev) => {
  const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-vlog-act]')?.dataset.vlogAct;
  if (act === 'clear') { void forgetVoiceLog().then(renderVoiceLog); return; }
  if (act !== 'copy') return;
  void readVoiceLog().then(async (all) => {
    const text = all.length ? voiceLogText(all, 150) : 'Voice log: nothing yet.';
    try { await navigator.clipboard.writeText(text); toast(`Copied (${all.length} lines). Paste it into the chat.`, 4000); }
    catch { toast('Could not copy. Press and hold on the log, then Select All and Copy.', 6000); }
  });
});

// ---- drawn again after every change (a box being typed in keeps its value: not drawn under the finger) ----------------
let azureAvail: string[] | null = null;
async function render(force = false): Promise<void> {
  [settings, extras, keys] = await Promise.all([store.getSettings(), store.getExtras(), store.getKeys()]);
  const o = await chrome.storage.local.get('drAzureVoices').catch(() => ({} as Record<string, unknown>));
  azureAvail = Array.isArray(o.drAzureVoices) ? (o.drAzureVoices as string[]) : null;
  await prepareVoice();
  const focused = root.activeElement as HTMLElement | null;
  if (!force && focused && q.contains(focused) && /^(INPUT|TEXTAREA)$/.test(focused.tagName)) return;
  const y = window.scrollY;
  renderQuick(q, {
    part, settings, extras, keys, voiceNow, azureAvail, macVoices, macVoice, phone: TOUCH, pad: window.__ytcDevice === 'pad',
    testVoice: () => test('teacher'), testWord: () => test('word'),
    testCall: () => toast('Open a video, then tap Call on the Watch bar.', 5000),
    close: () => undefined, toast,
  });
  if (!force) window.scrollTo(0, y);
  await renderVoiceLog();
  document.body.dataset.part = part;
  document.body.dataset.ready = '1';
}

let soon: ReturnType<typeof setTimeout> | null = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  // (only a new line of the voice log: the log is drawn again, the rest of the page stays as it is)
  if (Object.keys(ch).every((k) => k === VOICE_LOG_KEY)) { void renderVoiceLog(); return; }
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => { soon = null; void render(); }, 60);
});

window.__drSettings = {
  show: (p: string) => { part = p === 'voice' ? 'voice' : 'tutor'; history.replaceState(null, '', `#${part}`); window.scrollTo(0, 0); void render(true); },
  diag: () => ({ part, voice: voiceNow, voiceId }),
};
void render(true);
