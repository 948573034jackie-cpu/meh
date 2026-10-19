import React, { useEffect, useState } from 'react';
import { SECRET_NAMES, SECRET_LABELS, type Diagnostics, type SecretName, type SecretStatusMap } from '@shared/api';
import { KeyStatusDot, LostKeyNotice, STORAGE_NOTE, NO_KEYS } from './Settings';

/** Shows environment facts the user can paste back when something does not work on their Mac. */
export function DiagnosticsView(): JSX.Element {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [probe, setProbe] = useState<string>('not run');
  const [keys, setKeys] = useState<SecretStatusMap>(NO_KEYS);
  const [testResult, setTestResult] = useState<Partial<Record<SecretName, string>>>({});
  const refreshKeys = () => window.readalong.secretStatus().then(setKeys).catch(() => { /* main not ready */ });
  const testKey = async (name: SecretName) => {
    setTestResult((t) => ({ ...t, [name]: 'Testing…' }));
    try { const r = await window.readalong.aiTest(name); setTestResult((t) => ({ ...t, [name]: `${r.ok ? '✅' : '❌'} ${r.message}${r.detail ? ` [${r.detail}]` : ''}` })); }
    catch (e) { setTestResult((t) => ({ ...t, [name]: `❌ ${(e as Error).message}` })); }
  };
  useEffect(() => {
    void window.readalong.getDiagnostics().then(setD);
    void refreshKeys();
    const load = () => setVoices(speechSynthesis.getVoices().map((v) => `${v.name} [${v.lang}]${v.default ? ' (default)' : ''}${v.localService ? '' : ' remote'}`));
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const runProbe = () => {
    const u = new SpeechSynthesisUtterance('Testing word boundary events for ReadAlong.');
    const gb = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').toLowerCase() === 'en-gb');
    if (gb) u.voice = gb;
    let words = 0; const t0 = performance.now();
    u.onboundary = (e) => { if (e.name === 'word') words++; };
    u.onend = () => setProbe(`voice=${u.voice?.name ?? 'default'} wordEvents=${words} durationMs=${Math.round(performance.now() - t0)}`);
    u.onerror = (e) => setProbe(`error: ${e.error}`);
    setProbe('speaking…');
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  };
  const keyLines = SECRET_NAMES.map((n) => `key ${n}: ${keys[n].verified ? 'saved, verified' : keys[n].saved ? 'saved, UNREADABLE' : keys[n].lostAtStartup ? 'lost at startup' : 'none'}${testResult[n] ? ` · test: ${testResult[n]}` : ''}`);
  const text = [d ? Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n') : '', ...keyLines, `voices (${voices.length}):`, ...voices, `probe: ${probe}`].join('\n');
  return (
    <div className="library">
      <h1>Diagnostics</h1>
      <div className="row"><button onClick={runProbe}>Test speech voice</button><button onClick={() => navigator.clipboard.writeText(text)}>Copy all</button></div>
      <div className="field" style={{ marginTop: 16 }}>
        <label>API keys</label>
        {SECRET_NAMES.map((name) => (
          <React.Fragment key={name}>
            <LostKeyNotice name={name} status={keys[name]} onDismiss={() => { void window.readalong.dismissLostKeys().then(refreshKeys); }} />
            <div className="row" data-testid={`diag-key-${name}`}>
              <span style={{ width: 150 }}><KeyStatusDot status={keys[name]} /> {SECRET_LABELS[name]}</span>
              <span className="muted" style={{ width: 130 }}>{keys[name].verified ? 'saved, verified' : keys[name].saved ? 'saved, unreadable' : 'no key'}</span>
              <button onClick={() => testKey(name)} disabled={!keys[name].saved}>Test</button>
              {testResult[name] && <span className="hint">{testResult[name]}</span>}
            </div>
          </React.Fragment>
        ))}
        <div className="hint">{STORAGE_NOTE}{d ? ` File: ${d.secretsFile}` : ''}</div>
      </div>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 16 }} data-testid="diagnostics-text">{text}</pre>
    </div>
  );
}
