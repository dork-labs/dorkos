/**
 * "Run now" raises an approval a person can actually answer.
 *
 * The bug this pins, found by browser verification: clicking **Run now** on a
 * schedule whose prompt needed a tool the agent had to ask about produced an
 * approval card that appeared nowhere, and then the run died two minutes later
 * saying "No receiver for the scheduled run", for a run somebody had clicked
 * with their own hand.
 *
 * Two faults produced that. The first, a turn projected nowhere, is gone with
 * the path that had it: a task's turn now starts through the turn port, so the
 * dispatcher projects it as it projects every chat's turn
 * (`tasks-through-turn-port.test.ts` proves the card reaches the person). The
 * second is pinned here: **the run rode the message bus.** A relay dispatch
 * awaits the whole turn inside a 120-second delivery deadline, so a card left
 * standing while a person read it timed the delivery out and failed the run as
 * though nothing had received it.
 *
 * @module services/tasks/__tests__/run-now-ask
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RelayCore } from '@dorkos/relay';
import { TaskSchedulerService } from '../task-scheduler-service.js';
import { RELAY_DISPATCH_OK } from '../../relay/task-dispatch/readiness.js';
import { TaskStore } from '../task-store.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';
import { onRuntime, type RuntimeDouble } from './support/runtime-task-turns.js';

// What the server's startup registers (DOR-4928): unregistered, the protected-path policy
// refuses every path and turn code knows no Claude transcript.
registerClaudeCodeFacts();

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => true) }));

const CONFIG = {
  maxConcurrentRuns: 2,
  retentionCount: 100,
  timezone: null,
  mayFire: true,
  firingReason: 'test',
};

describe('a "Run now" ask reaches the person waiting for it', () => {
  let store: TaskStore;
  let agent: RuntimeDouble;

  beforeEach(() => {
    const db = createTestDb();
    runtimeRegistry.setDb(db);
    store = new TaskStore(db);
    agent = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'done' } } as unknown as StreamEvent;
      }),
      interruptQuery: vi.fn().mockResolvedValue({ outcome: 'not-running' }),
      getInternalSessionId: vi.fn(() => undefined),
    };
  });

  it('keeps a run somebody clicked off the bus, and still puts a scheduled one on it', async () => {
    // The discriminating pair: the bus below says yes to everything, so a rule
    // that stopped reading the trigger would send both.
    const publish = vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 });
    const task = store.createTask({
      name: 'Tighten a file',
      description: 'Tighten a file',
      prompt: 'Run `chmod 640 /tmp/x`',
      filePath: '/tmp/tasks/tighten-a-file/SKILL.md',
      cron: '0 3 * * *',
      permissionMode: 'default',
    });
    const service = new TaskSchedulerService({
      store,
      ...onRuntime(agent),
      config: CONFIG,
      relay: { publish } as unknown as RelayCore,
      relayHoldsRuntime: () => RELAY_DISPATCH_OK,
    });

    await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled();

    await (service as unknown as { dispatch(t: typeof task, when: Date): Promise<void> }).dispatch(
      task,
      // An on-time fire of the task's 03:00 occurrence: a fire far from any
      // occurrence would be skipped as stale and never reach the bus (DOR-2718).
      new Date('2023-11-14T03:00:00.000Z')
    );
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

    await service.stop();
  });
});
