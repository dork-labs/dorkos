import { describe, it, expect, vi } from 'vitest';
import { TaskStore, type CreateTaskStoreInput } from '../task-store.js';
import { TaskCompletionNotifier } from '../task-completion-notifier.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

/**
 * Proves the real in-process seam index.ts wires: a run reaching a terminal
 * status through `TaskStore.updateRun` (the DOR-248 chokepoint the relay
 * task-handler writes through) fires the store hook, which drives a real
 * TaskCompletionNotifier to publish exactly one message — with no
 * relay_notify_user tool call anywhere.
 */
function taskInput(name: string): CreateTaskStoreInput {
  return {
    name,
    displayName: 'Nightly tests',
    description: 'test',
    prompt: 'run the tests',
    agentId: 'agent-1',
    filePath: `/tmp/tasks/${name}/SKILL.md`,
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

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Task completion → notifier → relay publish (integration)', () => {
  it('publishes one formatted completion message when a run terminates in the store', async () => {
    const db = createTestDb();
    const store = new TaskStore(db);
    const publish = vi.fn().mockResolvedValue({ deliveredTo: 1 });

    // Wire exactly as index.ts does.
    const notifier = new TaskCompletionNotifier({
      bindingStore: { getAll: () => [binding()] },
      bindingRouter: {
        getSessionsByBinding: () => [{ chatId: 'chat-42', sessionId: 'sess-1' }],
      },
      adapterManager: { listAdapters: () => [{ config: { id: 'tg-main', type: 'telegram' } }] },
      relayCore: { publish },
      taskStore: { getTask: (id) => store.getTask(id) },
      isRelayEnabled: () => true,
      logger: { debug: vi.fn() },
    });
    store.setOnRunTerminal((run, task) => void notifier.handle(run, task));

    const task = store.createTask(taskInput('nightly'));
    const run = store.createRun(task.id, 'scheduled');

    // Simulate the relay task-handler's terminal write.
    store.updateRun(run.id, {
      status: 'completed',
      durationMs: 252_000,
      outputSummary: '14 new tests, 2 bugs found. Opened PR #312.',
    });
    await flush();

    expect(publish).toHaveBeenCalledTimes(1);
    const [subject, message, options] = publish.mock.calls[0];
    expect(subject).toBe('relay.human.telegram.tg-main.chat-42');
    expect(message).toContain('Nightly');
    expect(message).toContain('4m 12s');
    expect(message).toContain('Opened PR #312');
    expect(options.from).toBe('relay.system.tasks.notifier');
    expect(options.budget).toMatchObject({ maxHops: 2, callBudgetRemaining: 1 });
  });
});
