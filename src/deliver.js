'use strict';
// Gets a screenshot in front of Claude: the picture goes onto the clipboard,
// then the Claude desktop app is briefly brought forward, the picture is
// pasted (Cmd/Ctrl+V) and you are put straight back on the exact window you
// were reading.
//
// Safety rules every platform script follows:
//   1. If Claude is already in front, do not switch at all.
//   2. Only press paste once Claude is REALLY in front (polled, max ~1s).
//      If it never comes forward, paste nothing (never into your own page).
//   3. Switch back as fast as possible (short polling, no long fixed sleeps),
//      verify you are back on the same window, retry if not.
// Each script prints one line:  "ok <ms away>" | "ok-nofocus <ms>" | "not-running" | "wrong-window"
const { execFile } = require('child_process');

function safeName(name) {
  const n = String(name || 'Claude');
  if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(n)) throw new Error(`bad app name: ${n}`);
  return n;
}

function macScript(app) {
  return `
on frontName()
  tell application "System Events" to return name of first application process whose frontmost is true
end frontName

on nowMs()
  return (do shell script "perl -MTime::HiRes=time -e 'print int(time()*1000)'") as integer
end nowMs

on restorePrev(prevName, prevWinName)
  repeat 3 times
    tell application "System Events"
      set frontmost of application process prevName to true
      try
        if prevWinName is not "" then perform action "AXRaise" of (first window of application process prevName whose name is prevWinName)
      end try
    end tell
    repeat 10 times
      if my frontName() is prevName then return true
      delay 0.03
    end repeat
  end repeat
  return false
end restorePrev

tell application "System Events"
  if not (exists application process "${app}") then return "not-running"
  set prevName to name of first application process whose frontmost is true
  set prevWinName to ""
  try
    set prevWinName to name of window 1 of application process prevName
  end try
end tell

if prevName is "${app}" then
  tell application "System Events" to keystroke "v" using command down
  return "ok 0"
end if

set t0 to my nowMs()
tell application "${app}" to activate
set isFront to false
repeat 34 times
  if my frontName() is "${app}" then
    set isFront to true
    exit repeat
  end if
  delay 0.03
end repeat
if not isFront then
  my restorePrev(prevName, prevWinName)
  return "wrong-window"
end if

tell application "System Events" to keystroke "v" using command down
delay 0.08
set wentBack to my restorePrev(prevName, prevWinName)
set elapsedMs to (my nowMs()) - t0
if wentBack then return "ok " & elapsedMs
return "ok-nofocus " & elapsedMs
`.trim();
}

function winScript(app) {
  return `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CE {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static bool Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow(); uint pid;
    uint fgThread = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    if (IsIconic(h)) ShowWindow(h, 9);
    bool attached = false;
    if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    bool r = SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
    return r;
  }
}
"@
$prev = [CE]::GetForegroundWindow()
$p = Get-Process -Name '${app}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'not-running'; exit 0 }
$target = $p.MainWindowHandle
$ws = New-Object -ComObject WScript.Shell
if ($prev -eq $target) { $ws.SendKeys('^v'); Write-Output 'ok 0'; exit 0 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
[void][CE]::Focus($target)
for ($i = 0; $i -lt 34 -and [CE]::GetForegroundWindow() -ne $target; $i++) { Start-Sleep -Milliseconds 30 }
if ([CE]::GetForegroundWindow() -ne $target) {
  [void][CE]::Focus($prev)
  Write-Output 'wrong-window'; exit 0
}
$ws.SendKeys('^v')
Start-Sleep -Milliseconds 80
$back = $false
for ($n = 0; $n -lt 3 -and -not $back; $n++) {
  [void][CE]::Focus($prev)
  for ($i = 0; $i -lt 10 -and [CE]::GetForegroundWindow() -ne $prev; $i++) { Start-Sleep -Milliseconds 30 }
  $back = ([CE]::GetForegroundWindow() -eq $prev)
}
if ($back) { Write-Output ('ok ' + $sw.ElapsedMilliseconds) } else { Write-Output ('ok-nofocus ' + $sw.ElapsedMilliseconds) }
`;
}

function linuxScript(app) {
  return `
now() { date +%s%N | cut -b1-13; }
active() { xdotool getactivewindow 2>/dev/null; }
prev=$(active)
w=$(xdotool search --onlyvisible --name '^${app}$' | head -n1)
[ -z "$w" ] && w=$(xdotool search --onlyvisible --class '${app}' | head -n1)
[ -z "$w" ] && { echo not-running; exit 0; }
if [ "$prev" = "$w" ]; then xdotool key --clearmodifiers ctrl+v; echo "ok 0"; exit 0; fi
t0=$(now)
xdotool windowactivate "$w"
i=0; while [ "$(active)" != "$w" ] && [ $i -lt 34 ]; do i=$((i+1)); sleep 0.03; done
if [ "$(active)" != "$w" ]; then
  [ -n "$prev" ] && xdotool windowactivate "$prev"
  echo wrong-window; exit 0
fi
xdotool key --clearmodifiers ctrl+v
sleep 0.08
back=0
if [ -z "$prev" ]; then back=1; fi
n=0; while [ $back -eq 0 ] && [ $n -lt 3 ]; do
  n=$((n+1)); xdotool windowactivate "$prev"
  i=0; while [ "$(active)" != "$prev" ] && [ $i -lt 10 ]; do i=$((i+1)); sleep 0.03; done
  [ "$(active)" = "$prev" ] && back=1
done
t1=$(now)
if [ $back -eq 1 ]; then echo "ok $((t1-t0))"; else echo "ok-nofocus $((t1-t0))"; fi
`.trim();
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
  if (platform === 'linux') return { cmd: 'bash', args: ['-c', linuxScript(app)] };
  return null;
}

function defaultRun(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, env: env || process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// -> { ok:true, awayMs, focusRestored }  |  { ok:false, reason: 'unsupported'|'not-running'|'wrong-window'|'no-accessibility'|'failed', detail? }
async function pasteIntoApp({ platform = process.platform, appName = 'Claude', run = defaultRun } = {}) {
  const c = buildPasteCommand(platform, appName);
  if (!c) return { ok: false, reason: 'unsupported' };
  const res = await run(c.cmd, c.args);
  const last = res.stdout.trim().split(/\r?\n/).pop().trim();
  const m = /^(ok|ok-nofocus)(?:\s+(\d+))?$/.exec(last);
  if (res.code === 0 && m) return { ok: true, awayMs: m[2] ? Number(m[2]) : 0, focusRestored: m[1] === 'ok' };
  if (last === 'not-running') return { ok: false, reason: 'not-running' };
  if (last === 'wrong-window') return { ok: false, reason: 'wrong-window' };
  if (/1002|not allowed to send keystrokes|assistive access/i.test(res.stderr)) {
    return { ok: false, reason: 'no-accessibility', detail: res.stderr.trim() };
  }
  return { ok: false, reason: 'failed', detail: (res.stderr || res.stdout).trim().slice(0, 300) };
}

module.exports = { buildPasteCommand, pasteIntoApp, safeName, defaultRun };
