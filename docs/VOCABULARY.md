# My Vocabulary, Progress and the review class

Where the words a learner has had explained live, how the numbers on the Progress page are computed, and
what the spoken review after a listening session is built from.

## Files

| What | Where |
|---|---|
| Store (main process) | `src/main/vocabulary.ts` → `<userData>/data/vocabulary.json` |
| Status map used by highlighting | `src/main/settings.ts` → `<userData>/data/vocab.json` (`VocabState.words`) |
| CSV mirror | `~/Documents/Dream Read/my-vocabulary.csv` |
| IPC | `src/main/ipc.ts` (`vocab:*`), bridge in `src/preload/index.ts`, types in `src/shared/api.ts` |
| Screens | `src/renderer/views/Vocabulary.tsx`, `src/renderer/views/Progress.tsx` (ids `VOCAB_VIEW_IDS = ['vocabulary', 'progress']`) |
| Review planner (pure) | `src/core/vocab/review.ts` |
| Tests | `test/unit/vocabulary.test.ts`, `test/unit/vocabulary-review.test.ts` |

## Entries

One entry per dictionary lemma (`VocabEntry` in `src/shared/api.ts`):

`lemma, word, sentence, explanation, chinese, bookId, bookTitle, chapter, position, createdAt, lastSeenAt,
timesExplained, status ('learning' | 'known'), level?, again`

The reader sends a `VocabEntryInput` through `vocabExplained` whenever the learner heard a word's explanation (the
listening controller's `onTranscript` callback is the place): one call that merges the entry and saves the word as
learning, entry and status map, unless it is known. `onMarkLearning` only shows the learning status at once; it saves
it on its own (`vocabSetEntryStatus`) when no heard explanation follows in the same turn ("go on", an explanation cut
short). `vocabUpsertEntry` (merge only) stays for other callers. Merge rule, by lemma:

- new word: `timesExplained = 1`, `status = 'learning'`, `createdAt = lastSeenAt = now`;
- seen before: `timesExplained + 1`, `lastSeenAt = now`, the **first** sentence (and book / chapter / position)
  is kept, the **latest** non-empty explanation and Chinese win, `again + 1` when the input says `again: true`
  (the learner said "I don't know"), a known word stays known;
- `level` is taken from the input, else from the dictionary.

The status map `VocabState.words` is kept in sync so highlighting follows: upsert → `'learning'` unless the word
is already `'known'`; `vocabSetEntryStatus` mirrors the status; `vocabDeleteEntry` removes the word from the map.

Both files are written in the background (`JsonStore` in `src/main/storage.ts`: about half a second after the last
change, anything unsaved synchronously at quit); every read comes from memory, so it always sees the latest change.

## CSV

`vocabExportCsv()` writes the file now, reveals it in Finder and resolves with the path; the same file is also
rewritten automatically in the background three seconds after the last change (and at quit when a change is not in
it yet), so it is always current. UTF-8 with a BOM (Excel and
Numbers then show the Chinese), CRLF line ends, oldest entry first, columns:

`word, chinese, explanation, sentence, book, chapter, date, status`

Fields with commas, quotes, semicolons or tabs are quoted; line breaks inside a field become spaces.

## Progress (`vocabProgress`)

Computed in the main process from the dictionary data (`library.getDictData()`, the raw `DictData`) and the
status map:

- per level A1…C2, over the **CEFR-tagged** single-word headwords (`levelSource` `cefrj` or `oct`, never the
  estimated levels, never phrases): `known`, `learning`, `unknown` (neither; `ignored` words are left out) and
  `total`;
- `totals.known` / `totals.learning` count every marked word, tagged or not; `totals.unknown` is the sum over the
  levels; `totals.entries` is the size of My Vocabulary;
- `learnedThisWeek`: entries created in the last 7 days;
- `streakDays`: days in a row with at least one entry created or seen, counted back from today, or from
  yesterday when nothing happened today yet (local dates).

`vocabUnknownAtLevel(level)` lists the tagged words of that level the learner has not marked, with the first
gloss line, IPA and the COCA rank, most frequent first (unranked words last). The Progress page shows them a
hundred at a time with "I know it" (→ `setWordStatus(word, 'known')`) and "Say it".

## Review class (`src/core/vocab/review.ts`)

`buildReviewPlan(entries, sessionWords, { now, sessionLemmas, sessionStart })` returns a `ReviewPlan` the voice
layer speaks after a listening session:

- size: about one item per 300 words read, at least 3, at most 20 (`reviewSize`);
- items: the words explained this session first ("I don't know" words before the others, then the most recent),
  then words due again on the spaced schedule, most overdue first. Each item is `{ lemma, word, sentence,
  chinese, explanation, reason }`;
- `context`: the chosen sentences grouped by book and chapter in reading order, for the context review;
- schedule: `nextDue(entry)` = `lastSeenAt` + 1, 3, 7, 14 or 30 days depending on `timesExplained`; a known word
  is never due.
