/**
 * Keyboard shortcuts of the tutor on YouTube; every one can be changed in the quick settings (click it, press the
 * new keys). Combos are written as "Shift+KeyE" (modifiers in a fixed order, then KeyboardEvent.code), so they work
 * the same with any keyboard layout. The answers (I know / I don't know / Go on) only act while a window or card
 * is open, and "Go on" (Enter) while the reading page or the talk is open, so YouTube keeps its own keys otherwise.
 */
export interface ShortcutAction { id: string; label: string; def: string; when?: 'window' | 'page' | 'explaining' }

export const SHORTCUTS: ShortcutAction[] = [
  { id: 'explainSentence', label: 'Explain the last sentence (play it, explain, play it again)', def: 'ArrowLeft' },
  { id: 'explainLast', label: 'Explain the last part (30 s)', def: 'Shift+KeyE' },
  { id: 'talk', label: 'Talk to my tutor (live voice call)', def: 'Shift+KeyT' },
  { id: 'listening', label: 'Listening mode (all subtitles, full screen) / normal video', def: 'Shift+KeyL' },
  { id: 'page', label: 'Show / hide the reading page', def: 'Shift+KeyB' },
  { id: 'bigger', label: 'Bigger text', def: 'BracketRight' },
  { id: 'smaller', label: 'Smaller text', def: 'BracketLeft' },
  { id: 'zh', label: 'Chinese translation on / off', def: 'Shift+KeyC' },
  { id: 'tutor', label: 'My tutor on / off', def: 'Shift+KeyM' },
  { id: 'interrupt', label: 'Pause the teacher and ask (while it explains)', def: 'Space', when: 'explaining' },
  { id: 'continue', label: 'Go on (back to the video)', def: 'Enter', when: 'page' },
  { id: 'know', label: 'I know', def: 'KeyK', when: 'window' },
  { id: 'dontKnow', label: 'I don\'t know (explain / explain again)', def: 'KeyD', when: 'window' },
  { id: 'goOn', label: 'Bye bye: stop the AI, play again from the start', def: 'Escape', when: 'window' },
];

const MODS: ['ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', string][] = [['ctrlKey', 'Ctrl'], ['altKey', 'Alt'], ['shiftKey', 'Shift'], ['metaKey', 'Cmd']];

/** "Shift+KeyE" for a key event; '' for a lone modifier key. */
export function comboOf(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string {
  if (!e.code || /^(Shift|Control|Alt|Meta)(Left|Right)?$/.test(e.code)) return '';
  return [...MODS.filter(([k]) => e[k]).map(([, n]) => n), e.code].join('+');
}

/** "Shift+KeyE" -> "Shift+E", "BracketRight" -> "]", "ArrowLeft" -> "←" */
export function comboLabel(combo: string): string {
  if (!combo) return '—';
  const NAMES: Record<string, string> = { BracketRight: ']', BracketLeft: '[', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Enter: 'Enter', Space: 'Space', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`' };
  return combo.split('+').map((p) => NAMES[p] ?? p.replace(/^Key/, '').replace(/^Digit/, '')).join('+');
}

export function shortcutMap(custom: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(SHORTCUTS.map((a) => [a.id, custom?.[a.id] ?? a.def]));
}

/** The action a key event triggers (first match), or null. */
export function actionFor(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, custom: Record<string, string> | undefined): ShortcutAction | null {
  const c = comboOf(e);
  if (!c) return null;
  const map = shortcutMap(custom);
  return SHORTCUTS.find((a) => map[a.id] === c) ?? null;
}
