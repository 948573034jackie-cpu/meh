/**
 * Live Chinese translation by the AI (the cheap, fast model, streamed): each line of the reading page gets its
 * Chinese under it as soon as the model writes it, and a word on the card gets the meaning that fits its sentence.
 * Results are kept per video, so a line is translated once.
 */
import type { PromptBundle } from '@core/ai/prompts';

export function buildLinesPrompt(lines: string[], title: string): PromptBundle {
  return {
    system: 'You translate the English subtitles of a YouTube video into natural, easy Simplified Chinese for a Chinese learner of English. Keep the meaning exactly; no explanations.',
    user: `Video: ${title || 'YouTube video'}\nTranslate each numbered line into Simplified Chinese. Answer with exactly one line per input line, in the same order, in the form "<number>. <Chinese>", and nothing else.\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    maxTokens: Math.min(4000, 120 + lines.reduce((n, l) => n + l.length * 2, 0)),
  };
}

/** The complete lines of a (partial) streamed answer: number (1-based) -> Chinese. A last line still being written is left out unless `final`. */
export function parseLines(raw: string, count: number, final = false): Map<number, string> {
  const out = new Map<number, string>();
  const rows = raw.split(/\r?\n/);
  if (!final) rows.pop(); // may be incomplete
  for (const row of rows) {
    const m = /^\s*(\d+)\s*[.、:：)]\s*(.+?)\s*$/.exec(row);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= count && m[2]) out.set(n, m[2]);
  }
  return out;
}

export function buildWordPrompt(word: string, sentence: string): PromptBundle {
  return {
    system: 'You give the Simplified Chinese meaning of an English word or phrase as it is used in one sentence. Answer only with the Chinese.',
    user: `Sentence: ${sentence}\nWord or phrase: ${word}\nGive one or two short Chinese meanings that fit this sentence, separated by "；". Nothing else.`,
    maxTokens: 60,
  };
}

/** "一丝不苟的；细致的" -> ["一丝不苟的", "细致的"] */
export function parseWordMeanings(raw: string): [string, string] | null {
  const parts = raw.replace(/["“”]/g, '').split(/[；;，,、/\n]/).map((x) => x.trim()).filter((x) => /[㐀-鿿]/.test(x));
  if (!parts.length) return null;
  return [parts[0], parts[1] ?? ''];
}
