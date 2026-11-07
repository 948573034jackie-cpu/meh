/**
 * Quick settings, right on the YouTube page (⚙ on the panel and on the reading page): everything the learner
 * changes while watching, saved at once: listening / normal, text sizes, the voice, the talk, the teacher's
 * instructions, the keys and the shortcuts. The full settings page stays for the rarely used rest.
 */
import { copyLevel } from './level-copy';
import type { Settings } from '@shared/settings';
import { CEFR_LEVELS } from '@core/model';
import * as store from './store';
import { OPENAI_VOICES, ELEVEN_VOICES, AZURE_VOICES, AZURE_ACCENTS } from './voice';
import { DEFAULT_TEACHER, MY_TEACHER_STYLE } from './teacher-text';
import { isWay, wayOf, wayStyle, bandOf } from './teaching-ways';
import { SHORTCUTS, shortcutMap, comboLabel, comboOf } from './shortcuts';
import { resolveStyles } from '@shared/styles';

export interface QuickCtx {
  settings: Settings;
  extras: store.YtExtras;
  keys: store.Keys;
  /** the voice really speaking now (a cloud voice without its key = the Mac voice) */
  voiceNow: 'mac' | 'openai' | 'elevenlabs' | 'azure';
  /** the Microsoft voices the learner's region has (null = not checked yet: all are shown) */
  azureAvail?: string[] | null;
  /** the Mac's English voices, and the one the tutor uses */
  macVoices: { id: string; name: string; lang: string }[];
  macVoice: string;
  /** what my own words say about my level */
  levelText?: string;
  /** say a test sentence with the chosen voice (teacher volume) / a test word (word volume) */
  testVoice(): void;
  testWord(): void;
  /** the online copy's last sync, in words */
  gist?: string;
  /** a phone: the page is always the book of subtitles */
  phone?: boolean;
  /** the minutes left on the sleep timer (0 = off), and how to set it */
  sleepMin?: number;
  setSleep?(minutes: number): void;
  /** start a test call */
  testCall(): void;
  close(): void;
  toast(text: string, ms?: number): void;
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
  // Microsoft: grouped by accent, woman / man, only the voices the learner's region has
  const azureOptions = (val: string) => {
    const have = ctx.azureAvail ? new Set(ctx.azureAvail) : null;
    const list = AZURE_VOICES.filter((v) => !have || have.has(v.id) || v.id === val);
    return AZURE_ACCENTS.map((acc) => {
      const vs = list.filter((v) => v.accent === acc);
      return vs.length ? `<optgroup label="${acc}">${vs.map((v) => `<option value="${esc(v.id)}"${v.id === val ? ' selected' : ''}>${esc(`${v.name} · ${v.gender}`)}</option>`).join('')}</optgroup>` : '';
    }).join('');
  };
  // the voice you really hear: a cloud voice without its key falls back to the Mac voice, so say so
  const now = ctx.voiceNow;
  const missing = now === 'mac' ? (x.voice === 'elevenlabs' ? 'ElevenLabs' : x.voice === 'azure' ? 'Microsoft' : x.voice === 'openai' ? 'OpenAI' : '') : '';
  const voiceRows = [
    missing ? `<p class="warn">No ${missing} key is saved, so you hear the Mac voice now. Paste your ${missing} key below (API keys) to use the ${missing} voices.</p>` : '',
    now === 'mac' && x.voice === 'auto' ? '<p class="warn">No Microsoft or OpenAI key is saved, so you hear the Mac voice now. Paste a free Microsoft key below (API keys) for a natural voice.</p>' : '',
    now === 'azure' ? `<label>Microsoft voice <select data-name="azureVoice">${azureOptions(x.azureVoice ?? AZURE_VOICES[0].id)}</select> <span class="muted">(★ = the best, they also say Chinese words)</span></label>
      <p class="muted az-used">Microsoft this month: counting…</p>` : '',
    now === 'openai' ? `<label>OpenAI voice <select data-name="openaiVoice">${options(OPENAI_VOICES, x.openaiVoice)}</select> <span class="muted">(the live call too)</span></label>` : '',
    now === 'elevenlabs' ? `<label>ElevenLabs voice <select data-name="elevenVoice">${options(ELEVEN_VOICES, x.elevenVoice)}</select> ${seg('elevenQ', x.elevenQuality ?? 'best', [['best', 'Best'], ['fast', 'Fast (half the credits)']])}</label>` : '',
    now === 'mac' ? (ctx.macVoices.length ? `<label>Mac voice <select data-name="macVoice">${options(ctx.macVoices.map((v) => ({ id: v.id, name: `${v.name} (${v.lang})` })), ctx.macVoice)}</select></label>` : '<p class="muted">No English Mac voice was found.</p>') : '',
    now !== 'openai' ? `<label>Live call voice <select data-name="openaiVoice">${options(OPENAI_VOICES, x.openaiVoice)}</select>${keys.openai ? '' : ' <span class="warn">needs an OpenAI key</span>'}</label>` : '',
  ].filter(Boolean).join('\n      ');
  el.innerHTML = `<div class="q-head"><b>Quick settings</b><span class="grow"></span><span class="muted">saved at once</span><button class="quiet" data-act="close" title="Close (Esc)">✕</button></div>
  <div class="q-body">
    <section><label>Volume ${slider('allVolume', x.teacherVolume ?? 60, 0, 100, 1, '%')} <span class="muted">the tutor and the words read to you, together</span></label></section>
    <section><h4>My tutor stops for</h4>
      <label>Words ${onOff('stopItemsOn', x.stopItemsOn !== false)} ${slider('capWords', x.capWords ?? 35, 0, 100, 5, '%')}</label>
      <label>Phrases ${onOff('stopPhrasesOn', x.stopPhrasesOn !== false)} ${slider('capPhrases', x.capPhrases ?? 15, 0, 100, 5, '%')}</label>
      <label>Whole sentences ${onOff('stopHardOn', x.stopHardOn !== false)} ${slider('capSentences', x.capSentences ?? 5, 0, 50, 1, '%')}</label>
      <p class="muted">How much of what is above your level the tutor explains, the hardest first: 100% = every hard word (phrase, sentence), 50% = the harder half, 10% = only the hardest 10%, 0% = never. Tap a word = explain it now; double tap = I know it. The tutor says the word ${s.listen.wordRepeats} times and waits ${Math.round((s.listen.commandWindowMs || 5000) / 1000)} seconds. "I know", "know", "bye" or "bye bye": marked known, no explanation, the video goes on. Say nothing: it explains.</p>
      <label>Explanations ${seg('teachLength', s.ai.explanationLength === 'short' || s.ai.explanationLength === 'long' ? s.ai.explanationLength : 'normal', [['short', 'Short'], ['normal', 'Mid'], ['long', 'Long']])}</label>
      <label>The same word not again within ${num('repeatWords', x.repeatWords ?? 1000, 0, 9999)} words · known after ${num('knownAfter', x.knownAfter ?? 7, 0, 20)} explanations</label>
      <label>Sleep timer ${seg('sleep', (ctx.sleepMin ?? 0) > 30 ? 60 : (ctx.sleepMin ?? 0) > 0 ? 30 : 0, [[0, 'Off'], [30, '30 min'], [60, '60 min']])}${ctx.sleepMin ? ` <span class="muted">${ctx.sleepMin} min left</span>` : ''}</label>
      <label>Microphone ${seg('mic', x.micLevel ?? 3, [[1, 'Low'], [2, 'Mid'], [3, 'High']])} <span class="muted">how easily it hears you</span></label>
      ${ctx.phone ? `<label>Talk through Bluetooth headphones ${onOff('headsetMic', !!x.headsetMic)} <span class="muted">their microphone hears you (the sound becomes phone-call quality while on). Wired headphones with a microphone always work.</span></label>` : ''}
      <label>Tutor's volume ${slider('teacherVolume', x.teacherVolume ?? 60, 0, 100, 1, '%')} <button type="button" data-act="test">▶ Test</button></label>
      <label>The word's volume ${slider('wordVolume', x.wordVolume ?? 80, 0, 100, 1, '%')} <button type="button" data-act="test-word">▶ Test</button></label>
      <label>Word test before each video ${seg('levelAsk', x.levelAsk !== false ? 'on' : 'off', [['on', 'On'], ['off', 'Off']])}</label>
      <label>Just talk ${onOff('voiceMode', !!x.voiceMode)} <span class="muted">“hello” = the tutor comes · “I know” · “bye bye” = the tutor goes, the video plays</span></label>
    </section>
    <section><h4>What you see</h4>
      <label>Play line ${slider('playLine', x.playLine ?? 40, 0, 100, 1, '')} <span class="muted">0 = bottom, 100 = top: the sentence being played or explained stays there</span></label>
      <label>Mode ${seg('view', x.view, [['listening', '🎧 Listening'], ['reading', '📖 Reading'], ['lyrics', '🎵 Lyrics'], ['normal', '🎬 Video']])}</label>
      ${x.view === 'reading' ? `<label>Reading look ${seg('readLook', x.readLook === 'night' ? 'night' : 'day', [['day', '☀️ Day'], ['night', '🌙 Night']])}</label>` : ''}
      <p class="muted">Listening: all the subtitles, the text moves with the sound. Reading: pages like a book, the text stays, a thin line follows the word and the pages turn by themselves (‹ › or a swipe turns them). Lyrics: the song's lyrics, an introduction to the song first, and explanations about the lyrics. Video: the video. Each mode has its own text size.</p>
      ${x.view === 'reading' ? `<label>Text size (Reading) ${slider('readSize', x.readSizePx ?? 22, 12, 60, 1, 'px')}</label>` : x.view === 'normal' ? (ctx.phone ? `<label>Text size (Video: the subtitles on the video) ${slider('phoneBand', x.phoneBandPx ?? 17, 12, 40, 1, 'px')}</label>` : `<label>Text size (Video: the subtitles on the video) ${slider('bandSize', s.appearance.subtitleSizePx || 26, 16, 96, 1, 'px')}</label>`) : ctx.phone ? `<label>Text size (Listening) ${slider('phoneSize', x.phoneSizePx ?? 21, 14, 48, 1, 'px')}</label>` : `<label>Text size (Listening) ${slider('stageSize', x.stageSizePx, 16, 96, 1, 'px')}</label>`}
      <label>Letters ${slider('textWeight', x.textWeight ?? 400, 200, 800, 100, '')} <span class="muted">thinner ← → bolder</span></label>
      ${ctx.phone ? `<label>E button on every sentence ${onOff('sentenceButtons', !!x.sentenceButtons)}</label>
      <label>Show what the tutor says as text ${onOff('showSay', !!x.showSay)}</label>` : `<label>Page at every stop ${onOff('stageOn', x.stageOn)}</label>`}
      <label>When I pause: play the part again first ${onOff('replayPart', x.replayPart)}</label>
      <label>Part length ${seg('seconds', s.listen.lastSecondsWindow, [[10, '10 s'], [20, '20 s'], [30, '30 s']])}</label>
      <label>Complete sentences by the AI <span class="muted">(only when the video has no good official subtitles)</span> ${onOff('aiSentences', x.aiSentences)}</label>
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
      ${ctx.phone ? '' : `<label>Reading page ${slider('stageSize', x.stageSizePx, 16, 96, 1, 'px')}</label>`}
      <label>Side panel ${slider('panelSize', s.appearance.fontSizePx || 19, 12, 48, 1, 'px')}</label>
      <label>Subtitles over the video ${slider('bandSize', s.appearance.subtitleSizePx || 26, 16, 96, 1, 'px')}</label>
      <label>Chinese under each line (AI, live) ${onOff('zhLines', x.zhLines)}</label>
      <label>Chinese hint under hard words ${onOff('hints', s.appearance.showHints !== false)}</label>
      <label>Hide YouTube's own captions ${onOff('hideCc', x.hideYtCaptions)}</label>
    </section>
    <section><h4>Voice</h4>
      <label>Follow the video's volume ${onOff('followVol', x.followVideoVolume !== false)} <span class="muted">(100 % = as loud as the video)</span></label>
      <label>Tutor's voice ${seg('voice', x.voice, [['auto', 'Auto'], ['azure', 'Microsoft (free)'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], ['mac', 'Mac']])}</label>
      ${voiceRows}
      <label>Speed ${slider('rate', Math.round((s.voice.rate || 1) * 100) / 100, 0.6, 1.6, 0.05, '×')}</label>
      <label>Say the Chinese meanings at the end ${onOff('speakChinese', s.ai.speakChinese)}</label>
      <p class="muted">Auto = the Microsoft voice when its key is saved, else the OpenAI voice with an OpenAI key, else the Mac voice. One hour of the tutor speaking costs about: Microsoft $0 (free about 9 hours a month, then about $0.90), OpenAI $0.90, ElevenLabs $3 or more, Mac free.</p>
    </section>
    <section><h4>Talk to my tutor</h4>
      <label>After each explanation ${onOff('talkAfter', x.talkAfterExplain)}</label>
      <label>Voice call ${onOff('liveOn', x.liveOn)} <button type="button" data-act="test-call">📞 Test the call</button></label>
      <label>Talk with ${seg('callEngine', x.callEngine ?? 'claude', [['claude', 'Claude + my tutor’s voice (no OpenAI)'], ['openai', 'OpenAI realtime']])}${(x.callEngine ?? 'claude') === 'openai' && !keys.openai ? ' <span class="warn">needs an OpenAI key with credit</span>' : ''}</label>
      ${(x.callEngine ?? 'claude') === 'openai' ? `<label>Live model ${seg('liveModel', x.liveModel, [['gpt-realtime-2.1', 'Best'], ['gpt-realtime-2.1-mini', 'Cheaper']])}</label>` : '<p class="muted">You talk, Chrome writes down your words, Claude answers, and your tutor’s voice speaks. Say “stop” (or press Space) to interrupt, “go on” to go back to the video.</p>'}
      <label>Microphone on ${seg('micAlways', x.micAlways ? 'always' : 'needed', [['needed', 'Only when the tutor waits for me'], ['always', 'Always (for “hi bro”)']])}</label>
      <p class="muted">“Always” keeps the Mac’s microphone on, which makes the sound quieter and a little broken. “Only when…” is clean.</p>
      <label>Go on ${seg('silence', x.talkSilenceSec > 0 ? 'auto' : 'wait', [['wait', 'Wait for me'], ['auto', 'After quiet seconds']])}${x.talkSilenceSec > 0 ? ` <input type="number" data-name="silenceSec" min="3" max="120" value="${x.talkSilenceSec}" style="width:64px"> s` : ''}</label>
      <p class="muted">After an explanation you have a moment to ask; then the video goes on by itself. Say “bye bye” (or press Esc) to stop the AI at any time; Space pauses the teacher so you can ask.</p>
    </section>
    <section><h4>My teacher</h4>
      <label>My level ${seg('level', s.learnerLevel, CEFR_LEVELS.map((l) => [l, l] as [string, string]))}</label>
      <label>Level from my words ${onOff('levelAuto', x.levelAuto !== false)} <span class="muted">(up when you know most words of the next level, down when many of yours are new)</span></label>
      ${ctx.levelText ? `<p class="muted">${esc(ctx.levelText)}</p>` : ''}
      <label>AI <select data-name="model">${CLAUDE_MODELS.map(([v, l]) => `<option value="anthropic:${v}"${s.ai.provider === 'anthropic' && s.ai.anthropicModel === v ? ' selected' : ''}>${l}</option>`).join('')}<option value="openai:${esc(s.ai.openaiModel)}"${s.ai.provider === 'openai' ? ' selected' : ''}>OpenAI ${esc(s.ai.openaiModel)}</option></select></label>
      ${wayRows}
      <label class="col">My teacher's instructions <span class="muted">(write anything: how to teach, the personality)</span><textarea data-name="teacher" rows="9">${esc(x.teacher)}</textarea><span><button type="button" data-act="teacher-reset">Use my rules again</button></span></label>
      <label>Say the word before ${num('wordRepeats', s.listen.wordRepeats, 0, 10)} after ${num('wordAfter', shape.wordAfter, 0, 20)} times · play the sentence after a word ${num('sentenceAfterWord', shape.sentenceAfterWord, 0, 3)} · a sentence before ${num('sentenceBefore', shape.sentenceBefore, 0, 3)} after ${num('sentenceAfter', shape.sentenceAfter, 0, 3)}</label>
      <label>Commands window ${num('windowSec', Math.round((s.listen.commandWindowMs || 5000) / 1000), 2, 15)} s</label>
    </section>
    <section><h4>API keys</h4>
      ${(['azure', 'anthropic', 'openai', 'elevenlabs', 'github'] as const).map((k) => `<label${k === 'azure' && !keys.azure ? ' class="hl"' : ''}>${k === 'anthropic' ? 'Claude' : k === 'openai' ? 'OpenAI' : k === 'azure' ? 'Microsoft (Azure Speech) — the free voice, Key 1' : k === 'github' ? 'GitHub token (your words online, shared with your computer)' : 'ElevenLabs'} <input type="password" data-key="${k}" placeholder="${keys[k] ? `saved (…${esc(keys[k]!.slice(-4))})` : 'paste your key'}" autocomplete="off"><button type="button" data-act="save-key" data-k="${k}">Save</button></label>`).join('')}
      <label>Microsoft region <input type="text" data-name="azureRegion" value="${esc(x.azureRegion ?? 'eastus')}" placeholder="eastus" style="width:140px" autocomplete="off"> <button type="button" data-act="test-azure">Test</button> <span class="muted">(“Location/Region” of your Speech resource)</span></label>
      <p class="muted">Keys stay on this device (on the iPhone in its Keychain). Claude explains; Microsoft (free), OpenAI or ElevenLabs give the voice. The GitHub token (github.com → Settings → Developer settings → Fine-grained tokens, with only "Gists: Read and write") keeps your words in one private gist, shared by the phone and the computer within seconds.${ctx.gist ? ` ${esc(ctx.gist)}` : ''}</p>
    </section>
    <section><h4>Shortcuts <span class="muted">(click one, then press the new keys)</span></h4>
      <div class="keys">${SHORTCUTS.map((a) => `<div><span>${esc(a.label)}</span><button type="button" data-sc="${a.id}">${esc(comboLabel(sc[a.id]))}</button></div>`).join('')}</div>
      <span><button type="button" data-act="sc-reset">Default shortcuts</button></span>
    </section>
    <section><h4>Level Check</h4>
      <button type="button" data-act="copy-level">Copy my level for Claude</button>
    </section>
    <section class="links"><button type="button" data-act="all">All settings</button><button type="button" data-act="vocab">📒 My Vocabulary</button><button type="button" data-act="reader">📖 Read a PDF or text</button></section>
  </div>`;

  // the Microsoft voice: how much of this month's free 500,000 characters is used (counted on this computer)
  const azUsed = el.querySelector<HTMLElement>('.az-used');
  if (azUsed) void store.getUsage().then((u) => {
    const r = store.azureUsageText(store.azureCharsSince(u, store.periodStarts().month));
    azUsed.textContent = r.text;
    azUsed.className = r.low ? 'warn az-used' : 'muted az-used';
  }, () => undefined);
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
      else if (segName === 'showSay') void store.patchExtras({ showSay: v === 'on' });
      else if (segName === 'stopItemsOn') void store.patchExtras({ stopItemsOn: v === 'on' });
      else if (segName === 'stopHardOn') void store.patchExtras({ stopHardOn: v === 'on' });
      else if (segName === 'stopPhrasesOn') void store.patchExtras({ stopPhrasesOn: v === 'on' });
      else if (segName === 'readLook') void store.patchExtras({ readLook: v === 'night' ? 'night' : 'day' });
      else if (segName === 'sentenceButtons') void store.patchExtras({ sentenceButtons: v === 'on' });
      else if (segName === 'headsetMic') void store.patchExtras({ headsetMic: v === 'on' });
      else if (segName === 'teachLength') patchAi({ explanationLength: v as Settings['ai']['explanationLength'] });
      else if (segName === 'sleep') ctx.setSleep?.(Number(v));
      else if (segName === 'replayPart') void store.patchExtras({ replayPart: v === 'on' });
      else if (segName === 'aiSentences') void store.patchExtras({ aiSentences: v === 'on' });
      else if (segName === 'stopWords') patchListen({ autoExplainWords: v === 'on' });
      else if (segName === 'stopPhrases') patchListen({ autoExplainPhrases: v === 'on' });
      else if (segName === 'stopSentences') void store.patchExtras({ stopSentences: v === 'on' });
      else if (segName === 'seconds') patchListen({ lastSecondsWindow: Number(v) as Settings['listen']['lastSecondsWindow'] });
      else if (segName === 'zhLines') void store.patchExtras({ zhLines: v === 'on' });
      else if (segName === 'hints') patchLook({ showHints: v === 'on' });
      else if (segName === 'levelAsk') void store.patchExtras({ levelAsk: v === 'on' });
      else if (segName === 'hideCc') void store.patchExtras({ hideYtCaptions: v === 'on' });
      else if (segName === 'voice') void store.patchExtras({ voice: v as store.VoiceChoice });
      else if (segName === 'speakChinese') patchAi({ speakChinese: v === 'on' });
      else if (segName === 'talkAfter') void store.patchExtras({ talkAfterExplain: v === 'on' });
      else if (segName === 'liveOn') void store.patchExtras({ liveOn: v === 'on' });
      else if (segName === 'liveModel') void store.patchExtras({ liveModel: v });
      else if (segName === 'elevenQ') void store.patchExtras({ elevenQuality: v as store.YtExtras['elevenQuality'] });
      else if (segName === 'voiceMode') void store.patchExtras({ voiceMode: v === 'on' });
      else if (segName === 'micAlways') void store.patchExtras({ micAlways: v === 'always' });
      else if (segName === 'callEngine') void store.patchExtras({ callEngine: v as store.YtExtras['callEngine'] });
      else if (segName === 'mic') void store.patchExtras({ micLevel: Number(v) as 1 | 2 | 3 });
      else if (segName === 'silence') void store.patchExtras({ talkSilenceSec: v === 'auto' ? 3 : 0 });
      // (a level chosen by hand stays: the automatic level is turned off)
      else if (segName === 'level') { void store.patchSettings({ learnerLevel: v as Settings['learnerLevel'] }); void store.patchExtras({ levelAuto: false }); }
      else if (segName === 'levelAuto') void store.patchExtras({ levelAuto: v === 'on' });
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
    else if (act === 'test-call') { ctx.close(); ctx.testCall(); }
    else if (act === 'test-azure') void (chrome.runtime.sendMessage({ type: 'dream-test-azure' }) as Promise<{ ok: boolean; message: string }>).then((r) => ctx.toast(r?.message ?? 'No answer.', 9000), () => ctx.toast('No answer.'));
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
      // a Microsoft key pasted into another box (ElevenLabs keys start with sk_, OpenAI ones with sk-): saved as Microsoft
      // (not for a GitHub token: it never goes anywhere but GitHub)
      if (k !== 'azure' && k !== 'anthropic' && k !== 'github' && k !== 'genius' && !/^sk[-_]/.test(v)) {
        void (chrome.runtime.sendMessage({ type: 'dream-test-azure', key: v }) as Promise<{ ok: boolean; message: string } | undefined>).then(async (r) => {
          if (!r?.ok) { void store.setKey(k, v).then(() => { if (inp) inp.value = ''; ctx.toast('Key saved.'); }); return; }
          await store.setKey('azure', v);
          await store.patchExtras({ voice: 'azure' });
          if (inp) inp.value = '';
          ctx.toast(`This is your Microsoft key, so it is saved as Microsoft. ${r.message} Your tutor speaks with it now.`, 9000);
        }, () => ctx.toast('No answer.'));
        return;
      }
      void store.setKey(k, v).then(async () => {
        if (inp) inp.value = '';
        if (k !== 'azure') { ctx.toast('Key saved.'); return; }
        // the Microsoft key: the tutor speaks with it now, and we check it works
        await store.patchExtras({ voice: 'azure' });
        const r = (await chrome.runtime.sendMessage({ type: 'dream-test-azure' }).catch(() => null)) as { ok: boolean; message: string } | null;
        ctx.toast(r ? (r.ok ? `Key saved. ${r.message} Your tutor speaks with it now.` : `Key saved, but: ${r.message}`) : 'Key saved.', 9000);
      });
    } else if (act === 'sc-reset') void store.patchExtras({ shortcuts: {} });
    else if (act === 'all') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'options' });
    else if (act === 'vocab') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'vocab' });
    else if (act === 'reader') void chrome.runtime.sendMessage({ type: 'dream-open', page: 'reader' });
    else if (act === 'copy-level') void copyLevel().then((how) => { if (how === 'copied') ctx.toast('Your level is copied. Paste it to Claude.'); }, () => ctx.toast('It could not be copied.'));
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
    if (name === 'playLine') later(() => void store.patchExtras({ playLine: n }));
    else if (name === 'capWords') later(() => void store.patchExtras({ capWords: n }), 300);
    else if (name === 'capSentences') later(() => void store.patchExtras({ capSentences: n }), 300);
    else if (name === 'capPhrases') later(() => void store.patchExtras({ capPhrases: n }), 300);
    else if (name === 'repeatWords' && t.value !== '') later(() => void store.patchExtras({ repeatWords: Math.max(0, n) }), 500);
    else if (name === 'knownAfter' && t.value !== '') later(() => void store.patchExtras({ knownAfter: Math.max(0, n) }), 500);
    else if (name === 'phoneSize') later(() => void store.patchExtras({ phoneSizePx: n }), 120);
    else if (name === 'readSize') later(() => void store.patchExtras({ readSizePx: n }), 120);
    else if (name === 'phoneBand') later(() => void store.patchExtras({ phoneBandPx: n }), 120);
    else if (name === 'textWeight') later(() => void store.patchExtras({ textWeight: n }), 120);
    else if (name === 'stageSize') later(() => void store.patchExtras({ stageSizePx: n }), 120);
    else if (name === 'panelSize') later(() => patchLook({ fontSizePx: n }), 120);
    else if (name === 'bandSize') later(() => patchLook({ subtitleSizePx: n }), 120);
    else if (name === 'rate') later(() => patchS((cur) => ({ voice: { ...cur.voice, rate: n } })));
    else if (name === 'allVolume') later(() => void store.patchExtras({ teacherVolume: n, wordVolume: n }), 120);
    else if (name === 'teacherVolume') later(() => void store.patchExtras({ teacherVolume: n }), 120);
    else if (name === 'wordVolume') later(() => void store.patchExtras({ wordVolume: n }), 120);
    else if (name === 'bandBottom') later(() => void store.patchExtras({ bandBottom: n }), 80);
    else if (name === 'videoSize') later(() => void store.patchExtras({ videoSize: n }), 200);
    else if (name === 'teacher') later(() => void store.patchExtras({ teacher: t.value }), 600);
    else if (name === 'azureRegion') later(() => void store.patchExtras({ azureRegion: store.azureRegionOf(t.value) || 'eastus' }), 600);
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
    else if (name === 'azureVoice') void store.patchExtras({ azureVoice: t.value }).then(() => ctx.toast('Voice changed.'));
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
