/**
 * Entry of the web (iPad) build, bundled by scripts/build-web.mjs. Module order matters: install.ts sets
 * window.readalong before the renderer's modules run, then the unchanged renderer starts, then web.css
 * (bundled after the renderer's CSS) adapts it to touch and safe areas.
 */
import './install';
import '../renderer/main';
import './web.css';

// The renderer marks MacIntel (which iPadOS reports) as "mac" to leave room for traffic lights; there are none here.
document.documentElement.dataset.platform = 'web';
