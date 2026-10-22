import React, { useEffect, useMemo, useState } from 'react';
import type { CefrLevel } from '@core/model';
import type { VocabProgress, LevelProgress, UnknownWord } from '@shared/api';
import { useApp } from '../state/store';
import { Tip } from '../ui/Tip';
import { sayWord } from './Vocabulary';

const PAGE = 100;

/** Widths (in %) of the three segments of a level bar; an empty level shows nothing. */
export function barSegments(p: Pick<LevelProgress, 'known' | 'learning' | 'unknown'>): { known: number; learning: number; unknown: number } {
  const sum = p.known + p.learning + p.unknown;
  if (sum === 0) return { known: 0, learning: 0, unknown: 0 };
  return { known: (p.known / sum) * 100, learning: (p.learning / sum) * 100, unknown: (p.unknown / sum) * 100 };
}

const LEVEL_NAMES: Record<CefrLevel, string> = { A1: 'Beginner', A2: 'Elementary', B1: 'Intermediate', B2: 'Upper intermediate', C1: 'Advanced', C2: 'Mastery' };

function LevelCard({ p, active, onClick }: { p: LevelProgress; active: boolean; onClick: () => void }): JSX.Element {
  const seg = barSegments(p);
  const pct = p.total ? Math.round((p.known / p.total) * 100) : 0;
  return (
    <button className={`level-card ${active ? 'active' : ''}`} onClick={onClick} aria-pressed={active} data-testid={`level-card-${p.level}`}>
      <div className="top"><span className="lvl">{p.level}</span><span className="name">{LEVEL_NAMES[p.level]}</span></div>
      <div className="pct">{pct}%<span className="of"> known</span></div>
      <div className="stack" aria-hidden="true">
        <i className="known" style={{ width: `${seg.known}%` }} /><i className="learning" style={{ width: `${seg.learning}%` }} /><i className="unknown" style={{ width: `${seg.unknown}%` }} />
      </div>
      <div className="nums"><span><b>{p.known}</b> known</span><span><b>{p.learning}</b> learning</span><span><b>{p.unknown}</b> to learn</span></div>
    </button>
  );
}

export function Progress(): JSX.Element {
  const [progress, setProgress] = useState<VocabProgress | null>(null);
  const [level, setLevel] = useState<CefrLevel | null>(null);
  const [words, setWords] = useState<UnknownWord[] | null>(null);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);

  const reloadProgress = async () => { try { setProgress(await window.readalong.vocabProgress()); } catch (e) { useApp.getState().showToast(`Could not load progress: ${(e as Error).message}`); } };
  useEffect(() => { void reloadProgress(); }, []);
  useEffect(() => {
    if (!level) { setWords(null); return; }
    let alive = true;
    setWords(null); setLimit(PAGE); setQ('');
    window.readalong.vocabUnknownAtLevel(level).then((w) => { if (alive) setWords(w); }).catch(() => { if (alive) setWords([]); });
    return () => { alive = false; };
  }, [level]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? (words ?? []).filter((w) => w.word.includes(needle) || w.zh.includes(needle)) : (words ?? []);
    return list;
  }, [words, q]);

  const markKnown = async (w: UnknownWord) => {
    setBusy(w.word);
    try {
      await window.readalong.setWordStatus(w.word, 'known');
      setWords((ws) => (ws ?? []).filter((x) => x.word !== w.word));
      setProgress((p) => p ? { ...p, levels: p.levels.map((l) => (l.level === w.level ? { ...l, known: l.known + 1, unknown: Math.max(0, l.unknown - 1) } : l)), totals: { ...p.totals, known: p.totals.known + 1, unknown: Math.max(0, p.totals.unknown - 1) } } : p);
      try { useApp.getState().setVocab(await window.readalong.getVocab()); } catch { /* main not ready */ }
    } catch (e) { useApp.getState().showToast(`Could not save: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const t = progress?.totals;
  return (
    <div className="progress-view" data-testid="progress">
      <h1>Progress</h1>
      <p className="lead">How far your English vocabulary has come, level by level.</p>
      <div className="stats" data-testid="progress-stats">
        <div className="stat"><div className="n">{t ? t.known.toLocaleString() : '–'}</div><div className="l">words known</div></div>
        <div className="stat"><div className="n">{progress ? progress.learnedThisWeek : '–'}</div><div className="l">new this week</div></div>
        <div className="stat"><div className="n">{progress ? progress.streakDays : '–'}</div><div className="l">{progress?.streakDays === 1 ? 'day in a row' : 'days in a row'}</div></div>
        <div className="stat"><div className="n">{t ? t.learning.toLocaleString() : '–'}</div><div className="l">learning</div></div>
      </div>
      {progress === null && <p className="muted">Counting…</p>}
      {progress && (
        <div className="level-row">
          {progress.levels.map((p) => <LevelCard key={p.level} p={p} active={level === p.level} onClick={() => setLevel(level === p.level ? null : p.level)} />)}
        </div>
      )}
      {progress && <p className="legend muted"><i className="known" /> known <i className="learning" /> learning <i className="unknown" /> to learn · tap a level to see the words you have not met yet</p>}

      {level && (
        <div className="unknown-panel" data-testid="unknown-panel">
          <div className="row">
            <h2>{level} words to learn</h2>
            <span className="muted">{words ? `${shown.length.toLocaleString()} ${shown.length === 1 ? 'word' : 'words'}, most common first` : 'Loading…'}</span>
            <span className="spacer" />
            <input type="text" className="search" placeholder="Find a word…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a word" />
            <button className="quiet" onClick={() => setLevel(null)}>Close</button>
          </div>
          {words && shown.length === 0 && <div className="empty"><p>{q ? 'No words match.' : `You know every ${level} word in the dictionary. Well done.`}</p></div>}
          {shown.length > 0 && (
            <div className="unknown-list" role="list">
              {shown.slice(0, limit).map((w) => (
                <div className="unknown-row" key={w.word} role="listitem" data-testid="unknown-row">
                  <span className="word">{w.word}</span>
                  <span className="ipa muted">{w.ipa}</span>
                  <span className="zh">{w.zh}</span>
                  <span className="acts">
                    <Tip text="Hear it" align="end"><button className="quiet" onClick={() => void sayWord(w.word)}>Say it</button></Tip>
                    <button disabled={busy === w.word} onClick={() => void markKnown(w)} data-testid="mark-known">I know it</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {shown.length > limit && <div className="row center"><button onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, shown.length - limit)} more</button></div>}
        </div>
      )}
    </div>
  );
}
