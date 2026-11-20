/**
 * DOR-4315: a task's agent-set list, its pins and the one-shot state live in
 * DorkOS's own row, never in the SKILL.md. Real store, in-memory database,
 * made-up names.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../../task-store.js';
import type { TaskFileSync } from '../../sync/task-file-sync.js';
import { fireOneShot, oneShotDue } from '../../store/task-run-controls.js';

const FILE_PATH = `/home/sample/.dork/agents/media/.dork/tasks/sample-backfill/${SKILL_FILENAME}`;
const RUN = 'Bash(/home/sample/agents/media/bin/derive-sample --backfill)';
const VERIFY = 'Bash(/home/sample/agents/media/bin/derive-sample --check)';
const PINS = {
  firstSetAt: '2026-11-15T09:00:00.000Z',
  programs: {
    [RUN]: { path: '/home/sample/agents/media/bin/derive-sample', sha256: 'ab'.repeat(32) },
  },
};

/** A parsed SKILL.md for the task. */
function definition(body = 'Run the sample backfill once.') {
  return {
    name: 'sample-backfill',
    meta: {
      name: 'sample-backfill',
      description: 'A one-off sample backfill',
      schedule: { cron: '', timezone: 'UTC', enabled: true, permissions: 'dontAsk' },
    },
    body,
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

describe('a task’s run controls', () => {
  let db: Db;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  function created() {
    return store.fileSync.upsertFromFile(definition());
  }

  it('starts with no list and as an ordinary task', () => {
    expect(created()).toMatchObject({ approvedAllow: null, runOnce: false, ranOnceAt: null });
  });

  it('stores a list, its pins and the one-shot flag, and reads them back', () => {
    const task = created();
    expect(
      store.runControls.set(task.id, {
        approvedAllow: [RUN, VERIFY],
        allowListPins: PINS,
        runOnce: true,
      })
    ).toBe(true);
    expect(store.getTask(task.id)).toMatchObject({ approvedAllow: [RUN, VERIFY], runOnce: true });
    expect(store.runControls.pinsOf(task.id)).toEqual(PINS);
  });

  it('keeps pins off the task every reader carries', () => {
    const task = created();
    store.runControls.set(task.id, { allowListPins: PINS });
    expect(JSON.stringify(store.getTask(task.id))).not.toContain('sha256');
  });

  it('clears a list with an empty one', () => {
    const task = created();
    store.runControls.set(task.id, { approvedAllow: [RUN] });
    store.runControls.set(task.id, { approvedAllow: [] });
    const row = db.select().from(pulseSchedules).where(eq(pulseSchedules.id, task.id)).get()!;
    expect(row.approvedAllow).toBeNull();
  });

  it('keeps the one-shot flag through a sync of a changed file', () => {
    const task = created();
    store.runControls.set(task.id, { runOnce: true });
    store.fileSync.upsertFromFile(definition('A changed body.'));
    expect(store.getTask(task.id)).toMatchObject({ runOnce: true });
  });

  it('claims a one-shot run once, and never again', () => {
    const task = created();
    store.runControls.set(task.id, { runOnce: true });
    expect(store.runControls.claimOneShot(task.id)).toBe(true);
    expect(store.runControls.claimOneShot(task.id)).toBe(false);
    expect(store.getTask(task.id)?.ranOnceAt).toEqual(expect.any(String));
  });

  it('never claims a task that is not a one-shot', () => {
    const task = created();
    expect(store.runControls.claimOneShot(task.id)).toBe(false);
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(false);
  });

  it('is due once: the claim is what makes it due', () => {
    const task = created();
    store.runControls.set(task.id, { runOnce: true });
    const fresh = store.getTask(task.id)!;
    expect(oneShotDue(fresh, store.runControls)).toBe(true);
    expect(oneShotDue(fresh, store.runControls)).toBe(false);
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(false);
  });

  /** A one-shot task with its claim taken, as `armOneShot` takes it. */
  function claimed() {
    const task = created();
    store.runControls.set(task.id, { runOnce: true });
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(true);
    return task;
  }

  it('gives the claim back when the dispatch opened no run, so it runs when armed again', async () => {
    const task = claimed();
    // Parked or switched off between arming and firing: the dispatch opens no row.
    await fireOneShot(store, task.id, async () => null);
    expect(store.getTask(task.id)?.ranOnceAt ?? null).toBeNull();
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(true);
  });

  it('keeps the claim when the dispatch opened its run, skipped or not', async () => {
    const task = claimed();
    await fireOneShot(store, task.id, async () => store.createRun(task.id, 'scheduled'));
    expect(store.getTask(task.id)?.ranOnceAt).toEqual(expect.any(String));
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(false);
  });

  it('keeps the claim when the run it opened is pruned away before the fire ends', async () => {
    const task = claimed();
    await fireOneShot(store, task.id, async () => {
      const run = store.createRun(task.id, 'scheduled');
      store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });
      store.pruneRuns(task.id, 0); // no row left for any count or look-back to find
      return run;
    });
    expect(store.countRuns(task.id)).toBe(0);
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(false);
  });

  it('gives the claim back on the dispatch’s word, whatever other rows appear meanwhile', async () => {
    const task = claimed();
    await fireOneShot(store, task.id, async () => {
      store.createRun(task.id, 'scheduled'); // another writer's row, not this fire's
      return null;
    });
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(true);
  });

  it('keeps the claim when the dispatch throws, since it may have opened a row', async () => {
    const task = claimed();
    await expect(
      fireOneShot(store, task.id, async () => {
        throw new Error('the run could not start');
      })
    ).rejects.toThrow('the run could not start');
    expect(oneShotDue(store.getTask(task.id)!, store.runControls)).toBe(false);
  });

  it('reads no pins for a task that does not exist', () => {
    expect(store.runControls.set('missing', { approvedAllow: [RUN] })).toBe(false);
    expect(store.runControls.pinsOf('missing')).toEqual({ firstSetAt: null, programs: {} });
  });
});
