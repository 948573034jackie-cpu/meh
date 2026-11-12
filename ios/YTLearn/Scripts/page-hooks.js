// Runs in the PAGE's own JavaScript world of the YouTube window (the tutor itself runs in the private "ytc" world,
// and a prototype changed there would not reach YouTube's code). One job: while My tutor is on this page
// (<html data-ytc-tutor="1">), YouTube's "full screen" must not open Apple's own video player (it would hide the
// tutor's subtitles, card and page): the request is stopped here and the tutor is told (it then makes its own full
// screen, the video over the whole window). Nothing of the app is reachable from here: only a DOM event is sent.
(function () {
  if (window.__ytcHooks) return;
  window.__ytcHooks = true;
  try {
    var P = HTMLVideoElement.prototype;
    var orig = P.webkitEnterFullscreen;
    if (orig) {
      P.webkitEnterFullscreen = function () {
        if (document.documentElement.dataset.ytcTutor === '1') { document.dispatchEvent(new CustomEvent('ytc-fs-request')); return; }
        return orig.apply(this, arguments);
      };
    }
    var E = Element.prototype;
    ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen'].forEach(function (name) {
      var was = E[name];
      if (!was) return;
      E[name] = function () {
        if (document.documentElement.dataset.ytcTutor === '1') { document.dispatchEvent(new CustomEvent('ytc-fs-request')); return Promise.resolve(); }
        return was.apply(this, arguments);
      };
    });
  } catch (e) { /* the page keeps its own full screen */ }
})();
