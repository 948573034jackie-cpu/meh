# UX research: Kindle / Speechify / LingQ / Trancy -> Dream Read

Method: web search over official help pages, press releases, store listings, reviews. Direct page fetches were blocked by the sandbox DNS, so details come from search extracts; items marked (unverified) could not be confirmed from a primary source.

## 1. Kindle app (iOS/iPadOS/Mac)

- Tap zones: tap left/right side = previous/next page; tap centre = toggle chrome (top bar + bottom bar). Swipe horizontally also turns pages (iOS: swipe left = next). Exact zone widths are not documented; e-reader guides describe a narrow left strip (~1/5) for "back" and the rest for "forward". [1][2]
- Controls auto-hide: chrome appears only on centre tap and disappears on the next tap/page turn; bookmark button lives top-right of the chrome. [1]
- Page-turn animation: a toggle ("Page turn animation") under Aa > More; Layout tab also offers "Continuous scrolling" (vertical) as the alternative to paged mode. [3][4]
- Aa panel (tap top-centre, then Aa) has tabs Font / Layout / Themes / More. Font: size, typeface (incl. OpenDyslexic), line and character spacing, brightness (brightness slider is on every tab). Layout: page colour (white, sepia, light green, black), dark mode follows system, continuous scrolling, margins, alignment, orientation lock. Themes: presets + custom. More: reading progress, popular highlights, clock, page-turn animation, Reading Ruler. [3][4]
- Progress: Aa > More > Reading progress with options Page in book / Time left in chapter / Time left in book / Location in book / None; tapping the text in the bottom-left corner cycles through them. Time-left is estimated from the user's own measured reading speed. [5][6]
- Go to: left panel / Go to menu offers Cover, Beginning, Table of contents, Page... (only when the book has print page numbers), Location..., Notes & highlights; Page entry appears just before Location. [7]
- Word Wise: short definitions rendered above difficult words; a slider ("Fewer hints" ... "More hints") controls how many words get hints, lower = only harder words. Line spacing is forced to maximum while on. Tapping a hinted word opens a card with definitions, synonyms and more. Toggle Show/Hide from the reading menu; master switch under Settings > Reading Options. [8][9][10]
- Dictionary card: long-press a word -> pop-up card with short definition; links to Wikipedia / translation / search; dismissed by tapping anywhere outside the card or the X. Lookups work offline. [11][12]
- Vocabulary Builder: every dictionary lookup is saved automatically (toggle in Reading Options). Flashcards show the word in the sentence where it was found; "See Definition" flips the card; "Mark as Mastered" removes it from the active list. No SRS. [13][14]
- X-Ray: tabs Notable Clips / People / Terms; People lists characters alphabetically with occurrence counts and locations; long-press on a name shows an X-Ray snippet; works offline. [15]

## 2. Speechify

- Speed: up to 4.5x (~900 wpm); App Store copy suggests starting around 300 wpm; speeds above 1.1x are Premium. Minimum not documented (a Speechify-powered app exposes 0.1x). [16][17]
- Voices: 50+ HD voices on Premium, 200+ across 60+ languages on Android listing; celebrity voices (Snoop Dogg, MrBeast, Gwyneth Paltrow); free tier uses on-device voices. [16][18]
- Highlighting: "text is highlighted and perfectly synced, word for word"; extension listings describe "active highlighting". No documented word-vs-sentence or colour settings (unverified; NaturalReader-style word+sentence dual highlight is the common pattern). [17][19]
- Skip content ("Enhanced Skipping"): Settings gear (web) or three dots (iOS/Android). Toggle categories individually or "Skip All". Exact option names: Headers, Footers, Footnotes, Braces, Citations, Parentheses, Brackets, URLs. Reviews note it does not skip page numbers, formulas, alt text, tables of contents or code blocks. [20][21][22]
- Floating player: Chrome "floating widget is always accessible ... Move it around, dock it, or completely hide it". [16]
- Smoothness: public API streams audio via HTTP chunked transfer with sub-300 ms first byte; playback starts before synthesis completes. A user review reports buffering at 1.3x when audio is not pre-generated, so pre-synthesising the next sentences is the visible difference between smooth and stuttering. [23][24]

## 3. LingQ

- Word states: blue = new (never seen), yellow = LingQ (saved) with status 1 New, 2 Recognized, 3 Familiar, 4 Learned; checkmark = Known (white). Keyboard: K = known, X = ignore. [25][26]
- Becoming known: by default turning the page marks all remaining blue words Known ("paging moves to known"); it is toggled under the Reader settings gear (top right). Known cannot revert to blue but can be re-LingQed. Learned (4) still appears in SRS; Known never does. [27][28]
- LingQ card: tapping a blue word shows up to 3 popular meanings in the side dashboard (or popup on mobile); choosing one creates the LingQ; the saved hint is displayed under the word in the text. Phrases: click-drag to select; phrase turns blue, gets translations; individual words inside remain saveable. [29][30]
- Modes: Page mode (full page, inline translation on click), Sentence mode (one sentence with its own audio and full translation; used for hard texts and for fixing timestamps), and Listening mode with word-by-word highlight (karaoke). [31]
- Counter and milestones (English known words): Beginner 1 500, Beginner 2 1,500, Intermediate 1 6,000, Intermediate 2 12,000, Advanced 1 20,750, Advanced 2 30,250. [32]
- SRS: Status 1 due after 1 day, 2 after 3 days, 3 after 1 week, 4 after 2 weeks, then 1 month, 3 months. Activities: flashcards, reverse flashcards, cloze, dictation, multiple choice; configurable per session. LingQ warns against list review, recommends reviewing as you page. [33][34]

## 4. Trancy

- Bilingual subtitles support hover-to-lookup; click opens an AI explanation/definition with context-specific meaning, part-of-speech tag, example sentences and a save-to-vocabulary button, without pausing the video. YouTube bilingual subtitles have word-by-word highlighting. [35][36]
- Sentence breakdown: "AI Grammar Analysis" labels parts of speech and explains structure; Reading Mode renders subtitles as interactive text with grammar labels above each word; NLP groups cues into complete sentences. [36][37]
- Auto-dismiss: no documentation found; hover tooltips are implicitly dismissed on mouse-out (unverified).

## 5. Dream Read spec

Reading mode (Kindle-like pages)
- Paged layout, margins preset (narrow/medium/wide), chrome hidden by default; tap/click zones: left 20% = back, right 20% = forward, centre 60% = toggle chrome; arrow keys and horizontal swipe also page; 250 ms slide animation with a "none" option.
- Aa popover with Font / Layout / Theme tabs; brightness on every tab; themes white/sepia/green/black.
- Bottom-left status text cycles Page / Time left in chapter / Time left in book / % / none; time estimates from measured wpm. Go to: Cover, Beginning, TOC, Page or %, Notes.
- Word Wise layer: hints above words in a smaller grey face; difficulty slider (5 steps) mapped to word-frequency rank; line spacing fixed while on.
- LingQ layer: blue = new, yellow = learning (1-4), plain = known; page-forward marks remaining blue words known (toggle "Paging moves to known"); known-words counter in chrome with level badges at 500/1,500/6,000/12,000/20,750/30,250.

Listening mode (karaoke)
- Current sentence centred, previous/next dimmed; word-level highlight synced to timestamps, sentence highlight in a second colour; pre-synthesise N+2 sentences, start playback at first chunk.
- Speed 0.5x-4.5x; floating mini-player (drag, dock, hide); "Enhanced Skipping" toggles with the same eight names as Speechify plus Page numbers.

Dictionary card
- Trigger: long-press/click (reading) or hover 300 ms (listening, pauses nothing). Card appears above the word (below if no room) with headword, IPA, 1-3 short senses, context sentence, POS tag, buttons: Save / Known / Ignore.
- Dismiss: click outside, Esc, page turn, or auto-hide 4 s after mouse leaves in hover mode. Every lookup lands in Vocabulary (Kindle) as a status-1 LingQ with intervals 1d/3d/1w/2w/1m/3m.

## Sources
[1] https://www.slideshare.net/slideshow/ipad-handout/10255237
[2] https://brainvoyage.blog/kindle-paperwhite-navigation-guide
[3] https://digprjsurvey.amazon.com/csad/help/node/TABlJ4ot69emTO8jJG
[4] https://blog.the-ebook-reader.com/2020/02/25/kindle-ios-update-6-28-adds-new-aa-menu-and-reading-ruler/
[5] https://www.howtogeek.com/715778/how-to-see-a-books-page-number-on-amazon-kindle/
[6] https://www.bgr.com/2158335/what-kindle-loc-means-explained/
[7] https://applevis.com/comment/21338
[8] https://press.aboutamazon.com/2014/11/new-features-for-kindle-e-readers-now-available
[9] https://blog.the-ebook-reader.com/2014/11/16/kindle-word-wise-review-and-free-ebook-samples/
[10] https://www.guidingtech.com/how-to-disable-word-wise-on-kindle/
[11] https://www.dummies.com/article/how-to-use-the-dictionary-on-your-kindle-paperwhite-157147
[12] https://www.guidingtech.com/how-to-use-dictionary-in-kindle/
[13] https://www.dummies.com/article/technology/electronics/tablets-e-readers/kindles/how-to-use-vocabulary-builder-on-your-kindle-paperwhite-156833/
[14] https://nerdschalk.com/how-to-enable-and-use-kindle-vocabulary-builder/
[15] https://www.slashgear.com/1475659/kindle-x-ray-feature-explained/
[16] https://microsoftedge.microsoft.com/addons/detail/speechify-text-to-speech-/ogapibpahpkbcdidopigillpmndjemnj
[17] https://apps.apple.com/app/speechify-text-to-speech/id1209815023
[18] https://9to5mac.com/2026/02/02/speechify-adds-celebrity-voices-to-its-ai-voice-assistant/
[19] https://help.naturalreaders.com/en/articles/6177143-web-app-preferences
[20] https://speechify.com/blog/how-to-autoskip-content-in-speechify/
[21] https://oae.stanford.edu/accessibility-resources/speechify-tips-tricks
[22] https://www.audeus.com/product-reviews/speechify-alternatives
[23] https://docs.speechify.ai/build/guides/text-to-speech/streaming
[24] https://www.trustpilot.com/review/speechify.com?page=6
[25] https://lingq-support.groovehq.com/help/can-you-explain-a-lingqs-status
[26] https://lingq-support.groovehq.com/help/how-do-i-create-lingqs
[27] https://lingq-support.groovehq.com/help/how-do-i-increase-my-known-words
[28] https://lingq-support.groovehq.com/help/understanding-lingq-statistics
[29] https://lingq-support.groovehq.com/help/can-i-save-or-create-lingqs-for-phrases
[30] https://www.lingq.com/zh-cn/ios-app-support/
[31] https://www.lingq.com/en/learn-english-online/courses/854680/learn-english-lingq-podcast-38-how-p-11392113/
[32] https://lingq-support.groovehq.com/help/step-8-lingq-statistics
[33] https://lingq-support.groovehq.com/help/how-does-the-lingq-srs-review-work
[34] https://www.lingq.com/blog/reviewing-vocabulary/
[35] https://air.trancy.org/changelog
[36] https://www.trancy.org/blog/ai-subtitles-for-youtube-learn-any-language-31f9d22520058042b6eac12784edab31
[37] https://cf.trancy.org/blog/netflix-bilingual-subtitles-complete-guide-2026-31f9d2252005809d981bc9721094b0e8
