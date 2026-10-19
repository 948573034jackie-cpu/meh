/**
 * Files in the browser. The renderer's contract is path based (pathForFile -> importFile(path)); a web page
 * has no paths, so pathForFile hands out a token ("web-file:<n>/<name>") that importFile resolves back to
 * the File object it stands for. The "Open a book" picker is a hidden <input type="file">: on iPad it
 * offers the Files app, iCloud Drive and other providers.
 */
const files = new Map<string, File>();
let counter = 0;
export const FILE_TOKEN_PREFIX = 'web-file:';

export function tokenForFile(file: File): string {
  const token = `${FILE_TOKEN_PREFIX}${++counter}/${file.name}`;
  files.set(token, file);
  return token;
}

export function takeFile(token: string): File | null {
  const f = files.get(token) ?? null;
  files.delete(token);
  return f;
}

/**
 * Opens the system file picker and resolves with the chosen file, or null when the learner cancels.
 * Must be called synchronously from a tap (Safari blocks pickers opened later).
 */
export function pickFile(accept = '.epub,.pdf,.txt,.md,application/epub+zip,application/pdf,text/plain,text/markdown'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-1000px';
    let settled = false;
    const finish = (f: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(f);
    };
    // 'cancel' fires when the picker is dismissed in recent Safari and Chrome. Without it the promise simply
    // stays pending, which is harmless; a focus-based guess would misfire on slow iCloud downloads.
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Hands a text file to the learner: the share sheet when the browser can share files (iPad: Save to Files,
 * AirDrop, Mail), else a download. Resolves with a short description of where it went.
 */
export async function saveTextFile(fileName: string, contents: string, mime = 'text/plain'): Promise<string> {
  const safe = String(fileName).replace(/[\\/:*?"<>|]+/g, '-').trim() || 'export.txt';
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const file = new File([blob], safe, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] }) && typeof nav.share === 'function') {
    try {
      await nav.share({ files: [file], title: safe });
      return `${safe} (shared)`;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return `${safe} (not saved)`;
      // NotAllowedError (no user gesture left after an await): fall back to a download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safe;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return `Downloads/${safe}`;
}
