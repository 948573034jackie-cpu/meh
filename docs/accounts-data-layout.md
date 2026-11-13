# Accounts (wish 23): the data layout, ready for later

Not built in 3.8 or 3.9 (3.9 note: the level is a school level again, `drSettings.learnerLevel` A1–C2, with
`drExtras.explainPct` 0–100; `my_level` below would become `level text` + `explain_pct int`). Sign in with Apple needs the learner's own Apple Developer account; the online database needs
their own Supabase project; Google sign-in needs their own Google Cloud project. This file is the plan for the data,
so the accounts can be added without changing how the app keeps its words.

## What the app keeps today (per learner, already ONE document)

`dream-ext/src/level-db.ts` → `VocabularyDoc` (version 1). The iPhone, the iPad and the computer already share it
(a file, or a private GitHub Gist) and merge it three ways (`mergeDocs`), so two devices never lose each other's words.

| Part | What it is |
|---|---|
| `known[]` | `{ item, date }`: words and phrases the learner knows |
| `stillLearning[]` | `{ item, date, sentence, group? }`: still to learn, with the sentence it was met in |
| `removed[]` | words taken out on a device (so the other device takes them out too) |
| `tests[]`, `currentLevel` | the old Level Check results (kept for history) |
| `heard` | `{ n, asked }`: the "words heard" counter and the words explained lately (the 1,000-word rule across videos) |

Outside the document today (per device): `drExtras` (My level 0-100 = `myLevel`, the three switches, Text size, volume,
mode…), `drEntries` (each explained word: the explanation, Chinese, how many times explained), `drSpots` (where each
video stopped), `drFinderList` (the last Find-video list), the reader's books and places.

## Tables for the account (Supabase / Postgres), one row set per user

```sql
create table profiles (            -- one row per user
  user_id uuid primary key references auth.users on delete cascade,
  my_level int not null default 50 check (my_level between 0 and 100),
  stop_words bool not null default true, stop_phrases bool not null default true, stop_sentences bool not null default true,
  words_heard bigint not null default 0,
  settings jsonb not null default '{}',          -- text size, volume, mode, explain seconds …
  updated_at timestamptz not null default now()
);
create table words (               -- the vocabulary: one row per word or phrase
  user_id uuid not null references auth.users on delete cascade,
  item text not null,                              -- the word or phrase (lower case)
  status text not null check (status in ('known','learning','ignored','removed')),
  status_at timestamptz not null,                  -- when it got this status (newest wins when two devices differ)
  sentence text, chinese text, explanation text,
  times_explained int not null default 0,
  last_seen_at timestamptz, asked_at_heard bigint, -- the counter's value at its last explanation
  primary key (user_id, item)
);
create table places (              -- back where you stopped: videos, books, web pages
  user_id uuid not null references auth.users on delete cascade,
  kind text not null, ref text not null,           -- 'video' + id, 'book' + id
  place jsonb not null, updated_at timestamptz not null default now(),
  primary key (user_id, kind, ref)
);
alter table profiles enable row level security;
alter table words enable row level security;
alter table places enable row level security;
create policy own_profile on profiles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_words on words for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy own_places on places for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Each user sees only their own rows (row-level security). Deleting the account deletes every row (`on delete cascade`):
Apple requires a "Delete my account" button.

## How the app would use it

- Sign in: "Sign in with Apple" (native) and Google (Apple's web sign-in sheet). An App Store app that offers Google
  sign-in must offer Sign in with Apple too. A guest mode stays (the words stay on the device).
- First sign-in: the device's `VocabularyDoc` and settings are uploaded once (`known` / `stillLearning` → `words`,
  `heard.n` → `profiles.words_heard`, `heard.asked` → `words.asked_at_heard`, `myLevel` and the switches → `profiles`).
- After that the same merge rule as today (`mergeDocs`: only the other device's changes come in; the newest status of
  a word wins) runs against the tables instead of the Gist. `level-db-bg.ts` `gistPass()` is the one place to replace.
- The AI must not use the learner's own keys in a public app: a small server in front of the AI (with a daily limit per
  user) replaces `NativeFetch` for the AI calls. See `reports/I Know app product plan.md`.

## What the learner must set up first

1. An Apple Developer account (99 USD a year): Sign in with Apple, TestFlight, the App Store.
2. A Supabase project (free to start): the three tables above, Apple and Google sign-in turned on.
3. A Google Cloud project: the OAuth client for Google sign-in.
4. A privacy policy page, and a lawyer's look at YouTube's terms and lyrics rights before selling.
