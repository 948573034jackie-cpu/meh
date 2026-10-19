import React from 'react';
import type { ReadMode } from '@shared/settings';
import { SHORTCUT_HELP, LISTEN_KEYS, shortcutLabel } from './shortcuts';

/** The "?" sheet: every shortcut with a one-line explanation. Keys come from settings.shortcuts. */
export function HelpSheet({ shortcuts, mode, onClose }: { shortcuts: Record<string, string>; mode: ReadMode; onClose: () => void }): JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="help">
      <div className="modal help-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2>Keyboard shortcuts</h2><span className="grow" /><span className="muted small">You are in {mode === 'reading' ? 'Reading' : 'Listening'} mode</span><button className="icon quiet" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="help-groups">
          {SHORTCUT_HELP.map((g) => (
            <section key={g.group}>
              <h3>{g.group}</h3>
              <div className="kv">
                {g.items.map((it) => {
                  const key = LISTEN_KEYS[it.id] ?? shortcuts[it.id];
                  if (!key) return null;
                  const off = it.modes && !it.modes.includes(mode);
                  return <React.Fragment key={it.id}><span className="key">{shortcutLabel(key)}</span><span className={off ? 'muted' : ''}>{it.text}{off ? ` (${it.modes!.join('/')} mode)` : ''}</span></React.Fragment>;
                })}
              </div>
            </section>
          ))}
        </div>
        <div className="muted small">Mouse: in Reading mode tap the left or right fifth of the page to turn it, the middle to show or hide the bars; swipe sideways for the previous or next sentence. Tap any word for its meaning and a spoken explanation; double-tap to mark it known; select text to explain a phrase.</div>
      </div>
    </div>
  );
}
