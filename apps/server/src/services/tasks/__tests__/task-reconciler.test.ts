import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, pulseRuns, pulseDispatchLog, type Db } from '@dorkos/db';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../lib/logger.js';
import { TaskReconciler } from '../task-reconciler.js';
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

  beforeEach(async () => {
    vi.clearAllMocks();
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'task-reconciler-'));
    tasksDir = path.join(dorkHome, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    db = createTestDb();
    store = new TaskStore(db);
    reconciler = new TaskReconciler(store);
    reconciler.addDirectory(tasksDir, 'global');
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
      store.tryClaimDispatch(taskId, 1_700_000_000_000);

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
        expect.any(Error)
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
        expect.any(Error)
      );
    });
  });
});
