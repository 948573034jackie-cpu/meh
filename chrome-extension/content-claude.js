// Runs on claude.ai. Receives a screenshot from the service worker and attaches it to the chat.

if (!window.__claudeSnapLoaded) {
  window.__claudeSnapLoaded = true;

  function dataUrlToFile(dataUrl) {
    const [head, b64] = dataUrl.split(',');
    const mime = (head.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1] || 'jpg';
    return new File([bytes], 'screenshot-' + Date.now() + '.' + ext, { type: mime });
  }

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 12px;border-radius:8px;' +
      'background:#1f1f1f;color:#fff;font:13px system-ui;opacity:.92;pointer-events:none';
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  function attach(file) {
    const dt = new DataTransfer();
    dt.items.add(file);

    // 1) The chat's hidden file input (the same thing the "attach" button uses).
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const input = inputs.find((i) => !i.accept || /image|\*/.test(i.accept)) || inputs[0];
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'file-input';
    }

    // 2) Otherwise pretend to paste the image into the message box.
    const box = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
    if (box) {
      box.focus();
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return 'paste';
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'claudesnap-attach') return;
    try {
      const via = attach(dataUrlToFile(msg.dataUrl));
      if (via) toast('📸 Screenshot sent to Claude');
      sendResponse({ ok: !!via, via });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  });
}
