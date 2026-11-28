/**
 * The voice log (I Know 3.13, step 1): every time the tutor's voice waited long, was tried again, was stopped from
 * outside or did not speak, with the reason, so the real cause of a gap can be found afterwards. Short lines, the
 * newest last; kept in the app's storage (`drVoiceLog`, the last MAX lines) so Settings can show and copy them.
 * No key and no app code is ever written here: only what happened, how long it took, and the first words of the text.
 */
export interface VoiceLogLine {
  /** when (ms since 1970) */
  at: number;
  /** what happened, in a few words: 'not spoken', 'try 2', 'slow start', 'paused from outside', … */
  what: string;
  /** the reason, as the service or the device gave it */
  why?: string;
  /** how long it took or waited, ms */
  ms?: number;
  /** the first words of the text (never more than 40 letters) */
  text?: string;
}

export const VOICE_LOG_KEY = 'drVoiceLog';
export const VOICE_LOG_MAX = 150;

// (the app runs the background and the page in one window: both copies of this file write the same list)
const shared = globalThis as unknown as { __drVoiceLog?: VoiceLogLine[] };
const lines = (): VoiceLogLine[] => (shared.__drVoiceLog ??= []);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const idOf = (l: VoiceLogLine): string => `${l.at}|${l.what}|${l.why ?? ''}|${l.text ?? ''}`;

/** the lines of both lists in the order of their time, each once, the newest MAX */
export function mergeVoiceLog(a: readonly VoiceLogLine[], b: readonly VoiceLogLine[]): VoiceLogLine[] {
  const seen = new Set<string>();
  const out: VoiceLogLine[] = [];
  for (const l of [...a, ...b]) {
    if (!l || typeof l.at !== 'number' || typeof l.what !== 'string') continue;
    const id = idOf(l);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(l);
  }
  return out.sort((x, y) => x.at - y.at).slice(-VOICE_LOG_MAX);
}

async function save(): Promise<void> {
  saveTimer = null;
  try {
    const got = (await chrome.storage.local.get(VOICE_LOG_KEY)) as Record<string, unknown>;
    const kept = Array.isArray(got[VOICE_LOG_KEY]) ? (got[VOICE_LOG_KEY] as VoiceLogLine[]) : [];
    await chrome.storage.local.set({ [VOICE_LOG_KEY]: mergeVoiceLog(kept, lines()) });
  } catch { /* no storage here (a test, a web page): the lines stay in memory */ }
}

/** one line more; it is saved a moment later (many lines in a row are one write) */
export function voiceLog(what: string, o: { why?: string; ms?: number; text?: string } = {}): void {
  const l: VoiceLogLine = { at: Date.now(), what };
  if (o.why) l.why = String(o.why).slice(0, 200);
  if (typeof o.ms === 'number' && Number.isFinite(o.ms)) l.ms = Math.round(o.ms);
  if (o.text) l.text = o.text.replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  const all = lines();
  all.push(l);
  if (all.length > VOICE_LOG_MAX) all.splice(0, all.length - VOICE_LOG_MAX);
  if (saveTimer === null && typeof chrome !== 'undefined' && chrome.storage?.local) saveTimer = setTimeout(() => { void save(); }, 1200);
}

/** the lines in memory now (tests, the check report) */
export function voiceLogNow(): VoiceLogLine[] { return [...lines()]; }

/** (tests) */
export function clearVoiceLog(): void { lines().length = 0; }

/** the saved lines and the ones in memory, the newest last */
export async function readVoiceLog(): Promise<VoiceLogLine[]> {
  try {
    const got = (await chrome.storage.local.get(VOICE_LOG_KEY)) as Record<string, unknown>;
    return mergeVoiceLog(Array.isArray(got[VOICE_LOG_KEY]) ? (got[VOICE_LOG_KEY] as VoiceLogLine[]) : [], lines());
  } catch { return voiceLogNow(); }
}

/** forgets every line (the "Clear" button) */
export async function forgetVoiceLog(): Promise<void> {
  clearVoiceLog();
  try { await chrome.storage.local.remove(VOICE_LOG_KEY); } catch { /* nothing kept */ }
}

const two = (n: number): string => String(n).padStart(2, '0');
/** one line as text: "14:03:27 not spoken · the Worker did not answer in time · 12.0 s · “It means to feel…”" */
export function voiceLogLineText(l: VoiceLogLine): string {
  const d = new Date(l.at);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return [`${time} ${l.what}`, l.why, typeof l.ms === 'number' ? `${(l.ms / 1000).toFixed(1)} s` : '', l.text ? `“${l.text}”` : ''].filter(Boolean).join(' · ');
}
/** the newest `n` lines as text, the newest last (for Copy) */
export function voiceLogText(all: readonly VoiceLogLine[], n = 60): string {
  return all.slice(-n).map(voiceLogLineText).join('\n');
}
