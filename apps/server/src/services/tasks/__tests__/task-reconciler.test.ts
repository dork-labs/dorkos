import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, pulseRuns, pulseDispatchLog, type Db } from '@dorkos/db';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import { logger } from '../../../lib/logger.js';
import { TaskReconciler } from '../task-reconciler.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { TaskStore } from '../task-store.js';
import { TASK_TEMPLATES_DIRNAME, ensureDefaultTemplates } from '../task-templates.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Frontmatter + body for a minimal, schema-valid scheduled skill. */
function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: A task named ${name}\nschedule:\n  cron: '0 9 * * *'\n---\nDo the thing.`;
}

/** A SKILL.md whose frontmatter does not parse: `description` is required. */
function unparseableFile(name: string): string {
  return `---\nname: ${name}\n---\nBody`;
}

describe('TaskReconciler', () => {
  // A throwaway stand-in for `~/.dork`; the real one is never touched.
  let dorkHome: string;
  let skillsDir: string;
  let db: Db;
  let store: TaskStore;
  let reconciler: TaskReconciler;
  let scheduler: FakeScheduler;

  beforeEach(async () => {
    // The passes below log every fault they contain; keep the run's output readable.
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => {});
    }
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'task-reconciler-'));
    skillsDir = path.join(dorkHome, 'skills');
    await fs.mkdir(skillsDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new FakeScheduler();
    reconciler = new TaskReconciler(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry()
    );
    reconciler.addRoot(skillsRoot(skillsDir, 'global'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    reconciler.stop();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** Write `{skillsDir}/{relativeDir}/SKILL.md` and return its absolute path. */
  async function writeTask(relativeDir: string, name: string): Promise<string> {
    const dir = path.join(skillsDir, relativeDir);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    await fs.writeFile(filePath, skillFile(name), 'utf-8');
    return filePath;
  }

  /** A row at `filePath`, as an operator or an older build left it. */
  function rowAt(name: string, filePath: string) {
    return store.createTask({ name, description: name, prompt: name, filePath });
  }

  /** Age every row so the next pass is past the 24h grace period. */
  function expireGracePeriod(): void {
    db.update(pulseSchedules)
      .set({ updatedAt: new Date(Date.now() - 2 * DAY_MS).toISOString() })
      .run();
  }

  describe('orphan removal', () => {
    it('removes an orphan that has run history instead of aborting the pass', async () => {
      const taskId = rowAt('gone-task', path.join(skillsDir, 'gone-task', 'SKILL.md')).id;
      store.createRun(taskId, 'manual');
      store.claimScheduledRun(taskId, 1_700_000_000_000, { status: 'running' });
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 1 });

      expect(store.getTasks()).toEqual([]);
      expect(db.select().from(pulseRuns).where(eq(pulseRuns.scheduleId, taskId)).all()).toEqual([]);
      expect(
        db.select().from(pulseDispatchLog).where(eq(pulseDispatchLog.taskId, taskId)).all()
      ).toEqual([]);
    });

    it('keeps going when one orphan fails to delete', async () => {
      const doomedId = rowAt('explodes', path.join(skillsDir, 'explodes', 'SKILL.md')).id;
      const healthyId = rowAt('fine', path.join(skillsDir, 'fine', 'SKILL.md')).id;
      expireGracePeriod();
      const realDelete = store.deleteTask.bind(store);
      vi.spyOn(store, 'deleteTask').mockImplementation((id: string) => {
        if (id === doomedId) throw new Error('boom');
        return realDelete(id);
      });

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 1 });

      expect(store.getTask(doomedId)).not.toBeNull();
      expect(store.getTask(healthyId)).toBeNull();
    });

    it('pauses an orphan that is still inside the grace period', async () => {
      const task = rowAt('recently-gone', path.join(skillsDir, 'recently-gone', 'SKILL.md'));

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTask(task.id)?.status).toBe('paused');
    });
  });

  it('never schedules the seeded templates container, and syncs the task beside it', async () => {
    await ensureDefaultTemplates(dorkHome);
    await writeTask('real-task', 'real-task');

    await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 1, orphaned: 0 });

    expect(store.getTasks().map((t) => t.name)).toEqual(['real-task']);
  });

  describe('a file that is on disk is never treated as deleted', () => {
    it('keeps a task whose frontmatter stopped parsing, with its run history', async () => {
      const filePath = await writeTask('typo-task', 'typo-task');
      await reconciler.reconcile();
      const created = store.getTasks()[0];
      store.createRun(created.id, 'scheduled');

      await fs.writeFile(filePath, unparseableFile('typo-task'), 'utf-8');
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      // A failed parse changes NOTHING about the row.
      expect(store.getTask(created.id)?.status).toBe(created.status);
      expect(store.countRuns(created.id)).toBe(1);
    });

    it('keeps a task in a slot the scan skips by name', async () => {
      // The watcher accepts a SKILL.md inside the reserved templates container
      // and creates a row; the scan skipping that slot used to look like a deletion.
      await fs.mkdir(path.join(skillsDir, TASK_TEMPLATES_DIRNAME), { recursive: true });
      const filePath = path.join(skillsDir, TASK_TEMPLATES_DIRNAME, 'SKILL.md');
      await fs.writeFile(filePath, skillFile(TASK_TEMPLATES_DIRNAME), 'utf-8');
      const task = rowAt(TASK_TEMPLATES_DIRNAME, filePath);
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTask(task.id)).not.toBeNull();
    });

    it('keeps, and syncs, a task whose directory is a symlink to somewhere else', async () => {
      // `readdir(withFileTypes)` does not follow links; `scanSymlinkedSkills`
      // is the second look that finds it (an installed plugin skill's shape).
      const realDir = path.join(dorkHome, 'shared', 'nightly-sweep');
      await fs.mkdir(realDir, { recursive: true });
      await fs.writeFile(path.join(realDir, 'SKILL.md'), skillFile('nightly-sweep'), 'utf-8');
      const linkPath = path.join(skillsDir, 'nightly-sweep');
      await fs.symlink(realDir, linkPath);
      const task = rowAt('nightly-sweep', path.join(linkPath, 'SKILL.md'));
      store.createRun(task.id, 'scheduled');
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 1, orphaned: 0 });

      expect(store.countRuns(task.id)).toBe(1);
    });

    it('pauses a waiting schedule when its file goes, and resumes it when it returns', async () => {
      const filePath = await writeTask('flaky-file', 'flaky-file');
      await reconciler.reconcile();
      const created = store.getTasks()[0];

      await fs.rm(filePath);
      await reconciler.reconcile();
      // Paused stops the clock; the person's own switch is left as it was (FB-26).
      expect(store.getTask(created.id)?.status).toBe('paused');

      await writeTask('flaky-file', 'flaky-file');
      await reconciler.reconcile();

      // Never approved, so there is no grant to match: back to waiting.
      expect(store.getTask(created.id)).toMatchObject({
        status: 'pending_approval',
        enabled: true,
      });
    });

    // Root ignores file permissions, so this SKIPS in any root container: a
    // green run there is not evidence the unlistable-directory path is covered.
    it.skipIf(process.getuid?.() === 0)(
      'leaves every task alone when its directory cannot be listed',
      async () => {
        await writeTask('alpha', 'alpha');
        await writeTask('beta', 'beta');
        await reconciler.reconcile();
        const before = store.getTasks().map((t) => [t.id, t.status] as const);
        expect(before).toHaveLength(2);

        // EACCES, and equally EMFILE: the scan cannot look, which is not evidence of deletion.
        await fs.chmod(skillsDir, 0o000);
        expireGracePeriod();
        try {
          await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });
        } finally {
          await fs.chmod(skillsDir, 0o755);
        }

        expect(store.getTasks().map((t) => [t.id, t.status] as const)).toEqual(before);
      }
    );

    it('keeps a task that failed to sync out of the orphan set', async () => {
      const filePath = await writeTask('flaky', 'flaky');
      rowAt('flaky', filePath);
      expireGracePeriod();
      vi.spyOn(store.fileSync, 'upsertFromFile').mockImplementation(() => {
        throw new Error('db is busy');
      });

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTasks()).toHaveLength(1);
    });
  });

  describe('a directory nobody listed cannot testify that a file is gone', () => {
    /** A project tasks directory with one real task file, never registered. */
    async function unregisteredProjectTask(): Promise<{ dir: string; filePath: string }> {
      const dir = path.join(dorkHome, 'late-project', '.dork', 'tasks');
      await fs.mkdir(path.join(dir, 'late-task'), { recursive: true });
      const filePath = path.join(dir, 'late-task', 'SKILL.md');
      await fs.writeFile(filePath, skillFile('late-task'), 'utf-8');
      rowAt('late-task', filePath);
      return { dir, filePath };
    }

    it('leaves a task behind after its directory is removed on agent unregister', async () => {
      const { dir } = await unregisteredProjectTask();
      reconciler.addRoot(skillsRoot(dir, 'project', path.join(dorkHome, 'late-project')));
      await reconciler.reconcile();
      const task = store.getTasks()[0];
      store.createRun(task.id, 'scheduled');

      // The agent unregisters: index.ts drops the directory but keeps the rows.
      reconciler.removeDirectory(dir);
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.countRuns(task.id)).toBe(1);
    });

    it('leaves a task in an unregistered directory even when its file is gone too', async () => {
      // The discriminating case for gate 1: with the file still on disk, gate 2
      // (`fs.access`) alone would keep the row. A checkout moved while its agent
      // was not registered looks exactly like this.
      const { filePath } = await unregisteredProjectTask();
      const task = store.getTasks()[0];
      store.createRun(task.id, 'scheduled');
      await fs.rm(path.dirname(filePath), { recursive: true, force: true });
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.getTask(task.id)?.status).toBe('active');
      expect(store.countRuns(task.id)).toBe(1);
    });

    it('leaves every task alone when a registered directory has vanished wholesale', async () => {
      // `scanSkillDirectory` answers ENOENT with `[]`, so without an existence
      // check a deleted checkout reads as "enumerated and empty" and every task
      // in it, run history included, is destroyed 24h later.
      const projectDir = path.join(dorkHome, 'doomed-project', '.dork', 'tasks');
      await fs.mkdir(path.join(projectDir, 'nightly'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'nightly', 'SKILL.md'), skillFile('nightly'));
      reconciler.addRoot(skillsRoot(projectDir, 'project', path.join(dorkHome, 'doomed-project')));
      await reconciler.reconcile();
      const task = store.getTasks()[0];
      store.createRun(task.id, 'scheduled');

      await fs.rm(path.join(dorkHome, 'doomed-project'), { recursive: true, force: true });
      expireGracePeriod();

      await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 0, orphaned: 0 });

      expect(store.countRuns(task.id)).toBe(1);
    });
  });

  describe('a packaged skill whose link is gone (DOR-1934)', () => {
    /** A project install: the package under `.dork/plugins`, linked from `.agents/skills`. */
    async function installProjectPackage(
      repo: string
    ): Promise<{ linkPath: string; filePath: string }> {
      const skillDir = path.join(repo, '.dork', 'plugins', 'acme', 'skills', 'daily');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillFile('daily'), 'utf-8');
      const agentsSkills = path.join(repo, '.agents', 'skills');
      await fs.mkdir(agentsSkills, { recursive: true });
      const linkPath = path.join(agentsSkills, 'acme__daily');
      await fs.symlink(skillDir, linkPath);
      return { linkPath, filePath: path.join(await fs.realpath(skillDir), 'SKILL.md') };
    }

    /** A reconciler over one project's `.agents/skills`, and the repo it watches. */
    async function projectReconciler(): Promise<{ repo: string; recon: TaskReconciler }> {
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'task-reconciler-repo-'));
      const recon = new TaskReconciler(
        store,
        new TaskRegistrar({ store, scheduler }),
        new ScheduleIdentityRegistry()
      );
      recon.addRoot(skillsRoot(path.join(repo, '.agents', 'skills'), 'project', repo, 'agent-1'));
      return { repo, recon };
    }

    it('pauses the row when the link is removed and the package stays', async () => {
      const { repo, recon } = await projectReconciler();
      const { linkPath, filePath } = await installProjectPackage(repo);
      await recon.reconcile();
      expect(store.fileSync.getByFilePath(filePath)?.status).toBe('pending_approval');

      await fs.rm(linkPath, { force: true });
      await recon.reconcile();

      expect(store.fileSync.getByFilePath(filePath)?.status).toBe('paused');
      await fs.access(filePath);
      await fs.rm(repo, { recursive: true, force: true });
    });

    it.skipIf(process.getuid?.() === 0)(
      'keeps a row whose FILE cannot be read while its link is still there',
      async () => {
        // A file no scan could read reaches the retirement loop while still
        // reachable. Seeded defect: drop `!linkedFiles.has(task.filePath)`.
        const { repo, recon } = await projectReconciler();
        const { filePath } = await installProjectPackage(repo);
        await recon.reconcile();

        await fs.chmod(filePath, 0o000);
        try {
          await recon.reconcile();

          expect(store.fileSync.getByFilePath(filePath)?.status).toBe('pending_approval');
        } finally {
          await fs.chmod(filePath, 0o644);
          await fs.rm(repo, { recursive: true, force: true });
        }
      }
    );

    it('never retires a row whose surviving link is in a root this pass did not read', async () => {
      // `sweepUnwatchedRoots` runs single-root passes, so it may not judge
      // reachability. Seeded defect: drop `coversEveryRoot`.
      const { repo, recon } = await projectReconciler();
      const { filePath } = await installProjectPackage(repo);
      const projectSkills = path.join(repo, '.agents', 'skills');
      const second = path.join(skillsDir, 'acme__daily');
      await fs.symlink(path.join(repo, '.dork', 'plugins', 'acme', 'skills', 'daily'), second);
      const unwatched = new TaskReconciler(
        store,
        new TaskRegistrar({ store, scheduler }),
        new ScheduleIdentityRegistry(),
        { rootsWithoutLiveWatch: () => [projectSkills] }
      );
      unwatched.addRoot(skillsRoot(projectSkills, 'project', repo, 'agent-1'));
      unwatched.addRoot(skillsRoot(skillsDir, 'global'));
      await recon.reconcile();

      await fs.rm(path.join(projectSkills, 'acme__daily'), { force: true });
      await unwatched.sweepUnwatchedRoots();

      expect(store.fileSync.getByFilePath(filePath)?.status).toBe('pending_approval');
      await fs.rm(repo, { recursive: true, force: true });
    });

    it('does not mistake a neighbouring folder for the packages folder', async () => {
      // Containment is a path-segment test, not a bare `startsWith`.
      const realHome = await fs.realpath(dorkHome);
      const stranger = rowAt(
        'in-a-neighbour',
        path.join(realHome, 'plugins-backup', 'acme', 'skills', 'x', 'SKILL.md')
      );

      await reconciler.reconcile();

      expect(store.getTask(stranger.id)?.status).toBe('active');
    });
  });

  it('pauses only the task whose own file is gone when two directories share a slug', async () => {
    const projectDir = path.join(dorkHome, 'project', '.agents', 'skills');
    await fs.mkdir(path.join(projectDir, 'flow-drain'), { recursive: true });
    const projectFile = path.join(projectDir, 'flow-drain', 'SKILL.md');
    await fs.writeFile(projectFile, skillFile('flow-drain'), 'utf-8');
    reconciler.addRoot(skillsRoot(projectDir, 'project', path.join(dorkHome, 'project')));
    const globalFile = path.join(skillsDir, 'flow-drain', 'SKILL.md');
    rowAt('flow-drain', globalFile);

    await reconciler.reconcile();

    // Discovered rows are keyed on the REAL path (macOS temp dirs are symlinked).
    const projectReal = await fs.realpath(projectFile);
    const project = store.getTasks().find((t) => t.filePath === projectReal);
    const global = store.getTasks().find((t) => t.filePath === globalFile);
    expect(project?.status).toBe('pending_approval');
    expect(global?.status).toBe('paused');
  });

  it('survives the whole-DB read for retirement throwing', async () => {
    // A throw the pass did not contain would abort every future pass too.
    await writeTask('real-task', 'real-task');
    vi.spyOn(store, 'getTasks').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(reconciler.reconcile()).resolves.toEqual({ upserted: 1, orphaned: 0 });
  });

  it('runs the check after each five-minute pass, even when the pass failed (DOR-2337)', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const recon = new TaskReconciler(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry(),
      undefined,
      async () => {
        order.push('check');
      }
    );
    vi.spyOn(recon, 'reconcile').mockImplementation(async () => {
      order.push('pass');
      throw new Error('disk went away');
    });
    recon.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    recon.stop();

    expect(order).toEqual(['pass', 'check']);
  });

  it('logs a standing fault once an hour, then says how much it held back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T09:00:00Z'));
    const warn = vi.mocked(logger.warn);
    await fs.mkdir(path.join(skillsDir, 'broken'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, 'broken', 'SKILL.md'), unparseableFile('broken'));

    // Twelve passes is one hour at the real 5-minute cadence.
    for (let i = 0; i < 12; i++) {
      await reconciler.reconcile();
      vi.advanceTimersByTime(5 * 60 * 1000);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));

    await reconciler.reconcile();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      expect.stringContaining('11 identical reports suppressed in the last hour')
    );
  });
});
