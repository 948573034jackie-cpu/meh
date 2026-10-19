import React, { useRef, useState } from 'react';
import type { Position } from '@core/model';
import { chapterMarks, formatClock, positionAtTime, timeAt, totalTime, type BookIndex } from './progress';

interface Props {
  index: BookIndex;
  wpm: number;
  position: Position;
  /** seconds under the pointer while dragging (null = not dragging); reported through onScrub */
  scrubbing: number | null;
  onScrub: (seconds: number | null) => void;
  onSeek: (pos: Position) => void;
}

/** The whole-book timeline: estimated listening time, chapter marks with titles, drag to seek. */
export function Timeline({ index, wpm, position, scrubbing, onScrub, onSeek }: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; title: string } | null>(null);
  const total = totalTime(index, wpm);
  const now = timeAt(index, position, wpm);
  const marks = chapterMarks(index);
  const frac = total > 0 ? Math.min(1, Math.max(0, (scrubbing ?? now) / total)) : 0;

  const secondsAt = (clientX: number): number => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onScrub(secondsAt(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (scrubbing !== null && (e.buttons & 1)) onScrub(secondsAt(e.clientX));
    const r = trackRef.current!.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const m = [...marks].reverse().find((k) => k.at <= f);
    setHover({ x: e.clientX - r.left, title: `${formatClock(f * total)}${m ? ` · ${m.title}` : ''}` });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (scrubbing === null) return;
    const sec = secondsAt(e.clientX);
    onScrub(null);
    const pos = positionAtTime(index, sec, wpm);
    if (pos) onSeek(pos);
  };

  return (
    <div className="timeline" data-testid="timeline">
      <span className="t cur" data-testid="clock">{formatClock(scrubbing ?? now)}</span>
      <div className="track" ref={trackRef} role="slider" aria-label="Position in the book" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(now)} aria-valuetext={formatClock(now)}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => onScrub(null)} onPointerLeave={() => setHover(null)}>
        <div className="fill" style={{ width: `${frac * 100}%` }} />
        {marks.map((m) => m.at > 0 && <i key={m.index} className="mark" style={{ left: `${m.at * 100}%` }} data-testid="chapter-mark" title={m.title} />)}
        <div className="thumb" style={{ left: `${frac * 100}%` }} />
        {hover && <div className="hover-label" style={{ left: hover.x }}>{hover.title}</div>}
      </div>
      <span className="t total" data-testid="clock-total">{formatClock(total)}</span>
    </div>
  );
}
