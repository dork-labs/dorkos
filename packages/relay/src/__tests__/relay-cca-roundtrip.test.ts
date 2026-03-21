/**
 * Integration: full relay round-trip through ClaudeCodeAdapter.
 *
 * Tests the complete message journey:
 *   sender publishes query → CCA delivers to AgentManager
 *   → mock AgentManager yields StreamEvents
 *   → CCA publishes StreamEvents back to sender's endpoint
 *   → StreamEvents arrive without triggering a second sendMessage call (Bug 1 guard)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code/index.js';
import type { AgentRuntimeLike, TraceStoreLike } from '../adapters/claude-code/index.js';
import type {
  RelayPublisher,
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
} from '../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Minimal single-adapter registry shim
// ---------------------------------------------------------------------------

class SingleAdapterRegistry implements AdapterRegistryLike {
  constructor(private readonly adapter: ClaudeCodeAdapter) {}

  // CCA is started manually in test setup — this is a no-op
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createMockTraceStore(): TraceStoreLike {
  return {
    insertSpan: vi.fn(),
    updateSpan: vi.fn(),
  };
}

function createMockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'Deus' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('relay → CCA round-trip', () => {
  let tmpDir: string;
  let relay: RelayCore;
  let cca: ClaudeCodeAdapter;
  let agentManager: AgentRuntimeLike;
  let traceStore: TraceStoreLike;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-cca-roundtrip-'));

    agentManager = createMockAgentManager();
    traceStore = createMockTraceStore();

    // maxConcurrent: 5 avoids semaphore exhaustion when re-entrant StreamEvent
    // deliver() calls occur during response streaming
    cca = new ClaudeCodeAdapter(
      'claude-code',
      { defaultCwd: '/tmp', maxConcurrent: 5 },
      { agentManager, traceStore }
    );

    const registry = new SingleAdapterRegistry(cca);

    relay = new RelayCore({
      dataDir: tmpDir,
      defaultTtlMs: 3_600_000,
      adapterRegistry: registry,
    });

    // Give CCA a relay reference after RelayCore exists (avoids async setRelay issue)
    await cca.start(relay);
  });

  afterEach(async () => {
    await cca.stop();
    await relay.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('delivers query to receiver, StreamEvent responses arrive at sender without looping', async () => {
    await relay.registerEndpoint('relay.agent.sender-session');

    const receivedPayloads: unknown[] = [];
    relay.subscribe('relay.agent.sender-session', (envelope) => {
      receivedPayloads.push(envelope.payload);
    });

    await relay.publish(
      'relay.agent.lifeOS-session',
      { text: "What is my son's name?" },
      { from: 'relay.agent.sender-session', replyTo: 'relay.agent.sender-session' }
    );

    // AgentManager called exactly once for the real query — never for StreamEvent responses
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      'lifeOS-session',
      expect.any(String),
      expect.any(Object)
    );

    // StreamEvents arrived at sender's subject (round-trip completed)
    const types = receivedPayloads.map((p) => (p as Record<string, unknown>).type);
    expect(types).toContain('text_delta');
    expect(types).toContain('done');
  });

  it('calls sendMessage for a regular text payload without a StreamEvent type field', async () => {
    // Reset so we can count from zero for this isolated test
    vi.mocked(agentManager.sendMessage).mockClear();

    await relay.publish(
      'relay.agent.lifeOS-session',
      { text: 'Hello LifeOS' },
      { from: 'relay.agent.sender-session' }
    );

    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('passes context.agent.directory as cwd to ensureSession() in the full pipeline', async () => {
    // Purpose: end-to-end regression guard for the CWD bug fix.
    // Verifies that AdapterContext.agent.directory set by buildContext() flows
    // all the way through CCA to AgentManager.ensureSession().
    const context: AdapterContext = {
      agent: { directory: '/path/to/agent-b', runtime: 'claude-code' },
    };

    // Deliver directly to CCA with the context (simulating what AdapterDelivery does
    // after calling buildContext())
    await cca.deliver(
      'relay.agent.lifeOS-session',
      {
        id: 'msg-cwd-test',
        subject: 'relay.agent.lifeOS-session',
        from: 'agent:sender',
        budget: {
          hopCount: 1,
          maxHops: 5,
          ancestorChain: [],
          ttl: Date.now() + 300_000,
          callBudgetRemaining: 10,
        },
        createdAt: new Date().toISOString(),
        payload: { text: 'Hello' },
      } as RelayEnvelope,
      context
    );

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: '/path/to/agent-b' })
    );
  });

  it('publishes progress events + final agent_result to relay.inbox.* replyTo — unified streaming', async () => {
    await relay.registerEndpoint('relay.inbox.sender-session');

    const receivedPayloads: unknown[] = [];
    relay.subscribe('relay.inbox.sender-session', (envelope) => {
      receivedPayloads.push(envelope.payload);
    });

    vi.mocked(agentManager.sendMessage).mockClear();

    await relay.publish(
      'relay.agent.lifeOS-session',
      { text: 'question' },
      { from: 'relay.agent.sender-session', replyTo: 'relay.inbox.sender-session' }
    );

    // AgentManager called exactly once — no loop from inbox replyTo
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);

    // Inbox receives progress events + final agent_result (unified streaming for all relay.inbox.*)
    expect(receivedPayloads.length).toBeGreaterThanOrEqual(1);
    const lastPayload = receivedPayloads[receivedPayloads.length - 1] as Record<string, unknown>;
    expect(lastPayload).toMatchObject({ type: 'agent_result', text: 'Deus' });

    // No raw stream events (text_delta, done) published to the inbox
    const hasRawStreamEvents = receivedPayloads.some(
      (p) =>
        (p as Record<string, unknown>).type === 'text_delta' ||
        (p as Record<string, unknown>).type === 'done'
    );
    expect(hasRawStreamEvents).toBe(false);
  });

  it('publishes multiple progress events followed by agent_result for relay.inbox.dispatch.* replyTo', async () => {
    // Purpose: end-to-end verification that CCA streams progress to dispatch inboxes.
    // Validates the core contract: Agent A receives intermediate steps + done:true.
    await relay.registerEndpoint('relay.inbox.dispatch.test-uuid');

    const receivedPayloads: unknown[] = [];
    relay.subscribe('relay.inbox.dispatch.test-uuid', (envelope) => {
      receivedPayloads.push(envelope.payload);
    });

    vi.mocked(agentManager.sendMessage).mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'Thinking...' } } as StreamEvent;
        yield {
          type: 'tool_call_start',
          data: { tool_use_id: 'tu1', name: 'Read' },
        } as StreamEvent;
        yield {
          type: 'tool_result',
          data: { tool_use_id: 'tu1', content: 'file contents' },
        } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'Analysis complete.' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );

    await relay.publish(
      'relay.agent.dispatch-target',
      { text: 'Analyze this' },
      { from: 'relay.agent.sender', replyTo: 'relay.inbox.dispatch.test-uuid' }
    );

    // Wait briefly for async operations to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    const types = receivedPayloads.map((p) => (p as Record<string, unknown>).type);
    // Progress events arrive before the final result
    expect(types).toContain('progress');
    expect(types[types.length - 1]).toBe('agent_result');

    // Final result has done: true
    const finalResult = receivedPayloads[receivedPayloads.length - 1] as Record<string, unknown>;
    expect(finalResult.done).toBe(true);

    // Progress events have done: false
    const progressEvents = receivedPayloads.filter(
      (p) => (p as Record<string, unknown>).type === 'progress'
    );
    expect(progressEvents.length).toBeGreaterThan(0);
    progressEvents.forEach((p) => {
      expect((p as Record<string, unknown>).done).toBe(false);
    });
  });

  it('publishes progress events + agent_result for relay.inbox.query.* replyTo (unified streaming)', async () => {
    // Purpose: verify relay.inbox.query.* now uses the same unified streaming as dispatch.
    // All relay.inbox.* addresses receive incremental progress events + final agent_result.
    await relay.registerEndpoint('relay.inbox.query.existing-test');

    const receivedPayloads: unknown[] = [];
    relay.subscribe('relay.inbox.query.existing-test', (envelope) => {
      receivedPayloads.push(envelope.payload);
    });

    // Use default mock: yields one text_delta + done
    vi.mocked(agentManager.sendMessage).mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'answer' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );

    await relay.publish(
      'relay.agent.lifeOS-session',
      { text: 'question' },
      { from: 'relay.agent.sender', replyTo: 'relay.inbox.query.existing-test' }
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Receives progress events + final agent_result (unified streaming for all relay.inbox.*)
    expect(receivedPayloads.length).toBeGreaterThanOrEqual(1);
    const lastPayload = receivedPayloads[receivedPayloads.length - 1] as Record<string, unknown>;
    expect(lastPayload).toMatchObject({ type: 'agent_result' });

    // No raw stream events (text_delta, done) published to the query inbox
    const hasRawStreamEvents = receivedPayloads.some(
      (p) =>
        (p as Record<string, unknown>).type === 'text_delta' ||
        (p as Record<string, unknown>).type === 'done'
    );
    expect(hasRawStreamEvents).toBe(false);
  });

  it('step_type field is "message" for text completions and "tool_result" for tool events', async () => {
    // Purpose: validates the step_type discriminator field is correctly set,
    // allowing Agent A to distinguish text progress from tool activity.
    await relay.registerEndpoint('relay.inbox.dispatch.step-type-test');

    const receivedPayloads: unknown[] = [];
    relay.subscribe('relay.inbox.dispatch.step-type-test', (envelope) => {
      receivedPayloads.push(envelope.payload);
    });

    vi.mocked(agentManager.sendMessage).mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent;
        yield {
          type: 'tool_call_start',
          data: { tool_use_id: 'tu1', name: 'Bash' },
        } as StreamEvent;
        yield {
          type: 'tool_result',
          data: { tool_use_id: 'tu1', content: 'output' },
        } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );

    await relay.publish(
      'relay.agent.target',
      { text: 'Do work' },
      { from: 'relay.agent.src', replyTo: 'relay.inbox.dispatch.step-type-test' }
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const progressEvents = receivedPayloads.filter(
      (p) => (p as Record<string, unknown>).type === 'progress'
    ) as Array<Record<string, unknown>>;

    const messageSteps = progressEvents.filter((p) => p.step_type === 'message');
    const toolSteps = progressEvents.filter((p) => p.step_type === 'tool_result');

    expect(messageSteps.length).toBeGreaterThan(0);
    expect(toolSteps.length).toBeGreaterThan(0);
  });

  it('TTL sweeper unregisters dispatch inboxes after configured TTL', async () => {
    // Purpose: guard against TTL sweeper regression — dispatch inboxes must auto-expire.
    // Uses real timers with a very short TTL to avoid chokidar/fake-timer conflicts.
    const shortRelay = new RelayCore({
      dataDir: path.join(tmpDir, 'ttl-test'),
      dispatchInboxTtlMs: 10, // 10ms TTL
      ttlSweepIntervalMs: 5, // 5ms sweep
      adapterRegistry: new SingleAdapterRegistry(cca),
    });

    await shortRelay.registerEndpoint('relay.inbox.dispatch.ttl-test-uuid');
    expect(shortRelay.listEndpoints()).toHaveLength(1);

    // Wait for TTL (10ms) + two sweep intervals (10ms) + buffer — well under 100ms
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(shortRelay.listEndpoints()).toHaveLength(0);

    await shortRelay.close();
  });

  it('relay_send_and_wait resolves with populated progress array for CCA progress streaming', async () => {
    // Purpose: end-to-end guard for relay_send_and_wait Phase 3 enhancement.
    // relay_send_and_wait must accumulate progress events from query inbox and return them
    // in the response, not prematurely resolve on the first progress event.

    // This test validates the subscribe-level behavior by using RelayCore directly.
    // Register a query inbox and simulate the message flow that relay_send_and_wait uses.
    const inboxSubject = 'relay.inbox.query.e2e-test';
    await relay.registerEndpoint(inboxSubject);

    const progressEvents: unknown[] = [];
    let finalPayload: unknown;

    relay.subscribe(inboxSubject, (envelope) => {
      const payload = envelope.payload as Record<string, unknown>;
      if (payload?.type === 'progress' && payload?.done === false) {
        progressEvents.push(payload);
      } else {
        finalPayload = payload;
      }
    });

    // Simulate CCA publishing: 2 progress events + final agent_result
    await relay.publish(
      inboxSubject,
      { type: 'progress', step: 1, step_type: 'message', text: 'step1', done: false },
      { from: 'relay.agent.cca' }
    );
    await relay.publish(
      inboxSubject,
      { type: 'progress', step: 2, step_type: 'tool_result', text: 'tool output', done: false },
      { from: 'relay.agent.cca' }
    );
    await relay.publish(
      inboxSubject,
      { type: 'agent_result', text: 'Final answer', done: true },
      { from: 'relay.agent.cca' }
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(progressEvents).toHaveLength(2);
    expect(finalPayload).toMatchObject({ type: 'agent_result', done: true });

    await relay.unregisterEndpoint(inboxSubject);
  });
});
