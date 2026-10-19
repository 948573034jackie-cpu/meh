import React, { useEffect } from 'react';
import { useApp, applyAppearance } from './state/store';
import { Library } from './views/Library';
import { SettingsView } from './views/Settings';
import { DiagnosticsView } from './views/Diagnostics';
import { ReaderView } from './reader/ReaderView';
import { Vocabulary } from './views/Vocabulary';
import { Progress } from './views/Progress';
import { LevelTest } from './views/LevelTest';
import { Tip } from './ui/Tip';

export function App(): JSX.Element {
  const view = useApp((s) => s.view);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);
  const book = useApp((s) => s.book);

  useEffect(() => {
    (async () => {
      const [settings, vocab] = await Promise.all([window.readalong.getSettings(), window.readalong.getVocab()]);
      useApp.getState().setSettings(settings);
      useApp.getState().setVocab(vocab);
      await useApp.getState().refreshLibrary();
      // first start: find the learner's level, then the settings tour
      if (!settings.onboarded) useApp.getState().setView(settings.level.testedAt ? 'settings' : 'leveltest');
    })();
    const off = window.readalong.onMenu((action) => {
      const st = useApp.getState();
      if (action === 'settings') st.setView('settings');
      else if (action === 'library') st.setView('library');
      else if (action === 'diagnostics') st.setView('diagnostics');
      else if (action === 'vocabulary') st.setView('vocabulary');
      else if (action === 'progress') st.setView('progress');
      else if (action === 'open') void Library.openDialog();
      else if (action === 'paste') Library.openPaste();
      else if (action === 'fontUp' || action === 'fontDown') {
        const size = Math.min(34, Math.max(12, st.settings.appearance.fontSizePx + (action === 'fontUp' ? 2 : -2)));
        void st.patchSettings({ appearance: { ...st.settings.appearance, fontSizePx: size } });
      } else if (action === 'theme') {
        const order = ['night', 'sepia', 'light', 'grey'] as const;
        const next = order[(order.indexOf(st.settings.appearance.theme as never) + 1) % order.length];
        void st.patchSettings({ appearance: { ...st.settings.appearance, theme: next } });
      } else if (action === 'band') {
        // the old subtitle band is now the Listening screen
        if (st.view === 'reader' && st.book) st.setMode(st.mode === 'reading' ? 'listening' : 'reading');
      } else window.dispatchEvent(new CustomEvent('readalong:menu', { detail: action }));
    });
    return off;
  }, []);

  useEffect(() => { applyAppearance(settings); }, [settings]);

  // The reader fills the whole window and draws its own slim bars (the traffic-light drag region included).
  const reader = view === 'reader' && book;

  return (
    <div className="app">
      {!reader && (
        <div className="titlebar drag">
          <span className="title app-name">Dream Read</span>
          <div className="row no-drag">
            {view !== 'library' && <Tip text="Your books (Cmd+L)" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('library')}>Library</button></Tip>}
            {book && <Tip text="Back to where you stopped" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('reader')}>Continue reading</button></Tip>}
            {view !== 'vocabulary' && <Tip text="Every word you asked about, with its sentence and meaning" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('vocabulary')} data-testid="nav-vocabulary">My Vocabulary</button></Tip>}
            {view !== 'progress' && <Tip text="Known and unknown words for each level" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('progress')} data-testid="nav-progress">Progress</button></Tip>}
            {view !== 'settings' && <Tip text="Look, voice, AI and level (Cmd+,)" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('settings')}>Settings</button></Tip>}
          </div>
        </div>
      )}
      <div className="content">
        {view === 'library' && <Library />}
        {reader && <ReaderView key={book.id} book={book} />}
        {view === 'settings' && <SettingsView />}
        {view === 'diagnostics' && <DiagnosticsView />}
        {view === 'vocabulary' && <Vocabulary />}
        {view === 'progress' && <Progress />}
        {view === 'leveltest' && <LevelTest onDone={() => useApp.getState().setView(useApp.getState().book ? 'reader' : 'settings')} />}
        {toast && (
          <div className="toast" role="status">
            <span>{toast.text}</span>
            {toast.action && <button onClick={() => { toast.action!.run(); useApp.setState({ toast: null }); }}>{toast.action.label}</button>}
          </div>
        )}
      </div>
    </div>
  );
}
