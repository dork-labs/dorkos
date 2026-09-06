/**
 * Sole access to the one sidebar panel every worker is looking at (DOR-1420).
 *
 * **What is shared, and why naming cannot isolate it.** Every other fixture here
 * isolates by NAMING: `roomsApi` gives each test a `run-<runId>` namespace, and
 * two tests asserting on `#e2e-today-a-3f2c` and `#e2e-today-b-91ab` never
 * collide. That works for assertions about a room. It does not work for
 * assertions about the PANEL, because the sidebar draws every room on the
 * server — so the twenty-five channels `sidebar-bottom-slot.spec.ts` seeds to
 * overflow its list are drawn in the page `sidebar-groups.spec.ts` is dragging
 * in, whatever they are called.
 *
 * Measured, not theorised. Running `sidebar-groups`, `sidebar-today` and
 * `sidebar-bottom-slot` together at `--workers=3` against one server:
 *
 * ```
 * Error: Drag target is off screen (centre y=-553, viewport height 720).
 *   at DashboardSidebarPage.dragRowIntoGroup
 * ```
 *
 * The drop target had been pushed 553px above the fold by rows another worker's
 * test had seeded. Nothing about the product was wrong, and no rename would have
 * helped.
 *
 * The second shared surface is `ui.sidebar` itself. `PATCH /api/config`
 * deep-merges objects but replaces arrays, so the client sends the COMPLETE
 * `ui.sidebar` section on every write and the last one wins
 * (`use-sidebar-prefs.ts`). Two pages folding a section and creating a group at
 * the same time are two whole-section writes, and the loser's change is gone.
 *
 * **So the fix is exclusion, not a namespace**: a test that renders or writes
 * the shared panel holds a machine-wide lock for its duration, and the other
 * forty spec files keep running beside it at full parallelism. `workers: 1`
 * would buy the same correctness by making every unrelated spec wait too.
 *
 * Nothing here fires under `CI`, which already runs `workers: 1` — the lock is
 * uncontended there and costs one `mkdir` per test.
 *
 * @module fixtures/sole-access
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';

/**
 * The tag a spec wears to say it reads or writes the shared sidebar.
 *
 * Declared as a tag rather than inferred from the file's directory because the
 * directory is not the truth: `sidebar-model-showcase.spec.ts` lives beside the
 * others and drives the Dev Playground's own fixtures with no server behind it
 * at all, so holding the lock across its 150s cases would serialize the family
 * for nothing. What matters is whether the test looks at the app's real panel,
 * which is a property of the test.
 *
 * `__tests__/sole-sidebar-tag.test.ts` is what stops that from being a matter of
 * memory: it fails when a spec in `tests/dashboard-sidebar/` carries neither the
 * tag nor a named, argued exemption.
 */
export const SOLE_SIDEBAR_TAG = '@sole-sidebar';

/** Where lock directories live. One per server under test — see {@link soleAccess}. */
const LOCK_ROOT = join(tmpdir(), 'dorkos-e2e-sole-access');

/** The file inside a lock naming who holds it. */
const HOLDER_FILE = 'holder';

/**
 * How often a holder touches its lock to say it is still there.
 *
 * The heartbeat is what makes {@link STALE_AFTER_MS} mean "abandoned" rather
 * than "old". Without one, a hold that simply lasted longer than the staleness
 * threshold looked identical to a dead run — so a second test took the lock
 * while the first was still using it, and mutual exclusion was silently gone
 * for as long as that lasted.
 */
const HEARTBEAT_MS = 5_000;

/**
 * How long a lock may go untouched before a waiter will CONSIDER taking it over.
 *
 * Half of the takeover test, never the whole of it: the other half is that the
 * holding process is gone (see {@link isAbandoned}). Both have to be true,
 * which is what keeps a live holder whose event loop stalled — a busy machine
 * is this suite's normal environment — from being robbed by a waiter that only
 * looked at a clock.
 *
 * Twelve missed beats. It has nothing to do with how long a test runs any more,
 * which is the point of the heartbeat: the previous number was sized against the
 * longest per-test timeout, and a number sized that way goes wrong the moment
 * somebody writes a slower test.
 */
const STALE_AFTER_MS = 60_000;

/**
 * How long to wait for the lock before failing rather than hanging.
 *
 * Generous, because waiting is the normal case: the sidebar family runs one test
 * at a time by construction, so a test entering behind nine others legitimately
 * waits minutes. The wait is refunded to the test's own timeout (see
 * {@link soleAccess}), so this ceiling only ever catches a lock that is held by
 * a process still alive and no longer releasing it — the one case the takeover
 * test deliberately refuses to break.
 */
const ACQUIRE_TIMEOUT_MS = 600_000;

/** How often to retry an acquire. */
const ACQUIRE_POLL_MS = 50;

/** One process's claim on a lock, as the holder file records it. */
interface Holder {
  /** The process holding it, so a waiter can ask whether it still exists. */
  pid: number;
  /** This particular hold, so a release can tell its own lock from a successor's. */
  nonce: string;
}

/** A lock this process is holding, and what it needs to give it back. */
interface Hold {
  /** The lock directory. */
  dir: string;
  /** This hold's nonce, checked on release. */
  nonce: string;
  /** The timer keeping the lock warm; cleared on release. */
  heartbeat: NodeJS.Timeout;
  /** How long acquiring it took, which the caller refunds to the test. */
  waitedMs: number;
}

/** Turn a base URL into something that can be a directory name. */
function lockName(key: string): string {
  return `${key.replace(/[^a-z0-9]+/gi, '-')}.lock`;
}

/**
 * Where one key's lock lives.
 *
 * Exported for `__tests__/sole-access.test.ts`, which has to stage locks that
 * cannot be produced by calling {@link soleAccess} — an abandoned one, and one
 * that was stolen out from under a live holder. Both are the cases the takeover
 * rules exist for, and neither can be asserted from the outside.
 *
 * @param key - The same key {@link soleAccess} was given.
 */
export function lockDirFor(key: string): string {
  return join(LOCK_ROOT, lockName(key));
}

/** Read a lock's holder, or `null` when there is nothing readable to read. */
async function readHolder(dir: string): Promise<Holder | null> {
  try {
    const [pid, nonce] = (await readFile(join(dir, HOLDER_FILE), 'utf8')).split('\n');
    const parsed = Number(pid);
    if (!Number.isInteger(parsed) || nonce === undefined || nonce === '') return null;
    return { pid: parsed, nonce };
  } catch {
    return null;
  }
}

/**
 * Whether a process is still around to finish what it started.
 *
 * `EPERM` counts as alive on purpose: it means the pid exists and belongs to
 * somebody else, which is every reason to leave its lock alone and none to take
 * it.
 *
 * @param pid - The process to ask about.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a lock was left behind rather than being used.
 *
 * Both halves are required, and the pid is the load-bearing one. A run killed
 * with Ctrl-C mid-test, or a worker the harness shot, leaves its directory
 * behind and every later run on that machine would otherwise wait out the whole
 * acquire timeout for nothing.
 *
 * @param dir - The lock directory to judge.
 */
async function isAbandoned(dir: string): Promise<boolean> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(dir)).mtimeMs;
  } catch {
    // It vanished between the failed `mkdir` and this call, which is the holder
    // releasing it. Not abandoned — just gone, and the next `mkdir` will win.
    return false;
  }
  if (Date.now() - mtimeMs <= STALE_AFTER_MS) return false;
  const holder = await readHolder(dir);
  // Nothing readable to ask about: either a directory made by a version of this
  // file that kept no holder, or a process that died between `mkdir` and its
  // first write. Age is then all the evidence there is.
  return holder === null || !isAlive(holder.pid);
}

/**
 * Take the lock, waiting for whoever holds it.
 *
 * `mkdir` is the primitive because it is atomic across processes on every
 * filesystem this suite runs on: it either creates the directory or fails
 * `EEXIST`, with no window in which two callers both believe they won.
 *
 * @param key - What is being locked; one lock per distinct key.
 * @returns The hold, which {@link release} gives back.
 */
async function acquire(key: string): Promise<Hold> {
  const dir = join(LOCK_ROOT, lockName(key));
  const started = Date.now();
  // `0700` for the same reason the legs' data directories are (DOR-1551): /tmp
  // is world-traversable, and a lock another account can create is a lock
  // another account can hold shut.
  await mkdir(LOCK_ROOT, { recursive: true, mode: 0o700 });
  for (;;) {
    let won = false;
    try {
      await mkdir(dir);
      won = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (won) {
      const nonce = randomUUID();
      await writeFile(join(dir, HOLDER_FILE), `${process.pid}\n${nonce}`);
      const heartbeat = setInterval(() => {
        const now = new Date();
        // Swallowed: the only way this fails is the directory being gone, which
        // `release` is about to notice properly.
        void utimes(dir, now, now).catch(() => {});
      }, HEARTBEAT_MS);
      // Never a reason for the worker to stay alive — a lock is held for the
      // length of a test, not for the length of the process.
      heartbeat.unref();
      return { dir, nonce, heartbeat, waitedMs: Date.now() - started };
    }
    if (await isAbandoned(dir)) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started > ACQUIRE_TIMEOUT_MS) {
      const holder = await readHolder(dir);
      throw new Error(
        `Waited ${Math.round((Date.now() - started) / 1000)}s for sole access to the sidebar on ` +
          `${key} and never got it. It is held by pid ${holder?.pid ?? '(unrecorded)'}, which is ` +
          `still running. Delete ${dir} if that process is not a test run.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ACQUIRE_POLL_MS));
  }
}

/**
 * Give a lock back, but only if it is still ours.
 *
 * The ownership check is not ceremony. A takeover is meant to be impossible
 * while the holder lives, and the heartbeat plus the pid test is what makes it
 * so — but if one ever did happen, an unconditional `rm` here would delete the
 * SUCCESSOR's lock on the way out, handing a third waiter a lock two tests
 * already believe they hold. One stolen lock would cascade into a broken queue;
 * with this, it stays one.
 *
 * @param hold - What {@link acquire} returned.
 */
async function release(hold: Hold): Promise<void> {
  clearInterval(hold.heartbeat);
  const holder = await readHolder(hold.dir);
  if (holder !== null && holder.nonce !== hold.nonce) return;
  await rm(hold.dir, { recursive: true, force: true });
}

/**
 * Hold the shared sidebar panel for one test, if that test asked for it.
 *
 * A no-op for every test that does not carry {@link SOLE_SIDEBAR_TAG}, which is
 * nearly all of them — this is wired as an automatic fixture so a tagged spec
 * cannot forget to request it, not because every spec needs it.
 *
 * **The wait is refunded, and the budget is raised BEFORE the wait rather than
 * after it.** A fixture is spent out of the test's own timeout, so a test that
 * queued behind three others would fail on a 30s deadline having done nothing
 * wrong. Raising it afterwards is not enough and fails in a way that names the
 * wrong thing: the clock runs during the wait, so the test dies mid-queue and
 * Playwright reports `Test timeout of 30000ms exceeded while running "beforeEach"
 * hook` about a `beforeEach` that is one HTTP call. (Measured, twice, on the
 * first cut of this fixture.) So the ceiling goes up first and comes back down
 * to `timeout + waited` once the lock is in hand — the test body gets exactly
 * the deadline it was configured with, and not one second of the queue.
 *
 * A test configured with no timeout at all keeps none.
 *
 * @param key - The server under test — the panel is shared per server, so two
 *   checkouts running on different ports do not wait for each other.
 * @param testInfo - The running test, read for its tags and its deadline.
 * @param run - The test body, called while the lock is held.
 */
export async function soleAccess(
  key: string,
  testInfo: TestInfo,
  run: () => Promise<void>
): Promise<void> {
  if (!testInfo.tags.includes(SOLE_SIDEBAR_TAG)) {
    await run();
    return;
  }
  const configured = testInfo.timeout;
  // Cover the whole queue up front. `acquire` cannot outlast this by
  // construction — it gives up at ACQUIRE_TIMEOUT_MS with a message naming the
  // lock, which is a far better failure than a test deadline naming a hook.
  if (configured > 0) testInfo.setTimeout(configured + ACQUIRE_TIMEOUT_MS);
  const hold = await acquire(key);
  if (configured > 0) testInfo.setTimeout(configured + hold.waitedMs);
  // Say so in the report. A queue is invisible otherwise: the test simply takes
  // longer than its own work explains, which reads as a slow test rather than as
  // one that was waiting its turn.
  if (hold.waitedMs > ACQUIRE_POLL_MS) {
    testInfo.annotations.push({
      type: 'sole-sidebar',
      description: `queued ${Math.round(hold.waitedMs / 1000)}s for the shared sidebar`,
    });
  }
  try {
    await run();
  } finally {
    await release(hold);
  }
}
