/** Dream Tutor settings page (dream/options.html): API keys, level, stopping rules, styles, voices, look. Saved on every change. */
import { resolveStyles, resolveStyle, DEFAULT_CONTEXT_RULES, DEFAULT_STYLES, KNOBS, type StyleOverride, type ExplanationStyle, type StyleId } from '@shared/styles';
import type { Settings, AiProviderId } from '@shared/settings';
import { WebSpeechEngine } from '@core/tts/webspeech';
import * as store from './store';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let S: Settings;
let X: store.YtExtras;
let editing: StyleId = 'custom';

async function save(patch: Partial<Settings>): Promise<void> { S = await store.patchSettings(patch); }
async function saveX(patch: Partial<store.YtExtras>): Promise<void> { X = await store.patchExtras(patch); }

function bindNumber(id: string, get: () => number, set: (n: number) => Partial<Settings>, scale = 1): void {
  const el = $<HTMLInputElement>(id);
  el.value = String(get() / scale);
  el.addEventListener('change', () => { const n = Number(el.value); if (Number.isFinite(n)) void save(set(n * scale)); });
}
function bindCheck(id: string, get: () => boolean, set: (b: boolean) => Promise<void>): void {
  const el = $<HTMLInputElement>(id);
  el.checked = get();
  el.addEventListener('change', () => void set(el.checked));
}

async function init(): Promise<void> {
  [S, X] = await Promise.all([store.getSettings(), store.getExtras()]);
  const keys = await store.getKeys();
  // ---- keys
  $<HTMLSelectElement>('provider').value = S.ai.provider;
  $('provider').addEventListener('change', () => void save({ ai: { ...S.ai, provider: $<HTMLSelectElement>('provider').value as AiProviderId } }));
  for (const p of ['anthropic', 'openai'] as const) {
    const inp = $<HTMLInputElement>(`key-${p}`);
    if (keys[p]) inp.placeholder = `saved (…${keys[p]!.slice(-4)})`;
    document.querySelector(`[data-save="${p}"]`)!.addEventListener('click', async () => {
      const v = inp.value.trim();
      const msg = $(`msg-${p}`);
      if (!v) { msg.textContent = 'Paste the key first.'; msg.className = 'msg bad'; return; }
      const looks = p === 'anthropic' ? v.startsWith('sk-ant-') : v.startsWith('sk-') && !v.startsWith('sk-ant-');
      await store.setKey(p, v);
      inp.value = ''; inp.placeholder = `saved (…${v.slice(-4)})`;
      msg.textContent = looks ? 'Saved.' : `Saved, but it does not look like ${p === 'anthropic' ? 'an Anthropic key (they start with "sk-ant-")' : 'an OpenAI key (they start with "sk-")'}. Press Test.`;
      msg.className = looks ? 'msg ok' : 'msg bad';
    });
    document.querySelector(`[data-test="${p}"]`)!.addEventListener('click', async () => {
      const msg = $(`msg-${p}`);
      msg.textContent = 'Testing…'; msg.className = 'msg';
      const r = await chrome.runtime.sendMessage({ type: 'dream-test-key', provider: p }) as { ok: boolean; message: string } | undefined;
      msg.textContent = r?.message ?? 'No answer from the extension.'; msg.className = r?.ok ? 'msg ok' : 'msg bad';
    });
  }
  const am = $<HTMLSelectElement>('anthropicModel');
  if (![...am.options].some((o) => o.value === S.ai.anthropicModel)) am.add(new Option(S.ai.anthropicModel, S.ai.anthropicModel));
  am.value = S.ai.anthropicModel;
  am.addEventListener('change', () => void save({ ai: { ...S.ai, anthropicModel: am.value } }));
  const om = $<HTMLInputElement>('openaiModel');
  om.value = S.ai.openaiModel;
  om.addEventListener('change', () => void save({ ai: { ...S.ai, openaiModel: om.value.trim() || S.ai.openaiModel } }));
  const hm = $<HTMLInputElement>('hintsModel');
  hm.value = S.ai.hintsModel ?? '';
  hm.addEventListener('change', () => void save({ ai: { ...S.ai, hintsModel: hm.value.trim() || null } }));
  bindNumber('dailyWarnUsd', () => S.ai.dailyWarnUsd, (n) => ({ ai: { ...S.ai, dailyWarnUsd: n } }));
  bindNumber('monthlyStopUsd', () => S.ai.monthlyStopUsd, (n) => ({ ai: { ...S.ai, monthlyStopUsd: n } }));
  const usage = await store.getUsage();
  const { day, month } = store.periodStarts();
  $('spent').textContent = `Spent today $${store.usdSince(usage, day).toFixed(2)}, this month $${store.usdSince(usage, month).toFixed(2)} (estimate)`;

  // ---- level
  $<HTMLSelectElement>('learnerLevel').value = S.learnerLevel;
  $('learnerLevel').addEventListener('change', () => void save({ learnerLevel: $<HTMLSelectElement>('learnerLevel').value as Settings['learnerLevel'] }));

  // ---- stops
  bindCheck('autoExplainWords', () => S.listen.autoExplainWords, (b) => save({ listen: { ...S.listen, autoExplainWords: b } }));
  bindCheck('autoExplainPhrases', () => S.listen.autoExplainPhrases, (b) => save({ listen: { ...S.listen, autoExplainPhrases: b } }));
  bindNumber('wordRepeats', () => S.listen.wordRepeats, (n) => ({ listen: { ...S.listen, wordRepeats: Math.max(0, Math.min(5, Math.round(n))) } }));
  bindNumber('commandWindowMs', () => S.listen.commandWindowMs, (n) => ({ listen: { ...S.listen, commandWindowMs: Math.max(2000, Math.min(15000, n)) } }), 1000);
  bindNumber('repeatWindowWords', () => S.listen.repeatWindowWords, (n) => ({ listen: { ...S.listen, repeatWindowWords: Math.max(0, n) } }));
  bindNumber('maxStopsPer10Min', () => S.listen.maxStopsPer10Min, (n) => ({ listen: { ...S.listen, maxStopsPer10Min: Math.max(0, n) } }));
  bindCheck('explainOnStop', () => X.explainOnStop, (b) => saveX({ explainOnStop: b }));
  bindCheck('stopInCall', () => X.stopInCall, (b) => saveX({ stopInCall: b }));
  const lw = $<HTMLSelectElement>('lastSecondsWindow');
  lw.value = String(S.listen.lastSecondsWindow);
  lw.addEventListener('change', () => void save({ listen: { ...S.listen, lastSecondsWindow: Number(lw.value) as Settings['listen']['lastSecondsWindow'] } }));

  // ---- explanations
  bindCheck('speakChinese', () => S.ai.speakChinese, (b) => save({ ai: { ...S.ai, speakChinese: b } }));
  const rules = $<HTMLTextAreaElement>('contextRules');
  rules.value = S.ai.contextRules;
  rules.addEventListener('change', () => void save({ ai: { ...S.ai, contextRules: rules.value.trim() || DEFAULT_CONTEXT_RULES } }));
  $('reset-rules').addEventListener('click', () => { rules.value = DEFAULT_CONTEXT_RULES; void save({ ai: { ...S.ai, contextRules: DEFAULT_CONTEXT_RULES } }); });
  editing = S.ai.activeStyle;
  renderStyles();

  // ---- voices and look
  const vs = $<HTMLSelectElement>('voiceId');
  const voices = await new WebSpeechEngine().listVoices().catch(() => []);
  const en = voices.filter((v) => /^en/i.test(v.lang));
  vs.add(new Option('Automatic (a British voice)', ''));
  for (const v of en) vs.add(new Option(`${v.name} (${v.lang})${v.quality ? ` · ${v.quality}` : ''}`, v.id));
  vs.value = S.voice.voiceId;
  vs.addEventListener('change', () => void save({ voice: { ...S.voice, voiceId: vs.value } }));
  $('test-voice').addEventListener('click', () => { const e = new WebSpeechEngine(); e.speak('Hello! This is your Dream tutor. Meticulous means very careful about every small detail.', { voiceId: vs.value || (en.find((v) => /en-gb/i.test(v.lang))?.id ?? ''), rate: S.voice.rate }); });
  const zh = voices.find((v) => /^zh[-_]?(cn|hans)?$/i.test(v.lang));
  $('zh-voice').textContent = zh ? `${zh.name} (${zh.lang})` : 'No Chinese voice on this computer: add one in System Settings → Accessibility → Spoken Content (e.g. Tingting). Without it Chinese is shown, not spoken.';
  const rate = $<HTMLInputElement>('rate');
  rate.value = String(S.voice.rate); $('rate-val').textContent = `${S.voice.rate.toFixed(2)}×`;
  rate.addEventListener('input', () => { $('rate-val').textContent = `${Number(rate.value).toFixed(2)}×`; });
  rate.addEventListener('change', () => void save({ voice: { ...S.voice, rate: Number(rate.value) } }));
  bindNumber('fontSizePx', () => S.appearance.fontSizePx, (n) => ({ appearance: { ...S.appearance, fontSizePx: n } }));
  bindNumber('subtitleSizePx', () => S.appearance.subtitleSizePx, (n) => ({ appearance: { ...S.appearance, subtitleSizePx: n } }));
  bindCheck('showHints', () => S.appearance.showHints !== false, (b) => save({ appearance: { ...S.appearance, showHints: b } }));
  bindCheck('panel', () => X.panel, (b) => saveX({ panel: b }));
  bindCheck('hideYtCaptions', () => X.hideYtCaptions, (b) => saveX({ hideYtCaptions: b }));
  const band = $<HTMLSelectElement>('band');
  band.value = X.band;
  band.addEventListener('change', () => void saveX({ band: band.value as store.YtExtras['band'] }));
}

// ---- styles: pick, edit, copy, new, hide -------------------------------------------------------------------------
function patchStyle(id: StyleId, patch: StyleOverride): Promise<void> {
  const styles = { ...S.ai.styles, [id]: { ...(S.ai.styles[id] ?? {}), ...patch } };
  return save({ ai: { ...S.ai, styles } });
}

function renderStyles(): void {
  const all = resolveStyles(S.ai.styles);
  const list = $('style-list');
  list.innerHTML = '';
  for (const s of all.filter((x) => !x.hidden)) {
    const b = document.createElement('button');
    b.className = s.id === editing ? 'sel' : '';
    b.innerHTML = `<span>${esc(s.name)}</span>${s.id === S.ai.activeStyle ? '<span class="badge">active</span>' : s.userMade ? '<span class="badge">yours</span>' : ''}`;
    b.onclick = () => { editing = s.id; renderStyles(); };
    list.appendChild(b);
  }
  const hidden = all.filter((x) => x.hidden);
  if (hidden.length) {
    const r = document.createElement('button');
    r.textContent = `Show ${hidden.length} hidden`;
    r.onclick = async () => { for (const h of hidden) await patchStyle(h.id, { hidden: false }); renderStyles(); };
    list.appendChild(r);
  }
  const nb = document.createElement('button');
  nb.textContent = '+ New style';
  nb.onclick = async () => { const id = nextId('my-style'); await patchStyle(id, { userMade: true, hidden: false, name: 'My new style', description: 'Your own style.', basis: 'Your own style. Edit anything below.' }); editing = id; renderStyles(); };
  list.appendChild(nb);
  renderStyleEditor(resolveStyle(editing, S.ai.styles));
}

function nextId(base: string): string {
  const ids = resolveStyles(S.ai.styles).map((s) => s.id);
  for (let n = 1; ; n++) if (!ids.includes(`${base}-${n}`)) return `${base}-${n}`;
}

function renderStyleEditor(st: ExplanationStyle): void {
  const box = $('style-edit');
  const builtin = DEFAULT_STYLES.some((d) => d.id === st.id);
  const opt = (rec: Record<string, { label: string }>, v: string) => Object.entries(rec).map(([k, x]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
  box.innerHTML = `
    <div class="row" style="margin-bottom:8px"><b style="font-size:16px">${esc(st.name)}</b><span class="muted">${esc(st.description)}</span></div>
    <div class="row" style="margin-bottom:10px">${st.id === S.ai.activeStyle ? '<span class="badge">This style is used for explanations</span>' : '<button class="primary" id="st-use">Use this style</button>'}
      <button id="st-copy">Copy</button>${builtin ? '<button id="st-reset">Reset</button>' : ''}<button id="st-hide" class="danger">${builtin ? 'Hide' : 'Delete'}</button></div>
    <div class="field"><label>Name</label><input type="text" id="st-name" value="${esc(st.name)}"></div>
    <div class="field"><label>Personality</label><select id="st-personality">${opt(KNOBS.personality, st.personality)}</select></div>
    <div class="field"><label>Length</label><select id="st-length">${opt(KNOBS.length, st.length)}</select></div>
    <div class="field"><label>Answer type</label><select id="st-answerType">${opt(KNOBS.answerType, st.answerType)}</select></div>
    <div class="field"><label>Own model (optional)</label><input type="text" id="st-model" value="${esc(st.model ?? '')}" placeholder="the model above"></div>
    <div class="field"><label>Prompt for a word or phrase</label><textarea id="st-wordPrompt">${esc(st.wordPrompt)}</textarea></div>
    <div class="field"><label>Prompt for a sentence</label><textarea id="st-sentencePrompt">${esc(st.sentencePrompt)}</textarea></div>
    <p class="muted">Placeholders: {{word}} {{sentence}} {{before}} {{after}} {{title}} {{chapter}} {{level}} {{dict}} {{native}}. For a video, the title is the video's title and "before/after" are the subtitles around the word.</p>`;
  const on = (id: string, ev: string, f: () => void) => document.getElementById(id)?.addEventListener(ev, f);
  on('st-use', 'click', () => void save({ ai: { ...S.ai, activeStyle: st.id } }).then(renderStyles));
  on('st-copy', 'click', async () => {
    const id = nextId('my-copy');
    await patchStyle(id, { userMade: true, hidden: false, name: `${st.name} (copy)`, description: st.description, basis: `Your own style, copied from ${st.name}.`, wordPrompt: st.wordPrompt, sentencePrompt: st.sentencePrompt, shape: { ...st.shape }, provider: st.provider, model: st.model, maxTokens: st.maxTokens, personality: st.personality, length: st.length, answerType: st.answerType });
    editing = id; renderStyles();
  });
  on('st-reset', 'click', async () => { const styles = { ...S.ai.styles }; delete styles[st.id]; await save({ ai: { ...S.ai, styles } }); renderStyles(); });
  on('st-hide', 'click', async () => {
    if (builtin) await patchStyle(st.id, { hidden: true });
    else { const styles = { ...S.ai.styles }; delete styles[st.id]; await save({ ai: { ...S.ai, styles } }); }
    if (S.ai.activeStyle === st.id) await save({ ai: { ...S.ai, activeStyle: 'custom' } });
    editing = S.ai.activeStyle; renderStyles();
  });
  for (const k of ['name', 'personality', 'length', 'answerType', 'model', 'wordPrompt', 'sentencePrompt'] as const) {
    on(`st-${k}`, 'change', () => {
      const el = document.getElementById(`st-${k}`) as HTMLInputElement;
      const v = el.value;
      void patchStyle(st.id, { [k]: k === 'model' ? (v.trim() || null) : v } as StyleOverride).then(() => { if (k === 'name') renderStyles(); });
    });
  }
}

function esc(s: string): string { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

void init();
