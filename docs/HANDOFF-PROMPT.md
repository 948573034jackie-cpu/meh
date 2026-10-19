# Paste this into the other chat

Copy everything between the lines below into the new chat, and attach (or paste) these three files with it:
**HOW-IT-WORKS.md**, **RULES.md** and, if possible, the GitHub project link.

---

I am building an English-learning app and want to combine it with the reading and listening features of my
existing app, **Dream Read**. I am a native Chinese speaker, about B2 level, using an Intel MacBook Pro with
macOS 13. Please answer in simple, clear English.

**About Dream Read**
- How it is built and how every feature works: see the attached file **HOW-IT-WORKS.md**.
- My rules for how it must behave (this is the most important part): see the attached file **RULES.md**.
  These rules are final. If anything in your plan disagrees with RULES.md, follow RULES.md.
- The source code is on GitHub: `948573034jackie-cpu/meh`, branch `claude/readalong-app`.
  If you can open GitHub, please read the code there, especially `src/core` (reusable logic without Electron),
  `src/renderer/reader` (the two reading screens), `src/core/listen` (the listening teaching flow),
  `src/core/ai` and `src/shared/styles.ts` (AI prompts and teaching styles).

**What I want from you**
1. Read HOW-IT-WORKS.md and RULES.md first.
2. Ask me what the other app is and what it already does, if I have not told you yet.
3. Then repeat back in 5 to 10 short lines what you will combine, how, and in what order, and wait for my OK.
4. Build in small steps. After every 2 or 3 features, give me a version I can test, and tell me how long each
   step will take before you start it.
5. Keep all my rules: the listening rule (word said 3 times, 5-second commands window with "I know", "I don't
   know", "go on", nothing sent to the AI in that window, then the explanation, then reading again from the same
   sentence), explanations in easy English with no filler, Chinese only as two meanings at the end with a Chinese
   voice, everything saved, and everything customisable.
6. Reuse the existing code in `src/core` where you can instead of rewriting it; it has about 650 tests.
7. Test everything before you give it to me, and tell me honestly what you could not test (for example, sound on
   a real Mac).

The other app is: **[describe the other app here, or attach it]**

---

## Tips for working with the other chat
- Send one topic per message when you can; long voice messages are fine, but ask it to repeat back what it
  understood before building.
- When something is wrong, send a screenshot or the error text instead of describing it.
- If it can open GitHub, it can read the real code, which works much better than descriptions.
