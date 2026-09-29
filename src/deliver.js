'use strict';
// Gets a screenshot in front of Claude: the picture goes onto the clipboard,
// then the Claude desktop app is briefly brought forward, the picture is
// pasted (Cmd/Ctrl+V) and focus returns to whatever you were using.
// Every platform script prints "ok" or "not-running" so results are uniform.
const { execFile } = require('child_process');

function safeName(name) {
  const n = String(name || 'Claude');
  if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(n)) throw new Error(`bad app name: ${n}`);
  return n;
}

function macScript(app) {
  return [
    'tell application "System Events"',
    `  if not (exists application process "${app}") then return "not-running"`,
    '  set prevName to name of first application process whose frontmost is true',
    'end tell',
    `tell application "${app}" to activate`,
    'delay 0.2',
    'tell application "System Events" to keystroke "v" using command down',
    'delay 0.3',
    `if prevName is not "${app}" then`,
    '  tell application "System Events" to set frontmost of application process prevName to true',
    'end if',
    'return "ok"',
  ].join('\n');
}

function winScript(app) {
  return `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CE { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
$prev = [CE]::GetForegroundWindow()
$p = Get-Process -Name '${app}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'not-running'; exit 0 }
$ws = New-Object -ComObject WScript.Shell
[void]$ws.AppActivate($p.Id)
Start-Sleep -Milliseconds 200
$ws.SendKeys('^v')
Start-Sleep -Milliseconds 300
[void][CE]::SetForegroundWindow($prev)
Write-Output 'ok'
`;
}

// Returns { cmd, args } for the platform, or null if unsupported.
function buildPasteCommand(platform, appName) {
  const app = safeName(appName);
  if (platform === 'darwin') return { cmd: 'osascript', args: ['-e', macScript(app)] };
  if (platform === 'win32') {
    const encoded = Buffer.from(winScript(app), 'utf16le').toString('base64');
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    };
  }
  if (platform === 'linux') {
    const sh =
      `prev=$(xdotool getactivewindow) || exit 1; ` +
      `w=$(xdotool search --onlyvisible --name '^${app}$' | head -n1); ` +
      `[ -z "$w" ] && w=$(xdotool search --onlyvisible --class '${app}' | head -n1); ` +
      `[ -z "$w" ] && { echo not-running; exit 0; }; ` +
      `xdotool windowactivate --sync "$w" && sleep 0.2 && xdotool key --clearmodifiers ctrl+v && sleep 0.3 && ` +
      `xdotool windowactivate "$prev"; echo ok`;
    return { cmd: 'sh', args: ['-c', sh] };
  }
  return null;
}

function defaultRun(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// -> { ok: boolean, reason?: 'unsupported'|'not-running'|'no-accessibility'|'failed', detail?: string }
async function pasteIntoApp({ platform = process.platform, appName = 'Claude', run = defaultRun } = {}) {
  const c = buildPasteCommand(platform, appName);
  if (!c) return { ok: false, reason: 'unsupported' };
  const res = await run(c.cmd, c.args);
  const out = res.stdout.trim();
  if (res.code === 0 && out.endsWith('ok')) return { ok: true };
  if (out.endsWith('not-running')) return { ok: false, reason: 'not-running' };
  if (/1002|not allowed to send keystrokes|assistive access/i.test(res.stderr)) {
    return { ok: false, reason: 'no-accessibility', detail: res.stderr.trim() };
  }
  return { ok: false, reason: 'failed', detail: (res.stderr || out).trim().slice(0, 300) };
}

module.exports = { buildPasteCommand, pasteIntoApp, safeName };
