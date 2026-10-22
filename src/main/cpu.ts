import os from 'node:os';
import { execFile } from 'node:child_process';

/** Runs a command and resolves with its stdout (rejects on any failure). */
type Run = (cmd: string, args: string[]) => Promise<string>;

const runCommand: Run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

let physicalOnce: Promise<number | null> | null = null;

/**
 * Physical CPU cores (Diagnostics). Intel Macs report two logical CPUs per core (Hyper-Threading), which os.cpus()
 * cannot tell apart; macOS gives the real count with `sysctl -n hw.physicalcpu`, asked once, asynchronously (never on
 * the main thread's critical path). Null on other systems or when the command fails.
 */
export function physicalCores(platform: string = process.platform, run: Run = runCommand): Promise<number | null> {
  if (platform !== 'darwin') return Promise.resolve(null);
  if (run !== runCommand) return readPhysical(run);
  physicalOnce ??= readPhysical(run);
  return physicalOnce;
}

async function readPhysical(run: Run): Promise<number | null> {
  try {
    const n = Number((await run('sysctl', ['-n', 'hw.physicalcpu'])).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** The processor for Diagnostics: its model name, logical CPUs and physical cores (macOS). */
export async function cpuInfo(): Promise<{ model: string; logical: number; physical: number | null }> {
  const cpus = os.cpus();
  return { model: cpus[0]?.model?.trim() || 'unknown', logical: cpus.length, physical: await physicalCores() };
}
