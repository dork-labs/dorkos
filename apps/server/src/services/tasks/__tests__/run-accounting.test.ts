import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RunAccounting } from '../run-accounting.js';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

describe('RunAccounting (DOR-1482)', () => {
  let db: Db;
  let store: TaskStore;
  let taskId: string;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    taskId = store.createTask(taskInput({ name: 'Counted', cron: '0 * * * *' })).id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts both dispatch paths under one number', () => {
    const runs = new RunAccounting(store);
    const direct = store.createRun(taskId, 'manual');
    const viaRelay = store.createRun(taskId, 'scheduled');

    runs.addDirect(direct.id, new AbortController());
    runs.addRelay(viaRelay.id, null);

    expect(runs.count()).toBe(2);
    expect(runs.directCount()).toBe(1);
    expect(runs.relayRunIds()).toEqual([viaRelay.id]);
  });

  it('gives back a relay slot as soon as the run row goes terminal', () => {
    const runs = new RunAccounting(store);
    const run = store.createRun(taskId, 'scheduled');
    runs.addRelay(run.id, null);
    expect(runs.count()).toBe(1);

    // The receiver finished it — the row is the only thing that says so.
    store.updateRun(run.id, { status: 'completed', finishedAt: new Date().toISOString() });

    expect(runs.count()).toBe(0);
  });

  it('forgets preparation ownership when preparation rejects', async () => {
    const runs = new RunAccounting(store);
    const run = store.createRun(taskId, 'manual');
    await expect(
      runs.prepare(run.id, async () => {
        throw new Error('Cannot read the schedule');
      })
    ).rejects.toThrow('Cannot read the schedule');

    expect(runs.stopHere(run.id, store, 'stop')).toBeUndefined();
    expect(store.getRun(run.id)!.status).toBe('running');
  });

  it.each(['direct', 'relay'] as const)(
    'hands preparation ownership to the %s dispatch path',
    async (path) => {
      const runs = new RunAccounting(store);
      const run = store.createRun(taskId, 'manual');
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const controller = new AbortController();
      const work = runs.prepare(run.id, async () => {
        if (path === 'direct') runs.addDirect(run.id, controller);
        else runs.addRelay(run.id);
        await done;
      });
      try {
        expect(runs.stopHere(run.id, store, 'stop')).toEqual(
          path === 'direct' ? { state: 'stopping' } : undefined
        );
        expect(controller.signal.aborted).toBe(path === 'direct');
        // Only a runner can finalize an already-dispatched run. In particular,
        // a relay run must not be filed as stopped by the preparation path.
        expect(store.getRun(run.id)!.status).toBe('running');
      } finally {
        finish();
        await work;
      }
    }
  );

  it('gives back a relay slot whose run vanished with its task', () => {
    const runs = new RunAccounting(store);
    const run = store.createRun(taskId, 'scheduled');
    runs.addRelay(run.id, null);

    store.deleteTask(taskId);

    expect(runs.count()).toBe(0);
  });

  it('stops holding a slot for a relay run that never reports an ending', () => {
    // A runner that dies mid-run writes nothing, so without a deadline its slot
    // would be held for the life of the process — silently shrinking the cap.
    vi.useFakeTimers();
    const runs = new RunAccounting(store);
    const run = store.createRun(taskId, 'scheduled');
    runs.addRelay(run.id, 60_000);

    vi.advanceTimersByTime(60_000 + 30_000);
    expect(runs.count()).toBe(1); // deadline plus grace has not fully elapsed

    vi.advanceTimersByTime(60_000);
    expect(runs.count()).toBe(0);
    // The row is left exactly as it was: this process does not know it failed.
    expect(store.getRun(run.id)!.status).toBe('running');
  });

  it('only hands back an abort handle for a run this process is executing', () => {
    const runs = new RunAccounting(store);
    const direct = store.createRun(taskId, 'manual');
    const viaRelay = store.createRun(taskId, 'scheduled');
    const controller = new AbortController();
    runs.addDirect(direct.id, controller);
    runs.addRelay(viaRelay.id, null);

    expect(runs.directController(direct.id)).toBe(controller);
    expect(runs.directController(viaRelay.id)).toBeUndefined();
  });

  it('aborts every direct run and leaves relay runs to their runner', () => {
    const runs = new RunAccounting(store);
    const a = new AbortController();
    const b = new AbortController();
    runs.addDirect('run-a', a);
    runs.addDirect('run-b', b);
    const viaRelay = store.createRun(taskId, 'scheduled');
    runs.addRelay(viaRelay.id, null);

    runs.abortDirect('shutting down');

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(runs.relayRunIds()).toEqual([viaRelay.id]);

    runs.forgetRelayRuns();
    expect(runs.relayRunIds()).toEqual([]);
  });
});
