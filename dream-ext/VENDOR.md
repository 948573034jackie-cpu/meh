# Vendored Dream Read code

`vendor/core` and `vendor/shared` are copies of `src/core` and `src/shared` from the Dream Read app
(GitHub `948573034jackie-cpu/meh`, branch `claude/readalong-app`, commit 8e703ec), so the YouTube
version uses exactly the same dictionary, hard-word rules, listening teacher, prompts, styles and voice
commands. They are not edited here. The PDF and EPUB importers were left out (books are not used).

To update: copy the two folders again from a newer Dream Read checkout and run `npm test`.

The dictionary file `youtube-to-claude/dream/dict.json.gz` (ECDICT + British IPA + CEFR levels) is also copied as is
from that Dream Read commit; `build.mjs` does not make it.
