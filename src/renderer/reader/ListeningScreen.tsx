import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Position } from '@core/model';
import type { Settings, TtsEngineId } from '@shared/settings';
import type { TtsVoice } from '@core/tts/engine';
import { ENGINE_LABELS, AVAILABLE_ENGINES } from '@core/tts/engine';
import { useApp } from '../state/store';
import { Tip } from '../ui/Tip';
import type { ScreenShared } from './ReaderView';
import { keyOf } from './ReaderView';
import { BookIcon } from './ReadingScreen';
import { Timeline } from './Timeline';
import { clampRate, wordsPerMinute } from './progress';

/** The current line sits this far down the text area (the rest of the screen shows what comes next). */
const ANCHOR = 0.4;

interface Props {
  shared: ScreenShared;
  settings: Settings;
  voices: TtsVoice[];
  autoStop: boolean;
  onAutoStop: () => void;
  transcriptOpen: boolean;
  onTranscript: () => void;
  transcript: React.ReactNode;
  waiting: boolean;
  onContinue: () => void;
  onVoice: (engine: TtsEngineId, voiceId: string) => void;
  onWindow: (s: Settings['listen']['lastSecondsWindow']) => void;
}

/**
 * Listening mode: the chapter as lines (karaoke / lyrics). The current sentence is large and bright and the
 * text flows upward as the voice reads; past lines dim. A whole-book timeline and calm, always-visible controls.
 */
export function ListeningScreen(p: Props): JSX.Element {
  const { shared, settings } = p;
  const { book, index, chapter, position, playState, html, docRef, ensureRef, onRendered } = shared;
  const scrollRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const playing = playState === 'playing' || playState === 'explaining';
  const wpm = wordsPerMinute('listening', settings.voice.rate, true);

  useLayoutEffect(() => {
    const lines = linesRef.current; if (!lines) return;
    lines.innerHTML = html;
    docRef.current = lines;
    onRendered();
    return () => { if (docRef.current === lines) docRef.current = null; };
  }, [html, onRendered, docRef]);

  function ensureVisible(pos: Position, force = false): void {
    const scroll = scrollRef.current, lines = linesRef.current; if (!scroll || !lines) return;
    const el = lines.querySelector<HTMLElement>(`.s[data-key="${keyOf(pos)}"]`); if (!el) return;
    const place = () => {
      const r = el.getBoundingClientRect(), s = scroll.getBoundingClientRect();
      const top = scroll.scrollTop + (r.top - s.top) + r.height / 2 - scroll.clientHeight * ANCHOR;
      scroll.scrollTo({ top: Math.max(0, top), behavior: force ? 'auto' : 'smooth' });
    };
    place();
    // the line grows when it becomes the current one: settle once the size transition has ended
    if (!force) setTimeout(place, 260);
  }
  useEffect(() => { ensureRef.current = ensureVisible; return () => { ensureRef.current = () => undefined; }; });
  useEffect(() => {
    const scroll = scrollRef.current; if (!scroll) return;
    const ro = new ResizeObserver(() => ensureVisible(position, true));
    ro.observe(scroll);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.appearance.subtitleSizePx, settings.appearance.fontSizePx, settings.appearance.listenMaxLineChars]);

  const onLinesClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const target = e.target as HTMLElement;
    const w = target.closest<HTMLElement>('.w');
    if (w?.dataset.lemma) { if (e.detail === 2) { e.preventDefault(); return; } shared.tapWord(w); return; }
    if (shared.closeOverlays()) return;
    const s = target.closest('.s');
    if (s) shared.tapSentence(s);
  };

  const rate = settings.voice.rate;
  const setRate = (r: number) => shared.setRate(clampRate(r));
  const engines = AVAILABLE_ENGINES;

  return (
    <div className={`screen listening ${playing ? 'playing' : ''}`} data-testid="listening">
      <div className="traffic-drag drag" aria-hidden="true" />
      <div className="listen-main">
        <div className="listen-scroll" ref={scrollRef}>
          <div className="listen-head drag">
            <span className="book-title">{book.title}</span>
            {book.chapters[chapter] && book.chapters.length > 1 && <span className="chapter-name">{book.chapters[chapter].title}</span>}
            <span className="grow" />
            <div className="row no-drag">
              <Tip text="Reading mode: pages, like a Kindle (L)" below align="end"><button className="primary switch" onClick={shared.switchMode} data-testid="switch-mode"><BookIcon /> Read</button></Tip>
              <Tip text="Your books" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('library')}>Library</button></Tip>
              <Tip text="Look, voice, AI and level" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('settings')}>Settings</button></Tip>
              <Tip text="All keyboard shortcuts (?)" below align="end"><button className="quiet icon" onClick={shared.openHelp} aria-label="Shortcuts">?</button></Tip>
            </div>
          </div>
          <div className="listen-lines" ref={linesRef} onClick={onLinesClick} onDoubleClick={shared.onDoubleClick} onMouseUp={shared.onMouseUp} data-testid="doc" />
        </div>
        {p.transcript}
      </div>
      {p.waiting && <div className="waiting-chip" onClick={(e) => e.stopPropagation()}><span>Your turn: say or type the answer…</span><button onClick={p.onContinue}>Continue</button></div>}
      <div className="listen-bottom" onClick={(e) => e.stopPropagation()}>
        <Timeline index={index} wpm={wpm} position={position} scrubbing={scrubbing} onScrub={setScrubbing} onSeek={(pos) => shared.seek(pos)} />
        <div className="controls" data-testid="controls">
          <div className="group transport">
            <Tip text="Previous sentence (←)" align="start"><button className="icon" onClick={shared.prev} aria-label="Previous sentence">⏮</button></Tip>
            <Tip text="Play or pause (Space)"><button className="primary icon play" onClick={shared.playPause} data-testid="play" aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button></Tip>
            <Tip text="Next sentence (→)"><button className="icon" onClick={shared.next} aria-label="Next sentence">⏭</button></Tip>
          </div>
          <div className="group speed" data-testid="speed">
            <Tip text="Slower (−)"><button className="icon" onClick={() => setRate(rate - 0.1)} aria-label="Slower">−</button></Tip>
            <input type="range" min={0.5} max={2} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Speed" />
            <Tip text="Faster (+)"><button className="icon" onClick={() => setRate(rate + 0.1)} aria-label="Faster">+</button></Tip>
            <span className="val">{rate.toFixed(1)}×</span>
          </div>
          <div className="group explain">
            <Tip text="Hear the last explanation again, deeper; or explain the hard word of this sentence (D)"><button onClick={shared.dontKnow} data-testid="dontknow">I don't know</button></Tip>
            <Tip text="Explain what was just read (Shift+E)"><button onClick={shared.explainLast} data-testid="explain-last">Explain last</button></Tip>
            <select value={settings.listen.lastSecondsWindow} onChange={(e) => p.onWindow(Number(e.target.value) as never)} aria-label="How far back" data-testid="window">
              {[20, 30, 40, 60].map((s) => <option key={s} value={s}>{s} s</option>)}
            </select>
            <Tip text={p.autoStop ? 'Auto-stop at hard words is on (Q)' : 'Auto-stop at hard words is off (Q)'}><button className={`icon ${p.autoStop ? 'active' : ''}`} onClick={p.onAutoStop} aria-label="Auto-stop at hard words" data-testid="autostop">{p.autoStop ? '◉' : '○'}</button></Tip>
          </div>
          <span className="grow" />
          <div className="group right">
            <select className="voice" value={`${settings.voice.engine}|${settings.voice.voiceId}`} onChange={(e) => { const [eng, id] = e.target.value.split('|'); p.onVoice(eng as TtsEngineId, id); }} aria-label="Voice" data-testid="voice">
              {engines.map((eng) => {
                const vs = p.voices.filter((v) => v.engine === eng);
                const meta = ENGINE_LABELS[eng];
                return (
                  <optgroup key={eng} label={`${meta.label} · ${meta.cost}`}>
                    {vs.length === 0 && <option value={`${eng}|`}>{eng === settings.voice.engine ? 'Default voice' : `Default voice (${meta.kind === 'cloud' ? 'needs setup' : 'auto'})`}</option>}
                    {vs.map((v) => <option key={v.id} value={`${eng}|${v.id}`}>{v.name} ({v.lang}){v.note ? ` – ${v.note}` : ''}</option>)}
                  </optgroup>
                );
              })}
            </select>
            <Tip text="Show or hide the written explanations" align="end"><button className={`icon ${p.transcriptOpen ? 'active' : ''}`} onClick={p.onTranscript} aria-label="Explanations" data-testid="transcript-toggle">≡</button></Tip>
            <Tip text="Voice chat comes in the next update" align="end"><button className="icon mic" disabled data-testid="mic" aria-label="Microphone (coming soon)" title="Voice chat comes in the next update"><MicIcon /></button></Tip>
          </div>
        </div>
      </div>
    </div>
  );
}

function MicIcon(): JSX.Element {
  return <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
}
