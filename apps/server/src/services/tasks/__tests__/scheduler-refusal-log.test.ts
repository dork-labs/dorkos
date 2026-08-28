/**
 * A task nobody can schedule is reported once an hour, not 288 times a day.
 *
 * The reconciler re-syncs every task file every five minutes and pushes each one
 * through the registrar, so the refusal log is on a forever-timer. Undamped, one
 * typo in one SKILL.md buries every other failure an operator needs to see —
 * the same hazard `TaskReconciler.report` and `TaskStore.upsertFromFile` already
 * damp.
 *
 * A dedicated file because it needs the logger mocked at module scope, which the
 * main scheduler suite deliberately does not do.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { taggedLogger } = vi.hoisted(() => ({
  taggedLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: taggedLogger,
  createTaggedLogger: () => taggedLogger,
  logError: (err: unknown) =>
    err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) },
}));

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => false) }));

import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
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
    filePath: `/tmp/tasks/${overrides.name}/SKILL.md`,
    ...overrides,
  };
}

const CONFIG = {
  maxConcurrentRuns: 1,
  retentionCount: 100,
  timezone: null,
  mayFire: true,
  firingReason: 'test',
};

/** Every refusal line written so far. */
function refusals(): string[] {
  return taggedLogger.error.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes('DorkOS cannot run'));
}

describe('reporting a schedule croner refuses', () => {
  let db: Db;
  let store: TaskStore;
  let service: TaskSchedulerService;
  const agent = {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    interruptQuery: vi.fn(),
  } as unknown as SchedulerAgentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    db = createTestDb();
    store = new TaskStore(db);
    service = new TaskSchedulerService(store, agent, CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the first refusal in full, naming the task and its cron', () => {
    const task = store.createTask(taskInput({ name: 'broken', cron: 'banana' }));

    service.registerTask(task);

    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('broken');
    expect(refusals()[0]).toContain('banana');
  });

  it('says nothing more for the same bad schedule inside the hour', () => {
    const task = store.createTask(taskInput({ name: 'broken', cron: 'banana' }));

    // Twelve passes: what the reconciler does in one hour.
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
      service.registerTask(task);
    }

    expect(refusals()).toHaveLength(1);
  });

  it('speaks again when the hour is up, and says what it swallowed', () => {
    const task = store.createTask(taskInput({ name: 'broken', cron: 'banana' }));
    service.registerTask(task);
    for (let i = 0; i < 3; i++) service.registerTask(task);

    vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
    service.registerTask(task);

    expect(refusals()).toHaveLength(2);
    expect(refusals()[1]).toContain('still failing');
    expect(refusals()[1]).toContain('3 identical reports suppressed');
  });

  // The masking bug the key exists to prevent: a task edited from one bad cron
  // into a different bad cron is a NEW fault, and hiding it behind the first
  // would swallow exactly the line that says the fix did not work.
  it('reports immediately when the same task is edited into a different bad schedule', () => {
    const task = store.createTask(taskInput({ name: 'broken', cron: 'banana' }));
    service.registerTask(task);

    service.registerTask({ ...task, cron: '99 * * * *' });

    expect(refusals()).toHaveLength(2);
    expect(refusals()[1]).toContain('99 * * * *');
  });

  it('counts a bad timezone on an otherwise fine cron as its own fault', () => {
    const task = store.createTask(taskInput({ name: 'broken', cron: '0 9 * * *' }));
    service.registerTask({ ...task, timezone: 'Mars/Phobos' });

    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toContain('Mars/Phobos');
  });

  it('gives each unschedulable task its own line', () => {
    const one = store.createTask(taskInput({ name: 'broken-one', cron: 'banana' }));
    const two = store.createTask(taskInput({ name: 'broken-two', cron: 'banana' }));

    service.registerTask(one);
    service.registerTask(two);

    expect(refusals()).toHaveLength(2);
  });

  // A fixed task that breaks again later deserves a full report, not a line
  // damped against the fault it had an hour ago.
  it('forgets a task once its schedule reads again', () => {
    const task = store.createTask(taskInput({ name: 'fixed-then-broken', cron: 'banana' }));
    service.registerTask(task);

    expect(service.registerTask({ ...task, cron: '0 9 * * *' })).toBe(true);
    service.registerTask(task);

    expect(refusals()).toHaveLength(2);
    expect(refusals()[1]).not.toContain('still failing');
  });
});
