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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  } as unknown as SchedulerAgentManager;
}

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
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Install a package for all projects, holding one skill that runs on a timer. */
  async function installGlobalPackage(name: string, skill: string): Promise<void> {
    const dir = path.join(dorkHome, 'plugins', name);
    await mkdir(path.join(dir, '.dork'), { recursive: true });
    await writeFile(
      path.join(dir, '.dork', 'manifest.json'),
      JSON.stringify({ name, version: '1.0.0', type: 'plugin', description: name })
    );
    await mkdir(path.join(dir, 'skills', skill), { recursive: true });
    await writeFile(
      path.join(dir, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: A skill named ${skill}\nschedule:\n  cron: '0 9 * * *'\n---\nDo the thing.\n`
    );
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

    await reconciler.reconcile();
    expect(store.getTasks().filter((t) => t.status === 'active')).toEqual([]);
  });
});
