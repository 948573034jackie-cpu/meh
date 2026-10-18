import React from 'react';
import type { Book } from '@core/model';
import type { PlaybackState } from '@core/listen/playback';
import type { Settings, TtsEngineId } from '@shared/settings';
import type { TtsVoice } from '@core/tts/engine';
import { ENGINE_LABELS, AVAILABLE_ENGINES } from '@core/tts/engine';

interface Props {
  book: Book;
  state: PlaybackState;
  listenOn: boolean;
  settings: Settings;
  chapter: number;
  voices: TtsVoice[];
  stops: number | null;
  transcriptOpen: boolean;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleListen: () => void;
  onExplainLast: () => void;
  onRate: (r: number) => void;
  onVoice: (engine: TtsEngineId, voiceId: string) => void;
  onChapter: (i: number) => void;
  onLayout: () => void;
  onBand: () => void;
  onTranscript: () => void;
  onWindow: (s: Settings['listen']['lastSecondsWindow']) => void;
}

export function Transport(p: Props): JSX.Element {
  const playing = p.state === 'playing' || p.state === 'explaining';
  const engines = AVAILABLE_ENGINES;
  return (
    <div className="transport" data-testid="transport">
      <button className="icon" title="Previous sentence (←)" onClick={p.onPrev}>⏮</button>
      <button className="primary icon" style={{ minWidth: 64 }} title="Play / pause (Space)" onClick={p.onPlayPause} data-testid="play">{playing ? '⏸' : '▶'}</button>
      <button className="icon" title="Next sentence (→)" onClick={p.onNext}>⏭</button>
      <button className={`listen-toggle ${p.listenOn ? 'on' : ''}`} title="Listening mode: stops at hard words and explains them (Q)" onClick={p.onToggleListen} data-testid="listen">
        {p.listenOn ? '● Listening mode' : '○ Listening mode'}
      </button>
      {p.listenOn && p.stops !== null && <span className="pill live" title="Stops left in this chapter">{p.stops} stops</span>}
      <button title="Explain the last part (Shift+E)" onClick={p.onExplainLast} data-testid="explain-last">↺ Explain last</button>
      <select value={p.settings.listen.lastSecondsWindow} onChange={(e) => p.onWindow(Number(e.target.value) as never)} title="How far back">
        {[20, 30, 40, 60].map((s) => <option key={s} value={s}>{s} s</option>)}
      </select>
      <span className="speed">
        <span>{p.settings.voice.rate.toFixed(1)}×</span>
        <input type="range" min={0.5} max={2.5} step={0.1} value={p.settings.voice.rate} onChange={(e) => p.onRate(Number(e.target.value))} title="Reading speed (+ / −)" />
      </span>
      <select value={`${p.settings.voice.engine}|${p.settings.voice.voiceId}`} onChange={(e) => { const [eng, id] = e.target.value.split('|'); p.onVoice(eng as TtsEngineId, id); }} title="Voice">
        {engines.map((eng) => {
          const vs = p.voices.filter((v) => v.engine === eng);
          const meta = ENGINE_LABELS[eng];
          return (
            <optgroup key={eng} label={`${meta.label} · ${meta.cost}`}>
              {vs.length === 0 && <option value={`${eng}|`}>{eng === p.settings.voice.engine ? 'Default voice' : `Default voice (${meta.kind === 'cloud' ? 'needs setup' : 'auto'})`}</option>}
              {vs.map((v) => <option key={v.id} value={`${eng}|${v.id}`}>{v.name} ({v.lang}){v.note ? ` – ${v.note}` : ''}</option>)}
            </optgroup>
          );
        })}
      </select>
      <span className="grow" />
      <select value={p.chapter} onChange={(e) => p.onChapter(Number(e.target.value))} title="Chapter">
        {p.book.chapters.map((c) => <option key={c.index} value={c.index}>{c.index + 1}. {c.title.slice(0, 40)}</option>)}
      </select>
      <button className="icon" title="Page / scroll layout" onClick={p.onLayout}>{p.settings.appearance.layout === 'page' ? '📖' : '📜'}</button>
      <button className={`icon ${p.settings.appearance.bandEnabled ? 'active' : ''}`} title="Subtitle band (B)" onClick={p.onBand}>▭</button>
      <button className="icon" title="Explanations panel" onClick={p.onTranscript}>{p.transcriptOpen ? '▶|' : '|◀'}</button>
    </div>
  );
}
