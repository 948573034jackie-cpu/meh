/** Matches a KeyboardEvent against a shortcut string like "Shift+KeyE", "Space", "Equal". */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
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

export function shortcutLabel(s: string): string {
  return s.replace('Key', '').replace('Digit', '').replace('Arrow', '').replace('Equal', '+').replace('Minus', '−').replace('Cmd', '⌘').replace('Shift', '⇧').replace('+', ' ');
}
