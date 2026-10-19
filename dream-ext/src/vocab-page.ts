/** My Vocabulary page (dream/vocab.html): every word the tutor explained, CSV download, progress per CEFR level. */
import type { CefrLevel } from '@core/model';
import type { VocabEntry } from '@shared/api';
import * as store from './store';
import { toCsv, computeProgress, unknownAtLevel, videoLink } from './vocab';
import { getDictData } from './ai-client';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function renderWords(): Promise<void> {
  const entries = Object.values(await store.getEntries()).sort((a, b) => (b.lastSeenAt > a.lastSeenAt ? 1 : -1));
  const q = $<HTMLInputElement>('q').value.trim().toLowerCase();
  const f = $<HTMLSelectElement>('filter').value;
  const shown = entries.filter((e) => (f === 'all' || e.status === f) && (!q || `${e.word} ${e.lemma} ${e.chinese} ${e.sentence}`.toLowerCase().includes(q)));
  $('rows').innerHTML = shown.map((e: VocabEntry) => `<tr data-lemma="${esc(e.lemma)}">
    <td class="word">${esc(e.word || e.lemma)}${e.level ? ` <span class="muted" style="font-size:11px;font-family:var(--font-sans)">${esc(e.level)}</span>` : ''}</td>
    <td class="zh">${esc(e.chinese)}</td>
    <td><div><i>${esc(e.sentence)}</i></div><div class="muted">${esc(e.explanation)}</div></td>
    <td>${videoLink(e) ? `<a href="${esc(videoLink(e))}" target="_blank" style="color:var(--accent)">${esc(e.bookTitle)}${e.chapter ? ` (${esc(e.chapter)})` : ''}</a>` : esc(e.bookTitle)}</td>
    <td><button data-act="status" class="st-${e.status}">${e.status === 'known' ? 'known' : 'learning'}</button></td>
    <td><button data-act="del" class="danger" title="Remove">✕</button></td></tr>`).join('');
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

function tab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.classList.toggle('sel', b.dataset.tab === name));
  $('tab-words').hidden = name !== 'words';
  $('tab-progress').hidden = name !== 'progress';
  void (name === 'words' ? renderWords() : renderProgress());
}

document.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab!)));
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
$('csv').addEventListener('click', async () => {
  const csv = toCsv(Object.values(await store.getEntries()));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'my-vocabulary.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
chrome.storage.onChanged.addListener(() => { if (!$('tab-words').hidden) void renderWords(); });
tab('words');
