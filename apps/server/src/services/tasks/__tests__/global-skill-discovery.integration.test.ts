/**
 * A scheduled skill in a package installed for all projects actually runs.
 *
 * This is the half of slice A2's bar that `packages/harness` cannot assert on
 * its own: the engine is a leaf package and cannot import a server service, so
 * its own integration test can only prove the SHAPE — a `<pkg>__<name>` link
 * whose `SKILL.md` reads through it. What the scheduler does with that shape is
 * a question only the scheduler can answer, and it is answered here, with the
 * real `projectGlobal` and `applyGlobalPlan` writing the link and the real
 * `TaskReconciler` walking `<dorkHome>/skills` afterwards.
 *
 * Nothing is mocked and nothing fires: the schedule is hours away and the
 * assertions read the row, not its output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyGlobalPlan, projectGlobal } from '@dorkos/harness';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { globalTaskRoots } from '../skills-roots.js';

/** An agent manager that would run a turn, if anything here ever fired one. */
function silentAgentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {}),
    interruptQuery: vi.fn().mockResolvedValue(true),
    // The runtime never renamed this session, so the run records the id it ran under.
    getInternalSessionId: vi.fn(() => undefined),
    // Nobody else is writing to these sessions, so the write-lock is always free.
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as SchedulerAgentManager;
}

/**
 * Whether this machine can make a directory unreadable at all.
 *
 * `chmod 000` is the only way to stage that case, and two platforms ignore it.
 * Windows has no POSIX mode bits, so the `chmod` is a no-op, the scan succeeds
 * and `unreadableRoot` is never set — measured on the advisory `harness-windows`
 * job. Root ignores permission bits by definition, which is every root CI
 * container.
 *
 * **A green run on either is NOT evidence this path is covered.** It is
 * exercised on POSIX as a non-root user, where the assertion is exactly as
 * strong as it was; nothing is weakened to make the skip possible. Same shape as
 * `task-reconciler.test.ts`'s permission-dependent cases.
 */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('a scheduled skill installed for all projects', () => {
  let dorkHome: string;
  let db: Db;
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let reconciler: TaskReconciler;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'global-skill-discovery-'));
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new TaskSchedulerService(store, silentAgentManager(), {
      maxConcurrentRuns: 1,
      retentionCount: 100,
      mayFire: true,
      firingReason: 'test',
    });
    reconciler = new TaskReconciler(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry()
    );
    for (const root of globalTaskRoots(dorkHome)) reconciler.addRoot(root);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
    // Modes first: `rm -r` has to read a directory to empty it, so a mode-000
    // one left by the unreadable-root case would leak the whole temp tree.
    await chmod(path.join(dorkHome, 'plugins'), 0o755).catch(() => undefined);
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Install a package for all projects, holding one or more skills that run on a timer. */
  async function installGlobalPackage(name: string, ...skills: string[]): Promise<void> {
    const dir = path.join(dorkHome, 'plugins', name);
    await mkdir(path.join(dir, '.dork'), { recursive: true });
    await writeFile(
      path.join(dir, '.dork', 'manifest.json'),
      JSON.stringify({ name, version: '1.0.0', type: 'plugin', description: name })
    );
    for (const skill of skills) {
      await mkdir(path.join(dir, 'skills', skill), { recursive: true });
      await writeFile(
        path.join(dir, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: A skill named ${skill}\nschedule:\n  cron: '0 9 * * *'\n---\nDo the thing.\n`
      );
    }
  }

  it('is discovered as a schedule once a global sync has linked it', async () => {
    await installGlobalPackage('globex', 'daily-sweep');

    // Nothing is watching the package directory itself, so before the sync the
    // scheduler cannot see the skill at all. That is the gap slice A2 closes.
    await reconciler.reconcile();
    expect(store.getTasks()).toEqual([]);

    const roots = { dorkHome };
    const { applied } = applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, {
      sweepOrphans: true,
    });
    expect(applied).toHaveLength(1);

    await reconciler.reconcile();

    const rows = store.getTasks();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // The name a person reads is the frontmatter's, not the namespaced directory
    // the link is called — discovery relaxes the name-must-match rule precisely
    // because Harness Sync projects `<pkg>__<name>` links.
    expect(row?.name).toBe('daily-sweep');
    expect(row?.cron).toBe('0 9 * * *');
    // Parked, like every discovered schedule: a package installing itself is not
    // a person saying yes.
    expect(row?.status).toBe('pending_approval');
    // One row, not two: the schedule's identity is the file's REAL path, so the
    // link and its target are one schedule.
    expect(row?.filePath).toContain(path.join('plugins', 'globex', 'skills', 'daily-sweep'));
  });

  it('stops being discovered when the package is uninstalled and the sync sweeps its link', async () => {
    await installGlobalPackage('globex', 'daily-sweep');
    const roots = { dorkHome };
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
    await reconciler.reconcile();
    expect(store.getTasks()).toHaveLength(1);

    await rm(path.join(dorkHome, 'plugins', 'globex'), { recursive: true, force: true });
    const { swept } = applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, {
      sweepOrphans: true,
    });
    expect(swept).toHaveLength(1);
    // The link is GONE, not merely listed. `swept` is what the finder named, so
    // a sweep that names a path and removes nothing would satisfy the line
    // above and leave a dead link in the folder the scheduler walks.
    expect(
      lstatSync(path.join(dorkHome, 'skills', 'globex__daily-sweep'), { throwIfNoEntry: false })
    ).toBeUndefined();

    // The row the LIVE store is holding is retired in the same pass (DOR-1934).
    // It used to survive: the reconciler only retires a row whose file sits in a
    // directory the pass enumerated, and a packaged skill's row is keyed on its
    // RESOLVED path — `<dorkHome>/plugins/<pkg>/skills/<name>/SKILL.md`, which is
    // under no watched root at all. Once the link was swept there was nothing
    // left to testify about it, so the schedule stayed on the clock for a
    // package that is not installed any more.
    await reconciler.reconcile();
    const retired = store.getTasks();
    expect(retired).toHaveLength(1);
    // Paused stops the clock; the person's own switch is left as it was (FB-26).
    expect(retired[0]?.status).toBe('paused');

    // The skill is no longer DISCOVERABLE: a store that has never seen it finds
    // nothing in the same root. Asserting `status === 'active'` is empty was
    // vacuous — a discovered schedule parks as `pending_approval`.
    const fresh = new TaskStore(createTestDb());
    const freshReconciler = new TaskReconciler(
      fresh,
      new TaskRegistrar({ store: fresh, scheduler }),
      new ScheduleIdentityRegistry()
    );
    for (const root of globalTaskRoots(dorkHome)) freshReconciler.addRoot(root);
    await freshReconciler.reconcile();
    expect(fresh.getTasks()).toEqual([]);
  });

  it('retires the row when the link goes and the package stays', async () => {
    // DOR-1934, the other half. A link can go for reasons that have nothing to
    // do with an uninstall — the plan stopped naming it, a folder stopped being
    // shared, somebody tidied the directory — and the file at the end of it is
    // still on disk. The row must still retire, because what made the skill a
    // schedule was being reachable from a watched root, and it is not any more.
    // Keying retirement on the FILE's existence answers "the file is right
    // there" and leaves the row firing for a skill nothing can reach.
    await installGlobalPackage('globex', 'daily-sweep');
    const roots = { dorkHome };
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
    await reconciler.reconcile();
    expect(store.getTasks()).toHaveLength(1);

    await rm(path.join(dorkHome, 'skills', 'globex__daily-sweep'), { force: true });
    // The package, and the file the row is keyed on, are both still there.
    expect(
      lstatSync(path.join(dorkHome, 'plugins', 'globex', 'skills', 'daily-sweep', 'SKILL.md'), {
        throwIfNoEntry: false,
      })
    ).toBeDefined();

    await reconciler.reconcile();

    const rows = store.getTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('paused');
  });

  it('retires one skill’s row while its sibling in the same package keeps firing', async () => {
    // The hole gate 1 leaves open, and the reason the unreachable rule may not
    // be gated behind it. `scannedDirs` records the PARENT of every directory a
    // link points into — `<pkg>/skills` — so one surviving sibling link makes
    // "this pass enumerated the directory" true for every row in the package,
    // and a row whose own link was swept read as merely skipped by the scan.
    // Seeded defect: `!enumerated && isInsideAny(…)`. Then `daily` stays armed
    // for as long as `weekly` exists.
    await installGlobalPackage('globex', 'daily-sweep', 'weekly-sweep');
    const roots = { dorkHome };
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
    await reconciler.reconcile();
    expect(store.getTasks()).toHaveLength(2);

    await rm(path.join(dorkHome, 'skills', 'globex__daily-sweep'), { force: true });
    await reconciler.reconcile();

    const byName = new Map(store.getTasks().map((t) => [t.name, t]));
    expect({
      daily: byName.get('daily-sweep')?.status,
      weekly: byName.get('weekly-sweep')?.status,
    }).toEqual({ daily: 'paused', weekly: 'pending_approval' });
  });

  it('leaves a row alone while its link is still there', async () => {
    // The floor under both cases above, and the one that keeps "unreachable"
    // from becoming "retire everything the pass did not walk into". Seeded
    // defect: treat any row under a plugins folder as unreachable without
    // asking whether a link still resolves to it.
    await installGlobalPackage('globex', 'daily-sweep');
    const roots = { dorkHome };
    applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
    await reconciler.reconcile();
    const before = store.getTasks();
    expect(before).toHaveLength(1);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(
      store.getTasks().map((t) => ({ id: t.id, status: t.status, enabled: t.enabled }))
    ).toEqual(before.map((t) => ({ id: t.id, status: t.status, enabled: t.enabled })));
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'keeps the schedule when the packages folder is momentarily unreadable',
    async () => {
      // The whole reason `unreadableRoot` exists. Before it, a `chmod 000` on
      // `<dorkHome>/plugins` produced an empty plan, the sweep read that plan as
      // "nothing is installed", every global link went, and this row went with
      // them — a person's daily job silently stopped because a folder was briefly
      // unreadable. Seeded red: drop the guard in `findGlobalOrphans`.
      await installGlobalPackage('globex', 'daily-sweep');
      const roots = { dorkHome };
      applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, { sweepOrphans: true });
      await reconciler.reconcile();
      const before = store.getTasks();
      expect(before).toHaveLength(1);

      await chmod(path.join(dorkHome, 'plugins'), 0o000);
      try {
        const plan = projectGlobal({ roots, harnesses: [] });
        const { swept } = applyGlobalPlan(plan, roots, { sweepOrphans: true });
        expect(swept).toEqual([]);
      } finally {
        await chmod(path.join(dorkHome, 'plugins'), 0o755);
      }

      await reconciler.reconcile();
      const after = store.getTasks();
      expect(after.map((t) => ({ id: t.id, name: t.name, status: t.status }))).toEqual(
        before.map((t) => ({ id: t.id, name: t.name, status: t.status }))
      );
    }
  );
});
