import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AgentRegistryEntry } from '@dorkos/mesh';
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
    behavior: {},
    budget: {},
    namespace: 'default',
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'mesh',
    projectPath: '/projects/test',
    scanRoot: '/projects',
    enabledToolGroups: {},
    ...overrides,
  };
}

/** Create a minimal A2A Message for testing. */
function makeUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    kind: 'message',
    role: 'user',
    messageId: 'msg-001',
    parts: [{ kind: 'text', text: 'Run the tests.' }],
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
    task?: Partial<Task>;
  } = {}
): RequestContext {
  const msg =
    overrides.userMessage ??
    makeUserMessage(overrides.metadata ? { metadata: overrides.metadata } : {});
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

/** Extract published events from a mock event bus. */
function publishedEvents(bus: ExecutionEventBus): unknown[] {
  return vi.mocked(bus.publish).mock.calls.map(([event]) => event);
}

function statusEvents(bus: ExecutionEventBus): TaskStatusUpdateEvent[] {
  return publishedEvents(bus).filter(
    (e): e is TaskStatusUpdateEvent => (e as TaskStatusUpdateEvent).kind === 'status-update'
  );
}

function taskEvents(bus: ExecutionEventBus): Task[] {
  return publishedEvents(bus).filter((e): e is Task => (e as Task).kind === 'task');
}

function statusText(event: TaskStatusUpdateEvent): string | undefined {
  const part = event.status.message?.parts[0];
  return part?.kind === 'text' ? part.text : undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DorkOSAgentExecutor', () => {
  let relay: ReturnType<typeof makeRelay>;
  let registry: ReturnType<typeof makeRegistry>;
  let executor: DorkOSAgentExecutor;
  let eventBus: ExecutionEventBus;
  let subscribeHandler: ((envelope: RelayEnvelope) => void) | undefined;

  function buildExecutor() {
    executor = new DorkOSAgentExecutor({
      relay: relay as never,
      agentRegistry: registry as never,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    relay = makeRelay();
    registry = makeRegistry();
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

      await executor.execute(ctx, eventBus);

      const events = publishedEvents(eventBus);
      const first = events[0] as Task;
      expect(first.kind).toBe('task');
      expect(first.id).toBe('task-123');
      expect(first.contextId).toBe('ctx-456');
      expect(first.status.state).toBe('submitted');
    });

    it('includes the user message in the initial task history', async () => {
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      const [task] = taskEvents(eventBus);
      expect(task!.history).toEqual([ctx.userMessage]);
    });

    it('carries the resolved agentId in task metadata', async () => {
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      const [task] = taskEvents(eventBus);
      expect(task!.metadata).toEqual(expect.objectContaining({ agentId: 'agent-01' }));
    });

    it('re-emits the stored task snapshot (not a fresh submitted task) for follow-up turns', async () => {
      const existingTask: Task = {
        kind: 'task',
        id: 'task-123',
        contextId: 'ctx-456',
        status: { state: 'working' },
        history: [makeUserMessage(), makeUserMessage({ messageId: 'msg-002' })],
        metadata: { agentId: 'agent-01' },
      };
      const ctx = makeRequestContext({ task: existingTask });

      await executor.execute(ctx, eventBus);

      // The snapshot refresh keeps concurrent processing loops' in-memory
      // copies current so the follow-up user message survives in history
      const tasks = taskEvents(eventBus);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toBe(existingTask);
      expect(tasks[0]!.status.state).toBe('working');
    });

    it('publishes a Task even when the agent is not found, so the failure persists', async () => {
      registry.get.mockReturnValue(undefined);
      const ctx = makeRequestContext({ metadata: { agentId: 'nonexistent' } });

      await executor.execute(ctx, eventBus);

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

      await executor.execute(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('agent-01');
    });

    it('resolves agent from task metadata when message metadata is absent', async () => {
      const ctx = makeRequestContext({
        task: {
          kind: 'task',
          id: 'task-123',
          contextId: 'ctx-456',
          status: { state: 'working' },
          metadata: { agentId: 'agent-01' },
        },
      });

      await executor.execute(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('agent-01');
    });

    it('falls back to first registered agent when no agentId in metadata', async () => {
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(registry.list).toHaveBeenCalled();
      expect(relay.publish).toHaveBeenCalledWith(
        'relay.agent.default.agent-01',
        expect.any(Object),
        expect.objectContaining({ from: 'a2a-gateway' })
      );
    });

    it('emits failed status with a diagnostic when the agent is not found', async () => {
      registry.get.mockReturnValue(undefined);
      const ctx = makeRequestContext({ metadata: { agentId: 'nonexistent' } });

      await executor.execute(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status.state).toBe('failed');
      expect(failed!.final).toBe(true);
      expect(statusText(failed!)).toContain("Agent 'nonexistent' not found");
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('emits failed status when no agents are registered', async () => {
      registry = makeRegistry([]);
      buildExecutor();
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status.state).toBe('failed');
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

      await executor.execute(ctx, eventBus);

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

      await executor.execute(ctx, eventBus);

      expect(relay.publish).toHaveBeenCalledWith(
        'relay.agent.default.agent-01',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('translates the A2A message to a Relay StandardPayload', async () => {
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

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

      await executor.execute(ctx, eventBus);

      const [subscribedSubject] = relay.subscribe.mock.calls[0]!;
      expect(subscribedSubject).toMatch(/^relay\.a2a\.reply\.task-abc\.[a-zA-Z0-9-]+$/);
      const [, , options] = relay.publish.mock.calls[0]!;
      expect(options).toEqual(
        expect.objectContaining({ from: 'a2a-gateway', replyTo: subscribedSubject })
      );
    });

    it('uses a distinct reply subject per execution so concurrent turns cannot cross-talk', async () => {
      const ctx1 = makeRequestContext();
      await executor.execute(ctx1, eventBus);
      const [firstSubject] = relay.subscribe.mock.calls[0]!;
      const firstHandler = subscribeHandler!;

      // Follow-up turn on the same (non-terminal) task while turn 1 is in-flight
      const secondBus = makeEventBus();
      const ctx2 = makeRequestContext({
        task: {
          kind: 'task',
          id: 'task-123',
          contextId: 'ctx-456',
          status: { state: 'working' },
          metadata: { agentId: 'agent-01' },
        },
      });
      await executor.execute(ctx2, secondBus);
      const [secondSubject] = relay.subscribe.mock.calls[1]!;

      expect(secondSubject).not.toBe(firstSubject);

      // Turn 2's stream settles only turn 2 — turn 1 stays pending
      subscribeHandler!(makeReplyEnvelope(textDelta('Second answer.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      expect(statusEvents(secondBus).some((e) => e.status.state === 'completed')).toBe(true);
      expect(statusEvents(eventBus).some((e) => e.status.state === 'completed')).toBe(false);

      // Turn 1's stream still completes turn 1 with its own text
      firstHandler(makeReplyEnvelope(textDelta('First answer.')));
      firstHandler(makeReplyEnvelope(doneEvent()));

      const firstCompleted = statusEvents(eventBus).filter((e) => e.status.state === 'completed');
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

      await executor.execute(ctx, eventBus);

      const working = statusEvents(eventBus).find((e) => e.status.state === 'working');
      expect(working).toBeDefined();
      expect(working!.final).toBe(false);
    });

    it('accumulates text_delta events and completes once on done with the full text', async () => {
      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('Build ')));
      subscribeHandler!(makeReplyEnvelope(toolCallStart()));
      subscribeHandler!(makeReplyEnvelope(textDelta('passed ')));
      subscribeHandler!(makeReplyEnvelope(textDelta('successfully.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const completed = statusEvents(eventBus).filter((e) => e.status.state === 'completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]!.final).toBe(true);
      expect(statusText(completed[0]!)).toBe('Build passed successfully.');
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('does not complete on the first text_delta', async () => {
      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('partial')));

      const completed = statusEvents(eventBus).filter((e) => e.status.state === 'completed');
      expect(completed).toHaveLength(0);
      expect(eventBus.finished).not.toHaveBeenCalled();
    });

    it('completes with an aggregated agent_result payload', async () => {
      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(agentResult('Full aggregated answer.')));

      const completed = statusEvents(eventBus).filter((e) => e.status.state === 'completed');
      expect(completed).toHaveLength(1);
      expect(statusText(completed[0]!)).toBe('Full aggregated answer.');
    });

    it('fails the task when the stream reports an error before done', async () => {
      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('partial ')));
      subscribeHandler!(makeReplyEnvelope(errorEvent('SDK session crashed')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const failed = statusEvents(eventBus).filter((e) => e.status.state === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.final).toBe(true);
      expect(statusText(failed[0]!)).toContain('SDK session crashed');
      const completed = statusEvents(eventBus).filter((e) => e.status.state === 'completed');
      expect(completed).toHaveLength(0);
    });

    it('ignores events after the task has settled', async () => {
      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

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
      await executor.execute(ctx, eventBus);
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
      const finalIndex = statuses.findIndex((e) => e.final);
      expect(finalIndex).toBeGreaterThanOrEqual(0);
      expect(statuses.slice(finalIndex + 1)).toHaveLength(0);
      expect(statuses.some((e) => e.status.state === 'working')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Failure paths
  // -------------------------------------------------------------------------

  describe('failure paths', () => {
    it('emits failed status with the real error when Relay publish throws', async () => {
      relay.publish.mockRejectedValue(new Error('Connection refused'));
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status.state).toBe('failed');
      expect(failed!.final).toBe(true);
      expect(statusText(failed!)).toContain('Connection refused');
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('handles non-Error throw from relay.publish', async () => {
      relay.publish.mockRejectedValue('string error');
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status.state).toBe('failed');
      expect(statusText(failed!)).toContain('Unknown publish error');
    });

    it('emits failed status when publish delivers to zero endpoints', async () => {
      relay.publish.mockResolvedValue({ messageId: 'msg-x', deliveredTo: 0 });
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      const [failed] = statusEvents(eventBus);
      expect(failed!.status.state).toBe('failed');
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

      await executor.execute(ctx, eventBus);

      vi.advanceTimersByTime(120_001);

      const failed = statusEvents(eventBus).filter((e) => e.status.state === 'failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.final).toBe(true);
      expect(statusText(failed[0]!)).toContain('timeout');
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('does not emit timeout after a successful response', async () => {
      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(textDelta('Quick response.')));
      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const finishedCountBefore = vi.mocked(eventBus.finished).mock.calls.length;
      vi.advanceTimersByTime(120_001);

      expect(vi.mocked(eventBus.finished).mock.calls.length).toBe(finishedCountBefore);
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
      await executor.execute(ctx, eventBus);

      vi.advanceTimersByTime(120_001);

      expect(unsubFn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // cancelTask
  // -------------------------------------------------------------------------

  describe('cancelTask', () => {
    it('emits canceled status event', async () => {
      await executor.cancelTask('task-999', eventBus);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          taskId: 'task-999',
          status: expect.objectContaining({ state: 'canceled' }),
          final: true,
        })
      );
      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('suppresses response processing for canceled tasks', async () => {
      const execBus = makeEventBus();
      const ctx = makeRequestContext({ taskId: 'task-cancel-test' });
      await executor.execute(ctx, execBus);

      const cancelBus = makeEventBus();
      await executor.cancelTask('task-cancel-test', cancelBus);

      // Late relay responses must not complete the canceled task
      subscribeHandler!(makeReplyEnvelope(textDelta('Late response.'), 'task-cancel-test'));
      subscribeHandler!(makeReplyEnvelope(doneEvent(), 'task-cancel-test'));

      const completed = statusEvents(execBus).filter((e) => e.status.state === 'completed');
      expect(completed).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('ignores empty string agentId in metadata', async () => {
      const ctx = makeRequestContext({ metadata: { agentId: '' } });

      await executor.execute(ctx, eventBus);

      expect(registry.list).toHaveBeenCalled();
    });

    it('completes with empty text when the stream produced no deltas', async () => {
      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      subscribeHandler!(makeReplyEnvelope(doneEvent()));

      const completed = statusEvents(eventBus).filter((e) => e.status.state === 'completed');
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
          kind: 'task',
          id: 'task-123',
          contextId: 'ctx-456',
          status: { state: 'working' },
          metadata: { agentId: 'task-agent' },
        },
      });

      await executor.execute(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('msg-agent');
    });
  });
});
