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
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskStore } from '../task-store.js';
import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

/** A task SKILL.md with the given cron, in UTC so next-run times are stable. */
function skillFile(name: string, cron: string, timezone = 'UTC'): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\nschedule:\n  cron: '${cron}'\n  timezone: ${timezone}\n---\nDo the thing.`;
}

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
  let skillsDir: string;
  let db: Db;
  let store: TaskStore;
  let scheduler: TaskSchedulerService;
  let registrar: TaskRegistrar;
  let watcher: TaskFileWatcher;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'task-registrar-'));
    skillsDir = path.join(dorkHome, 'skills');
    await mkdir(skillsDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new TaskSchedulerService(store, silentAgentManager(), {
      maxConcurrentRuns: 1,
      retentionCount: 100,
      // Nothing in this file waits long enough to fire, and the schedules are
      // hours out; firing stays on so the jobs are the real thing.
      mayFire: true,
      firingReason: 'test',
    });
    registrar = new TaskRegistrar({ store, scheduler });
    watcher = new TaskFileWatcher(store, registrar, new ScheduleIdentityRegistry());
    await scheduler.start();
  });

  afterEach(async () => {
    await watcher.stopAll();
    await scheduler.stop();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** Write `<skillsDir>/<slug>/SKILL.md` and return its REAL path (a row's identity). */
  async function writeTask(slug: string, cron: string, timezone = 'UTC'): Promise<string> {
    const dir = path.join(skillsDir, slug);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await writeFile(filePath, skillFile(slug, cron, timezone), 'utf-8');
    return realpath(filePath);
  }

  /** A person's approval: the `status: 'active'` transition `PATCH /api/tasks/:id` performs. */
  function approve(taskId: string): void {
    store.updateTask(taskId, { status: 'active' });
    registrar.syncTask(taskId);
  }

  // The headline: the cockpit showed the new cron while the old one kept firing,
  // until the next server restart.
  it('re-registers the job when a cron is edited on disk', async () => {
    const filePath = await writeTask('nightly', '0 9 * * *');
    watcher.watch(skillsRoot(skillsDir, 'global'));

    const task = await waitFor(() => store.fileSync.getByFilePath(filePath), 'the task to sync');
    approve(task.id);
    await waitFor(() => scheduler.isRegistered(task.id) || null, 'the task to be scheduled');
    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(9);

    await writeFile(filePath, skillFile('nightly', '0 21 * * *'), 'utf-8');

    // A changed cron is different work, and nobody has read this one: the grant
    // the approval made was for the 9am schedule. So the old job stops rather
    // than silently becoming a schedule the operator never saw.
    await waitFor(
      () => (!scheduler.isRegistered(task.id) ? true : null),
      'the 9am job to stop once its content changed'
    );
    expect(store.getTask(task.id)?.status).toBe('pending_approval');
    // …and the row agrees, so the screen and the clock say the same thing.
    expect(store.getTask(task.id)?.cron).toBe('0 21 * * *');

    approve(task.id);
    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(21);
  });

  // The reconciler is the backstop for a change the watcher missed. A backstop
  // that only repaired the row left the clock exactly as stale as before.
  it('the reconciler re-registers a cron that changed while the watcher was blind', async () => {
    const filePath = await writeTask('missed', '0 7 * * *');
    // No watcher at all — this is the missed-event case, reproduced by never
    // delivering the event in the first place.
    const reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
    reconciler.addRoot(skillsRoot(skillsDir, 'global'));

    await reconciler.reconcile();
    const task = store.fileSync.getByFilePath(filePath)!;
    approve(task.id);
    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(7);

    await writeFile(filePath, skillFile('missed', '0 19 * * *'), 'utf-8');
    await reconciler.reconcile();

    // The backstop carries the change all the way: the row holds the new cron
    // and the stale 7am job is gone, waiting on the operator rather than firing
    // a schedule nobody approved.
    expect(store.getTask(task.id)?.cron).toBe('0 19 * * *');
    expect(scheduler.isRegistered(task.id)).toBe(false);

    approve(task.id);
    expect(scheduler.getNextRun(task.id)?.getUTCHours()).toBe(19);
  });

  // A file going away and coming back is what an ordinary SAVE looks like
  // (temp file + rename), so an approval survives a round trip when the
  // content is unchanged (DOR-1485 review, I1), and only then.
  it('the reconciler stops a gone file, re-arms it unchanged, and re-parks it changed', async () => {
    const filePath = await writeTask('comes-and-goes', '0 6 * * *');
    const reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
    reconciler.addRoot(skillsRoot(skillsDir, 'global'));
    await reconciler.reconcile();
    const task = store.fileSync.getByFilePath(filePath)!;
    approve(task.id);
    expect(scheduler.isRegistered(task.id)).toBe(true);

    await rm(filePath);
    await reconciler.reconcile();
    expect(store.getTask(task.id)?.status).toBe('paused');
    expect(scheduler.isRegistered(task.id)).toBe(false);

    await writeFile(filePath, skillFile('comes-and-goes', '0 6 * * *'), 'utf-8');
    await reconciler.reconcile();
    expect(store.getTask(task.id)?.status).toBe('active');
    expect(scheduler.isRegistered(task.id)).toBe(true);

    await rm(filePath);
    await reconciler.reconcile();
    await writeFile(filePath, skillFile('comes-and-goes', '0 23 * * *'), 'utf-8');
    await reconciler.reconcile();
    expect(store.getTask(task.id)?.status).toBe('pending_approval');
    expect(scheduler.isRegistered(task.id)).toBe(false);
  });

  // Containment, from the direction a real operator meets it: a typo in a file
  // they were editing by hand.
  it('the reconciler survives a file whose cron croner cannot read', async () => {
    const goodPath = await writeTask('good', '0 8 * * *');
    const badPath = await writeTask('bad', 'banana');
    const reconciler = new TaskReconciler(store, registrar, new ScheduleIdentityRegistry());
    reconciler.addRoot(skillsRoot(skillsDir, 'global'));

    await expect(reconciler.reconcile()).resolves.toMatchObject({ upserted: 2 });

    const good = store.fileSync.getByFilePath(goodPath)!;
    const bad = store.fileSync.getByFilePath(badPath)!;
    // The unreadable one keeps its row — its history and id are not the typo's
    // to take — and says what is wrong with it, which is new: the complaint
    // used to exist only in the log.
    expect(bad.reason).toContain('banana');
    approve(good.id);
    approve(bad.id);
    // Even approved, the typo has no job. Containment is the scheduler's, and
    // it holds whatever a person clicks.
    expect(scheduler.isRegistered(bad.id)).toBe(false);
    expect(scheduler.isRegistered(good.id)).toBe(true);
  });
});
