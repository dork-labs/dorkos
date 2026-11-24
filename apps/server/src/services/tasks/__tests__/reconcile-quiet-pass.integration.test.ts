/**
 * A reconcile pass over files nobody changed writes nothing (DOR-2899).
 *
 * The five-minute pass re-read about 180 SKILL.md files and rewrote every row,
 * timestamp and all, and re-registered every cron job, every time ("28
 * upserted" about 780 times in 65 hours on one machine). It still has to put
 * back a job the clock lost.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../task-store.js';
import { TaskRegistrar } from '../task-registrar.js';
import { TaskReconciler } from '../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { globalSkillsRoot, globalTaskRoots } from '../skills-roots.js';
import { FakeScheduler } from './fake-scheduler.js';

const schedule = (name: string, cron: string) =>
  `---\nname: ${name}\ndescription: A task named ${name}\nschedule:\n  cron: '${cron}'\n---\nDo the thing.`;

describe('a reconcile pass over unchanged files', () => {
  let dorkHome: string;
  let db: Db;
  let store: TaskStore;
  let scheduler: FakeScheduler;
  let reconciler: TaskReconciler;

  async function writeTask(name: string, cron: string): Promise<string> {
    const dir = path.join(globalSkillsRoot(dorkHome), name);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    await fs.writeFile(file, schedule(name, cron));
    return file;
  }

  beforeEach(async () => {
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'quiet-pass-')));
    db = createTestDb();
    store = new TaskStore(db);
    scheduler = new FakeScheduler();
    reconciler = new TaskReconciler(
      store,
      new TaskRegistrar({ store, scheduler }),
      new ScheduleIdentityRegistry()
    );
    for (const root of globalTaskRoots(dorkHome)) reconciler.addRoot(root);
    await writeTask('alpha', '0 3 * * *');
    await writeTask('beta', '0 4 * * *');
    const first = await reconciler.reconcile();
    expect(first.upserted).toBe(2);
    // Approve them, as a person would; the next pass arms them. Everything
    // after that is the steady state these tests are about.
    for (const task of store.getTasks()) store.approvals.recordApproval(task.id);
    await reconciler.reconcile();
    expect(store.getTasks().every((task) => task.status === 'active')).toBe(true);
    expect(scheduler.jobs.size).toBe(2);
  });

  it('writes no row and re-registers no job', async () => {
    const before = store.getTasks().map((task) => [task.id, task.updatedAt]);
    const registrations = scheduler.registered.length;

    const second = await reconciler.reconcile();

    expect(second.upserted).toBe(0);
    expect(store.getTasks().map((task) => [task.id, task.updatedAt])).toEqual(before);
    expect(scheduler.registered).toHaveLength(registrations);
  });

  it('puts back a job the clock lost, without rewriting its row', async () => {
    const beta = store.getTasks().find((task) => task.name === 'beta')!;
    scheduler.jobs.delete(beta.id);

    await reconciler.reconcile();

    expect(scheduler.jobs.has(beta.id)).toBe(true);
    expect(store.getTask(beta.id)!.updatedAt).toBe(beta.updatedAt);
  });

  it('repairTask takes a job off the clock when the row says it should not run', () => {
    // A writer that parked a row without syncing the clock left a live job.
    const beta = store.getTasks().find((task) => task.name === 'beta')!;
    db.update(pulseSchedules)
      .set({ status: 'pending_approval' })
      .where(eq(pulseSchedules.id, beta.id))
      .run();
    expect(scheduler.jobs.has(beta.id)).toBe(true);

    new TaskRegistrar({ store, scheduler }).repairTask(beta.id);

    expect(scheduler.jobs.has(beta.id)).toBe(false);
  });
});
