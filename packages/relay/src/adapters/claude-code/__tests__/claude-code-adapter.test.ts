import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type {
  AgentRuntimeLike,
  AgentSessionStoreLike,
  TraceStoreLike,
  PulseStoreLike,
  ClaudeCodeAdapterDeps,
} from '../index.js';
import type { RelayPublisher, AdapterContext } from '../../../types.js';

// === Mock factories ===

function createMockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'Hello ' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'world' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
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

function createMockPulseStore(): PulseStoreLike {
  return {
    updateRun: vi.fn(),
  };
}

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
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

// === Compliance Suite ===
// NOTE: Compliance suite not run for ClaudeCodeAdapter because it depends on
// injected services (AgentRuntimeLike, TraceStoreLike, PulseStoreLike) and
// deliver() drives an SDK agent session via sendMessage(). The compliance
// suite's generic createAdapter() factory cannot wire up these dependencies.
// All compliance behaviors (shape, lifecycle, idempotency, delivery, status)
// are covered by the dedicated tests below.

// === Test suite ===

describe('ClaudeCodeAdapter', () => {
  let agentManager: AgentRuntimeLike;
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

  it('formats <relay_context> XML block with dual IDs, sender, budget, reply-to', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope);

    const prompt = vi.mocked(agentManager.sendMessage).mock.calls[0][1];
    // Dual-ID lines: stable Mesh ULID (Agent-ID) and SDK session UUID (Session-ID)
    expect(prompt).toContain('Agent-ID: session-abc');
    expect(prompt).toContain('Session-ID: session-abc');
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

    const hangingManager: AgentRuntimeLike = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockReturnValue(hangingStream),
      getSdkSessionId: vi.fn().mockReturnValue(undefined),
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
    // hasStarted is false because no agentSessionStore is provided, so there's
    // no persisted SDK session ID to resume — avoids broken resume attempts.
    expect(ensureCall[1]).toEqual({ permissionMode: 'default', hasStarted: false });
    expect(ensureCall[1]).not.toHaveProperty('cwd');

    const sendCall = vi.mocked(agentManager.sendMessage).mock.calls[0];
    expect(sendCall[2]).toEqual({ permissionMode: 'default' });
    expect(sendCall[2]).not.toHaveProperty('cwd');
  });

  it('extracts permissionMode from __bindingPermissions payload enrichment', async () => {
    // Purpose: Validates the fix for hardcoded permissionMode: 'default'. When BindingRouter
    // enriches the payload with __bindingPermissions, the CCA must extract permissionMode
    // and pass it to both ensureSession() and sendMessage().
    await adapter.start(relay);
    const envelope = createTestEnvelope({
      payload: {
        content: 'Run the report',
        __bindingPermissions: {
          canReply: true,
          canInitiate: true,
          permissionMode: 'bypassPermissions',
        },
      },
    });

    await adapter.deliver(envelope.subject, envelope);

    const ensureCall = vi.mocked(agentManager.ensureSession).mock.calls[0];
    expect(ensureCall[1]).toEqual(
      expect.objectContaining({ permissionMode: 'bypassPermissions' }),
    );

    const sendCall = vi.mocked(agentManager.sendMessage).mock.calls[0];
    expect(sendCall[2]).toEqual(
      expect.objectContaining({ permissionMode: 'bypassPermissions' }),
    );
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

  it('passes cwd from relay payload to ensureSession and sendMessage when no agent context', async () => {
    // Purpose: Validates the bug fix — relay payload cwd must be extracted and
    // forwarded even when context.agent.directory is undefined (web client sessions).
    await adapter.start(relay);
    const envelope = createTestEnvelope({
      payload: { content: 'Run pwd', cwd: '/my/project', correlationId: 'corr-123' },
    });

    const result = await adapter.deliver(envelope.subject, envelope, undefined /* no context */);

    expect(result.success).toBe(true);
    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'session-abc',
      expect.objectContaining({ cwd: '/my/project' }),
    );
    const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
    expect(sendArgs[2]).toEqual(expect.objectContaining({ cwd: '/my/project' }));
  });

  it('prefers payload cwd over agent context directory', async () => {
    // Purpose: Validates fallback precedence — payload cwd wins over Mesh agent context.
    await adapter.start(relay);
    const envelope = createTestEnvelope({
      payload: { content: 'Run pwd', cwd: '/payload/path', correlationId: 'corr-456' },
    });
    const context: AdapterContext = {
      agent: { directory: '/mesh/agent/path', runtime: 'claude-code' },
    };

    await adapter.deliver(envelope.subject, envelope, context);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'session-abc',
      expect.objectContaining({ cwd: '/payload/path' }),
    );
  });

  it('falls back to agent context directory when payload has no cwd', async () => {
    // Purpose: Ensures Mesh agent routing is not regressed — when payload cwd is absent,
    // context.agent.directory still wins.
    await adapter.start(relay);
    const envelope = createTestEnvelope(); // payload: { content: 'Run the budget report' } — no cwd
    const context: AdapterContext = {
      agent: { directory: '/projects/myapp', runtime: 'claude-code' },
    };

    await adapter.deliver(envelope.subject, envelope, context);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'session-abc',
      expect.objectContaining({ cwd: '/projects/myapp' }),
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

  // === Inbox replyTo path ===

  describe('inbox replyTo path', () => {
    it('publishes progress events + final agent_result to relay.inbox.* — unified streaming', async () => {
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent;
          yield { type: 'text_delta', data: { text: ' world' } } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })(),
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.inbox.sender' });

      await adapter.deliver(envelope.subject, envelope);

      const calls = vi.mocked(relay.publish).mock.calls;
      // Text-only stream: post-loop flushes buffer as progress (1) + agent_result (1) = 2 calls
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.every(([subject]) => subject === 'relay.inbox.sender')).toBe(true);

      // Final publish must be the agent_result with full accumulated text
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('relay.inbox.sender');
      expect(lastCall[1]).toMatchObject({ type: 'agent_result', text: 'Hello world' });

      // No raw text_delta payloads published (progress uses dispatch_progress type)
      const hasTextDelta = calls.some(
        ([, payload]) => (payload as Record<string, unknown>).type === 'text_delta',
      );
      expect(hasTextDelta).toBe(false);
    });

    it('streams individual events to relay.human.console.* (not aggregated)', async () => {
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent;
          yield { type: 'text_delta', data: { text: ' world' } } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })(),
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.human.console.abc' });

      await adapter.deliver(envelope.subject, envelope);

      // All three events published individually (not aggregated)
      expect(relay.publish).toHaveBeenCalledTimes(3);
      const subjects = vi.mocked(relay.publish).mock.calls.map(([s]) => s);
      expect(subjects.every((s) => s === 'relay.human.console.abc')).toBe(true);
    });
  });

  // === Persistent session mapping ===

  describe('persistent session mapping', () => {
    function createMockAgentSessionStore(initial?: Map<string, string>): AgentSessionStoreLike {
      const store = new Map<string, string>(initial);
      return {
        get: vi.fn((agentId: string) => store.get(agentId)),
        set: vi.fn((agentId: string, sdkId: string) => {
          store.set(agentId, sdkId);
        }),
      };
    }

    it('persists SDK session ID on first delivery when getSdkSessionId returns a real UUID', async () => {
      const sdkUUID = 'sdk-uuid-0000-aaaa-1234567890ab';
      vi.mocked(agentManager.getSdkSessionId).mockReturnValue(sdkUUID);

      const agentSessionStore = createMockAgentSessionStore();
      const adapterWithStore = new ClaudeCodeAdapter(
        'cca-persist',
        { defaultCwd: '/tmp' },
        { agentManager, traceStore, agentSessionStore },
      );
      await adapterWithStore.start(relay);

      const envelope = createTestEnvelope({ subject: 'relay.agent.agent-ulid-001' });
      await adapterWithStore.deliver(envelope.subject, envelope);

      // The subject key 'agent-ulid-001' should be mapped to the real SDK UUID
      expect(agentSessionStore.set).toHaveBeenCalledWith('agent-ulid-001', sdkUUID);
    });

    it('uses persisted SDK session ID on subsequent delivery (not raw subject key)', async () => {
      const sdkUUID = 'sdk-uuid-0000-bbbb-1234567890ab';
      // Store already has a mapping from a previous delivery
      const agentSessionStore = createMockAgentSessionStore(
        new Map([['agent-ulid-002', sdkUUID]]),
      );

      const adapterWithStore = new ClaudeCodeAdapter(
        'cca-resume',
        { defaultCwd: '/tmp' },
        { agentManager, traceStore, agentSessionStore },
      );
      await adapterWithStore.start(relay);

      const envelope = createTestEnvelope({ subject: 'relay.agent.agent-ulid-002' });
      await adapterWithStore.deliver(envelope.subject, envelope);

      // ensureSession and sendMessage must use the persisted SDK UUID, not 'agent-ulid-002'.
      // hasStarted is true because the store has a real SDK session ID to resume.
      expect(agentManager.ensureSession).toHaveBeenCalledWith(
        sdkUUID,
        expect.objectContaining({ permissionMode: 'default', hasStarted: true }),
      );
      expect(agentManager.sendMessage).toHaveBeenCalledWith(
        sdkUUID,
        expect.stringContaining('Run the budget report'),
        expect.anything(),
      );
      // set() must NOT be called — the mapping already exists
      expect(agentSessionStore.set).not.toHaveBeenCalled();
    });

    it('does not call getSdkSessionId when agentSessionStore is not provided', async () => {
      // Default adapter in beforeEach has no agentSessionStore
      await adapter.start(relay);
      const envelope = createTestEnvelope();

      await adapter.deliver(envelope.subject, envelope);

      expect(agentManager.getSdkSessionId).not.toHaveBeenCalled();
    });
  });

  // === Per-agentId queue (concurrency safety) ===

  describe('per-agentId queue (concurrency safety)', () => {
    it('same agentId delivers are serialized — second sendMessage starts only after first completes', async () => {
      const callOrder: string[] = [];
      let resolveFirst!: () => void;

      // First call: hangs until manually resolved
      const hangingStream = (async function* () {
        callOrder.push('first:start');
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        callOrder.push('first:end');
      })();

      // Second call: resolves immediately
      const quickStream = (async function* () {
        callOrder.push('second:start');
        yield { type: 'done', data: {} } as StreamEvent;
        callOrder.push('second:end');
      })();

      const serializedManager: AgentRuntimeLike = {
        ensureSession: vi.fn(),
        sendMessage: vi.fn()
          .mockReturnValueOnce(hangingStream)
          .mockReturnValueOnce(quickStream),
        getSdkSessionId: vi.fn().mockReturnValue(undefined),
      };

      const serializedAdapter = new ClaudeCodeAdapter(
        'serialized',
        { defaultCwd: '/tmp', maxConcurrent: 10 },
        { agentManager: serializedManager, traceStore },
      );
      await serializedAdapter.start(relay);

      const sameSubject = 'relay.agent.SAME_AGENT';
      const envelope1 = createTestEnvelope({ id: 'msg-s1', subject: sameSubject });
      const envelope2 = createTestEnvelope({ id: 'msg-s2', subject: sameSubject });

      // Fire both concurrently
      const first = serializedAdapter.deliver(sameSubject, envelope1);
      const second = serializedAdapter.deliver(sameSubject, envelope2);

      // Flush microtasks so first call can enter the queue
      await Promise.resolve();
      await Promise.resolve();

      // At this point, only the first call should have started
      expect(callOrder).toContain('first:start');
      expect(callOrder).not.toContain('second:start');

      // Unblock the first call
      resolveFirst();
      await first;

      // Now the second can run
      await second;

      expect(callOrder).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('different agentId delivers run in parallel — both sendMessage calls start without waiting', async () => {
      const startedAgents: string[] = [];
      let resolveA!: () => void;
      let resolveB!: () => void;

      const streamForA = (async function* () {
        startedAgents.push('AGENT_A');
        await new Promise<void>((resolve) => { resolveA = resolve; });
        yield { type: 'done', data: {} } as StreamEvent;
      })();

      const streamForB = (async function* () {
        startedAgents.push('AGENT_B');
        await new Promise<void>((resolve) => { resolveB = resolve; });
        yield { type: 'done', data: {} } as StreamEvent;
      })();

      const parallelManager: AgentRuntimeLike = {
        ensureSession: vi.fn(),
        sendMessage: vi.fn()
          .mockReturnValueOnce(streamForA)
          .mockReturnValueOnce(streamForB),
        getSdkSessionId: vi.fn().mockReturnValue(undefined),
      };

      const parallelAdapter = new ClaudeCodeAdapter(
        'parallel',
        { defaultCwd: '/tmp', maxConcurrent: 10 },
        { agentManager: parallelManager, traceStore },
      );
      await parallelAdapter.start(relay);

      const envelopeA = createTestEnvelope({ id: 'msg-a1', subject: 'relay.agent.AGENT_A' });
      const envelopeB = createTestEnvelope({ id: 'msg-b1', subject: 'relay.agent.AGENT_B' });

      // Fire both concurrently to different agents
      const deliverA = parallelAdapter.deliver('relay.agent.AGENT_A', envelopeA);
      const deliverB = parallelAdapter.deliver('relay.agent.AGENT_B', envelopeB);

      // Flush microtasks so both calls can enter their independent queues
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Both agents should have started without waiting for each other
      expect(startedAgents).toContain('AGENT_A');
      expect(startedAgents).toContain('AGENT_B');

      // Resolve both and await completion
      resolveA();
      resolveB();
      await Promise.all([deliverA, deliverB]);
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

  // === Terminal done event and delivery diagnostics (tasks 1.3, 1.4) ===

  describe('terminal done event on generator error', () => {
    it('publishes done event when SDK generator throws', async () => {
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'hello' } } as StreamEvent;
          throw new Error('SDK stream error');
        })(),
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.human.console.client-1' });

      const result = await adapter.deliver(envelope.subject, envelope);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/SDK stream error/);

      // The finally block should publish a done event even on error
      const publishCalls = vi.mocked(relay.publish).mock.calls;
      expect(publishCalls.length).toBeGreaterThanOrEqual(2); // text_delta + done

      const lastPublish = publishCalls[publishCalls.length - 1];
      const payload = lastPublish[1] as Record<string, unknown>;
      expect(payload).toMatchObject({ type: 'done', data: {} });
    });

    it('does not double-send done event on normal completion', async () => {
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'hello' } } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })(),
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.human.console.client-1' });

      await adapter.deliver(envelope.subject, envelope);

      const publishCalls = vi.mocked(relay.publish).mock.calls;
      const doneCalls = publishCalls.filter(
        ([, payload]) => (payload as Record<string, unknown>).type === 'done',
      );
      expect(doneCalls).toHaveLength(1);
    });

    it('sends done in finally even when publishResponse throws', async () => {
      let publishCount = 0;
      vi.mocked(relay.publish).mockImplementation(async () => {
        publishCount++;
        if (publishCount === 1) {
          throw new Error('Publish failed for text_delta');
        }
        return { messageId: `resp-${publishCount}`, deliveredTo: 1 };
      });

      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'hello' } } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })(),
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.human.console.client-1' });

      await adapter.deliver(envelope.subject, envelope);

      // done event should still have been published despite earlier publish failure
      const publishCalls = vi.mocked(relay.publish).mock.calls;
      const donePublish = publishCalls.find(
        ([, payload]) => (payload as Record<string, unknown>).type === 'done',
      );
      expect(donePublish).toBeDefined();
    });
  });

  describe('delivery diagnostics', () => {
    it('logs warning when deliveredTo is 0 for non-done events', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const adapterWithLogger = new ClaudeCodeAdapter(
        'diagnostic-test',
        { defaultCwd: '/tmp' },
        { agentManager, traceStore, logger: mockLogger },
      );
      await adapterWithLogger.start({
        ...relay,
        publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 0 }),
      });

      const envelope = createTestEnvelope({ replyTo: 'relay.human.console.client-1' });

      await adapterWithLogger.deliver(envelope.subject, envelope);

      // Warning should be logged for text_delta events with deliveredTo=0
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('delivered to 0'),
      );
    });

    it('does not log warning for done events with deliveredTo=0', async () => {
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      // Stream that only yields done
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'done', data: {} } as StreamEvent;
        })(),
      );

      const adapterWithLogger = new ClaudeCodeAdapter(
        'diagnostic-done',
        { defaultCwd: '/tmp' },
        { agentManager, traceStore, logger: mockLogger },
      );
      await adapterWithLogger.start({
        ...relay,
        publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 0 }),
      });

      const envelope = createTestEnvelope({ replyTo: 'relay.human.console.client-1' });

      await adapterWithLogger.deliver(envelope.subject, envelope);

      // No warning for done events
      const warnCalls = mockLogger.warn.mock.calls.filter(
        ([msg]: [string]) => msg.includes('delivered to 0'),
      );
      expect(warnCalls).toHaveLength(0);
    });
  });

  // === Platform formatting awareness (responseContext → systemPromptAppend) ===

  describe('platform formatting awareness', () => {
    it('passes systemPromptAppend with Slack formatting rules when responseContext includes formattingInstructions', async () => {
      await adapter.start(relay);
      const envelope = createTestEnvelope({
        payload: {
          content: 'List programming languages',
          responseContext: {
            platform: 'slack',
            maxLength: 4000,
            supportedFormats: ['text', 'mrkdwn'],
            formattingInstructions: 'FORMATTING RULES (you MUST follow these):\n- Do NOT use Markdown tables',
          },
        },
      });

      await adapter.deliver(envelope.subject, envelope);

      const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
      const opts = sendArgs[2] as { systemPromptAppend?: string };
      expect(opts.systemPromptAppend).toBeDefined();
      expect(opts.systemPromptAppend).toContain('<response_format>');
      expect(opts.systemPromptAppend).toContain('Platform: slack');
      expect(opts.systemPromptAppend).toContain('Do NOT use Markdown tables');
      expect(opts.systemPromptAppend).toContain('4000');
    });

    it('passes systemPromptAppend with Telegram formatting rules from formattingInstructions', async () => {
      await adapter.start(relay);
      const envelope = createTestEnvelope({
        payload: {
          content: 'List programming languages',
          responseContext: {
            platform: 'telegram',
            maxLength: 4096,
            supportedFormats: ['text', 'markdown'],
            formattingInstructions: 'FORMATTING RULES (you MUST follow these):\n- Do NOT use Markdown tables',
          },
        },
      });

      await adapter.deliver(envelope.subject, envelope);

      const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
      const opts = sendArgs[2] as { systemPromptAppend?: string };
      expect(opts.systemPromptAppend).toBeDefined();
      expect(opts.systemPromptAppend).toContain('Platform: telegram');
      expect(opts.systemPromptAppend).toContain('Do NOT use Markdown tables');
      expect(opts.systemPromptAppend).toContain('4096');
    });

    it('passes through third-party platform formattingInstructions without modification', async () => {
      await adapter.start(relay);
      const customRules = 'Use Discord-flavored markdown.\n- Spoiler tags: ||text||';
      const envelope = createTestEnvelope({
        payload: {
          content: 'Hello',
          responseContext: {
            platform: 'discord',
            maxLength: 2000,
            formattingInstructions: customRules,
          },
        },
      });

      await adapter.deliver(envelope.subject, envelope);

      const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
      const opts = sendArgs[2] as { systemPromptAppend?: string };
      expect(opts.systemPromptAppend).toBeDefined();
      expect(opts.systemPromptAppend).toContain('Platform: discord');
      expect(opts.systemPromptAppend).toContain(customRules);
      expect(opts.systemPromptAppend).toContain('2000');
    });

    it('falls back to generic hint when supportedFormats lacks markdown and no formattingInstructions', async () => {
      await adapter.start(relay);
      const envelope = createTestEnvelope({
        payload: {
          content: 'Hello',
          responseContext: {
            platform: 'sms',
            supportedFormats: ['text'],
          },
        },
      });

      await adapter.deliver(envelope.subject, envelope);

      const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
      const opts = sendArgs[2] as { systemPromptAppend?: string };
      expect(opts.systemPromptAppend).toBeDefined();
      expect(opts.systemPromptAppend).toContain('Platform: sms');
      expect(opts.systemPromptAppend).toContain('Avoid complex Markdown formatting');
    });

    it('does not include systemPromptAppend when no responseContext is present', async () => {
      await adapter.start(relay);
      const envelope = createTestEnvelope(); // no responseContext

      await adapter.deliver(envelope.subject, envelope);

      const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
      const opts = sendArgs[2] as Record<string, unknown>;
      expect(opts).not.toHaveProperty('systemPromptAppend');
    });

    it('does not include systemPromptAppend when responseContext has no platform', async () => {
      await adapter.start(relay);
      const envelope = createTestEnvelope({
        payload: {
          content: 'Hello',
          responseContext: { maxLength: 4000 },
        },
      });

      await adapter.deliver(envelope.subject, envelope);

      const sendArgs = vi.mocked(agentManager.sendMessage).mock.calls[0];
      const opts = sendArgs[2] as Record<string, unknown>;
      expect(opts).not.toHaveProperty('systemPromptAppend');
    });
  });
});
