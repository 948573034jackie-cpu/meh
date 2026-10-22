import React, { useEffect, useState } from 'react';
import { SECRET_NAMES, SECRET_LABELS, type Diagnostics, type SecretName, type SecretStatusMap } from '@shared/api';
import type { UsageRecord } from '@shared/settings';
import { KeyStatusDot, LostKeyNotice, STORAGE_NOTE, NO_KEYS } from './Settings';
import { environmentLines, speedLines, segmentLines } from './diagnosticsText';

/**
 * Shows environment facts the user can paste back when something does not work on their Mac, and the speed facts
 * (the voice's real-time factor, CPU and threads, the AI's time to its first words) that tell how fast it runs there.
 */
export function DiagnosticsView(): JSX.Element {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [usage, setUsage] = useState<UsageRecord[]>([]);
  const [copied, setCopied] = useState('');
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
  /** fresh facts (the speed numbers change while the app reads) */
  const refresh = async (): Promise<{ diag: Diagnostics; records: UsageRecord[] }> => {
    const [diag, records] = await Promise.all([window.readalong.getDiagnostics(), window.readalong.getUsage().catch(() => [] as UsageRecord[])]);
    setD(diag); setUsage(records);
    return { diag, records };
  };
  useEffect(() => {
    void refresh().catch(() => { /* main not ready */ });
    void refreshKeys();
    const load = () => setVoices(speechSynthesis.getVoices().map((v) => `${v.name} [${v.lang}]${v.default ? ' (default)' : ''}${v.localService ? '' : ' remote'}`));
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const runProbe = () => {
    const u = new SpeechSynthesisUtterance('Testing word boundary events for Dream Read.');
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
  const textOf = (diag: Diagnostics | null, records: UsageRecord[]) => [
    ...environmentLines(diag), ...speedLines(diag, records), ...keyLines, `voices (${voices.length}):`, ...voices, `probe: ${probe}`,
    ...segmentLines(diag?.kokoro?.segments ?? []),
  ].join('\n');
  const text = textOf(d, usage);
  const speed = speedLines(d, usage);
  const copy = async () => {
    setCopied('Copying…');
    let fresh: { diag: Diagnostics; records: UsageRecord[] } | null = null;
    try { fresh = await refresh(); } catch { /* copy what is shown */ }
    try { await navigator.clipboard.writeText(textOf(fresh?.diag ?? d, fresh?.records ?? usage)); setCopied('Copied. Paste it in your message.'); }
    catch (e) { setCopied(`Could not copy: ${(e as Error).message}`); }
  };
  return (
    <div className="library">
      <h1>Diagnostics</h1>
      <div className="row">
        <button onClick={runProbe}>Test speech voice</button>
        <button onClick={() => { void copy(); }} data-testid="diagnostics-copy">Copy diagnostics</button>
        {copied && <span className="hint">{copied}</span>}
      </div>
      <div className="field" style={{ marginTop: 16 }}>
        <label>Speed</label>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }} data-testid="diagnostics-speed">{d ? speed.join('\n') : 'Loading…'}</pre>
      </div>
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
