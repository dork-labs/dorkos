import { beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEARTBEAT_DEADLINE_MS, LOADING_CEILING_MS, readRendererHealth } from '../index';
import { noteDocumentReplaced } from '../document-watermark';
import { app, BrowserWindow, session } from '../../__tests__/electron-mock';
import log from '../../__tests__/electron-log-mock';
import {
  ctx,
  expireDeadline,
  failTimes,
  fromWindow,
  health,
  navigate,
  reportedBy,
  seedHealth,
  send,
  settle,
  startMainFrameLoad,
  useSupervisor,
} from './supervisor.fixtures';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

useSupervisor();

describe('the health record', () => {
  it('reads a truncated file as nothing wrong yet, rather than refusing to start', () => {
    seedHealth('{ "consecutiveFailures": 3');

    expect(readRendererHealth().consecutiveFailures).toBe(0);
  });
});

describe('the heartbeat', () => {
  it('records a fresh, zeroed record — the signal the packaged smoke reads', () => {
    const before = Date.now();

    send('renderer:alive', fromWindow());

    expect(health().consecutiveFailures).toBe(0);
    expect(Date.parse(health().updatedAt)).toBeGreaterThanOrEqual(before);
  });

  it('disarms the deadline, so a healthy window is never reloaded', async () => {
    send('renderer:alive', fromWindow());

    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 3);

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
  });

  it('clears a failure count and the hardware-acceleration flag it left behind', async () => {
    await failTimes(3);
    expect(health().disableHardwareAcceleration).toBe(true);

    send('renderer:alive', fromWindow());

    expect(health().consecutiveFailures).toBe(0);
    expect(health().disableHardwareAcceleration).toBe(false);
  });

  // Only the primary window is supervised. A second cockpit window reporting
  // alive would clear the count on the window that is actually broken.
  it('ignores a heartbeat from a window it does not supervise', async () => {
    const other = new BrowserWindow();

    send('renderer:alive', { sender: other.webContents });
    await expireDeadline();

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  // `pointWindowsAtServer` in `server-crash-recovery.ts` sends every window to
  // a restarted server, for whatever reason the server was restarted — a
  // crash, the updater's stalled-restart recovery, either danger-zone button
  // in Settings. None of those goes through the ladder, so that function
  // stamps the shared watermark itself; otherwise the page it navigated away
  // from can still clear the count for a load that never came up.
  it('ignores a heartbeat from a page another part of the shell navigated away from', async () => {
    const stranded = Date.now();
    seedHealth(JSON.stringify({ consecutiveFailures: 2 }));

    // What `pointWindowsAtServer` does the moment the server is back.
    await vi.advanceTimersByTimeAsync(5);
    noteDocumentReplaced();

    send('renderer:alive', fromWindow(), reportedBy(stranded));

    expect(health().consecutiveFailures).toBe(2);

    // The page that navigation produced still clears it.
    await vi.advanceTimersByTimeAsync(2);
    send('renderer:alive', fromWindow(), reportedBy(Date.now()));

    expect(health().consecutiveFailures).toBe(0);
  });
});

// GitHub #1860, reported against desktop 0.75.0 (DOR-2041). The deadline used
// to be armed by `did-start-loading`, which Electron also fires for an iframe
// load and for a same-document navigation. Neither produces a heartbeat, so
// ten seconds after every route change — and every ten seconds while the
// canvas browser was open — the shell reloaded a window that was working.
describe('what starts the clock', () => {
  /** A window that has come up and reported for itself. */
  function healthyWindow(): void {
    send('renderer:alive', fromWindow(), reportedBy(Date.now()));
  }

  it('does not reload a healthy window because an iframe in it started loading', async () => {
    healthyWindow();

    await navigate({ isMainFrame: false, isSameDocument: false, url: 'https://dorkos.ai/' });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 2);
    await settle();

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
    expect(health().consecutiveFailures).toBe(0);
  });

  it('does not reload a healthy window because the app changed its route', async () => {
    healthyWindow();

    await navigate({
      isMainFrame: true,
      isSameDocument: true,
      url: 'http://localhost:4242/team',
    });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 2);
    await settle();

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
    expect(health().consecutiveFailures).toBe(0);
  });

  // The other half: a real new document is exactly what the deadline is for,
  // and one that never reports alive still gets the first rung.
  it('waits on a new document loading in the main frame', async () => {
    healthyWindow();

    await navigate({ isMainFrame: true, isSameDocument: false, url: 'http://localhost:4242/' });
    await expireDeadline();

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(health().consecutiveFailures).toBe(1);
  });
});

describe('the recovery ladder', () => {
  it('reloads on the first failure', async () => {
    await expireDeadline();

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(health().consecutiveFailures).toBe(1);
    expect(health().lastFailureAt).not.toBeNull();
  });

  it('clears the web cache before reloading on the second', async () => {
    await failTimes(2);

    expect(session.defaultSession.clearCache).toHaveBeenCalledTimes(1);
    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(health().consecutiveFailures).toBe(2);
  });

  it('still reloads on the second failure when the cache clear fails', async () => {
    session.defaultSession.clearCache = vi.fn(() => Promise.reject(new Error('cache locked')));

    await failTimes(2);

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });

  it('clears the GPU caches and relaunches without hardware acceleration on the third', async () => {
    for (const name of ['GPUCache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
      mkdirSync(join(ctx.userData, name), { recursive: true });
      writeFileSync(join(ctx.userData, name, 'entry.bin'), 'stale');
    }

    await failTimes(3);

    expect(existsSync(join(ctx.userData, 'GPUCache'))).toBe(false);
    expect(existsSync(join(ctx.userData, 'Code Cache'))).toBe(false);
    expect(existsSync(join(ctx.userData, 'DawnGraphiteCache'))).toBe(false);
    expect(existsSync(join(ctx.userData, 'DawnWebGPUCache'))).toBe(false);
    expect(health().disableHardwareAcceleration).toBe(true);
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    // Through the ordinary quit, so `quit-guard.ts` still asks about agents
    // that are mid-run and still stops the server first.
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(2);
  });

  it('gives up and loads the bundled recovery page on the fourth', async () => {
    await failTimes(4);

    expect(ctx.win.loadFile).toHaveBeenCalledTimes(1);
    expect(String(ctx.win.loadFile.mock.calls[0]?.[0])).toContain('fallback.html');
    expect(health().consecutiveFailures).toBe(4);
    expect(log.error).toHaveBeenCalled();
  });

  it('continues the ladder where the previous launch left it', async () => {
    seedHealth(JSON.stringify({ consecutiveFailures: 3, disableHardwareAcceleration: true }));

    await expireDeadline();

    expect(ctx.win.loadFile).toHaveBeenCalledTimes(1);
    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
  });

  it('stops laddering once the recovery page is up', async () => {
    await failTimes(4);
    vi.mocked(ctx.win.loadFile).mockClear();

    await vi.advanceTimersByTimeAsync(LOADING_CEILING_MS * 2);

    expect(ctx.win.loadFile).not.toHaveBeenCalled();
    expect(health().consecutiveFailures).toBe(4);
  });

  // Pins the yield in `afterTheStackUnwinds`. Reloading from inside the
  // crash handler's own stack takes the whole main process down with
  // SIGTRAP — measured under a real Electron. The observable half of that
  // fix is that no reload happens on the emitting stack.
  it('never reloads on the stack that reported the crash', async () => {
    await ctx.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 });

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();

    await settle();

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  // The echo that arrives after the rung has finished but before the reload
  // it issued has started: `ladderInFlight` is already null by then, so only
  // the recovering latch can refuse it.
  it('ignores a late echo of the failure it is already recovering from', async () => {
    await expireDeadline();
    expect(health().consecutiveFailures).toBe(1);

    await ctx.win.webContents.emit(
      'did-fail-load',
      {},
      -2,
      'ERR_FAILED',
      'http://localhost/',
      true
    );
    await settle();

    expect(health().consecutiveFailures).toBe(1);
    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(session.defaultSession.clearCache).not.toHaveBeenCalled();
  });

  // DOR-2034, reported against desktop 0.74.0: a first paint slower than the
  // deadline gets the window reloaded, and about 110ms later the heartbeat
  // the DISCARDED page had already sent arrives. Counting it as recovery put
  // the failure count back to zero, so the replacement load failed as rung 1
  // again — reload, reload, reload, never reaching the cache clear, and every
  // cycle throwing away unsent messages and half-typed settings.
  it('does not let the page it just reloaded put the ladder back to the start', async () => {
    const firstDocument = Date.now();

    await expireDeadline();
    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
    expect(health().consecutiveFailures).toBe(1);

    // The heartbeat that was already in flight when the reload went out.
    await vi.advanceTimersByTimeAsync(110);
    send('renderer:alive', fromWindow(), reportedBy(firstDocument));

    expect(health().consecutiveFailures).toBe(1);
    const ignored = log.warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(ignored).toContain('already replaced');

    // The replacement load fails the same way, and the ladder climbs.
    await startMainFrameLoad();
    await expireDeadline();

    expect(health().consecutiveFailures).toBe(2);
    expect(session.defaultSession.clearCache).toHaveBeenCalledTimes(1);
  });

  // The other half: the page the reload produced is the page being waited
  // on, and it clears the ladder exactly as it always did.
  it('lets the page the reload produced clear the ladder', async () => {
    await expireDeadline();
    await startMainFrameLoad();

    // A document that came into existence after the reload went out.
    await vi.advanceTimersByTimeAsync(200);
    send('renderer:alive', fromWindow(), reportedBy(Date.now()));

    expect(health().consecutiveFailures).toBe(0);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 2);

    // Still just the one reload: the deadline was cleared, not re-armed.
    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });
});

describe('failure signals', () => {
  it('recovers from a main-frame load failure', async () => {
    await ctx.win.webContents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'http://localhost:4242/',
      true
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  // ERR_ABORTED is what the app navigating itself looks like. Treating it as
  // a failure would reload the window on every internal link.
  it('ignores an aborted navigation', async () => {
    await ctx.win.webContents.emit(
      'did-fail-load',
      {},
      -3,
      'ERR_ABORTED',
      'http://localhost/',
      true
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
  });

  it('ignores a sub-frame load failure', async () => {
    await ctx.win.webContents.emit('did-fail-load', {}, -105, 'ERR', 'http://cdn/', false);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
  });

  it('recovers from a renderer process that went away', async () => {
    await ctx.win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 });
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a clean renderer exit', async () => {
    await ctx.win.webContents.emit(
      'render-process-gone',
      {},
      { reason: 'clean-exit', exitCode: 0 }
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
  });

  it('recovers from a window that stopped responding', async () => {
    await ctx.win.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  // Chromium respawns both of these on its own. Reloading a window that is
  // about to be fine is a worse outcome than waiting one deadline.
  it('logs a GPU crash without laddering, and names it when the heartbeat then fails', async () => {
    await app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();

    await expireDeadline();

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
    const reported = log.warn.mock.calls.map((args) => String(args[0])).join('\n');
    expect(reported).toContain('GPU process');
  });
});

describe('a slow load is not a failed load', () => {
  /**
   * Put the window's main frame into (or out of) a fetch.
   *
   * Both answers are set because a real main-frame fetch reports both: a
   * page cannot be fetching its own document without the page fetching
   * something. Only `isLoadingMainFrame` is what the supervisor reads —
   * `waits on the main frame only` is the case where they disagree.
   */
  function fetchingMainFrame(value: boolean): void {
    ctx.win.webContents.isLoading = vi.fn(() => value);
    ctx.win.webContents.isLoadingMainFrame = vi.fn(() => value);
  }

  it('waits rather than reloading while the page is still fetching', async () => {
    fetchingMainFrame(true);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 4);

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.userData, 'renderer-health.json'))).toBe(false);
  });

  it('gives up on a fetch that hangs instead of finishing', async () => {
    fetchingMainFrame(true);

    await vi.advanceTimersByTimeAsync(LOADING_CEILING_MS + HEARTBEAT_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('counts a failure once a slow page finishes loading without reporting alive', async () => {
    fetchingMainFrame(true);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 2);
    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();

    fetchingMainFrame(false);
    await expireDeadline();

    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(1);
  });
});

describe('probe D — a health file that cannot be written', () => {
  beforeEach(() => {
    // A ctx.userData path that cannot be created: a file sits where the
    // directory would go. ENOSPC and a permissions fault land the same way,
    // and either is a plausible cause of the failure being recovered from.
    const blocker = join(ctx.base, 'blocked');
    writeFileSync(blocker, 'not a directory');
    app.getPath = vi.fn(() => join(blocker, 'ctx.userData'));
  });

  it('still escalates through every rung when nothing can be recorded', async () => {
    await failTimes(4);

    // Rung 1 and rung 2 each reloaded; rung 3 relaunched; rung 4 gave up.
    expect(ctx.win.webContents.reload).toHaveBeenCalledTimes(2);
    expect(session.defaultSession.clearCache).toHaveBeenCalled();
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(ctx.win.loadFile).toHaveBeenCalledTimes(1);
    expect(String(ctx.win.loadFile.mock.calls[0]?.[0])).toContain('fallback.html');
  });
});

describe('a window that comes back mid-recovery', () => {
  it('does not reload a window that reported alive while the cache was clearing', async () => {
    // Hold rung 2 open at its cache clear, then let the window come back.
    let releaseClear = (): void => {};
    session.defaultSession.clearCache = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClear = resolve;
        })
    );

    await failTimes(1);
    // Trigger failure 2 and let its rung start, but do not wait for it —
    // it is parked on the clear above.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(1);
    ctx.win.webContents.reload.mockClear();

    // The window comes back on its own, mid-rung.
    send('renderer:alive', fromWindow());
    releaseClear();
    await settle();

    // Reloading here would throw away a window that had just recovered.
    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
  });
});

describe('a window that goes away', () => {
  it('stops supervising a closed window rather than reloading a destroyed one', async () => {
    await ctx.win.emit('closed');

    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 2);

    expect(ctx.win.webContents.reload).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.userData, 'renderer-health.json'))).toBe(false);
  });
});
