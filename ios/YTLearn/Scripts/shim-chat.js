// Chat side (claude.ai / chatgpt.com web view): Swift calls window.__ytcDeliver(message) and gets the answer back.
(function () {
  if (window.__ytcShimChat) return;
  window.__ytcShimChat = true;
  window.__ytcDeliver = (msg) => window.__ytcDispatch(msg, {});
})();
