import React, { useEffect, useRef } from 'react';
import type { TranscriptEntry } from '@core/listen/controller';

export function Transcript({ entries, onSkip, onClose, onAsk }: { entries: TranscriptEntry[]; onSkip: () => void; onClose: () => void; onAsk: (q: string) => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = React.useState('');
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [entries]);
  const active = entries.some((e) => e.status === 'thinking' || e.status === 'speaking');
  return (
    <aside className="transcript" data-testid="transcript">
      <header>
        <span>Explanations</span>
        <span className="grow" />
        {active && <button onClick={onSkip} data-testid="skip">Skip ▶▶</button>}
        <button className="icon" onClick={onClose}>✕</button>
      </header>
      <div className="entries" ref={ref}>
        {entries.length === 0 && <div className="muted small">Tap a word and press Ask AI, press E, or turn on listening mode. Explanations appear here and are spoken aloud.</div>}
        {entries.map((e) => (
          <div className={`entry ${e.status === 'error' ? 'error' : ''}`} key={e.id} data-testid="entry">
            <div className="target">{e.kind === 'passage' ? 'Last part' : e.kind === 'question' ? 'Question' : e.target}</div>
            {e.kind !== 'passage' && e.kind !== 'question' && <div className="st">{e.sentence}</div>}
            <div className="st">{e.status === 'thinking' ? 'thinking…' : e.status === 'speaking' ? 'speaking' : e.status === 'skipped' ? 'skipped' : e.status === 'error' ? e.error : e.usd !== undefined ? `done · $${e.usd.toFixed(4)}` : 'done'}</div>
            {e.parts ? (
              <div className="body">
                {e.parts.definition && <div>{e.parts.definition}</div>}
                {e.parts.inSentence && <div><b>Here:</b> {e.parts.inSentence}</div>}
                {e.parts.example && <div><i>{e.parts.example}</i></div>}
                {e.parts.meaning && <div>{e.parts.meaning}</div>}
                {e.parts.summary && <div>{e.parts.summary}</div>}
                {e.parts.chinese && <div className="zh">{e.parts.chinese}</div>}
                {e.parts.hardWords?.map((h, i) => <div key={i}><b>{h.word}</b> — {h.meaning} <span className="zh">{h.zh}</span></div>)}
                {e.parts.free && <div>{e.parts.free}</div>}
              </div>
            ) : e.text ? <div className="body">{e.text}</div> : null}
          </div>
        ))}
      </div>
      <form className="row" style={{ padding: 10, borderTop: '1px solid var(--border)' }} onSubmit={(ev) => { ev.preventDefault(); if (q.trim()) { onAsk(q.trim()); setQ(''); } }}>
        <input type="text" style={{ flex: 1 }} placeholder="Ask about this sentence…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Ask</button>
      </form>
    </aside>
  );
}
