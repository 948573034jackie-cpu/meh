import React from 'react';
import type { CefrLevel } from '@core/model';
import type { WordStatus } from '@shared/settings';
import { parseGloss } from '@core/dict/dictionary';

export interface PopupData {
  word: string;
  lemma: string;
  ipa: string;
  zh: string;
  level: CefrLevel | null;
  isName: boolean;
  status: WordStatus | undefined;
  x: number;
  y: number;
  placeBelow: boolean;
}

interface Props {
  data: PopupData;
  onClose: () => void;
  onSay: () => void;
  onAsk: () => void;
  onStatus: (s: WordStatus | null) => void;
  onMarkSentence: () => void;
}

export function Popup({ data, onClose, onSay, onAsk, onStatus, onMarkSentence }: Props): JSX.Element {
  const glosses = data.zh ? parseGloss(data.zh) : [];
  const style: React.CSSProperties = { left: Math.max(8, data.x - 160), top: data.placeBelow ? data.y + 8 : undefined, bottom: data.placeBelow ? undefined : `calc(100% - ${data.y}px + 8px)` };
  return (
    <div className="popup" style={style} data-testid="popup" onClick={(e) => e.stopPropagation()}>
      <div className="hw">
        <span className="word">{data.word}</span>
        {data.lemma !== data.word.toLowerCase() && !data.isName && <span className="muted small">→ {data.lemma}</span>}
        {data.ipa && <span className="ipa">{data.ipa}</span>}
        <button className="icon" title="Say it (S)" onClick={onSay}>▶</button>
        <span className="grow" />
        {data.level && <span className="lvl">{data.level}</span>}
        {data.isName && <span className="lvl">name</span>}
      </div>
      {glosses.length > 0 ? (
        <div className="zh">{glosses.slice(0, 4).map((g, i) => <div key={i}>{g.pos && <span className="pos">{g.pos}</span>}{g.zh}</div>)}</div>
      ) : data.isName ? <div className="muted small">A name. Ask AI for the Chinese transliteration.</div> : <div className="muted small">Not in the offline dictionary. Ask AI.</div>}
      <div className="row status-btns">
        <button className={data.status === 'known' ? 'active' : ''} title="Known: never highlighted, never stops (K)" onClick={() => onStatus(data.status === 'known' ? null : 'known')}>✓ Known</button>
        <button className={data.status === 'learning' ? 'active' : ''} title="Learning: highlighted yellow, does not stop (L)" onClick={() => onStatus(data.status === 'learning' ? null : 'learning')}>Learning</button>
        <button className={data.status === 'ignored' ? 'active' : ''} title="Ignore (X)" onClick={() => onStatus(data.status === 'ignored' ? null : 'ignored')}>Ignore</button>
      </div>
      <div className="row">
        <button className="primary" onClick={onAsk} data-testid="popup-ask">Ask AI (E)</button>
        <button onClick={onMarkSentence} title="Explain this whole sentence when listening reaches it (H)">Mark sentence</button>
        <span className="grow" />
        <button className="icon" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
    </div>
  );
}
