/** Matches a KeyboardEvent against a shortcut string like "Shift+KeyE", "Space", "Equal". */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split('+');
  const code = parts.pop()!;
  const need = { shift: parts.includes('Shift'), alt: parts.includes('Alt'), ctrl: parts.includes('Ctrl'), meta: parts.includes('Cmd') || parts.includes('Meta') };
  if (e.code !== code) return false;
  return e.shiftKey === need.shift && e.altKey === need.alt && e.ctrlKey === need.ctrl && e.metaKey === need.meta;
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

const KEY_NAMES: Record<string, string> = { Equal: '+', Minus: '−', Slash: '?', Cmd: '⌘', Meta: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃', Escape: 'Esc' };
export function shortcutLabel(s: string): string {
  return s.split('+').map((part) => KEY_NAMES[part] ?? part.replace(/^(Key|Digit|Arrow)/, '')).join(' ');
}

/** One line per shortcut for the help sheet ("?"), grouped by what it is for. Keys come from settings.shortcuts. */
export const SHORTCUT_HELP: { group: string; items: { id: string; text: string; modes?: ('reading' | 'listening')[] }[] }[] = [
  { group: 'Reading and listening', items: [
    { id: 'playPause', text: 'Play or pause the voice' },
    { id: 'prevSentence', text: 'Previous sentence' },
    { id: 'nextSentence', text: 'Next sentence' },
    { id: 'replaySentence', text: 'Hear the current sentence again' },
    { id: 'prevPage', text: 'Previous page', modes: ['reading'] },
    { id: 'nextPage', text: 'Next page', modes: ['reading'] },
    { id: 'prevParagraph', text: 'Previous paragraph', modes: ['reading'] },
    { id: 'nextParagraph', text: 'Next paragraph', modes: ['reading'] },
    { id: 'switchMode', text: 'Switch between Reading and Listening mode' },
    { id: 'goTo', text: 'Go to a chapter, page or percent', modes: ['reading'] },
    { id: 'speedUp', text: 'Faster (0.1 steps)' },
    { id: 'speedDown', text: 'Slower (0.1 steps)' },
    { id: 'speedReset', text: 'Normal speed' },
  ] },
  { group: 'Explanations', items: [
    { id: 'explain', text: 'Explain the word on the card, the selection, or the current sentence' },
    { id: 'explainLast', text: 'Explain what was just read (the last 20–60 seconds)' },
    { id: 'dontKnow', text: '"I don\'t know": hear the last explanation again, deeper' },
    { id: 'toggleListen', text: 'Pause at hard words on/off (Listening mode)', modes: ['listening'] },
    { id: 'closePopup', text: 'Close the card, or skip the explanation being spoken' },
    { id: 'nextHard', text: 'Jump to the next hard word' },
    { id: 'prevHard', text: 'Jump to the previous hard word' },
  ] },
  { group: 'At a hard word (the 5-second window)', items: [
    { id: '_winKnow', text: '"I know": known for good, no explanation; the sentence is read again and the book goes on' },
    { id: '_winDontKnow', text: '"I don\'t know": the explanation now (after it: again, deeper)' },
    { id: '_winGoOn', text: '"Go on": no explanation; the sentence is read again and the book goes on' },
  ] },
  { group: 'Words', items: [
    { id: 'markKnown', text: 'Mark the word on the card as known (never explained again)' },
    { id: 'markLearning', text: 'Mark the word on the card as learning' },
    { id: 'ignore', text: 'Ignore the word on the card' },
    { id: 'sayWord', text: 'Say the word on the card' },
    { id: 'markPhrase', text: 'Mark the selection or sentence to be explained when listening reaches it' },
    { id: 'toggleHints', text: 'Chinese hints under hard words on/off' },
  ] },
  { group: 'Listening mode only', items: [
    { id: '_listenUp', text: 'Explain the previous sentence' },
    { id: '_listenDown', text: 'Explain the next sentence' },
    { id: '_listenBack', text: 'Back 30 seconds' },
    { id: '_listenFwd', text: 'Forward 30 seconds' },
  ] },
  { group: 'Voice chat', items: [
    { id: 'pushToTalk', text: 'Talk with the tutor: open or close the voice line (the mic button on the right)' },
  ] },
  { group: 'Help', items: [{ id: 'help', text: 'This sheet' }] },
];

/** The window answers use the keys of these shortcuts (K, D, Esc by default). */
export const WINDOW_KEY_OF: Record<string, string> = { _winKnow: 'markKnown', _winDontKnow: 'dontKnow', _winGoOn: 'closePopup' };

/** Keys of the listening-only shortcuts, which are fixed (not in settings). */
export const LISTEN_KEYS: Record<string, string> = { _listenUp: 'ArrowUp', _listenDown: 'ArrowDown', _listenBack: 'Shift+ArrowLeft', _listenFwd: 'Shift+ArrowRight' };
