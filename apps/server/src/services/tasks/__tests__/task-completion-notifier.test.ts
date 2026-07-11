import { describe, it, expect, vi } from 'vitest';
import {
  TaskCompletionNotifier,
  formatCompletionMessage,
  type TaskCompletionNotifierDeps,
} from '../task-completion-notifier.js';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

/** A task linked to an agent by default. */
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'nightly-tests',
    displayName: 'Nightly tests',
    description: null,
    prompt: 'run the tests',
    cron: '* * * * *',
    timezone: 'UTC',
    agentId: 'agent-1',
    enabled: true,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    status: 'active',
    filePath: '/tmp/nightly-tests/SKILL.md',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextRun: null,
    ...overrides,
  };
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    scheduleId: 'task-1',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:04:12.000Z',
    durationMs: 252_000,
    outputSummary: '14 new tests, 2 bugs found. Opened PR #312.',
    error: null,
    sessionId: 'run-1',
    trigger: 'scheduled',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function binding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b-1',
    adapterId: 'tg-main',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    label: '',
    permissionMode: 'acceptEdits',
    enabled: true,
    canInitiate: true,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build notifier deps with a spyable relay publish and one telegram binding. */
function makeDeps(
  overrides: {
    bindings?: AdapterBinding[];
    sessions?: Array<{ chatId: string; sessionId: string }>;
    relayEnabled?: boolean;
    publish?: TaskCompletionNotifierDeps['relayCore'];
  } = {}
): { deps: TaskCompletionNotifierDeps; publish: ReturnType<typeof vi.fn> } {
  const publish = vi.fn().mockResolvedValue({ deliveredTo: 1 });
  const sessions = overrides.sessions ?? [{ chatId: 'chat-42', sessionId: 'sess-1' }];
  const deps: TaskCompletionNotifierDeps = {
    bindingStore: { getAll: () => overrides.bindings ?? [binding()] },
    bindingRouter: { getSessionsByBinding: () => sessions },
    adapterManager: { listAdapters: () => [{ config: { id: 'tg-main', type: 'telegram' } }] },
    relayCore: overrides.publish ?? { publish },
    isRelayEnabled: () => overrides.relayEnabled ?? true,
    logger: { debug: vi.fn() },
  };
  return { deps, publish };
}

describe('TaskCompletionNotifier', () => {
  it('publishes on failure even when the opt-in is off', async () => {
    const { deps, publish } = makeDeps({ bindings: [binding({ notifyOnTaskComplete: false })] });
    await new TaskCompletionNotifier(deps).handle(run({ status: 'failed', error: 'boom' }), task());
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toBe('relay.human.telegram.tg-main.chat-42');
  });

  it('publishes on success when the opt-in is on', async () => {
    const { deps, publish } = makeDeps();
    await new TaskCompletionNotifier(deps).handle(run({ status: 'completed' }), task());
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('does NOT publish on success when the opt-in is off', async () => {
    const { deps, publish } = makeDeps({ bindings: [binding({ notifyOnTaskComplete: false })] });
    await new TaskCompletionNotifier(deps).handle(run({ status: 'completed' }), task());
    expect(publish).not.toHaveBeenCalled();
  });

  it('never publishes on cancellation', async () => {
    const { deps, publish } = makeDeps();
    await new TaskCompletionNotifier(deps).handle(run({ status: 'cancelled' }), task());
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish when canInitiate=false (DOR-239 consent gate)', async () => {
    const { deps, publish } = makeDeps({ bindings: [binding({ canInitiate: false })] });
    await new TaskCompletionNotifier(deps).handle(run({ status: 'failed' }), task());
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish when the binding is paused (enabled=false)', async () => {
    const { deps, publish } = makeDeps({ bindings: [binding({ enabled: false })] });
    await new TaskCompletionNotifier(deps).handle(run({ status: 'failed' }), task());
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish (and does not throw) when there is no active chat session', async () => {
    const { deps, publish } = makeDeps({ sessions: [] });
    await expect(
      new TaskCompletionNotifier(deps).handle(run({ status: 'failed' }), task())
    ).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish for a global (agent-less) task', async () => {
    const { deps, publish } = makeDeps();
    await new TaskCompletionNotifier(deps).handle(run(), task({ agentId: null }));
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish (and does not throw) when relay is disabled', async () => {
    const { deps, publish } = makeDeps({ relayEnabled: false });
    await expect(
      new TaskCompletionNotifier(deps).handle(run({ status: 'failed' }), task())
    ).resolves.toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes with a bounded budget and a system principal', async () => {
    const { deps, publish } = makeDeps();
    await new TaskCompletionNotifier(deps).handle(run(), task());
    const [, , options] = publish.mock.calls[0];
    expect(options.from).toBe('relay.system.tasks.notifier');
    expect(options.budget.maxHops).toBe(2);
    expect(options.budget.callBudgetRemaining).toBe(1);
    expect(typeof options.budget.ttl).toBe('number');
  });

  it('swallows a rejected publish (deliveredTo=0) without throwing', async () => {
    const publish = vi.fn().mockResolvedValue({ deliveredTo: 0 });
    const { deps } = makeDeps({ publish: { publish } });
    await expect(new TaskCompletionNotifier(deps).handle(run(), task())).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('looks the task up via taskStore when the hook passes null', async () => {
    const { deps, publish } = makeDeps();
    const withStore: TaskCompletionNotifierDeps = {
      ...deps,
      taskStore: { getTask: vi.fn().mockReturnValue(task()) },
    };
    await new TaskCompletionNotifier(withStore).handle(run(), null);
    expect(withStore.taskStore!.getTask).toHaveBeenCalledWith('task-1');
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('formatCompletionMessage', () => {
  it('formats a success message: emoji, name, duration, first output line', () => {
    const msg = formatCompletionMessage(task(), run({ status: 'completed' }));
    expect(msg).toBe(
      '✅ Nightly tests — done in 4m 12s. 14 new tests, 2 bugs found. Opened PR #312.'
    );
  });

  it('formats a failure message with the first error line', () => {
    const msg = formatCompletionMessage(
      task(),
      run({ status: 'failed', durationMs: 123_000, error: 'Timeout waiting for server\nstack…' })
    );
    expect(msg).toBe('⚠️ Nightly tests — failed after 2m 3s. Timeout waiting for server');
  });

  it('truncates a long body to about 200 characters', () => {
    const msg = formatCompletionMessage(
      task(),
      run({ status: 'completed', outputSummary: 'x'.repeat(500) })
    );
    expect(msg.length).toBeLessThanOrEqual(200);
    expect(msg.endsWith('…')).toBe(true);
  });

  it('falls back to a generic name when the task is null', () => {
    const msg = formatCompletionMessage(null, run({ status: 'completed', outputSummary: null }));
    expect(msg).toBe('✅ Task — done in 4m 12s.');
  });
});
