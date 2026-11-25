import { vi, beforeEach, afterEach } from 'vitest';
import type { MockServerProcess } from './server-child-mock';

type ElectronMock = typeof import('./electron-mock');
type ChildProcessMock = typeof import('./child-process-mock');
type LogMock = typeof import('./electron-log-mock');

/**
 * Mirrors `SHUTDOWN_GRACE_MS` in `server-process.ts`. Not imported: it is an
 * internal policy value with no reason to be exported, and the tests that use
 * it are asserting on that exact policy.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so mock
 * state is fetched through the real specifier (matching `index.test.ts` and
 * `auto-updater.test.ts`) rather than importing the mock modules directly —
 * `vi.resetModules()` re-evaluates the module under test but never re-invokes
 * a mock factory.
 */
export async function getElectronMock(): Promise<ElectronMock> {
  const electron = await import('electron');
  return electron as unknown as ElectronMock;
}

export async function getChildProcessMock(): Promise<ChildProcessMock> {
  const childProcess = await import('node:child_process');
  return childProcess as unknown as ChildProcessMock;
}

export async function getLogMock(): Promise<LogMock> {
  const electronLog = await import('electron-log');
  return electronLog as unknown as LogMock;
}

/** Let queued microtasks and one macrotask turn drain (crash handling is async). */
export function flush(): Promise<void> {
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
export async function devChildAt(index: number): Promise<MockServerProcess> {
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
export function forkCount(): number {
  return forkedChildren.length;
}

/** {@link devChildAt}'s packaged counterpart — the `utilityProcess.fork` path. */
export async function utilityChildAt(index: number): Promise<MockServerProcess> {
  const { utilityProcessChildren } = await getElectronMock();
  return spawnedChildAt(utilityProcessChildren, index, 'utility process');
}

/**
 * How long to wait for a spawn before calling it a genuine failure. Generous on
 * purpose: this bounds a real-I/O wait on a shared CI runner, and the wait ends
 * the moment the child appears, so the cost of being generous is nothing.
 */
export const SPAWN_WAIT_MS = 10_000;

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
export async function startReadyServer(
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
export function stubPackagedPaths(
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

/**
 * Poll until `predicate` holds, on `setImmediate` so real socket I/O (the
 * free-port probe each restart makes) can complete between turns.
 */
export async function until(label: string, predicate: () => boolean): Promise<void> {
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

/**
 * Await a `startServer()` call expected to reject, and hand back its error.
 *
 * Replaces `started.catch((e) => e as Error)`, which typed as `number | Error`
 * and — worse — resolved silently if the call unexpectedly *succeeded*.
 */
export async function startupError(started: Promise<number>): Promise<Error> {
  try {
    await started;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected startServer() to reject, but it resolved');
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
  // The suites that share this harness run in parallel workers, so each worker
  // searches its own range: two workers probing one range can both see a port
  // free and then collide on the strict claim.
  const base = 45_000 + Number(process.env.VITEST_POOL_ID ?? 0) * 100;
  vi.stubEnv('DORKOS_PORT', String(await findAvailablePort(base, 50)));
}

/**
 * Register the per-test reset every server-process suite needs: fresh modules,
 * fresh doubles, a pinned free port and restart waits too long to fire.
 */
export function useServerProcessHarness(): void {
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
    // A crash outside 'the crash monitor' starts restarts nobody drives. Waits
    // of days keep them from ever spawning into a later test; that block sets
    // millisecond waits of its own.
    const { setRestartTimingForTests } = await import('../server-crash-recovery');
    setRestartTimingForTests({
      firstDelayMs: 1_000_000_000,
      maxDelayMs: 1_000_000_000,
      noticeDelayMs: 1_000_000_000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    process.removeAllListeners('unhandledRejection');
    for (const listener of originalRejectionListeners) process.on('unhandledRejection', listener);
  });
}
