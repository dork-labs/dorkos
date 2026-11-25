/**
 * A scheduled skill in a package installed for all projects actually runs:
 * the real `projectGlobal` and `applyGlobalPlan` write the link and the real
 * `TaskReconciler` walks `<dorkHome>/skills` afterwards. Nothing fires.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyGlobalPlan, projectGlobal } from '@dorkos/harness';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { globalTaskRoots } from '../skills-roots.js';
import { FakeScheduler } from './fake-scheduler.js';

/** `chmod 000` is ignored on Windows and as root; a green skip there proves nothing. */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('a scheduled skill installed for all projects', () => {
  let dorkHome: string;
  let store: TaskStore;
  let reconciler: TaskReconciler;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'global-skill-discovery-'));
    store = new TaskStore(createTestDb());
    reconciler = new TaskReconciler(
      store,
      new TaskRegistrar({ store, scheduler: new FakeScheduler() }),
      new ScheduleIdentityRegistry()
    );
    for (const root of globalTaskRoots(dorkHome)) reconciler.addRoot(root);
  });

  afterEach(async () => {
    // Modes first: a mode-000 folder would leak the whole temp tree.
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

  /** Run a global Harness Sync, then a reconcile pass. */
  async function syncAndReconcile() {
    const roots = { dorkHome };
    const result = applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, {
      sweepOrphans: true,
    });
    await reconciler.reconcile();
    return result;
  }

  it('is discovered once a global sync links it, and retired when it is uninstalled (DOR-1934)', async () => {
    await installGlobalPackage('globex', 'daily-sweep');
    await reconciler.reconcile();
    expect(store.getTasks()).toEqual([]);

    await syncAndReconcile();

    const [row] = store.getTasks();
    expect(row).toMatchObject({ name: 'daily-sweep', status: 'pending_approval' });
    expect(row?.filePath).toContain(path.join('plugins', 'globex', 'skills', 'daily-sweep'));

    await rm(path.join(dorkHome, 'plugins', 'globex'), { recursive: true, force: true });
    const { swept } = await syncAndReconcile();
    expect(swept).toHaveLength(1);
    expect(store.getTasks().map((t) => t.status)).toEqual(['paused']);
  });

  it('retires one skill’s row when its link goes, while its sibling keeps its row', async () => {
    // The package and the file stay; only the link goes. Seeded defect:
    // `!enumerated && isInsideAny(…)` keeps `daily` armed while `weekly` exists.
    await installGlobalPackage('globex', 'daily-sweep', 'weekly-sweep');
    await syncAndReconcile();
    expect(store.getTasks()).toHaveLength(2);

    await rm(path.join(dorkHome, 'skills', 'globex__daily-sweep'), { force: true });
    await reconciler.reconcile();

    const byName = new Map(store.getTasks().map((t) => [t.name, t]));
    expect({
      daily: byName.get('daily-sweep')?.status,
      weekly: byName.get('weekly-sweep')?.status,
    }).toEqual({ daily: 'paused', weekly: 'pending_approval' });
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)(
    'keeps the schedule when the packages folder is momentarily unreadable',
    async () => {
      // Seeded red: drop the `unreadableRoot` guard in `findGlobalOrphans`.
      await installGlobalPackage('globex', 'daily-sweep');
      await syncAndReconcile();
      const before = store.getTasks().map((t) => ({ id: t.id, status: t.status }));
      expect(before).toHaveLength(1);

      await chmod(path.join(dorkHome, 'plugins'), 0o000);
      try {
        const roots = { dorkHome };
        const { swept } = applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, {
          sweepOrphans: true,
        });
        expect(swept).toEqual([]);
      } finally {
        await chmod(path.join(dorkHome, 'plugins'), 0o755);
      }

      await reconciler.reconcile();
      expect(store.getTasks().map((t) => ({ id: t.id, status: t.status }))).toEqual(before);
    }
  );
});
