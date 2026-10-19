import React, { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import type { Settings, TtsEngineId, AiProviderId, ThemeId } from '@shared/settings';
import { DEFAULT_SETTINGS, DEFAULT_INSTRUCTIONS } from '@shared/settings';
import { CEFR_LEVELS } from '@core/model';
import { ENGINE_LABELS, AVAILABLE_ENGINES, type TtsVoice } from '@core/tts/engine';
import { getEngine, defaultVoiceFor } from '@core/tts/registry';
import { shortcutLabel } from '../reader/shortcuts';
import { SECRET_LABELS, type SecretName, type SecretStatus, type SecretStatusMap } from '@shared/api';
import { Tip } from '../ui/Tip';

export const STORAGE_NOTE = 'Keys are stored encrypted in the app\'s own data folder; they survive updates and re-signing.';
const EMPTY_STATUS: SecretStatus = { saved: false, verified: false, lostAtStartup: false };
export const NO_KEYS: SecretStatusMap = { anthropic: EMPTY_STATUS, openai: EMPTY_STATUS, elevenlabs: EMPTY_STATUS, azure: EMPTY_STATUS, google: EMPTY_STATUS };
const KEY_PLACEHOLDER: Record<SecretName, string> = { anthropic: 'sk-ant-…', openai: 'sk-…', elevenlabs: 'sk_… or 32 hex characters', azure: 'Speech resource key', google: 'AIza…' };

type Section = 'start' | 'look' | 'voice' | 'ai' | 'level' | 'shortcuts' | 'data';

const AI_MODELS: { provider: AiProviderId; id: string; name: string; cost: string; note: string }[] = [
  { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', cost: 'about 1–2 cents a day', note: 'Fast and cheap. Fine for word meanings.' },
  { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', cost: 'about 30 cents a day', note: 'Smarter, more natural explanations.' },
  { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', cost: 'about 65 cents a day', note: 'Best quality.' },
  { provider: 'openai', id: 'gpt-5.4-mini', name: 'ChatGPT: GPT-5.4 mini', cost: 'about 10 cents a day', note: 'Fast and cheap.' },
  { provider: 'openai', id: 'gpt-5.6-terra', name: 'ChatGPT: GPT-5.6', cost: 'about 30 cents a day', note: 'Higher quality.' },
];

/** Theme cards: the colours mirror the tokens in main.css so the preview is honest. */
const THEMES: { id: ThemeId; name: string; bg: string; fg: string; accent: string; muted: string }[] = [
  { id: 'night', name: 'Night', bg: '#15171c', fg: '#d7d2c8', accent: '#d9a066', muted: '#8e8a82' },
  { id: 'sepia', name: 'Sepia', bg: '#f4ecd8', fg: '#3b3328', accent: '#b5651d', muted: '#7a6e5c' },
  { id: 'light', name: 'Light', bg: '#faf9f6', fg: '#2a2a2e', accent: '#b5651d', muted: '#6f6e6a' },
  { id: 'grey', name: 'Grey', bg: '#2b2d31', fg: '#e0e0e0', accent: '#d9a066', muted: '#9a9ea6' },
  { id: 'system', name: 'Match system', bg: 'linear-gradient(135deg, #15171c 50%, #faf9f6 50%)', fg: '#9a968e', accent: '#c58a4a', muted: '#9a968e' },
];

const NAV_ICONS: Record<Section, JSX.Element> = {
  start: <path d="M3 11.5 12 4l9 7.5M5 10v10h14V10" />,
  look: <path d="M12 5C7 5 3.5 8.5 2 12c1.5 3.5 5 7 10 7s8.5-3.5 10-7c-1.5-3.5-5-7-10-7Zm0 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
  voice: <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />,
  ai: <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3ZM5 16l.9 2.1L8 19l-2.1.9L5 22l-.9-2.1L2 19l2.1-.9L5 16Z" />,
  level: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  shortcuts: <path d="M3 7h18v10H3zM7 11h1M11 11h1M15 11h1M8 14h8" />,
  data: <path d="M12 3c-4.4 0-8 1.3-8 3v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0-1.7-3.6-3-8-3ZM4 12c0 1.7 3.6 3 8 3s8-1.3 8-3M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
};
function NavIcon({ id }: { id: Section }): JSX.Element {
  return <svg className="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{NAV_ICONS[id]}</svg>;
}

export function SettingsView(): JSX.Element {
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSettings);
  const [section, setSection] = useState<Section>(settings.onboarded ? 'look' : 'start');
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
  const setA = (p: Partial<Settings['appearance']>) => set({ appearance: { ...S.appearance, ...p } });

  const nav: { id: Section; label: string }[] = [
    { id: 'start', label: 'Start' }, { id: 'look', label: 'Reading look' }, { id: 'voice', label: 'Voice' }, { id: 'ai', label: 'AI' },
    { id: 'level', label: 'Level & stops' }, { id: 'shortcuts', label: 'Shortcuts' }, { id: 'data', label: 'Data' },
  ];

  return (
    <div className="settings" data-testid="settings">
      <nav aria-label="Settings sections">
        <div className="nav-title">Settings</div>
        {nav.map((n) => <button key={n.id} className={section === n.id ? 'active' : ''} onClick={() => setSection(n.id)} data-testid={`nav-${n.id}`}><NavIcon id={n.id} />{n.label}</button>)}
        <span style={{ flex: 1 }} />
        {!S.onboarded && <button className="primary" data-testid="finish-onboarding" onClick={() => { set({ onboarded: true }); useApp.getState().setView('library'); }}>Done, open my library</button>}
      </nav>

      {section === 'start' && (
        <section>
          <h2>{S.onboarded ? 'Dream Read' : 'Welcome to Dream Read'}</h2>
          <p className="section-lead">Dream Read reads English books aloud with a British voice, shows the meaning of any word you tap, and explains hard words and sentences with Claude or ChatGPT, spoken aloud, like a tutor sitting next to you.</p>
          <div className="card">
            <div><b>Three things to set up</b>, each takes a minute:</div>
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <li><b>AI</b>: choose Claude or ChatGPT and paste an API key. Without a key, tapping words still shows the dictionary meaning; only the spoken explanations need the key.</li>
              <li><b>Voice</b>: the Mac voices work right away. For a much better British voice, download “Daniel (Enhanced)” or “Serena (Premium)” once in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices, then pick it here.</li>
              <li><b>Your level</b>: words above your level are highlighted and explained automatically in listening mode.</li>
            </ol>
            <div className="row"><button className="primary" onClick={() => setSection('ai')}>Start with AI →</button><button onClick={() => setSection('look')}>Choose how it looks</button></div>
          </div>
          <div className="hint muted">Tip: Cmd+, opens Settings at any time. Space plays or pauses. Q turns listening mode on and off.</div>
        </section>
      )}

      {section === 'look' && (
        <section data-testid="section-look">
          <h2>Reading look</h2>
          <p className="section-lead">Calm colours and sizes you can live in for hours. Every change applies at once.</p>

          <h3>Theme</h3>
          <div className="theme-grid" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <div key={t.id} className={`theme-card ${S.appearance.theme === t.id ? 'active' : ''}`} role="radio" aria-checked={S.appearance.theme === t.id} tabIndex={0} onClick={() => setA({ theme: t.id })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setA({ theme: t.id }); } }} data-testid={`theme-${t.id}`}>
                <div className="preview" style={{ background: t.bg, color: t.fg }}>
                  <span className="aa">Aa</span>
                  <span className="line" style={{ background: t.fg }} />
                  <span className="line short" style={{ background: t.accent, opacity: 0.9 }} />
                </div>
                <div className="name">{t.name}</div>
              </div>
            ))}
          </div>

          <h3>Text sizes</h3>
          <div className="card">
            <div className="size-row">
              <div className="field">
                <label>Book text <span className="value">{S.appearance.fontSizePx}px</span></label>
                <input type="range" min={14} max={34} value={S.appearance.fontSizePx} onChange={(e) => setA({ fontSizePx: Number(e.target.value) })} data-testid="size-book" />
                <div className="hint">What you read on the page. Cmd+= and Cmd+− change it while reading.</div>
              </div>
              <div className="sample book" style={{ fontSize: S.appearance.fontSizePx, lineHeight: S.appearance.lineHeight, fontFamily: `var(--font-${S.appearance.fontFamily})` }}>The letter arrived the next morning. Elizabeth read it twice before folding it away.</div>
            </div>
            <div className="size-row">
              <div className="field">
                <label>Listening subtitles <span className="value">{S.appearance.subtitleSizePx}px</span></label>
                <input type="range" min={14} max={40} value={S.appearance.subtitleSizePx} onChange={(e) => setA({ subtitleSizePx: Number(e.target.value) })} data-testid="size-subtitle" />
                <div className="hint">The sentence being read, shown in the band at the bottom while you listen.</div>
              </div>
              <div className="sample subtitle" style={{ fontSize: S.appearance.subtitleSizePx, fontFamily: `var(--font-${S.appearance.fontFamily})` }}>Mr. Darcy remained <u>sanguine</u> about the weather.</div>
            </div>
            <div className="size-row">
              <div className="field">
                <label>Explanations <span className="value">{S.appearance.explainSizePx}px</span></label>
                <input type="range" min={12} max={24} value={S.appearance.explainSizePx} onChange={(e) => setA({ explainSizePx: Number(e.target.value) })} data-testid="size-explain" />
                <div className="hint">The explanation panel and transcript.</div>
              </div>
              <div className="sample explain" style={{ fontSize: S.appearance.explainSizePx }}><b>sanguine</b> — hopeful and confident about the future, even when things look bad. <span className="zh">乐观的</span></div>
            </div>
            <div className="size-row">
              <div className="field">
                <label>Buttons and menus <span className="value">{Math.round(S.appearance.uiScale * 100)}%</span></label>
                <input type="range" min={0.9} max={1.3} step={0.05} value={S.appearance.uiScale} onChange={(e) => setA({ uiScale: Number(e.target.value) })} data-testid="size-ui" />
                <div className="hint">The size of everything that is not book text.</div>
              </div>
              <div className="sample ui" style={{ zoom: S.appearance.uiScale }}><button className="primary">Continue</button><button>Settings</button><span className="muted">Library · 3 books</span></div>
            </div>
          </div>

          <h3>Lines</h3>
          <div className="card">
            <div className="size-row">
              <div className="field">
                <label>Line spacing <span className="value">{S.appearance.lineHeight.toFixed(2)}</span></label>
                <input type="range" min={1.2} max={2.2} step={0.05} value={S.appearance.lineHeight} onChange={(e) => setA({ lineHeight: Number(e.target.value) })} data-testid="line-height" />
              </div>
              <div className="sample book" style={{ fontSize: S.appearance.fontSizePx, lineHeight: S.appearance.lineHeight, fontFamily: `var(--font-${S.appearance.fontFamily})` }}>The committee's deliberations were protracted and acrimonious, but a consensus emerged. The children went home before the rain started.</div>
            </div>
            <div className="size-row">
              <div className="field">
                <label>Line length <span className="value">{S.appearance.maxLineChars} characters</span></label>
                <input type="range" min={45} max={110} value={S.appearance.maxLineChars} onChange={(e) => setA({ maxLineChars: Number(e.target.value) })} data-testid="line-length" />
                <div className="hint">Shorter lines are easier on the eyes; 60–75 is typical for a book.</div>
              </div>
              <div className="sample book" style={{ fontSize: Math.min(S.appearance.fontSizePx, 16), lineHeight: S.appearance.lineHeight, fontFamily: `var(--font-${S.appearance.fontFamily})`, maxWidth: `${S.appearance.maxLineChars}ch` }}>It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families.</div>
            </div>
            <div className="size-row">
              <div className="field">
                <label>Listening screen width <span className="value">{S.appearance.listenMaxLineChars} characters</span></label>
                <input type="range" min={60} max={140} value={S.appearance.listenMaxLineChars} onChange={(e) => setA({ listenMaxLineChars: Number(e.target.value) })} data-testid="line-length-listen" />
                <div className="hint">The subtitle band uses the full width with comfortable side margins.</div>
              </div>
              <div className="sample subtitle" style={{ fontSize: Math.min(S.appearance.subtitleSizePx, 18), fontFamily: `var(--font-${S.appearance.fontFamily})`, maxWidth: `${S.appearance.listenMaxLineChars}ch` }}>The letter arrived the next morning. It contained a single, perplexing sentence, and Elizabeth read it twice before folding it away.</div>
            </div>
            <div className="field">
              <label>Page margins <span className="value">{S.appearance.marginPx}px</span></label>
              <input type="range" min={16} max={160} step={4} value={S.appearance.marginPx} onChange={(e) => setA({ marginPx: Number(e.target.value) })} />
            </div>
          </div>

          <h3>Page</h3>
          <div className="card">
            <div className="row" style={{ gap: 18 }}>
              <div className="field"><label>Font</label><select value={S.appearance.fontFamily} onChange={(e) => setA({ fontFamily: e.target.value as never })}><option value="serif">Serif (book)</option><option value="sans">Sans-serif</option><option value="dyslexic">Easy to read</option></select></div>
              <div className="field"><label>Layout</label><select value={S.appearance.layout} onChange={(e) => setA({ layout: e.target.value as never })} data-testid="layout"><option value="page">Pages (like Kindle)</option><option value="scroll">Scroll</option></select></div>
              <div className="field"><label>Subtitle band</label><select value={S.appearance.bandEnabled ? '1' : '0'} onChange={(e) => setA({ bandEnabled: e.target.value === '1' })}><option value="1">Shown</option><option value="0">Hidden</option></select></div>
              <div className="field"><label>Band height <span className="value">{S.appearance.bandHeightPct}%</span></label><input type="range" min={15} max={60} value={S.appearance.bandHeightPct} onChange={(e) => setA({ bandHeightPct: Number(e.target.value) })} style={{ width: 140 }} /></div>
            </div>
            <div className="row" style={{ gap: 18 }}>
              <div className="field"><label>Highlight style</label><select value={S.appearance.underlineOnly ? '1' : '0'} onChange={(e) => setA({ underlineOnly: e.target.value === '1' })}><option value="0">Colour fill</option><option value="1">Underline only</option></select></div>
              <div className="field"><label>Tips</label><select value={S.appearance.showTips ? '1' : '0'} onChange={(e) => setA({ showTips: e.target.value === '1' })} data-testid="show-tips"><option value="1">Show: hover a button to see how it works</option><option value="0">Hide</option></select></div>
            </div>
          </div>

          <h3>Highlight colours</h3>
          <div className="card">
            {(['highlightsDark', 'highlightsLight'] as const).map((k) => (
              <div className="field" key={k}>
                <label>{k === 'highlightsDark' ? 'In the Night and Grey themes' : 'In the Sepia and Light themes'}</label>
                <div className="swatches">
                  {(['unknown', 'learning', 'marked', 'sentence', 'word'] as const).map((c) => (
                    <label key={c} className="swatch">
                      <input type="color" value={S.appearance[k][c]} onChange={(e) => setA({ [k]: { ...S.appearance[k], [c]: e.target.value } } as never)} />
                      {{ unknown: 'hard word', learning: 'learning', marked: 'marked', sentence: 'sentence being read', word: 'word being read' }[c]}
                    </label>
                  ))}
                  <button className="quiet" onClick={() => setA({ [k]: DEFAULT_SETTINGS.appearance[k] } as never)}>Reset</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {section === 'voice' && (
        <section>
          <h2>Voice</h2>
          <p className="section-lead">Who reads to you, and how fast.</p>
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
          {S.voice.engine === 'webspeech' && <div className="hint muted small">Better free British voices: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices… → English (UK) → download Daniel (Enhanced), Serena (Premium) or Jamie (Premium). Restart Dream Read afterwards and pick the new voice here.</div>}
          <div className="field">
            <label>Explanation voice</label>
            <select value={S.voice.explainEngine ?? ''} onChange={(e) => set({ voice: { ...S.voice, explainEngine: (e.target.value || null) as TtsEngineId | null, explainVoiceId: null } })}>
              <option value="">Same as the reading voice</option>
              {AVAILABLE_ENGINES.map((id) => <option key={id} value={id}>{ENGINE_LABELS[id].label} · {ENGINE_LABELS[id].cost}</option>)}
            </select>
          </div>
          {S.voice.explainEngine && <VoicePicker label="Explanation voice" engine={S.voice.explainEngine} voiceId={S.voice.explainVoiceId ?? ''} voices={voices} onChange={(explainVoiceId) => set({ voice: { ...S.voice, explainVoiceId } })} onPreview={() => previewVoice(S.voice.explainEngine!, S.voice.explainVoiceId ?? '')} />}
          <div className="card">
            <div className="size-row">
              <div className="field"><label>Speed <span className="value">{S.voice.rate.toFixed(1)}×</span></label><input type="range" min={0.5} max={2.5} step={0.1} value={S.voice.rate} onChange={(e) => set({ voice: { ...S.voice, rate: Number(e.target.value) } })} /></div>
              <div className="field"><label>Pause between sentences <span className="value">{S.voice.pauseBetweenSentencesMs} ms</span></label><input type="range" min={0} max={3000} step={50} value={S.voice.pauseBetweenSentencesMs} onChange={(e) => set({ voice: { ...S.voice, pauseBetweenSentencesMs: Number(e.target.value) } })} /></div>
            </div>
          </div>
          <h3>Keys for paid voices</h3>
          <div className="card">
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

      {section === 'ai' && (
        <section>
          <h2>AI</h2>
          <p className="section-lead">Who explains the hard words, and how much it may cost.</p>
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
          <div className="card">
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
          </div>
          <div className="field">
            <label>Your instructions to the AI</label>
            <textarea value={S.ai.instructions} onChange={(e) => set({ ai: { ...S.ai, instructions: e.target.value } })} />
            <div className="hint">Paste the same instructions you use in ChatGPT or Claude. <a href="#" onClick={(e) => { e.preventDefault(); set({ ai: { ...S.ai, instructions: DEFAULT_INSTRUCTIONS } }); }}>Reset to default</a></div>
          </div>
          <div className="row" style={{ gap: 18 }}>
            <div className="field"><label>Explanation length</label>
              <select value={S.ai.explanationLength} onChange={(e) => set({ ai: { ...S.ai, explanationLength: e.target.value as never } })}><option value="short">Short</option><option value="normal">Normal</option><option value="long">Long</option></select></div>
            <div className="field"><label>Speak the Chinese meaning</label>
              <select value={S.ai.speakChinese ? '1' : '0'} onChange={(e) => set({ ai: { ...S.ai, speakChinese: e.target.value === '1' } })}><option value="1">Yes, with the Mac Chinese voice</option><option value="0">No, show it only</option></select></div>
          </div>
          <h3>Budget</h3>
          <div className="card">
            <div className="row" style={{ gap: 18 }}>
              <div className="field"><label>Warn me when a day costs more than</label><div className="row">$<input type="number" min={0} step={0.5} style={{ width: 90 }} value={S.ai.dailyWarnUsd} onChange={(e) => set({ ai: { ...S.ai, dailyWarnUsd: Number(e.target.value) } })} /></div></div>
              <div className="field"><label>Stop AI for the month after</label><div className="row">$<input type="number" min={0} step={1} style={{ width: 90 }} value={S.ai.monthlyStopUsd} onChange={(e) => set({ ai: { ...S.ai, monthlyStopUsd: Number(e.target.value) } })} /></div></div>
              <div className="field"><label>Spent</label><div className="hint">today ${usage.today.toFixed(2)} · this month ${usage.month.toFixed(2)}</div></div>
            </div>
          </div>
        </section>
      )}

      {section === 'level' && (
        <section>
          <h2>Level & stops</h2>
          <p className="section-lead">Which words count as hard, and how often listening mode pauses to explain one.</p>
          <div className="field">
            <label>My English level</label>
            <div className="row">{CEFR_LEVELS.map((l) => <button key={l} className={S.learnerLevel === l ? 'primary' : ''} onClick={() => set({ learnerLevel: l })} data-testid={`level-${l}`}>{l}</button>)}</div>
            <div className="hint">Words above this level are highlighted. In listening mode the reading stops at them and the AI explains them. Double-click a highlighted word to mark it known.</div>
          </div>
          <div className="card">
            <div className="field"><label>In listening mode, stop and explain</label>
              <div className="row" style={{ gap: 16 }}>
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={S.listen.autoExplainWords} onChange={(e) => set({ listen: { ...S.listen, autoExplainWords: e.target.checked } })} /> highlighted words</label>
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={S.listen.autoExplainPhrases} onChange={(e) => set({ listen: { ...S.listen, autoExplainPhrases: e.target.checked } })} /> highlighted phrases</label>
                <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={S.listen.firstOccurrencePerChapterOnly} onChange={(e) => set({ listen: { ...S.listen, firstOccurrencePerChapterOnly: e.target.checked } })} /> only the first time a word appears in a chapter</label>
              </div>
            </div>
            <div className="row" style={{ gap: 18 }}>
              <div className="field"><label>Say the word (times, before and after)</label><input type="number" min={0} max={5} style={{ width: 80 }} value={S.listen.wordRepeats} onChange={(e) => set({ listen: { ...S.listen, wordRepeats: Number(e.target.value) } })} /></div>
              <div className="field"><label>Repeat the sentence after a word (times)</label><input type="number" min={0} max={4} style={{ width: 80 }} value={S.listen.sentenceRepeatsAfterWord} onChange={(e) => set({ listen: { ...S.listen, sentenceRepeatsAfterWord: Number(e.target.value) } })} /></div>
              <div className="field"><label>Repeat a sentence being explained (total)</label><input type="number" min={1} max={4} style={{ width: 80 }} value={S.listen.sentenceRepeatsForPhrase} onChange={(e) => set({ listen: { ...S.listen, sentenceRepeatsForPhrase: Number(e.target.value) } })} /></div>
            </div>
            <div className="row" style={{ gap: 18 }}>
              <div className="field"><label>Maximum stops per 10 minutes (0 = no limit)</label><input type="number" min={0} max={30} style={{ width: 80 }} value={S.listen.maxStopsPer10Min} onChange={(e) => set({ listen: { ...S.listen, maxStopsPer10Min: Number(e.target.value) } })} /></div>
              <div className="field"><label>“Explain last” window</label><select value={S.listen.lastSecondsWindow} onChange={(e) => set({ listen: { ...S.listen, lastSecondsWindow: Number(e.target.value) as never } })}>{[20, 30, 40, 60].map((s) => <option key={s} value={s}>{s} seconds</option>)}</select></div>
              <div className="field"><label>While listening, one tap on a highlighted word</label><select value={S.listen.tapHighlightCancels ? '1' : '0'} onChange={(e) => set({ listen: { ...S.listen, tapHighlightCancels: e.target.value === '1' } })}><option value="1">marks it known and keeps reading</option><option value="0">opens the word popup</option></select></div>
            </div>
          </div>
        </section>
      )}

      {section === 'shortcuts' && (
        <section>
          <h2>Keyboard shortcuts</h2>
          <p className="section-lead">They work while reading, when no text box has the focus.</p>
          <div className="card">
            <div className="kv">
              {Object.entries(S.shortcuts).map(([k, v]) => <React.Fragment key={k}><span>{SHORTCUT_NAMES[k] ?? k}</span><span className="key">{shortcutLabel(v)}</span></React.Fragment>)}
            </div>
          </div>
          <div className="hint muted">Cmd+O opens a book, Cmd+Shift+V pastes text, Cmd+= / Cmd+− change the text size, Cmd+T cycles the theme.</div>
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
        <Tip text="Hear a sample sentence in this voice"><button onClick={onPreview}>▶ Preview</button></Tip>
      </div>
      {list.length === 0 && engine !== 'webspeech' && <div className="hint">No voices listed yet: check the key or the internet connection. The automatic voice will be used.</div>}
    </div>
  );
}

function DataSection({ usage }: { usage: { today: number; month: number } }): JSX.Element {
  const [diag, setDiag] = useState<string>('');
  const [exported, setExported] = useState<string>('');
  useEffect(() => { void window.readalong.getDiagnostics().then((d) => setDiag(JSON.stringify(d, null, 1))); }, []);
  const vocab = useApp((s) => s.vocab);
  const known = Object.values(vocab.words).filter((v) => v === 'known').length;
  const learning = Object.values(vocab.words).filter((v) => v === 'learning').length;
  const exportCsv = async () => {
    const rows = [['word', 'status'], ...Object.entries(vocab.words)];
    const csv = rows.map((r) => r.join(',')).join('\n');
    try {
      const file = await window.readalong.exportText('dream-read-vocabulary.csv', csv);
      setExported(`Saved to ${file}`);
    } catch {
      // fall back to a browser download when the main process cannot write (older build)
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dream-read-vocabulary.csv'; a.click();
    }
  };
  return (
    <section>
      <h2>Data</h2>
      <p className="section-lead">What the app has learned about you, and where it keeps it. Everything stays on your Mac.</p>
      <div className="card">
        <div className="field"><label>AI spending</label><div>today ${usage.today.toFixed(3)} · this month ${usage.month.toFixed(2)}</div></div>
        <div className="field"><label>Vocabulary</label><div>{known} known · {learning} learning</div>
          <div className="row"><Tip text="Writes a CSV into Documents → Dream Read"><button onClick={exportCsv}>Export CSV</button></Tip><button onClick={() => useApp.getState().setView('diagnostics')}>Diagnostics</button></div>
          {exported && <div className="hint">{exported}</div>}
        </div>
      </div>
      <div className="field"><label>Where your data lives</label><pre className="small muted" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{diag}</pre></div>
    </section>
  );
}
