import { describe, it, expect, vi } from 'vitest';
import { SERVER_READY_PARENT_TIMEOUT_MS } from '../../shared/boot-timeouts';
import {
  SHUTDOWN_GRACE_MS,
  devChildAt,
  forkCount,
  getElectronMock,
  getLogMock,
  startReadyServer,
  startupError,
  until,
  useServerProcessHarness,
} from './server-process.fixtures';
import type { MockServerProcess } from './server-child-mock';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

useServerProcessHarness();

describe('startServer — the readiness handshake', () => {
  it('resolves with the port it handed the child and reports it from getServerPort()', async () => {
    const { startServer, getServerPort } = await import('../server-process');

    const { port, child } = await startReadyServer(startServer);

    expect(port).toBe(Number(child.env.DORKOS_PORT));
    expect(getServerPort()).toBe(port);
  });

  it('rejects when the child exits 0 before signalling ready (H5)', async () => {
    const { startServer, getServerPort } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    // A clean early exit used to clear the timeout without settling anything,
    // so `await startServer()` blocked forever inside app.on('ready') and the
    // app sat there with no window and no error.
    child.emitExit(0);

    await expect(started).rejects.toThrow(/exited/i);
    expect(getServerPort()).toBeNull();
  });

  it("surfaces the server's own reason for refusing to boot, not just a code", async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    // What the server prints when a `dorkos` CLI server already holds the data
    // directory: the actionable sentence, which used to reach only the log file.
    child.emitStderr('Another DorkOS server is already using ~/.dork (pid 8123, port 4242).');
    child.emitStderr('Quit that server, or start DorkOS with a different data directory.');
    child.emitExit(1);

    // index.ts renders this message into its "DorkOS couldn't start" box.
    const err = await startupError(started);
    expect(err.message).toContain('The server reported:');
    expect(err.message).toContain('already using ~/.dork (pid 8123, port 4242)');
    expect(err.message).toContain('Quit that server');
  });

  it('bounds and truncates a noisy stream, keeping both ends', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    child.emitStderr('first line: the reason');
    for (let n = 0; n < 40; n++) child.emitStderr(`noise line ${n}`);
    // Long, but real prose: redaction leaves it alone, so this is what
    // exercises the length cap.
    child.emitStderr(`trailing ${'detail '.repeat(80)}`);
    child.emitExit(1);

    const err = await startupError(started);
    // Both ends survive; the middle is elided rather than silently dropped.
    expect(err.message).toContain('first line: the reason');
    expect(err.message).toContain('noise line 39');
    expect(err.message).toMatch(/… \d+ more lines …/);
    expect(err.message).not.toContain('noise line 20');
    // No single line runs away with the dialog.
    for (const line of err.message.split('\n')) expect(line.length).toBeLessThanOrEqual(210);
  });

  it('redacts a real DorkOS token even when it straddles a chunk boundary', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    // The real per-instance token shape: `dork_mcp_local_` + 64 hex
    // (services/core/auth/mcp-local-token.ts). A `dork_[0-9a-f]+` rule cannot
    // match it, which is why this asserts against the true format.
    const token = `dork_mcp_local_${'a1b2c3d4'.repeat(8)}`;
    // Chunks do not respect line boundaries. Split the token across two `data`
    // events: each half alone looks like nothing.
    child.emitStderrChunk(`could not read token ${token.slice(0, 22)}`);
    child.emitStderrChunk(`${token.slice(22)} from disk\n`);
    child.emitExit(1);

    const err = await startupError(started);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain('dork_mcp_local_');
    expect(err.message).not.toContain(token.slice(22, 40));
  });

  it('rejects and kills the child when it never signals ready', async () => {
    // Only setTimeout is faked: the free-port probe is real socket I/O, and
    // devChildAt polls on setImmediate to let it finish.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { startServer } = await import('../server-process');

    const started = startServer();
    const assertion = expect(started).rejects.toThrow(/did not start in time/i);
    const child = await devChildAt(0);
    await vi.advanceTimersByTimeAsync(SERVER_READY_PARENT_TIMEOUT_MS);
    await assertion;

    // A child left running would keep the port and the SQLite lock.
    expect(child.killed).toBe(true);
  });

  it('rejects with a clear message when the fork fails to spawn (M7)', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    child.emitError(new Error('spawn tsx ENOENT'));

    await expect(started).rejects.toThrow(/ENOENT/);
  });

  it('settles the startup wait when a booting child exits during shutdown', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    const assertion = expect(started).rejects.toThrow(/before it was ready/i);

    // Cmd+Q while the server is still booting: app.on('ready') is still
    // awaiting startServer, and nothing else will ever settle it.
    const stopping = stopServer();
    child.emitExit(0);

    await stopping;
    await assertion;
  });

  it('refuses to start a second server on top of a running one', async () => {
    const { startServer } = await import('../server-process');
    await startReadyServer(startServer);

    await expect(startServer()).rejects.toThrow(/second DorkOS server/);
  });
});

describe('stopServer', () => {
  it('returns promptly when the child has already exited (M1)', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(1);

    // Cmd+Q used to hang for the full grace period here, waiting on an `exit`
    // event from a process that had already exited.
    vi.useFakeTimers();
    await stopServer();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.killed).toBe(false);
  });

  it('kills the child instead of throwing when the shutdown message cannot be sent (M1)', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    // A dead ChildProcess emits an `error` event from send(), which throws
    // when nothing is listening.
    child.sendError = new Error('channel closed');

    const stopping = stopServer();
    child.emitExit(0);
    await expect(stopping).resolves.toBeUndefined();
    expect(child.killed).toBe(true);
  });

  it('kills a child that ignores the shutdown message, then resolves', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    vi.useFakeTimers();
    const stopping = stopServer();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await expect(stopping).resolves.toBeUndefined();

    expect(child.sent).toEqual([{ type: 'shutdown' }]);
    expect(child.killed).toBe(true);
  });
});

describe('restartServer — the supervisor restarting its own child (DOR-542)', () => {
  /**
   * Drive a restart to completion: shut the current child down, then let the
   * replacement report ready.
   *
   * The whole cycle has to be driven from the test, because both halves are
   * events the supervisor is waiting on — a shutdown the child obeys, and a
   * readiness handshake from the child that takes its place.
   *
   * @param current - The child the supervisor is about to stop.
   * @param replacementIndex - Which fork the replacement will be.
   */
  async function letTheRestartHappen(
    current: MockServerProcess,
    replacementIndex: number
  ): Promise<MockServerProcess> {
    await until('the shutdown message', () => current.sent.length > 0);
    current.emitExit(0);
    const replacement = await devChildAt(replacementIndex);
    replacement.emitReady();
    return replacement;
  }

  it('stops the running server and starts a replacement that serves', async () => {
    const { startServer, restartServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const restarting = restartServer();
    const replacement = await letTheRestartHappen(child, 1);
    const outcome = await restarting;

    expect(child.sent).toEqual([{ type: 'shutdown' }]);
    expect(outcome.port).toBe(Number(replacement.env.DORKOS_PORT));
    expect(outcome.interrupted).toBeNull();
    expect(getServerPort()).toBe(outcome.port);
  });

  it('does not report the old server as crashed on the way through', async () => {
    // The exit is one the supervisor asked for. Counting it as a crash would
    // put the "server stopped unexpectedly" dialog in front of somebody who
    // just clicked Restart.
    const { dialog } = await getElectronMock();
    const { startServer, restartServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const restarting = restartServer();
    await letTheRestartHappen(child, 1);
    await restarting;

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('runs the between-stop-and-start work while nothing holds the data directory', async () => {
    const { startServer, restartServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    /** What had happened by the time the callback ran. */
    let sawWhileStopped: { forks: number; oldChildExited: boolean } | null = null;
    let oldChildExited = false;
    child.on('exit', () => {
      oldChildExited = true;
    });

    const restarting = restartServer(async () => {
      sawWhileStopped = { forks: forkCount(), oldChildExited };
    });
    await letTheRestartHappen(child, 1);
    await restarting;

    // One fork so far — the old one. The replacement had not been spawned yet,
    // and the old child was already gone: the only moment a reset may delete
    // the directory both servers would otherwise have open.
    expect(sawWhileStopped).toEqual({ forks: 1, oldChildExited: true });
  });

  it('starts the server anyway when that work throws, and reports what it threw', async () => {
    // The invariant that keeps "Reset All Data" from bricking the app: a
    // callback that fails between the stop and the start must not be able to
    // leave the shell with no server, which is exactly the state DOR-532 gated
    // the HTTP route to prevent.
    const { startServer, restartServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const restarting = restartServer(() => Promise.reject(new Error('someone else has it')));
    const replacement = await letTheRestartHappen(child, 1);
    const outcome = await restarting;

    expect(outcome.interrupted?.message).toBe('someone else has it');
    expect(outcome.port).toBe(Number(replacement.env.DORKOS_PORT));
    expect(getServerPort()).toBe(outcome.port);
  });

  it('refuses a second restart while one is still running', async () => {
    const { startServer, restartServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const restarting = restartServer();
    // Two interleaved cycles would have one's startServer race the other's
    // stopServer over the same port and the same SQLite store.
    await expect(restartServer()).rejects.toThrow(/already restarting/i);

    await letTheRestartHappen(child, 1);
    await restarting;
  });
});

describe('the main process safety net', () => {
  it('logs an unhandled rejection instead of letting it vanish (H1)', async () => {
    const { default: log } = await getLogMock();
    const before = process.listenerCount('unhandledRejection');
    const { startServer } = await import('../server-process');

    await startReadyServer(startServer);

    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    const listener = process.listeners('unhandledRejection').at(-1) as (
      reason: unknown,
      promise: Promise<unknown>
    ) => void;
    listener(new Error('nothing awaited me'), Promise.resolve());

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Unhandled'), expect.any(Error));
  });
});
