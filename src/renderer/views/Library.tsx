import React, { useState } from 'react';
import { useApp } from '../state/store';

let setPasteOpen: ((v: boolean) => void) | null = null;

export function Library(): JSX.Element {
  const library = useApp((s) => s.library);
  const [pasteOpen, _setPasteOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  setPasteOpen = _setPasteOpen;

  const importPaste = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const book = await window.readalong.importText(title.trim(), text);
      await useApp.getState().refreshLibrary();
      useApp.getState().setBook(book);
      useApp.getState().setView('reader');
      _setPasteOpen(false); setText(''); setTitle('');
    } catch (e) {
      useApp.getState().showToast(`Could not import: ${(e as Error).message}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="library" data-testid="library">
      <h1>Your books</h1>
      <div className="actions">
        <button className="primary" onClick={() => Library.openDialog()} data-testid="open-book">Open EPUB / PDF / text…</button>
        <button onClick={() => _setPasteOpen(true)} data-testid="paste-text">Paste text…</button>
      </div>
      {library.length === 0 && <div className="empty">No books yet. Open an EPUB or PDF, or paste some text.</div>}
      <div className="grid">
        {library.map((it) => (
          <div className="book-card" key={it.id} onClick={() => useApp.getState().openBook(it.id)} data-testid="book-card">
            <div className="t">{it.title}</div>
            <div className="m">{it.author ? `${it.author} · ` : ''}{it.kind.toUpperCase()} · {it.words.toLocaleString()} words</div>
            <div className="m">{it.percent > 0 ? `${Math.round(it.percent)}% read` : 'Not started'}</div>
            <div className="bar"><i style={{ width: `${it.percent}%` }} /></div>
            <div className="row end"><button className="small" onClick={async (e) => { e.stopPropagation(); if (confirm(`Remove “${it.title}” from the library?`)) { await window.readalong.removeBook(it.id); await useApp.getState().refreshLibrary(); } }}>Remove</button></div>
          </div>
        ))}
      </div>
      {pasteOpen && (
        <div className="modal-backdrop" onClick={() => _setPasteOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Paste text</h2>
            <input type="text" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="paste-title" />
            <textarea style={{ minHeight: 260 }} placeholder="Paste an article, a chapter, anything in English…" value={text} onChange={(e) => setText(e.target.value)} data-testid="paste-body" />
            <div className="row end">
              <button onClick={() => _setPasteOpen(false)}>Cancel</button>
              <button className="primary" disabled={busy || !text.trim()} onClick={importPaste} data-testid="paste-import">Add to library</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

Library.openDialog = async function openDialog(): Promise<void> {
  try {
    const book = await window.readalong.importBookDialog();
    if (!book) return;
    await useApp.getState().refreshLibrary();
    useApp.getState().setBook(book);
    useApp.getState().setView('reader');
  } catch (e) {
    useApp.getState().showToast(`Could not open: ${(e as Error).message}`);
  }
};
Library.openPaste = function openPaste(): void { useApp.getState().setView('library'); setPasteOpen?.(true); };
