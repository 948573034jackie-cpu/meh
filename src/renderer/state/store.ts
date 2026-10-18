import { create } from 'zustand';
import type { Book } from '@core/model';
import type { Settings, LibraryItem, VocabState } from '@shared/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';

export type View = 'library' | 'reader' | 'settings' | 'diagnostics';

interface AppState {
  view: View;
  settings: Settings;
  library: LibraryItem[];
  book: Book | null;
  vocab: VocabState;
  toast: { text: string; action?: { label: string; run: () => void } } | null;
  setView(v: View): void;
  setSettings(s: Settings): void;
  patchSettings(patch: Partial<Settings>): Promise<void>;
  refreshLibrary(): Promise<void>;
  openBook(id: string): Promise<void>;
  setBook(b: Book | null): void;
  setVocab(v: VocabState): void;
  showToast(text: string, action?: { label: string; run: () => void }): void;
}

export const useApp = create<AppState>((set, get) => ({
  view: 'library',
  settings: DEFAULT_SETTINGS,
  library: [],
  book: null,
  vocab: { words: {}, marked: {} },
  toast: null,
  setView: (view) => set({ view }),
  setSettings: (settings) => set({ settings }),
  patchSettings: async (patch) => {
    const settings = await window.readalong.setSettings(patch);
    set({ settings });
  },
  refreshLibrary: async () => set({ library: await window.readalong.listLibrary() }),
  openBook: async (id) => {
    const book = await window.readalong.loadBook(id);
    if (book) set({ book, view: 'reader' });
  },
  setBook: (book) => set({ book }),
  setVocab: (vocab) => set({ vocab }),
  showToast: (text, action) => {
    set({ toast: { text, action } });
    setTimeout(() => { if (get().toast?.text === text) set({ toast: null }); }, 4000);
  },
}));

/** Applies theme + reader typography to the document root as CSS variables. */
export function applyAppearance(s: Settings): void {
  const root = document.documentElement;
  const theme = s.appearance.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.appearance.theme;
  root.dataset.theme = theme;
  const hl = theme === 'dark' ? s.appearance.highlightsDark : s.appearance.highlightsLight;
  root.style.setProperty('--hl-unknown', hl.unknown);
  root.style.setProperty('--hl-learning', hl.learning);
  root.style.setProperty('--hl-sentence', hl.sentence);
  root.style.setProperty('--hl-word', hl.word);
  root.style.setProperty('--hl-marked', hl.marked);
  root.style.setProperty('--reader-font', `var(--font-${s.appearance.fontFamily})`);
  root.style.setProperty('--reader-size', `${s.appearance.fontSizePx}px`);
  root.style.setProperty('--reader-lh', String(s.appearance.lineHeight));
  root.style.setProperty('--reader-margin', `${s.appearance.marginPx}px`);
  root.dataset.underlineOnly = s.appearance.underlineOnly ? '1' : '0';
}
