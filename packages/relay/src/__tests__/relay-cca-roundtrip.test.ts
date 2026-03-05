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
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import type {
  AgentManagerLike,
  TraceStoreLike,
} from '../adapters/claude-code-adapter.js';
import type { RelayPublisher, AdapterRegistryLike, AdapterContext, DeliveryResult } from '../types.js';
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
    context?: AdapterContext,
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

function createMockAgentManager(): AgentManagerLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', data: { text: 'Deus' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })(),
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
  let agentManager: AgentManagerLike;
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
      { agentManager, traceStore },
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
      { from: 'relay.agent.sender-session', replyTo: 'relay.agent.sender-session' },
    );

    // AgentManager called exactly once for the real query — never for StreamEvent responses
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      'lifeOS-session',
      expect.any(String),
      expect.any(Object),
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
      { from: 'relay.agent.sender-session' },
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
    await cca.deliver('relay.agent.lifeOS-session', {
      id: 'msg-cwd-test',
      subject: 'relay.agent.lifeOS-session',
      from: 'agent:sender',
      budget: {
        hopCount: 1, maxHops: 5, ancestorChain: [],
        ttl: Date.now() + 300_000, callBudgetRemaining: 10,
      },
      createdAt: new Date().toISOString(),
      payload: { text: 'Hello' },
    } as RelayEnvelope, context);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: '/path/to/agent-b' }),
    );
  });

  it('publishes single agent_result to relay.inbox.* replyTo — not individual StreamEvents', async () => {
    await relay.registerEndpoint('relay.inbox.sender-session');

    const receivedPayloads: unknown[] = [];
    relay.subscribe('relay.inbox.sender-session', (envelope) => {
      receivedPayloads.push(envelope.payload);
    });

    vi.mocked(agentManager.sendMessage).mockClear();

    await relay.publish(
      'relay.agent.lifeOS-session',
      { text: 'question' },
      { from: 'relay.agent.sender-session', replyTo: 'relay.inbox.sender-session' },
    );

    // AgentManager called exactly once — no loop from inbox replyTo
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);

    // Inbox receives exactly one aggregated result, not individual stream events
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toMatchObject({ type: 'agent_result', text: 'Deus' });

    // No raw streaming events published to the inbox
    const hasStreamEvents = receivedPayloads.some(
      (p) => (p as Record<string, unknown>).type === 'text_delta' ||
               (p as Record<string, unknown>).type === 'done',
    );
    expect(hasStreamEvents).toBe(false);
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
        yield { type: 'tool_call_start', data: { tool_use_id: 'tu1', name: 'Read' } } as StreamEvent;
        yield { type: 'tool_result', data: { tool_use_id: 'tu1', content: 'file contents' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'Analysis complete.' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })(),
    );

    await relay.publish(
      'relay.agent.dispatch-target',
      { text: 'Analyze this' },
      { from: 'relay.agent.sender', replyTo: 'relay.inbox.dispatch.test-uuid' },
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
      (p) => (p as Record<string, unknown>).type === 'progress',
    );
    expect(progressEvents.length).toBeGreaterThan(0);
    progressEvents.forEach((p) => {
      expect((p as Record<string, unknown>).done).toBe(false);
    });
  });

  it('still publishes single agent_result for relay.inbox.query.* replyTo (backward compat)', async () => {
    // Purpose: regression guard — relay_query inbox behavior must not change.
    // relay_query subscribes via EventEmitter and resolves on the FIRST message;
    // streaming would break it.
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
      })(),
    );

    await relay.publish(
      'relay.agent.lifeOS-session',
      { text: 'question' },
      { from: 'relay.agent.sender', replyTo: 'relay.inbox.query.existing-test' },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Still exactly one message, still agent_result, still no progress events
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toMatchObject({ type: 'agent_result' });
    const hasProgress = receivedPayloads.some(
      (p) => (p as Record<string, unknown>).type === 'progress',
    );
    expect(hasProgress).toBe(false);
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
        yield { type: 'tool_call_start', data: { tool_use_id: 'tu1', name: 'Bash' } } as StreamEvent;
        yield { type: 'tool_result', data: { tool_use_id: 'tu1', content: 'output' } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })(),
    );

    await relay.publish(
      'relay.agent.target',
      { text: 'Do work' },
      { from: 'relay.agent.src', replyTo: 'relay.inbox.dispatch.step-type-test' },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const progressEvents = receivedPayloads.filter(
      (p) => (p as Record<string, unknown>).type === 'progress',
    ) as Array<Record<string, unknown>>;

    const messageSteps = progressEvents.filter((p) => p.step_type === 'message');
    const toolSteps = progressEvents.filter((p) => p.step_type === 'tool_result');

    expect(messageSteps.length).toBeGreaterThan(0);
    expect(toolSteps.length).toBeGreaterThan(0);
  });
});
