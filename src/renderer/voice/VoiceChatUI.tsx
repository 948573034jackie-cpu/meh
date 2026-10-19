import React, { useEffect, useRef, useState } from 'react';
import type { VoiceSnapshot } from './VoiceChat';
import './voice.css';

export interface VoiceExchange { you: string; tutor: string; status: 'thinking' | 'speaking' | 'done' | 'error' | 'skipped' | 'idle'; error?: string }

interface Props {
  snap: VoiceSnapshot;
  /** the last thing the learner said or typed, and the tutor's answer */
  last: VoiceExchange | null;
  popover: boolean;
  onPopover: (open: boolean) => void;
  onToggle: () => void;
  onAlwaysOn: (on: boolean) => void;
  onAsk: (text: string) => void;
  onAcceptDownload: () => void;
  onDeclineDownload: () => void;
  onDismissError: () => void;
  /** key label for the tooltip (e.g. "M") */
  keyLabel: string;
  /** moves the button left of the explanations panel when it is open */
  shifted?: boolean;
}

const LABEL: Record<VoiceSnapshot['ui'], string> = { off: 'Talk with the tutor', listening: 'Listening… just talk', thinking: 'Thinking…', speaking: 'Speaking… talk any time to interrupt' };

/** The floating round mic button (right edge, mid-height) with its popover: status, Always on, typed box. */
export function VoiceChatUI(p: Props): JSX.Element {
  const { snap } = p;
  const [text, setText] = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const on = snap.line !== 'closed';
  const state = on || snap.ui !== 'off' ? snap.ui : 'off';
  // the typed box takes the focus when the popover opens, not each time a commands window closes (that would
  // swallow K / D / Esc / M while the popover stays open)
  const onRef = useRef(on); onRef.current = on;
  useEffect(() => { if (p.popover && !onRef.current) boxRef.current?.focus(); }, [p.popover]);
  const send = () => { const t = text.trim(); if (!t) return; p.onAsk(t); setText(''); };
  const mb = (bytes: number | undefined) => Math.max(1, Math.round((bytes || 111e6) / 1e6));
  const prog = snap.model?.progress;
  const pct = prog && prog.overallTotal > 0 ? Math.round((prog.overallReceived / prog.overallTotal) * 100) : null;
  const downloading = snap.model?.state === 'downloading';
  const statusLine = snap.line === 'window' && snap.ui === 'listening' ? 'Say “I know”, “I don’t know”, or ask a question' : LABEL[state];

  return (
    <div className={`voice-dock ${p.shifted ? 'shifted' : ''}`} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()} data-testid="voice">
      {p.popover && (
        <div className="voice-pop" role="dialog" aria-label="Voice chat" data-testid="voice-popover">
          <div className="vp-head">
            <span className={`vp-dot ${state}`} aria-hidden="true" />
            <span className="vp-status" data-testid="voice-status">{on ? statusLine : 'Voice line closed'}</span>
            <span className="grow" />
            <button className="icon quiet" onClick={() => p.onPopover(false)} aria-label="Close">✕</button>
          </div>
          {on && <div className="vp-meter" aria-hidden="true"><span style={{ transform: `scaleX(${Math.max(0.02, snap.level)})` }} /></div>}
          {snap.partial && <div className="vp-partial" data-testid="voice-partial">“{snap.partial}”</div>}
          {p.last && (
            <div className="vp-turns">
              <div className="vp-you"><b>You</b> {p.last.you}</div>
              <div className="vp-tutor"><b>Tutor</b> {p.last.status === 'thinking' && !p.last.tutor ? <span className="muted">thinking…</span> : p.last.status === 'error' ? <span className="vp-err">{p.last.error}</span> : p.last.tutor}</div>
            </div>
          )}
          {snap.consent && (
            <div className="vp-consent" data-testid="voice-consent">
              <div><b>Download the speech model ({mb(snap.model?.downloadBytes)} MB) once?</b></div>
              <div className="muted small">It runs on your Mac: what you say never leaves it. Typing works meanwhile.</div>
              {downloading ? (
                <div className="vp-progress"><div className="bar"><span style={{ width: `${pct ?? 0}%` }} /></div><span className="small muted">{prog?.phase === 'extract' ? 'Unpacking…' : `${pct ?? 0}%`}</span><button className="quiet" onClick={p.onDeclineDownload}>Cancel</button></div>
              ) : (
                <div className="row"><button className="primary" onClick={p.onAcceptDownload} data-testid="voice-download">Download</button><button className="quiet" onClick={p.onDeclineDownload}>Not now</button></div>
              )}
            </div>
          )}
          {snap.error && <div className="vp-error" data-testid="voice-error"><span>{snap.error}</span><button className="icon quiet" onClick={p.onDismissError} aria-label="Dismiss">✕</button></div>}
          <form className="vp-ask" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea ref={boxRef} rows={2} value={text} placeholder="Ask the tutor about this sentence…" onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} data-testid="voice-text" />
            <div className="row">
              <span className="muted small vp-hint">Pronunciation does not matter, you can type.</span>
              <span className="grow" />
              <button type="submit" className="primary" disabled={!text.trim()} data-testid="voice-send">Send</button>
            </div>
          </form>
          <label className="vp-always">
            <input type="checkbox" checked={snap.alwaysOn} onChange={(e) => p.onAlwaysOn(e.target.checked)} data-testid="voice-always" />
            <span>Always on <span className="muted small">(the tutor hears you whenever you talk)</span></span>
          </label>
          <div className="muted small">Say “bye bye” to close the line.</div>
        </div>
      )}
      <button className={`voice-mic ${state} ${on ? 'on' : ''}`} onClick={p.onToggle} data-testid="mic" data-state={state} data-line={snap.line}
        aria-label={on ? 'Close the voice line' : 'Talk with the tutor'} title={`${on ? 'Close the voice line' : 'Talk with the tutor'} (${p.keyLabel})`}>
        <MicIcon />
        {on && <span className="ring" style={{ transform: `scale(${1 + snap.level * 0.6})` }} aria-hidden="true" />}
      </button>
      <button className={`voice-more ${p.popover ? 'active' : ''}`} onClick={() => p.onPopover(!p.popover)} aria-label="Type a question, voice options" title="Type a question, voice options" data-testid="voice-more">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></svg>
      </button>
    </div>
  );
}

export function MicIcon(): JSX.Element {
  return <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
}
