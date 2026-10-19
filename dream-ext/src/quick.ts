/**
 * Quick settings, right on the YouTube page (⚙ on the panel and on the reading page): everything the learner
 * changes while watching, saved at once: listening / normal, text sizes, the voice, the talk, the teacher's
 * instructions, the keys and the shortcuts. The full settings page stays for the rarely used rest.
 */
import type { Settings } from '@shared/settings';
import { CEFR_LEVELS } from '@core/model';
import * as store from './store';
import { OPENAI_VOICES, ELEVEN_VOICES } from './voice';
import { DEFAULT_TEACHER } from './teacher-text';
import { SHORTCUTS, shortcutMap, comboLabel, comboOf } from './shortcuts';
import { resolveStyles } from '@shared/styles';

export interface QuickCtx {
  settings: Settings;
  extras: store.YtExtras;
  keys: store.Keys;
  /** say a test sentence with the chosen voice */
  testVoice(): void;
  close(): void;
  toast(text: string): void;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CLAUDE_MODELS: [string, string][] = [['claude-opus-5-5', 'Claude Opus 5.5 (best)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest, cheapest)'], ['claude-fable-5-1', 'Claude Fable 5.1']];

function seg<T extends string | number>(name: string, value: T, options: [T, string][]): string {
  return `<span class="seg" data-name="${name}">${options.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === value ? 'on' : ''}">${esc(l)}</button>`).join('')}</span>`;
}
function onOff(name: string, on: boolean): string { return seg(name, on ? 'on' : 'off', [['on', 'On'], ['off', 'Off']]); }
function slider(name: string, value: number, min: number, max: number, step: number, unit: string): string {
  return `<span class="sl"><input type="range" data-name="${name}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${value}${unit}</output></span>`;
}

export function renderQuick(el: HTMLElement, ctx: QuickCtx): void {
  const { settings: s, extras: x, keys } = ctx;
  const sc = shortcutMap(x.shortcuts);
  const styles = resolveStyles(s.ai.styles).filter((st) => !st.hidden);
  const shape = styles.find((st) => st.id === s.ai.activeStyle)?.shape ?? styles[0].shape;
  const voices = x.voice === 'elevenlabs' ? ELEVEN_VOICES : OPENAI_VOICES;
  const voiceVal = x.voice === 'elevenlabs' ? x.elevenVoice : x.openaiVoice;
  el.innerHTML = `<div class="q-head"><b>Quick settings</b><span class="grow"></span><span class="muted">saved at once</span><button class="quiet" data-act="close" title="Close (Esc)">✕</button></div>
  <div class="q-body">
    <section><h4>What you see</h4>
      <label>Mode ${seg('view', x.view, [['normal', '🎬 Normal video'], ['listening', '📖 Listening (all subtitles)']])}</label>
      <label>Page at every stop ${onOff('stageOn', x.stageOn)}</label>
      <label>When I pause: play the part again first ${onOff('replayPart', x.replayPart)}</label>
      <label>Part length ${seg('seconds', s.listen.lastSecondsWindow, [[20, '20 s'], [30, '30 s'], [40, '40 s'], [60, '60 s']])}</label>
      <label>Playing line at ${slider('followAt', x.followAt, 15, 75, 1, '%')} <span class="muted">from the top</span></label>
      <label>Complete sentences by the AI ${onOff('aiSentences', x.aiSentences)}</label>
      <label>Stop at hard words ${onOff('stopWords', s.listen.autoExplainWords)} phrases ${onOff('stopPhrases', s.listen.autoExplainPhrases)} sentences ${onOff('stopSentences', x.stopSentences)}</label>
    </section>
    <section><h4>Text size</h4>
      <label>Reading page ${slider('stageSize', x.stageSizePx, 16, 96, 1, 'px')}</label>
      <label>Side panel ${slider('panelSize', s.appearance.fontSizePx || 19, 12, 48, 1, 'px')}</label>
      <label>Subtitles over the video ${slider('bandSize', s.appearance.subtitleSizePx || 26, 16, 96, 1, 'px')}</label>
      <label>Chinese under each line (AI, live) ${onOff('zhLines', x.zhLines)}</label>
      <label>Chinese hint under hard words ${onOff('hints', s.appearance.showHints !== false)}</label>
      <label>Hide YouTube's own captions ${onOff('hideCc', x.hideYtCaptions)}</label>
    </section>
    <section><h4>Voice</h4>
      <label>Tutor's voice ${seg('voice', x.voice, [['auto', 'Auto'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], ['mac', 'Mac']])}</label>
      ${x.voice !== 'mac' ? `<label>Voice <select data-name="voiceId">${voices.map((v) => `<option value="${v.id}"${v.id === voiceVal ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select><button type="button" data-act="test">▶ Test</button></label>` : '<label>Voice <button type="button" data-act="test">▶ Test</button> <span class="muted">(Mac voices: pick one in the full settings)</span></label>'}
      <label>Speed ${slider('rate', Math.round((s.voice.rate || 1) * 100) / 100, 0.6, 1.6, 0.05, '×')}</label>
      <label>Say the Chinese meanings at the end ${onOff('speakChinese', s.ai.speakChinese)}</label>
      <p class="muted">Auto = the OpenAI voice when your OpenAI key is saved, otherwise the Mac voice.</p>
    </section>
    <section><h4>Talk to my tutor</h4>
      <label>After each explanation ${onOff('talkAfter', x.talkAfterExplain)}</label>
      <label>Live voice call (real time) ${onOff('liveOn', x.liveOn)} ${keys.openai ? '' : '<span class="warn">needs an OpenAI key</span>'}</label>
      <label>Live model ${seg('liveModel', x.liveModel, [['gpt-realtime-2.1', 'Best'], ['gpt-realtime-2.1-mini', 'Cheaper']])}</label>
      <label>Microphone ${seg('mic', x.micLevel ?? 2, [[1, 'Normal'], [2, 'Sensitive'], [3, 'Very sensitive']])}</label>
      <label>Go on ${seg('silence', x.talkSilenceSec > 0 ? 'auto' : 'wait', [['wait', 'Wait for me'], ['auto', 'After quiet seconds']])}${x.talkSilenceSec > 0 ? ` <input type="number" data-name="silenceSec" min="3" max="120" value="${x.talkSilenceSec}" style="width:64px"> s` : ''}</label>
      <p class="muted">After an explanation you have a moment to ask; then the video goes on by itself. Say “bye bye” (or press Esc) to stop the AI at any time; Space pauses the teacher so you can ask.</p>
    </section>
    <section><h4>My teacher</h4>
      <label>My level ${seg('level', s.learnerLevel, CEFR_LEVELS.map((l) => [l, l] as [string, string]))}</label>
      <label>AI <select data-name="model">${CLAUDE_MODELS.map(([v, l]) => `<option value="anthropic:${v}"${s.ai.provider === 'anthropic' && s.ai.anthropicModel === v ? ' selected' : ''}>${l}</option>`).join('')}<option value="openai:${esc(s.ai.openaiModel)}"${s.ai.provider === 'openai' ? ' selected' : ''}>OpenAI ${esc(s.ai.openaiModel)}</option></select></label>
      <label>Style <select data-name="style">${styles.map((st) => `<option value="${st.id}"${st.id === s.ai.activeStyle ? ' selected' : ''}>${esc(st.name)}</option>`).join('')}</select></label>
      <label class="col">My teacher's instructions <span class="muted">(write anything: how to teach, the personality)</span><textarea data-name="teacher" rows="9">${esc(x.teacher)}</textarea><span><button type="button" data-act="teacher-reset">Use my rules again</button></span></label>
      <label>Say the word before ${num('wordRepeats', s.listen.wordRepeats, 0, 10)} after ${num('wordAfter', shape.wordAfter, 0, 20)} times · play the sentence after a word ${num('sentenceAfterWord', shape.sentenceAfterWord, 0, 3)} · a sentence before ${num('sentenceBefore', shape.sentenceBefore, 0, 3)} after ${num('sentenceAfter', shape.sentenceAfter, 0, 3)}</label>
      <label>Commands window ${num('windowSec', Math.round((s.listen.commandWindowMs || 5000) / 1000), 2, 15)} s</label>
    </section>
    <section><h4>API keys</h4>
      ${(['anthropic', 'openai', 'elevenlabs'] as const).map((k) => `<label>${k === 'anthropic' ? 'Claude' : k === 'openai' ? 'OpenAI' : 'ElevenLabs'} <input type="password" data-key="${k}" placeholder="${keys[k] ? `saved (…${esc(keys[k]!.slice(-4))})` : 'paste your key'}" autocomplete="off"><button type="button" data-act="save-key" data-k="${k}">Save</button></label>`).join('')}
      <p class="muted">Keys stay in Chrome on this computer. Claude explains; OpenAI gives the voice and the live call.</p>
    </section>
    <section><h4>Shortcuts <span class="muted">(click one, then press the new keys)</span></h4>
      <div class="keys">${SHORTCUTS.map((a) => `<div><span>${esc(a.label)}</span><button type="button" data-sc="${a.id}">${esc(comboLabel(sc[a.id]))}</button></div>`).join('')}</div>
      <span><button type="button" data-act="sc-reset">Default shortcuts</button></span>
    </section>
    <section class="links"><button type="button" data-act="all">All settings</button><button type="button" data-act="vocab">📒 My Vocabulary</button></section>
  </div>`;

  const patchListen = (p: Partial<Settings['listen']>) => void store.patchSettings({ listen: { ...s.listen, ...p } });
  const patchShape = (p: Record<string, number>) => {
    const id = s.ai.activeStyle;
    const cur = s.ai.styles[id] ?? {};
    void store.patchSettings({ ai: { ...s.ai, styles: { ...s.ai.styles, [id]: { ...cur, shape: { ...shape, ...(cur.shape ?? {}), ...p } } } } });
  };
  el.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest('button');
    if (!b) return;
    ev.stopPropagation();
    const act = b.dataset.act;
    const segName = b.parentElement?.classList.contains('seg') ? b.parentElement.dataset.name : undefined;
    if (segName) {
      const v = b.dataset.v!;
      if (segName === 'view') void store.patchExtras({ view: v as store.YtExtras['view'] });
      else if (segName === 'stageOn') void store.patchExtras({ stageOn: v === 'on' });
      else if (segName === 'replayPart') void store.patchExtras({ replayPart: v === 'on' });
      else if (segName === 'aiSentences') void store.patchExtras({ aiSentences: v === 'on' });
      else if (segName === 'stopWords') patchListen({ autoExplainWords: v === 'on' });
      else if (segName === 'stopPhrases') patchListen({ autoExplainPhrases: v === 'on' });
      else if (segName === 'stopSentences') void store.patchExtras({ stopSentences: v === 'on' });
      else if (segName === 'seconds') patchListen({ lastSecondsWindow: Number(v) as Settings['listen']['lastSecondsWindow'] });
      else if (segName === 'zhLines') void store.patchExtras({ zhLines: v === 'on' });
      else if (segName === 'hints') void store.patchSettings({ appearance: { ...s.appearance, showHints: v === 'on' } });
      else if (segName === 'hideCc') void store.patchExtras({ hideYtCaptions: v === 'on' });
      else if (segName === 'voice') void store.patchExtras({ voice: v as store.VoiceChoice });
      else if (segName === 'speakChinese') void store.patchSettings({ ai: { ...s.ai, speakChinese: v === 'on' } });
      else if (segName === 'talkAfter') void store.patchExtras({ talkAfterExplain: v === 'on' });
      else if (segName === 'liveOn') void store.patchExtras({ liveOn: v === 'on' });
      else if (segName === 'liveModel') void store.patchExtras({ liveModel: v });
      else if (segName === 'mic') void store.patchExtras({ micLevel: Number(v) as 1 | 2 | 3 });
      else if (segName === 'silence') void store.patchExtras({ talkSilenceSec: v === 'auto' ? 3 : 0 });
      else if (segName === 'level') void store.patchSettings({ learnerLevel: v as Settings['learnerLevel'] });
      return;
    }
    if (act === 'close') ctx.close();
    else if (act === 'test') ctx.testVoice();
    else if (act === 'teacher-reset') void store.patchExtras({ teacher: DEFAULT_TEACHER }).then(() => ctx.toast('Your own rules are back.'));
    else if (act === 'save-key') {
      const k = b.dataset.k as store.KeyName;
      const inp = el.querySelector<HTMLInputElement>(`input[data-key="${k}"]`);
      const v = inp?.value.trim() ?? '';
      if (!v) { ctx.toast('Paste the key first.'); return; }
      void store.setKey(k, v).then(() => { if (inp) inp.value = ''; ctx.toast('Key saved.'); });
    } else if (act === 'sc-reset') void store.patchExtras({ shortcuts: {} });
    else if (act === 'all') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'options' });
    else if (act === 'vocab') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'vocab' });
    else if (b.dataset.sc) {
      const id = b.dataset.sc;
      b.textContent = 'press keys…';
      b.classList.add('on');
      const onKey = (e: KeyboardEvent) => {
        const c = comboOf(e);
        if (!c) return;
        e.preventDefault(); e.stopImmediatePropagation();
        window.removeEventListener('keydown', onKey, true);
        void store.patchExtras({ shortcuts: { ...x.shortcuts, [id]: c } });
      };
      window.addEventListener('keydown', onKey, true);
    }
  };
  // sliders and boxes: saved as they change (the page follows live)
  let tm: ReturnType<typeof setTimeout> | null = null;
  const later = (fn: () => void, ms = 250) => { if (tm) clearTimeout(tm); tm = setTimeout(fn, ms); };
  el.oninput = (ev) => {
    const t = ev.target as HTMLInputElement | HTMLTextAreaElement;
    const name = t.dataset.name;
    if (!name) return;
    const out = t.parentElement?.querySelector('output');
    if (out && t instanceof HTMLInputElement && t.type === 'range') out.textContent = `${t.value}${out.textContent?.replace(/^[\d.]+/, '') ?? ''}`;
    const n = Number(t.value);
    if (name === 'followAt') later(() => void store.patchExtras({ followAt: n }));
    else if (name === 'stageSize') later(() => void store.patchExtras({ stageSizePx: n }), 120);
    else if (name === 'panelSize') later(() => void store.patchSettings({ appearance: { ...s.appearance, fontSizePx: n } }), 120);
    else if (name === 'bandSize') later(() => void store.patchSettings({ appearance: { ...s.appearance, subtitleSizePx: n } }), 120);
    else if (name === 'rate') later(() => void store.patchSettings({ voice: { ...s.voice, rate: n } }));
    else if (name === 'teacher') later(() => void store.patchExtras({ teacher: t.value }), 600);
    else if (name === 'silenceSec' && n >= 3) later(() => void store.patchExtras({ talkSilenceSec: n }), 500);
    else if (name === 'wordRepeats') later(() => patchListen({ wordRepeats: n }), 400);
    else if (name === 'windowSec' && n >= 2) later(() => patchListen({ commandWindowMs: n * 1000 }), 400);
    else if (['wordAfter', 'sentenceAfterWord', 'sentenceBefore', 'sentenceAfter'].includes(name)) later(() => patchShape({ [name]: n }), 400);
  };
  el.onchange = (ev) => {
    const t = ev.target as HTMLSelectElement;
    const name = t.dataset.name;
    if (name === 'voiceId') void store.patchExtras(x.voice === 'elevenlabs' ? { elevenVoice: t.value } : { openaiVoice: t.value });
    else if (name === 'model') {
      const [provider, model] = t.value.split(':') as ['anthropic' | 'openai', string];
      void store.patchSettings({ ai: { ...s.ai, provider, ...(provider === 'anthropic' ? { anthropicModel: model } : { openaiModel: model }) } });
    } else if (name === 'style') void store.patchSettings({ ai: { ...s.ai, activeStyle: t.value as Settings['ai']['activeStyle'] } });
  };
  // typing here must not reach YouTube's shortcuts
  for (const evName of ['keydown', 'keyup', 'keypress']) el.addEventListener(evName, (e) => { const tg = e.target as HTMLElement; if (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName)) e.stopPropagation(); });
}

function num(name: string, v: number, min: number, max: number): string {
  return `<input type="number" data-name="${name}" min="${min}" max="${max}" value="${v}" style="width:52px">`;
}
