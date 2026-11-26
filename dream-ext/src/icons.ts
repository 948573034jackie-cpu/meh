/**
 * The one icon set of both apps, on the web side. The native views use SF Symbols; these are the same symbols
 * (the same names), drawn as simple line icons in their style: 24 x 24, a 1.7 stroke in the text colour, round ends.
 * An icon is only a picture (aria-hidden): the button around it keeps its own label (aria-label or its words).
 */
const LINE: Record<string, string> = {
  'book': '<path d="M12 6.6C10 5.1 7.2 4.6 3.6 5v13.2c3.6-.4 6.4.1 8.4 1.6 2-1.5 4.8-2 8.4-1.6V5c-3.6-.4-6.4.1-8.4 1.6z"/><path d="M12 6.6v13.2"/>',
  'book.closed': '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 23H19"/>',
  'character.book.closed': '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M5 20.5A2.5 2.5 0 0 0 7.5 23H19"/><path d="M9.6 14.5 12 7.5l2.4 7M10.4 12.2h3.2"/>',
  'gearshape': '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.4"/>',
  'slider.horizontal.3': '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  'xmark': '<path d="M6 6l12 12M18 6 6 18"/>',
  'chevron.left': '<path d="M15 5l-7 7 7 7"/>',
  'chevron.right': '<path d="M9 5l7 7-7 7"/>',
  'plus': '<path d="M12 5v14M5 12h14"/>',
  'speaker.wave.2': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  'text.magnifyingglass': '<path d="M4 6h12M4 10h7M4 14h5"/><circle cx="15.5" cy="15.5" r="3.5"/><path d="M18 18l2.5 2.5"/>',
  'magnifyingglass': '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  'text.bubble': '<path d="M4 5h16v11H9l-5 4z"/><path d="M8.5 9h7M8.5 12h4.5"/>',
  'phone.fill': '<path d="M6.6 3.5h2.6l1.4 4.1-1.9 1.3a11 11 0 0 0 6.4 6.4l1.3-1.9 4.1 1.4v2.6a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>',
  'mic': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  'headphones': '<path d="M4 14.5V12a8 8 0 0 1 16 0v2.5"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.8"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.8"/>',
  'ellipsis': '<circle cx="5" cy="12" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="19" cy="12" r="1.1"/>',
  'doc.text': '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 15.5h6M9 19h4"/>',
  'square.and.arrow.down': '<path d="M8 10l4 4 4-4M12 3v11"/><path d="M5 13v7h14v-7"/>',
  'icloud': '<path d="M7 18.5h10.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6-1.2A4.6 4.6 0 0 0 7 18.5z"/>',
  'sun.max': '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  'moon': '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  'textformat.size': '<path d="M3 19 8 6l5 13M4.8 14.5h6.4M14 19l3.5-8.5L21 19M15 16.5h5"/>',
  'hand.raised': '<path d="M8 12V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V5.5a1.5 1.5 0 0 1 3 0V13M8 12a1.5 1.5 0 0 0-3 0v2a8 8 0 0 0 8 7h.5a6.5 6.5 0 0 0 6.5-6.5V9a1.5 1.5 0 0 0-3 0"/>',
  'music.note': '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  'film': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/>',
  'key': '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>',
  'pencil': '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  'checkmark': '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  'list.bullet': '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
};
const FILLED: Record<string, string> = {
  'play.fill': '<path d="M8 5.2v13.6l11-6.8z"/>',
  'pause.fill': '<path d="M7 5h3.6v14H7zM13.4 5H17v14h-3.6z"/>',
  'stop.fill': '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  'backward.fill': '<path d="M11 7l-6 5 6 5zM19 7l-6 5 6 5z"/>',
  'forward.fill': '<path d="M13 7l6 5-6 5zM5 7l6 5-6 5z"/>',
};
export type IconName = keyof typeof LINE | keyof typeof FILLED;
export const ICON_NAMES = [...Object.keys(LINE), ...Object.keys(FILLED)];

/** the icon as SVG text (class "ic": its size and colour come from the page's CSS) */
export function icon(name: string, cls = 'ic'): string {
  const fill = FILLED[name];
  const body = fill ?? LINE[name];
  if (!body) return '';
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${fill ? ' style="fill:currentColor;stroke:none"' : ''}>${body}</svg>`;
}

/** the CSS every page needs for the icons (a page may size .ic itself) */
export const ICON_CSS = '.ic{width:1.25em;height:1.25em;flex:none;display:inline-block;vertical-align:-0.25em;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}';
