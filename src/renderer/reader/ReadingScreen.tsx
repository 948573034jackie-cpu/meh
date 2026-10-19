import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Position } from '@core/model';
import type { Settings, ThemeId } from '@shared/settings';
import { useApp } from '../state/store';
import { Tip } from '../ui/Tip';
import type { ScreenShared } from './ReaderView';
import { keyOf } from './ReaderView';
import { bookPages, chapterMarks, fractionAt, nextProgressKind, positionAtWords, progressText, wordsLeft, type ProgressKind } from './progress';

export type ReadingPopover = 'aa' | 'goto' | null;

/** Chrome (the two bars) hides this long after the mouse last moved. */
const CHROME_HIDE_MS = 3000;

const THEMES: { id: ThemeId; name: string; bg: string; fg: string }[] = [
  { id: 'night', name: 'Night', bg: '#15171c', fg: '#d7d2c8' },
  { id: 'sepia', name: 'Sepia', bg: '#f4ecd8', fg: '#3b3328' },
  { id: 'light', name: 'Light', bg: '#faf9f6', fg: '#2a2a2e' },
  { id: 'grey', name: 'Grey', bg: '#2b2d31', fg: '#e0e0e0' },
];

interface Props { shared: ScreenShared; settings: Settings; popover: ReadingPopover; setPopover: (p: ReadingPopover) => void }

/**
 * Reading mode: Kindle-like pages. Tap zones (left fifth = back, right fifth = forward, middle = bars on/off),
 * bars that hide after 3 s without mouse movement, Aa and Go to popovers, a progress line with chapter ticks.
 */
export function ReadingScreen({ shared, settings, popover, setPopover }: Props): JSX.Element {
  const { book, index, chapter, position, playState, html, docRef, ensureRef, onRendered } = shared;
  const screenRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState({ index: 0, count: 1 });
  const pageRef = useRef(page); pageRef.current = page;
  const [chrome, setChrome] = useState(true);
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const overBars = useRef(false);
  const popoverRef = useRef(popover); popoverRef.current = popover;
  const [progressKind, setProgressKind] = useState<ProgressKind>('page');
  const [gotoPage, setGotoPage] = useState('');
  const pending = useRef<Position | null>(null);
  const pageStep = useRef({ w: 0, gap: 48 });
  const playing = playState === 'playing' || playState === 'explaining';

  // ---- layout: CSS columns, one column per page ------------------------------------------------------
  const layoutPages = useCallback(() => {
    const view = viewRef.current, pages = pagesRef.current;
    if (!view || !pages) return;
    const w = view.clientWidth, h = view.clientHeight, gap = Math.max(32, settings.appearance.marginPx);
    pageStep.current = { w, gap };
    pages.style.cssText = `width:${w}px;height:${h}px;column-width:${w}px;column-gap:${gap}px;`;
    const count = Math.max(1, Math.round((pages.scrollWidth + gap) / (w + gap)));
    setPage((p) => ({ index: Math.min(p.index, count - 1), count }));
  }, [settings.appearance.marginPx]);

  useLayoutEffect(() => {
    const pages = pagesRef.current; if (!pages) return;
    pages.innerHTML = html;
    docRef.current = pages;
    layoutPages();
    onRendered();
    return () => { if (docRef.current === pages) docRef.current = null; };
  }, [html, layoutPages, onRendered, docRef]);

  useEffect(() => {
    const view = viewRef.current; if (!view) return;
    const ro = new ResizeObserver(() => { layoutPages(); requestAnimationFrame(() => ensureVisible(pendingPosition(), true)); });
    ro.observe(view);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutPages, settings.appearance.fontSizePx, settings.appearance.lineHeight, settings.appearance.maxLineChars, settings.appearance.showHints]);
  useEffect(() => {
    const pages = pagesRef.current; if (!pages) return;
    pages.style.transform = `translateX(${-page.index * (pageStep.current.w + pageStep.current.gap)}px)`;
  }, [page]);

  const positionRef = useRef(position); positionRef.current = position;
  const pendingPosition = () => pending.current ?? positionRef.current;

  function pageOfSentence(pos: Position): number | null {
    const el = pagesRef.current?.querySelector(`.s[data-key="${keyOf(pos)}"]`);
    if (!el || !viewRef.current) return null;
    const rect = el.getClientRects()[0] ?? el.getBoundingClientRect();
    const viewRect = viewRef.current.getBoundingClientRect();
    const step = pageStep.current.w + pageStep.current.gap;
    const abs = rect.left - viewRect.left + pageRef.current.index * step;
    return Math.max(0, Math.floor((abs + 2) / step));
  }
  function ensureVisible(pos: Position, force = false): void {
    const target = pageOfSentence(pos);
    if (target === null) return;
    if (target !== pageRef.current.index || force) setPage((p) => ({ ...p, index: Math.min(target, p.count - 1) }));
  }
  useEffect(() => { ensureRef.current = ensureVisible; return () => { ensureRef.current = () => undefined; }; });

  // a Go to page/percent that lands in another chapter waits for that chapter to render
  useEffect(() => { const p = pending.current; if (p && p.chapter === chapter) { pending.current = null; requestAnimationFrame(() => ensureVisible(p, true)); } });

  // ---- pages: keys, tap zones, swipe -----------------------------------------------------------------
  const turn = useCallback((dir: 1 | -1) => {
    setPage((p) => {
      const next = Math.min(p.count - 1, Math.max(0, p.index + dir));
      if (next === p.index) {
        // past the chapter's last page: the next chapter (and its first page)
        const ch = chapter + dir;
        if (book.chapters[ch]) { pending.current = null; shared.goToChapter(ch); }
      }
      return { ...p, index: next };
    });
  }, [book, chapter, shared]);
  useEffect(() => {
    const onPage = (ev: Event) => turn((ev as CustomEvent).detail === 1 ? 1 : -1);
    window.addEventListener('reader:page', onPage);
    return () => window.removeEventListener('reader:page', onPage);
  }, [turn]);

  // when a page is turned past the current sentence (reading silently), the position follows the page
  useEffect(() => {
    const cur = pageOfSentence(positionRef.current);
    if (cur === null || cur === page.index || playing) return;
    const step = pageStep.current.w + pageStep.current.gap;
    const viewRect = viewRef.current?.getBoundingClientRect(); if (!viewRect) return;
    for (const el of pagesRef.current?.querySelectorAll<HTMLElement>('.s[data-key]') ?? []) {
      const r = el.getClientRects()[0]; if (!r) continue;
      const abs = r.left - viewRect.left + page.index * step;
      if (Math.floor((abs + 2) / step) === page.index) { const pos = shared.posOf(el); if (pos && keyOf(pos) !== keyOf(positionRef.current)) shared.seek(pos); break; }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.index]);

  const onViewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (popover) { setPopover(null); return; }
    const target = e.target as HTMLElement;
    const w = target.closest<HTMLElement>('.w');
    if (w?.dataset.lemma) { if (e.detail === 2) { e.preventDefault(); return; } shared.tapWord(w); return; }
    if (shared.closeOverlays()) return;
    const rect = viewRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (x < 0.2) { turn(-1); return; }
    if (x > 0.8) { turn(1); return; }
    const s = target.closest('.s');
    if (s && shared.tapSentence(s)) return;
    toggleChrome();
  };

  const swipe = useRef({ dx: 0, lock: 0 });
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const now = Date.now();
    if (now < swipe.current.lock) return;
    swipe.current.dx += e.deltaX;
    if (Math.abs(swipe.current.dx) > 60) { swipe.current.lock = now + 450; swipe.current.dx = 0; if (e.deltaX > 0) shared.next(); else shared.prev(); }
  };
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => { const s = touch.current; touch.current = null; if (!s) return; const t = e.changedTouches[0]; const dx = t.clientX - s.x, dy = t.clientY - s.y; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx < 0) shared.next(); else shared.prev(); } };

  // ---- chrome: bars that hide after 3 s of stillness --------------------------------------------------
  const armHide = useCallback(() => {
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(() => { if (!overBars.current && !popoverRef.current) setChrome(false); }, CHROME_HIDE_MS);
  }, []);
  const onMouseMove = useCallback(() => { setChrome(true); armHide(); }, [armHide]);
  const toggleChrome = () => { setChrome((v) => { if (!v) armHide(); else if (chromeTimer.current) clearTimeout(chromeTimer.current); return !v; }); };
  useEffect(() => { armHide(); return () => { if (chromeTimer.current) clearTimeout(chromeTimer.current); }; }, [armHide]);
  useEffect(() => { if (popover) { setChrome(true); if (chromeTimer.current) clearTimeout(chromeTimer.current); } else armHide(); }, [popover, armHide]);

  // ---- progress -----------------------------------------------------------------------------------------
  const pages = bookPages(index, chapter, page.index, page.count);
  const left = wordsLeft(index, position);
  const fraction = fractionAt(index, position);
  const status = progressText(progressKind, { page: pages.page, pageCount: pages.total, wordsLeftChapter: left.chapter, wordsLeftBook: left.book, wpm: shared.wpm, fraction });
  const marks = chapterMarks(index);
  const ch = book.chapters[chapter];

  const goToWords = (words: number) => { const pos = positionAtWords(index, words); if (!pos) return; pending.current = pos; shared.seek(pos); setPopover(null); };
  const setA = (patch: Partial<Settings['appearance']>) => void useApp.getState().patchSettings({ appearance: { ...settings.appearance, ...patch } });
  const bars = { onMouseEnter: () => { overBars.current = true; }, onMouseLeave: () => { overBars.current = false; armHide(); } };

  return (
    <div className={`screen reading ${chrome ? 'chrome-on' : 'chrome-off'} ${playing ? 'playing' : ''}`} ref={screenRef} onMouseMove={onMouseMove} data-testid="reading">
      <div className="traffic-drag drag" aria-hidden="true" />
      <header className="bar top drag" {...bars} onClick={(e) => e.stopPropagation()} data-testid="topbar">
        <div className="titles">
          <span className="book-title" title={book.title}>{book.title}</span>
          {ch && book.chapters.length > 1 && <span className="chapter-name" title={ch.title}>{ch.title}</span>}
        </div>
        <div className="row no-drag">
          <Tip text="Text size, spacing, theme and margins" below><button className={`quiet ${popover === 'aa' ? 'active' : ''}`} onClick={() => setPopover(popover === 'aa' ? null : 'aa')} data-testid="aa"><span className="aa">Aa</span></button></Tip>
          <Tip text="Chapter, page or percent (G)" below><button className={`quiet ${popover === 'goto' ? 'active' : ''}`} onClick={() => setPopover(popover === 'goto' ? null : 'goto')} data-testid="goto">Go to</button></Tip>
          <Tip text="Listening mode: large lines, the voice stops at hard words and explains them (L)" below align="end"><button className="primary switch" onClick={shared.switchMode} data-testid="switch-mode"><HeadphonesIcon /> Listen</button></Tip>
          <Tip text="Your books" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('library')}>Library</button></Tip>
          <Tip text="Look, voice, AI and level" below align="end"><button className="quiet" onClick={() => useApp.getState().setView('settings')}>Settings</button></Tip>
          <Tip text="All keyboard shortcuts (?)" below align="end"><button className="quiet icon" onClick={shared.openHelp} aria-label="Shortcuts">?</button></Tip>
        </div>
        {popover === 'aa' && (
          <div className="popover aa-pop no-drag" onClick={(e) => e.stopPropagation()} data-testid="aa-pop">
            <div className="pop-row"><span>Text size</span><div className="steps"><button onClick={() => setA({ fontSizePx: Math.max(12, settings.appearance.fontSizePx - 2) })} aria-label="Smaller">A−</button><span className="val">{settings.appearance.fontSizePx}</span><button onClick={() => setA({ fontSizePx: Math.min(34, settings.appearance.fontSizePx + 2) })} aria-label="Larger">A+</button></div></div>
            <div className="pop-row"><span>Line spacing</span><div className="steps">{[1.4, 1.6, 1.8, 2.0].map((lh) => <button key={lh} className={Math.abs(settings.appearance.lineHeight - lh) < 0.05 ? 'active' : ''} onClick={() => setA({ lineHeight: lh })}>{lh.toFixed(1)}</button>)}</div></div>
            <div className="pop-row"><span>Margins</span><div className="steps">{[{ n: 'Narrow', m: 24, c: 90 }, { n: 'Medium', m: 48, c: 70 }, { n: 'Wide', m: 96, c: 56 }].map((o) => <button key={o.n} className={settings.appearance.maxLineChars === o.c ? 'active' : ''} onClick={() => setA({ marginPx: o.m, maxLineChars: o.c })}>{o.n}</button>)}</div></div>
            <div className="pop-row"><span>Font</span><div className="steps">{([['serif', 'Serif'], ['sans', 'Sans'], ['dyslexic', 'Dyslexic']] as const).map(([id, n]) => <button key={id} className={settings.appearance.fontFamily === id ? 'active' : ''} onClick={() => setA({ fontFamily: id })}>{n}</button>)}</div></div>
            <div className="pop-row themes">{THEMES.map((t) => <button key={t.id} className={`theme ${settings.appearance.theme === t.id ? 'active' : ''}`} style={{ background: t.bg, color: t.fg }} onClick={() => setA({ theme: t.id })} data-testid={`aa-theme-${t.id}`}><span className="aa">Aa</span><span>{t.name}</span></button>)}</div>
            <div className="pop-row"><label className="check"><input type="checkbox" checked={settings.appearance.showHints !== false} onChange={(e) => setA({ showHints: e.target.checked })} /> Chinese hints under hard words</label></div>
            <div className="pop-row"><label className="check"><input type="checkbox" checked={settings.appearance.pageTurnAnimation !== false} onChange={(e) => setA({ pageTurnAnimation: e.target.checked })} /> Page-turn animation</label></div>
          </div>
        )}
        {popover === 'goto' && (
          <div className="popover goto-pop no-drag" onClick={(e) => e.stopPropagation()} data-testid="goto-pop">
            <div className="pop-row"><button onClick={() => goToWords(0)}>Cover</button><button onClick={() => { const first = index.sentences[0]; if (first) goToWords(first.before); }}>Beginning</button>
              <form className="page-form" onSubmit={(e) => { e.preventDefault(); const n = Number(gotoPage); if (n >= 1) goToWords((n - 1) * pages.wordsPerPage); }}>
                <input type="number" min={1} max={pages.total} placeholder={`Page 1–${pages.total}`} value={gotoPage} onChange={(e) => setGotoPage(e.target.value)} data-testid="goto-page" /><button type="submit">Go</button>
              </form>
            </div>
            <div className="pop-row"><span className="muted small">{Math.floor(fraction * 100)}%</span><input type="range" min={0} max={100} step={1} defaultValue={Math.floor(fraction * 100)} onChange={(e) => goToWords((Number(e.target.value) / 100) * index.totalWords)} data-testid="goto-percent" /></div>
            <div className="chapter-list">
              {book.chapters.map((c) => <button key={c.index} className={`quiet ${c.index === chapter ? 'active' : ''}`} onClick={() => { shared.goToChapter(c.index); setPopover(null); }}><span className="n">{c.index + 1}</span><span className="t">{c.title}</span></button>)}
            </div>
          </div>
        )}
      </header>

      <div className="page-view" ref={viewRef} onClick={onViewClick} onDoubleClick={shared.onDoubleClick} onMouseUp={shared.onMouseUp} onWheel={onWheel} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} data-testid="doc">
        <div className={`pages ${settings.appearance.pageTurnAnimation === false ? 'no-anim' : ''}`} ref={pagesRef} />
        <div className="zone left" aria-hidden="true" /><div className="zone right" aria-hidden="true" />
      </div>

      <footer className="bar bottom" {...bars} onClick={(e) => e.stopPropagation()} data-testid="bottombar">
        <Tip text="Click to cycle: page, time left in chapter, time left in book, percent" align="start"><button className="quiet status" onClick={() => setProgressKind(nextProgressKind(progressKind))} data-testid="progress-text">{status}</button></Tip>
        <span className="grow" />
        <Tip text="Play or pause the voice (Space)"><button className={`quiet play ${playing ? 'on' : ''}`} onClick={shared.playPause} data-testid="play" aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button></Tip>
        <span className="muted small page-count">{page.index + 1} / {page.count} in chapter</span>
      </footer>
      <div className="progress-line" aria-hidden="true">
        <div className="fill" style={{ width: `${fraction * 100}%` }} />
        {marks.map((m) => m.at > 0 && <i key={m.index} className="tick" style={{ left: `${m.at * 100}%` }} title={m.title} />)}
      </div>
    </div>
  );
}

export function HeadphonesIcon(): JSX.Element {
  return <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="13" width="4" height="7" rx="1.5" /><rect x="17" y="13" width="4" height="7" rx="1.5" /></svg>;
}
export function BookIcon(): JSX.Element {
  return <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 7c-2-2-5-2.5-8-2v13c3-.5 6 0 8 2 2-2 5-2.5 8-2V5c-3-.5-6 0-8 2Z" /><path d="M12 7v13" /></svg>;
}
