import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MockServerProcess } from './server-child-mock';
import type { ShowMessageBox } from './electron-mock';
import { SERVER_READY_PARENT_TIMEOUT_MS } from '../../shared/boot-timeouts';

/**
 * Mirrors `SHUTDOWN_GRACE_MS` in `server-process.ts`. Not imported: it is an
 * internal policy value with no reason to be exported, and the tests that use
 * it are asserting on that exact policy.
 */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * How many times the fake user will click the leftmost button before giving up
 * and quitting.
 *
 * Bounds every retry-loop test: an implementation whose cap has been removed
 * still terminates, so the test fails on a clean assertion instead of running
 * until the worker dies.
 */
const IMPATIENT_USER_CLICKS = 8;

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so mock
 * state is fetched through the real specifier (matching `index.test.ts` and
 * `auto-updater.test.ts`) rather than importing the mock modules directly —
 * `vi.resetModules()` re-evaluates the module under test but never re-invokes
 * a mock factory.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

async function getChildProcessMock() {
  const childProcess = await import('node:child_process');
  return childProcess as unknown as typeof import('./child-process-mock');
}

async function getLogMock() {
  const electronLog = await import('electron-log');
  return electronLog as unknown as typeof import('./electron-log-mock');
}

/** Let queued microtasks and one macrotask turn drain (crash handling is async). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Wait for the `index`-th dev child to be spawned. `startServer` binds a free
 * port before forking, so the child does not exist synchronously.
 *
 * Polls on `setImmediate` rather than `vi.waitFor` so it keeps working in the
 * tests that fake `setTimeout` — real socket I/O still completes between
 * turns, which is what the free-port probe is waiting on.
 */
async function devChildAt(index: number): Promise<MockServerProcess> {
  const { forkedChildren } = await getChildProcessMock();
  return spawnedChildAt(forkedChildren, index, 'dev');
}

/**
 * The live `forkedChildren` array from the mocked `node:child_process`.
 *
 * Captured once per test because `until()` predicates have to be synchronous;
 * the mock clears the array in place rather than replacing it, so the
 * reference stays valid.
 */
let forkedChildren: MockServerProcess[] = [];

/** How many dev children have been spawned so far. */
function forkCount(): number {
  return forkedChildren.length;
}

/** {@link devChildAt}'s packaged counterpart — the `utilityProcess.fork` path. */
async function utilityChildAt(index: number): Promise<MockServerProcess> {
  const { utilityProcessChildren } = await getElectronMock();
  return spawnedChildAt(utilityProcessChildren, index, 'utility process');
}

/**
 * How long to wait for a spawn before calling it a genuine failure. Generous on
 * purpose: this bounds a real-I/O wait on a shared CI runner, and the wait ends
 * the moment the child appears, so the cost of being generous is nothing.
 */
const SPAWN_WAIT_MS = 10_000;

async function spawnedChildAt(
  children: MockServerProcess[],
  index: number,
  label: string
): Promise<MockServerProcess> {
  // Bounded by WALL CLOCK, not by turn count (DOR-653). The old bound was 1000
  // `setImmediate` turns, which is a count and not a duration: on an idle
  // machine those elapse in under a millisecond, so the loop gave up almost
  // immediately and only ever passed because the spawn usually won the race.
  // Under CI contention the free-port probe's real socket I/O needs longer than
  // 1000 turns, and this reported "was never spawned" for a child that was
  // merely late — three times on 2026-07-28 alone, on branches that touched no
  // desktop code.
  //
  // `process.hrtime` rather than `Date.now`: vitest's fake timers patch `Date`
  // and `setTimeout`, and several tests in this file fake `setTimeout`, which
  // would freeze a `Date`-based deadline and reinstate the original bug in a
  // subtler form. `setImmediate` polling is kept for that same reason.
  const deadline = process.hrtime.bigint() + BigInt(SPAWN_WAIT_MS) * 1_000_000n;
  while (!children[index] && process.hrtime.bigint() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const child = children[index];
  if (!child) {
    throw new Error(
      `${label} child #${index} was never spawned within ${SPAWN_WAIT_MS}ms ` +
        `(${children.length} child(ren) spawned)`
    );
  }
  return child;
}

/** Drive `startServer` all the way to a ready server. */
async function startReadyServer(
  startServer: (accessor?: () => Electron.BrowserWindow | null) => Promise<number>,
  accessor?: () => Electron.BrowserWindow | null
): Promise<{ port: number; child: MockServerProcess }> {
  const started = startServer(accessor);
  const child = await devChildAt(0);
  child.emitReady();
  return { port: await started, child };
}

/**
 * Pretend this process is a packaged app. `app.isPackaged` alone is not
 * enough: the packaged spawn path also reads `process.resourcesPath`, which
 * only Electron defines.
 */
function stubPackagedPaths(
  resourcesPath = '/Applications/DorkOS.app/Contents/Resources'
): () => void {
  const original = (process as { resourcesPath?: string }).resourcesPath;
  Object.defineProperty(process, 'resourcesPath', {
    value: resourcesPath,
    configurable: true,
  });
  return () => {
    Object.defineProperty(process, 'resourcesPath', { value: original, configurable: true });
  };
}

/** A dialog that never settles — for tests that only care that it was shown. */
function pendingDialog(): ShowMessageBox {
  return () => new Promise<Electron.MessageBoxReturnValue>(() => {});
}

/**
 * Poll until `predicate` holds, on `setImmediate` so real socket I/O (the
 * free-port probe each restart makes) can complete between turns.
 */
async function until(label: string, predicate: () => boolean): Promise<void> {
  // Same wall-clock bound as spawnedChildAt, and for the same reason (DOR-653):
  // a turn count is not a duration, so on a loaded runner this gave up on work
  // that was merely slow. Every restart here re-runs the free-port probe, so
  // this waits on real socket I/O too.
  const deadline = process.hrtime.bigint() + BigInt(SPAWN_WAIT_MS) * 1_000_000n;
  while (!predicate() && process.hrtime.bigint() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) throw new Error(`timed out waiting for ${label} after ${SPAWN_WAIT_MS}ms`);
}

type ElectronMock = Awaited<ReturnType<typeof getElectronMock>>;

/** Every `dialog.showMessageBox` call so far. */
function dialogCalls(dialog: ElectronMock['dialog']): unknown[][] {
  return vi.mocked(dialog.showMessageBox).mock.calls as unknown[][];
}

/**
 * The options of the `index`-th message box, whether it was shown anchored to
 * a window (two arguments) or unanchored (one).
 */
function dialogOptions(dialog: ElectronMock['dialog'], index: number): Electron.MessageBoxOptions {
  const call = dialogCalls(dialog)[index];
  if (!call) throw new Error(`no message box was shown at index ${index}`);
  return (call.length > 1 ? call[1] : call[0]) as Electron.MessageBoxOptions;
}

/**
 * A fake user who clicks "Restart Server" `times` times and then quits.
 *
 * Always finite on purpose. A recovery loop still running when a test ends
 * keeps spawning children into the shared `forkedChildren` array and calling
 * the shared dialog mock, which breaks whatever test runs next — the loop must
 * be driven to an end, not abandoned.
 */
function userClicksRestart(dialog: ElectronMock['dialog'], times: number): void {
  dialog.showMessageBox = vi.fn<ShowMessageBox>(async () => ({
    response: dialogCalls(dialog).length > times ? 1 : 0,
    checkboxChecked: false,
  }));
}

/**
 * Await a `startServer()` call expected to reject, and hand back its error.
 *
 * Replaces `started.catch((e) => e as Error)`, which typed as `number | Error`
 * and — worse — resolved silently if the call unexpectedly *succeeded*.
 */
async function startupError(started: Promise<number>): Promise<Error> {
  try {
    await started;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected startServer() to reject, but it resolved');
}

/** The `detail` of the `index`-th message box. */
function dialogDetail(dialog: ElectronMock['dialog'], index: number): string {
  return dialogOptions(dialog, index).detail ?? '';
}

/**
 * The supervisor installs a process-wide `unhandledRejection` logger, and
 * every test re-imports it through `vi.resetModules()`. Snapshot the listener
 * list so those copies never accumulate into a MaxListeners warning — and so a
 * listener a test registers itself is always removed.
 */
let originalRejectionListeners: Array<(...args: unknown[]) => void> = [];

/**
 * Pin every `startServer` in this file to a port nothing is using, so the
 * supervisor's behaviour is what is under test and the machine's port map is
 * not.
 *
 * `DORKOS_PORT` is the top of `resolvePreferredPort`'s precedence, and a pinned
 * port is claimed strictly — no scanning (see `server-port.ts`). That is what
 * makes this necessary: left ambient, a developer with DorkOS already running on
 * 4242 would turn every start in this file into a refusal. Pinning also means
 * the restart assertions below are about the supervisor reusing an address, not
 * about whichever port the operating system felt like handing out.
 *
 * Found fresh per test rather than once, so a port taken part-way through a run
 * cannot strand the rest of the file.
 */
async function pinFreePort(): Promise<void> {
  const { findAvailablePort } = await import('../server-port');
  vi.stubEnv('DORKOS_PORT', String(await findAvailablePort(45_000, 50)));
}

beforeEach(async () => {
  vi.resetModules();
  originalRejectionListeners = process.listeners('unhandledRejection') as Array<
    (...args: unknown[]) => void
  >;
  (await getElectronMock()).resetElectronMock();
  const childProcess = await getChildProcessMock();
  childProcess.resetChildProcessMock();
  forkedChildren = childProcess.forkedChildren;
  (await getLogMock()).resetLogMock();
  await pinFreePort();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  process.removeAllListeners('unhandledRejection');
  for (const listener of originalRejectionListeners) process.on('unhandledRejection', listener);
});

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

  it('rejects when the child exits non-zero before signalling ready', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    child.emitExit(1);

    await expect(started).rejects.toThrow(/exited with code 1/i);
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

  it('keeps the reason when a real failure buries it under a stack trace', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    // The shape every real boot failure has: server-entry's `console.error`
    // prints the reason and then a full trace. Node's default
    // Error.stackTraceLimit is 10, so a pure tail keeps frames and throws the
    // only useful sentence away.
    child.emitStderr(
      'Server failed to start: Error: Another DorkOS server is already using ~/.dork (pid 8123)'
    );
    for (let frame = 0; frame < 10; frame++) {
      child.emitStderr(`    at frame${frame} (/Users/x/app/node_modules/pkg/index.js:${frame}:12)`);
    }
    child.emitExit(1);

    const err = await startupError(started);
    expect(err.message).toContain('already using ~/.dork (pid 8123)');
    // Frames are the bulk of a dump and the least useful thing in a dialog;
    // electron-log still has the whole trace.
    expect(err.message).not.toContain('at frame');
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

  it('bounds one runaway line, whether or not it ever ends', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);

    // Length alone cannot prove this: the display cap truncates to 200 either
    // way, so an unbounded carry would look identical while still growing all
    // session and handing scrubMessage a string long enough to block the UI
    // thread. What distinguishes them is *which* characters can reach the
    // dialog. Each unit below is redacted down to a tenth of its length, so
    // without the bound the marker far past it shrinks up into view; with the
    // bound the marker was never retained at all.
    const unit = `sk-${'a'.repeat(60)} `;
    const marker = 'MARKERWORD';
    child.emitStderr(`${unit.repeat(10)}${marker}`);
    // Same again with no newline ever, so only the carry holds it.
    for (let n = 0; n < 10; n++) child.emitStderrChunk(unit);
    child.emitStderrChunk(marker);
    child.emitExit(1);

    const err = await startupError(started);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain(marker);
    for (const line of err.message.split('\n')) expect(line.length).toBeLessThanOrEqual(210);
  });

  it('takes a final line the dying child never terminated', async () => {
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    // No trailing newline — a crashing process rarely obliges.
    child.emitStderrChunk('FATAL: the data directory is locked by pid 8123');
    child.emitExit(1);

    const err = await startupError(started);
    expect(err.message).toContain('locked by pid 8123');
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

  it('rejects when the fork throws synchronously', async () => {
    const { failNextFork } = await getChildProcessMock();
    const { startServer, getServerPort } = await import('../server-process');

    failNextFork(new Error('spawn EACCES'));

    await expect(startServer()).rejects.toThrow(/EACCES/);
    expect(getServerPort()).toBeNull();
  });

  it('looks for the .cmd tsx shim on Windows and names it when missing (M7)', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { startServer } = await import('../server-process');
      // Only the Windows branch can miss here: the extensionless Unix shim
      // exists in this repo, `tsx.cmd` does not.
      await expect(startServer()).rejects.toThrow(/tsx\.cmd/);
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
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

  it('settles the startup wait when a booting child never answers shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { startServer, stopServer } = await import('../server-process');

    const started = startServer();
    const assertion = expect(started).rejects.toThrow(/stopped before it finished starting/i);
    const child = await devChildAt(0);

    // This is the *guaranteed* shape of quit-during-boot, not an exotic one:
    // server-entry.ts only registers its shutdown listener after the health
    // poll succeeds, so a child that is still booting cannot answer. The
    // grace period runs out, the supervisor kills it, and its later exit is
    // ignored by the identity guard — so nothing but the kill path is left to
    // settle the startup wait.
    const stopping = stopServer();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS);
    await stopping;
    await assertion;

    expect(child.killed).toBe(true);
  });

  it('ignores a late exit from a child it already gave up on', async () => {
    const { dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn<ShowMessageBox>(pendingDialog());
    const { startServer } = await import('../server-process');

    const failing = startServer();
    const abandoned = await devChildAt(0);
    abandoned.emitError(new Error('spawn tsx ENOENT'));
    await expect(failing).rejects.toThrow();
    expect(abandoned.killed).toBe(true);

    // Its exit lands after the supervisor moved on; it is not a crash.
    abandoned.emitExit(1);

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('refuses to start a second server on top of a running one', async () => {
    const { startServer } = await import('../server-process');
    await startReadyServer(startServer);

    await expect(startServer()).rejects.toThrow(/second DorkOS server/);
  });
});

describe('the environment handed to the server child', () => {
  /**
   * A DORK_HOME the *test process* exports, so these assertions are about what
   * `buildServerEnv` contributes rather than about the developer's shell. The
   * child inherits `process.env` wholesale, so asserting "undefined" here
   * would go red for anyone who has DORK_HOME set.
   */
  const INHERITED_DORK_HOME = '/tmp/dor-533-inherited-dork-home';

  beforeEach(() => {
    vi.stubEnv('DORK_HOME', INHERITED_DORK_HOME);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hands the child the port the resolver chose, not one the OS picked', async () => {
    // The end-to-end half of `server-port.test.ts`: whatever
    // `resolvePreferredPort` settles on has to reach `DORKOS_PORT`. Driven
    // through DORKOS_PORT (the top of that precedence) so the assertion does
    // not depend on 4242 being free on the machine running the suite.
    const { findAvailablePort } = await import('../server-port');
    const asked = await findAvailablePort(45_678, 20);
    vi.stubEnv('DORKOS_PORT', String(asked));
    const { startServer } = await import('../server-process');

    const { port, child } = await startReadyServer(startServer);

    expect(port).toBe(asked);
    expect(child.env.DORKOS_PORT).toBe(String(asked));
  });

  it("puts the server's refusal to share a data directory in front of the user", async () => {
    // The argument this whole design rests on: the port scan is silent, so the
    // one start-up conflict a person is ever shown is the one that actually
    // stopped them — the single-instance lock (ADR 260726-234122), in the
    // server's own words. That only holds if the relay works end to end, from
    // the child's stderr to the dialog `index.ts` raises.
    const { startServer } = await import('../server-process');

    const started = startServer();
    const child = await devChildAt(0);
    for (const line of [
      'Another DorkOS instance is already using this data directory (/Users/kai/.dork).',
      'It is running as process 8123 on port 4242 (DorkOS 0.56.0).',
      'Stop it first (`kill 8123`), or start this one against a different directory.',
    ]) {
      child.emitStderr(line);
    }
    child.emitExit(1);

    const message = (await startupError(started)).message;
    // `~/.dork`, not `/Users/kai/.dork`: the tail abbreviates home paths on its
    // way to a dialog someone may screenshot. The actionable part survives.
    expect(message).toContain('already using this data directory (~/.dork)');
    expect(message).toContain('process 8123 on port 4242');
    expect(message).toContain('kill 8123');
    // Nothing in the relay may reframe it as a port problem: this conflict is
    // about the directory, and the two stories must not compete.
    expect(message).not.toMatch(/next free port|will not quietly move/i);
  });

  it('marks the server as desktop-managed so it refuses to restart itself', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    expect(child.env.DORKOS_MANAGED_BY).toBe('desktop');
  });

  it('leaves DORK_HOME alone in dev, so the child picks its own dev data dir (M3)', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    // Overriding DORK_HOME in dev pointed the dev build at the production
    // ~/.dork and applied unreleased migrations to it. Whatever the
    // environment already said is passed through untouched.
    expect(child.env.DORK_HOME).toBe(INHERITED_DORK_HOME);
    expect(child.env.NODE_ENV).toBe('development');
  });

  it('hands the dev child this process id to watch, and no pid when packaged', async () => {
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    // The child cannot derive this itself — tsx runs it as a grandchild, so
    // its own ppid is the tsx wrapper. See server-entry.ts's exitWhenOrphaned.
    expect(child.env.DORKOS_PARENT_PID).toBe(String(process.pid));
  });

  it('pins DORK_HOME to ~/.dork in a packaged build, spawned as a UtilityProcess', async () => {
    const restorePaths = stubPackagedPaths();
    try {
      const { app, utilityProcess } = await getElectronMock();
      app.isPackaged = true;
      const { startServer } = await import('../server-process');

      const started = startServer();
      const child = await utilityChildAt(0);
      child.emitReady();
      await started;

      expect(utilityProcess.fork).toHaveBeenCalledTimes(1);
      expect(child.env.DORK_HOME).toBe(join(app.getPath('home'), '.dork'));
      expect(child.env.NODE_ENV).toBe('production');
      expect(child.env.DORKOS_MANAGED_BY).toBe('desktop');
      // Electron tears a UtilityProcess down with the app; no watchdog needed.
      expect(child.env.DORKOS_PARENT_PID).toBeUndefined();
    } finally {
      restorePaths();
    }
  });
});

describe('what a packaged server child is told about the machine it runs on', () => {
  /**
   * A throwaway `.app` payload: a home directory the app pretends to own, and
   * a `Contents/Resources` tree with the unpacked binaries a real build ships.
   *
   * Real files, because every path under test is guarded by an `existsSync` —
   * the whole point of handing the server these paths is that they are files
   * that actually exist, and a stub could only ever agree with itself.
   */
  let home: string;
  let resources: string;
  let restorePaths: () => void;

  /** Where the packaged esbuild binary lives for the platform running the suite. */
  function esbuildBinaryPath(): string {
    const leaf = process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild'];
    return join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@esbuild',
      `${process.platform}-${process.arch}`,
      ...leaf
    );
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'dorkos-packaged-home-'));
    mkdirSync(join(home, '.dork'), { recursive: true });
    resources = mkdtempSync(join(tmpdir(), 'dorkos-packaged-resources-'));
    mkdirSync(dirname(esbuildBinaryPath()), { recursive: true });
    writeFileSync(esbuildBinaryPath(), '#!/bin/sh\n', 'utf8');
    restorePaths = stubPackagedPaths(resources);

    const { app } = await getElectronMock();
    app.isPackaged = true;
    app.getPath = vi.fn(() => home);
  });

  afterEach(() => {
    restorePaths();
    rmSync(home, { recursive: true, force: true });
    rmSync(resources, { recursive: true, force: true });
  });

  /** Start a packaged server and hand back the child it forked. */
  async function startPackagedServer(): Promise<MockServerProcess> {
    const { startServer } = await import('../server-process');
    const started = startServer();
    const child = await utilityChildAt(0);
    child.emitReady();
    await started;
    return child;
  }

  it('opens in the home directory, and starts the process there too', async () => {
    // Left unset, the server derived its default working directory from its own
    // file location — `…/DorkOS.app/Contents/Resources`, outside the boundary —
    // so every boot logged "Access denied: path outside directory boundary" and
    // the session list came up empty (DOR-1335). `process.cwd()` was no better:
    // a Finder-launched app inherits `/`.
    const child = await startPackagedServer();

    expect(child.env.DORKOS_DEFAULT_CWD).toBe(home);
    expect(child.options.cwd).toBe(home);
    // The server defaults the boundary to home on its own; saying so here would
    // turn its default into a setting somebody made.
    expect(child.env.DORKOS_BOUNDARY).toBeUndefined();
  });

  it('honours server.cwd from config.json, and passes a configured boundary through', async () => {
    const projects = join(home, 'projects');
    mkdirSync(projects);
    writeFileSync(
      join(home, '.dork', 'config.json'),
      JSON.stringify({ server: { cwd: projects, boundary: home } }),
      'utf8'
    );

    const child = await startPackagedServer();

    expect(child.env.DORKOS_DEFAULT_CWD).toBe(projects);
    expect(child.options.cwd).toBe(projects);
    expect(child.env.DORKOS_BOUNDARY).toBe(home);
  });

  it('hands over the login-shell PATH, not the four directories launchd gave it', async () => {
    const { spawnSync } = await getChildProcessMock();
    const { LOGIN_SHELL_PATH_MARKER } = await import('../../shared/login-shell-path');
    const loginPath = `${home}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: `${LOGIN_SHELL_PATH_MARKER}${loginPath}${LOGIN_SHELL_PATH_MARKER}`,
      stderr: '',
    });
    vi.stubEnv('SHELL', '/bin/zsh');
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');

    const child = await startPackagedServer();

    // The tester's `claude` and `codex` both lived in ~/.local/bin, which the
    // packaged app could not see at all.
    expect(child.env.PATH).toBe(`${loginPath}:/usr/sbin:/sbin`);
  });

  it('points the extension compiler at the unpacked esbuild binary', async () => {
    // esbuild finds its own binary by require.resolve, which inside a packaged
    // app answers with an app.asar path — and spawning one of those fails with
    // ENOTDIR, because Electron's asar shim covers execFile but not spawn. That
    // is why the bundled marketplace extension failed to compile on every boot.
    const child = await startPackagedServer();

    expect(child.env.ESBUILD_BINARY_PATH).toBe(esbuildBinaryPath());
  });

  it('says so loudly when the esbuild binary was left out of the package', async () => {
    rmSync(esbuildBinaryPath());
    const { default: log } = await getLogMock();

    const child = await startPackagedServer();

    expect(child.env.ESBUILD_BINARY_PATH).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('esbuild'), esbuildBinaryPath());
  });
});

describe('the crash monitor', () => {
  it('treats a clean exit after startup as a crash and stops reporting a port (C1)', async () => {
    const { dialog } = await getElectronMock();
    const { default: log } = await getLogMock();
    dialog.showMessageBox = vi.fn<ShowMessageBox>(pendingDialog());
    const { startServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    // POST /api/admin/restart and "Reset All Data" both exit 0. The old
    // monitor ignored that, leaving getServerPort() handing out a dead port.
    child.emitExit(0);

    expect(log.error).toHaveBeenCalled();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(getServerPort()).toBeNull();
  });

  it('treats death by signal (exit code null) as a crash (C1)', async () => {
    const { dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn<ShowMessageBox>(pendingDialog());
    const { startServer, getServerPort } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(null);

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(getServerPort()).toBeNull();
  });

  it('logs and surfaces the crash even when no window is focused (H2)', async () => {
    const { BrowserWindow, dialog } = await getElectronMock();
    const { default: log } = await getLogMock();
    // The app is in the background — the single most likely real crash.
    BrowserWindow.getFocusedWindow = vi.fn(() => null);
    dialog.showMessageBox = vi.fn<ShowMessageBox>(pendingDialog());
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(1);

    expect(log.error).toHaveBeenCalled();
    // Nothing to anchor to, so the dialog is shown unanchored rather than
    // skipped: one argument, the options.
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]).toHaveLength(1);
  });

  it('anchors the dialog to the tracked main window, not the focused one (H2)', async () => {
    const { BrowserWindow, dialog } = await getElectronMock();
    const tracked = new BrowserWindow({ width: 1200, height: 800 });
    const somethingElse = new BrowserWindow({ width: 400, height: 300 });
    BrowserWindow.getFocusedWindow = vi.fn(() => somethingElse);
    dialog.showMessageBox = vi.fn<ShowMessageBox>(pendingDialog());
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(
      startServer,
      () => tracked as unknown as Electron.BrowserWindow
    );
    child.emitExit(1);

    expect(vi.mocked(dialog.showMessageBox).mock.calls[0][0]).toBe(tracked);
  });

  it('restarts on request onto the same address, reloads the window, and reports the live port', async () => {
    const { BrowserWindow, dialog } = await getElectronMock();
    const tracked = new BrowserWindow({ width: 1200, height: 800 });
    dialog.showMessageBox = vi.fn<ShowMessageBox>(async () => ({
      response: 0,
      checkboxChecked: false,
    }));
    const { startServer, getServerPort } = await import('../server-process');

    const { port, child } = await startReadyServer(
      startServer,
      () => tracked as unknown as Electron.BrowserWindow
    );
    child.emitExit(1);

    const replacement = await devChildAt(1);
    replacement.emitReady();
    await flush();

    const newPort = Number(replacement.env.DORKOS_PORT);
    // The dead server let its port go, so the replacement asks for the same
    // one and gets it. A bookmark, an MCP client config, and a `dorkos://`
    // link all survive a crash because of this — before, every restart moved
    // the app to a fresh random port.
    expect(newPort).toBe(port);
    // The reported port is the live child's, not a value left over from the
    // dead one — the property that has to hold whether or not it changed.
    expect(getServerPort()).toBe(newPort);
    // Dev renderer comes from electron-vite, so it only needs a reload to
    // re-read the port over IPC.
    expect(tracked.reload).toHaveBeenCalledTimes(1);
  });

  it('moves a packaged window to the restarted server’s origin', async () => {
    const restorePaths = stubPackagedPaths();
    try {
      const { app, BrowserWindow, dialog } = await getElectronMock();
      app.isPackaged = true;
      const tracked = new BrowserWindow({ width: 1200, height: 800 });
      dialog.showMessageBox = vi.fn<ShowMessageBox>(async () => ({
        response: 0,
        checkboxChecked: false,
      }));
      const { startServer, getServerPort } = await import('../server-process');

      const started = startServer(() => tracked as unknown as Electron.BrowserWindow);
      const child = await utilityChildAt(0);
      child.emitReady();
      await started;

      child.emitExit(1);
      const replacement = await utilityChildAt(1);
      replacement.emitReady();
      await flush();

      // A packaged renderer is served *by* the server, so it has to be sent
      // back to the origin — its connection died with the old process, whether
      // or not the replacement came back on the same port.
      const newPort = Number(replacement.env.DORKOS_PORT);
      expect(getServerPort()).toBe(newPort);
      expect(tracked.loadURL).toHaveBeenCalledWith(`http://localhost:${newPort}`);
      expect(tracked.reload).not.toHaveBeenCalled();
    } finally {
      restorePaths();
    }
  });

  it('catches a restart that fails, logs it, and asks again (H1)', async () => {
    const { dialog } = await getElectronMock();
    const { default: log } = await getLogMock();
    const { failNextFork } = await getChildProcessMock();
    userClicksRestart(dialog, 1);
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    const rejections: unknown[] = [];
    const captureRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', captureRejection);

    failNextFork(new Error('spawn EACCES'));
    child.emitExit(1);
    await until('the failed restart to be reported', () => dialogCalls(dialog).length >= 2);

    expect(log.error).toHaveBeenCalled();
    // The failure is shown in the next prompt rather than swallowed.
    expect(dialogDetail(dialog, 1)).toContain('spawn EACCES');
    // The old `.then()` had no `.catch`, so this became an unhandled rejection
    // with no dialog and no log.
    expect(rejections).toEqual([]);
  });

  it('stops offering a restart that keeps failing, and points at the logs instead', async () => {
    const { app, dialog, shell } = await getElectronMock();
    const { failEveryFork } = await getChildProcessMock();
    // The user takes the leftmost button — but only so many times. Bounding
    // the fake user means an implementation with no cap terminates too, and
    // fails on the assertions below rather than by killing the test worker.
    dialog.showMessageBox = vi.fn<ShowMessageBox>(async () => ({
      response: dialogCalls(dialog).length > IMPATIENT_USER_CLICKS ? 1 : 0,
      checkboxChecked: false,
    }));
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);

    // A failure no retry can get past — the shape of a `dorkos` CLI server
    // already holding the data directory.
    failEveryFork(new Error('Another DorkOS server is already using ~/.dork (pid 8123)'));
    child.emitExit(1);

    await until('the retry offer to be withdrawn', () => app.quit.mock.calls.length > 0);

    // Two offers to restart, then one final prompt that no longer offers it:
    // the crash itself is the first failure, since the server never stayed up.
    expect(dialogCalls(dialog)).toHaveLength(3);
    for (const index of [0, 1]) {
      expect(dialogOptions(dialog, index).buttons).toEqual(['Restart Server', 'Quit']);
    }
    expect(dialogOptions(dialog, 2).buttons).toEqual(['Open Logs', 'Quit']);
    // The server's own explanation rides along to the end.
    expect(dialogDetail(dialog, 2)).toContain('already using ~/.dork');
    expect(shell.showItemInFolder).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('caps a server that keeps booting and dying, not just one that fails to spawn', async () => {
    const { app, dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn<ShowMessageBox>(async () => ({
      response: dialogCalls(dialog).length > IMPATIENT_USER_CLICKS ? 1 : 0,
      checkboxChecked: false,
    }));
    const { startServer } = await import('../server-process');

    const { getServerPort } = await import('../server-process');
    let { child } = await startReadyServer(startServer);

    // Every restart *succeeds* and then dies seconds later: the renderer
    // reloads onto the new port and re-issues whatever killed it. Counting
    // only failed spawns never caps this, so the dialog loops forever.
    for (let cycle = 0; cycle < IMPATIENT_USER_CLICKS; cycle++) {
      child.emitExit(1);
      // The shell either spawns a replacement or gives up; wait for whichever.
      await until(
        `the shell to answer crash #${cycle + 1}`,
        () => forkCount() > cycle + 1 || app.quit.mock.calls.length > 0
      );
      if (app.quit.mock.calls.length > 0) break;
      child = await devChildAt(cycle + 1);
      child.emitReady();
      await until(`restart #${cycle + 1} to be serving`, () => getServerPort() !== null);
    }

    await until('the app to give up', () => app.quit.mock.calls.length > 0);

    const last = dialogOptions(dialog, dialogCalls(dialog).length - 1);
    expect(last.buttons).toEqual(['Open Logs', 'Quit']);
    // Bounded, and well short of the impatient user's limit.
    expect(dialogCalls(dialog).length).toBeLessThanOrEqual(4);
  });

  it('starts a fresh incident when a server that had been up for a while dies', async () => {
    const { dialog } = await getElectronMock();
    // Two restarts, then quit at the prompt this test is about.
    userClicksRestart(dialog, 2);
    const { startServer, getServerPort } = await import('../server-process');

    let { child } = await startReadyServer(startServer);

    // Two quick crashes put two failures on the counter.
    for (let cycle = 0; cycle < 2; cycle++) {
      child.emitExit(1);
      await until(`restart #${cycle + 1}`, () => forkCount() > cycle + 1);
      child = await devChildAt(cycle + 1);
      child.emitReady();
      await until(`restart #${cycle + 1} to be serving`, () => getServerPort() !== null);
    }
    expect(dialogCalls(dialog)).toHaveLength(2);

    // This one served for an hour before dying. That is a working server, so
    // its death opens a fresh incident rather than tripping the cap — a
    // counter that only ever climbed would strand this user at 'Open Logs'.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    child.emitExit(1);
    await until('the third prompt', () => dialogCalls(dialog).length > 2);

    expect(dialogOptions(dialog, 2).buttons).toEqual(['Restart Server', 'Quit']);
  });

  it('quits when the user declines the restart', async () => {
    const { app, dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn<ShowMessageBox>(async () => ({
      response: 1,
      checkboxChecked: false,
    }));
    const { startServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    child.emitExit(1);
    await flush();

    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the exit was the one stopServer asked for', async () => {
    const { dialog } = await getElectronMock();
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const stopping = stopServer();
    child.emitExit(0);
    await stopping;
    await flush();

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe('stopServer', () => {
  it('returns promptly when the child has already exited (M1)', async () => {
    const { dialog } = await getElectronMock();
    dialog.showMessageBox = vi.fn<ShowMessageBox>(pendingDialog());
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

  it('is safe to call twice', async () => {
    const { startServer, stopServer } = await import('../server-process');

    const { child } = await startReadyServer(startServer);
    const stopping = stopServer();
    child.emitExit(0);
    await stopping;

    await expect(stopServer()).resolves.toBeUndefined();
    expect(child.sent).toEqual([{ type: 'shutdown' }]);
  });

  it('resolves without a server ever having been started', async () => {
    const { stopServer } = await import('../server-process');

    await expect(stopServer()).resolves.toBeUndefined();
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
