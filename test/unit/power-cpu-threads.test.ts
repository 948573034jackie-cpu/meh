import { describe, it, expect, vi, afterEach } from 'vitest';

// the IPC handler and the page it came from: enough of Electron for registerPowerIpc
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => ipc.handlers.set(ch, fn) },
  powerSaveBlocker: { start: () => 0, stop: () => undefined, isStarted: () => false },
  app: { getPath: () => '/tmp/dream-read-power-test' },
}));
import { KeepAwake, registerPowerIpc } from '../../src/main/power';
import { physicalCores } from '../../src/main/cpu';
import { defaultSttThreads } from '../../src/main/stt/engine';

/** a powerSaveBlocker that records what it was asked */
function fakeBlocker() {
  const started = new Set<number>();
  let next = 1;
  const calls: string[] = [];
  return {
    calls, started,
    start: vi.fn((type: 'prevent-app-suspension' | 'prevent-display-sleep') => { calls.push(`start ${type}`); started.add(next); return next++; }),
    stop: vi.fn((id: number) => { calls.push(`stop ${id}`); started.delete(id); return true; }),
    isStarted: vi.fn((id: number) => started.has(id)),
  };
}

describe('KeepAwake (no App Nap while Listening plays)', () => {
  it('one blocker while any page holds it, released when the last one gives it back; repeated calls change nothing', () => {
    const b = fakeBlocker();
    const k = new KeepAwake(b);
    k.set(1, true); k.set(1, true);
    expect(b.calls).toEqual(['start prevent-app-suspension']);
    k.set(2, true);
    k.set(1, false);
    expect(k.active).toBe(true);
    k.set(2, false); k.set(2, false);
    expect(b.calls).toEqual(['start prevent-app-suspension', 'stop 1']);
    expect(k.active).toBe(false);
    k.set(3, true);
    expect(b.calls.at(-1)).toBe('start prevent-app-suspension');
  });

  it('app:keepAwake: a page that closes, reloads or crashes without saying so gives it back', () => {
    const b = fakeBlocker();
    const keep = registerPowerIpc(b);
    const handler = ipc.handlers.get('app:keepAwake')!;
    const listeners = new Map<string, () => void>();
    const sender = { id: 7, on: (ev: string, fn: () => void) => listeners.set(ev, fn), once: (ev: string, fn: () => void) => listeners.set(ev, fn) };
    handler({ sender }, true);
    expect(keep.active).toBe(true);
    listeners.get('did-navigate')!(); // reloaded: the new page reads nothing aloud
    expect(keep.active).toBe(false);
    handler({ sender }, true);
    handler({ sender }, 'yes'); // anything but true gives it back
    expect(keep.active).toBe(false);
    handler({ sender }, true);
    listeners.get('destroyed')!(); // the window closed
    expect(keep.active).toBe(false);
    expect(b.calls.filter((c) => c.startsWith('start'))).toHaveLength(3);
    expect(b.started.size).toBe(0);
  });
});

describe('physicalCores (Diagnostics)', () => {
  it('macOS: sysctl -n hw.physicalcpu; other systems and failures: null', async () => {
    const asked: string[][] = [];
    expect(await physicalCores('darwin', async (cmd, args) => { asked.push([cmd, ...args]); return '4\n'; })).toBe(4);
    expect(asked).toEqual([['sysctl', '-n', 'hw.physicalcpu']]);
    expect(await physicalCores('darwin', async () => 'garbage')).toBeNull();
    expect(await physicalCores('darwin', async () => { throw new Error('no sysctl'); })).toBeNull();
    expect(await physicalCores('linux', async () => '4')).toBeNull();
  });
});

describe('defaultSttThreads (speech recognition next to Kokoro)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('Intel Mac: physical cores minus one, 1 or 2 (Hyper-Threading reports 2 logical CPUs per core)', () => {
    vi.stubEnv('STT_THREADS', '');
    expect(defaultSttThreads(8, 'x64', 'darwin')).toBe(2); // 4-core/8-thread i5/i7
    expect(defaultSttThreads(4, 'x64', 'darwin')).toBe(1); // 2-core/4-thread 13"
    expect(defaultSttThreads(12, 'x64', 'darwin')).toBe(2); // 6-core i7
    expect(defaultSttThreads(2, 'x64', 'darwin')).toBe(1);
  });

  it('elsewhere unchanged: cores - 1, between 2 and 4', () => {
    vi.stubEnv('STT_THREADS', '');
    expect(defaultSttThreads(4, 'x64', 'linux')).toBe(3);
    expect(defaultSttThreads(8, 'x64', 'linux')).toBe(4);
    expect(defaultSttThreads(2, 'x64', 'linux')).toBe(2);
    expect(defaultSttThreads(8, 'arm64', 'darwin')).toBe(4); // Apple Silicon reports real cores
  });

  it('STT_THREADS overrides it (an A/B on the Mac); nonsense is ignored', () => {
    vi.stubEnv('STT_THREADS', '3');
    expect(defaultSttThreads(4, 'x64', 'darwin')).toBe(3);
    vi.stubEnv('STT_THREADS', '0');
    expect(defaultSttThreads(4, 'x64', 'darwin')).toBe(1);
    vi.stubEnv('STT_THREADS', 'two');
    expect(defaultSttThreads(8, 'x64', 'darwin')).toBe(2);
  });
});
