/**
 * My Vocabulary (every word the tutor explained, CSV download, progress per CEFR level), as a part that can be put in
 * any page: vocab.html (I Know's Words tab, and Chrome) and I Know Book's Words tab (book.html). `prefix` keeps the
 * ids apart from the page's own; `onSettings` = what the "Settings" link does in the app (else it opens options.html).
 */
import { copyLevel } from './level-copy';
import type { CefrLevel } from '@core/model';
import type { VocabEntry } from '@shared/api';
import * as store from './store';
import { toCsv, computeProgress, unknownAtLevel, videoLink, estimateKnown } from './vocab';
import { getDictData } from './ai-client';
import { icon } from './icons';

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function vocabHtml(p = ''): string {
  return `<h1>My Vocabulary</h1>
<div class="knowbox"><div class="big" id="${p}know-big">…</div><div class="muted" id="${p}know-small"></div><div class="online" id="${p}online"></div></div>
<p class="lead" id="${p}summary"></p>
<div class="tabs"><button data-tab="words" class="sel">Words</button><button data-tab="progress">Progress</button><span class="grow" style="flex:1"></span><button id="${p}copy-level">Copy my level for Claude</button> <button id="${p}csv" class="primary"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 10l4 4 4-4M12 3v11"/><path d="M5 13v7h14v-7"/></svg> Download CSV</button><a href="options.html" id="${p}settings" style="align-self:center;margin-left:10px">Settings</a></div>
<section id="${p}tab-words">
  <div class="row" style="margin-bottom:10px"><input id="${p}q" type="text" placeholder="Search"><select id="${p}filter"><option value="all">All</option><option value="learning">Learning</option><option value="known">Known</option></select></div>
  <table><thead><tr><th>Word</th><th>中文</th><th>Sentence and explanation</th><th>Video</th><th>Status</th><th></th></tr></thead><tbody id="${p}rows"></tbody></table>
  <p class="muted" id="${p}empty" hidden>No words yet. Turn on <b>My tutor</b> under a YouTube video: every word it explains is saved here.</p>
</section>
<section id="${p}tab-progress" hidden>
  <div class="levels" id="${p}levels"></div>
  <h2 style="margin-top:16px" id="${p}unknown-title"></h2>
  <table><tbody id="${p}unknown"></tbody></table>
</section>`;
}

export interface VocabView { refresh(): void }

export function mountVocab(root: HTMLElement, o: { prefix?: string; onSettings?: () => void } = {}): VocabView {
  const p = o.prefix ?? '';
  root.innerHTML = vocabHtml(p);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(p + id) as T;
  async function renderWords(): Promise<void> {
    const entries = Object.values(await store.getEntries()).sort((a, b) => (b.lastSeenAt > a.lastSeenAt ? 1 : -1));
    const q = $<HTMLInputElement>('q').value.trim().toLowerCase();
    const f = $<HTMLSelectElement>('filter').value;
    const shown = entries.filter((e) => (f === 'all' || e.status === f) && (!q || `${e.word} ${e.lemma} ${e.chinese} ${e.sentence}`.toLowerCase().includes(q)));
    $('rows').innerHTML = shown.map((e: VocabEntry) => `<tr data-lemma="${esc(e.lemma)}">
      <td class="word">${esc(e.word || e.lemma)}${e.level ? ` <span class="muted">${esc(e.level)}</span>` : ''}</td>
      <td class="zh">${esc(e.chinese)}</td>
      <td><div><i>${esc(e.sentence)}</i></div><div class="muted">${esc(e.explanation)}</div></td>
      <td>${videoLink(e) ? `<a href="${esc(videoLink(e))}" target="_blank">${esc(e.bookTitle)}${e.chapter ? ` (${esc(e.chapter)})` : ''}</a>` : esc(e.bookTitle)}</td>
      <td><button data-act="status" class="st-${e.status}">${e.status === 'known' ? 'known' : 'learning'}</button></td>
      <td><button data-act="del" class="danger" title="Remove" aria-label="Remove ${esc(e.word || e.lemma)}">${icon('xmark')}</button></td></tr>`).join('');
    $('empty').hidden = entries.length > 0;
    const learning = entries.filter((e) => e.status === 'learning').length;
    $('summary').textContent = `${entries.length} words · ${learning} learning · ${entries.length - learning} known`;
  }

  async function renderProgress(): Promise<void> {
    const [dict, vocab, entries] = await Promise.all([getDictData(), store.getVocab(), store.getEntries()]);
    const p = computeProgress(dict, vocab.words, Object.values(entries));
    $('levels').innerHTML = p.levels.map((l) => {
      const k = l.total ? (100 * l.known) / l.total : 0, le = l.total ? (100 * l.learning) / l.total : 0;
      return `<button class="level" data-level="${l.level}"><b>${l.level}</b><div class="bar"><span class="k" style="width:${k}%"></span><span class="l" style="width:${le}%"></span></div><div class="muted" style="font-size:12px">${l.known} known · ${l.learning} learning · ${l.unknown} new</div></button>`;
    }).join('');
    $('summary').textContent = `${p.totals.known} known · ${p.totals.learning} learning · ${p.learnedThisWeek} new words this week · ${p.streakDays} day streak`;
    $('levels').onclick = (ev) => {
      const lv = (ev.target as HTMLElement).closest<HTMLElement>('.level')?.dataset.level as CefrLevel | undefined;
      if (!lv) return;
      const words = unknownAtLevel(dict, vocab.words, lv).slice(0, 300);
      $('unknown-title').textContent = `${lv}: words you have not met yet (most common first)`;
      $('unknown').innerHTML = words.map((w) => `<tr><td class="word">${esc(w.word)}</td><td class="muted">${esc(w.ipa)}</td><td class="zh">${esc(w.zh)}</td></tr>`).join('');
    };
  }

  /**
   * About how many words you know: every dictionary word at or below your level (except the ones you are still
   * learning), plus the harder words you marked as known.
   */
  async function renderKnow(): Promise<void> {
    const [dict, vocab, entries, s] = await Promise.all([getDictData(), store.getVocab(), store.getEntries(), store.getSettings()]);
    const p = computeProgress(dict, vocab.words, Object.values(entries));
    const est = estimateKnown(p, s.learnerLevel);
    const words = Object.entries(vocab.words).filter(([k]) => !k.startsWith('sentence:'));
    const known = words.filter(([, st]) => st === 'known').length, learning = words.filter(([, st]) => st === 'learning').length;
    $('know-big').innerHTML = `You know about <b>${est.toLocaleString()}</b> English words`;
    $('know-small').textContent = `Your level ${s.learnerLevel} · ${known} harder words marked known · ${learning} words you are learning · ${p.learnedThisWeek} new this week`;
  }

  /** the online copy (Chrome sync, your Google account) */
  async function renderOnline(save = false): Promise<void> {
    const el = $('online');
    el.textContent = save ? 'Saving online…' : '';
    const r = await chrome.runtime.sendMessage({ type: 'dream-vocab-online', save }).catch(() => null) as { at: string | null; words: number; sync: boolean } | null;
    if (!r || !r.sync) { el.textContent = 'Online copy: not available in this browser.'; return; }
    el.innerHTML = r.at
      ? `${icon('icloud')} Saved online: ${esc(r.words.toLocaleString())} words · ${esc(new Date(r.at).toLocaleString())} <span class="muted">(your Google account, when Chrome sync is on)</span><button id="${p}save-now">Save now</button>`
      : `Not saved online yet.<button id="${p}save-now">Save now</button>`;
    $('save-now').onclick = () => void renderOnline(true);
  }

  function tab(name: string): void {
    root.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.classList.toggle('sel', b.dataset.tab === name));
    $('tab-words').hidden = name !== 'words';
    $('tab-progress').hidden = name !== 'progress';
    void (name === 'words' ? renderWords() : renderProgress());
  }

  root.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab!)));
  $('q').addEventListener('input', () => void renderWords());
  $('filter').addEventListener('change', () => void renderWords());
  $('rows').addEventListener('click', async (ev) => {
    const btn = (ev.target as HTMLElement).closest('button');
    const lemma = (ev.target as HTMLElement).closest<HTMLElement>('tr')?.dataset.lemma;
    if (!btn || !lemma) return;
    if (btn.dataset.act === 'del') await store.deleteEntry(lemma);
    else if (btn.dataset.act === 'status') { const e = (await store.getEntries())[lemma]; await store.setWordStatus(lemma, e?.status === 'known' ? 'learning' : 'known'); }
    void renderWords();
  });
  $('copy-level').addEventListener('click', async () => {
    const b = $('copy-level');
    try { if ((await copyLevel()) === 'copied') b.textContent = 'Copied ✓'; }
    catch { b.textContent = 'Could not copy'; }
    setTimeout(() => { b.textContent = 'Copy my level for Claude'; }, 2500);
  });
  $('csv').addEventListener('click', async () => {
    const csv = toCsv(Object.values(await store.getEntries()));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'my-vocabulary.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  if (o.onSettings) $('settings').addEventListener('click', (ev) => { ev.preventDefault(); o.onSettings!(); });
  const refresh = () => { if (!$('tab-words').hidden) void renderWords(); else void renderProgress(); void renderKnow(); };
  chrome.storage.onChanged.addListener((_ch, area) => { if (area !== 'local' || !root.isConnected) return; if (!$('tab-words').hidden) void renderWords(); void renderKnow(); });
  tab('words');
  void renderKnow();
  void renderOnline();
  return { refresh };
}
