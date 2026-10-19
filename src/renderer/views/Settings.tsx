import React, { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import type { Settings, TtsEngineId, AiProviderId } from '@shared/settings';
import { DEFAULT_SETTINGS, DEFAULT_INSTRUCTIONS } from '@shared/settings';
import { CEFR_LEVELS } from '@core/model';
import { ENGINE_LABELS, AVAILABLE_ENGINES, type TtsVoice } from '@core/tts/engine';
import { getEngine, defaultVoiceFor } from '@core/tts/registry';
import { shortcutLabel } from '../reader/shortcuts';
import { SECRET_LABELS, type SecretName, type SecretStatus, type SecretStatusMap } from '@shared/api';

export const STORAGE_NOTE = 'Keys are stored encrypted in the app\'s own data folder; they survive updates and re-signing.';
const EMPTY_STATUS: SecretStatus = { saved: false, verified: false, lostAtStartup: false };
export const NO_KEYS: SecretStatusMap = { anthropic: EMPTY_STATUS, openai: EMPTY_STATUS, elevenlabs: EMPTY_STATUS, azure: EMPTY_STATUS, google: EMPTY_STATUS };
const KEY_PLACEHOLDER: Record<SecretName, string> = { anthropic: 'sk-ant-…', openai: 'sk-…', elevenlabs: 'sk_… or 32 hex characters', azure: 'Speech resource key', google: 'AIza…' };

type Section = 'start' | 'ai' | 'voice' | 'level' | 'appearance' | 'shortcuts' | 'data';

const AI_MODELS: { provider: AiProviderId; id: string; name: string; cost: string; note: string }[] = [
  { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', cost: 'about 1–2 cents a day', note: 'Fast and cheap. Fine for word meanings.' },
  { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', cost: 'about 30 cents a day', note: 'Smarter, more natural explanations.' },
  { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', cost: 'about 65 cents a day', note: 'Best quality.' },
  { provider: 'openai', id: 'gpt-5.4-mini', name: 'ChatGPT: GPT-5.4 mini', cost: 'about 10 cents a day', note: 'Fast and cheap.' },
  { provider: 'openai', id: 'gpt-5.6-terra', name: 'ChatGPT: GPT-5.6', cost: 'about 30 cents a day', note: 'Higher quality.' },
];

export function SettingsView(): JSX.Element {
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSettings);
  const [section, setSection] = useState<Section>(settings.onboarded ? 'ai' : 'start');
  const [keys, setKeys] = useState<SecretStatusMap>(NO_KEYS);
  const [keyInput, setKeyInput] = useState<Partial<Record<SecretName, string>>>({});
  const [azureRegion, setAzureRegion] = useState<string>('uksouth');
  /** per key: the warning or error from the last Save */
  const [keyNotes, setKeyNotes] = useState<Partial<Record<SecretName, string>>>({});
  const [testResult, setTestResult] = useState<Partial<Record<SecretName, string>>>({});
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [usage, setUsage] = useState<{ today: number; month: number }>({ today: 0, month: 0 });

  const refreshKeys = async () => { try { setKeys(await window.readalong.secretStatus()); } catch { /* main not ready */ } };
  useEffect(() => { void refreshKeys(); }, []);
  useEffect(() => {
    (async () => {
      const list: TtsVoice[] = [];
      for (const id of Object.keys(ENGINE_LABELS) as TtsEngineId[]) {
        try { list.push(...(await getEngine(id).listVoices())); } catch { /* not configured */ }
      }
      setVoices(list);
    })();
  }, [keys]);
  useEffect(() => {
    void window.readalong.getUsage().then((records) => {
      const today = new Date().toISOString().slice(0, 10); const month = today.slice(0, 7);
      setUsage({ today: records.filter((r) => r.date.startsWith(today)).reduce((s, r) => s + r.usd, 0), month: records.filter((r) => r.date.startsWith(month)).reduce((s, r) => s + r.usd, 0) });
    });
  }, [section]);

  const saveKey = async (name: SecretName) => {
    let value = keyInput[name]?.trim() ?? '';
    if (name === 'azure' && value) value = JSON.stringify({ key: value, region: azureRegion.trim().toLowerCase() || 'uksouth' });
    setTestResult((t) => ({ ...t, [name]: '' }));
    try {
      const r = await window.readalong.setSecret(name, value);
      setKeyNotes((n) => ({ ...n, [name]: r.warning ?? 'Saved and verified.' }));
      setKeyInput((k) => ({ ...k, [name]: '' }));
    } catch (e) {
      setKeyNotes((n) => ({ ...n, [name]: `Could not save: ${(e as Error).message}` }));
    }
    await refreshKeys();
  };
  const removeKey = async (name: SecretName) => { await window.readalong.setSecret(name, ''); setKeyNotes((n) => ({ ...n, [name]: '' })); setTestResult((t) => ({ ...t, [name]: '' })); await refreshKeys(); };
  const testKey = async (name: SecretName) => {
    setTestResult((t) => ({ ...t, [name]: 'Testing…' }));
    try { const r = await window.readalong.aiTest(name); setTestResult((t) => ({ ...t, [name]: `${r.ok ? '✅' : '❌'} ${r.message}` })); }
    catch (e) { setTestResult((t) => ({ ...t, [name]: `❌ ${(e as Error).message}` })); }
  };
  const dismissLost = async () => { await window.readalong.dismissLostKeys(); await refreshKeys(); };
  const previewVoice = async (engine: TtsEngineId, voiceId: string) => {
    const e = getEngine(engine);
    e.cancelAll();
    const id = voiceId || (await defaultVoiceFor(engine));
    e.speak('Hello! This is how I will read your books. The quick brown fox jumps over the lazy dog.', { voiceId: id, rate: settings.voice.rate });
  };
  const S = settings;
  const set = (p: Partial<Settings>) => void patch(p);

  const nav: { id: Section; label: string }[] = [
    ...(S.onboarded ? [] : [{ id: 'start' as Section, label: 'Welcome' }]),
    { id: 'ai', label: 'AI explanations' }, { id: 'voice', label: 'Voice & speed' }, { id: 'level', label: 'Level & stops' },
    { id: 'appearance', label: 'Appearance' }, { id: 'shortcuts', label: 'Shortcuts' }, { id: 'data', label: 'Usage & data' },
  ];

  return (
    <div className="settings" data-testid="settings">
      <nav>
        {nav.map((n) => <button key={n.id} className={section === n.id ? 'active' : ''} onClick={() => setSection(n.id)}>{n.label}</button>)}
        <span style={{ flex: 1 }} />
        {!S.onboarded && <button className="primary" data-testid="finish-onboarding" onClick={() => { set({ onboarded: true }); useApp.getState().setView('library'); }}>Done, open my library</button>}
      </nav>

      {section === 'start' && (
        <section>
          <h2>Welcome to ReadAlong</h2>
          <p>ReadAlong reads English books aloud with a British voice, shows the meaning of any word you tap, and explains hard words and sentences with Claude or ChatGPT, spoken aloud, like a tutor sitting next to you.</p>
          <p>Three things to set up, each takes a minute:</p>
          <ol>
            <li><b>AI explanations</b>: choose Claude or ChatGPT and paste an API key. Without a key, tapping words still shows the dictionary meaning; only the spoken explanations need the key.</li>
            <li><b>Voice</b>: the Mac voices work right away. For a much better British voice, download “Daniel (Enhanced)” or “Serena (Premium)” once in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices, then pick it here.</li>
            <li><b>Your level</b>: words above your level are highlighted and explained automatically in listening mode.</li>
          </ol>
          <div className="row"><button className="primary" onClick={() => setSection('ai')}>Start with AI settings →</button></div>
        </section>
      )}

      {section === 'ai' && (
        <section>
          <h2>AI explanations</h2>
          <div className="field">
            <label>Which AI explains things?</label>
            <div className="choice-grid">
              {AI_MODELS.map((m) => {
                const active = S.ai.provider === m.provider && (m.provider === 'anthropic' ? S.ai.anthropicModel : S.ai.openaiModel) === m.id;
                return (
                  <div key={m.id} className={`choice ${active ? 'active' : ''}`} onClick={() => set({ ai: { ...S.ai, provider: m.provider, ...(m.provider === 'anthropic' ? { anthropicModel: m.id } : { openaiModel: m.id }) } })} data-testid={`model-${m.id}`}>
                    <span className="name">{m.name}</span>
                    <span className="cost">{m.cost} at 3 hours of listening</span>
                    <span className="cost">{m.note}</span>
                  </div>
                );
              })}
            </div>
            <div className="hint">Costs are estimates for about 120 explanations a day. You pay the AI company directly through your own API key; this app adds nothing.</div>
          </div>
          <div className="field">
            <label><KeyStatusDot status={keys[S.ai.provider]} /> {S.ai.provider === 'anthropic' ? 'Anthropic API key' : 'OpenAI API key'} <KeyBadge status={keys[S.ai.provider]} /></label>
            <LostKeyNotice name={S.ai.provider} status={keys[S.ai.provider]} onDismiss={dismissLost} />
            <div className="row">
              <input type="password" style={{ flex: 1 }} placeholder={KEY_PLACEHOLDER[S.ai.provider]} value={keyInput[S.ai.provider] ?? ''} onChange={(e) => setKeyInput((k) => ({ ...k, [S.ai.provider]: e.target.value }))} data-testid="api-key" />
              <button className="primary" onClick={() => saveKey(S.ai.provider)} disabled={!keyInput[S.ai.provider]?.trim()}>Save key</button>
              <button onClick={() => testKey(S.ai.provider)} disabled={!keys[S.ai.provider].saved}>Test</button>
              {keys[S.ai.provider].saved && <button onClick={() => removeKey(S.ai.provider)}>Remove</button>}
            </div>
            {keyNotes[S.ai.provider] && <div className="hint" data-testid="key-note">{keyNotes[S.ai.provider]}</div>}
            {testResult[S.ai.provider] && <div className="hint" data-testid="test-result">{testResult[S.ai.provider]}</div>}
            <div className="hint">
              {S.ai.provider === 'anthropic'
                ? <>Get a key: sign in at <a href="#" onClick={(e) => { e.preventDefault(); void window.readalong.openExternal('https://platform.claude.com/'); }}>platform.claude.com</a>, open Billing to add 5 dollars of credit, then API keys → Create key.</>
                : <>Get a key: sign in at <a href="#" onClick={(e) => { e.preventDefault(); void window.readalong.openExternal('https://platform.openai.com/api-keys'); }}>platform.openai.com</a>, add credit under Billing, then create an API key.</>}
              {' '}{STORAGE_NOTE}
            </div>
          </div>
          <div className="field">
            <label>Your instructions to the AI</label>
            <textarea value={S.ai.instructions} onChange={(e) => set({ ai: { ...S.ai, instructions: e.target.value } })} />
            <div className="hint">Paste the same instructions you use in ChatGPT or Claude. <a href="#" onClick={(e) => { e.preventDefault(); set({ ai: { ...S.ai, instructions: DEFAULT_INSTRUCTIONS } }); }}>Reset to default</a></div>
          </div>
          <div className="row">
            <div className="field"><label>Explanation length</label>
              <select value={S.ai.explanationLength} onChange={(e) => set({ ai: { ...S.ai, explanationLength: e.target.value as never } })}><option value="short">Short</option><option value="normal">Normal</option><option value="long">Long</option></select></div>
            <div className="field"><label>Speak the Chinese meaning</label>
              <select value={S.ai.speakChinese ? '1' : '0'} onChange={(e) => set({ ai: { ...S.ai, speakChinese: e.target.value === '1' } })}><option value="1">Yes, with the Mac Chinese voice</option><option value="0">No, show it only</option></select></div>
          </div>
          <div className="row">
            <div className="field"><label>Warn me when a day costs more than</label><div className="row">$<input type="number" min={0} step={0.5} style={{ width: 90 }} value={S.ai.dailyWarnUsd} onChange={(e) => set({ ai: { ...S.ai, dailyWarnUsd: Number(e.target.value) } })} /></div></div>
            <div className="field"><label>Stop AI for the month after</label><div className="row">$<input type="number" min={0} step={1} style={{ width: 90 }} value={S.ai.monthlyStopUsd} onChange={(e) => set({ ai: { ...S.ai, monthlyStopUsd: Number(e.target.value) } })} /></div></div>
            <div className="field"><label>Spent</label><div className="hint">today ${usage.today.toFixed(2)} · this month ${usage.month.toFixed(2)}</div></div>
          </div>
        </section>
      )}

      {section === 'voice' && (
        <section>
          <h2>Voice & speed</h2>
          <div className="field">
            <label>Reading voice</label>
            <div className="choice-grid">
              {AVAILABLE_ENGINES.map((id) => {
                const m = ENGINE_LABELS[id];
                const needsKey = id === 'openai' ? !keys.openai.saved : id === 'elevenlabs' ? !keys.elevenlabs.saved : false;
                return (
                  <div key={id} className={`choice ${S.voice.engine === id ? 'active' : ''}`} onClick={() => set({ voice: { ...S.voice, engine: id, voiceId: '' } })} data-testid={`engine-${id}`}>
                    <span className="name">{m.label} <span className={`badge ${m.cost.startsWith('Free') ? 'free' : 'paid'}`}>{m.cost.startsWith('Free') ? 'free' : 'paid'}</span></span>
                    <span className="cost">{m.cost}</span>
                    <span className="cost">{m.quality}</span>
                    {needsKey && <span className="cost">Needs an API key (below)</span>}
                  </div>
                );
              })}
            </div>
          </div>
          <VoicePicker label="Voice" engine={S.voice.engine} voiceId={S.voice.voiceId} voices={voices} onChange={(voiceId) => set({ voice: { ...S.voice, voiceId } })} onPreview={() => previewVoice(S.voice.engine, S.voice.voiceId)} />
          {S.voice.engine === 'webspeech' && <div className="hint">Better free British voices: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… → English (UK) → download Daniel (Enhanced), Serena (Premium) or Jamie (Premium). Restart ReadAlong afterwards and pick the new voice here.</div>}
          <div className="field">
            <label>Explanation voice</label>
            <select value={S.voice.explainEngine ?? ''} onChange={(e) => set({ voice: { ...S.voice, explainEngine: (e.target.value || null) as TtsEngineId | null, explainVoiceId: null } })}>
              <option value="">Same as the reading voice</option>
              {AVAILABLE_ENGINES.map((id) => <option key={id} value={id}>{ENGINE_LABELS[id].label} · {ENGINE_LABELS[id].cost}</option>)}
            </select>
          </div>
          {S.voice.explainEngine && <VoicePicker label="Explanation voice" engine={S.voice.explainEngine} voiceId={S.voice.explainVoiceId ?? ''} voices={voices} onChange={(explainVoiceId) => set({ voice: { ...S.voice, explainVoiceId } })} onPreview={() => previewVoice(S.voice.explainEngine!, S.voice.explainVoiceId ?? '')} />}
          <div className="row">
            <div className="field"><label>Speed: {S.voice.rate.toFixed(1)}×</label><input type="range" min={0.5} max={2.5} step={0.1} value={S.voice.rate} onChange={(e) => set({ voice: { ...S.voice, rate: Number(e.target.value) } })} /></div>
            <div className="field"><label>Pause between sentences (ms)</label><input type="number" min={0} max={3000} step={50} style={{ width: 100 }} value={S.voice.pauseBetweenSentencesMs} onChange={(e) => set({ voice: { ...S.voice, pauseBetweenSentencesMs: Number(e.target.value) } })} /></div>
          </div>
          <div className="field">
            <label>Keys for paid voices</label>
            {(['openai', 'elevenlabs', 'azure', 'google'] as const).map((name) => (
              <React.Fragment key={name}>
                <LostKeyNotice name={name} status={keys[name]} onDismiss={dismissLost} />
                <div className="row" data-testid={`voice-key-${name}`}>
                  <span style={{ width: 150 }}><KeyStatusDot status={keys[name]} /> {SECRET_LABELS[name]} <KeyBadge status={keys[name]} /></span>
                  <input type="password" style={{ flex: 1 }} placeholder={KEY_PLACEHOLDER[name]} value={keyInput[name] ?? ''} onChange={(e) => setKeyInput((k) => ({ ...k, [name]: e.target.value }))} />
                  {name === 'azure' && <input type="text" style={{ width: 110 }} placeholder="region" title="Azure region of the Speech resource, e.g. uksouth" value={azureRegion} onChange={(e) => setAzureRegion(e.target.value)} />}
                  <button onClick={() => saveKey(name)} disabled={!keyInput[name]?.trim()}>Save</button>
                  <button onClick={() => testKey(name)} disabled={!keys[name].saved}>Test</button>
                  {keys[name].saved && <button onClick={() => removeKey(name)}>Remove</button>}
                </div>
                {keyNotes[name] && <div className="hint">{keyNotes[name]}</div>}
                {testResult[name] && <div className="hint" data-testid={`test-result-${name}`}>{testResult[name]}</div>}
              </React.Fragment>
            ))}
            <div className="hint">The OpenAI key is shared with ChatGPT explanations. Azure needs the key and the region of your Speech resource; Google needs a Cloud API key with the Text-to-Speech API enabled. Azure and Google voices are coming in a later version; the keys can already be saved and tested. Microsoft Edge voices need no key but use an unofficial free service that may stop working one day. {STORAGE_NOTE}</div>
          </div>
        </section>
      )}

      {section === 'level' && (
        <section>
          <h2>Level & stops</h2>
          <div className="field">
            <label>My English level</label>
            <div className="row">{CEFR_LEVELS.map((l) => <button key={l} className={S.learnerLevel === l ? 'primary' : ''} onClick={() => set({ learnerLevel: l })} data-testid={`level-${l}`}>{l}</button>)}</div>
            <div className="hint">Words above this level are highlighted in blue. In listening mode the reading stops at them and the AI explains them. Double-click a highlighted word to mark it known.</div>
          </div>
          <div className="field"><label>In listening mode, stop and explain</label>
            <div className="row">
              <label><input type="checkbox" checked={S.listen.autoExplainWords} onChange={(e) => set({ listen: { ...S.listen, autoExplainWords: e.target.checked } })} /> highlighted words</label>
              <label><input type="checkbox" checked={S.listen.autoExplainPhrases} onChange={(e) => set({ listen: { ...S.listen, autoExplainPhrases: e.target.checked } })} /> highlighted phrases</label>
              <label><input type="checkbox" checked={S.listen.firstOccurrencePerChapterOnly} onChange={(e) => set({ listen: { ...S.listen, firstOccurrencePerChapterOnly: e.target.checked } })} /> only the first time a word appears in a chapter</label>
            </div>
          </div>
          <div className="row">
            <div className="field"><label>Say the word (times, before and after)</label><input type="number" min={0} max={5} style={{ width: 80 }} value={S.listen.wordRepeats} onChange={(e) => set({ listen: { ...S.listen, wordRepeats: Number(e.target.value) } })} /></div>
            <div className="field"><label>Repeat the sentence after a word (times)</label><input type="number" min={0} max={4} style={{ width: 80 }} value={S.listen.sentenceRepeatsAfterWord} onChange={(e) => set({ listen: { ...S.listen, sentenceRepeatsAfterWord: Number(e.target.value) } })} /></div>
            <div className="field"><label>Repeat a sentence being explained (total)</label><input type="number" min={1} max={4} style={{ width: 80 }} value={S.listen.sentenceRepeatsForPhrase} onChange={(e) => set({ listen: { ...S.listen, sentenceRepeatsForPhrase: Number(e.target.value) } })} /></div>
          </div>
          <div className="row">
            <div className="field"><label>Maximum stops per 10 minutes (0 = no limit)</label><input type="number" min={0} max={30} style={{ width: 80 }} value={S.listen.maxStopsPer10Min} onChange={(e) => set({ listen: { ...S.listen, maxStopsPer10Min: Number(e.target.value) } })} /></div>
            <div className="field"><label>“Explain last” window</label><select value={S.listen.lastSecondsWindow} onChange={(e) => set({ listen: { ...S.listen, lastSecondsWindow: Number(e.target.value) as never } })}>{[20, 30, 40, 60].map((s) => <option key={s} value={s}>{s} seconds</option>)}</select></div>
            <div className="field"><label>While listening, one tap on a highlighted word</label><select value={S.listen.tapHighlightCancels ? '1' : '0'} onChange={(e) => set({ listen: { ...S.listen, tapHighlightCancels: e.target.value === '1' } })}><option value="1">marks it known and keeps reading</option><option value="0">opens the word popup</option></select></div>
          </div>
        </section>
      )}

      {section === 'appearance' && (
        <section>
          <h2>Appearance</h2>
          <div className="row">
            <div className="field"><label>Theme</label><select value={S.appearance.theme} onChange={(e) => set({ appearance: { ...S.appearance, theme: e.target.value as never } })}><option value="dark">Dark</option><option value="light">Light</option><option value="sepia">Sepia</option><option value="system">Match system</option></select></div>
            <div className="field"><label>Layout</label><select value={S.appearance.layout} onChange={(e) => set({ appearance: { ...S.appearance, layout: e.target.value as never } })}><option value="page">Pages (like Kindle)</option><option value="scroll">Scroll</option></select></div>
            <div className="field"><label>Font</label><select value={S.appearance.fontFamily} onChange={(e) => set({ appearance: { ...S.appearance, fontFamily: e.target.value as never } })}><option value="serif">Serif (book)</option><option value="sans">Sans-serif</option><option value="dyslexic">Easy to read</option></select></div>
          </div>
          <div className="row">
            <div className="field"><label>Text size: {S.appearance.fontSizePx}px</label><input type="range" min={14} max={34} value={S.appearance.fontSizePx} onChange={(e) => set({ appearance: { ...S.appearance, fontSizePx: Number(e.target.value) } })} /></div>
            <div className="field"><label>Line height: {S.appearance.lineHeight.toFixed(2)}</label><input type="range" min={1.2} max={2.2} step={0.05} value={S.appearance.lineHeight} onChange={(e) => set({ appearance: { ...S.appearance, lineHeight: Number(e.target.value) } })} /></div>
            <div className="field"><label>Margins: {S.appearance.marginPx}px</label><input type="range" min={16} max={160} step={4} value={S.appearance.marginPx} onChange={(e) => set({ appearance: { ...S.appearance, marginPx: Number(e.target.value) } })} /></div>
          </div>
          <div className="row">
            <div className="field"><label>Subtitle band</label><select value={S.appearance.bandEnabled ? '1' : '0'} onChange={(e) => set({ appearance: { ...S.appearance, bandEnabled: e.target.value === '1' } })}><option value="1">Shown</option><option value="0">Hidden</option></select></div>
            <div className="field"><label>Band height: {S.appearance.bandHeightPct}%</label><input type="range" min={15} max={60} value={S.appearance.bandHeightPct} onChange={(e) => set({ appearance: { ...S.appearance, bandHeightPct: Number(e.target.value) } })} /></div>
            <div className="field"><label>Highlight style</label><select value={S.appearance.underlineOnly ? '1' : '0'} onChange={(e) => set({ appearance: { ...S.appearance, underlineOnly: e.target.value === '1' } })}><option value="0">Colour fill</option><option value="1">Underline only</option></select></div>
          </div>
          {(['highlightsDark', 'highlightsLight'] as const).map((k) => (
            <div className="field" key={k}>
              <label>{k === 'highlightsDark' ? 'Colours in the dark theme' : 'Colours in light and sepia themes'}</label>
              <div className="row">
                {(['unknown', 'learning', 'marked', 'sentence', 'word'] as const).map((c) => (
                  <label key={c} className="row" style={{ gap: 4 }}>
                    <input type="color" value={S.appearance[k][c]} onChange={(e) => set({ appearance: { ...S.appearance, [k]: { ...S.appearance[k], [c]: e.target.value } } })} />
                    {{ unknown: 'hard word', learning: 'learning', marked: 'marked', sentence: 'sentence being read', word: 'word being read' }[c]}
                  </label>
                ))}
                <button onClick={() => set({ appearance: { ...S.appearance, [k]: DEFAULT_SETTINGS.appearance[k] } })}>Reset</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {section === 'shortcuts' && (
        <section>
          <h2>Keyboard shortcuts</h2>
          <div className="kv">
            {Object.entries(S.shortcuts).map(([k, v]) => <React.Fragment key={k}><span>{SHORTCUT_NAMES[k] ?? k}</span><span>{shortcutLabel(v)}</span></React.Fragment>)}
          </div>
          <div className="hint">Shortcuts work while reading, when no text box has the focus. Cmd+O opens a book, Cmd+Shift+V pastes text, Cmd+= / Cmd+− change the text size, Cmd+T cycles the theme.</div>
        </section>
      )}

      {section === 'data' && <DataSection usage={usage} />}
    </div>
  );
}

/** Green = saved and readable, orange = saved but unreadable, grey = none. */
export function KeyStatusDot({ status }: { status: SecretStatus }): JSX.Element {
  const color = status.verified ? 'var(--ok)' : status.saved ? 'var(--accent)' : status.lostAtStartup ? 'var(--danger)' : 'var(--fg-muted)';
  const title = status.verified ? 'Key saved and verified' : status.saved ? 'Key saved but cannot be read; paste it again' : status.lostAtStartup ? 'Key could not be recovered' : 'No key saved';
  return <span title={title} aria-label={title} style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, verticalAlign: 'middle', marginRight: 2 }} />;
}

function KeyBadge({ status }: { status: SecretStatus }): JSX.Element {
  if (status.verified) return <span className="badge free">saved</span>;
  if (status.saved) return <span className="badge paid">unreadable</span>;
  return <span className="badge">none</span>;
}

/** Shown once per session for a key that was stored with the old Keychain scheme and could not be read after a re-sign. */
export function LostKeyNotice({ name, status, onDismiss }: { name: SecretName; status: SecretStatus; onDismiss: () => void }): JSX.Element | null {
  if (!status.lostAtStartup || status.saved) return null;
  return (
    <div className="hint" style={{ color: 'var(--danger)' }} data-testid={`lost-key-${name}`}>
      Your {SECRET_LABELS[name]} key could not be recovered after the app was updated or re-signed. Please paste it again. <a href="#" onClick={(e) => { e.preventDefault(); onDismiss(); }}>Dismiss</a>
    </div>
  );
}

const SHORTCUT_NAMES: Record<string, string> = {
  playPause: 'Play / pause', prevSentence: 'Previous sentence', nextSentence: 'Next sentence', prevParagraph: 'Previous paragraph', nextParagraph: 'Next paragraph',
  prevPage: 'Previous page', nextPage: 'Next page', replaySentence: 'Replay sentence', explain: 'Explain word / selection / sentence', explainLast: 'Explain the last part',
  markKnown: 'Mark word known', markLearning: 'Mark word learning', ignore: 'Ignore word', toggleListen: 'Listening mode on/off', toggleBand: 'Subtitle band on/off',
  sayWord: 'Say the word', speedUp: 'Faster', speedDown: 'Slower', speedReset: 'Normal speed', nextHard: 'Next hard word', prevHard: 'Previous hard word', closePopup: 'Close popup / skip explanation', markPhrase: 'Mark selection or sentence for listening',
};

function VoicePicker({ label, engine, voiceId, voices, onChange, onPreview }: { label: string; engine: TtsEngineId; voiceId: string; voices: TtsVoice[]; onChange: (id: string) => void; onPreview: () => void }): JSX.Element {
  const list = voices.filter((v) => v.engine === engine);
  const english = list.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const others = list.filter((v) => !v.lang.toLowerCase().startsWith('en'));
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row">
        <select value={voiceId} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 280 }} data-testid={`voice-${engine}`}>
          <option value="">Automatic (best British voice available)</option>
          {english.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.lang}{v.quality ? ` · ${v.quality}` : ''}{v.note ? ` · ${v.note}` : ''}</option>)}
          {others.length > 0 && <optgroup label="Other languages">{others.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.lang}</option>)}</optgroup>}
        </select>
        <button onClick={onPreview}>▶ Preview</button>
      </div>
      {list.length === 0 && engine !== 'webspeech' && <div className="hint">No voices listed yet: check the key or the internet connection. The automatic voice will be used.</div>}
    </div>
  );
}

function DataSection({ usage }: { usage: { today: number; month: number } }): JSX.Element {
  const [diag, setDiag] = useState<string>('');
  useEffect(() => { void window.readalong.getDiagnostics().then((d) => setDiag(JSON.stringify(d, null, 1))); }, []);
  const vocab = useApp((s) => s.vocab);
  const known = Object.values(vocab.words).filter((v) => v === 'known').length;
  const learning = Object.values(vocab.words).filter((v) => v === 'learning').length;
  const exportCsv = () => {
    const rows = [['word', 'status'], ...Object.entries(vocab.words)];
    const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'readalong-vocabulary.csv'; a.click();
  };
  return (
    <section>
      <h2>Usage & data</h2>
      <div className="field"><label>AI spending</label><div>today ${usage.today.toFixed(3)} · this month ${usage.month.toFixed(2)}</div></div>
      <div className="field"><label>Vocabulary</label><div>{known} known · {learning} learning</div><div className="row"><button onClick={exportCsv}>Export CSV</button><button onClick={() => useApp.getState().setView('diagnostics')}>Diagnostics</button></div></div>
      <div className="field"><label>Where your data lives</label><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{diag}</pre></div>
    </section>
  );
}
