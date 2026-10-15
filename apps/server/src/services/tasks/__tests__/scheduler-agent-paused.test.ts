/**
 * A paused agent's schedules start nothing (spec `audit-trail` PR5): a fire is
 * recorded as a skipped run saying why, Run now is skipped the same way, and
 * each held run is handed to the pause service to record once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Task } from '@dorkos/shared/types';
import { initBoundary } from '../../../lib/boundary.js';
import { AGENT_PAUSED_SKIP_REASON } from '../lifecycle/agent-pause-hold.js';
import {
  TaskSchedulerService,
  singleRuntimeSource,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';

vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
}));

/** An on-time fire of an hourly task (an exact hour boundary). */
const ON_TIME_HOURLY = new Date(1_699_999_200_000);

type Fireable = { dispatch(t: Task, when: Date): Promise<void> };

const PAUSED = { id: 'agent-1', name: 'Scout' };

describe('a paused agent’s schedules (spec audit-trail PR5)', () => {
  let store: TaskStore;
  let agentManager: SchedulerAgentManager;
  let paused: boolean;
  let pausedAt: string;
  const recordHeld = vi.fn();
  let service: TaskSchedulerService;

  beforeEach(async () => {
    store = new TaskStore(createTestDb());
    paused = true;
    pausedAt = '2026-10-10T00:00:00.000Z';
    recordHeld.mockReset();
    agentManager = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn(),
      interruptQuery: vi.fn().mockResolvedValue({ status: 'interrupted' }),
      getInternalSessionId: vi.fn(() => undefined),
      acquireLock: vi.fn(() => true),
      releaseLock: vi.fn(),
    } as unknown as SchedulerAgentManager;
    await initBoundary('/');
    service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(agentManager),
      config: { maxConcurrentRuns: 5, retentionCount: 100, mayFire: true, firingReason: 'test' },
      agentPauses: {
        pausedAgent: (agentId: string) =>
          paused && agentId === PAUSED.id ? { ...PAUSED, pausedAt } : undefined,
        recordHeld,
      },
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  function task(): Task {
    return store.createTask({
      name: 'Hourly report',
      description: 'test',
      prompt: 'test',
      cron: '0 * * * *',
      agentId: PAUSED.id,
      filePath: '/tmp/tasks/hourly-report/SKILL.md',
    });
  }

  it('records a fire as skipped, never starts a turn, and records the hold once', async () => {
    const t = task();
    await (service as unknown as Fireable).dispatch(t, ON_TIME_HOURLY);
    const [run] = store.listRuns({ taskId: t.id });
    expect(run).toMatchObject({ status: 'skipped', error: AGENT_PAUSED_SKIP_REASON });
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(recordHeld).toHaveBeenCalledTimes(1);
    expect(recordHeld).toHaveBeenCalledWith(
      { ...PAUSED, pausedAt },
      { via: 'schedule', taskRunId: run!.id }
    );
  });

  it('records one hold per task per pause, however many fires it skips', async () => {
    const t = task();
    const fire = (service as unknown as Fireable).dispatch.bind(service);
    await fire(t, ON_TIME_HOURLY);
    await fire(t, new Date(ON_TIME_HOURLY.getTime() + 3_600_000));
    await fire(t, new Date(ON_TIME_HOURLY.getTime() + 7_200_000));
    expect(store.listRuns({ taskId: t.id })).toHaveLength(3);
    expect(recordHeld).toHaveBeenCalledTimes(1);
    // A new pause is new news.
    pausedAt = '2026-10-11T00:00:00.000Z';
    await fire(t, new Date(ON_TIME_HOURLY.getTime() + 10_800_000));
    expect(recordHeld).toHaveBeenCalledTimes(2);
  });

  it('skips Run now the same way', async () => {
    const t = task();
    const run = await service.triggerManualRun(t.id);
    expect(run).toMatchObject({ status: 'skipped', error: AGENT_PAUSED_SKIP_REASON });
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
    expect(recordHeld).toHaveBeenCalledTimes(1);
  });

  it('records nothing held for an agent that is not paused', async () => {
    paused = false;
    const t = task();
    await (service as unknown as Fireable).dispatch(t, ON_TIME_HOURLY);
    expect(store.listRuns({ taskId: t.id })[0]?.error ?? null).not.toBe(AGENT_PAUSED_SKIP_REASON);
    expect(recordHeld).not.toHaveBeenCalled();
  });
});
