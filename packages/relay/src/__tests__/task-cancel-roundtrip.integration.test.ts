/**
 * Integration: stopping a relay-dispatched task run, over a real bus.
 *
 * Every other test of this path holds one side of the wire and mocks the
 * other — the scheduler against a fake publisher, the adapter against a fake
 * relay. That is exactly how the original bug survived: each half was fine and
 * nothing joined them. This drives a REAL {@link RelayCore} from the publish
 * the server makes to the subscription the adapter registers, so the subject,
 * the budget, the access rules and the subscriber fan-out all have to agree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code/index.js';
import type {
  AgentRuntimeLike,
  TasksStoreLike,
  TraceStoreLike,
} from '../adapters/claude-code/index.js';
import type {
  RelayPublisher,
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
} from '../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { TASK_CANCEL_SUBJECT_PREFIX, TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

/** The one thing `RelayCore` needs to reach the adapter under test. */
class SingleAdapterRegistry implements AdapterRegistryLike {
  constructor(private readonly adapter: ClaudeCodeAdapter) {}

  setRelay(_r: RelayPublisher) {}

  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult | null> {
    return this.adapter.deliver(subject, envelope, context);
  }

  async shutdown() {
    await this.adapter.stop();
  }
}

/** A turn that parks forever — a run waiting on a person who never arrives. */
function parkedTurn(): { stream: AsyncGenerator<StreamEvent>; parked: Promise<void> } {
  let signalParked!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const stream = (async function* () {
    yield { type: 'text_delta', data: { text: 'starting' } } as StreamEvent;
    signalParked();
    await new Promise(() => {});
  })();
  return { stream, parked };
}

/** The dispatch the scheduler publishes for one run. */
function dispatchPayload(runId: string) {
  return {
    type: 'task_dispatch',
    taskId: 'sched-1',
    runId,
    prompt: 'Check the budget',
    cwd: '/tmp',
    permissionMode: 'default',
    taskName: 'Budget Monitor',
    cron: '0 * * * *',
    trigger: 'scheduled',
  };
}

describe('stopping a relay-dispatched run, end to end', () => {
  let tmpDir: string;
  let relay: RelayCore;
  let cca: ClaudeCodeAdapter;
  let agentManager: AgentRuntimeLike;
  let taskStore: TasksStoreLike;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-task-cancel-'));
    agentManager = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn(),
      getSdkSessionId: vi.fn().mockReturnValue(undefined),
      approveTool: vi.fn(),
      interruptQuery: vi.fn().mockResolvedValue(true),
    };
    taskStore = { updateRun: vi.fn() };
    const traceStore: TraceStoreLike = { insertSpan: vi.fn(), updateSpan: vi.fn() };

    cca = new ClaudeCodeAdapter(
      'claude-code',
      // One slot, so the stop has to arrive by a route that does not need one.
      { defaultCwd: '/tmp', maxConcurrent: 1 },
      { agentManager, traceStore, taskStore, approvalAuthorizer: () => true }
    );
    relay = new RelayCore({
      dataDir: tmpDir,
      defaultTtlMs: 3_600_000,
      adapterRegistry: new SingleAdapterRegistry(cca),
    });
    await cca.start(relay);
  });

  afterEach(async () => {
    await cca.stop();
    await relay.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reaches the run and finalizes it as cancelled', async () => {
    const turn = parkedTurn();
    vi.mocked(agentManager.sendMessage).mockReturnValue(turn.stream);

    // NOT awaited: a tasks dispatch is delivered inline, so this publish does
    // not resolve until the run ends — which is the whole problem.
    const dispatch = relay.publish('relay.system.tasks.sched-1', dispatchPayload('run-1'), {
      from: TASK_SCHEDULER_PRINCIPAL,
      budget: { maxHops: 3, ttl: Date.now() + 3_600_000, callBudgetRemaining: 5 },
    });
    await turn.parked;

    const stop = await relay.publish(
      `${TASK_CANCEL_SUBJECT_PREFIX}run-1`,
      { type: 'task_cancel', runId: 'run-1' },
      {
        from: TASK_SCHEDULER_PRINCIPAL,
        budget: { maxHops: 1, ttl: Date.now() + 30_000, callBudgetRemaining: 1 },
      }
    );

    // One runner took it — this number is what the cockpit's answer rests on.
    expect(stop.deliveredTo).toBe(1);

    await dispatch;
    expect(agentManager.interruptQuery).toHaveBeenCalledWith('run-1');
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'cancelled', error: 'Run cancelled' })
    );
  });

  it('is not made to look delivered by somebody merely WATCHING the bus', async () => {
    // `GET /api/relay/stream?subject=relay.system.>` registers a passive
    // handler exactly like this one, and the publish pipeline counts any
    // handler that does not refuse as a delivery. If a stop can match a
    // watcher's pattern, every Stop answers 200 while nothing was stopped and
    // the honest `unconfirmed` answer becomes unreachable. The stop subject
    // lives outside every pattern that route will accept, which is what this
    // pins — the widest one it allows is `relay.system.>`.
    const observed: RelayEnvelope[] = [];
    relay.subscribe('relay.system.>', (envelope) => {
      observed.push(envelope);
    });

    const stop = await relay.publish(
      `${TASK_CANCEL_SUBJECT_PREFIX}run-nobody-is-running`,
      { type: 'task_cancel', runId: 'run-nobody-is-running' },
      {
        from: TASK_SCHEDULER_PRINCIPAL,
        budget: { maxHops: 1, ttl: Date.now() + 30_000, callBudgetRemaining: 1 },
      }
    );

    expect(stop.deliveredTo).toBe(0);
    expect(observed).toHaveLength(0);
  });

  it('refuses a stop that did not come from the scheduler', async () => {
    const turn = parkedTurn();
    vi.mocked(agentManager.sendMessage).mockReturnValue(turn.stream);
    const dispatch = relay.publish('relay.system.tasks.sched-1', dispatchPayload('run-1'), {
      from: TASK_SCHEDULER_PRINCIPAL,
      budget: { maxHops: 3, ttl: Date.now() + 3_600_000, callBudgetRemaining: 5 },
    });
    await turn.parked;

    // Any agent can publish, and a run id is guessable. Stopping other
    // people's work is the server's business, not an agent's.
    const stop = await relay.publish(
      `${TASK_CANCEL_SUBJECT_PREFIX}run-1`,
      { type: 'task_cancel', runId: 'run-1' },
      {
        from: 'relay.agent.some-other-agent',
        budget: { maxHops: 1, ttl: Date.now() + 30_000, callBudgetRemaining: 1 },
      }
    );

    expect(stop.deliveredTo).toBe(0);
    expect(agentManager.interruptQuery).not.toHaveBeenCalled();
    expect(taskStore.updateRun).not.toHaveBeenCalled();

    // The run is still going, and a real stop still reaches it.
    await relay.publish(
      `${TASK_CANCEL_SUBJECT_PREFIX}run-1`,
      { type: 'task_cancel', runId: 'run-1' },
      {
        from: TASK_SCHEDULER_PRINCIPAL,
        budget: { maxHops: 1, ttl: Date.now() + 30_000, callBudgetRemaining: 1 },
      }
    );
    await dispatch;
    expect(agentManager.interruptQuery).toHaveBeenCalledWith('run-1');
  });

  it('reports zero — and dead-letters nothing — for a run nobody is executing', async () => {
    const stop = await relay.publish(
      `${TASK_CANCEL_SUBJECT_PREFIX}ghost-run`,
      { type: 'task_cancel', runId: 'ghost-run' },
      {
        from: TASK_SCHEDULER_PRINCIPAL,
        budget: { maxHops: 1, ttl: Date.now() + 30_000, callBudgetRemaining: 1 },
      }
    );

    expect(stop.deliveredTo).toBe(0);
    // The adapter REFUSED it rather than ignoring it, so the bus knows somebody
    // was listening and does not manufacture a dead letter for a no-op.
    const dead = await relay.getDeadLetters({});
    expect(dead).toHaveLength(0);
  });
});
