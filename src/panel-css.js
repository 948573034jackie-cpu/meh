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
.wave-wrap { position: relative; flex: none; height: 140px; }
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
.collapsed .wave-wrap, .collapsed .sub, .collapsed .status { display: none; }
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
  .row { gap: 6px 7px; }
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
}
`;
