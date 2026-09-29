'use strict';
// Runs on real macOS / Windows CI machines: proves the paste scripts are valid
// (AppleScript compiles / PowerShell parses). It does not press any keys.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildPasteCommand } = require('../../src/deliver');

const c = buildPasteCommand(process.platform, 'Claude');
if (!c) { console.log('no paste script for', process.platform); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-'));

if (process.platform === 'darwin') {
  const src = path.join(dir, 'paste.applescript');
  fs.writeFileSync(src, c.args[1]);
  execFileSync('osacompile', ['-o', path.join(dir, 'paste.scpt'), src], { stdio: 'inherit' });
  console.log('OK: AppleScript compiles');
} else if (process.platform === 'win32') {
  const script = Buffer.from(c.args[c.args.length - 1], 'base64').toString('utf16le');
  fs.writeFileSync(path.join(dir, 'paste.ps1'), script);
  const check = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(dir, 'paste.ps1')}',[ref]$t,[ref]$e);if($e.Count){$e|%{Write-Error $_.Message};exit 1}else{'OK: PowerShell parses'}`;
  console.log(execFileSync('powershell.exe', ['-NoProfile', '-Command', check]).toString());
} else {
  console.log('skipped on', process.platform);
}
