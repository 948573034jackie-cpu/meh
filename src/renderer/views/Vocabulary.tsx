import React, { useEffect, useMemo, useState } from 'react';
import type { CefrLevel } from '@core/model';
import { CEFR_LEVELS } from '@core/model';
import type { VocabEntry, VocabEntryStatus } from '@shared/api';
import { getEngine, defaultVoiceFor } from '@core/tts/registry';
import { useApp } from '../state/store';
import { Tip } from '../ui/Tip';

/** The two vocabulary screens; app.tsx adds them to its routing under these ids. */
export const VOCAB_VIEW_IDS = ['vocabulary', 'progress'] as const;
export type VocabViewId = (typeof VOCAB_VIEW_IDS)[number];

type StatusFilter = 'learning' | 'known' | 'all';

/** "Oct 3" this year, "Oct 3, 2025" otherwise. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

/** Entries matching the search box (word, Chinese, sentence or explanation) and the chips. */
export function filterEntries(entries: VocabEntry[], q: string, status: StatusFilter, bookId: string | null, level: CefrLevel | null): VocabEntry[] {
  const needle = q.trim().toLowerCase();
  return entries.filter((e) => {
    if (status !== 'all' && e.status !== status) return false;
    if (bookId && e.bookId !== bookId) return false;
    if (level && e.level !== level) return false;
    if (!needle) return true;
    return [e.word, e.lemma, e.chinese, e.sentence, e.explanation].some((s) => (s ?? '').toLowerCase().includes(needle));
  });
}

/** Speaks a word with the reading voice from Settings (falls back to the engine's default voice). */
export async function sayWord(text: string): Promise<void> {
  const { voice } = useApp.getState().settings;
  try {
    const engine = getEngine(voice.engine);
    const voiceId = voice.voiceId || (await defaultVoiceFor(voice.engine));
    engine.cancelAll();
    engine.speak(text, { voiceId, rate: Math.min(voice.rate, 1) });
  } catch (e) {
    useApp.getState().showToast(`Could not speak: ${(e as Error).message}`);
  }
}

async function syncHighlightMap(): Promise<void> {
  try { useApp.getState().setVocab(await window.readalong.getVocab()); } catch { /* main not ready */ }
}

export function LevelPill({ level }: { level?: CefrLevel }): JSX.Element | null {
  if (!level) return null;
  return <span className={`level-pill l-${level.toLowerCase()}`}>{level}</span>;
}

function Row({ e, open, onToggle, onChange }: { e: VocabEntry; open: boolean; onToggle: () => void; onChange: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await syncHighlightMap(); onChange(); } catch (err) { useApp.getState().showToast((err as Error).message); } finally { setBusy(false); }
  };
  const setStatus = (status: VocabEntryStatus) => act(() => window.readalong.vocabSetEntryStatus(e.lemma, status));
  const remove = () => act(async () => { if (confirm(`Remove “${e.word}” from your vocabulary?`)) await window.readalong.vocabDeleteEntry(e.lemma); });
  return (
    <div className={`vocab-row ${open ? 'open' : ''} ${e.status}`} data-testid="vocab-row" data-lemma={e.lemma}>
      <div className="head" role="button" tabIndex={0} onClick={onToggle} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle(); } }} aria-expanded={open}>
        <span className="word">{e.word || e.lemma}</span>
        <span className="zh">{e.chinese}</span>
        <LevelPill level={e.level} />
        <span className="book" title={e.chapter ? `${e.bookTitle} · ${e.chapter}` : e.bookTitle}>{e.bookTitle}</span>
        <span className="date">{shortDate(e.createdAt)}</span>
        <span className={`status-dot ${e.status}`} title={e.status === 'known' ? 'Known' : 'Learning'} aria-label={e.status} />
      </div>
      {open && (
        <div className="body">
          {e.sentence && <p className="sentence">“{e.sentence}”</p>}
          {e.explanation ? <p className="explanation">{e.explanation}</p> : <p className="explanation muted">No explanation saved yet.</p>}
          <div className="meta muted">
            {e.chapter ? `${e.bookTitle} · ${e.chapter}` : e.bookTitle}
            {e.timesExplained > 1 ? ` · explained ${e.timesExplained} times` : ''}
            {e.again > 0 ? ` · “I don't know” ${e.again}×` : ''}
            {` · last seen ${shortDate(e.lastSeenAt)}`}
          </div>
          <div className="row actions">
            <Tip text="Hear the word in your reading voice" below align="start"><button onClick={() => void sayWord(e.word || e.lemma)} data-testid="vocab-say">Say it</button></Tip>
            {e.status === 'learning'
              ? <button className="primary" disabled={busy} onClick={() => void setStatus('known')} data-testid="vocab-known">Move to Known</button>
              : <button disabled={busy} onClick={() => void setStatus('learning')} data-testid="vocab-learning">Back to Learning</button>}
            <button className="quiet danger" disabled={busy} onClick={() => void remove()} data-testid="vocab-delete">Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Vocabulary(): JSX.Element {
  const [entries, setEntries] = useState<VocabEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('learning');
  const [bookId, setBookId] = useState<string | null>(null);
  const [level, setLevel] = useState<CefrLevel | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [csvPath, setCsvPath] = useState('');
  const [exporting, setExporting] = useState(false);

  const reload = async () => { try { setEntries(await window.readalong.vocabEntries()); } catch { setEntries([]); } };
  useEffect(() => { void reload(); window.readalong.vocabCsvPath().then(setCsvPath).catch(() => setCsvPath('')); }, []);

  const books = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries ?? []) if (e.bookId && !m.has(e.bookId)) m.set(e.bookId, e.bookTitle || 'Untitled');
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);
  const levels = useMemo(() => CEFR_LEVELS.filter((l) => (entries ?? []).some((e) => e.level === l)), [entries]);
  const shown = useMemo(() => filterEntries(entries ?? [], q, status, bookId, level), [entries, q, status, bookId, level]);
  const counts = useMemo(() => ({ learning: (entries ?? []).filter((e) => e.status === 'learning').length, known: (entries ?? []).filter((e) => e.status === 'known').length }), [entries]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const file = await window.readalong.vocabExportCsv();
      setCsvPath(file);
      useApp.getState().showToast(`Saved ${file}`);
    } catch (e) { useApp.getState().showToast(`Could not export: ${(e as Error).message}`); }
    finally { setExporting(false); }
  };

  const total = entries?.length ?? 0;
  return (
    <div className="vocab" data-testid="vocabulary">
      <h1>My vocabulary</h1>
      <p className="lead">{total === 0 ? 'Words you have explained will be collected here.' : `${total} ${total === 1 ? 'word' : 'words'} · ${counts.learning} learning · ${counts.known} known`}</p>
      <div className="toolbar">
        <input type="text" className="search" placeholder="Search a word, a meaning or a sentence…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="vocab-search" aria-label="Search" />
        <div className="chips" role="tablist" aria-label="Status">
          {([['learning', `Learning${counts.learning ? ` ${counts.learning}` : ''}`], ['known', `Known${counts.known ? ` ${counts.known}` : ''}`], ['all', 'All']] as [StatusFilter, string][]).map(([id, label]) => (
            <button key={id} className={`chip ${status === id ? 'active' : ''}`} onClick={() => setStatus(id)} role="tab" aria-selected={status === id} data-testid={`vocab-filter-${id}`}>{label}</button>
          ))}
        </div>
        {books.length > 1 && (
          <select value={bookId ?? ''} onChange={(e) => setBookId(e.target.value || null)} aria-label="Book" data-testid="vocab-book">
            <option value="">All books</option>
            {books.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </select>
        )}
        {levels.length > 1 && (
          <div className="chips" role="tablist" aria-label="Level">
            <button className={`chip ${level === null ? 'active' : ''}`} onClick={() => setLevel(null)}>Any level</button>
            {levels.map((l) => <button key={l} className={`chip ${level === l ? 'active' : ''}`} onClick={() => setLevel(level === l ? null : l)}>{l}</button>)}
          </div>
        )}
        <span className="spacer" />
        <Tip text="Writes a spreadsheet file you can open in Excel or Numbers" below align="end">
          <button onClick={() => void exportCsv()} disabled={exporting || total === 0} data-testid="vocab-export">Export CSV</button>
        </Tip>
      </div>
      {csvPath && total > 0 && <p className="csv-path muted" data-testid="vocab-csv-path">Kept up to date in <span className="path">{csvPath}</span></p>}

      {entries === null && <p className="muted">Loading…</p>}
      {entries !== null && total === 0 && (
        <div className="empty">
          <svg className="glyph" viewBox="0 0 56 56" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="10" y="12" width="36" height="32" rx="4" /><path d="M18 22h20M18 29h20M18 36h12" />
          </svg>
          <p>This list is empty for now. When you read or listen to a book and a word is explained, it is saved here with its sentence and its meaning.</p>
        </div>
      )}
      {entries !== null && total > 0 && shown.length === 0 && <div className="empty"><p>No words match. Try another word or another filter.</p></div>}
      {shown.length > 0 && (
        <div className="vocab-list" role="list">
          {shown.map((e) => <Row key={e.lemma} e={e} open={open === e.lemma} onToggle={() => setOpen(open === e.lemma ? null : e.lemma)} onChange={reload} />)}
        </div>
      )}
    </div>
  );
}
