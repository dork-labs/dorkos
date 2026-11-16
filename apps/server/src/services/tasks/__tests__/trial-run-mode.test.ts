/**
 * A trial a person starts on a pending schedule, tightened by the trigger route
 * (review of #3794): it runs at the mode it was handed, on a fresh chat. A
 * sticky schedule's warm chat keeps the mode it was launched at, so a tightened
 * trial that resumed it would run looser than it says. Driven through the real
 * scheduler, so the session options are the ones production sends.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  TaskSchedulerService,
  singleRuntimeSource,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';

describe('a tightened trial of a sticky schedule', () => {
  let store: TaskStore;
  let manager: SchedulerAgentManager;
  let service: TaskSchedulerService;

  beforeEach(() => {
    const db = createTestDb();
    runtimeRegistry.setDb(db);
    store = new TaskStore(db);
    manager = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(async function* () {}),
      interruptQuery: vi.fn().mockResolvedValue(true),
      getInternalSessionId: vi.fn(() => undefined),
      acquireLock: vi.fn(() => true),
      releaseLock: vi.fn(),
    } as unknown as SchedulerAgentManager;
    service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(manager),
      config: { maxConcurrentRuns: 1, retentionCount: 100, mayFire: true, firingReason: 'test' },
    });
  });

  afterEach(async () => {
    await service.stop();
    store.close();
  });

  /** Start a run and wait until its turn was sent; returns that turn's session options. */
  async function runNow(id: string, mode?: 'dontAsk') {
    const before = vi.mocked(manager.ensureSession).mock.calls.length;
    const run = mode
      ? await service.triggerManualRun(id, mode)
      : await service.triggerManualRun(id);
    expect(run).not.toBeNull();
    await vi.waitFor(() =>
      expect(vi.mocked(manager.ensureSession).mock.calls.length).toBeGreaterThan(before)
    );
    await vi.waitFor(() => expect(store.getRun(run!.id)?.status).not.toBe('running'));
    const [sessionId, opts] = vi.mocked(manager.ensureSession).mock.calls.at(-1)!;
    return { sessionId, opts: opts as Record<string, unknown> };
  }

  it('runs at the mode it was handed, on a fresh chat rather than the warm one', async () => {
    const task = store.createTask({
      name: 'sticky-sweep',
      description: 'sticky',
      prompt: 'Sweep.',
      cron: '0 3 * * *',
      sticky: true,
      permissionMode: 'acceptEdits',
      filePath: '/tmp/tasks/sticky-sweep/SKILL.md',
    });

    const warm = await runNow(task.id);
    const again = await runNow(task.id);
    // The control: a sticky schedule's own runs share one chat.
    expect(again.sessionId).toBe(warm.sessionId);
    expect(again.opts).toMatchObject({ permissionMode: 'acceptEdits', hasStarted: true });

    const trial = await runNow(task.id, 'dontAsk');
    expect(trial.sessionId).not.toBe(warm.sessionId);
    expect(trial.opts).toMatchObject({ permissionMode: 'dontAsk', hasStarted: false });
  });
});
