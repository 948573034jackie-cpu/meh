import { create } from 'zustand';
import type { Book } from '@core/model';
import type { Settings, LibraryItem, VocabState, ReadMode } from '@shared/settings';
import { DEFAULT_SETTINGS, isDarkTheme } from '@shared/settings';

export type View = 'library' | 'reader' | 'settings' | 'diagnostics';

interface AppState {
  view: View;
  settings: Settings;
  library: LibraryItem[];
  book: Book | null;
  /** the screen the open book is shown on; persisted per book (settings.bookModes) and as settings.lastMode */
  mode: ReadMode;
  vocab: VocabState;
  toast: { text: string; action?: { label: string; run: () => void } } | null;
  setView(v: View): void;
  setSettings(s: Settings): void;
  patchSettings(patch: Partial<Settings>): Promise<void>;
  refreshLibrary(): Promise<void>;
  openBook(id: string): Promise<void>;
  setBook(b: Book | null): void;
  /** switches the screen of the open book and remembers it for the book and as the default for new books */
  setMode(m: ReadMode): void;
  setVocab(v: VocabState): void;
  showToast(text: string, action?: { label: string; run: () => void }): void;
}

/** The screen a book opens on: the one used last for it, else the one used last at all. */
export function modeForBook(settings: Settings, bookId: string): ReadMode {
  return settings.bookModes?.[bookId] ?? settings.lastMode ?? 'reading';
}

/** Library items with the per-book screen filled in from settings, so the library can show it. */
function withModes(items: LibraryItem[], settings: Settings): LibraryItem[] {
  return items.map((it) => (settings.bookModes?.[it.id] ? { ...it, mode: settings.bookModes[it.id] } : it));
}

export const useApp = create<AppState>((set, get) => ({
  view: 'library',
  settings: DEFAULT_SETTINGS,
  library: [],
  book: null,
  mode: 'reading',
  vocab: { words: {}, marked: {} },
  toast: null,
  setView: (view) => set({ view }),
  setSettings: (settings) => set({ settings, library: withModes(get().library, settings) }),
  patchSettings: async (patch) => {
    const settings = await window.readalong.setSettings(patch);
    set({ settings, library: withModes(get().library, settings) });
  },
  refreshLibrary: async () => set({ library: withModes(await window.readalong.listLibrary(), get().settings) }),
  openBook: async (id) => {
    const book = await window.readalong.loadBook(id);
    if (book) set({ book, view: 'reader', mode: modeForBook(get().settings, book.id) });
  },
  setBook: (book) => set({ book, mode: book ? modeForBook(get().settings, book.id) : get().mode }),
  setMode: (mode) => {
    const { book, settings } = get();
    if (get().mode === mode) return;
    set({ mode });
    const patch: Partial<Settings> = { lastMode: mode };
    if (book) patch.bookModes = { ...(settings.bookModes ?? {}), [book.id]: mode };
    void get().patchSettings(patch);
  },
  setVocab: (vocab) => set({ vocab }),
  showToast: (text, action) => {
    set({ toast: { text, action } });
    setTimeout(() => { if (get().toast?.text === text) set({ toast: null }); }, 4000);
  },
}));

/** Applies theme + reader typography to the document root as CSS variables. */
export function applyAppearance(s: Settings): void {
  const root = document.documentElement;
  const a = s.appearance;
  const stored = (a.theme as string) === 'dark' ? 'night' : a.theme;
  const theme = stored === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'night') : stored;
  root.dataset.theme = theme;
  const hl = isDarkTheme(theme) ? a.highlightsDark : a.highlightsLight;
  root.style.setProperty('--hl-unknown', hl.unknown);
  root.style.setProperty('--hl-learning', hl.learning);
  root.style.setProperty('--hl-sentence', hl.sentence);
  root.style.setProperty('--hl-word', hl.word);
  root.style.setProperty('--hl-marked', hl.marked);
  root.style.setProperty('--reader-font', `var(--font-${a.fontFamily})`);
  root.style.setProperty('--reader-size', `${a.fontSizePx}px`);
  root.style.setProperty('--reader-lh', String(a.lineHeight));
  root.style.setProperty('--reader-margin', `${a.marginPx}px`);
  root.style.setProperty('--subtitle-size', `${a.subtitleSizePx ?? DEFAULT_SETTINGS.appearance.subtitleSizePx}px`);
  root.style.setProperty('--explain-size', `${a.explainSizePx ?? DEFAULT_SETTINGS.appearance.explainSizePx}px`);
  root.style.setProperty('--ui-scale', String(clamp(a.uiScale ?? 1, 0.9, 1.3)));
  root.style.setProperty('--max-line', String(a.maxLineChars ?? DEFAULT_SETTINGS.appearance.maxLineChars));
  root.style.setProperty('--max-line-listen', String(a.listenMaxLineChars ?? DEFAULT_SETTINGS.appearance.listenMaxLineChars));
  root.dataset.tips = a.showTips === false ? '0' : '1';
  root.dataset.underlineOnly = a.underlineOnly ? '1' : '0';
  root.dataset.hints = a.showHints === false ? '0' : '1';
  root.dataset.pageTurn = a.pageTurnAnimation === false ? '0' : '1';
}

function clamp(n: number, lo: number, hi: number): number { return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 1; }
