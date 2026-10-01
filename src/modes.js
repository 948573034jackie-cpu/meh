// Shared color modes. Loaded by the content script, the popup and the service worker.
//
// Each mode says what a plain page's white background and black text should become.
// Dark modes first invert light pages, so for them `bg` is the new background and
// `fg` the new text color. The numbers come from the research notes in README.md.
var EYECARE_MODES = [
  { id: 'original', name: 'Original', tip: 'No change', bg: '#FFFFFF', fg: '#000000', dark: false },
  { id: 'paper', name: 'Paper', tip: 'Soft daytime reading', bg: '#F5EEDC', fg: '#2E2A24', dark: false },
  { id: 'book', name: 'Book', tip: 'Warm sepia, long reads', bg: '#F1E3C4', fg: '#4A3B2A', dark: false },
  { id: 'warm', name: 'Blue-light filter', tip: 'Keeps colors, cuts blue', bg: '#FFD3A0', fg: '#000000', dark: false },
  { id: 'dark', name: 'Dark', tip: 'Dark gray, not pure black', bg: '#1F1F1F', fg: '#DADADA', dark: true },
  { id: 'night', name: 'Night', tip: 'Dark + low blue, before bed', bg: '#1E1A16', fg: '#E3C9A5', dark: true }
];

var EYECARE_DEFAULTS = { mode: 'original', lastMode: 'paper', brightness: 100, disabledSites: [] };

function eyecareMode(id) {
  return EYECARE_MODES.find((m) => m.id === id) || EYECARE_MODES[0];
}
