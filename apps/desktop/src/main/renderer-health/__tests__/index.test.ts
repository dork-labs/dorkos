import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));
// The recovery page's third action, stubbed: writing a real diagnostic archive
// is `diagnostics/__tests__`' job, and it would put a zip on the Desktop.
vi.mock('../../diagnostics', () => ({
  saveDiagnosticReportInteractive: vi.fn(() => Promise.resolve()),
}));
// Only `loadRenderer` is needed, and mocking the module whole keeps the real
// one's window construction out of a suite about what happens after it.
vi.mock('../../window-manager', () => ({ loadRenderer: vi.fn() }));
// Rung 3 asks before it arms a relaunch. The real guard opens a dialog; what
// matters here is the answer it gives back.
vi.mock('../../quit-guard', () => ({
  confirmInterruptingAgents: vi.fn(() => Promise.resolve(true)),
}));

import {
  attachRendererSupervisor,
  HEARTBEAT_DEADLINE_MS,
  LOADING_CEILING_MS,
  pendingRecovery,
  readRendererHealth,
  resetRendererSupervisor,
  setupRendererRecovery,
  shouldDisableHardwareAcceleration,
  type RendererHealth,
} from '../index';
import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  resetElectronMock,
} from '../../__tests__/electron-mock';
import type { MockBrowserWindow } from '../../__tests__/electron-mock';
import log, { resetLogMock } from '../../__tests__/electron-log-mock';
import { saveDiagnosticReportInteractive } from '../../diagnostics';
import { loadRenderer } from '../../window-manager';
import { confirmInterruptingAgents } from '../../quit-guard';

/**
 * The renderer supervisor, driven through the events Electron would raise.
 *
 * Real files on a throwaway userData dir rather than a mocked `node:fs`: the
 * counter's whole point is that it survives a relaunch, so the write and the
 * read have to be the same round trip. The GPU cache directories are real
 * directories for the same reason — "did rung 3 actually delete them" is not a
 * question a mock can answer.
 */
/**
 * Ceiling on {@link settle}'s wait, in rungs.
 *
 * Only a backstop: the wait itself is on the rung's own promise, so it takes
 * exactly as long as the work does. This is here so a supervisor bug that
 * leaves a rung permanently in flight fails the test instead of hanging the
 * suite.
 */
const SETTLE_ROUNDS = 4;

describe('renderer supervisor', () => {
  let base: string;
  let userData: string;
  let win: MockBrowserWindow;

  /** The renderer entry the supervisor puts back on screen from the fallback page. */
  const OPTIONS = { getRendererUrl: () => 'http://localhost:4242', role: 'primary' as const };

  /** What the health file holds right now. */
  function health(): RendererHealth {
    return JSON.parse(
      readFileSync(join(userData, 'renderer-health.json'), 'utf-8')
    ) as RendererHealth;
  }

  /** Pretend a previous launch (or a previous failure) left this behind. */
  function seedHealth(contents: string): void {
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, 'renderer-health.json'), contents);
  }

  /** Invoke the `ipcMain.on` listener registered for `channel`. */
  function send(channel: string, event: unknown): void {
    const call = ipcMain.on.mock.calls.find(([registered]) => registered === channel);
    if (!call) throw new Error(`Nothing is listening on ${channel}.`);
    (call[1] as (event: unknown) => void)(event);
  }

  /** Invoke the `ipcMain.handle` listener registered for `channel`. */
  async function invoke(channel: string, event: unknown): Promise<void> {
    const call = ipcMain.handle.mock.calls.find(([registered]) => registered === channel);
    if (!call) throw new Error(`Nothing handles ${channel}.`);
    await (call[1] as (event: unknown) => Promise<void>)(event);
  }

  /** An IPC event shaped like one from the supervised window. */
  function fromWindow(): { sender: MockBrowserWindow['webContents'] } {
    return { sender: win.webContents };
  }

  /**
   * Let the recovery a failure started finish.
   *
   * A rung is not instant — two of them clear caches and remove directories —
   * and under fake timers there is no amount of clock advancing that waits for
   * real filesystem work. Nor is a fixed number of event-loop turns an answer:
   * that was tried, and it passed alone and failed under a full parallel suite
   * run. So the wait is on the rung's **own** promise, which is exactly as long
   * as the work takes and no longer.
   */
  async function settle(): Promise<void> {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      const inFlight = pendingRecovery();
      if (!inFlight) break;
      // A rung yields out of the failing event's own stack on a real timer
      // before it touches the window, so the clock has to move for it to
      // start at all.
      await vi.advanceTimersByTimeAsync(1);
      await inFlight;
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  /** Let the deadline expire, and let the rung it triggers finish its work. */
  async function expireDeadline(): Promise<void> {
    await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS);
    await settle();
  }

  /** Drive `count` consecutive failures through the heartbeat deadline. */
  async function failTimes(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await expireDeadline();
      // Each rung's recovery issues a fresh load; only a fresh load re-opens
      // the ladder, exactly as `did-start-loading` does in production.
      await win.webContents.emit('did-start-loading');
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    resetElectronMock();
    resetLogMock();
    resetRendererSupervisor();
    vi.mocked(loadRenderer).mockClear();
    vi.mocked(saveDiagnosticReportInteractive).mockClear();
    vi.mocked(confirmInterruptingAgents).mockClear();
    vi.mocked(confirmInterruptingAgents).mockResolvedValue(true);
    delete process.env.DORKOS_DESKTOP_SUPPRESS_HEARTBEAT;

    base = mkdtempSync(join(tmpdir(), 'dorkos-renderer-health-'));
    userData = join(base, 'userData');
    app.getPath = vi.fn(() => userData);

    setupRendererRecovery();
    win = new BrowserWindow();
    attachRendererSupervisor(win as unknown as Electron.BrowserWindow, OPTIONS);
  });

  afterEach(() => {
    resetRendererSupervisor();
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  describe('the health record', () => {
    it('reads a missing file as nothing wrong yet', () => {
      expect(readRendererHealth().consecutiveFailures).toBe(0);
      expect(shouldDisableHardwareAcceleration()).toBe(false);
    });

    it('reads a truncated file as nothing wrong yet, rather than refusing to start', () => {
      seedHealth('{ "consecutiveFailures": 3');

      expect(readRendererHealth().consecutiveFailures).toBe(0);
    });

    // A counter that decides whether to relaunch someone's app must not be
    // steerable by a hand-edited or half-written value of the wrong type.
    it('rejects a failure count that is not a whole non-negative number', () => {
      seedHealth(JSON.stringify({ consecutiveFailures: -4 }));
      expect(readRendererHealth().consecutiveFailures).toBe(0);

      seedHealth(JSON.stringify({ consecutiveFailures: 'lots' }));
      expect(readRendererHealth().consecutiveFailures).toBe(0);
    });

    it('carries the hardware-acceleration flag across a launch', () => {
      seedHealth(JSON.stringify({ consecutiveFailures: 3, disableHardwareAcceleration: true }));

      expect(shouldDisableHardwareAcceleration()).toBe(true);
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

      expect(win.webContents.reload).not.toHaveBeenCalled();
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

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });

    it('ignores every heartbeat when the fault-injection flag is set', async () => {
      process.env.DORKOS_DESKTOP_SUPPRESS_HEARTBEAT = '1';

      send('renderer:alive', fromWindow());
      await expireDeadline();

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('the recovery ladder', () => {
    it('reloads on the first failure', async () => {
      await expireDeadline();

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
      expect(health().consecutiveFailures).toBe(1);
      expect(health().lastFailureAt).not.toBeNull();
    });

    it('clears the web cache before reloading on the second', async () => {
      await failTimes(2);

      expect(session.defaultSession.clearCache).toHaveBeenCalledTimes(1);
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
      expect(health().consecutiveFailures).toBe(2);
    });

    it('still reloads on the second failure when the cache clear fails', async () => {
      session.defaultSession.clearCache = vi.fn(() => Promise.reject(new Error('cache locked')));

      await failTimes(2);

      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalled();
    });

    it('clears the GPU caches and relaunches without hardware acceleration on the third', async () => {
      for (const name of ['GPUCache', 'Code Cache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
        mkdirSync(join(userData, name), { recursive: true });
        writeFileSync(join(userData, name, 'entry.bin'), 'stale');
      }

      await failTimes(3);

      expect(existsSync(join(userData, 'GPUCache'))).toBe(false);
      expect(existsSync(join(userData, 'Code Cache'))).toBe(false);
      expect(existsSync(join(userData, 'DawnGraphiteCache'))).toBe(false);
      expect(existsSync(join(userData, 'DawnWebGPUCache'))).toBe(false);
      expect(health().disableHardwareAcceleration).toBe(true);
      expect(app.relaunch).toHaveBeenCalledTimes(1);
      // Through the ordinary quit, so `quit-guard.ts` still asks about agents
      // that are mid-run and still stops the server first.
      expect(app.quit).toHaveBeenCalledTimes(1);
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
    });

    it('gives up and loads the bundled recovery page on the fourth', async () => {
      await failTimes(4);

      expect(win.loadFile).toHaveBeenCalledTimes(1);
      expect(String(win.loadFile.mock.calls[0]?.[0])).toContain('fallback.html');
      expect(health().consecutiveFailures).toBe(4);
      expect(log.error).toHaveBeenCalled();
    });

    it('continues the ladder where the previous launch left it', async () => {
      seedHealth(JSON.stringify({ consecutiveFailures: 3, disableHardwareAcceleration: true }));

      await expireDeadline();

      expect(win.loadFile).toHaveBeenCalledTimes(1);
      expect(win.webContents.reload).not.toHaveBeenCalled();
    });

    it('stops laddering once the recovery page is up', async () => {
      await failTimes(4);
      vi.mocked(win.loadFile).mockClear();

      await vi.advanceTimersByTimeAsync(LOADING_CEILING_MS * 2);

      expect(win.loadFile).not.toHaveBeenCalled();
      expect(health().consecutiveFailures).toBe(4);
    });

    // Pins the yield in `afterTheStackUnwinds`. Reloading from inside the
    // crash handler's own stack takes the whole main process down with
    // SIGTRAP — measured under a real Electron. The observable half of that
    // fix is that no reload happens on the emitting stack.
    it('never reloads on the stack that reported the crash', async () => {
      await win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 });

      expect(win.webContents.reload).not.toHaveBeenCalled();

      await settle();

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });

    // The echo that arrives after the rung has finished but before the reload
    // it issued has started: `ladderInFlight` is already null by then, so only
    // the recovering latch can refuse it.
    it('ignores a late echo of the failure it is already recovering from', async () => {
      await expireDeadline();
      expect(health().consecutiveFailures).toBe(1);

      await win.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://localhost/', true);
      await settle();

      expect(health().consecutiveFailures).toBe(1);
      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
      expect(session.defaultSession.clearCache).not.toHaveBeenCalled();
    });

    // One failure announces itself several times — a dead renderer fires
    // `render-process-gone` and then `did-fail-load` for the navigation it
    // took down. Each extra report must not cost a rung.
    it('counts one failure once, however many events report it', async () => {
      await win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 });
      await win.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://localhost/', true);
      await vi.advanceTimersByTimeAsync(0);

      expect(health().consecutiveFailures).toBe(1);
      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('failure signals', () => {
    it('recovers from a main-frame load failure', async () => {
      await win.webContents.emit(
        'did-fail-load',
        {},
        -105,
        'ERR_NAME_NOT_RESOLVED',
        'http://localhost:4242/',
        true
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });

    // ERR_ABORTED is what the app navigating itself looks like. Treating it as
    // a failure would reload the window on every internal link.
    it('ignores an aborted navigation', async () => {
      await win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost/', true);
      await vi.advanceTimersByTimeAsync(0);

      expect(win.webContents.reload).not.toHaveBeenCalled();
    });

    it('ignores a sub-frame load failure', async () => {
      await win.webContents.emit('did-fail-load', {}, -105, 'ERR', 'http://cdn/', false);
      await vi.advanceTimersByTimeAsync(0);

      expect(win.webContents.reload).not.toHaveBeenCalled();
    });

    it('recovers from a renderer process that went away', async () => {
      await win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 133 });
      await vi.advanceTimersByTimeAsync(0);

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });

    it('ignores a clean renderer exit', async () => {
      await win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
      await vi.advanceTimersByTimeAsync(0);

      expect(win.webContents.reload).not.toHaveBeenCalled();
    });

    it('recovers from a window that stopped responding', async () => {
      await win.emit('unresponsive');
      await vi.advanceTimersByTimeAsync(0);

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });

    // Chromium respawns both of these on its own. Reloading a window that is
    // about to be fine is a worse outcome than waiting one deadline.
    it('logs a GPU crash without laddering, and names it when the heartbeat then fails', async () => {
      await app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed' });

      expect(win.webContents.reload).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();

      await expireDeadline();

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
      const reported = log.warn.mock.calls.map((args) => String(args[0])).join('\n');
      expect(reported).toContain('GPU process');
    });

    it('logs a network-service crash without laddering', async () => {
      await app.emit(
        'child-process-gone',
        {},
        { type: 'Utility', serviceName: 'network.mojom.NetworkService', reason: 'crashed' }
      );

      expect(win.webContents.reload).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });

    it('leaves an unrelated utility-process crash alone', async () => {
      await app.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed' });

      expect(log.warn).not.toHaveBeenCalled();
    });

    // A second cockpit window is a full window that can die too; what it does
    // not get is a ladder fighting the primary one over shared caches.
    it('logs a secondary window crash without recovering it', async () => {
      const secondary = new BrowserWindow();
      await app.emit('web-contents-created', {}, secondary.webContents);

      await secondary.webContents.emit(
        'render-process-gone',
        {},
        { reason: 'crashed', exitCode: 9 }
      );

      expect(log.error).toHaveBeenCalled();
      expect(secondary.webContents.reload).not.toHaveBeenCalled();
      expect(existsSync(join(userData, 'renderer-health.json'))).toBe(false);
    });
  });

  describe('a slow load is not a failed load', () => {
    it('waits rather than reloading while the page is still fetching', async () => {
      win.webContents.isLoading = vi.fn(() => true);

      await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 4);

      expect(win.webContents.reload).not.toHaveBeenCalled();
      expect(existsSync(join(userData, 'renderer-health.json'))).toBe(false);
    });

    it('gives up on a fetch that hangs instead of finishing', async () => {
      win.webContents.isLoading = vi.fn(() => true);

      await vi.advanceTimersByTimeAsync(LOADING_CEILING_MS + HEARTBEAT_DEADLINE_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });

    it('counts a failure once a slow page finishes loading without reporting alive', async () => {
      win.webContents.isLoading = vi.fn(() => true);
      await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 2);
      expect(win.webContents.reload).not.toHaveBeenCalled();

      win.webContents.isLoading = vi.fn(() => false);
      await expireDeadline();

      expect(win.webContents.reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('the recovery page', () => {
    /**
     * Walk the ladder to the fallback page, where its three actions live.
     *
     * Four failures in one session, which in production would be spread across
     * the relaunch rung 3 performs — the counter is what carries it, and
     * `continues the ladder where the previous launch left it` covers that
     * half. Everything the walk itself did is cleared afterwards, so the
     * assertions are about the action under test and nothing else.
     */
    async function reachFallbackPage(): Promise<void> {
      await failTimes(4);
      vi.mocked(loadRenderer).mockClear();
      app.relaunch.mockClear();
      app.quit.mockClear();
      session.defaultSession.clearCache.mockClear();
      session.defaultSession.clearStorageData.mockClear();
      vi.mocked(saveDiagnosticReportInteractive).mockClear();
    }

    it('puts the app back on screen and restarts the ladder on Try Again', async () => {
      await reachFallbackPage();

      await invoke('renderer:try-again', fromWindow());

      expect(loadRenderer).toHaveBeenCalledTimes(1);
      expect(health().consecutiveFailures).toBe(0);
    });

    it('wipes the caches and local storage, then relaunches, on Reset and Relaunch', async () => {
      await reachFallbackPage();
      mkdirSync(join(userData, 'GPUCache'), { recursive: true });

      await invoke('renderer:reset-and-relaunch', fromWindow());

      expect(session.defaultSession.clearCache).toHaveBeenCalled();
      expect(session.defaultSession.clearStorageData).toHaveBeenCalledWith({
        storages: ['localstorage'],
      });
      expect(existsSync(join(userData, 'GPUCache'))).toBe(false);
      expect(health().consecutiveFailures).toBe(0);
      expect(app.relaunch).toHaveBeenCalledTimes(1);
      expect(app.quit).toHaveBeenCalledTimes(1);
    });

    it('saves a diagnostic report on Save Diagnostic Report', async () => {
      await reachFallbackPage();

      await invoke('renderer:save-diagnostics', fromWindow());

      expect(saveDiagnosticReportInteractive).toHaveBeenCalledTimes(1);
    });

    // The cockpit runs third-party extension code in the same renderer. None
    // of these three may be reachable from it — they wipe storage and restart
    // the app.
    it('refuses every action from a window that is not showing the recovery page', async () => {
      await invoke('renderer:try-again', fromWindow());
      await invoke('renderer:reset-and-relaunch', fromWindow());
      await invoke('renderer:save-diagnostics', fromWindow());

      expect(loadRenderer).not.toHaveBeenCalled();
      expect(app.relaunch).not.toHaveBeenCalled();
      expect(saveDiagnosticReportInteractive).not.toHaveBeenCalled();
    });

    it('refuses every action from a window it does not supervise', async () => {
      await reachFallbackPage();
      const other = new BrowserWindow();

      await invoke('renderer:try-again', { sender: other.webContents });
      await invoke('renderer:reset-and-relaunch', { sender: other.webContents });
      await invoke('renderer:save-diagnostics', { sender: other.webContents });

      expect(loadRenderer).not.toHaveBeenCalled();
      expect(app.relaunch).not.toHaveBeenCalled();
      expect(saveDiagnosticReportInteractive).not.toHaveBeenCalled();
    });

    it('shows the window if the failure happened before it was ever revealed', async () => {
      win.isVisible = vi.fn(() => false);

      await failTimes(4);

      expect(win.show).toHaveBeenCalledTimes(1);
    });
  });

  describe('probe A — the recovery page is a place, not a flag', () => {
    /**
     * `server-crash-recovery.ts` points every window at the restarted server.
     * It has never heard of this module, and it can do that while the recovery
     * page is up.
     */
    async function navigateAwayFromFallback(): Promise<void> {
      await win.loadURL('http://localhost:4242/');
    }

    it('refuses the recovery actions once the window has been navigated back to the app', async () => {
      await failTimes(4);
      expect(win.webContents.getURL()).toContain('fallback.html');
      vi.mocked(loadRenderer).mockClear();
      app.relaunch.mockClear();

      // Something else moved the window. Nothing told this module.
      await navigateAwayFromFallback();

      await invoke('renderer:try-again', fromWindow());
      await invoke('renderer:reset-and-relaunch', fromWindow());
      await invoke('renderer:save-diagnostics', fromWindow());

      // Otherwise the cockpit — and the extension code running in it — can
      // wipe storage and restart the app.
      expect(loadRenderer).not.toHaveBeenCalled();
      expect(app.relaunch).not.toHaveBeenCalled();
      expect(saveDiagnosticReportInteractive).not.toHaveBeenCalled();
    });

    it('supervises the window again after it has been navigated back to the app', async () => {
      await failTimes(4);
      await navigateAwayFromFallback();
      // A navigation the shell performs raises this exactly as any load does.
      await win.webContents.emit('did-start-loading');
      win.webContents.reload.mockClear();

      await expireDeadline();

      // The ladder is alive: it counted the fresh failure rather than sitting
      // out the rest of the session.
      expect(health().consecutiveFailures).toBe(5);
    });

    it('stops laddering while the recovery page really is the page', async () => {
      await failTimes(4);
      vi.mocked(win.loadFile).mockClear();

      await win.webContents.emit('did-start-loading');
      await vi.advanceTimersByTimeAsync(LOADING_CEILING_MS * 2);

      expect(win.loadFile).not.toHaveBeenCalled();
      expect(health().consecutiveFailures).toBe(4);
    });

    it('does not ladder on a recovery page that fails to load', async () => {
      await failTimes(4);
      vi.mocked(win.loadFile).mockClear();

      await win.webContents.emit(
        'did-fail-load',
        {},
        -6,
        'ERR_FILE_NOT_FOUND',
        win.webContents.getURL(),
        true
      );
      await settle();

      expect(win.loadFile).not.toHaveBeenCalled();
      expect(health().consecutiveFailures).toBe(4);
    });
  });

  describe('probe B — a declined restart', () => {
    it('asks before it arms the relaunch, and arms nothing when the answer is no', async () => {
      vi.mocked(confirmInterruptingAgents).mockResolvedValue(false);

      await failTimes(3);

      expect(confirmInterruptingAgents).toHaveBeenCalledWith('restart');
      // Arming first and asking second leaves a relaunch primed for the
      // person's next deliberate quit, hours later.
      expect(app.relaunch).not.toHaveBeenCalled();
      expect(app.quit).not.toHaveBeenCalled();
    });

    it('keeps the ladder alive, so the next failure still reaches the recovery page', async () => {
      vi.mocked(confirmInterruptingAgents).mockResolvedValue(false);
      await failTimes(3);

      // No new load happened — the decline is what re-armed the deadline.
      await expireDeadline();

      expect(health().consecutiveFailures).toBe(4);
      expect(win.loadFile).toHaveBeenCalledTimes(1);
      expect(String(win.loadFile.mock.calls[0]?.[0])).toContain('fallback.html');
    });

    it('asks with the restart wording, not the quit wording', async () => {
      await failTimes(3);

      expect(confirmInterruptingAgents).toHaveBeenCalledWith('restart');
    });
  });

  describe('probe D — a health file that cannot be written', () => {
    beforeEach(() => {
      // A userData path that cannot be created: a file sits where the
      // directory would go. ENOSPC and a permissions fault land the same way,
      // and either is a plausible cause of the failure being recovered from.
      const blocker = join(base, 'blocked');
      writeFileSync(blocker, 'not a directory');
      app.getPath = vi.fn(() => join(blocker, 'userData'));
    });

    it('still escalates through every rung when nothing can be recorded', async () => {
      await failTimes(4);

      // Rung 1 and rung 2 each reloaded; rung 3 relaunched; rung 4 gave up.
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
      expect(session.defaultSession.clearCache).toHaveBeenCalled();
      expect(app.relaunch).toHaveBeenCalledTimes(1);
      expect(win.loadFile).toHaveBeenCalledTimes(1);
      expect(String(win.loadFile.mock.calls[0]?.[0])).toContain('fallback.html');
    });

    it('starts over from the first rung once a window reports alive', async () => {
      await expireDeadline();
      expect(win.webContents.reload).toHaveBeenCalledTimes(1);

      send('renderer:alive', fromWindow());
      await win.webContents.emit('did-start-loading');
      await expireDeadline();

      // Back to rung 1 — a reload, not the cache clear rung 2 would have done.
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
      expect(session.defaultSession.clearCache).not.toHaveBeenCalled();
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
      win.webContents.reload.mockClear();

      // The window comes back on its own, mid-rung.
      send('renderer:alive', fromWindow());
      releaseClear();
      await settle();

      // Reloading here would throw away a window that had just recovered.
      expect(win.webContents.reload).not.toHaveBeenCalled();
    });
  });

  describe('a window that goes away', () => {
    it('stops supervising a closed window rather than reloading a destroyed one', async () => {
      await win.emit('closed');

      await vi.advanceTimersByTimeAsync(HEARTBEAT_DEADLINE_MS * 2);

      expect(win.webContents.reload).not.toHaveBeenCalled();
      expect(existsSync(join(userData, 'renderer-health.json'))).toBe(false);
    });
  });
});
