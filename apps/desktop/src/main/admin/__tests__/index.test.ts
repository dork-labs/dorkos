import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTANCE_LOCK_FILENAME } from '@dorkos/shared/instance-lock';
import type { RestartOutcome } from '../../server-process';

/**
 * The two danger-zone buttons, answered by the shell instead of the server
 * (DOR-542).
 *
 * The supervisor's own state machine is covered next door in
 * `../../__tests__/server-process.test.ts`; what is under test here is everything wrapped around
 * it — who is allowed to ask, what happens to the data directory, where the
 * windows end up, and what a person is told when it does not work.
 */

/**
 * Per-test knobs the hoisted `vi.mock` factories below read.
 *
 * `rmFails` is how a delete is made to fail on purpose. `vi.spyOn` cannot touch
 * an ESM namespace ("Module namespace is not configurable"), and the alternative
 * — a directory the OS refuses to unlink — is not portable: a root CI runner
 * would delete it anyway and the test would go green on the wrong branch.
 */
const state = vi.hoisted(() => ({ dorkHome: '', rmFails: null as Error | null }));

vi.mock('electron', () => import('../../__tests__/electron-mock'));
vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));
vi.mock('../../dork-home', () => ({ resolveDataDirectory: () => state.dorkHome }));
// The real `rm` unless a test arms `state.rmFails` — so the tests that assert the
// directory is GONE delete it for real, and the one about a delete that could not
// finish still gets a failure it can control.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: (async (...args: Parameters<typeof actual.rm>) => {
      if (state.rmFails) throw state.rmFails;
      return actual.rm(...args);
    }) as typeof actual.rm,
  };
});
vi.mock('../../server-crash-recovery', () => ({ pointWindowsAtServer: vi.fn() }));
// Only `restartServer` is doubled. `RestartFailedError` stays the REAL class,
// because the module under test asks `instanceof` of it to decide what to tell a
// person — a stand-in would answer `false` and the whole message would be chosen
// on a lie.
vi.mock('../../server-process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server-process')>()),
  restartServer: vi.fn(),
}));

/** The app's own origin in these tests, and the URL a cockpit window is on. */
const OWN_ORIGIN = 'http://localhost:4242';

/** The port a restarted server comes back on, unless a test says otherwise. */
const RESTARTED_PORT = 4242;

async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('../../__tests__/electron-mock');
}

async function getLogMock() {
  const electronLog = await import('electron-log');
  return electronLog as unknown as typeof import('../../__tests__/electron-log-mock');
}

/**
 * A restart that succeeds: it runs whatever it was asked to do while the server
 * is down, and comes back on {@link RESTARTED_PORT} regardless of how that went.
 *
 * Deliberately faithful to `restartServer`'s contract rather than convenient —
 * a callback that throws is REPORTED, not propagated, because the real one
 * always ends with a server running.
 */
function restartThatWorks(port = RESTARTED_PORT) {
  return async (whileStopped?: () => Promise<void>): Promise<RestartOutcome> => {
    let interrupted: Error | null = null;
    if (whileStopped) {
      try {
        await whileStopped();
      } catch (err) {
        interrupted = err as Error;
      }
    }
    return { port, interrupted };
  };
}

/** An invoke from a page on `url`. */
function senderOn(url: string) {
  return { sender: { getURL: () => url } } as unknown as Electron.IpcMainInvokeEvent;
}

/**
 * Register the handlers and hand back a way to call one.
 *
 * @param getRendererUrl - The origin accessor to arm the guard with. Defaults to
 *   a fixed one; the tests that care about the guard itself pass the REAL
 *   accessor, because a stub can never reproduce what it answers during a gap.
 */
async function armHandlers(
  getRendererUrl: () => string | undefined = () => OWN_ORIGIN
): Promise<(channel: string, url?: string) => Promise<import('../index').AdminActionResult>> {
  const { ipcMain } = await getElectronMock();
  const { setupAdminActions } = await import('../index');
  setupAdminActions({ getRendererUrl });
  return async (channel, url = `${OWN_ORIGIN}/`) => {
    const call = ipcMain.handle.mock.calls.find(([name]) => name === channel);
    if (!call) throw new Error(`nothing registered on ${channel}`);
    const handler = call[1] as (
      event: Electron.IpcMainInvokeEvent
    ) => Promise<import('../index').AdminActionResult>;
    return handler(senderOn(url));
  };
}

/** Write an `instance.lock` naming `pid`, claimed just now. */
function claimDataDirectory(pid: number): void {
  writeFileSync(
    join(state.dorkHome, INSTANCE_LOCK_FILENAME),
    JSON.stringify({ pid, port: 4242, startedAt: new Date().toISOString(), version: '9.9.9' })
  );
}

/** A pid high enough that no process can hold it. */
const DEAD_PID = 2147483646;

/** The process that spawned this one: alive, and never our own pid. */
const LIVE_PID = process.ppid;

beforeEach(async () => {
  vi.resetModules();
  // `vi.mock(..., factory)` memoizes per specifier, so the doubles for
  // `server-process` and `server-crash-recovery` outlive `resetModules` and
  // would otherwise carry the previous test's calls into this one. Every test
  // below sets the implementation it needs, so clearing the history is enough.
  vi.clearAllMocks();
  (await getElectronMock()).resetElectronMock();
  (await getLogMock()).resetLogMock();
  state.rmFails = null;
  state.dorkHome = mkdtempSync(join(tmpdir(), 'dorkos-admin-'));
  // Something to notice the absence of.
  mkdirSync(join(state.dorkHome, 'agents'), { recursive: true });
});

afterEach(() => {
  rmSync(state.dorkHome, { recursive: true, force: true });
});

describe('Restart Server', () => {
  it('restarts through the supervisor and puts the windows on the new port', async () => {
    const { restartServer } = await import('../../server-process');
    const { pointWindowsAtServer } = await import('../../server-crash-recovery');
    vi.mocked(restartServer).mockImplementation(restartThatWorks(4300));
    const invoke = await armHandlers();

    await expect(invoke('admin:restart-server')).resolves.toEqual({ ok: true });

    // Not an optimisation to skip: the window is holding a connection to a
    // process that no longer exists, and in a packaged build the port IS its
    // origin.
    expect(pointWindowsAtServer).toHaveBeenCalledWith(4300);
  });

  it('says what went wrong in words, and leaves the window where it is', async () => {
    const { restartServer, RestartFailedError } = await import('../../server-process');
    const { pointWindowsAtServer } = await import('../../server-crash-recovery');
    vi.mocked(restartServer).mockRejectedValue(
      new RestartFailedError(new Error('The DorkOS server did not start in time.'), null)
    );
    const invoke = await armHandlers();

    const result = await invoke('admin:restart-server');

    // There is nothing to reload onto, so the page that asked survives to show
    // this — and the button on it still works, because this path needs no
    // server.
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('The DorkOS server did not start in time.'),
    });
    expect(pointWindowsAtServer).not.toHaveBeenCalled();
  });

  it('passes a refusal that is already a sentence through unprefixed', async () => {
    // "DorkOS couldn't restart its server. DorkOS is already restarting its
    // server." — two sentences that contradict each other, from one click.
    const { restartServer } = await import('../../server-process');
    vi.mocked(restartServer).mockRejectedValue(
      new Error('DorkOS is already restarting its server. Give it a moment.')
    );
    const invoke = await armHandlers();

    expect(await invoke('admin:restart-server')).toEqual({
      ok: false,
      message: 'DorkOS is already restarting its server. Give it a moment.',
    });
  });

  it('still works once the failed restart has left no port behind (DOR-542)', async () => {
    // The retry the whole IPC path exists for. `getRendererUrl` is the REAL
    // accessor over a REAL port that has just gone to null, because that is the
    // only way to see what the guard actually answers in the gap: a stub that
    // returns a fixed origin can never reproduce it, and this button was refused
    // with "DorkOS only takes this from its own window" at exactly the moment a
    // person needed it.
    const { app } = await getElectronMock();
    const { makeRendererUrlAccessor } = await import('../../window-manager');
    const { restartServer } = await import('../../server-process');
    app.isPackaged = true;
    let port: number | null = 4242;
    const getRendererUrl = makeRendererUrlAccessor(() => port);
    const invoke = await armHandlers(getRendererUrl);
    // The window loaded on that origin and lived there while the server was up,
    // asking this same accessor on every link and every permission check.
    expect(getRendererUrl()).toBe(OWN_ORIGIN);
    vi.mocked(restartServer).mockImplementation(restartThatWorks());

    // Then the server went away — a crash, or a restart whose replacement never
    // came up. The window is still on the origin it loaded from.
    port = null;

    expect(await invoke('admin:restart-server', `${OWN_ORIGIN}/`)).toEqual({ ok: true });
  });
});

describe('Reset All Data', () => {
  it('deletes the data directory while the server is down, then comes back', async () => {
    const { restartServer } = await import('../../server-process');
    const { pointWindowsAtServer } = await import('../../server-crash-recovery');
    vi.mocked(restartServer).mockImplementation(restartThatWorks());
    const invoke = await armHandlers();

    await expect(invoke('admin:reset-all-data')).resolves.toEqual({ ok: true });

    expect(existsSync(state.dorkHome)).toBe(false);
    expect(pointWindowsAtServer).toHaveBeenCalledWith(RESTARTED_PORT);
  });

  it('deletes nothing when another live DorkOS holds the directory', async () => {
    // The race the instance lock exists for (DOR-532): between our stop and our
    // delete, another instance can claim the directory it just saw go free.
    // Deleting it then would pull the store out from under a running server.
    const { restartServer } = await import('../../server-process');
    const { dialog } = await getElectronMock();
    vi.mocked(restartServer).mockImplementation(restartThatWorks());
    claimDataDirectory(LIVE_PID);
    const invoke = await armHandlers();

    const result = await invoke('admin:reset-all-data');

    expect(existsSync(state.dorkHome)).toBe(true);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining(`process ${LIVE_PID}`),
    });
    // The server came back and the windows have just been sent to it, so the
    // message has to land somewhere that outlives the page.
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'DorkOS did not reset',
      expect.stringContaining('Nothing was deleted')
    );
  });

  it('goes ahead when the lock names a process that is gone', async () => {
    // A crash leaves the file behind naming a dead pid. Refusing forever over
    // that would make the app's only reset story permanently unavailable.
    const { restartServer } = await import('../../server-process');
    vi.mocked(restartServer).mockImplementation(restartThatWorks());
    claimDataDirectory(DEAD_PID);
    const invoke = await armHandlers();

    await expect(invoke('admin:reset-all-data')).resolves.toEqual({ ok: true });
    expect(existsSync(state.dorkHome)).toBe(false);
  });

  it('says so when the folder could only be half deleted', async () => {
    // `force` swallows "it was not there" and nothing else. A file the OS will
    // not release stops the walk partway, so "nothing was deleted" would be a
    // lie — and a bare `EPERM: operation not permitted, unlink '…'` under
    // "DorkOS did not reset" is wrong twice over.
    const { restartServer } = await import('../../server-process');
    const { dialog } = await getElectronMock();
    vi.mocked(restartServer).mockImplementation(restartThatWorks());
    state.rmFails = new Error("EPERM: operation not permitted, unlink 'agents/x'");
    const invoke = await armHandlers();

    const result = await invoke('admin:reset-all-data');

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('some of your data may be gone and some may still be there'),
    });
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'DorkOS did not reset',
      expect.stringContaining('could not finish')
    );
  });

  it('reports a restart that never came back, without a native box over it', async () => {
    const { restartServer, RestartFailedError } = await import('../../server-process');
    const { dialog } = await getElectronMock();
    vi.mocked(restartServer).mockRejectedValue(
      new RestartFailedError(new Error('the port was taken'), null)
    );
    const invoke = await armHandlers();

    const result = await invoke('admin:reset-all-data');

    expect(result).toEqual({ ok: false, message: expect.stringContaining('the port was taken') });
    // The page was not reloaded, so it can say this itself; a dialog too would
    // be the same failure told twice.
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it('answers "was my data deleted?" when the restart failed too', async () => {
    // Both halves can fail at once, and they are independent questions. A
    // message that only reports the restart leaves the one the person actually
    // asked unanswered.
    const { restartServer, RestartFailedError } = await import('../../server-process');
    vi.mocked(restartServer).mockRejectedValue(
      new RestartFailedError(
        new Error('The DorkOS server did not start in time.'),
        new Error('Another copy of DorkOS is using this folder right now. Nothing was deleted.')
      )
    );
    const invoke = await armHandlers();

    const result = await invoke('admin:reset-all-data');

    expect(result).toMatchObject({ ok: false });
    const message = result.ok ? '' : result.message;
    expect(message).toContain('Nothing was deleted');
    expect(message).toContain('The DorkOS server did not start in time.');
  });

  it('says the data went when only the restart failed', async () => {
    const { restartServer, RestartFailedError } = await import('../../server-process');
    vi.mocked(restartServer).mockRejectedValue(
      new RestartFailedError(new Error('The DorkOS server did not start in time.'), null)
    );
    const invoke = await armHandlers();

    const result = await invoke('admin:reset-all-data');

    // The delete ran to completion; only the server failed to come back. Saying
    // nothing about the data would leave someone guessing at the one fact they
    // cannot check from a window with no server behind it.
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Your data was deleted.'),
    });
  });
});

describe('who may ask', () => {
  it.each([['admin:restart-server'], ['admin:reset-all-data']])(
    'refuses %s from a page that is not the cockpit',
    async (channel) => {
      const { restartServer } = await import('../../server-process');
      vi.mocked(restartServer).mockImplementation(restartThatWorks());
      const invoke = await armHandlers();

      const result = await invoke(channel, 'https://example.com/');

      expect(result).toEqual({ ok: false, message: expect.any(String) });
      expect(restartServer).not.toHaveBeenCalled();
      expect(existsSync(state.dorkHome)).toBe(true);
    }
  );
});
