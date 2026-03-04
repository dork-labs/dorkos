import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope, TraceSpan } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../claude-code-adapter.js';
import type {
  AgentManagerLike,
  TraceStoreLike,
  PulseStoreLike,
  ClaudeCodeAdapterDeps,
} from '../claude-code-adapter.js';
import type { RelayPublisher, AdapterContext } from '../../types.js';

// === Mock factories ===

function createMockAgentManager(): AgentManagerLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'Hello ' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'world' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })(),
    ),
  };
}

function createMockTraceStore(): TraceStoreLike {
  return {
    insertSpan: vi.fn(),
    updateSpan: vi.fn(),
  };
}

function createMockPulseStore(): PulseStoreLike {
  return {
    updateRun: vi.fn(),
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

function createPulseEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'msg-002',
    subject: 'relay.system.pulse.budget-monitor',
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
      prompt: 'Check the budget',
      cwd: '/home/user/project',
      permissionMode: 'default',
      scheduleName: 'Budget Monitor',
      cron: '0 * * * *',
      trigger: 'cron',
    },
    ...overrides,
  };
}

// === Test suite ===

describe('ClaudeCodeAdapter', () => {
  let agentManager: AgentManagerLike;
  let traceStore: TraceStoreLike;
  let pulseStore: PulseStoreLike;
  let deps: ClaudeCodeAdapterDeps;
  let relay: RelayPublisher;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    agentManager = createMockAgentManager();
    traceStore = createMockTraceStore();
    pulseStore = createMockPulseStore();
    relay = createMockRelay();
    deps = { agentManager, traceStore, pulseStore };
    adapter = new ClaudeCodeAdapter('claude-code', { defaultCwd: '/default/cwd' }, deps);
  });

  // === Adapter lifecycle ===

  it('start() sets state to connected', async () => {
    await adapter.start(relay);
    expect(adapter.getStatus().state).toBe('connected');
  });

  it('stop() sets state to disconnected', async () => {
    await adapter.start(relay);
    await adapter.stop();
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  // === Agent message delivery ===

  it('delivers agent message — calls AgentManager with correct cwd and formatted prompt', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();
    const context: AdapterContext = {
      agent: { directory: '/projects/myapp', runtime: 'claude-code' },
    };

    const result = await adapter.deliver(envelope.subject, envelope, context);

    expect(result.success).toBe(true);
    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'session-abc',
      expect.objectContaining({ cwd: '/projects/myapp' }),
    );
    const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
    expect(sendArgs[0]).toBe('session-abc');
    expect(sendArgs[1]).toContain('<relay_context>');
    expect(sendArgs[1]).toContain('Run the budget report');
  });

  it('formats <relay_context> XML block with sender, budget, reply-to', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope);

    const prompt = vi.mocked(agentManager.sendMessage).mock.calls[0][1];
    expect(prompt).toContain('From: user:console');
    expect(prompt).toContain('Message-ID: msg-001');
    expect(prompt).toContain('Hops: 1 of 5 used');
    expect(prompt).toContain('Reply to: relay.human.console.client-1');
    expect(prompt).toContain('Run the budget report');
  });

  it('enforces concurrency semaphore — rejects when at capacity', async () => {
    // Create adapter with maxConcurrent: 1 and a sendMessage that never resolves
    let resolveFirst!: () => void;
    const hangingStream = (async function* () {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
    })();

    const hangingManager: AgentManagerLike = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockReturnValue(hangingStream),
    };
    const cappedAdapter = new ClaudeCodeAdapter(
      'capped',
      { maxConcurrent: 1, defaultCwd: '/tmp' },
      { agentManager: hangingManager, traceStore },
    );
    await cappedAdapter.start(relay);

    const envelope = createTestEnvelope();

    // First call occupies the slot (don't await)
    const firstCall = cappedAdapter.deliver(envelope.subject, envelope);

    // Give the first call time to increment activeCount
    await Promise.resolve();
    await Promise.resolve();

    // Second call should be rejected immediately
    const secondResult = await cappedAdapter.deliver(envelope.subject, envelope);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toMatch(/Adapter at capacity/);

    // Clean up: let first call finish
    resolveFirst();
    await firstCall;
  });

  it('publishes response events to envelope.replyTo', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope);

    // Should have published for each event yielded (text_delta x2, done x1)
    expect(relay.publish).toHaveBeenCalled();
    const firstCall = vi.mocked(relay.publish).mock.calls[0];
    expect(firstCall[0]).toBe('relay.human.console.client-1');
    expect(firstCall[2]).toMatchObject({
      from: 'agent:session-abc',
      budget: { hopCount: 2 }, // original hopCount(1) + 1
    });
  });

  it('records trace spans through delivery lifecycle', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope);

    expect(traceStore.insertSpan).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', messageId: 'msg-001' }),
    );
    expect(traceStore.updateSpan).toHaveBeenCalledWith(
      'msg-001',
      expect.objectContaining({ status: 'delivered' }),
    );
    expect(traceStore.updateSpan).toHaveBeenCalledWith(
      'msg-001',
      expect.objectContaining({ status: 'processed' }),
    );
  });

  it('returns failure result on session error', async () => {
    vi.mocked(agentManager.sendMessage).mockReturnValue(
      (async function* () {
        throw new Error('Agent session crashed');
      })(),
    );
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    const result = await adapter.deliver(envelope.subject, envelope);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Agent session crashed/);
    expect(traceStore.updateSpan).toHaveBeenCalledWith(
      'msg-001',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('does not pass cwd when no context is provided (lets session.cwd take precedence)', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope);

    // When no Mesh context is available, CCA should NOT override with defaultCwd.
    // The session's stored CWD (set by BindingRouter from binding.projectPath)
    // takes precedence via AgentManager's fallback chain.
    const ensureCall = vi.mocked(agentManager.ensureSession).mock.calls[0];
    expect(ensureCall[0]).toBe('session-abc');
    expect(ensureCall[1]).toEqual({ permissionMode: 'default', hasStarted: true });
    expect(ensureCall[1]).not.toHaveProperty('cwd');

    const sendCall = vi.mocked(agentManager.sendMessage).mock.calls[0];
    expect(sendCall[2]).toEqual({});
    expect(sendCall[2]).not.toHaveProperty('cwd');
  });

  it('uses context.agent.directory when Mesh context is provided', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();
    const context: AdapterContext = {
      agent: { directory: '/mesh/agent/dir', runtime: 'claude-code' },
    };

    await adapter.deliver(envelope.subject, envelope, context);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'session-abc',
      expect.objectContaining({ cwd: '/mesh/agent/dir' }),
    );
  });

  // === Pulse message delivery ===

  it('handles Pulse dispatch messages — validates payload, updates PulseStore lifecycle', async () => {
    await adapter.start(relay);
    const envelope = createPulseEnvelope();

    const result = await adapter.deliver(envelope.subject, envelope);

    expect(result.success).toBe(true);
    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      'run-1',
      'Check the budget',
      expect.anything(),
    );
    expect(pulseStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('Pulse: records failed trace for invalid payload', async () => {
    await adapter.start(relay);
    const envelope = createPulseEnvelope({
      payload: { invalid: 'payload' },
    });

    const result = await adapter.deliver(envelope.subject, envelope);

    expect(result.success).toBe(false);
    expect(traceStore.insertSpan).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('Pulse: updates PulseStore to cancelled when TTL already expired', async () => {
    await adapter.start(relay);
    const envelope = createPulseEnvelope({
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() - 1000, // expired
        callBudgetRemaining: 5,
      },
    });

    const result = await adapter.deliver(envelope.subject, envelope);

    // Should fail due to expired TTL
    expect(result.success).toBe(false);
    // PulseStore should be updated (failed or cancelled)
    expect(pulseStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: expect.stringMatching(/failed|cancelled/) }),
    );
  });

  // === StreamEvent filter (Bug 1 guard) ===

  describe('agent message delivery', () => {
    it('skips sendMessage and marks trace processed for every StreamEvent payload type', async () => {
      const STREAM_EVENT_TYPES = [
        'text_delta', 'tool_call_start', 'tool_call_end', 'tool_call_delta',
        'tool_result', 'session_status', 'approval_required', 'question_prompt',
        'error', 'done', 'task_update', 'relay_message', 'relay_receipt', 'message_delivered',
      ] as const;

      await adapter.start(relay);

      for (const type of STREAM_EVENT_TYPES) {
        vi.clearAllMocks();
        const envelope = createTestEnvelope({
          payload: { type, data: { text: 'response from peer agent' } },
          replyTo: 'relay.human.console.client-1',
        });

        const result = await adapter.deliver(envelope.subject, envelope);

        expect(result.success, `type=${type}`).toBe(true);
        expect(agentManager.sendMessage, `type=${type}`).not.toHaveBeenCalled();
        expect(traceStore.updateSpan).toHaveBeenCalledWith(
          envelope.id,
          expect.objectContaining({ status: 'processed', processedAt: expect.any(Number) }),
        );
      }
    });
  });

  it('Pulse: collects output summary up to 1000 chars', async () => {
    // Generate events with text that exceeds 1000 chars total
    const longText = 'a'.repeat(600);
    vi.mocked(agentManager.sendMessage).mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: longText } } as StreamEvent;
        yield { type: 'text_delta', data: { text: longText } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })(),
    );

    await adapter.start(relay);
    const envelope = createPulseEnvelope();

    await adapter.deliver(envelope.subject, envelope);

    const updateCall = vi.mocked(pulseStore.updateRun).mock.calls[0][1];
    expect((updateCall.outputSummary as string).length).toBeLessThanOrEqual(1000);
  });
});
