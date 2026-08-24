import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, pulseRuns, pulseDispatchLog, type Db } from '@dorkos/db';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { legacyRoot } from './task-root-fixtures.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // The real one, not a stub: assertions below check the exact shape the
  // reconciler hands the logger, and a stub would let a regression through.
  logError: (err: unknown) =>
    err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) },
  // The registrar (constructed by these suites) builds a tagged child logger at
  // import time; without this the module mock has no `createTaggedLogger` to
  // give it and the whole suite fails to load.
  createTaggedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { logger } from '../../../lib/logger.js';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { TaskStore } from '../task-store.js';
import {
  TASK_TEMPLATES_DIRNAME,
  ensureDefaultTemplates,
  loadTemplates,
} from '../task-templates.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Frontmatter + body for a minimal, schema-valid task SKILL.md. */
function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\ncron: '0 9 * * *'\n---\nDo the thing.`;
}

describe('TaskReconciler', () => {
  // A throwaway stand-in for `~/.dork`; the real one is never touched.
  let dorkHome: string;
  let tasksDir: string;
  let db: Db;
  let store: TaskStore;
  let reconciler: TaskReconciler;
  let scheduler: FakeScheduler;

  beforeEach(async () => {
    vi.clearAllMocks();
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'task-reconciler-'));
    tasksDir = path.join(dorkHome, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new FakeScheduler();
    reconciler = new TaskReconciler(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry()
    );
    reconciler.addRoot(legacyRoot(tasksDir, 'global'));
  });

  afterEach(async () => {
    reconciler.stop();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** Write `{tasksDir}/{relativeDir}/SKILL.md` and return its absolute path. */
  async function writeTask(relativeDir: string, name: string): Promise<string> {
    const dir = path.join(tasksDir, relativeDir);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, skillFile(name), 'utf-8');
    return filePath;
  }

  /** Insert a task row whose file is already gone and whose grace period has expired. */
  function createExpiredOrphan(slug: string): string {
    const task = store.createTask({
      name: slug,
      description: 'gone from disk',
      prompt: 'gone from disk',
      filePath: path.join(tasksDir, slug, 'SKILL.md'),
    });
    db.update(pulseSchedules)
      .set({ updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() })
      .where(eq(pulseSchedules.id, task.id))
      .run();
    return task.id;
  }

  describe('orphan removal', () => {
    it('removes an orphan that has run history instead of aborting the pass', async () => {
      const taskId = createExpiredOrphan('gone-task');
      store.createRun(taskId, 'manual');
      store.claimScheduledRun(taskId, 1_700_000_000_000, { status: 'running' });

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 1 });

      expect(store.getTasks()).toEqual([]);
      expect(db.select().from(pulseRuns).where(eq(pulseRuns.scheduleId, taskId)).all()).toEqual([]);
      expect(
        db.select().from(pulseDispatchLog).where(eq(pulseDispatchLog.taskId, taskId)).all()
      ).toEqual([]);
    });

    it('keeps going when one orphan fails to delete, and logs the failure', async () => {
      const doomedId = createExpiredOrphan('explodes');
      const healthyId = createExpiredOrphan('deletes-fine');

      const realDelete = store.deleteTask.bind(store);
      vi.spyOn(store, 'deleteTask').mockImplementation((id: string) => {
        if (id === doomedId) throw new Error('boom');
        return realDelete(id);
      });

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 1 });

      expect(store.getTask(doomedId)).not.toBeNull();
      expect(store.getTask(healthyId)).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(doomedId),
        expect.objectContaining({ error: expect.any(String) })
      );
    });

    it('pauses an orphan that is still inside the grace period', async () => {
      const task = store.createTask({
        name: 'recently-gone',
        description: 'gone from disk',
        prompt: 'gone from disk',
        filePath: path.join(tasksDir, 'recently-gone', 'SKILL.md'),
      });

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTask(task.id)?.status).toBe('paused');
    });
  });

  describe('reserved directories', () => {
    it('does not report the templates container as an invalid task', async () => {
      // How the server seeds templates: a container of template directories,
      // which by design has no SKILL.md of its own.
      await writeTask(
        path.join(TASK_TEMPLATES_DIRNAME, 'daily-health-check'),
        'daily-health-check'
      );
      await writeTask('real-task', 'real-task');

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 1, orphaned: 0 });

      expect(logger.warn).not.toHaveBeenCalled();
      expect(store.getTasks().map((t) => t.name)).toEqual(['real-task']);
    });

    it('still reports a genuinely malformed task directory', async () => {
      await fs.mkdir(path.join(tasksDir, 'no-skill-here'), { recursive: true });

      await reconciler.reconcile();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no-skill-here'));
    });

    it('reconciles a freshly seeded data directory in silence, and templates still load', async () => {
      await ensureDefaultTemplates(dorkHome);

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(logger.warn).not.toHaveBeenCalled();
      // Seeded templates are offered as starting points, never scheduled as tasks.
      expect(store.getTasks()).toEqual([]);
      expect((await loadTemplates(dorkHome)).length).toBeGreaterThan(0);
    });
  });

  describe('a file that is on disk is never treated as deleted', () => {
    /** Age every row so the next pass is past the 24h grace period. */
    function expireGracePeriod(): void {
      db.update(pulseSchedules)
        .set({ updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() })
        .run();
    }

    it('keeps a task whose frontmatter stopped parsing, with its run history', async () => {
      const filePath = await writeTask('typo-task', 'typo-task');
      await reconciler.reconcile();
      const created = store.getTasks()[0];
      store.createRun(created.id, 'scheduled');

      // The user hand-edits SKILL.md and fat-fingers a boolean.
      await fs.writeFile(
        filePath,
        `---\nname: typo-task\ndescription: Broken\nenabled: yes-please\n---\nBody`,
        'utf-8'
      );
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      // Same row, same id, same status, history intact — the file is right
      // there. The status is compared to what it was rather than named
      // literally, because the claim is that a failed parse changes NOTHING
      // about the row, whatever state the arm gate left it in.
      const after = store.getTask(created.id);
      expect(after).not.toBeNull();
      expect(after?.status).toBe(created.status);
      expect(store.countRuns(created.id)).toBe(1);
    });

    it('keeps a task in a slot the scan skips by name', async () => {
      // The watcher accepts any `<tasksDir>/*/SKILL.md`, including one inside
      // the reserved templates container, and creates a row for it. The scan
      // skips that slot by name, which used to look exactly like a deletion.
      await fs.mkdir(path.join(tasksDir, TASK_TEMPLATES_DIRNAME), { recursive: true });
      const filePath = path.join(tasksDir, TASK_TEMPLATES_DIRNAME, 'SKILL.md');
      await fs.writeFile(filePath, skillFile(TASK_TEMPLATES_DIRNAME), 'utf-8');
      const task = store.createTask({
        name: TASK_TEMPLATES_DIRNAME,
        description: 'row the watcher created for a reserved slot',
        prompt: 'do it',
        filePath,
      });
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTask(task.id)).not.toBeNull();
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    });

    it('keeps a task whose directory is a symlink to somewhere else', async () => {
      // `readdir(withFileTypes)` does not follow links, so `entry.isDirectory()`
      // is false and the scan skips the slot — while the file is right there
      // and perfectly readable.
      const realDir = path.join(dorkHome, 'shared', 'nightly-sweep');
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, 'SKILL.md'), skillFile('nightly-sweep'), 'utf-8');
      const linkPath = path.join(tasksDir, 'nightly-sweep');
      await fs.symlink(realDir, linkPath);

      const filePath = path.join(linkPath, 'SKILL.md');
      const task = store.createTask({
        name: 'nightly-sweep',
        description: 'lives behind a symlink',
        prompt: 'do it',
        filePath,
      });
      store.createRun(task.id, 'scheduled');
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTask(task.id)).not.toBeNull();
      expect(store.countRuns(task.id)).toBe(1);
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    });

    it('switches a waiting schedule off when its file goes, and back on when it returns', async () => {
      const filePath = await writeTask('flaky-file', 'flaky-file');
      await reconciler.reconcile();
      const created = store.getTasks()[0];

      await fs.rm(filePath);
      await reconciler.reconcile();
      // Switched off, but still WAITING — not `paused`. `paused` means "this was
      // live and its file went away", and the arm gate reads it as an approval
      // that survived a save. Writing it over a schedule nobody approved would
      // let a delete-and-restore launder the missing approval.
      expect(store.getTask(created.id)?.status).toBe('pending_approval');
      expect(store.getTask(created.id)?.enabled).toBe(false);

      // The file comes back before the grace period expires.
      await writeTask('flaky-file', 'flaky-file');
      await reconciler.reconcile();

      // `paused` is DorkOS's own "the file went away" marker, and it is gone.
      //
      // The row keeps whatever standing it had, because the content that came
      // back is byte-identical to the content that left: an unlink followed by a
      // recreate is what an ordinary atomic save looks like, and treating it as
      // a fresh unapproved schedule would re-park every schedule on every save
      // (DOR-1485 review, I1). This row was never approved in the first place,
      // so `pending_approval` is where it stays.
      // `task-registrar.integration.test.ts` follows an APPROVED file through
      // the same round trip, all the way to the clock.
      expect(store.getTask(created.id)?.status).toBe('pending_approval');
      expect(store.getTask(created.id)?.enabled).toBe(true);
    });

    // Root ignores file permissions, so the chmod setup only works non-root.
    // NOTE: this SKIPS in any root container (including CI Docker images), so a
    // green run there is not evidence the unlistable-directory path is covered.
    // Verify it on a non-root machine before trusting the suite on this point.
    it.skipIf(process.getuid?.() === 0)(
      'leaves every task alone when its directory cannot be listed',
      async () => {
        await writeTask('alpha', 'alpha');
        await writeTask('beta', 'beta');
        await reconciler.reconcile();
        expect(store.getTasks()).toHaveLength(2);
        const before = store.getTasks().map((t) => [t.id, t.status] as const);

        // Simulates EACCES, and equally the EMFILE a file-descriptor squeeze
        // produces — the scan cannot look, which is not evidence of deletion.
        await fs.chmod(tasksDir, 0o000);
        expireGracePeriod();
        try {
          await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });
        } finally {
          await fs.chmod(tasksDir, 0o755);
        }

        expect(store.getTasks()).toHaveLength(2);
        // Untouched, not merely present: a pass that could not look must leave
        // every row exactly as it found it.
        expect(store.getTasks().map((t) => [t.id, t.status] as const)).toEqual(before);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining(tasksDir),
          expect.objectContaining({ error: expect.any(String) })
        );
      }
    );
  });

  describe('a directory nobody listed cannot testify that a file is gone', () => {
    /** Age every row so the next pass is past the 24h grace period. */
    function expireGracePeriod(): void {
      db.update(pulseSchedules)
        .set({ updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() })
        .run();
    }

    /** A project tasks directory with one real task file, never registered. */
    async function unregisteredProjectTask(): Promise<{ dir: string; filePath: string }> {
      const dir = path.join(dorkHome, 'late-project', '.dork', 'tasks');
      await fs.mkdir(path.join(dir, 'late-task'), { recursive: true });
      const filePath = path.join(dir, 'late-task', 'SKILL.md');
      await fs.writeFile(filePath, skillFile('late-task'), 'utf-8');
      store.createTask({
        name: 'late-task',
        description: 'created for an agent that registered after boot',
        prompt: 'do it',
        filePath,
      });
      return { dir, filePath };
    }

    it('leaves a task whose directory was never registered', async () => {
      // addDirectory only runs at boot and Mesh has no onRegister hook, so a
      // task created for an agent that registered afterwards lives in a
      // directory this pass never looks at.
      const { filePath } = await unregisteredProjectTask();
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTasks()).toHaveLength(1);
      expect(store.getTasks()[0].status).toBe('active');
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    });

    it('leaves a task behind after its directory is removed on agent unregister', async () => {
      const { dir } = await unregisteredProjectTask();
      reconciler.addRoot(legacyRoot(dir, 'project', path.join(dorkHome, 'late-project')));
      await reconciler.reconcile();
      const task = store.getTasks()[0];
      store.createRun(task.id, 'scheduled');

      // The agent unregisters: index.ts drops the directory but keeps the rows.
      reconciler.removeDirectory(dir);
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      // Re-registering must find the same row, with its history.
      expect(store.getTask(task.id)).not.toBeNull();
      expect(store.countRuns(task.id)).toBe(1);
    });

    it('leaves a task in an unregistered directory even when its file is gone too', async () => {
      // The discriminating case for gate 1. In every other test here the file
      // is still on disk, so gate 2 (`fs.access`) alone would keep the row and
      // gate 1 could be deleted without a single failure. Here the file is
      // gone AND nobody was watching the folder — the honest answer is "no
      // idea", because the directory this row belongs to was never enumerated.
      // A checkout moved or deleted while its agent was not registered looks
      // exactly like this.
      const { dir, filePath } = await unregisteredProjectTask();
      const task = store.getTasks()[0];
      store.createRun(task.id, 'scheduled');
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      // Nobody looked in `dir`, so nothing there can be declared deleted.
      expect(dir).toContain('late-project');
      expect(store.getTask(task.id)).not.toBeNull();
      expect(store.getTask(task.id)?.status).toBe('active');
      expect(store.countRuns(task.id)).toBe(1);
    });

    it('leaves every task alone when a registered directory has vanished wholesale', async () => {
      // A registered directory that no longer exists was also never looked at.
      // `scanSkillDirectory` answers ENOENT with `[]` rather than a throw, so
      // without an explicit existence check the pass treats a deleted checkout
      // as "I enumerated it and it was empty" — and every task in it, files and
      // run history included, is destroyed 24h later. Before this branch the FK
      // error accidentally prevented that; the cascade removes that accident.
      const projectDir = path.join(dorkHome, 'doomed-project', '.dork', 'tasks');
      await fs.mkdir(path.join(projectDir, 'nightly'), { recursive: true });
      await fs.writeFile(
        path.join(projectDir, 'nightly', 'SKILL.md'),
        skillFile('nightly'),
        'utf-8'
      );
      reconciler.addRoot(legacyRoot(projectDir, 'project', path.join(dorkHome, 'doomed-project')));
      await reconciler.reconcile();
      const task = store.getTasks()[0];
      store.createRun(task.id, 'scheduled');

      // The whole checkout goes away — an unmounted volume, a deleted clone.
      await fs.rm(path.join(dorkHome, 'doomed-project'), { recursive: true, force: true });
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTask(task.id)).not.toBeNull();
      expect(store.countRuns(task.id)).toBe(1);
    });
  });

  describe('same slug in two directories', () => {
    it('pauses only the task whose own file is gone', async () => {
      // Two projects, each with a task called flow-drain — the exact shape
      // found on real data.
      const projectDir = path.join(dorkHome, 'project', '.dork', 'tasks');
      await fs.mkdir(path.join(projectDir, 'flow-drain'), { recursive: true });
      const projectFile = path.join(projectDir, 'flow-drain', 'SKILL.md');
      await fs.writeFile(projectFile, skillFile('flow-drain'), 'utf-8');
      reconciler.addRoot(legacyRoot(projectDir, 'project', path.join(dorkHome, 'project')));

      const globalFile = path.join(tasksDir, 'flow-drain', 'SKILL.md');
      store.createTask({
        name: 'flow-drain',
        description: 'global copy whose file is gone',
        prompt: 'gone',
        filePath: globalFile,
      });

      await reconciler.reconcile();

      const project = store.getTasks().find((t) => t.filePath === projectFile);
      const global = store.getTasks().find((t) => t.filePath === globalFile);
      // The project one is a live sighting: parked for approval, never paused.
      // Only the copy whose own file is gone is paused.
      expect(project?.status).toBe('pending_approval');
      expect(project?.enabled).toBe(true);
      expect(global?.status).toBe('paused');
    });
  });

  describe('scan resilience', () => {
    it('keeps a task that failed to sync out of the orphan set', async () => {
      const filePath = await writeTask('flaky', 'flaky');
      store.createTask({
        name: 'flaky',
        description: 'on disk',
        prompt: 'on disk',
        filePath,
      });
      db.update(pulseSchedules)
        .set({ updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() })
        .where(eq(pulseSchedules.filePath, filePath))
        .run();

      vi.spyOn(store, 'upsertFromFile').mockImplementation(() => {
        throw new Error('db is busy');
      });

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      // The file is on disk — a failed write must never make it look deleted.
      expect(store.getTasks()).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(filePath),
        expect.objectContaining({ error: expect.any(String) })
      );
    });
  });

  describe('no single failure can disable the safety net', () => {
    it('survives the whole-DB read for retirement throwing', async () => {
      // The original bug in one sentence: a throw the pass did not contain
      // aborts every future pass too, because the timer just calls it again.
      // This read sits outside the per-row try, so it needs its own.
      await writeTask('real-task', 'real-task');
      vi.spyOn(store, 'getTasks').mockImplementation(() => {
        throw new Error('database is locked');
      });

      // Resolves rather than rejects, and still reports the sync half it did.
      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 1, orphaned: 0 });

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read tasks'),
        expect.objectContaining({ error: 'database is locked' })
      );
    });
  });

  describe('a standing fault logs once an hour, not twelve times', () => {
    const HOUR_MS = 60 * 60 * 1000;
    /** Twelve passes is one hour at the real 5-minute cadence. */
    const PASSES_PER_HOUR = 12;

    // The clock is pinned because the damping window is the whole subject:
    // with a real clock every pass lands inside the first window and the test
    // could never tell "suppressed correctly" from "never logs again".
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-31T09:00:00Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** A task file whose frontmatter does not parse — a fault that never clears. */
    async function writeBrokenTask(slug: string): Promise<string> {
      const dir = path.join(tasksDir, slug);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, 'SKILL.md');
      await fs.writeFile(filePath, `---\nname: ${slug}\nenabled: yes-please\n---\nBody`, 'utf-8');
      return filePath;
    }

    it('logs the first occurrence in full, and swallows an hour of identical repeats', async () => {
      await writeBrokenTask('broken');

      await reconciler.reconcile();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      // The first report of a fault is never withheld or abbreviated.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('broken'));

      // The remaining eleven passes of the hour say nothing new.
      for (let i = 1; i < PASSES_PER_HOUR; i++) {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await reconciler.reconcile();
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('speaks up again after the hour, saying how much it held back', async () => {
      await writeBrokenTask('broken');

      await reconciler.reconcile();
      for (let i = 1; i < PASSES_PER_HOUR; i++) {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await reconciler.reconcile();
      }

      vi.advanceTimersByTime(5 * 60 * 1000);
      await reconciler.reconcile();

      expect(logger.warn).toHaveBeenCalledTimes(2);
      // A standing fault must read as standing, not as a fresh one-off.
      expect(logger.warn).toHaveBeenLastCalledWith(
        expect.stringContaining('11 identical reports suppressed in the last hour')
      );
    });

    it('never damps a different fault behind one already being held back', async () => {
      await writeBrokenTask('broken-one');
      await reconciler.reconcile();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      // Same call site, same minute, different file: a distinct fault, and the
      // operator has not seen it yet.
      await writeBrokenTask('broken-two');
      await reconciler.reconcile();

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('broken-two'));
    });

    it('damps a repeating error the same way, and keeps the error object on the first', async () => {
      const filePath = await writeTask('flaky', 'flaky');
      vi.spyOn(store, 'upsertFromFile').mockImplementation(() => {
        throw new Error('db is busy');
      });

      await reconciler.reconcile();
      expect(logger.error).toHaveBeenCalledTimes(1);
      // Whatever a reader would have got before the damper, they still get.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(filePath),
        expect.objectContaining({ error: expect.any(String) })
      );

      for (let i = 1; i < PASSES_PER_HOUR; i++) {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await reconciler.reconcile();
      }
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('logs immediately when the same operation starts failing a different way', async () => {
      await writeTask('flaky', 'flaky');
      const upsert = vi.spyOn(store, 'upsertFromFile').mockImplementation(() => {
        throw new Error('db is busy');
      });

      await reconciler.reconcile();
      expect(logger.error).toHaveBeenCalledTimes(1);

      upsert.mockImplementation(() => {
        throw new Error('disk is full');
      });
      await reconciler.reconcile();

      // Same file, same call site, well inside the window — but a different
      // failure, which is news.
      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenLastCalledWith(
        expect.stringContaining('flaky'),
        expect.objectContaining({ error: 'disk is full' })
      );
    });

    it('keeps each of two standing faults counting independently', async () => {
      // Both faults report on the same 5-minute cadence, so when the first
      // one's window closes it logs and runs the sweep — at which point the
      // second's entry is exactly a window old and looks abandoned, though it
      // is mid-suppression with a count to report. Losing it means the second
      // fault re-introduces itself as brand new every hour, forever, and its
      // suppressed count is silently discarded.
      await writeBrokenTask('broken-a');
      await writeBrokenTask('broken-b');

      await reconciler.reconcile();
      expect(logger.warn).toHaveBeenCalledTimes(2);

      for (let i = 1; i <= PASSES_PER_HOUR; i++) {
        vi.advanceTimersByTime(5 * 60 * 1000);
        await reconciler.reconcile();
      }

      const lines = (logger.warn as unknown as { mock: { calls: string[][] } }).mock.calls.map(
        (c) => c[0]
      );
      const closing = lines.filter((l) => l.includes('suppressed in the last hour'));
      // One window-close line each, and BOTH carry what they held back.
      expect(closing).toHaveLength(2);
      expect(closing.some((l) => l.includes('broken-a'))).toBe(true);
      expect(closing.some((l) => l.includes('broken-b'))).toBe(true);
      for (const line of closing) {
        expect(line).toContain('11 identical reports suppressed');
      }
    });

    it('forgets a fault that stopped happening, so its return logs in full', async () => {
      await writeBrokenTask('broken');
      await reconciler.reconcile();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      // The user fixes the file, and an hour passes quietly.
      await fs.writeFile(path.join(tasksDir, 'broken', 'SKILL.md'), skillFile('broken'), 'utf-8');
      vi.advanceTimersByTime(HOUR_MS);
      await reconciler.reconcile();
      expect(logger.warn).toHaveBeenCalledTimes(1);

      // It breaks again. That is a new problem to a person reading the log.
      await writeBrokenTask('broken');
      await reconciler.reconcile();

      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith(expect.not.stringContaining('suppressed'));
    });
  });
});
