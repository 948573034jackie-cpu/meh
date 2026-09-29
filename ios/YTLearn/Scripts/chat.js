// Runs on claude.ai and chatgpt.com. Attaches a transcript file, types the message and presses Send.
// Written to survive small layout changes: several ways to find things, several ways to type, and it
// checks that the message really left the box.

(function () {
  'use strict';
  if (window.__ytChatLoaded) return;
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

  function sendButtonAny() { // even if it is disabled right now (e.g. while a file uploads)
    for (const s of SEND_SELECTORS) {
      const b = document.querySelector(s);
      if (b) return b;
    }
    return null;
  }
  function sendButton() {
    for (const s of SEND_SELECTORS) {
      const b = Array.from(document.querySelectorAll(s)).find((x) => !x.disabled && x.getAttribute('aria-disabled') !== 'true');
      if (b) return b;
    }
    return null;
  }

  function fileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    // an input that only takes images is useless for a text file (mobile ChatGPT has only those)
    return inputs.find((i) => !i.accept || /text|\.txt|\.md|\*\/\*|\.\*|application\//i.test(i.accept)) || null;
  }

  // an input that takes pictures (Claude's takes everything; a text-only one would refuse)
  function imageInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return inputs.find((i) => !i.accept || /image|\*\/\*|\.\*/i.test(i.accept)) || null;
  }
  function dataUrlToFile(dataUrl, name) {
    const [head, b64] = dataUrl.split(',');
    const mime = (head.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || 'video.jpg', { type: mime });
  }
  function attachImage(img, box) {
    const file = dataUrlToFile(img.dataUrl, img.name);
    const input = imageInput();
    if (input) {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'file input';
    }
    const dt = new DataTransfer(); // no file input: paste the picture into the message box
    dt.items.add(file);
    box.focus();
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'paste';
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
    await sleep(120);
    if (boxText(el)) return 'insertText';
    // 2) pretend to paste (rich editors handle this themselves)
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(120);
    if (boxText(el)) return 'paste';
    // 3) last resort: set the text and announce it
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    await sleep(250);
    return boxText(el) ? 'textContent' : null;
  }

  function pressEnter(el, mods) {
    el.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, Object.assign({ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }, mods || {})));
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
    if (msg.type === 'chat-state') { const b = composer(); sendResponse({ boxText: b ? boxText(b).length : -1 }); return; }
    if (msg.type === 'chat-focus') { const b = composer(); if (b) b.focus(); sendResponse({ ok: !!b }); return; }
    if (msg.type !== 'chat-send') return;
    (async () => {
      const steps = [];
      const t00 = Date.now();
      const mark = (s) => steps.push(s + ' (' + ((Date.now() - t00) / 1000).toFixed(1) + 's)');
      try {
        const box = await waitFor(composer, 8000);
        if (!box) return sendResponse({ ok: false, error: 'no message box found on this page (is it in voice mode?)', steps, info: pageInfo() });

        let text = msg.text;
        if (msg.file) {
          if (attachFile(msg.file.name, msg.file.text)) { mark('file attached'); }
          else { mark('no file input for text; transcript pasted into the message'); text = text.replace('The full transcript is attached', 'The full transcript is pasted at the end of this message') + '\n\n--- TRANSCRIPT ---\n' + msg.file.text; }
        }

        if (msg.image && msg.image.dataUrl) {
          if (msg.file) await sleep(700); // let the page finish taking the first file
          try { mark('picture attached via ' + attachImage(msg.image, box)); await sleep(500); } catch (e) { mark('picture failed: ' + e.message); }
        }

        const how = await typeInto(box, text);
        if (!how) return sendResponse({ ok: false, error: 'could not type into the message box', steps, info: pageInfo() });
        mark('typed via ' + how);

        if (msg.dryRun) { mark('dry run: typed, not sent'); return sendResponse({ ok: true, dryRun: true, steps, info: pageInfo(), boxChars: boxText(box).length }); }
        // Send. Click the Send button when it is ready; if the page has none, press Enter.
        // After every try, check that the message really left the box.
        // "Sent" = the box emptied, the box was replaced, or the page moved to another chat address.
        const path0 = location.pathname;
        const gone = (ms) => waitFor(() => !boxText(box) || !document.contains(box) || location.pathname !== path0, ms || 2000, 200);
        const t0 = Date.now();
        const limit = t0 + (msg.file || msg.image ? 25000 : 12000); // a file upload can take a while
        let left = false, clicks = 0, enters = 0;
        while (!left && Date.now() < limit && clicks < 2 && enters < 2) {
          const btn = sendButton();
          if (btn) { btn.click(); clicks++; mark('clicked Send'); left = await gone(3000); }
          else if (!sendButtonAny() && Date.now() - t0 > 2500) { pressEnter(box); enters++; mark('pressed Enter'); left = await gone(); }
          else await sleep(400); // Send exists but is disabled (uploading), or still appearing
        }
        if (!left) { pressEnter(box, { ctrlKey: true, metaKey: true }); mark('pressed Ctrl/Cmd+Enter'); left = await gone(1500); }
        if (!left && enters === 0) { pressEnter(box); mark('pressed Enter'); left = await gone(); }
        if (!left) return sendResponse({ ok: false, needsTrustedEnter: true, error: 'the message was typed but the page did not send it', steps, info: pageInfo() });
        mark('done');
        sendResponse({ ok: true, steps });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), steps, info: pageInfo() });
      }
    })();
    return true;
  });
})();
