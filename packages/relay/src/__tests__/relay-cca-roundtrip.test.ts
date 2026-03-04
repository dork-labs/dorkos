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
});
