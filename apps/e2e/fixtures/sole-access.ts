/**
 * Sole access to the one cockpit sidebar every worker is looking at (DOR-1420).
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
import { mkdir, rm, stat } from 'node:fs/promises';
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
 * for nothing. What matters is whether the test looks at the cockpit's real
 * panel, which is a property of the test.
 *
 * `__tests__/sole-sidebar-tag.test.ts` is what stops that from being a matter of
 * memory: it fails when a spec in `tests/dashboard-sidebar/` carries neither the
 * tag nor a named, argued exemption.
 */
export const SOLE_SIDEBAR_TAG = '@sole-sidebar';

/** Where lock directories live. One per server under test — see {@link soleAccess}. */
const LOCK_ROOT = join(tmpdir(), 'dorkos-e2e-sole-access');

/**
 * How long a lock may go unrefreshed before the next waiter takes it.
 *
 * A lock is a directory, and a directory outlives the process that made it: a
 * run killed with Ctrl-C mid-test, or a worker the harness shot, leaves one
 * behind and every later run on that machine would wait out its acquire timeout
 * for nothing. Sized above the longest per-test timeout in this suite (150s, the
 * showcase's) plus its fixtures, so a slow-but-live holder is never robbed.
 */
const STALE_AFTER_MS = 240_000;

/**
 * How long to wait for the lock before failing rather than hanging.
 *
 * Generous, because waiting is the normal case: the sidebar family runs one test
 * at a time by construction, so a test entering behind nine others legitimately
 * waits minutes. The wait is refunded to the test's own timeout (see
 * {@link soleAccess}), so this ceiling only ever catches a lock nobody is
 * releasing — which the staleness sweep above should already have broken.
 */
const ACQUIRE_TIMEOUT_MS = 600_000;

/** How often to retry an acquire. */
const ACQUIRE_POLL_MS = 50;

/** Turn a base URL into something that can be a directory name. */
function lockName(key: string): string {
  return `${key.replace(/[^a-z0-9]+/gi, '-')}.lock`;
}

/** Whether a lock directory has gone unrefreshed long enough to be taken over. */
async function isStale(dir: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(dir)).mtimeMs > STALE_AFTER_MS;
  } catch {
    // It vanished between the failed `mkdir` and this call, which is the holder
    // releasing it. Not stale — just gone, and the next `mkdir` will win.
    return false;
  }
}

/**
 * Take the lock, waiting for whoever holds it.
 *
 * `mkdir` is the primitive because it is atomic across processes on every
 * filesystem this suite runs on: it either creates the directory or fails
 * `EEXIST`, with no window in which two callers both believe they won.
 *
 * @param key - What is being locked; one lock per distinct key.
 * @returns The lock directory, and how long acquiring it took.
 */
async function acquire(key: string): Promise<{ dir: string; waitedMs: number }> {
  const dir = join(LOCK_ROOT, lockName(key));
  const started = Date.now();
  // `0700` for the same reason the legs' data directories are (DOR-1551): /tmp
  // is world-traversable, and a lock another account can create is a lock
  // another account can hold shut.
  await mkdir(LOCK_ROOT, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await mkdir(dir);
      return { dir, waitedMs: Date.now() - started };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (await isStale(dir)) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started > ACQUIRE_TIMEOUT_MS) {
      throw new Error(
        `Waited ${Math.round((Date.now() - started) / 1000)}s for sole access to the sidebar on ` +
          `${key} and never got it. Delete ${dir} if a killed run left it behind.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, ACQUIRE_POLL_MS));
  }
}

/**
 * Hold the shared cockpit sidebar for one test, if that test asked for it.
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
  const { dir, waitedMs } = await acquire(key);
  if (configured > 0) testInfo.setTimeout(configured + waitedMs);
  // Say so in the report. A queue is invisible otherwise: the test simply takes
  // longer than its own work explains, which reads as a slow test rather than as
  // one that was waiting its turn.
  if (waitedMs > ACQUIRE_POLL_MS) {
    testInfo.annotations.push({
      type: 'sole-sidebar',
      description: `queued ${Math.round(waitedMs / 1000)}s for the shared sidebar`,
    });
  }
  try {
    await run();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
