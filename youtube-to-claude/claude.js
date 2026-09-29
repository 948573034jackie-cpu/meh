// Runs on claude.ai. Attaches a transcript file and types + sends the message.

if (!window.__ytToClaudeClaudeLoaded) {
  window.__ytToClaudeClaudeLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout, step = 150) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function composer() {
    return document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"]') ||
      document.querySelector('textarea');
  }

  function sendButton() {
    const cands = Array.from(document.querySelectorAll('button'));
    return cands.find((b) => /send/i.test(b.getAttribute('aria-label') || '') && !b.disabled) || null;
  }

  function attachFile(name, text) {
    const input = document.querySelector('input[type="file"]');
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function insertText(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (document.execCommand('insertText', false, text)) return true;
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'claude-ping') { sendResponse({ ok: true, path: location.pathname }); return; }
    if (msg.type !== 'claude-send') return;
    (async () => {
      const steps = [];
      try {
        const box = await waitFor(composer, 8000);
        if (!box) return sendResponse({ ok: false, error: 'no message box found on this claude.ai page', steps });
        let text = msg.text;
        if (msg.file) {
          if (attachFile(msg.file.name, msg.file.text)) { steps.push('file attached'); await sleep(800); }
          else { steps.push('no file input; pasted transcript as text'); text += '\n\n--- TRANSCRIPT ---\n' + msg.file.text; }
        }
        insertText(box, text);
        steps.push('text typed');
        const btn = await waitFor(sendButton, 20000, 200);
        if (btn) { btn.click(); steps.push('send clicked'); }
        else {
          box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          steps.push('no enabled send button; pressed Enter');
        }
        sendResponse({ ok: true, steps });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), steps });
      }
    })();
    return true;
  });
}
