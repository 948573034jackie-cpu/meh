import { ipcMain, powerSaveBlocker, type WebContents } from 'electron';

type Blocker = Pick<typeof powerSaveBlocker, 'start' | 'stop' | 'isStarted'>;

/**
 * Keeps macOS from suspending the app (App Nap) while the book is read aloud in Listening mode: a napped app's timers
 * are coalesced and delayed, so the stop at a hard word, the pauses and the 5-second windows would drift. Pages ask for
 * it (window.readalong.keepAwake) and give it back on pause, stop, Reading mode and when the book closes; a page that
 * goes away (window closed, reloaded, crashed) gives it back too. 'prevent-app-suspension' keeps the app running, not
 * the display on. One blocker for all pages; it runs while any page holds it.
 */
export class KeepAwake {
  private holders = new Set<number>();
  private id: number | null = null;
  constructor(private readonly blocker: Blocker) {}

  set(holder: number, on: boolean): void {
    if (on) this.holders.add(holder); else this.holders.delete(holder);
    if (this.holders.size && this.id === null) this.id = this.blocker.start('prevent-app-suspension');
    else if (!this.holders.size && this.id !== null) {
      if (this.blocker.isStarted(this.id)) this.blocker.stop(this.id);
      this.id = null;
    }
  }

  get active(): boolean { return this.id !== null; }
}

/** app:keepAwake(on): the sending page holds (true) or gives back (false) the blocker. */
export function registerPowerIpc(blocker: Blocker = powerSaveBlocker): KeepAwake {
  const keep = new KeepAwake(blocker);
  const watched = new Set<number>();
  ipcMain.handle('app:keepAwake', (e, on: boolean) => {
    const wc: WebContents = e.sender;
    const id = wc.id;
    keep.set(id, on === true);
    if (watched.has(id)) return;
    watched.add(id);
    const release = () => keep.set(id, false);
    // the page is gone or replaced without telling us (closing a window does not run React's clean-ups)
    wc.on('did-navigate', release);
    wc.on('render-process-gone', release);
    wc.once('destroyed', () => { release(); watched.delete(id); });
  });
  return keep;
}
