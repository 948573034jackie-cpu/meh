// Runs on claude.ai and chatgpt.com. Attaches a transcript file, types the message and presses Send.
// Written to survive small layout changes: several ways to find things, several ways to type, and it
// checks that the message really left the box.

if (!window.__ytChatLoaded) {
  window.__ytChatLoaded = true;

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

  const visible = (el) => !!el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);

  // ---- finding things ----
  function composer() {
    const sels = [
      '#prompt-textarea',                                        // ChatGPT
      'div.ProseMirror[contenteditable="true"]',                 // Claude / ChatGPT
      'div[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea'
    ];
    for (const s of sels) {
      const all = Array.from(document.querySelectorAll(s));
      const el = all.find(visible) || all[0];
      if (el) return el;
    }
    return null;
  }

  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',            // ChatGPT
    '#composer-submit-button',                      // ChatGPT (newer)
    'button[data-testid="composer-submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',            // Claude
    'button[aria-label^="Send"]'
  ];

  function sendButton() {
    for (const s of SEND_SELECTORS) {
      const b = Array.from(document.querySelectorAll(s)).find((x) => !x.disabled && x.getAttribute('aria-disabled') !== 'true');
      if (b) return b;
    }
    return null;
  }

  function fileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    // prefer an input that accepts any file / text; skip ones that only take images
    const general = inputs.find((i) => !i.accept || /text|\.txt|\*\/\*|\.\*/.test(i.accept));
    return general || inputs.find((i) => !/^image\//.test(i.accept || '')) || inputs[0] || null;
  }

  // ---- doing things ----
  function attachFile(name, text) {
    const input = fileInput();
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'text/plain' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const boxText = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText || el.textContent || '').trim();

  async function typeInto(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return boxText(el) ? 'textarea value' : null;
    }
    // 1) normal typing command
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    document.execCommand('insertText', false, text);
    await sleep(250);
    if (boxText(el)) return 'insertText';
    // 2) pretend to paste (rich editors handle this themselves)
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(250);
    if (boxText(el)) return 'paste';
    // 3) last resort: set the text and announce it
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    await sleep(250);
    return boxText(el) ? 'textContent' : null;
  }

  function pressEnter(el) {
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  function pageInfo() {
    return {
      path: location.pathname,
      composer: (() => { const c = composer(); return c ? c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') : null; })(),
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((i) => i.accept || '*'),
      sendButton: !!sendButton()
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'chat-ping') { sendResponse({ ok: true, path: location.pathname }); return; }
    if (msg.type !== 'chat-send') return;
    (async () => {
      const steps = [];
      try {
        const box = await waitFor(composer, 8000);
        if (!box) return sendResponse({ ok: false, error: 'no message box found on this page (is it in voice mode?)', steps, info: pageInfo() });

        let text = msg.text;
        if (msg.file) {
          if (attachFile(msg.file.name, msg.file.text)) { steps.push('file attached'); await sleep(1200); }
          else { steps.push('no file input; transcript pasted as text'); text += '\n\n--- TRANSCRIPT ---\n' + msg.file.text; }
        }

        const how = await typeInto(box, text);
        if (!how) return sendResponse({ ok: false, error: 'could not type into the message box', steps, info: pageInfo() });
        steps.push('typed (' + how + ')');

        // the Send button only enables after typing / after the file finished uploading (a missing button → Enter)
        const btn = await waitFor(sendButton, msg.file ? 12000 : 8000, 250); // uploads take longer
        let pressed = 'none';
        if (btn) { btn.click(); pressed = 'button'; }
        else { pressEnter(box); pressed = 'Enter'; }
        steps.push('send via ' + pressed);

        // did the message leave the box?
        let left = await waitFor(() => !boxText(box) || !document.contains(box), 4000, 200);
        if (!left && pressed === 'button') {
          pressEnter(box); steps.push('also pressed Enter');
          left = await waitFor(() => !boxText(box) || !document.contains(box), 4000, 200);
        }
        if (!left) return sendResponse({ ok: false, error: 'the message was typed but the Send button did not send it', steps, info: pageInfo() });
        sendResponse({ ok: true, steps });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), steps, info: pageInfo() });
      }
    })();
    return true;
  });
}
