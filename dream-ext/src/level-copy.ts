/**
 * "Copy my level for Claude". Safari and the iPhone apps only allow a copy that starts during the tap, and the text comes
 * from the background a moment later: the copy starts at once with a promise of the text. Where copying is not
 * allowed at all, the text is shown, selected, for the learner to copy by hand.
 */
function showForCopy(text: string): void {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.6);display:flex;flex-direction:column;justify-content:center;padding:16px;gap:8px';
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.cssText = 'width:100%;height:50vh;font:14px/1.4 -apple-system,system-ui,sans-serif;border-radius:10px;padding:8px;color:#1f2328;background:#fff';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.cssText = 'font:600 15px -apple-system,system-ui,sans-serif;padding:10px;border:0;border-radius:10px;background:#fff;color:#1f2328';
  close.onclick = () => box.remove();
  box.append(area, close);
  (document.body ?? document.documentElement).appendChild(box);
  area.focus();
  area.select();
}

/** 'copied', or 'shown' when the text is on the screen for copying by hand; rejects only when the text itself failed */
export async function copyLevel(): Promise<'copied' | 'shown'> {
  const ask = chrome.runtime.sendMessage({ type: 'dream-level-copy' }) as Promise<{ text: string }>;
  let done = false;
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': ask.then((r) => new Blob([r.text], { type: 'text/plain' })) })]);
      done = true;
    }
  } catch { /* below */ }
  const { text } = await ask;
  if (done) return 'copied';
  try { await navigator.clipboard.writeText(text); return 'copied'; } catch { showForCopy(text); return 'shown'; }
}
