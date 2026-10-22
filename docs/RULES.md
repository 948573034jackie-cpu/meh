# Dream Read: all the learner's rules (read this first, every session)

The learner is a native Chinese speaker, about B2, using an Intel MacBook Pro. These are all the rules they
have given. When the code and this file disagree, this file wins. Change it only when the learner changes a rule.

## 1. Listening mode: a hard word, phrase or short sentence (latest rule)
1. The book is read aloud to the end. It pauses at every **word, phrase (2 to 5 words), slang or short
   sentence above the learner's level**, and at every yellow "learning" word. It does not pause twice for the
   same word within 500 words.
2. At the pause, the **dictionary card appears under the word**, and **at that same moment the word or phrase,
   with its sentence and the text around it, is sent to the AI**, so the explanation is prepared while the
   learner listens. Then the word is said **3 times**. Nothing of the explanation is said yet.
3. Then a **5-second window**. During these 5 seconds the microphone only listens for three commands.
   **Nothing the learner says is sent to the AI**, and repeating the word or saying anything else is ignored:
   it does not make the window longer. (A command the learner is still saying when the 5 seconds end is still
   heard, about 2 seconds at most.)
   - **"I know"** (or K, or the button): saved as known for good, highlight removed, never explained again.
     No explanation: the prepared one is thrown away. The sentence is read again from its start, then the book
     goes on.
   - **"Go on"** (also "bye bye", "continue", "next"; or Esc, or the button): no explanation, the AI says
     nothing, the prepared one is thrown away, but the word is **saved as learning**.
   - **"I don't know"** (or D, or the button): the prepared explanation starts **at once**, without waiting for
     the 5 seconds to end.
   - **Silence, the learner repeating the word, or anything else**: when the 5 seconds end, the prepared
     explanation is played **at once**.
4. After the explanation, the card disappears and another 5-second window opens (same rules: speech is not
   sent to the AI):
   - "I don't know": explain again, harder and deeper. Then this window again.
   - "I know": saved as known.
   - "Go on" or nothing: the word stays learning.
5. Reading then continues **from the start of the interrupted sentence** (never the next sentence) to the end
   of the book.

## 2. Explanations
- Easy English, plain spoken prose: no headings, labels, numbers or lists.
- **No filler**: never "we already know this", "the Chinese translation is", "let me explain", "great question".
  Start teaching at once and go step by step.
- Explain the meaning **in this exact context** of the book (it reads about 500 words before and 200 after,
  plus the title and chapter). Understand the story, the characters and the meaning under the words.
- Paint the scene **in the learner's mind with words** (who is there, what they see, hear and feel). Never
  images or pictures.
- Never invent text that is not in the book. Never say the word "stop" to the learner.
- **Chinese**: only the two meanings that fit this sentence, spoken at the end by a **Chinese voice**, never by
  an English voice. A **中文** on/off button is on the word card and in Listening mode.
- The learner's pronunciation is often recognised badly: never ask them to repeat; work out the meaning from
  the book.
- **Explanation styles** (Settings → AI): My Custom Style (default), Teacher, Imagination, Chunk, Word Parts,
  Story, Quiz, Philosopher, Poetry, Lyrics. Every style can be edited: its prompts, personality, length,
  answer type, repeats and AI model; styles can be copied, hidden, deleted or made new.

## 3. Dictionary and highlights
- Words and phrases above the learner's level are highlighted. Known words and words in My Vocabulary marked
  known are never highlighted.
- A short **Chinese meaning is written under each hard word**, chosen by the AI for this chapter (dictionary
  meaning until the AI's is ready), in a size that is easy to read.
- The dictionary card (word, pronunciation, level, Chinese in large characters, short English meaning) appears
  under the word when it is tapped or when Listening pauses there, and **disappears by itself after the
  explanation**.
- Phrases: for each chapter the AI finds expressions of 2 to 5 words and gives each a CEFR level **before**
  they are shown; above-level ones are highlighted and explained like words.

## 4. Reading mode (like Kindle)
- Pages; tap the right edge or PageDown = next page, left edge or PageUp = previous page, middle = bars.
- Left/Right arrows = previous/next sentence. Space = play/pause. Aa = look. Go to = chapter, page, percent.
- **Single tap on a word = "I don't know"**: card + spoken explanation, then the voice waits.
- **Double tap = "I know"**: highlight removed for good.
- Select text = explain the phrase or sentence.

## 5. Listening mode (like song lyrics)
- Full-width text flows up; the current sentence is large; timeline for the whole book with chapter marks.
- Up arrow = explain the previous sentence; Down arrow = explain the next sentence. "I don't know" button.
  "Explain the last 20/30/40 seconds".
- Reading and Listening share one position; L switches between them.

## 6. Talking with the tutor
- A round mic button on the right in both modes (M key); "Always on" keeps it listening.
- Outside the 5-second windows the learner can talk any time: the book pauses, the tutor answers by voice in
  this context, and the learner can interrupt by speaking. "Bye bye" closes the call.
- A typed box is always there ("pronunciation does not matter, you can type").

## 7. Saving and progress
- Every explained word goes to **My Vocabulary** (sentence, explanation, Chinese, book, date) and to
  Documents/Dream Read/my-vocabulary.csv, always up to date. Known words stay known.
- **Progress**: known, learning and unknown words per level; tap a level to see only the unknown words.
- A level test at first start (and any time); the level keeps adjusting from "I know" / "I don't know".
- A short spoken review class after a session.
- All settings, styles, prompts, API keys (all providers) and progress are saved and survive restarts and updates.

## 8. Voices and reading
- Default: the free **Dream voice** (Kokoro, British), prepared ahead so playback is smooth.
- Paid voices (Azure, Google, OpenAI, ElevenLabs) show their price per hour.
- **Skip** panel like Speechify: headers, footers, footnotes, braces, citations, parentheses, brackets, web
  links, page numbers, contents, captions.
- Comfort: separate text sizes, line spacing, themes (Night default, Sepia, Light, Grey), speed 0.5–2.0.

## 9. Working agreement
- Build in small steps; send a build after 2 or 3 features; the learner tests on the Mac the same day.
- Before a new feature, repeat the understanding back in 3 to 5 lines.
- The learner's Mac is Intel: always check Intel (x64) binaries and speed.
- Later: an account (Google, Apple or email) that saves vocabulary, progress and keys online.
