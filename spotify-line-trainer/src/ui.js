// Floating control panel (extension's isolated world). Talks to page.js via DOM events.
(function () {
  'use strict';
  if (window.__SLT_UI__) return;
  window.__SLT_UI__ = true;

  const SPEEDS = [0.3, 0.5, 0.75, 1];
  const REPS = [3, 5, 7, 10];
  const DEFAULTS = { mode: 'repeat', reps: 5, speed: 1, trainingReps: 5, trainingSpeeds: [0.3, 0.5, 0.75, 1], startFrom: 'first', autoNext: false, playFullAfter: true, minimized: false };
  let settings = Object.assign({}, DEFAULTS);
  let state = { active: false };

  const send = (type, extra) => document.dispatchEvent(new CustomEvent('slt-cmd', {
    detail: JSON.stringify(Object.assign({ type }, extra || {}))
  }));
  const pct = v => Math.round(v * 100) + '%';

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c);
    return el;
  }

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: "Circular", "Helvetica Neue", Arial, sans-serif; }
  .fab { position: fixed; right: 20px; bottom: 104px; z-index: 2147483646; width: 52px; height: 52px; border-radius: 50%;
    border: 0; background: #1ed760; color: #000; font-size: 24px; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.5); }
  .fab.on { animation: pulse 1.4s infinite; }
  @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(30,215,96,.6);} 50% { box-shadow: 0 0 0 10px rgba(30,215,96,0);} }
  .panel { position: fixed; right: 20px; bottom: 104px; z-index: 2147483647; width: 340px; max-height: calc(100vh - 130px); overflow: auto;
    background: #181818; color: #fff; border-radius: 12px; padding: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.6); font-size: 13px; }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .title { font-weight: 700; font-size: 15px; }
  .icon { background: transparent; border: 0; color: #b3b3b3; font-size: 18px; cursor: pointer; padding: 2px 6px; }
  .icon:hover { color: #fff; }
  .row { margin: 8px 0; }
  .label { color: #b3b3b3; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 5px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip { flex: 1; min-width: 52px; padding: 7px 0; border-radius: 999px; border: 1px solid #3e3e3e; background: #242424; color: #fff; cursor: pointer; font-size: 13px; }
  .chip:hover { border-color: #777; }
  .chip.sel { background: #1ed760; border-color: #1ed760; color: #000; font-weight: 700; }
  .hint { color: #8a8a8a; font-size: 11px; margin-top: 4px; }
  .check { display: flex; align-items: center; gap: 8px; color: #ddd; cursor: pointer; }
  .controls { display: flex; gap: 6px; margin-top: 12px; }
  .big { flex: 1; padding: 10px; border-radius: 999px; border: 0; font-weight: 700; font-size: 14px; cursor: pointer; background: #1ed760; color: #000; }
  .big.stop { background: #fff; }
  .nav { width: 40px; border-radius: 999px; border: 1px solid #3e3e3e; background: #242424; color: #fff; cursor: pointer; font-size: 14px; }
  .nav:disabled { opacity: .35; cursor: default; }
  .status { margin-top: 12px; background: #242424; border-radius: 8px; padding: 10px; }
  .meta { color: #1ed760; font-size: 12px; font-weight: 700; }
  .lyric { font-size: 16px; font-weight: 700; margin: 6px 0 4px; line-height: 1.3; }
  .next { color: #8a8a8a; font-size: 12px; }
  .msg { color: #f3c969; font-size: 12px; margin-top: 8px; }
  .bar { height: 4px; background: #3e3e3e; border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #1ed760; width: 0; }
  .ladder { display: flex; gap: 4px; margin-top: 6px; }
  .ladder span { flex: 1; text-align: center; font-size: 11px; padding: 3px 0; border-radius: 4px; background: #333; color: #aaa; }
  .ladder span.done { background: #1d5e35; color: #fff; }
  .ladder span.cur { background: #1ed760; color: #000; font-weight: 700; }
  `;

  const host = h('div', { id: 'slt-root' });
  const shadow = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const st = document.createElement('style'); st.textContent = CSS; shadow.append(st);
  }
  const root = h('div');
  shadow.append(root);

  function chipRow(values, isSel, onPick, fmt) {
    return h('div', { class: 'chips' }, values.map(v =>
      h('button', { class: 'chip' + (isSel(v) ? ' sel' : ''), 'data-v': String(v), onclick: () => onPick(v) }, fmt(v))));
  }

  function save() {
    try { chrome.storage.local.set({ sltSettings: settings }); } catch (e) { /* ignore */ }
  }
  function change(patch) {
    Object.assign(settings, patch);
    save();
    send('settings', { settings });
    render();
  }

  function render() {
    root.textContent = '';
    if (settings.minimized) {
      root.append(h('button', { class: 'fab' + (state.active ? ' on' : ''), title: 'Line Trainer', 'data-testid': 'slt-fab',
        onclick: () => change({ minimized: false }) }, '🎤'));
      return;
    }
    const training = settings.mode === 'training';
    const busy = state.active || state.loading || state.waitingNext || state.fullPlay;

    const panel = h('div', { class: 'panel', 'data-testid': 'slt-panel' },
      h('div', { class: 'head' },
        h('div', { class: 'title' }, '🎤 Line Trainer'),
        h('button', { class: 'icon', title: 'Minimize', onclick: () => change({ minimized: true }) }, '–')),

      h('div', { class: 'row' }, h('div', { class: 'label' }, 'Mode'),
        chipRow(['repeat', 'training'], v => settings.mode === v, v => change({ mode: v }),
          v => v === 'repeat' ? '🔁 Repeat' : '🏋️ Training')),

      training
        ? [
          h('div', { class: 'row' }, h('div', { class: 'label' }, 'Times at each speed'),
            chipRow(REPS, v => settings.trainingReps === v, v => change({ trainingReps: v }), v => v + '×')),
          h('div', { class: 'row' }, h('div', { class: 'label' }, 'Speed ladder (tap to include / skip)'),
            chipRow(SPEEDS, v => settings.trainingSpeeds.includes(v), v => {
              let list = settings.trainingSpeeds.includes(v) ? settings.trainingSpeeds.filter(x => x !== v) : settings.trainingSpeeds.concat(v);
              if (!list.length) list = [v];
              change({ trainingSpeeds: list.sort((a, b) => a - b) });
            }, pct),
            h('div', { class: 'hint' }, `Each line: ${settings.trainingSpeeds.map(pct).join(' → ')}, ${settings.trainingReps}× each = ${settings.trainingSpeeds.length * settings.trainingReps} plays, then the next line.`)),
          h('label', { class: 'row check' },
            (() => { const c = h('input', { type: 'checkbox', 'data-testid': 'slt-fullsong', onchange: e => change({ playFullAfter: e.target.checked }) }); c.checked = settings.playFullAfter; return c; })(),
            'At the end, play the whole song once at 100%')
        ]
        : [
          h('div', { class: 'row' }, h('div', { class: 'label' }, 'Repeat each line'),
            chipRow(REPS, v => settings.reps === v, v => change({ reps: v }), v => v + '×')),
          h('div', { class: 'row' }, h('div', { class: 'label' }, 'Speed'),
            chipRow(SPEEDS, v => settings.speed === v, v => change({ speed: v }), pct))
        ],

      h('div', { class: 'row' }, h('div', { class: 'label' }, 'Start from'),
        chipRow(['first', 'current'], v => settings.startFrom === v, v => change({ startFrom: v }),
          v => v === 'first' ? 'First line' : 'Current line')),

      h('label', { class: 'row check' },
        (() => { const c = h('input', { type: 'checkbox', 'data-testid': 'slt-autonext', onchange: e => change({ autoNext: e.target.checked }) }); c.checked = settings.autoNext; return c; })(),
        'Keep going with the next song'),

      h('div', { class: 'controls' },
        h('button', { class: 'nav', title: 'Previous line', disabled: '', 'data-testid': 'slt-prev', onclick: () => send('prev') }, '⏮'),
        h('button', { class: 'nav', title: 'Restart this line', disabled: '', 'data-testid': 'slt-restart', onclick: () => send('restart') }, '↻'),
        busy
          ? h('button', { class: 'big stop', 'data-testid': 'slt-toggle', onclick: () => send('stop') }, '■ Stop')
          : h('button', { class: 'big', 'data-testid': 'slt-toggle', onclick: () => send('start', { settings }) }, '▶ Start'),
        h('button', { class: 'nav', title: 'Next line', disabled: '', 'data-testid': 'slt-next', onclick: () => send('next') }, '⏭')),

      statusBox());
    if (state.active) panel.querySelectorAll('.nav').forEach(b => b.removeAttribute('disabled'));
    root.append(panel);
  }

  function statusBox() {
    if (!state.active && !state.loading && !state.message) return null;
    const box = h('div', { class: 'status', 'data-testid': 'slt-status' });
    if (state.active) {
      box.append(
        h('div', { class: 'meta', 'data-testid': 'slt-meta' },
          `Line ${state.line + 1}/${state.lineCount} · ${pct(state.rate)} · play ${state.rep + 1}/${state.reps}`),
        h('div', { class: 'lyric', 'data-testid': 'slt-lyric' }, state.text),
        state.nextText ? h('div', { class: 'next' }, 'Next: ' + state.nextText) : null);
      if (state.stageCount > 1) {
        box.append(h('div', { class: 'ladder' }, settings.trainingSpeeds.slice(0, state.stageCount).map((v, i) =>
          h('span', { class: i < state.stage ? 'done' : i === state.stage ? 'cur' : '' }, pct(v)))));
      }
      const bar = h('div', { class: 'bar' }, h('i'));
      bar.firstChild.style.width = (state.lineCount ? (100 * (state.line + 1) / state.lineCount) : 0) + '%';
      box.append(bar);
    }
    if (state.message) box.append(h('div', { class: 'msg', 'data-testid': 'slt-msg' }, state.message));
    return box;
  }

  let lastKey = '';
  document.addEventListener('slt-state', ev => {
    try { state = JSON.parse(ev.detail); } catch (e) { return; }
    const key = [state.active, state.loading, state.waitingNext, state.fullPlay, state.line, state.stage, state.rep, state.rate, state.message, state.text].join('|');
    if (key !== lastKey) { lastKey = key; render(); }
  });

  function mount() {
    if (!document.body) return setTimeout(mount, 100);
    document.body.append(host);
    render();
    send('ping');
  }

  try {
    chrome.storage.local.get('sltSettings', r => {
      if (r && r.sltSettings) settings = Object.assign({}, DEFAULTS, r.sltSettings);
      mount();
    });
  } catch (e) { mount(); }
})();
