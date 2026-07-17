/**
 * Integration: the A2A gateway driven through the REAL RelayCore.
 *
 * The sibling `a2a-gateway.integration.test.ts` proves the JSON-RPC / task-store
 * seam against a hand-rolled `FakeRelay` — but a fake on the other side of a
 * contract is exactly the "both sides mocked, CI green, shipped path broken"
 * failure the 2026-07 deep review found. This test replaces the fake with a real
 * `RelayCore` (real subscribe/publish, real access control, real maildir
 * pipeline) and a CCA-shaped adapter that streams the exact StreamEvent
 * envelopes the Claude Code adapter publishes back to the executor's reply
 * subject. It pins that the executor's publish → subscribe → settle path works
 * against the production relay, not just a stand-in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Task } from '@a2a-js/sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import { RelayCore } from '@dorkos/relay';
import type { RelayPublisher, AdapterRegistryLike, DeliveryResult } from '@dorkos/relay';
import type { RelayEnvelope, StandardPayload } from '@dorkos/shared/relay-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createA2aHandlers } from '../express-handlers.js';
import type { AgentRegistryLike } from '../types.js';

// ---------------------------------------------------------------------------
// CCA-shaped responder: a real RelayCore adapter that streams realistic
// StreamEvents to the inbound envelope's reply subject.
// ---------------------------------------------------------------------------

interface ResponderScript {
  /** Text chunks streamed as text_delta events. */
  chunks: string[];
  /** When set, an error event is streamed before the terminal done. */
  errorMessage?: string;
}

class CcaShapedResponder implements AdapterRegistryLike {
  private relay: RelayPublisher | null = null;

  constructor(private readonly script: ResponderScript) {}

  setRelay(relay: RelayPublisher): void {
    this.relay = relay;
  }

  async deliver(subject: string, envelope: RelayEnvelope): Promise<DeliveryResult | null> {
    if (!subject.startsWith('relay.agent.')) return null;
    const replyTo = envelope.replyTo;
    const relay = this.relay;
    if (replyTo && relay) {
      // Detached, like a real agent turn — the gateway's post-publish `working`
      // continuation runs before the reply stream lands.
      setTimeout(() => void this.stream(relay, replyTo, envelope), 0);
    }
    return { success: true };
  }

  async shutdown(): Promise<void> {
    /* nothing to tear down */
  }

  private async stream(
    relay: RelayPublisher,
    replyTo: string,
    envelope: RelayEnvelope
  ): Promise<void> {
    const correlationId = (envelope.payload as StandardPayload).correlationId;
    const wrap = (event: Record<string, unknown>) =>
      correlationId ? { ...event, correlationId } : event;
    const from = 'agent:cca-session-1';

    for (const chunk of this.script.chunks) {
      await relay.publish(replyTo, wrap({ type: 'text_delta', data: { text: chunk } }), { from });
    }
    if (this.script.errorMessage) {
      await relay.publish(
        replyTo,
        wrap({ type: 'error', data: { message: this.script.errorMessage } }),
        { from }
      );
    }
    await relay.publish(replyTo, wrap({ type: 'done', data: { sessionId: 'cca-session-1' } }), {
      from,
    });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(): AgentManifest {
  return {
    id: 'agent-backend',
    name: 'backend-bot',
    description: 'Backend engineering agent',
    runtime: 'claude-code',
    capabilities: ['code-review'],
    behavior: { responseMode: 'always' },
    namespace: 'default',
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'mesh',
    personaEnabled: true,
    enabledToolGroups: {},
  } as AgentManifest;
}

function makeRegistry(agents: AgentManifest[]): AgentRegistryLike {
  return {
    get: (id: string) => agents.find((a) => a.id === id),
    list: () => agents,
  };
}

function sendParams(text: string, agentId: string) {
  return {
    message: {
      kind: 'message',
      role: 'user',
      messageId: `user-msg-${++rpcId}`,
      parts: [{ kind: 'text', text }],
      metadata: { agentId },
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
let relay: RelayCore;
let server: Server;
let baseUrl: string;
let rpcId = 0;

async function buildHarness(script: ResponderScript): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-real-relay-'));
  tempDirs.push(dataDir);
  relay = new RelayCore({ dataDir, adapterRegistry: new CcaShapedResponder(script) });

  const db = createTestDb();
  const handlers = createA2aHandlers({
    agentRegistry: makeRegistry([makeManifest()]),
    relay,
    db,
    config: { baseUrl: 'http://127.0.0.1:0', version: '0.0.0-test', authRequired: false },
  });

  const app = express();
  app.use('/a2a', handlers.jsonRpc);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2A gateway through the real RelayCore', () => {
  it('accumulates streamed text and completes + persists the task', async () => {
    await buildHarness({ chunks: ['Hello ', 'from ', 'the agent.'] });

    const response = await rpc('message/send', sendParams('Say hello.', 'agent-backend'));
    expect(response.error).toBeUndefined();

    const task = response.result as Task;
    expect(task.kind).toBe('task');
    expect(task.status.state).toBe('completed');
    expect(task.status.message?.parts[0]).toEqual({
      kind: 'text',
      text: 'Hello from the agent.',
    });

    // Persisted through the real relay round-trip and retrievable via tasks/get.
    const getResponse = await rpc('tasks/get', { id: task.id, historyLength: 10 });
    const loaded = getResponse.result as Task;
    expect(loaded.status.state).toBe('completed');
    const historyTexts = (loaded.history ?? []).map((m) => {
      const part = m.parts[0];
      return part?.kind === 'text' ? `${m.role}:${part.text}` : `${m.role}:?`;
    });
    expect(historyTexts).toContain('user:Say hello.');
    expect(historyTexts).toContain('agent:Hello from the agent.');
    expect(loaded.metadata).toEqual(expect.objectContaining({ agentId: 'agent-backend' }));
  });

  it('propagates a streamed error as a failed task with the real message', async () => {
    await buildHarness({ chunks: ['partial '], errorMessage: 'SDK session crashed' });

    const response = await rpc('message/send', sendParams('Do work.', 'agent-backend'));
    expect(response.error).toBeUndefined();

    const task = response.result as Task;
    expect(task.status.state).toBe('failed');
    const part = task.status.message?.parts[0];
    expect(part?.kind).toBe('text');
    expect((part as { text: string }).text).toContain('SDK session crashed');

    const getResponse = await rpc('tasks/get', { id: task.id });
    expect((getResponse.result as Task).status.state).toBe('failed');
  });
});
