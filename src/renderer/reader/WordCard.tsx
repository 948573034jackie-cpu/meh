import React from 'react';
import type { CefrLevel } from '@core/model';
import type { WordStatus } from '@shared/settings';
import { parseGloss } from '@core/dict/dictionary';
import { Tip } from '../ui/Tip';

/** The small card under a tapped word (Trancy-style): word, IPA, level, meanings, and the three status buttons. */
export interface CardData {
  word: string;
  lemma: string;
  ipa: string;
  zh: string;
  level: CefrLevel | null;
  isName: boolean;
  status: WordStatus | undefined;
  /** anchor: centre x and the bottom of the word, relative to the reader screen */
  x: number;
  y: number;
  /** the card goes above the word when there is no room below */
  above: boolean;
  /** the voice explanation that the tap started: its streamed text and state */
  explain: { status: 'thinking' | 'speaking' | 'done' | 'error' | 'skipped' | 'idle'; text: string; error?: string };
}

interface Props {
  data: CardData;
  onClose: () => void;
  onSay: () => void;
  onKnown: () => void;
  onDontKnow: () => void;
  onIgnore: () => void;
}

export function WordCard({ data, onClose, onSay, onKnown, onDontKnow, onIgnore }: Props): JSX.Element {
  const glosses = data.zh ? parseGloss(data.zh).slice(0, 2) : [];
  const style: React.CSSProperties = { left: Math.max(8, data.x - 150), top: data.above ? undefined : data.y + 8, bottom: data.above ? `calc(100% - ${data.y}px + 8px)` : undefined };
  const ex = data.explain;
  const english = ex.text ? firstSentences(ex.text, 160) : '';
  return (
    <div className={`card-word ${data.above ? 'above' : 'below'}`} style={style} data-testid="card" data-status={ex.status} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="hw">
        <span className="word">{data.word}</span>
        {data.ipa && <span className="ipa">{data.ipa}</span>}
        <Tip text="Say the word (S)"><button className="icon say" onClick={onSay} aria-label="Say the word">▶</button></Tip>
        <span className="grow" />
        {data.level && <span className="lvl">{data.level}</span>}
        {data.isName && <span className="lvl">name</span>}
        {data.lemma !== data.word.toLowerCase() && !data.isName && <span className="lemma">{data.lemma}</span>}
      </div>
      {glosses.length > 0 ? (
        <div className="zh">{glosses.map((g, i) => <span key={i}>{g.pos && <span className="pos">{g.pos}</span>}{g.zh}</span>)}</div>
      ) : data.isName ? <div className="muted small">A name.</div> : <div className="muted small">Not in the offline dictionary.</div>}
      <div className={`en ${ex.status}`} data-testid="card-explain">
        {ex.status === 'thinking' && !english && <span className="muted">Explaining…</span>}
        {english && <span>{english}</span>}
        {ex.status === 'error' && !english && <span className="muted">{ex.error ?? 'The explanation failed.'}</span>}
        {(ex.status === 'speaking' || ex.status === 'thinking') && <span className="live-dot" aria-hidden="true" />}
      </div>
      <div className="row status-btns">
        <Tip text="Known: no highlight, no hint, never explained (K)" align="start"><button className={data.status === 'known' ? 'active' : ''} onClick={onKnown} data-testid="card-known">I know</button></Tip>
        <Tip text="Hear it explained again, deeper; stays highlighted (D)"><button className={data.status === 'learning' ? 'active' : ''} onClick={onDontKnow} data-testid="card-dontknow">I don't know</button></Tip>
        <Tip text="Ignore this word for good (X)" align="end"><button className={data.status === 'ignored' ? 'active' : ''} onClick={onIgnore} data-testid="card-ignore">Ignore</button></Tip>
        <span className="grow" />
        <button className="icon quiet close" onClick={onClose} aria-label="Close (Esc)">✕</button>
      </div>
    </div>
  );
}

/** The first sentence or two of a streamed explanation, cut at a sentence end within `max` characters. */
export function firstSentences(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}
