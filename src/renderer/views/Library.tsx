import React, { useEffect, useState } from 'react';
import { useApp } from '../state/store';
import type { LibraryItem } from '@shared/settings';
import { Tip } from '../ui/Tip';
import { loadDictionaryWhenIdle } from '../reader/useDictionary';

let setPasteOpen: ((v: boolean) => void) | null = null;

/** Up to two initials from the title, skipping leading articles: "The Great Gatsby" → "GG". */
export function coverInitials(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !/^(the|a|an|of|and|le|la|les|der|die|das)$/i.test(w));
  const pick = (meaningful.length ? meaningful : words).slice(0, 2);
  return pick.map((w) => w[0]!.toUpperCase()).join('') || '·';
}

/** A stable soft tint per title so each cover looks different but stays calm: hue from a string hash. */
export function coverHue(title: string): number {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function Cover({ item }: { item: LibraryItem }): JSX.Element {
  const hue = coverHue(item.title);
  const style = { background: `linear-gradient(160deg, hsl(${hue} 22% 42%), hsl(${(hue + 30) % 360} 26% 26%))` } as React.CSSProperties;
  return (
    <div className="book-cover" style={style} aria-hidden="true">
      <span className="initials">{coverInitials(item.title)}</span>
      <span className="cover-kind">{item.kind.toUpperCase()}</span>
      <span className="cover-title">{item.title}</span>
    </div>
  );
}

function Ring({ percent }: { percent: number }): JSX.Element {
  const r = 7, c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="track" cx="9" cy="9" r={r} />
      <circle className="fill" cx="9" cy="9" r={r} strokeDasharray={`${c * Math.min(1, Math.max(0, percent / 100))} ${c}`} />
    </svg>
  );
}

export function Library(): JSX.Element {
  const library = useApp((s) => s.library);
  const [pasteOpen, _setPasteOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  setPasteOpen = _setPasteOpen;
  useEffect(() => { void useApp.getState().refreshLibrary(); }, []);
  // the dictionary loads while the learner looks at the library, so the first book opens without waiting for it
  useEffect(() => loadDictionaryWhenIdle(), []);

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

  const [dragOver, setDragOver] = useState(false);
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.(epub|pdf|txt|md)$/i.test(f.name));
    if (!files.length) return;
    setBusy(true);
    try {
      let last = null;
      for (const f of files) last = await window.readalong.importFile(window.readalong.pathForFile(f));
      await useApp.getState().refreshLibrary();
      if (last && files.length === 1) { useApp.getState().setBook(last); useApp.getState().setView('reader'); }
    } catch (err) { useApp.getState().showToast(`Could not import: ${(err as Error).message}`); }
    finally { setBusy(false); }
  };
  const sorted = [...library].sort((a, b) => (b.lastOpenedAt || b.addedAt).localeCompare(a.lastOpenedAt || a.addedAt));
  return (
    <div className={`library ${dragOver ? 'drag-over' : ''}`} data-testid="library" onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
      <h1>Your books</h1>
      <p className="lead">{library.length === 0 ? 'A quiet place for the books you are reading.' : `${library.length} ${library.length === 1 ? 'book' : 'books'} · drop a file anywhere to add one`}</p>
      <div className="actions">
        <Tip text="Choose an EPUB, PDF or text file from your Mac" below align="start"><button className="primary" onClick={() => Library.openDialog()} data-testid="open-book">Open a book…</button></Tip>
        <Tip text="Paste an article or a chapter and read it like a book" below align="start"><button onClick={() => _setPasteOpen(true)} data-testid="paste-text">Paste text…</button></Tip>
        {busy && <span className="muted">Importing…</span>}
      </div>
      {library.length === 0 && !busy && (
        <div className="empty">
          <svg className="glyph" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M28 16c-4-4-10-5-18-4v30c8-1 14 0 18 4 4-4 10-5 18-4V12c-8-1-14 0-18 4Z" /><path d="M28 16v30" />
          </svg>
          <p>Drop an EPUB, PDF or text file here, or open one above, and Dream Read will read it to you.</p>
        </div>
      )}
      <div className="grid">
        {sorted.map((it) => {
          const pct = Math.max(0, Math.min(100, it.percent));
          return (
            <div className="book-card" key={it.id} onClick={() => useApp.getState().openBook(it.id)} data-testid="book-card" role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') void useApp.getState().openBook(it.id); }}>
              <Cover item={it} />
              <div className="t">{it.title}</div>
              <div className="m">{it.author ? `${it.author} · ` : ''}{it.words.toLocaleString()} words</div>
              <div className="progress"><Ring percent={pct} /><span>{pct > 0 ? `${Math.round(pct)}% read` : 'Not started'}</span></div>
              <div className="bar"><i style={{ width: `${pct}%` }} /></div>
              <div className="foot">
                <button className="primary" onClick={(e) => { e.stopPropagation(); void useApp.getState().openBook(it.id); }} data-testid="continue-book">{pct > 0 ? 'Continue' : 'Start'}</button>
                <button className="quiet remove" onClick={async (e) => { e.stopPropagation(); if (confirm(`Remove “${it.title}” from the library?`)) { await window.readalong.removeBook(it.id); await useApp.getState().refreshLibrary(); } }}>Remove</button>
              </div>
            </div>
          );
        })}
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
