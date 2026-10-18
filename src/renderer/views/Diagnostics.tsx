import React, { useEffect, useState } from 'react';
import type { Diagnostics } from '@shared/api';

/** Shows environment facts the user can paste back when something does not work on their Mac. */
export function DiagnosticsView(): JSX.Element {
  const [d, setD] = useState<Diagnostics | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [probe, setProbe] = useState<string>('not run');
  useEffect(() => {
    void window.readalong.getDiagnostics().then(setD);
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
  const text = [d ? Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('\n') : '', `voices (${voices.length}):`, ...voices, `probe: ${probe}`].join('\n');
  return (
    <div className="library">
      <h1>Diagnostics</h1>
      <div className="row"><button onClick={runProbe}>Test speech voice</button><button onClick={() => navigator.clipboard.writeText(text)}>Copy all</button></div>
      <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 16 }} data-testid="diagnostics-text">{text}</pre>
    </div>
  );
}
