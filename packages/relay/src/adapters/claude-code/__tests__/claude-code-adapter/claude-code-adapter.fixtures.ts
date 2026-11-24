/**
 * Shared doubles for the ClaudeCodeAdapter test files: a mock runtime, trace
 * and task stores, a relay publisher and envelope builders.
 *
 * The compliance suite does not run for ClaudeCodeAdapter: it depends on
 * injected services and drives an SDK agent session, which the suite's generic
 * factory cannot wire. The behaviours it would check are covered by these files.
 */
import { vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../../index.js';
import type {
  AgentRuntimeLike,
  TraceStoreLike,
  TasksStoreLike,
  ClaudeCodeAdapterDeps,
} from '../../index.js';
import type { RelayPublisher } from '../../../../types.js';

export function createMockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'Hello ' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'world' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
}

/**
 * A turn that emits one event and then parks forever — the shape of a run
 * blocked on a tool-approval prompt nobody will answer. It yields no further
 * events, so anything that only runs inside the consumer's loop body never runs
 * again. `parked` resolves once the consumer has asked for the event that will
 * never come.
 */
export function parkedTurn(): { stream: AsyncGenerator<StreamEvent>; parked: Promise<void> } {
  let signalParked!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const stream = (async function* () {
    yield { type: 'text_delta', data: { text: 'starting' } } as StreamEvent;
    signalParked();
    // Never settles: the run is waiting on a person who never arrives.
    await new Promise(() => {});
  })();
  return { stream, parked };
}

export function createMockTraceStore(): TraceStoreLike {
  return {
    insertSpan: vi.fn(),
    updateSpan: vi.fn(),
  };
}

export function createMockTasksStore(): TasksStoreLike {
  return {
    updateRun: vi.fn(),
  };
}

export function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

export function createTestEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'msg-001',
    subject: 'relay.agent.session-abc',
    from: 'relay.human.console',
    replyTo: 'relay.human.console.client-1',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'Run the budget report' },
    ...overrides,
  };
}

export function createTasksEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'msg-002',
    subject: 'relay.system.tasks.budget-monitor',
    from: 'relay.system.tasks.scheduler',
    replyTo: 'relay.human.console.client-1',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 5,
    },
    createdAt: new Date().toISOString(),
    payload: {
      type: 'task_dispatch',
      taskId: 'sched-1',
      runId: 'run-1',
      prompt: 'Check the budget',
      cwd: '/home/user/project',
      permissionMode: 'default',
      taskName: 'Budget Monitor',
      cron: '0 * * * *',
      // What the scheduler actually puts on the wire: `run.trigger`, one of
      // `scheduled` / `manual` / `agent` (`services/tasks/relay-dispatch.ts`).
      // This said `'cron'`, which no producer has ever sent, and that mattered
      // the moment the receiver started reading the field.
      trigger: 'scheduled',
    },
    ...overrides,
  };
}

/**
 * A run id is a ULID; the session it now runs under is a fresh UUID minted by
 * the handler (`task-handler.ts`), not the run id itself — a session keyed by
 * a ULID fails every route's UUID validation. Tests below capture the session
 * id the code actually minted and check its shape, rather than hardcoding it.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The adapter under test with fresh doubles for every dependency. */
export interface AdapterHarness {
  agentManager: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  taskStore: TasksStoreLike;
  deps: ClaudeCodeAdapterDeps;
  relay: RelayPublisher;
  adapter: ClaudeCodeAdapter;
}

/** Build a fresh {@link AdapterHarness}; call it from each file's `beforeEach`. */
export function createAdapterHarness(): AdapterHarness {
  const agentManager = createMockAgentManager();
  const traceStore = createMockTraceStore();
  const taskStore = createMockTasksStore();
  const relay = createMockRelay();
  const deps = { agentManager, traceStore, taskStore, approvalAuthorizer: () => true };
  const adapter = new ClaudeCodeAdapter('claude-code', { defaultCwd: '/default/cwd' }, deps);
  return { agentManager, traceStore, taskStore, deps, relay, adapter };
}
