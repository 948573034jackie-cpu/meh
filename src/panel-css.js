/* Styles for the looper panel. They live inside a shadow root, so YouTube's
 * CSS can't reach them and they can't leak into YouTube. */
globalThis.YTL_PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.panel {
  --bg: #0b0e14;
  --bg2: #121722;
  --bg3: #1a2130;
  --line: #262f42;
  --text: #e8ecf4;
  --muted: #8b95a8;
  --accent: #19d3ff;
  --accent-ink: #001a22;
  --a: #3ddc84;
  --b: #ff6b4a;
  --gold: #ffcf3d;
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.25 Roboto, "YouTube Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  border-top: 1px solid var(--line);
  box-shadow: 0 -10px 30px rgba(0,0,0,.45);
  user-select: none;
  -webkit-user-select: none;
}
.resize {
  position: absolute; left: 0; right: 0; top: -8px; height: 16px;
  cursor: ns-resize; z-index: 3;
}
.resize::after {
  content: ""; position: absolute; left: 50%; top: 5px; width: 72px; height: 6px;
  margin-left: -36px; border-radius: 3px; background: #4a5670; transition: background .12s;
}
.resize:hover::after { background: var(--accent); }
.row {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 6px 10px; padding: 6px 10px;
}
.bar { background: var(--bg2); border-bottom: 1px solid var(--line); padding-top: 7px; }
.bar.transport { background: #10151f; padding-top: 6px; }
.group { display: flex; align-items: center; gap: 4px; }
.sep { width: 1px; height: 22px; background: var(--line); margin: 0 2px; }
.spacer { flex: 1 1 auto; }
.brand { display: flex; align-items: center; gap: 6px; font-weight: 700; letter-spacing: .2px; color: #fff; margin-right: 2px; }
.brand svg { width: 18px; height: 18px; fill: var(--accent); }
.brand small { font-weight: 500; color: var(--muted); }
.label { color: var(--muted); font-size: 12px; }
button {
  font: inherit; color: var(--text); background: var(--bg3);
  border: 1px solid var(--line); border-radius: 8px;
  height: 28px; min-width: 28px; padding: 0 9px;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  cursor: pointer; white-space: nowrap; transition: background .12s, border-color .12s, color .12s;
}
button:hover { background: #222b3d; border-color: #34405a; }
button:active { transform: translateY(1px); }
button:disabled { opacity: .4; cursor: default; transform: none; }
button.icon { padding: 0; width: 28px; }
button svg { width: 16px; height: 16px; fill: currentColor; flex: none; }
button.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }
button.speed { min-width: 50px; font-weight: 600; }
button.play-btn { width: 44px; min-width: 44px; height: 32px; background: #1d3a46; border-color: #2b5666; color: #fff; }
button.play-btn svg { width: 22px; height: 22px; }
button.play-btn.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.zoom-toggle { min-width: 112px; font-weight: 600; }
button.speed.on { background: var(--gold); border-color: var(--gold); color: #241b00; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }
button.danger { color: #ffb4a6; }
.mark {
  display: flex; align-items: center; height: 28px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg3); overflow: hidden;
}
.mark button { border: 0; border-radius: 0; height: 26px; background: transparent; min-width: 22px; padding: 0 5px; }
.mark button:hover { background: #222b3d; }
.mark .set { font-weight: 800; padding: 0 8px; }
.mark.a .set { color: var(--a); }
.mark.b .set { color: var(--b); }
.mark .time {
  font-variant-numeric: tabular-nums; min-width: 62px; text-align: center; color: var(--text);
  padding: 0 2px; font-size: 12.5px;
}
.mark.pending { border-color: var(--a); box-shadow: 0 0 0 1px var(--a) inset; }
.rate {
  font-variant-numeric: tabular-nums; min-width: 52px; text-align: center; font-weight: 700;
  font-size: 14px; color: var(--gold); cursor: pointer; border-radius: 6px; padding: 4px 2px;
}
.rate:hover { background: var(--bg3); }
select {
  font: inherit; color: var(--text); background: var(--bg3); border: 1px solid var(--line);
  border-radius: 8px; height: 28px; padding: 0 6px; cursor: pointer;
}
label.check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text); }
label.check input { accent-color: var(--accent); width: 15px; height: 15px; margin: 0; }
.sub { background: #0f1420; border-bottom: 1px solid var(--line); }
.sub[hidden] { display: none; }
.progress { position: relative; width: 160px; height: 8px; border-radius: 4px; background: var(--bg3); overflow: hidden; }
.progress > i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(90deg, var(--a), var(--gold)); transition: width .25s; }
.tstat { font-variant-numeric: tabular-nums; color: var(--text); min-width: 140px; }
.tstat b { color: var(--gold); }
.stage { position: relative; display: flex; flex: none; height: 140px; }
.wave-wrap { position: relative; flex: 1 1 auto; min-width: 0; }
.lyrics {
  flex: 0 0 34%; min-width: 240px; max-width: 480px; display: flex; flex-direction: column;
  border-left: 1px solid var(--line); background: #0d1119;
  min-height: 0; overflow: hidden; /* a long song must scroll inside, never grow the panel */
}
.lyr-head { display: flex; gap: 4px; padding: 5px 6px; border-bottom: 1px solid var(--line); }
.lyr-head input {
  flex: 1 1 auto; min-width: 0; height: 28px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg3); color: var(--text); padding: 0 8px; font: inherit; outline: none;
}
.lyr-head input:focus { border-color: var(--accent); }
.lyr-meta { padding: 3px 8px; color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 18px; }
.lyr-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 8px 60px; -webkit-overflow-scrolling: touch; user-select: text; -webkit-user-select: text; }
.lyr-body p { margin: 0; padding: .2em .4em; border-radius: 6px; color: #b4bccc; font-size: var(--lyr-font, 15px); line-height: 1.35; transition: color .15s, background .15s; }
button.lyr-size { font-weight: 800; font-size: 13px; }
.lyr-resize { display: none; }
/* Lyrics on top of the screen (default on iPad/iPhone): big, karaoke style. */
.lyrics.top {
  position: fixed; left: 0; right: 0; top: 0; z-index: 4;
  flex: none; width: auto; min-width: 0; max-width: none;
  border-left: 0; border-bottom: 1px solid #33405a;
  background: rgba(8, 11, 17, .97); box-shadow: 0 10px 30px rgba(0,0,0,.55);
  padding-top: env(safe-area-inset-top, 0px);
}
.lyrics.top .lyr-meta { text-align: center; }
.lyrics.top .lyr-body { text-align: center; padding: 8px 16px 40%; }
.lyrics.top .lyr-body p { line-height: 1.3; }
.lyrics.top .lyr-resize {
  display: block; position: absolute; left: 0; right: 0; bottom: 0; height: 22px; cursor: ns-resize; z-index: 5; touch-action: none;
  background: linear-gradient(transparent, rgba(8,11,17,.9));
}
.lyrics.top .lyr-resize::after {
  content: ""; position: absolute; left: 50%; top: 9px; width: 90px; height: 7px; margin-left: -45px; border-radius: 4px; background: #4a5670;
}
.lyrics.top .lyr-resize:hover::after { background: var(--accent); }
.lyr-body.synced p { cursor: pointer; position: relative; padding-left: 2.1em; padding-right: 2.1em; }
.lyr-loop {
  position: absolute; left: .25em; top: 50%; transform: translateY(-50%);
  width: 1.5em; height: 1.5em; min-width: 26px; min-height: 26px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  color: #5d6780; border: 1px solid #2a3348; background: rgba(255,255,255,.03);
}
.lyr-loop svg { width: 62%; height: 62%; fill: currentColor; }
.lyr-body p:hover .lyr-loop, .lyr-body p.now .lyr-loop { color: #b9a4ff; border-color: #4b3f78; }
.lyr-body p.looping { background: rgba(190,120,255,.22); color: #fff; font-weight: 700; }
.lyr-body p.looping .lyr-loop { color: #1a0b2e; background: #c084fc; border-color: #c084fc; }
.lyr-body.synced p:hover { background: rgba(255,255,255,.05); }
.lyr-body p.past { color: #6f788b; }
.lyr-body p.now { color: #fff; background: rgba(25,211,255,.16); font-weight: 700; }
.lyr-msg { color: var(--muted); padding: 10px 6px; line-height: 1.4; }
.lyr-sync { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 2px 6px 4px; }
.lyr-sync button { height: 24px; padding: 0 8px; font-size: 12px; border-radius: 12px; }
.lyr-off { color: var(--muted); font-size: 12px; min-width: 96px; text-align: center; font-variant-numeric: tabular-nums; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.overlay {
  position: absolute; left: 50%; top: 55%; transform: translate(-50%, -50%);
  display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 10px;
  background: rgba(10, 14, 22, .88); border: 1px solid var(--line); box-shadow: 0 6px 24px rgba(0,0,0,.5);
  font-size: 13px; white-space: nowrap; pointer-events: auto; z-index: 2;
}
.overlay[hidden] { display: none; }
.tip {
  position: absolute; top: 20px; padding: 2px 6px; border-radius: 4px; background: #000c;
  color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; pointer-events: none;
  transform: translateX(-50%); white-space: nowrap; z-index: 2;
}
.tip[hidden] { display: none; }
.status { display: flex; align-items: center; gap: 10px; padding: 4px 10px; min-height: 30px; background: var(--bg2); border-top: 1px solid var(--line); }
.hint { color: var(--muted); flex: 1 1 auto; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint b { color: var(--text); font-weight: 600; }
.chips { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; overflow-x: auto; max-width: 55%; scrollbar-width: thin; }
.chip {
  display: inline-flex; align-items: center; height: 22px; border-radius: 11px; border: 1px solid var(--line);
  background: var(--bg3); font-size: 12px; overflow: hidden; flex: none;
}
.chip button { height: 20px; border: 0; background: transparent; border-radius: 0; padding: 0 8px; font-size: 12px; min-width: 0; }
.chip button.x { padding: 0 6px 0 2px; color: var(--muted); }
.chip.active { border-color: var(--accent); }
.chip.add button { color: var(--accent); }
.count { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.count b { color: var(--text); }
.collapsed .stage, .collapsed .sub, .collapsed .status { display: none; }
.help {
  position: absolute; right: 10px; bottom: 36px; z-index: 5; width: min(520px, calc(100% - 20px));
  max-height: calc(100% - 50px); overflow: auto; padding: 14px 16px; border-radius: 12px;
  background: #0f1420; border: 1px solid #33405a; box-shadow: 0 12px 40px rgba(0,0,0,.6); line-height: 1.5;
}
.help[hidden] { display: none; }
.help h3 { margin: 0 0 6px; font-size: 15px; color: #fff; }
.help ol, .help ul { margin: 4px 0 10px; padding-left: 20px; }
.help kbd {
  display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 4px; border: 1px solid #3a4560;
  background: #1a2130; font: 600 11px/18px ui-monospace, Menlo, monospace; text-align: center; color: #fff;
}
.help .close { position: absolute; right: 8px; top: 8px; }
@media (max-width: 1400px) {
  .brand-name, .hide-narrow { display: none; }
  .row { gap: 6px 5px; }
  .lyrics-btn .txt { display: none; }
  .lyrics-btn { width: 28px; padding: 0; }
  button.speed { min-width: 46px; }
}
@media (max-width: 900px) {
  .chips { max-width: 40%; }
}
/* Fingers: bigger targets (iPad, iPhone, touch laptops). */
@media (any-pointer: coarse) {
  button { height: 38px; min-width: 38px; border-radius: 10px; font-size: 14px; }
  button.icon { width: 38px; }
  button svg { width: 20px; height: 20px; }
  .mark { height: 38px; }
  .mark button { height: 36px; min-width: 30px; }
  select { height: 38px; font-size: 14px; }
  .chip { height: 30px; border-radius: 15px; }
  .chip button { height: 28px; font-size: 13px; }
  .resize { top: -12px; height: 24px; }
  .lyr-head input { height: 38px; font-size: 16px; }
  .lyrics-btn { width: 38px; }
  .lyr-sync button { height: 32px; font-size: 13px; padding: 0 12px; border-radius: 16px; }
  button.play-btn { width: 60px; min-width: 60px; height: 44px; }
  button.play-btn svg { width: 28px; height: 28px; }

  .resize::after { top: 9px; width: 90px; margin-left: -45px; }
  .help { font-size: 14px; }
}
/* Phones: compact rows so the wave keeps most of the space. */
@media (max-width: 600px) {
  .brand, .sep, .label.hide-narrow, .size-btns, .hide-phone { display: none !important; }
  .row { padding: 5px 6px; gap: 5px; }
  .group { gap: 3px; }
  button { padding: 0 6px; gap: 4px; }
  button.icon { width: 36px; min-width: 36px; }
  select { padding: 0 2px; font-size: 13px; }
  .status { flex-wrap: wrap; gap: 4px 8px; padding: 4px 8px; }
  .hint { flex-basis: 100%; }
  .mark .time { min-width: 54px; font-size: 12px; }
  .mark .set { padding: 0 6px; }
  button.speed { min-width: 46px; }
  button.zoom-toggle { min-width: 0; }
  .rate { min-width: 42px; font-size: 13px; }
  .spacer { display: none; }
  .hint { font-size: 12px; white-space: normal; }
  .chips { max-width: none; flex: 1 1 auto; }
  .tstat { min-width: 0; flex-basis: 100%; }
  .progress { flex: 1 1 auto; width: auto; }
  .stage { flex-direction: column-reverse; }
  .lyrics { flex: 0 0 170px; min-width: 0; max-width: none; border-left: 0; border-bottom: 1px solid var(--line); }
  .wave-wrap { min-height: 80px; }
  .lyrics-btn { width: 36px; min-width: 36px; }
  button.play-btn { width: 52px; min-width: 52px; height: 44px; }
  .rate { display: none; } /* the lit speed button and the trainer row show the speed */
  button.speed { min-width: 41px; padding: 0 5px; }
  .bar { padding-left: 4px; padding-right: 4px; }
  .rate { min-width: 38px; font-size: 12.5px; }
}
`;
