import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { RelayEnvelope, StandardPayload } from '@dorkos/shared/relay-schemas';
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
    task?: { metadata?: Record<string, unknown> };
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
        [string, unknown, { from: string; replyTo?: string }],
        Promise<{ messageId: string; deliveredTo: number }>
      >()
      .mockResolvedValue({ messageId: 'relay-msg-001', deliveredTo: 1 }),
    subscribe: vi
      .fn<[string, (envelope: RelayEnvelope) => void], () => void>()
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

/** Build a mock RelayEnvelope containing a StandardPayload. */
function makeRelayEnvelope(content: string): RelayEnvelope {
  return {
    id: 'env-001',
    subject: 'relay.a2a.reply.task-123',
    from: 'relay.agent.default.agent-01',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content } satisfies StandardPayload,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DorkOSAgentExecutor', () => {
  let relay: ReturnType<typeof makeRelay>;
  let registry: ReturnType<typeof makeRegistry>;
  let executor: DorkOSAgentExecutor;
  let eventBus: ExecutionEventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    relay = makeRelay();
    registry = makeRegistry();
    executor = new DorkOSAgentExecutor({
      relay: relay as unknown as DorkOSAgentExecutor extends { relay: infer R } ? R : never,
      agentRegistry: registry as unknown as DorkOSAgentExecutor extends { agentRegistry: infer R }
        ? R
        : never,
    } as never);
    eventBus = makeEventBus();
  });

  afterEach(() => {
    vi.useRealTimers();
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
        task: { metadata: { agentId: 'agent-01' } },
      });

      await executor.execute(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('agent-01');
    });

    it('falls back to first registered agent when no agentId in metadata', async () => {
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(registry.list).toHaveBeenCalled();
      // Should subscribe and publish to the first agent's subject
      expect(relay.publish).toHaveBeenCalledWith(
        'relay.agent.default.agent-01',
        expect.any(Object),
        expect.objectContaining({ from: 'a2a-gateway' })
      );
    });

    it('emits failed status when specified agent is not found', async () => {
      registry.get.mockReturnValue(undefined);
      const ctx = makeRequestContext({ metadata: { agentId: 'nonexistent' } });

      await executor.execute(ctx, eventBus);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          status: expect.objectContaining({ state: 'failed' }),
          final: true,
        })
      );
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('emits failed status when no agents are registered', async () => {
      registry = makeRegistry([]);
      executor = new DorkOSAgentExecutor({
        relay: relay as never,
        agentRegistry: registry as never,
      } as never);
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          status: expect.objectContaining({ state: 'failed' }),
        })
      );
      const statusEvent = vi.mocked(eventBus.publish).mock.calls[0]![0] as TaskStatusUpdateEvent;
      expect(statusEvent.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('No agents registered') })
      );
      expect(eventBus.finished).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Relay Subject Construction
  // -------------------------------------------------------------------------

  describe('Relay subject construction', () => {
    it('publishes to relay.agent.{namespace}.{agentId}', async () => {
      const agent = makeAgent({ id: 'agent-42', namespace: 'production' });
      registry = makeRegistry([agent]);
      executor = new DorkOSAgentExecutor({
        relay: relay as never,
        agentRegistry: registry as never,
      } as never);
      const ctx = makeRequestContext({ metadata: { agentId: 'agent-42' } });

      await executor.execute(ctx, eventBus);

      expect(relay.publish).toHaveBeenCalledWith(
        'relay.agent.production.agent-42',
        expect.any(Object),
        expect.any(Object)
      );
    });

    it('defaults namespace to "default" when agent has no namespace', async () => {
      const agent = makeAgent({ namespace: undefined as unknown as string });
      registry = makeRegistry([agent]);
      executor = new DorkOSAgentExecutor({
        relay: relay as never,
        agentRegistry: registry as never,
      } as never);
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(relay.publish).toHaveBeenCalledWith(
        'relay.agent.default.agent-01',
        expect.any(Object),
        expect.any(Object)
      );
    });
  });

  // -------------------------------------------------------------------------
  // Relay Publish
  // -------------------------------------------------------------------------

  describe('Relay publish', () => {
    it('translates the A2A message to a Relay StandardPayload', async () => {
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      const [, publishedPayload] = relay.publish.mock.calls[0]!;
      const payload = publishedPayload as StandardPayload;
      expect(payload.content).toBe('Run the tests.');
      expect(payload.senderName).toBe('a2a-client');
      expect(payload.performative).toBe('request');
    });

    it('sets replyTo in publish options', async () => {
      const ctx = makeRequestContext({ taskId: 'task-abc' });

      await executor.execute(ctx, eventBus);

      const [, , options] = relay.publish.mock.calls[0]!;
      expect(options).toEqual(
        expect.objectContaining({
          from: 'a2a-gateway',
          replyTo: 'relay.a2a.reply.task-abc',
        })
      );
    });

    it('subscribes to reply subject before publishing', async () => {
      const ctx = makeRequestContext({ taskId: 'task-xyz' });

      await executor.execute(ctx, eventBus);

      // Subscribe should have been called before publish
      expect(relay.subscribe).toHaveBeenCalledWith(
        'relay.a2a.reply.task-xyz',
        expect.any(Function)
      );
      // Both should be called
      expect(relay.publish).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Working -> Completed State Transition
  // -------------------------------------------------------------------------

  describe('working -> completed state transition', () => {
    it('emits working status after successful publish', async () => {
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          status: expect.objectContaining({ state: 'working' }),
          final: false,
        })
      );
    });

    it('emits completed status with response message on Relay response', async () => {
      // Capture the subscribe handler so we can invoke it manually
      let subscribeHandler: ((envelope: RelayEnvelope) => void) | undefined;
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return vi.fn();
        }
      );

      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      // Simulate Relay response
      subscribeHandler!(makeRelayEnvelope('Build passed.'));

      // Should have published: working status + response message + completed status
      const calls = vi.mocked(eventBus.publish).mock.calls;
      const events = calls.map(([event]) => event);

      // Find the completed status event
      const completedEvent = events.find(
        (e) =>
          (e as TaskStatusUpdateEvent).kind === 'status-update' &&
          (e as TaskStatusUpdateEvent).status.state === 'completed'
      ) as TaskStatusUpdateEvent;

      expect(completedEvent).toBeDefined();
      expect(completedEvent.final).toBe(true);

      // Find the response message
      const responseMsg = events.find(
        (e) => (e as Message).kind === 'message' && (e as Message).role === 'agent'
      ) as Message;

      expect(responseMsg).toBeDefined();
      expect(responseMsg.parts[0]).toEqual({ kind: 'text', text: 'Build passed.' });

      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('calls eventBus.finished() after completed status', async () => {
      let subscribeHandler: ((envelope: RelayEnvelope) => void) | undefined;
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return vi.fn();
        }
      );

      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);
      subscribeHandler!(makeRelayEnvelope('Done.'));

      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Working -> Failed State Transition
  // -------------------------------------------------------------------------

  describe('working -> failed state transition', () => {
    it('emits failed status when Relay publish throws', async () => {
      relay.publish.mockRejectedValue(new Error('Connection refused'));
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          status: expect.objectContaining({ state: 'failed' }),
          final: true,
        })
      );
      const failedEvent = vi.mocked(eventBus.publish).mock.calls[0]![0] as TaskStatusUpdateEvent;
      expect(failedEvent.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('Connection refused') })
      );
      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('emits failed status when publish delivers to zero endpoints', async () => {
      relay.publish.mockResolvedValue({ messageId: 'msg-x', deliveredTo: 0 });
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          status: expect.objectContaining({ state: 'failed' }),
          final: true,
        })
      );
      const failedEvent = vi.mocked(eventBus.publish).mock.calls[0]![0] as TaskStatusUpdateEvent;
      expect(failedEvent.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('no subscribers') })
      );
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

      // Fast-forward past the 2-minute timeout
      vi.advanceTimersByTime(120_001);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          status: expect.objectContaining({ state: 'failed' }),
          final: true,
        })
      );

      const calls = vi.mocked(eventBus.publish).mock.calls;
      const timeoutEvent = calls.find(
        ([event]) =>
          (event as TaskStatusUpdateEvent).kind === 'status-update' &&
          (event as TaskStatusUpdateEvent).status.state === 'failed'
      );
      expect(timeoutEvent).toBeDefined();
      const statusMsg = (timeoutEvent![0] as TaskStatusUpdateEvent).status.message;
      expect(statusMsg?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('timeout') })
      );

      expect(eventBus.finished).toHaveBeenCalled();
    });

    it('does not emit timeout after a successful response', async () => {
      let subscribeHandler: ((envelope: RelayEnvelope) => void) | undefined;
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return vi.fn();
        }
      );

      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      // Respond before timeout
      subscribeHandler!(makeRelayEnvelope('Quick response.'));

      const finishedCountBefore = vi.mocked(eventBus.finished).mock.calls.length;

      // Advance past timeout
      vi.advanceTimersByTime(120_001);

      // finished should not have been called again
      expect(vi.mocked(eventBus.finished).mock.calls.length).toBe(finishedCountBefore);
    });

    it('unsubscribes from reply subject on timeout', async () => {
      const unsubFn = vi.fn();
      relay.subscribe.mockReturnValue(unsubFn);

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
    });

    it('calls eventBus.finished() after cancellation', async () => {
      await executor.cancelTask('task-999', eventBus);

      expect(eventBus.finished).toHaveBeenCalledTimes(1);
    });

    it('suppresses response processing for canceled tasks', async () => {
      let subscribeHandler: ((envelope: RelayEnvelope) => void) | undefined;
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return vi.fn();
        }
      );

      const execBus = makeEventBus();
      const ctx = makeRequestContext({ taskId: 'task-cancel-test' });
      await executor.execute(ctx, execBus);

      // Cancel the task
      const cancelBus = makeEventBus();
      await executor.cancelTask('task-cancel-test', cancelBus);

      // Now simulate a late Relay response
      subscribeHandler!(makeRelayEnvelope('Late response.'));

      // The execute event bus should NOT have received a completed event after the working event
      const publishCalls = vi.mocked(execBus.publish).mock.calls;
      const completedEvents = publishCalls.filter(
        ([event]) =>
          (event as TaskStatusUpdateEvent).kind === 'status-update' &&
          (event as TaskStatusUpdateEvent).status.state === 'completed'
      );
      expect(completedEvents).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('ignores empty string agentId in metadata', async () => {
      const ctx = makeRequestContext({ metadata: { agentId: '' } });

      await executor.execute(ctx, eventBus);

      // Should fall back to list
      expect(registry.list).toHaveBeenCalled();
    });

    it('handles non-Error throw from relay.publish', async () => {
      relay.publish.mockRejectedValue('string error');
      const ctx = makeRequestContext();

      await executor.execute(ctx, eventBus);

      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'status-update',
          status: expect.objectContaining({ state: 'failed' }),
        })
      );
      const failedEvent = vi.mocked(eventBus.publish).mock.calls[0]![0] as TaskStatusUpdateEvent;
      expect(failedEvent.status.message?.parts[0]).toEqual(
        expect.objectContaining({ text: expect.stringContaining('Unknown publish error') })
      );
    });

    it('cleans up unsubscribe on successful response', async () => {
      const unsubFn = vi.fn();
      relay.subscribe.mockReturnValue(unsubFn);

      let subscribeHandler: ((envelope: RelayEnvelope) => void) | undefined;
      relay.subscribe.mockImplementation(
        (_pattern: string, handler: (envelope: RelayEnvelope) => void) => {
          subscribeHandler = handler;
          return unsubFn;
        }
      );

      const ctx = makeRequestContext();
      await executor.execute(ctx, eventBus);

      subscribeHandler!(makeRelayEnvelope('Response.'));

      expect(unsubFn).toHaveBeenCalled();
    });

    it('prefers message metadata agentId over task metadata agentId', async () => {
      const agents = [
        makeAgent({ id: 'msg-agent', name: 'Message Agent' }),
        makeAgent({ id: 'task-agent', name: 'Task Agent' }),
      ];
      registry = makeRegistry(agents);
      executor = new DorkOSAgentExecutor({
        relay: relay as never,
        agentRegistry: registry as never,
      } as never);

      const ctx = makeRequestContext({
        metadata: { agentId: 'msg-agent' },
        task: { metadata: { agentId: 'task-agent' } },
      });

      await executor.execute(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('msg-agent');
    });

    it('uses task metadata agentId when message metadata has no agentId', async () => {
      const agents = [makeAgent({ id: 'task-agent', name: 'Task Agent' })];
      registry = makeRegistry(agents);
      executor = new DorkOSAgentExecutor({
        relay: relay as never,
        agentRegistry: registry as never,
      } as never);

      const ctx = makeRequestContext({
        task: { metadata: { agentId: 'task-agent' } },
      });

      await executor.execute(ctx, eventBus);

      expect(registry.get).toHaveBeenCalledWith('task-agent');
    });
  });
});
