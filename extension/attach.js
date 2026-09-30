// Injected into the chat tab (claude.ai / chatgpt.com). Puts the picture into the chat's
// message box exactly like a person attaching a file, WITHOUT focusing or switching tabs.
// Self-contained: chrome.scripting.executeScript serialises this one function into the page.
function claudeEyesAttach(b64, mime, name) {
  const toast = (text, bad) => {
    try {
      const old = document.getElementById('claude-eyes-toast');
      if (old) old.remove();
      const d = document.createElement('div');
      d.id = 'claude-eyes-toast';
      d.textContent = text;
      d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 12px;border-radius:8px;' +
        'font:13px system-ui,sans-serif;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.3);pointer-events:none;' +
        'background:' + (bad ? '#c2410c' : '#16a34a');
      document.documentElement.appendChild(d);
      setTimeout(() => d.remove(), 2500);
    } catch (_) { /* toast is only a nicety */ }
  };
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], name, { type: mime, lastModified: Date.now() });
    const dt = new DataTransfer();
    dt.items.add(file);

    // 1) the hidden "attach a file" input every chat page has
    const inputs = [...document.querySelectorAll('input[type="file"]')]
      .filter((i) => !i.disabled && (!i.accept || /image|\*\/\*|png|jpe?g/i.test(i.accept)));
    if (inputs.length) {
      const input = inputs[0];
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      toast('Claude Eyes: picture attached');
      return { ok: true, method: 'file-input' };
    }
    // 2) otherwise paste it into the message box
    const box = document.querySelector('#prompt-textarea, div.ProseMirror[contenteditable="true"], [contenteditable="true"], textarea');
    if (box) {
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      toast('Claude Eyes: picture attached');
      return { ok: true, method: 'paste' };
    }
    toast("Claude Eyes: couldn't find the message box", true);
    return { ok: false, error: 'no-message-box' };
  } catch (e) {
    toast('Claude Eyes: ' + e.message, true);
    return { ok: false, error: String(e && e.message || e) };
  }
}
if (typeof module !== 'undefined') module.exports = { claudeEyesAttach };
