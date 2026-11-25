import { beforeEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, session } from '../../__tests__/electron-mock';
import {
  ctx,
  expireDeadline,
  failTimes,
  fromWindow,
  health,
  invoke,
  settle,
  useSupervisor,
} from './supervisor.fixtures';
import { saveDiagnosticReportInteractive } from '../../diagnostics';
import { loadRenderer } from '../../window-manager';
import { confirmInterruptingAgents } from '../../quit-guard';

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

useSupervisor();

beforeEach(() => {
  vi.mocked(loadRenderer).mockClear();
  vi.mocked(saveDiagnosticReportInteractive).mockClear();
  vi.mocked(confirmInterruptingAgents).mockClear();
  vi.mocked(confirmInterruptingAgents).mockResolvedValue(true);
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
    mkdirSync(join(ctx.userData, 'GPUCache'), { recursive: true });

    await invoke('renderer:reset-and-relaunch', fromWindow());

    expect(session.defaultSession.clearCache).toHaveBeenCalled();
    expect(session.defaultSession.clearStorageData).toHaveBeenCalledWith({
      storages: ['localstorage'],
    });
    expect(existsSync(join(ctx.userData, 'GPUCache'))).toBe(false);
    expect(health().consecutiveFailures).toBe(0);
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
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
    ctx.win.isVisible = vi.fn(() => false);

    await failTimes(4);

    expect(ctx.win.show).toHaveBeenCalledTimes(1);
  });
});

describe('probe A — the recovery page is a place, not a flag', () => {
  /**
   * `server-crash-recovery.ts` points every window at the restarted server.
   * It has never heard of this module, and it can do that while the recovery
   * page is up.
   */
  async function navigateAwayFromFallback(): Promise<void> {
    await ctx.win.loadURL('http://localhost:4242/');
  }

  it('refuses the recovery actions once the window has been navigated back to the app', async () => {
    await failTimes(4);
    expect(ctx.win.webContents.getURL()).toContain('fallback.html');
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

  it('does not ladder on a recovery page that fails to load', async () => {
    await failTimes(4);
    vi.mocked(ctx.win.loadFile).mockClear();

    await ctx.win.webContents.emit(
      'did-fail-load',
      {},
      -6,
      'ERR_FILE_NOT_FOUND',
      ctx.win.webContents.getURL(),
      true
    );
    await settle();

    expect(ctx.win.loadFile).not.toHaveBeenCalled();
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
    expect(ctx.win.loadFile).toHaveBeenCalledTimes(1);
    expect(String(ctx.win.loadFile.mock.calls[0]?.[0])).toContain('fallback.html');
  });
});
