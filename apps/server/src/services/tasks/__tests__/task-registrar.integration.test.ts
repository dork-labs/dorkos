/**
 * An edit on disk has to reach the clock, not just the database.
 *
 * REAL chokidar, a real `TaskStore`, and a real `TaskSchedulerService` with a
 * real croner behind it — the claim under test is exactly "what is scheduled
 * after this file changes?", and every layer that could quietly not forward the
 * change is one of the three. A test that seeded rows and asserted on a fake
 * scheduler would have passed against the bug this file exists to prevent.
 *
 * Nothing here waits for a cron to fire: every schedule used is hours away, and
 * the assertions read the job's next run rather than its output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

/** A task SKILL.md with the given cron, in UTC so next-run times are stable. */
function skillFile(name: string, cron: string, timezone = 'UTC'): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\ncron: '${cron}'\ntimezone: ${timezone}\n---\nDo the thing.`;
}

/** An agent manager that would run a turn, if anything here ever fired one. */
function silentAgentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {}),
    interruptQuery: vi.fn().mockResolvedValue(true),
  } as unknown as SchedulerAgentManager;
}

/** Poll `check` until it returns something truthy, or fail with `label`. */
async function waitFor<T>(check: () => T | null | undefined, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('a task file on disk drives the running scheduler', () => {
  let dorkHome: string;
  let tasksDir: string;
  let db: Db;
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let registrar: TaskRegistrar;
  let watcher: TaskFileWatcher;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'task-registrar-'));
    tasksDir = path.join(dorkHome, 'tasks');
    await mkdir(tasksDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new TaskSchedulerService(store, silentAgentManager(), {
      maxConcurrentRuns: 1,
      retentionCount: 100,
      timezone: null,
      // Nothing in this file waits long enough to fire, and the schedules are
      // hours out; firing stays on so the jobs are the real thing.
      mayFire: true,
      firingReason: 'test',
    });
    registrar = new TaskRegistrar({ store, scheduler });
    watcher = new TaskFileWatcher(store, registrar);
    await scheduler.start();
  });

  afterEach(async () => {
    await watcher.stopAll();
    await scheduler.stop();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Write `<tasksDir>/<slug>/SKILL.md`, creating the directory if needed. */
  async function writeTask(slug: string, cron: string, timezone = 'UTC'): Promise<string> {
    const dir = path.join(tasksDir, slug);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await writeFile(filePath, skillFile(slug, cron, timezone), 'utf-8');
    return filePath;
  }

  // The headline: the cockpit showed the new cron while the old one kept firing,
  // until the next server restart.
  it('re-registers the job when a cron is edited on disk', async () => {
    const filePath = await writeTask('nightly', '0 9 * * *');
    watcher.watch(tasksDir, 'global');

    const task = await waitFor(() => store.getByFilePath(filePath), 'the task to sync');
    await waitFor(() => scheduler.isRegistered(task.id) || null, 'the task to be scheduled');
    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(9);

    await writeFile(filePath, skillFile('nightly', '0 21 * * *'), 'utf-8');

    const rescheduled = await waitFor(
      () => (scheduler.getNextRun(task.id)?.getUTCHours() === 21 ? true : null),
      'the live job to move to the new cron'
    );
    expect(rescheduled).toBe(true);
    // …and the row agrees, so the screen and the clock say the same thing.
    expect(store.getTask(task.id)?.cron).toBe('0 21 * * *');
  });

  it('schedules a task whose SKILL.md is dropped in after the server started', async () => {
    watcher.watch(tasksDir, 'global');

    const filePath = await writeTask('brand-new', '0 4 * * *');

    const task = await waitFor(() => store.getByFilePath(filePath), 'the new task to sync');
    await waitFor(() => scheduler.isRegistered(task.id) || null, 'the new task to be scheduled');
    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(4);
  });

  it('drops the job when a good cron is edited into a bad one', async () => {
    const filePath = await writeTask('drifts', '0 8 * * *');
    watcher.watch(tasksDir, 'global');
    const task = await waitFor(() => store.getByFilePath(filePath), 'the task to sync');
    await waitFor(() => scheduler.isRegistered(task.id) || null, 'the task to be scheduled');

    await writeFile(filePath, skillFile('drifts', '99 * * * *'), 'utf-8');

    await waitFor(
      () => (!scheduler.isRegistered(task.id) ? true : null),
      'the job to stop rather than keep the schedule nobody asked for'
    );
  });

  // The reconciler is the backstop for a change the watcher missed. A backstop
  // that only repaired the row left the clock exactly as stale as before.
  it('the reconciler re-registers a cron that changed while the watcher was blind', async () => {
    const filePath = await writeTask('missed', '0 7 * * *');
    // No watcher at all — this is the missed-event case, reproduced by never
    // delivering the event in the first place.
    const reconciler = new TaskReconciler(store, registrar);
    reconciler.addDirectory(tasksDir, 'global');

    await reconciler.reconcile();
    const task = store.getByFilePath(filePath)!;
    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(7);

    await writeFile(filePath, skillFile('missed', '0 19 * * *'), 'utf-8');
    await reconciler.reconcile();

    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(19);
  });

  it('the reconciler stops the job for a file that is gone', async () => {
    const filePath = await writeTask('retired', '0 7 * * *');
    const reconciler = new TaskReconciler(store, registrar);
    reconciler.addDirectory(tasksDir, 'global');

    await reconciler.reconcile();
    const task = store.getByFilePath(filePath)!;
    expect(scheduler.isRegistered(task.id)).toBe(true);

    await rm(filePath);
    await reconciler.reconcile();

    expect(scheduler.isRegistered(task.id)).toBe(false);
    expect(store.getTask(task.id)?.status).toBe('paused');
  });

  // The third shape of the bug, and the quietest: `upsertFromFile` un-pauses a
  // row whose file is back, so the cockpit called the task active while nothing
  // was scheduled for it — and nothing ever would be until a restart.
  it('the reconciler starts the job again when a paused task’s file returns', async () => {
    const filePath = await writeTask('comes-and-goes', '0 6 * * *');
    const reconciler = new TaskReconciler(store, registrar);
    reconciler.addDirectory(tasksDir, 'global');

    await reconciler.reconcile();
    const task = store.getByFilePath(filePath)!;
    expect(scheduler.isRegistered(task.id)).toBe(true);

    await rm(filePath);
    await reconciler.reconcile();
    expect(store.getTask(task.id)?.status).toBe('paused');
    expect(scheduler.isRegistered(task.id)).toBe(false);

    await writeFile(filePath, skillFile('comes-and-goes', '0 6 * * *'), 'utf-8');
    await reconciler.reconcile();

    expect(store.getTask(task.id)?.status).toBe('active');
    expect(scheduler.isRegistered(task.id)).toBe(true);
  });

  // Containment, from the direction a real operator meets it: a typo in a file
  // they were editing by hand.
  it('the reconciler survives a file whose cron croner cannot read', async () => {
    const goodPath = await writeTask('good', '0 8 * * *');
    const badPath = await writeTask('bad', 'banana');
    const reconciler = new TaskReconciler(store, registrar);
    reconciler.addDirectory(tasksDir, 'global');

    await expect(reconciler.reconcile()).resolves.toMatchObject({ upserted: 2 });

    const good = store.getByFilePath(goodPath)!;
    const bad = store.getByFilePath(badPath)!;
    // The unreadable one keeps its row — its history and id are not the typo's
    // to take — and simply has no job. The healthy one beside it is untouched.
    expect(scheduler.isRegistered(bad.id)).toBe(false);
    expect(scheduler.isRegistered(good.id)).toBe(true);
  });
});
