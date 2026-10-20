/**
 * Quick settings, right on the YouTube page (⚙ on the panel and on the reading page): everything the learner
 * changes while watching, saved at once: listening / normal, text sizes, the voice, the talk, the teacher's
 * instructions, the keys and the shortcuts. The full settings page stays for the rarely used rest.
 */
import type { Settings } from '@shared/settings';
import { CEFR_LEVELS } from '@core/model';
import * as store from './store';
import { OPENAI_VOICES, ELEVEN_VOICES } from './voice';
import { DEFAULT_TEACHER, MY_TEACHER_STYLE } from './teacher-text';
import { isWay, wayOf, wayStyle, bandOf } from './teaching-ways';
import { SHORTCUTS, shortcutMap, comboLabel, comboOf } from './shortcuts';
import { resolveStyles } from '@shared/styles';

export interface QuickCtx {
  settings: Settings;
  extras: store.YtExtras;
  keys: store.Keys;
  /** the voice really speaking now (a cloud voice without its key = the Mac voice) */
  voiceNow: 'mac' | 'openai' | 'elevenlabs';
  /** the Mac's English voices, and the one the tutor uses */
  macVoices: { id: string; name: string; lang: string }[];
  macVoice: string;
  /** say a test sentence with the chosen voice (teacher volume) / a test word (word volume) */
  testVoice(): void;
  testWord(): void;
  close(): void;
  toast(text: string): void;
}

/** the teaching way whose prompts are open for editing (kept while the panel is redrawn) */
let editingWay: string | null = null;

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
  // the picker: your own rules, the seven teaching ways and styles you made (the reading app's others stay in All settings)
  const active = styles.find((st) => st.id === s.ai.activeStyle) ?? styles[0];
  const pick = styles.filter((st) => st.id === 'custom' || isWay(st.id) || st.userMade || st.id === active.id);
  const editing = editingWay === active.id;
  const wayRows = `<label>Teaching way <select data-name="style">${pick.map((st) => `<option value="${esc(st.id)}"${st.id === active.id ? ' selected' : ''}>${esc(st.id === 'custom' ? 'My rules (exactly as I wrote them)' : st.name)}</option>`).join('')}</select>
        <button type="button" data-act="way-edit">${editing ? 'Done' : '✎ Edit'}</button>${active.id === 'custom' || isWay(active.id) ? '<button type="button" data-act="way-reset">Reset</button>' : ''}</label>
      <p class="muted">${esc(active.description || '')}${isWay(active.id) ? ` · the ${bandOf(s.learnerLevel)} version (your level ${esc(s.learnerLevel)})` : ''}</p>
      ${editing ? `<label class="col">For a word <textarea data-name="wayWord" rows="7">${esc(active.wordPrompt)}</textarea></label><label class="col">For a sentence or phrase <textarea data-name="waySentence" rows="7">${esc(active.sentencePrompt)}</textarea></label>` : ''}`;
  const options = (list: { id: string; name: string }[], val: string) => list.map((v) => `<option value="${esc(v.id)}"${v.id === val ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
  // the voice you really hear: a cloud voice without its key falls back to the Mac voice, so say so
  const now = ctx.voiceNow;
  const missing = now === 'mac' ? (x.voice === 'elevenlabs' ? 'ElevenLabs' : x.voice === 'openai' || x.voice === 'auto' ? 'OpenAI' : '') : '';
  const voiceRows = [
    missing ? `<p class="warn">No ${missing} key is saved, so you hear the Mac voice now. Paste your ${missing} key below (API keys) to use the ${missing} voices.</p>` : '',
    now === 'openai' ? `<label>OpenAI voice <select data-name="openaiVoice">${options(OPENAI_VOICES, x.openaiVoice)}</select> <span class="muted">(the live call too)</span></label>` : '',
    now === 'elevenlabs' ? `<label>ElevenLabs voice <select data-name="elevenVoice">${options(ELEVEN_VOICES, x.elevenVoice)}</select> ${seg('elevenQ', x.elevenQuality ?? 'best', [['best', 'Best'], ['fast', 'Fast (half the credits)']])}</label>` : '',
    now === 'mac' ? (ctx.macVoices.length ? `<label>Mac voice <select data-name="macVoice">${options(ctx.macVoices.map((v) => ({ id: v.id, name: `${v.name} (${v.lang})` })), ctx.macVoice)}</select></label>` : '<p class="muted">No English Mac voice was found.</p>') : '',
    now !== 'openai' ? `<label>Live call voice <select data-name="openaiVoice">${options(OPENAI_VOICES, x.openaiVoice)}</select>${keys.openai ? '' : ' <span class="warn">needs an OpenAI key</span>'}</label>` : '',
  ].filter(Boolean).join('\n      ');
  el.innerHTML = `<div class="q-head"><b>Quick settings</b><span class="grow"></span><span class="muted">saved at once</span><button class="quiet" data-act="close" title="Close (Esc)">✕</button></div>
  <div class="q-body">
    <section><h4>What you see</h4>
      <label>Mode ${seg('view', x.view, [['normal', '🎬 Normal video'], ['listening', '📖 Listening (all subtitles)']])}</label>
      <label>Page at every stop ${onOff('stageOn', x.stageOn)}</label>
      <label>When I pause: play the part again first ${onOff('replayPart', x.replayPart)}</label>
      <label>Part length ${seg('seconds', s.listen.lastSecondsWindow, [[20, '20 s'], [30, '30 s'], [40, '40 s'], [60, '60 s']])}</label>
      <label>Playing line at ${slider('followAt', x.followAt, 15, 75, 1, '%')} <span class="muted">from the top</span></label>
      <label>Complete sentences by the AI ${onOff('aiSentences', x.aiSentences)}</label>
      <label>Stops by itself ${seg('stopGap', x.stopGapSec ?? 45, [[-1, 'Off'], [90, 'Rarely'], [45, 'Sometimes'], [20, 'Often'], [0, 'Every hard word']])}</label>
      <p class="muted">Every phrase and sentence above your level is highlighted and explained. Single hard words: Rarely / Sometimes / Often = at most one every 90 / 45 / 20 seconds. Off = it only stops when you pause.</p>
      <label>Stop at hard words ${onOff('stopWords', s.listen.autoExplainWords)} phrases ${onOff('stopPhrases', s.listen.autoExplainPhrases)} sentences ${onOff('stopSentences', x.stopSentences)}</label>
    </section>
    <section><h4>Subtitles on the video</h4>
      <label>Show ${seg('band', x.band, [['auto', 'Auto (full screen, theater)'], ['on', 'Always'], ['off', 'Off']])}</label>
      <label>Height ${slider('bandBottom', x.bandBottom ?? 7, 0, 40, 1, '%')} <span class="muted">from the bottom (lower = smaller number)</span></label>
      <label>Hide YouTube's own subtitles ${seg('ytcc', x.hideYtAlways ? 'always' : x.hideYtCaptions ? 'dream' : 'never', [['dream', 'While Dream shows'], ['always', 'Always'], ['never', 'Never']])}</label>
    </section>
    <section><h4>Video size</h4>
      <label>Size ${seg('vsizeOn', x.videoSize > 0 ? 'mine' : 'yt', [['yt', 'YouTube decides'], ['mine', 'My size']])}${x.videoSize > 0 ? ` ${slider('videoSize', x.videoSize, 40, 85, 1, '%')} <span class="muted">of the page width</span>` : ''}</label>
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
      <label>Teacher voice volume ${slider('teacherVolume', x.teacherVolume ?? 60, 0, 100, 1, '%')} <button type="button" data-act="test">▶ Test</button></label>
      <label>Word voice volume ${slider('wordVolume', x.wordVolume ?? 80, 0, 100, 1, '%')} <button type="button" data-act="test-word">▶ Test</button></label>
      <label>Follow the video's volume ${onOff('followVol', x.followVideoVolume !== false)} <span class="muted">(100 % = as loud as the video)</span></label>
      <label>Tutor's voice ${seg('voice', x.voice, [['auto', 'Auto'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], ['mac', 'Mac']])}</label>
      ${voiceRows}
      <label>Speed ${slider('rate', Math.round((s.voice.rate || 1) * 100) / 100, 0.6, 1.6, 0.05, '×')}</label>
      <label>Say the Chinese meanings at the end ${onOff('speakChinese', s.ai.speakChinese)}</label>
      <p class="muted">Auto = the OpenAI voice when your OpenAI key is saved, otherwise the Mac voice.</p>
    </section>
    <section><h4>Talk to my tutor</h4>
      <label>After each explanation ${onOff('talkAfter', x.talkAfterExplain)}</label>
      <label>Voice call ${onOff('liveOn', x.liveOn)}</label>
      <label>Talk with ${seg('callEngine', x.callEngine ?? 'claude', [['claude', 'Claude + my tutor’s voice (no OpenAI)'], ['openai', 'OpenAI realtime']])}${(x.callEngine ?? 'claude') === 'openai' && !keys.openai ? ' <span class="warn">needs an OpenAI key with credit</span>' : ''}</label>
      ${(x.callEngine ?? 'claude') === 'openai' ? `<label>Live model ${seg('liveModel', x.liveModel, [['gpt-realtime-2.1', 'Best'], ['gpt-realtime-2.1-mini', 'Cheaper']])}</label>` : '<p class="muted">You talk, Chrome writes down your words, Claude answers, and your tutor’s voice speaks. Say “stop” (or press Space) to interrupt, “go on” to go back to the video.</p>'}
      <label>Microphone on ${seg('micAlways', x.micAlways ? 'always' : 'needed', [['needed', 'Only when the tutor waits for me'], ['always', 'Always (for “hi bro”)']])}</label>
      <p class="muted">“Always” keeps the Mac’s microphone on, which makes the sound quieter and a little broken. “Only when…” is clean.</p>
      <label>Microphone ${seg('mic', x.micLevel ?? 2, [[1, 'Normal'], [2, 'Sensitive'], [3, 'Very sensitive']])}</label>
      <label>Go on ${seg('silence', x.talkSilenceSec > 0 ? 'auto' : 'wait', [['wait', 'Wait for me'], ['auto', 'After quiet seconds']])}${x.talkSilenceSec > 0 ? ` <input type="number" data-name="silenceSec" min="3" max="120" value="${x.talkSilenceSec}" style="width:64px"> s` : ''}</label>
      <p class="muted">After an explanation you have a moment to ask; then the video goes on by itself. Say “bye bye” (or press Esc) to stop the AI at any time; Space pauses the teacher so you can ask.</p>
    </section>
    <section><h4>My teacher</h4>
      <label>My level ${seg('level', s.learnerLevel, CEFR_LEVELS.map((l) => [l, l] as [string, string]))}</label>
      <label>AI <select data-name="model">${CLAUDE_MODELS.map(([v, l]) => `<option value="anthropic:${v}"${s.ai.provider === 'anthropic' && s.ai.anthropicModel === v ? ' selected' : ''}>${l}</option>`).join('')}<option value="openai:${esc(s.ai.openaiModel)}"${s.ai.provider === 'openai' ? ' selected' : ''}>OpenAI ${esc(s.ai.openaiModel)}</option></select></label>
      ${wayRows}
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

  // every change is made on the settings as they are now (this panel may be older than the last change)
  const patchS = (fn: (cur: Settings) => Partial<Settings>) => void store.updateSettings(fn);
  const patchListen = (p: Partial<Settings['listen']>) => patchS((cur) => ({ listen: { ...cur.listen, ...p } }));
  const patchLook = (p: Partial<Settings['appearance']>) => patchS((cur) => ({ appearance: { ...cur.appearance, ...p } }));
  const patchAi = (p: Partial<Settings['ai']>) => patchS((cur) => ({ ai: { ...cur.ai, ...p } }));
  const patchShape = (p: Record<string, number>) => patchS((cur) => {
    const id = cur.ai.activeStyle;
    const st = cur.ai.styles[id] ?? {};
    const base = resolveStyles(cur.ai.styles).find((x) => x.id === id)?.shape ?? shape;
    return { ai: { ...cur.ai, styles: { ...cur.ai.styles, [id]: { ...st, shape: { ...base, ...(st.shape ?? {}), ...p } } } } };
  });
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
      else if (segName === 'hints') patchLook({ showHints: v === 'on' });
      else if (segName === 'hideCc') void store.patchExtras({ hideYtCaptions: v === 'on' });
      else if (segName === 'voice') void store.patchExtras({ voice: v as store.VoiceChoice });
      else if (segName === 'speakChinese') patchAi({ speakChinese: v === 'on' });
      else if (segName === 'talkAfter') void store.patchExtras({ talkAfterExplain: v === 'on' });
      else if (segName === 'liveOn') void store.patchExtras({ liveOn: v === 'on' });
      else if (segName === 'liveModel') void store.patchExtras({ liveModel: v });
      else if (segName === 'elevenQ') void store.patchExtras({ elevenQuality: v as store.YtExtras['elevenQuality'] });
      else if (segName === 'micAlways') void store.patchExtras({ micAlways: v === 'always' });
      else if (segName === 'callEngine') void store.patchExtras({ callEngine: v as store.YtExtras['callEngine'] });
      else if (segName === 'mic') void store.patchExtras({ micLevel: Number(v) as 1 | 2 | 3 });
      else if (segName === 'silence') void store.patchExtras({ talkSilenceSec: v === 'auto' ? 3 : 0 });
      else if (segName === 'level') void store.patchSettings({ learnerLevel: v as Settings['learnerLevel'] });
      else if (segName === 'followVol') void store.patchExtras({ followVideoVolume: v === 'on' });
      else if (segName === 'stopGap') void store.patchExtras({ stopGapSec: Number(v) });
      else if (segName === 'band') void store.patchExtras({ band: v as store.YtExtras['band'] });
      else if (segName === 'ytcc') void store.patchExtras({ hideYtAlways: v === 'always', hideYtCaptions: v !== 'never' });
      else if (segName === 'vsizeOn') void store.patchExtras({ videoSize: v === 'mine' ? (x.videoSize > 0 ? x.videoSize : 62) : 0 });
      return;
    }
    if (act === 'close') ctx.close();
    else if (act === 'test') ctx.testVoice();
    else if (act === 'test-word') ctx.testWord();
    else if (act === 'way-edit') { editingWay = editingWay === active.id ? null : active.id; renderQuick(el, ctx); }
    else if (act === 'way-reset') {
      const id = active.id, way = wayOf(id);
      patchS((cur) => ({ ai: { ...cur.ai, styles: { ...cur.ai.styles, [id]: way ? wayStyle(way, cur.learnerLevel) : MY_TEACHER_STYLE } } }));
      editingWay = null;
      ctx.toast('Back to the original teaching way.');
    }
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
  // one timer per box, so two sliders moved quickly one after the other are both saved
  const tms = new Map<string, ReturnType<typeof setTimeout>>();
  let current = '';
  const later = (fn: () => void, ms = 250) => { const k = current; clearTimeout(tms.get(k)); tms.set(k, setTimeout(() => { tms.delete(k); fn(); }, ms)); };
  el.oninput = (ev) => {
    const t = ev.target as HTMLInputElement | HTMLTextAreaElement;
    const name = t.dataset.name;
    if (!name) return;
    current = name;
    const out = t.parentElement?.querySelector('output');
    if (out && t instanceof HTMLInputElement && t.type === 'range') out.textContent = `${t.value}${out.textContent?.replace(/^[\d.]+/, '') ?? ''}`;
    const n = Number(t.value);
    if (name === 'followAt') later(() => void store.patchExtras({ followAt: n }));
    else if (name === 'stageSize') later(() => void store.patchExtras({ stageSizePx: n }), 120);
    else if (name === 'panelSize') later(() => patchLook({ fontSizePx: n }), 120);
    else if (name === 'bandSize') later(() => patchLook({ subtitleSizePx: n }), 120);
    else if (name === 'rate') later(() => patchS((cur) => ({ voice: { ...cur.voice, rate: n } })));
    else if (name === 'teacherVolume') later(() => void store.patchExtras({ teacherVolume: n }), 120);
    else if (name === 'wordVolume') later(() => void store.patchExtras({ wordVolume: n }), 120);
    else if (name === 'bandBottom') later(() => void store.patchExtras({ bandBottom: n }), 80);
    else if (name === 'videoSize') later(() => void store.patchExtras({ videoSize: n }), 200);
    else if (name === 'teacher') later(() => void store.patchExtras({ teacher: t.value }), 600);
    else if (name === 'wayWord' || name === 'waySentence') {
      const id = active.id, field = name === 'wayWord' ? 'wordPrompt' : 'sentencePrompt', value = t.value;
      later(() => patchS((cur) => ({ ai: { ...cur.ai, styles: { ...cur.ai.styles, [id]: { ...(cur.ai.styles[id] ?? {}), [field]: value } } } })), 600);
    }
    else if (name === 'silenceSec' && n >= 3) later(() => void store.patchExtras({ talkSilenceSec: n }), 500);
    else if (name === 'wordRepeats') later(() => patchListen({ wordRepeats: n }), 400);
    else if (name === 'windowSec' && n >= 2) later(() => patchListen({ commandWindowMs: n * 1000 }), 400);
    else if (['wordAfter', 'sentenceAfterWord', 'sentenceBefore', 'sentenceAfter'].includes(name)) later(() => patchShape({ [name]: n }), 400);
  };
  el.onchange = (ev) => {
    const t = ev.target as HTMLSelectElement;
    const name = t.dataset.name;
    if (name === 'openaiVoice') void store.patchExtras({ openaiVoice: t.value }).then(() => ctx.toast('Voice changed.'));
    else if (name === 'elevenVoice') void store.patchExtras({ elevenVoice: t.value }).then(() => ctx.toast('Voice changed.'));
    else if (name === 'macVoice') { patchS((cur) => ({ voice: { ...cur.voice, voiceId: t.value } })); ctx.toast('Voice changed.'); }
    else if (name === 'model') {
      const [provider, model] = t.value.split(':') as ['anthropic' | 'openai', string];
      patchAi({ provider, ...(provider === 'anthropic' ? { anthropicModel: model } : { openaiModel: model }) });
    } else if (name === 'style') patchAi({ activeStyle: t.value as Settings['ai']['activeStyle'] });
  };
  // typing here must not reach YouTube's shortcuts
  for (const evName of ['keydown', 'keyup', 'keypress']) el.addEventListener(evName, (e) => { const tg = e.target as HTMLElement; if (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName)) e.stopPropagation(); });
}

function num(name: string, v: number, min: number, max: number): string {
  return `<input type="number" data-name="${name}" min="${min}" max="${max}" value="${v}" style="width:52px">`;
}
