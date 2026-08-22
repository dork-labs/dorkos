/**
 * Running a proposed schedule once, before deciding about it (DOR-1394).
 *
 * "Try it once and see" is the missing move in the approval experience: an
 * operator handed a cron line and a prompt has no way to find out what the thing
 * actually does short of approving it. A test run has to be exactly that — a
 * run, and nothing else. It must not arm the cron, must not approve the
 * schedule, and must not end the condition that is waiting on the person.
 *
 * ## What the notification mocks do and do not prove
 *
 * They are mocked wholesale rather than spied on so that a call reaching them by
 * ANY import route is caught. But the claim they support is narrow, and it is
 * worth stating exactly, because the obvious reading is wrong: a run does not
 * leave the notification pipeline alone in general. In production
 * `TaskStore.setOnRunTerminal` is wired to `notifyRunCompleted`, so a finished
 * run raises `run.completed` — quiet on success, notable and relayable on
 * failure. This test does not install that listener, so it says nothing about
 * that path.
 *
 * What it does pin is the APPROVAL: `resolveStanding` and
 * `cancelEscalationByKey` are how a parked schedule's standing condition is
 * ended and its escalation timer disarmed, and a trial run must touch neither.
 *
 * `notify` and `armEscalation` are stubbed only so the mocked modules stay
 * complete; nothing here asserts on them.
 *
 * @module services/tasks/__tests__/trigger-pending-schedule
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => false) }));

const resolveStanding = vi.fn().mockResolvedValue({ notification: null, deduped: false });
const notify = vi.fn().mockResolvedValue({ notification: null, deduped: false });
vi.mock('../../notifications/notification-service.js', () => ({
  resolveStanding: (...args: unknown[]) => resolveStanding(...args),
  notify: (...args: unknown[]) => notify(...args),
}));

const cancelEscalationByKey = vi.fn();
const armEscalation = vi.fn();
vi.mock('../../notifications/escalation-service.js', () => ({
  cancelEscalationByKey: (...args: unknown[]) => cancelEscalationByKey(...args),
  armEscalation: (...args: unknown[]) => armEscalation(...args),
}));

const CONFIG = {
  maxConcurrentRuns: 1,
  retentionCount: 100,
  timezone: null,
  mayFire: true,
  firingReason: 'test',
};

describe('a schedule waiting for approval can still be run once', () => {
  let db: Db;
  let store: TaskStore;
  let agent: SchedulerAgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    store = new TaskStore(db);
    agent = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(async function* () {
        yield { type: 'text_delta', data: { text: 'swept' } };
      }),
      interruptQuery: vi.fn().mockResolvedValue(true),
    } as unknown as SchedulerAgentManager;
  });

  /** A proposal parked exactly as `tasks_create` parks one. */
  function parkedTask() {
    const task = store.createTask({
      name: 'nightly-sweep',
      description: 'nightly',
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      filePath: '',
      reason: 'The overnight backlog needs sweeping before you start.',
      proposedBySessionId: 'ses-42',
      proposedByAgentPath: '/tmp/agents/nightly-bot',
    });
    return store.updateTask(task.id, { status: 'pending_approval' })!;
  }

  it('runs it, and records the run as a manual one', async () => {
    const task = parkedTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);
    await service.start();

    const run = await service.triggerManualRun(task.id);

    expect(run).not.toBeNull();
    expect(run!.trigger).toBe('manual');
    expect(store.listRuns({ taskId: task.id })).toHaveLength(1);
    // The run is a real turn in its own session, not a simulation.
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());
    const [sessionId, prompt] = vi.mocked(agent.sendMessage).mock.calls[0]!;
    expect(sessionId).toBe(run!.id);
    expect(prompt).toContain('sweep the backlog');

    await service.stop();
  });

  it('does not arm the cron', async () => {
    const task = parkedTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);
    await service.start();

    await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());

    expect(service.isRegistered(task.id)).toBe(false);
    expect(service.getNextRun(task.id)).toBeNull();

    await service.stop();
  });

  it('does not approve the schedule', async () => {
    const task = parkedTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);
    await service.start();

    await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());

    const after = store.getTask(task.id)!;
    expect(after.status).toBe('pending_approval');
    expect(after.enabled).toBe(task.enabled);
    // The case the agent made for it survives the trial run untouched.
    expect(after.reason).toBe(task.reason);

    await service.stop();
  });

  it('leaves the standing approval condition standing (nothing decides the approval)', async () => {
    const task = parkedTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);
    await service.start();

    await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());
    // Let the run reach its terminal write, where the notification hooks live.
    await vi.waitFor(() =>
      expect(store.listRuns({ taskId: task.id })[0]!.status).not.toBe('running')
    );

    // Trying a proposal is not deciding it: the operator still owes an answer,
    // so nothing may record one and nothing may stop the escalation clock.
    expect(resolveStanding).not.toHaveBeenCalled();
    expect(cancelEscalationByKey).not.toHaveBeenCalled();

    await service.stop();
  });
});
