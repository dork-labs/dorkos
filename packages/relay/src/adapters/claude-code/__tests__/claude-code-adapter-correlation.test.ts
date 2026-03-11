import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type {
  AgentRuntimeLike,
  TraceStoreLike,
  ClaudeCodeAdapterDeps,
} from '../index.js';
import type { RelayPublisher } from '../../../types.js';

// === Mock factories ===

function createMockAgentManager(events?: StreamEvent[]): AgentRuntimeLike {
  const defaultEvents: StreamEvent[] = [
    { type: 'text_delta', data: { text: 'Hello ' } },
    { type: 'text_delta', data: { text: 'world' } },
    { type: 'done', data: {} },
  ];
  const streamEvents = events ?? defaultEvents;

  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        for (const event of streamEvents) {
          yield event;
        }
      })(),
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
  };
}

function createMockTraceStore(): TraceStoreLike {
  return {
    insertSpan: vi.fn(),
    updateSpan: vi.fn(),
  };
}

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
  };
}

function createTestEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'msg-001',
    subject: 'relay.agent.session-abc',
    from: 'user:console',
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

// === Test suite ===

describe('ClaudeCodeAdapter correlation ID', () => {
  let agentManager: AgentRuntimeLike;
  let traceStore: TraceStoreLike;
  let deps: ClaudeCodeAdapterDeps;
  let relay: RelayPublisher;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    agentManager = createMockAgentManager();
    traceStore = createMockTraceStore();
    relay = createMockRelay();
    deps = { agentManager, traceStore };
    adapter = new ClaudeCodeAdapter('claude-code', { defaultCwd: '/default/cwd' }, deps);
  });

  it('echoes correlationId from inbound payload in every response chunk', async () => {
    await adapter.start(relay);

    const envelope = createTestEnvelope({
      payload: { content: 'hello', correlationId: 'test-corr-uuid' },
    });

    await adapter.deliver('relay.agent.session-abc', envelope);

    // All publish calls should include correlationId in the payload
    const publishCalls = vi.mocked(relay.publish).mock.calls;
    expect(publishCalls.length).toBeGreaterThan(0);

    for (const [subject, payload] of publishCalls) {
      expect(subject).toBe('relay.human.console.client-1');
      const payloadObj = payload as Record<string, unknown>;
      expect(payloadObj.correlationId).toBe('test-corr-uuid');
    }
  });

  it('publishes response chunks without correlationId when inbound payload lacks one', async () => {
    await adapter.start(relay);

    const envelope = createTestEnvelope({
      payload: { content: 'hello' }, // no correlationId
    });

    await adapter.deliver('relay.agent.session-abc', envelope);

    // All publish calls should NOT have correlationId
    const publishCalls = vi.mocked(relay.publish).mock.calls;
    expect(publishCalls.length).toBeGreaterThan(0);

    for (const [, payload] of publishCalls) {
      const payloadObj = payload as Record<string, unknown>;
      expect(payloadObj).not.toHaveProperty('correlationId');
    }
  });

  it('includes correlationId in the terminal done event', async () => {
    // Use events that do NOT include a natural done, so the adapter generates one
    const events: StreamEvent[] = [
      { type: 'text_delta', data: { text: 'partial' } },
    ];
    agentManager = createMockAgentManager(events);
    deps = { agentManager, traceStore };
    adapter = new ClaudeCodeAdapter('claude-code', { defaultCwd: '/default/cwd' }, deps);

    await adapter.start(relay);

    const envelope = createTestEnvelope({
      payload: { content: 'hello', correlationId: 'done-corr-uuid' },
    });

    await adapter.deliver('relay.agent.session-abc', envelope);

    // The last publish call should be the terminal done event with correlationId
    const publishCalls = vi.mocked(relay.publish).mock.calls;
    const lastPayload = publishCalls[publishCalls.length - 1][1] as Record<string, unknown>;
    expect(lastPayload.type).toBe('done');
    expect(lastPayload.correlationId).toBe('done-corr-uuid');
  });

  it('preserves the original event type and data alongside correlationId', async () => {
    await adapter.start(relay);

    const envelope = createTestEnvelope({
      payload: { content: 'hello', correlationId: 'preserve-corr' },
    });

    await adapter.deliver('relay.agent.session-abc', envelope);

    const publishCalls = vi.mocked(relay.publish).mock.calls;
    // Find a text_delta event
    const textDeltaCall = publishCalls.find(
      ([, payload]) => (payload as Record<string, unknown>).type === 'text_delta',
    );
    expect(textDeltaCall).toBeDefined();

    const payload = textDeltaCall![1] as Record<string, unknown>;
    expect(payload.type).toBe('text_delta');
    expect(payload.data).toEqual({ text: 'Hello ' });
    expect(payload.correlationId).toBe('preserve-corr');
  });

  it('does not include correlationId in dispatch (Pulse) flows', async () => {
    // Pulse dispatch uses handleDispatchMessage which does not pass correlationId
    const pulseEvents: StreamEvent[] = [
      { type: 'text_delta', data: { text: 'pulse output' } },
      { type: 'done', data: {} },
    ];
    agentManager = createMockAgentManager(pulseEvents);
    deps = { agentManager, traceStore, pulseStore: { updateRun: vi.fn() } };
    adapter = new ClaudeCodeAdapter('claude-code', { defaultCwd: '/default/cwd' }, deps);

    await adapter.start(relay);

    const pulseEnvelope: RelayEnvelope = {
      id: 'pulse-msg-001',
      subject: 'relay.system.pulse.sched-1',
      from: 'system:pulse',
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
        type: 'pulse_dispatch',
        scheduleId: 'sched-1',
        runId: 'run-1',
        prompt: 'Check budget',
        cwd: '/home/user/project',
        permissionMode: 'default',
        scheduleName: 'Budget Monitor',
        cron: '0 * * * *',
        trigger: 'cron',
      },
    };

    await adapter.deliver('relay.system.pulse.sched-1', pulseEnvelope);

    // Pulse dispatch publishes progress events, not raw streaming events.
    // Any published payloads should NOT have correlationId since dispatch
    // flows don't use the correlation pipeline.
    const publishCalls = vi.mocked(relay.publish).mock.calls;
    for (const [, payload] of publishCalls) {
      const payloadObj = payload as Record<string, unknown>;
      expect(payloadObj).not.toHaveProperty('correlationId');
    }
  });
});
