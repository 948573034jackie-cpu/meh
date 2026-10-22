// Safari: use Safari's own promise-based "browser" API under the name "chrome". In Chrome this does nothing.
(function () {
  try {
    if (typeof browser !== 'undefined' && browser && browser.runtime && browser.runtime.id) {
      self.__ytcSafari = true;
      try { self.chrome = browser; } catch (e) { /* Safari's own "chrome" stays */ }
    }
  } catch (e) { /* ignore */ }
})();
