# Vendored Dream Read code

`vendor/core` and `vendor/shared` are copies of `src/core` and `src/shared` from the Dream Read app
(GitHub `948573034jackie-cpu/meh`, branch `claude/readalong-app`, commit 8e703ec), so the YouTube
version uses exactly the same dictionary, hard-word rules, listening teacher, prompts, styles and voice
commands. They are not edited here. The PDF and EPUB importers were left out (books are not used).

To update: copy the two folders again from a newer Dream Read checkout and run `npm test`.

The dictionary file `youtube-to-claude/dream/dict.json.gz` (ECDICT + British IPA + CEFR levels) is also copied as is
from that Dream Read commit; `build.mjs` does not make it.

Local changes to the vendored code (both are off unless the YouTube side asks for them, so Dream Read's behaviour is unchanged):
- `core/listen/controller.ts`: `ListenDeps.streamProse` speaks word / phrase / sentence / passage explanations sentence by
  sentence while the reply streams in (the Chinese meanings still come at the end), and `ListenDeps.phraseAsSentence`
  ends a phrase stop like a sentence (the sentence again instead of the word repeats).
- `ListenDeps.sentenceTrigger` adds whole sentences that are too hard (found by the AI) as stops at the sentence end with
  a vocabulary key: played once, then the commands window, then the explanation and the sentence again.
- `core/tts/audio.ts`: `setVolume` sends an audio element's sound through a gain where the element's own volume cannot be set (an iPhone).
- `ListenDeps.directStop` / `directTrigger` (Level Check): the app chooses the stops; a stop plays the sentence, the explanation and the sentence again, then the reading goes on. With `items` (the sentence's hard words and phrases) each is said `wordRepeats` times and the commands window waits: "I know" goes to the next item (all known: the sentence again, on), anything else is the explanation. Off unless the YouTube side asks for it.

`youtube-to-claude/dream/zipf.json.gz` is made once by `scripts/make-zipf.py` from [wordfreq](https://github.com/rspeer/wordfreq) (its data is CC BY-SA 4.0).
