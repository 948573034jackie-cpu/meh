// Chat side (claude.ai / chatgpt.com web view): Swift calls window.__ytcDeliver(message) and gets the answer back.
(function () {
  if (window.__ytcShimChat) return;
  window.__ytcShimChat = true;
  window.__ytcDeliver = (msg) => window.__ytcDispatch(msg, {});

  // The newest answer of the AI: how many answers there are, its text, and whether it is still being written.
  const ANSWER = [
    '[data-message-author-role="assistant"]',        // ChatGPT
    '[data-testid="assistant-message"]',
    '.font-claude-message',                          // Claude
    '[class*="font-claude-message"]'
  ];
  const BUSY = [
    '[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="Stop generating"]',
    'button[aria-label="Stop response"]', 'button[aria-label="Stop"]', '[data-is-streaming="true"]'
  ];
  window.__ytcReplyState = () => {
    let list = [];
    for (const s of ANSWER) { list = document.querySelectorAll(s); if (list.length) break; }
    const last = list.length ? list[list.length - 1] : null;
    return {
      count: list.length,
      text: last ? String(last.innerText || last.textContent || '').trim() : '',
      busy: BUSY.some((s) => !!document.querySelector(s))
    };
  };
})();
