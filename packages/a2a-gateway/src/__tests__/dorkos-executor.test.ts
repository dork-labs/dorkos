import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Role, TaskState, type Message, type Task, type TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { buildMessage, partText } from '../a2a-model.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AgentRegistryEntry } from '@dorkos/mesh';
import type { Logger } from '@dorkos/shared/logger';
import { AGENT_CANCEL_SUBJECT_PREFIX, A2A_GATEWAY_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import { DorkOSAgentExecutor } from '../dorkos-executor.js';

// ---------------------------------------------------------------------------
// Mocks & Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AgentRegistryEntry for testing. */
function makeAgent(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: 'agent-01',
    name: 'Test Agent',
    description: 'A test agent',
    runtime: 'claude-code' as AgentRegistryEntry['runtime'],
    capabilities: ['code-review'],
    behavior: { responseMode: 'always' },
    personaEnabled: true,
    namespace: 'default',
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'mesh',
    projectPath: '/projects/test',
    scanRoot: '/projects',
    enabledToolGroups: {},
    mcpServers: [],
    ...overrides,
  };
}

/** Create a minimal A2A Message for testing. */
function makeUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    ...buildMessage({ role: Role.ROLE_USER, text: 'Run the tests.', messageId: 'msg-001' }),
    ...overrides,
  };
}

/** Create a mock RequestContext. */
function makeRequestContext(
  overrides: {
    taskId?: string;
    contextId?: string;
    userMessage?: Message;
    metadata?: Record<string, unknown>;
    /**
     * Target agent for the message metadata. Defaults to `'agent-01'` because
     * the Express routing layer now guarantees a target reaches the executor;
     * pass `null` to omit it and exercise the missing-target path.
     */
    agentId?: string | null;
    task?: Partial<Task>;
  } = {}
): RequestContext {
  const metadata =
    overrides.metadata ??
    (overrides.agentId === null ? undefined : { agentId: overrides.agentId ?? 'agent-01' });
  const msg = overrides.userMessage ?? makeUserMessage(metadata ? { metadata } : {});
  return {
    taskId: overrides.taskId ?? 'task-123',
    contextId: overrides.contextId ?? 'ctx-456',
    userMessage: msg,
    task: overrides.task as RequestContext['task'],
  } as RequestContext;
}

/** Create a mock ExecutionEventBus. */
function makeEventBus(): ExecutionEventBus {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
  } as unknown as ExecutionEventBus;
}

/** Create a mock RelayCore. */
function makeRelay() {
  return {
    publish: vi
      .fn<
        (
          subject: string,
          payload: unknown,
          options: { from: string; replyTo?: string }
        ) => Promise<{ messageId: string; deliveredTo: number }>
      >()
      .mockResolvedValue({ messageId: 'relay-msg-001', deliveredTo: 1 }),
    subscribe: vi
      .fn<(pattern: string, handler: (envelope: RelayEnvelope) => void) => () => void>()
      .mockReturnValue(vi.fn()),
  };
}

/** Create a mock AgentRegistry. */
function makeRegistry(agents: AgentRegistryEntry[] = [makeAgent()]) {
  return {
    get: vi.fn((id: string) => agents.find((a) => a.id === id)),
    list: vi.fn(() => agents),
  };
}

// ---------------------------------------------------------------------------
// Realistic reply payloads — these mirror EXACTLY what the Claude Code
// adapter publishes to envelope.replyTo (one envelope per StreamEvent,
// wrapped with correlationId when the inbound payload carried one; see
// packages/relay/src/adapters/claude-code/agent-handler.ts and publish.ts).
// The previous version of this suite hand-crafted `{ content }` payloads
// that nothing in the codebase actually publishes, which is how the F2
// contract mismatch stayed green in CI.
// ---------------------------------------------------------------------------

/** Wrap a StreamEvent-shaped payload in a RelayEnvelope for the reply subject. */
function makeReplyEnvelope(payload: unknown, taskId = 'task-123'): RelayEnvelope {
  return {
    id: 'env-001',
    subject: `relay.a2a.reply.${taskId}`,
    from: 'agent:cca-session-1',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload,
  };
}

function textDelta(text: string, correlationId = 'task-123') {
  return { type: 'text_delta', data: { text }, correlationId };
}

function toolCallStart(correlationId = 'task-123') {
  return {
    type: 'tool_call_start',
    data: { id: 'tool-1', name: 'Bash', input: { command: 'pnpm test' } },
    correlationId,
  };
}

function errorEvent(message: string, correlationId = 'task-123') {
  return { type: 'error', data: { message }, correlationId };
}

function doneEvent(correlationId = 'task-123') {
  return { type: 'done', data: { sessionId: 'cca-session-1' }, correlationId };
}

function agentResult(text: string) {
  return { type: 'agent_result', text, done: true };
}

/**
 * Extract published events from a mock event bus.
 *
 * A2A v1.0 publishes each event inside an {@link AgentExecutionEvent} wrapper
 * — `{ kind, data }` — rather than as a bare Task or status update, so the
 * `kind` these helpers read now lives on the wrapper, not on the payload.
 */
function publishedEvents(bus: ExecutionEventBus): AgentExecutionEvent[] {
  return vi.mocked(bus.publish).mock.calls.map(([event]) => event);
}

function statusEvents(bus: ExecutionEventBus): TaskStatusUpdateEvent[] {
  return publishedEvents(bus)
    .filter((e) => e.kind === 'statusUpdate')
    .map((e) => e.data as TaskStatusUpdateEvent);
}

function taskEvents(bus: ExecutionEventBus): Task[] {
  return publishedEvents(bus)
    .filter((e) => e.kind === 'task')
    .map((e) => e.data as Task);
}

/**
 * Whether a task state ends the stream.
 *
 * A2A v1.0 removed the `final` flag from status-update events: a terminal
 * state IS the terminal event now, so this is what the old `.final` assertions
 * became.
 */
function isTerminal(state: TaskState | undefined): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  );
}

function statusText(event: TaskStatusUpdateEvent): string | undefined {
  const part = event.status?.message?.parts[0];
  return part ? partText(part) : undefined;
}

let relay: ReturnType<typeof makeRelay>;
let registry: ReturnType<typeof makeRegistry>;
let executor: DorkOSAgentExecutor;
let eventBus: ExecutionEventBus;
let logger: Logger;
let subscribeHandler: ((envelope: RelayEnvelope) => void) | undefined;

/**
 * Let every pending microtask run.
 *
 * The executor defers a reply that races a cancel until the cancel's outcome
 * is known, and that hand-off is promise work — no timer fires, so advancing
 * the fake clock would not run it.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Start a turn and let it get as far as having published and subscribed.
 *
 * `execute()` deliberately stays pending until the turn settles: A2A v1.0
 * ties the event bus's lifetime to that promise, closing the bus the moment
 * it resolves. So a test can no longer `await` the call and then drive the
 * reply — the bus would already be gone. It starts the turn, waits for the
 * publish and the `working` status to land (the point the old `await` used to
 * return at), drives the reply, and reads the bus.
 *
 * The returned promise is the turn's own completion, for the tests that care;
 * most assert on what reached the bus and can ignore it.
 */
async function startTurn(
  ctx: RequestContext,
  bus: ExecutionEventBus
): Promise<{ finished: Promise<void> }> {
  const finished = executor.execute(ctx, bus);
  // A turn that ends in a rejection is something a test asserts on, not an
  // unhandled rejection that fails the run.
  void finished.catch(() => undefined);
  // Drain the microtask queue — the relay publish and the `working` status it
  // gates are promise work, not timer work, so this runs under fake timers.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  // Wrapped, not returned bare: `await` adopts a returned promise, so handing
  // back `finished` directly would make every caller wait for the whole turn —
  // exactly the thing this helper exists to avoid.
  return { finished };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DorkOSAgentExecutor', () => {
  function buildExecutor() {
    executor = new DorkOSAgentExecutor({
      relay: relay as never,
      agentRegistry: registry as never,
      logger,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    relay = makeRelay();
    registry = makeRegistry();
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    subscribeHandler = undefined;
    relay.subscribe.mockImplementation(
      (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
        subscribeHandler = handler;
        return vi.fn();
      }
    );
    buildExecutor();
    eventBus = makeEventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Initial Task event (F1)
  // -------------------------------------------------------------------------

  describe('initial Task event', () => {
    it('publishes a Task event before any status-update', async () => {
      const ctx = makeRequestContext({ metadata: { agentId: 'agent-01' } });

      await startTurn(ctx, eventBus);

      const events = publishedEvents(eventBus);
      expect(events[0]!.kind).toBe('task');
      const first = events[0]!.data as Task;
      expect(first.id).toBe('task-123');
      expect(first.contextId).toBe('ctx-456');
      expect(first.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    });

    it('includes the user message in the initial task history', async () => {
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      const [task] = taskEvents(eventBus);
      expect(task!.history).toEqual([ctx.userMessage]);
    });

    it('carries the resolved agentId in task metadata', async () => {
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      const [task] = taskEvents(eventBus);
      expect(task!.metadata).toEqual(expect.objectContaining({ agentId: 'agent-01' }));
    });

    it('re-emits the stored task snapshot (not a fresh submitted task) for follow-up turns', async () => {
      const existingTask: Task = {
        id: 'task-123',
        contextId: 'ctx-456',
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
        history: [makeUserMessage(), makeUserMessage({ messageId: 'msg-002' })],
        artifacts: [],
        metadata: { agentId: 'agent-01' },
      };
      const ctx = makeRequestContext({ task: existingTask });

      await startTurn(ctx, eventBus);

      // The snapshot refresh keeps concurrent processing loops' in-memory
      // copies current so the follow-up user message survives in history
      const tasks = taskEvents(eventBus);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toBe(existingTask);
      expect(tasks[0]!.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    });

    it('publishes a Task even when the agent is not found, so the failure persists', async () => {
      registry.get.mockReturnValue(undefined);
      const ctx = makeRequestContext({ metadata: { agentId: 'nonexistent' } });

      await startTurn(ctx, eventBus);

      const [task] = taskEvents(eventBus);
      expect(task).toBeDefined();
      expect(task!.metadata).toEqual(expect.objectContaining({ agentId: 'nonexistent' }));
    });
  });

  // -------------------------------------------------------------------------
  // Agent Resolution
  // -------------------------------------------------------------------------

  describe('agent resolution', () => {
    it('resolves agent from userMessage metadata.agentId', async () => {
      const ctx = makeRequestContext({ metadata: { agentId: 'agent-01' } });

      await startTurn(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('agent-01');
    });

    it('resolves agent from task metadata when message metadata is absent', async () => {
      const ctx = makeRequestContext({
        agentId: null,
        task: {
          id: 'task-123',
          contextId: 'ctx-456',
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
          metadata: { agentId: 'agent-01' },
        },
      });

      await startTurn(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('agent-01');
    });

    it('fails with a missing-target diagnostic when no agentId is provided (never guesses)', async () => {
      const ctx = makeRequestContext({ agentId: null });

      await startTurn(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(isTerminal(failed!.status?.state)).toBe(true);
      expect(statusText(failed!)).toContain('No target agent specified');
      // Routing is never guessed — nothing is published to a relay subject.
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it('emits failed status with a diagnostic when the agent is not found', async () => {
      registry.get.mockReturnValue(undefined);
      const ctx = makeRequestContext({ metadata: { agentId: 'nonexistent' } });

      await startTurn(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(isTerminal(failed!.status?.state)).toBe(true);
      expect(statusText(failed!)).toContain("Agent 'nonexistent' not found");
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('emits failed status when no agents are registered', async () => {
      registry = makeRegistry([]);
      buildExecutor();
      const ctx = makeRequestContext({ agentId: null });

      await startTurn(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(failed!)).toContain('No agents registered');
      expect(eventBus.finished).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Relay Subject Construction & Publish
  // -------------------------------------------------------------------------

  describe('Relay publish', () => {
    it('publishes to relay.agent.{namespace}.{agentId}', async () => {
      registry = makeRegistry([makeAgent({ id: 'agent-42', namespace: 'production' })]);
      buildExecutor();
      const ctx = makeRequestContext({ metadata: { agentId: 'agent-42' } });

      await startTurn(ctx, eventBus);

      expect(relay.publish).toHaveBeenCalledWith(
        'relay.agent.production.agent-42',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('defaults namespace to "default" when agent has no namespace', async () => {
      registry = makeRegistry([makeAgent({ namespace: undefined as unknown as string })]);
      buildExecutor();
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      expect(relay.publish).toHaveBeenCalledWith(
        'relay.agent.default.agent-01',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('translates the A2A message to a Relay StandardPayload', async () => {
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      const [, publishedPayload] = relay.publish.mock.calls[0]!;
      expect(publishedPayload).toEqual(
        expect.objectContaining({
          content: 'Run the tests.',
          senderName: 'a2a-client',
          performative: 'request',
        })
      );
    });

    it('sets replyTo in publish options and subscribes before publishing', async () => {
      const ctx = makeRequestContext({ taskId: 'task-abc' });

      await startTurn(ctx, eventBus);

      const [subscribedSubject] = relay.subscribe.mock.calls[0]!;
      expect(subscribedSubject).toMatch(/^relay\.a2a\.reply\.task-abc\.[a-zA-Z0-9-]+$/);
      const [, , options] = relay.publish.mock.calls[0]!;
      expect(options).toEqual(
        expect.objectContaining({ from: 'a2a-gateway', replyTo: subscribedSubject })
      );
    });

    it('uses a distinct reply subject per execution so concurrent turns cannot cross-talk', async () => {
      const ctx1 = makeRequestContext();
      await startTurn(ctx1, eventBus);
      const [firstSubject] = relay.subscribe.mock.calls[0]!;
      const firstHandler = subscribeHandler!;

      // Follow-up turn on the same (non-terminal) task while turn 1 is in-flight
      const secondBus = makeEventBus();
      const ctx2 = makeRequestContext({
        task: {
          id: 'task-123',
          contextId: 'ctx-456',
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
          metadata: { agentId: 'agent-01' },
        },
      });
      await startTurn(ctx2, secondBus);
      const [secondSubject] = relay.subscribe.mock.calls[1]!;

      expect(secondSubject).not.toBe(firstSubject);

      // Turn 2's stream settles only turn 2 — turn 1 stays pending
      subscribeHandler!(makeReplyEnvelope(textDelta('Second answer.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      expect(
        statusEvents(secondBus).some((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED)
      ).toBe(true);
      expect(
        statusEvents(eventBus).some((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED)
      ).toBe(false);

      // Turn 1's stream still completes turn 1 with its own text
      firstHandler(makeReplyEnvelope(textDelta('First answer.')));
      firstHandler(makeReplyEnvelope(doneEvent()));

      const firstCompleted = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(firstCompleted).toHaveLength(1);
      expect(statusText(firstCompleted[0]!)).toBe('First answer.');
    });
  });

  // -------------------------------------------------------------------------
  // Stream accumulation -> completed (F2)
  // -------------------------------------------------------------------------

  describe('stream accumulation', () => {
    it('emits working status after successful publish', async () => {
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      const working = statusEvents(eventBus).find(
        (e) => e.status?.state === TaskState.TASK_STATE_WORKING
      );
      expect(working).toBeDefined();
      expect(isTerminal(working!.status?.state)).toBe(false);
    });

    it('accumulates text_delta events and completes once on done with the full text', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('Build ')));
      subscribeHandler!(makeReplyEnvelope(toolCallStart()));
      subscribeHandler!(makeReplyEnvelope(textDelta('passed ')));
      subscribeHandler!(makeReplyEnvelope(textDelta('successfully.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const completed = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(1);
      expect(isTerminal(completed[0]!.status?.state)).toBe(true);
      expect(statusText(completed[0]!)).toBe('Build passed successfully.');
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('does not complete on the first text_delta', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('partial')));

      const completed = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(0);
      expect(eventBus.finished).not.toHaveBeenCalled();
    });

    it('completes with an aggregated agent_result payload', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(agentResult('Full aggregated answer.')));

      const completed = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(1);
      expect(statusText(completed[0]!)).toBe('Full aggregated answer.');
    });

    it('fails the task when the stream reports an error before done', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('partial ')));
      subscribeHandler!(makeReplyEnvelope(errorEvent('SDK session crashed')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const failed = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_FAILED
      );
      expect(failed).toHaveLength(1);
      expect(isTerminal(failed[0]!.status?.state)).toBe(true);
      expect(statusText(failed[0]!)).toContain('SDK session crashed');
      const completed = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(0);
    });

    it('ignores events after the task has settled', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('Answer.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));
      const countAfterDone = vi.mocked(eventBus.publish).mock.calls.length;

      subscribeHandler!(makeReplyEnvelope(textDelta('late ')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      expect(vi.mocked(eventBus.publish).mock.calls.length).toBe(countAfterDone);
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from the reply subject when the stream completes', async () => {
      const unsubFn = vi.fn();
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return unsubFn;
        }
      );

      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      expect(unsubFn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // No status after terminal (F7)
  // -------------------------------------------------------------------------

  describe('terminal event ordering', () => {
    it('does not publish working after the reply settled during the publish await', async () => {
      let resolvePublish: (result: { messageId: string; deliveredTo: number }) => void;
      relay.publish.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePublish = resolve;
          })
      );

      const ctx = makeRequestContext();
      const executePromise = executor.execute(ctx, eventBus);

      // The whole reply stream arrives while relay.publish is still pending
      subscribeHandler!(makeReplyEnvelope(textDelta('Fast answer.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      resolvePublish!({ messageId: 'relay-msg-001', deliveredTo: 1 });
      await executePromise;

      const statuses = statusEvents(eventBus);
      const finalIndex = statuses.findIndex((e) => isTerminal(e.status?.state));
      expect(finalIndex).toBeGreaterThanOrEqual(0);
      expect(statuses.slice(finalIndex + 1)).toHaveLength(0);
      expect(statuses.some((e) => e.status?.state === TaskState.TASK_STATE_WORKING)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Failure paths
  // -------------------------------------------------------------------------

  describe('failure paths', () => {
    it('emits failed status with the real error when Relay publish throws', async () => {
      relay.publish.mockRejectedValue(new Error('Connection refused'));
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(isTerminal(failed!.status?.state)).toBe(true);
      expect(statusText(failed!)).toContain('Connection refused');
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('handles non-Error throw from relay.publish', async () => {
      relay.publish.mockRejectedValue('string error');
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(failed!)).toContain('Unknown publish error');
    });

    it('emits failed status when publish delivers to zero endpoints', async () => {
      relay.publish.mockResolvedValue({ messageId: 'msg-x', deliveredTo: 0 });
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(failed!)).toContain('no subscribers');
      expect(eventBus.finished).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('response timeout', () => {
    it('emits failed status after 2-minute timeout', async () => {
      const ctx = makeRequestContext();

      await startTurn(ctx, eventBus);

      vi.advanceTimersByTime(120_001);

      const failed = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_FAILED
      );
      expect(failed).toHaveLength(1);
      expect(isTerminal(failed[0]!.status?.state)).toBe(true);
      expect(statusText(failed[0]!)).toContain('timeout');
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('does not emit timeout after a successful response', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('Quick response.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const finishedCountBefore = vi.mocked(eventBus.finished).mock.calls.length;
      vi.advanceTimersByTime(120_001);

      expect(vi.mocked(eventBus.finished).mock.calls.length).toBe(finishedCountBefore);
    });

    it('asks the runner to end the turn when the caller stops waiting', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      await vi.advanceTimersByTimeAsync(120_001);

      const stop = relay.publish.mock.calls.find(([subject]) =>
        subject.startsWith(AGENT_CANCEL_SUBJECT_PREFIX)
      );
      // Walking away from the reply stream stops nothing: without this the
      // model keeps running, and billing, after the caller gave up (DOR-791).
      expect(stop).toBeDefined();
      expect(stop![1]).toEqual(
        expect.objectContaining({ type: 'agent_cancel', reason: 'caller_timeout' })
      );
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('asked to stop'));
    });

    it('says so in the log when a timed-out turn could not be stopped', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);
      relay.publish.mockResolvedValue({ messageId: 'msg-stop', deliveredTo: 0 });

      await vi.advanceTimersByTimeAsync(120_001);

      // Nothing on the wire can report this — the task is already failed — so
      // the log is the only place the leak is visible.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('may still be running'));
    });

    it('unsubscribes from reply subject on timeout', async () => {
      const unsubFn = vi.fn();
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return unsubFn;
        }
      );

      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      vi.advanceTimersByTime(120_001);

      expect(unsubFn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // cancelTask
  // -------------------------------------------------------------------------

  describe('cancelTask', () => {
    /** The stop requests the executor published, in order. */
    function stopRequests() {
      return relay.publish.mock.calls.filter(([subject]) =>
        subject.startsWith(AGENT_CANCEL_SUBJECT_PREFIX)
      );
    }

    it('asks the runner to end the turn and only then reports canceled', async () => {
      const execBus = makeEventBus();
      const ctx = makeRequestContext({ taskId: 'task-abort' });
      await startTurn(ctx, execBus);
      const replySubject = relay.publish.mock.calls[0]![2].replyTo;

      await executor.cancelTask('task-abort', eventBus);

      const [subject, payload, options] = stopRequests()[0]!;
      expect(subject).toBe(`${AGENT_CANCEL_SUBJECT_PREFIX}task-abort`);
      // The reply subject is what names ONE turn on the bus.
      expect(payload).toEqual({
        type: 'agent_cancel',
        replyTo: replySubject,
        reason: 'caller_canceled',
      });
      // The runner refuses a stop from anyone else.
      expect(options.from).toBe(A2A_GATEWAY_PRINCIPAL);
      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'statusUpdate',
          data: expect.objectContaining({
            taskId: 'task-abort',
            status: expect.objectContaining({ state: TaskState.TASK_STATE_CANCELED }),
          }),
        })
      );
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('refuses to claim canceled when nothing acknowledges the stop', async () => {
      const execBus = makeEventBus();
      const ctx = makeRequestContext({ taskId: 'task-unstoppable' });
      await startTurn(ctx, execBus);
      // Nobody is executing this turn any more (an adapter restart, say).
      relay.publish.mockResolvedValue({ messageId: 'msg-stop', deliveredTo: 0 });

      await expect(executor.cancelTask('task-unstoppable', eventBus)).rejects.toThrow(
        /not cancelable/i
      );

      expect(stopRequests()).toHaveLength(1);
      expect(statusEvents(eventBus)).toHaveLength(0);
      expect(eventBus.finished).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('may still be running'));
    });

    it('leaves a turn it could not stop able to finish the task', async () => {
      const execBus = makeEventBus();
      const ctx = makeRequestContext({ taskId: 'task-unstoppable' });
      await startTurn(ctx, execBus);
      relay.publish.mockResolvedValue({ messageId: 'msg-stop', deliveredTo: 0 });

      await expect(executor.cancelTask('task-unstoppable', eventBus)).rejects.toThrow();
      subscribeHandler!(makeReplyEnvelope(textDelta('Done anyway.'), 'task-unstoppable'));
      subscribeHandler!(makeReplyEnvelope(doneEvent(), 'task-unstoppable'));

      const completed = statusEvents(execBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(1);
      expect(statusText(completed[0]!)).toBe('Done anyway.');
    });

    it('stops both turns of a task that has two in flight', async () => {
      const ctx = makeRequestContext({ taskId: 'task-two' });
      await startTurn(ctx, makeEventBus());
      // A follow-up turn on a non-terminal task runs alongside the first, with
      // its own reply subject.
      await startTurn(
        makeRequestContext({
          taskId: 'task-two',
          task: {
            id: 'task-two',
            contextId: 'ctx-456',
            status: {
              state: TaskState.TASK_STATE_WORKING,
              message: undefined,
              timestamp: undefined,
            },
            metadata: { agentId: 'agent-01' },
          },
        }),
        makeEventBus()
      );

      await executor.cancelTask('task-two', eventBus);

      // One stop per turn — a single stop would leave the other one running.
      expect(stopRequests()).toHaveLength(2);
      const replySubjects = stopRequests().map(
        ([, payload]) => (payload as { replyTo: string }).replyTo
      );
      expect(new Set(replySubjects).size).toBe(2);
    });

    it('cancels the task when only one of two turns is stopped, and says which was not', async () => {
      await startTurn(makeRequestContext({ taskId: 'task-two' }), makeEventBus());
      await startTurn(
        makeRequestContext({
          taskId: 'task-two',
          task: {
            id: 'task-two',
            contextId: 'ctx-456',
            status: {
              state: TaskState.TASK_STATE_WORKING,
              message: undefined,
              timestamp: undefined,
            },
            metadata: { agentId: 'agent-01' },
          },
        }),
        makeEventBus()
      );
      // The first stop is taken, the second reaches nobody.
      let stops = 0;
      relay.publish.mockImplementation(async (subject: string) => {
        if (!subject.startsWith(AGENT_CANCEL_SUBJECT_PREFIX)) {
          return { messageId: 'm', deliveredTo: 1 };
        }
        stops += 1;
        return { messageId: 'm', deliveredTo: stops === 1 ? 1 : 0 };
      });

      await executor.cancelTask('task-two', eventBus);

      // The task IS being cancelled — something took a stop — so `canceled` is
      // honest. The turn nobody took keeps running, and the log is the only
      // place that says so.
      const canceled = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_CANCELED
      );
      expect(canceled).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('1 of 2 turns did not acknowledge')
      );
    });

    it('keeps the answer that lands while a stop nobody takes is still in flight', async () => {
      // The race, in order: the turn finishes and publishes its answer while
      // the stop is still on the wire, and the stop then turns out to reach
      // nobody. The cancel is withdrawn — so the answer is the only thing left
      // that can settle this task, and dropping it strands the task on
      // `working` with the reply discarded and no way to ask for it again.
      const execBus = makeEventBus();
      await startTurn(makeRequestContext({ taskId: 'task-race' }), execBus);

      relay.publish.mockImplementation(async (subject: string) => {
        if (!subject.startsWith(AGENT_CANCEL_SUBJECT_PREFIX)) {
          return { messageId: 'm', deliveredTo: 1 };
        }
        // Mid-stop: the agent was already finishing when the cancel went out.
        subscribeHandler!(makeReplyEnvelope(textDelta('The answer.'), 'task-race'));
        subscribeHandler!(makeReplyEnvelope(doneEvent(), 'task-race'));
        return { messageId: 'm', deliveredTo: 0 };
      });

      await expect(executor.cancelTask('task-race', eventBus)).rejects.toThrow(/not cancelable/i);
      await flushMicrotasks();

      const completed = statusEvents(execBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(1);
      expect(statusText(completed[0]!)).toBe('The answer.');
      expect(execBus.finished).toHaveBeenCalled();
    });

    it('drops a reply that lands while a stop a runner DID take is in flight', async () => {
      // The mirror image of the test above: same race, opposite outcome. A
      // runner took the stop, so the task really is cancelled and the
      // half-finished reply must not resurrect it as `completed`.
      const execBus = makeEventBus();
      await startTurn(makeRequestContext({ taskId: 'task-race-stopped' }), execBus);

      relay.publish.mockImplementation(async (subject: string) => {
        if (!subject.startsWith(AGENT_CANCEL_SUBJECT_PREFIX)) {
          return { messageId: 'm', deliveredTo: 1 };
        }
        subscribeHandler!(makeReplyEnvelope(textDelta('Too late.'), 'task-race-stopped'));
        subscribeHandler!(makeReplyEnvelope(doneEvent(), 'task-race-stopped'));
        return { messageId: 'm', deliveredTo: 1 };
      });

      await executor.cancelTask('task-race-stopped', eventBus);
      await flushMicrotasks();

      expect(
        statusEvents(execBus).filter((e) => e.status?.state === TaskState.TASK_STATE_COMPLETED)
      ).toHaveLength(0);
      expect(
        statusEvents(eventBus).filter((e) => e.status?.state === TaskState.TASK_STATE_CANCELED)
      ).toHaveLength(1);
    });

    it('refuses a cancel for a task it holds no turn for', async () => {
      await expect(executor.cancelTask('task-999', eventBus)).rejects.toThrow(/not cancelable/i);

      // Nothing was published and nothing was claimed: this gateway has no
      // handle on that task, and saying otherwise would be the original bug.
      expect(stopRequests()).toHaveLength(0);
      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(eventBus.finished).not.toHaveBeenCalled();
    });

    it('stops listening for the reply once the cancel is taken', async () => {
      const unsubFn = vi.fn();
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return unsubFn;
        }
      );
      const execBus = makeEventBus();
      await startTurn(makeRequestContext({ taskId: 'task-abort' }), execBus);

      await executor.cancelTask('task-abort', eventBus);

      expect(unsubFn).toHaveBeenCalled();
      // The response deadline is gone with it — a canceled task must not be
      // failed for timing out two minutes later.
      vi.advanceTimersByTime(120_001);
      expect(
        statusEvents(execBus).filter((e) => e.status?.state === TaskState.TASK_STATE_FAILED)
      ).toHaveLength(0);
    });

    it('suppresses response processing for canceled tasks', async () => {
      const execBus = makeEventBus();
      const ctx = makeRequestContext({ taskId: 'task-cancel-test' });
      await startTurn(ctx, execBus);

      const cancelBus = makeEventBus();
      await executor.cancelTask('task-cancel-test', cancelBus);

      // Late relay responses must not complete the canceled task
      subscribeHandler!(makeReplyEnvelope(textDelta('Late response.'), 'task-cancel-test'));
      subscribeHandler!(makeReplyEnvelope(doneEvent(), 'task-cancel-test'));

      const completed = statusEvents(execBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('treats an empty-string agentId as no target (never guesses)', async () => {
      const ctx = makeRequestContext({ metadata: { agentId: '' } });

      await startTurn(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(statusText(failed!)).toContain('No target agent specified');
      expect(relay.publish).not.toHaveBeenCalled();
    });

    it('completes with empty text when the stream produced no deltas', async () => {
      const ctx = makeRequestContext();
      await startTurn(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const completed = statusEvents(eventBus).filter(
        (e) => e.status?.state === TaskState.TASK_STATE_COMPLETED
      );
      expect(completed).toHaveLength(1);
      expect(statusText(completed[0]!)).toBe('');
    });

    it('prefers message metadata agentId over task metadata agentId', async () => {
      registry = makeRegistry([
        makeAgent({ id: 'msg-agent', name: 'Message Agent' }),
        makeAgent({ id: 'task-agent', name: 'Task Agent' }),
      ]);
      buildExecutor();

      const ctx = makeRequestContext({
        metadata: { agentId: 'msg-agent' },
        task: {
          id: 'task-123',
          contextId: 'ctx-456',
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
          metadata: { agentId: 'task-agent' },
        },
      });

      await startTurn(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('msg-agent');
    });
  });
});
