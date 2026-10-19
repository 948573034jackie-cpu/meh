import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { useLevelMaterials } from '../state/useDictData';
import { Tip } from '../ui/Tip';
import type { CefrLevel } from '@core/model';
import type { LevelResult } from '@core/level/score';
import type { LevelTestSession, TestItem } from '@core/level/test';
import { createSession } from '@core/level/test';
import { LevelModel } from '@core/level/adapt';
import type { LevelSettings } from '@shared/settings';
import {
  INTRO_LINES, INTRO_TITLE, LEVEL_TEST_VIEW_ID, answerForKey, changeText, levelMessage, progressText, stageText,
} from './levelText';

export { LEVEL_TEST_VIEW_ID };
export * from './levelText';

/**
 * The vocabulary level test screen: intro card, one word at a time (two stages of 50), result card.
 * Shown at first start and from Settings → Level. Routing: the app shows it for view === LEVEL_TEST_VIEW_ID.
 *
 * `onDone` is called when the learner leaves the screen: 'used' after "Use this level" (settings saved),
 * 'kept' after "Keep my old level", 'skipped' after "Skip for now" on the intro card.
 */
export type LevelTestOutcome = 'used' | 'kept' | 'skipped';

export interface LevelTestProps {
  onDone?: (outcome: LevelTestOutcome) => void;
}

type Phase = 'intro' | 'test' | 'between' | 'result';

export function LevelTest({ onDone }: LevelTestProps): JSX.Element {
  const settings = useApp((s) => s.settings);
  const patch = useApp((s) => s.patchSettings);
  const { materials, error } = useLevelMaterials();
  const [phase, setPhase] = useState<Phase>('intro');
  const [session, setSession] = useState<LevelTestSession | null>(null);
  const [items, setItems] = useState<TestItem[]>([]);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<LevelResult | null>(null);
  /** words of this run's sessions (a "Test again" avoids them too) */
  const usedRef = useRef<{ words: string[]; pseudowords: string[] }>({ words: [], pseudowords: [] });
  const previousLevel: CefrLevel | null = settings.onboarded ? settings.learnerLevel : null;

  // Start a session as soon as the learner pressed Start and the materials are ready.
  useEffect(() => {
    if (phase !== 'test' || session || !materials) return;
    const prev = settings.level?.used ?? { words: [], pseudowords: [] };
    const s = createSession(materials, {
      seed: `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      previous: { words: [...prev.words, ...usedRef.current.words], pseudowords: [...prev.pseudowords, ...usedRef.current.pseudowords] },
    });
    setSession(s);
    setItems(s.items());
    setIndex(0);
  }, [phase, session, materials, settings.level]);

  const start = useCallback(() => { setSession(null); setResult(null); setPhase('test'); }, []);

  const finish = useCallback((s: LevelTestSession) => {
    usedRef.current = {
      words: [...usedRef.current.words, ...s.usedWords()],
      pseudowords: [...usedRef.current.pseudowords, ...s.usedPseudowords()],
    };
    setResult(s.result());
    setPhase('result');
  }, []);

  const answer = useCallback((yes: boolean) => {
    if (!session || phase !== 'test') return;
    const item = items[index];
    if (!item) return;
    session.answer(item.id, yes);
    if (index + 1 < items.length) { setIndex(index + 1); return; }
    if (!session.stageComplete()) return;
    if (session.stage === 1) setPhase('between'); else finish(session);
  }, [session, phase, items, index, finish]);

  const continueStage = useCallback(() => {
    if (!session || session.stage !== 1) return;
    setItems(session.nextStage());
    setIndex(0);
    setPhase('test');
  }, [session]);

  // Keyboard: Y / J / → = Yes, N / K / ← = No, Enter = continue between stages. Space is not used on purpose.
  useEffect(() => {
    if (phase !== 'test' && phase !== 'between') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (phase === 'between') { if (e.code === 'Enter') { e.preventDefault(); continueStage(); } return; }
      const a = answerForKey(e.code);
      if (a === null) return;
      e.preventDefault();
      answer(a);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, answer, continueStage]);

  const useLevel = useCallback(async () => {
    if (!result) return;
    const testedAt = new Date().toISOString();
    const prev = settings.level?.used ?? { words: [], pseudowords: [] };
    const level: LevelSettings = {
      model: LevelModel.fromTest(result, testedAt).toJSON(),
      lastResult: result,
      testedAt,
      used: {
        words: [...new Set([...prev.words, ...usedRef.current.words])],
        pseudowords: [...new Set([...prev.pseudowords, ...usedRef.current.pseudowords])],
      },
    };
    await patch({ learnerLevel: result.cefr, onboarded: true, level });
    onDone?.('used');
  }, [result, settings.level, patch, onDone]);

  const message = useMemo(() => (result ? levelMessage(result) : null), [result]);
  const change = useMemo(() => (result ? changeText(result, previousLevel) : null), [result, previousLevel]);

  return (
    <div className="level-test" data-testid="level-test">
      {phase === 'intro' && (
        <div className="card level-card" data-testid="level-intro">
          <h2>{INTRO_TITLE}</h2>
          {INTRO_LINES.map((line, i) => <p key={i} className="level-intro-line">{line}</p>)}
          <div className="row level-actions">
            <Tip text="Begin the test (about 5 minutes)"><button className="primary" onClick={start} data-testid="level-start" autoFocus>Start</button></Tip>
            <Tip text={`Keep your level at ${settings.learnerLevel} for now. You can take the test later in Settings → Level.`} wrap>
              <button onClick={() => onDone?.('skipped')} data-testid="level-skip">Skip for now</button>
            </Tip>
          </div>
        </div>
      )}

      {phase === 'test' && (!session || !items[index]) && (
        <div className="card level-card level-preparing" data-testid="level-preparing">
          {error
            ? <p className="level-intro-line">Sorry, the dictionary could not be loaded, so the test cannot start. Please restart the app and try again.</p>
            : <p className="level-intro-line muted">Preparing the test…</p>}
          {error && <div className="row level-actions"><button onClick={() => onDone?.('skipped')}>Back</button></div>}
        </div>
      )}

      {phase === 'test' && session && items[index] && (
        <div className="level-stage" data-testid="level-stage" data-stage={session.stage}>
          <div className="level-meta">
            <span className="muted" data-testid="level-stage-text">{stageText(session.stage)}</span>
            <span className="muted" data-testid="level-progress">{progressText(index, items.length)}</span>
          </div>
          <div className="level-progress-bar" aria-hidden="true"><div className="level-progress-fill" style={{ width: `${(index / items.length) * 100}%` }} /></div>
          <p className="level-question muted">Do you know this word?</p>
          <div className="level-word" data-testid="level-word" key={items[index].id}>{items[index].word}</div>
          <div className="level-answers">
            <Tip text="I do not know it, or I am not sure (N, K or ←)"><button className="level-answer no" onClick={() => answer(false)} data-testid="level-no">No</button></Tip>
            <Tip text="I know what it means (Y, J or →)"><button className="level-answer yes primary" onClick={() => answer(true)} data-testid="level-yes">Yes, I know it</button></Tip>
          </div>
          <p className="level-keys muted">Keys: Y or → for Yes, N or ← for No</p>
        </div>
      )}

      {phase === 'between' && (
        <div className="card level-card" data-testid="level-between">
          <h2>Well done, halfway there</h2>
          <p className="level-intro-line">{stageText(2)}: 50 more words, chosen for you from the first half.</p>
          <div className="row level-actions">
            <Tip text="Show the next words (Enter)"><button className="primary" onClick={continueStage} data-testid="level-continue" autoFocus>Continue</button></Tip>
          </div>
        </div>
      )}

      {phase === 'result' && result && message && (
        <div className="card level-card level-result" data-testid="level-result" data-reliable={message.reliable ? '1' : '0'} data-level={result.cefr}>
          {message.reliable
            ? <>
                <div className="level-result-level" data-testid="level-result-level">{result.cefr}</div>
                <h2>{message.title}</h2>
                <p className="level-result-sub muted">{message.subtitle}</p>
                <p className="level-intro-line">{message.body}</p>
                {change && <p className="level-intro-line muted">{change}</p>}
              </>
            : <>
                <h2>{message.title}</h2>
                <p className="level-result-sub muted">{message.subtitle}</p>
                <p className="level-intro-line">{message.body}</p>
              </>}
          <div className="row level-actions">
            {message.reliable && (
              <Tip text={`Set my level to ${result.cefr} and highlight words above it`} wrap>
                <button className="primary" onClick={() => { void useLevel(); }} data-testid="level-use" autoFocus>Use this level</button>
              </Tip>
            )}
            <Tip text="Take the test again with new words"><button className={message.reliable ? '' : 'primary'} onClick={start} data-testid="level-again" autoFocus={!message.reliable}>Test again</button></Tip>
            <Tip text={`Keep my level at ${settings.learnerLevel}`}><button onClick={() => onDone?.('kept')} data-testid="level-keep">Keep my old level</button></Tip>
          </div>
        </div>
      )}
    </div>
  );
}
