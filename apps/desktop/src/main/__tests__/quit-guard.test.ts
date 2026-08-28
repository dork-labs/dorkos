import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));

import { armQuitGuard, isQuitting, resetQuitGuard, type QuitGuardOptions } from '../quit-guard';
import { app, BrowserWindow, dialog, resetElectronMock } from './electron-mock';

/** Button index the message box should answer with. 0 = Keep Working, 1 = Quit Anyway. */
function answerWith(response: number): void {
  dialog.showMessageBox = vi.fn(() => Promise.resolve({ response, checkboxChecked: false }));
}

/**
 * Fire `before-quit` and let the quit sequence run to completion.
 *
 * The handler cannot be awaited — Electron does not await `before-quit`
 * listeners, which is the whole reason the sequence is detached — so the test
 * drains the microtask queue instead.
 */
async function emitBeforeQuit(preventDefault = vi.fn()): Promise<void> {
  await app.emit('before-quit', { preventDefault });
  await new Promise((resolve) => setImmediate(resolve));
}

/** Arm the guard with overridable defaults and return the parts a test asserts on. */
function arm(overrides: Partial<QuitGuardOptions> = {}): {
  shutdown: ReturnType<typeof vi.fn>;
  countActiveAgents: ReturnType<typeof vi.fn>;
  recordUpdateInstallIntent: ReturnType<typeof vi.fn>;
} {
  const shutdown = vi.fn(() => Promise.resolve());
  const countActiveAgents = vi.fn(() => 0);
  const recordUpdateInstallIntent = vi.fn();
  armQuitGuard({
    countActiveAgents,
    getWindow: () => null,
    shutdown,
    consumeUpdateRestart: () => false,
    recordUpdateInstallIntent,
    ...overrides,
  });
  return { shutdown, countActiveAgents, recordUpdateInstallIntent };
}

beforeEach(() => {
  resetElectronMock();
  resetQuitGuard();
});

describe('armQuitGuard', () => {
  it('stops the server before letting the quit through, when nothing is running', async () => {
    const { shutdown } = arm();
    const preventDefault = vi.fn();

    await emitBeforeQuit(preventDefault);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(isQuitting()).toBe(true);
  });

  it('lets the second pass through untouched, so quitAndInstall still lands', async () => {
    arm();
    await emitBeforeQuit();

    // `app.quit()` from the sequence above re-fires the event; that pass must
    // not be prevented, or the app would never actually go.
    const second = vi.fn();
    await emitBeforeQuit(second);

    expect(second).not.toHaveBeenCalled();
  });

  it('quits even when the server refuses to shut down cleanly', async () => {
    arm({ shutdown: () => Promise.reject(new Error('the server hung')) });

    await emitBeforeQuit();

    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('does not stack listeners across repeated calls', () => {
    vi.mocked(app.on).mockClear();
    arm();
    arm();

    const registered = vi.mocked(app.on).mock.calls.map(([event]) => event);
    expect(registered).toEqual(['before-quit']);
  });
});

describe('confirming a quit while agents are working', () => {
  it('asks before cutting agents off, and quits when confirmed', async () => {
    answerWith(1);
    const { shutdown } = arm({ countActiveAgents: () => 3 });

    await emitBeforeQuit();

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0];
    expect(options).toMatchObject({
      message: '3 agents are still working or waiting on your answer. Quit anyway?',
      buttons: ['Keep Working', 'Quit Anyway'],
      // Staying is both the default button and the Escape action.
      defaultId: 0,
      cancelId: 0,
    });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('says "1 agent is" rather than "1 agents are"', async () => {
    answerWith(1);
    arm({ countActiveAgents: () => 1 });

    await emitBeforeQuit();

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0];
    expect(options).toMatchObject({
      message: '1 agent is still working or waiting on your answer. Quit anyway?',
    });
  });

  it('cancels the quit — the server keeps running and the app stays reachable', async () => {
    answerWith(0);
    const { shutdown } = arm({ countActiveAgents: () => 2 });

    await emitBeforeQuit();

    expect(shutdown).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    // Crash recovery reads this; a cancelled quit must not latch it, or the
    // shell would silently stop offering to restart a dead server.
    expect(isQuitting()).toBe(false);
  });

  it('asks again on the next quit after one was cancelled', async () => {
    answerWith(0);
    arm({ countActiveAgents: () => 2 });
    await emitBeforeQuit();

    answerWith(1);
    await emitBeforeQuit();

    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the quit is an update restart that already asked', async () => {
    answerWith(0);
    const consumeUpdateRestart = vi.fn(() => true);
    const { shutdown } = arm({ countActiveAgents: () => 3, consumeUpdateRestart });

    await emitBeforeQuit();

    // Asking here would be a second dialog for one decision — and answering
    // "Keep Working" would cancel a quit whose windows are already destroyed.
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    // Spent, not merely read: `quitAndInstall()` does not always quit, and a
    // token left standing would silence every quit after it.
    expect(consumeUpdateRestart).toHaveBeenCalledTimes(1);
  });

  it('does not tell you to close a window that is not there', async () => {
    // Reachable: the last window has closed and the tray could not be created,
    // so `window-all-closed` quits — through this guard. "Close the window
    // instead" would be advice about a window that is already gone. What is
    // true is that relaunching brings it back (`second-instance`).
    answerWith(0);
    arm({ countActiveAgents: () => 2, getWindow: () => null });

    await emitBeforeQuit();

    const [options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      Electron.MessageBoxOptions,
    ];
    expect(options.detail).not.toContain('close the window');
    expect(options.detail).toContain('opening DorkOS again brings the window back');
  });

  it('points at the window when there is one to point at', async () => {
    answerWith(0);
    const win = new BrowserWindow({ width: 1200, height: 800 });
    arm({ countActiveAgents: () => 2, getWindow: () => win as unknown as Electron.BrowserWindow });

    await emitBeforeQuit();

    const [, options] = vi.mocked(dialog.showMessageBox).mock.calls[0] as [
      unknown,
      Electron.MessageBoxOptions,
    ];
    expect(options.detail).toContain('close the window instead');
  });

  it('anchors the confirmation to the window when there is one', async () => {
    answerWith(1);
    const win = new BrowserWindow({ width: 1200, height: 800 });
    arm({ countActiveAgents: () => 1, getWindow: () => win as unknown as Electron.BrowserWindow });

    await emitBeforeQuit();

    const [first] = vi.mocked(dialog.showMessageBox).mock.calls[0];
    expect(first).toBe(win);
  });
});

/**
 * The quit sequence writes down what it is about to install (DOR-1454).
 *
 * An ORDINARY quit installs updates too (`autoInstallOnAppQuit`) and never
 * touches the restart button — it is how the reporting user's one successful
 * install finally happened, unannounced. The guard is the only place that path
 * passes through, so the record is taken here.
 */
describe('recording what a quit is about to install', () => {
  it('records the intent on the way out', async () => {
    const { recordUpdateInstallIntent } = arm();

    await emitBeforeQuit();

    expect(recordUpdateInstallIntent).toHaveBeenCalledTimes(1);
  });

  it('records BEFORE the shutdown, so a server that hangs cannot lose it', async () => {
    const order: string[] = [];
    const recordUpdateInstallIntent = vi.fn(() => order.push('record'));
    arm({
      recordUpdateInstallIntent,
      shutdown: () => {
        order.push('shutdown');
        return Promise.resolve();
      },
    });

    await emitBeforeQuit();

    expect(order).toEqual(['record', 'shutdown']);
  });

  it('records nothing for a quit the person cancelled', async () => {
    answerWith(0);
    const { recordUpdateInstallIntent } = arm({ countActiveAgents: () => 2 });

    await emitBeforeQuit();

    // Nothing is being installed: the app is still running.
    expect(recordUpdateInstallIntent).not.toHaveBeenCalled();
  });
});
