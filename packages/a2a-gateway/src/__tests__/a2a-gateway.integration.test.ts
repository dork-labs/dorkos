/**
 * Integration tests driving the REAL A2A protocol stack:
 * Express -> jsonRpcHandler -> DefaultRequestHandler -> SqliteTaskStore ->
 * DorkOSAgentExecutor, with a fake Relay whose subscribed responder streams
 * the exact StreamEvent envelope shapes the Claude Code adapter publishes
 * (see packages/relay/src/adapters/claude-code/agent-handler.ts).
 *
 * These are the tests that would have caught F1 (no initial Task event ->
 * nothing ever persisted) and F2 (reply payload contract mismatch -> tasks
 * "completed" with undefined text on the first delta).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Task } from '@a2a-js/sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import type { RelayCore } from '@dorkos/relay';
import type { RelayEnvelope, StandardPayload } from '@dorkos/shared/relay-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createA2aHandlers } from '../express-handlers.js';
import type { AgentRegistryLike } from '../types.js';

// ---------------------------------------------------------------------------
// Fake Relay — real subscribe/publish delivery, no mesh required
// ---------------------------------------------------------------------------

type Responder = (envelope: RelayEnvelope) => Promise<void>;

/**
 * Minimal in-memory Relay: exact-subject subscriptions plus a configurable
 * responder standing in for the Claude Code adapter on `relay.agent.*`.
 */
class FakeRelay {
  private readonly subscriptions = new Map<string, Set<(envelope: RelayEnvelope) => void>>();
  /** Simulates the agent adapter subscribed to relay.agent.* subjects. */
  responder: Responder | undefined;
  /** Every relay.agent.* subject published to, in order — for routing asserts. */
  readonly agentSubjects: string[] = [];
  private idCounter = 0;

  subscribe(pattern: string, handler: (envelope: RelayEnvelope) => void): () => void {
    const handlers = this.subscriptions.get(pattern) ?? new Set();
    handlers.add(handler);
    this.subscriptions.set(pattern, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  async publish(
    subject: string,
    payload: unknown,
    options: { from: string; replyTo?: string }
  ): Promise<{ messageId: string; deliveredTo: number }> {
    const envelope: RelayEnvelope = {
      id: `env-${++this.idCounter}`,
      subject,
      from: options.from,
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() + 60_000,
        callBudgetRemaining: 10,
      },
      createdAt: new Date().toISOString(),
      payload,
    };

    if (subject.startsWith('relay.agent.')) {
      this.agentSubjects.push(subject);
      if (!this.responder) {
        return { messageId: envelope.id, deliveredTo: 0 };
      }
      const responder = this.responder;
      // Deliver on a macrotask, like a real agent turn — the gateway's
      // post-publish continuation (the `working` status) must run first
      setTimeout(() => void responder(envelope), 0);
      return { messageId: envelope.id, deliveredTo: 1 };
    }

    const handlers = this.subscriptions.get(subject) ?? new Set();
    for (const handler of handlers) handler(envelope);
    return { messageId: envelope.id, deliveredTo: handlers.size };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'agent-backend',
    name: 'backend-bot',
    description: 'Backend engineering agent',
    runtime: 'claude-code',
    capabilities: ['code-review'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    namespace: 'default',
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'mesh',
    personaEnabled: true,
    enabledToolGroups: {},
    ...overrides,
  } as AgentManifest;
}

function makeRegistry(agents: AgentManifest[]): AgentRegistryLike {
  return {
    get: (id: string) => agents.find((a) => a.id === id),
    list: () => agents,
  };
}

/**
 * Build a responder that streams the given text as multiple StreamEvent
 * envelopes — the exact shapes publishResponseWithCorrelation produces —
 * followed by the terminal done event.
 */
function streamingResponder(relay: FakeRelay, chunks: string[]): Responder {
  return async (envelope) => {
    if (!envelope.replyTo) return;
    const correlationId = (envelope.payload as StandardPayload).correlationId;
    const wrap = (event: Record<string, unknown>) =>
      correlationId ? { ...event, correlationId } : event;

    for (const chunk of chunks) {
      await relay.publish(envelope.replyTo, wrap({ type: 'text_delta', data: { text: chunk } }), {
        from: 'agent:cca-session-1',
      });
    }
    await relay.publish(
      envelope.replyTo,
      wrap({
        type: 'tool_call_start',
        data: { id: 'tool-1', name: 'Bash', input: { command: 'true' } },
      }),
      { from: 'agent:cca-session-1' }
    );
    await relay.publish(
      envelope.replyTo,
      wrap({ type: 'done', data: { sessionId: 'cca-session-1' } }),
      { from: 'agent:cca-session-1' }
    );
  };
}

/**
 * Wrap a responder behind a manual gate so a turn can be held in-flight
 * (non-terminal task) while the test cancels it or sends a follow-up turn.
 * `finished` resolves once the inner responder has fully streamed, so tests
 * can deterministically wait for the held execution to settle after release.
 */
function gatedResponder(inner: Responder): {
  responder: Responder;
  release: () => void;
  finished: Promise<void>;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  return {
    responder: async (envelope) => {
      await gate;
      await inner(envelope);
      markFinished();
    },
    release,
    finished,
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let relay: FakeRelay;
let server: Server;
let baseUrl: string;
let rpcId = 0;

beforeEach(async () => {
  relay = new FakeRelay();
  const db = createTestDb();
  const handlers = createA2aHandlers({
    agentRegistry: makeRegistry([makeManifest()]),
    relay: relay as unknown as RelayCore,
    db,
    config: { baseUrl: 'http://127.0.0.1:0', version: '0.0.0-test', authRequired: false },
  });

  const app = express();
  app.get('/.well-known/agent-card.json', handlers.fleetCard);
  // Per-agent JSON-RPC endpoint: mounted (before the fleet use() below, which
  // prefix-matches every path under /a2a) at the nested path so the handler
  // binds the agent from the URL, mirroring createA2aRouter's POST /agents/:id.
  app.post('/a2a/agents/:id', handlers.agentJsonRpc);
  // The jsonRpc handler is an Express router with an internal POST '/'
  // route — mount it with use() so the path prefix is stripped, mirroring
  // how apps/server mounts createA2aRouter under '/a2a'.
  app.use('/a2a', handlers.jsonRpc);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  return (await rpcAt('/a2a', method, params)).body;
}

async function rpcAt(
  path: string,
  method: string,
  params: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function sendParams(text: string, agentId?: string) {
  return {
    message: {
      kind: 'message',
      role: 'user',
      messageId: `user-msg-${++rpcId}`,
      parts: [{ kind: 'text', text }],
      ...(agentId ? { metadata: { agentId } } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2A gateway integration (real jsonRpcHandler + DefaultRequestHandler + SqliteTaskStore)', () => {
  it('serves the fleet agent card at the spec well-known path', async () => {
    const response = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(response.status).toBe(200);
    const card = (await response.json()) as Record<string, unknown>;
    expect(card.protocolVersion).toBeDefined();
  });

  describe('deterministic routing (F5)', () => {
    it('rejects a fleet message with no metadata.agentId with a helpful JSON-RPC error', async () => {
      const { status, body } = await rpcAt('/a2a', 'message/send', sendParams('Hi.'));

      expect(status).toBe(400);
      expect(body.error).toBeDefined();
      expect((body.error as { code: number }).code).toBe(-32602);
      expect((body.error as { message: string }).message).toContain('metadata.agentId');
    });

    it('per-agent endpoint binds the agent from the URL without metadata.agentId', async () => {
      relay.responder = streamingResponder(relay, ['Bound.']);

      const { body } = await rpcAt('/a2a/agents/agent-backend', 'message/send', sendParams('Hi.'));

      expect(body.error).toBeUndefined();
      const task = body.result as Task;
      expect(task.status.state).toBe('completed');
      expect(task.metadata).toEqual(expect.objectContaining({ agentId: 'agent-backend' }));
      expect(relay.agentSubjects).toEqual(['relay.agent.default.agent-backend']);
    });

    it('per-agent endpoint 404s an unknown agent', async () => {
      const { status, body } = await rpcAt(
        '/a2a/agents/no-such-agent',
        'message/send',
        sendParams('Hi.')
      );

      expect(status).toBe(404);
      expect((body.error as { message: string }).message).toContain('not found');
    });
  });

  describe('message/send', () => {
    it('completes the task with the full accumulated response text', async () => {
      relay.responder = streamingResponder(relay, ['Hello ', 'from ', 'the agent.']);

      const response = await rpc('message/send', sendParams('Say hello.', 'agent-backend'));

      expect(response.error).toBeUndefined();
      const task = response.result as Task;
      expect(task.kind).toBe('task');
      expect(task.status.state).toBe('completed');
      const part = task.status.message?.parts[0];
      expect(part).toEqual({ kind: 'text', text: 'Hello from the agent.' });
    });

    it('persists the task so tasks/get returns state and history', async () => {
      relay.responder = streamingResponder(relay, ['Done.']);

      const sendResponse = await rpc('message/send', sendParams('Do a thing.', 'agent-backend'));
      const task = sendResponse.result as Task;

      const getResponse = await rpc('tasks/get', { id: task.id, historyLength: 10 });
      expect(getResponse.error).toBeUndefined();
      const loaded = getResponse.result as Task;
      expect(loaded.id).toBe(task.id);
      expect(loaded.status.state).toBe('completed');

      // History contains the user message and the agent's final response
      const historyTexts = (loaded.history ?? []).map((message) => {
        const part = message.parts[0];
        return part?.kind === 'text' ? `${message.role}:${part.text}` : `${message.role}:?`;
      });
      expect(historyTexts).toContain('user:Do a thing.');
      expect(historyTexts).toContain('agent:Done.');
      expect(loaded.metadata).toEqual(expect.objectContaining({ agentId: 'agent-backend' }));
    });

    it('returns a failed task with a useful diagnostic for an unknown agent (not -32603)', async () => {
      const response = await rpc('message/send', sendParams('Hi.', 'no-such-agent'));

      expect(response.error).toBeUndefined();
      const task = response.result as Task;
      expect(task.kind).toBe('task');
      expect(task.status.state).toBe('failed');
      const part = task.status.message?.parts[0];
      expect(part?.kind).toBe('text');
      expect((part as { text: string }).text).toContain("Agent 'no-such-agent' not found");

      // The failure itself is persisted and retrievable
      const getResponse = await rpc('tasks/get', { id: task.id });
      expect((getResponse.result as Task).status.state).toBe('failed');
    });

    it('returns a failed task with a delivery diagnostic when no responder is subscribed', async () => {
      relay.responder = undefined;

      const response = await rpc('message/send', sendParams('Hi.', 'agent-backend'));

      expect(response.error).toBeUndefined();
      const task = response.result as Task;
      expect(task.status.state).toBe('failed');
      const part = task.status.message?.parts[0];
      expect((part as { text: string }).text).toContain('no subscribers');
    });

    it('surfaces stream errors as a failed task with the real error message', async () => {
      relay.responder = async (envelope) => {
        if (!envelope.replyTo) return;
        await relay.publish(
          envelope.replyTo,
          { type: 'error', data: { message: 'SDK session crashed' } },
          { from: 'agent:cca-session-1' }
        );
        await relay.publish(
          envelope.replyTo,
          { type: 'done', data: { sessionId: 'cca-session-1' } },
          { from: 'agent:cca-session-1' }
        );
      };

      const response = await rpc('message/send', sendParams('Hi.', 'agent-backend'));

      const task = response.result as Task;
      expect(task.status.state).toBe('failed');
      const part = task.status.message?.parts[0];
      expect((part as { text: string }).text).toContain('SDK session crashed');
    });
  });

  describe('task lifecycle', () => {
    it('cancels an in-flight task via tasks/cancel and persists the canceled state', async () => {
      // Hold the agent turn open so the task stays non-terminal
      const gate = gatedResponder(streamingResponder(relay, ['Too late.']));
      relay.responder = gate.responder;

      const sendResponse = await rpc('message/send', {
        ...sendParams('Long-running job.', 'agent-backend'),
        configuration: { blocking: false },
      });
      expect(sendResponse.error).toBeUndefined();
      const task = sendResponse.result as Task;
      expect(['submitted', 'working']).toContain(task.status.state);

      const cancelResponse = await rpc('tasks/cancel', { id: task.id });
      expect(cancelResponse.jsonrpc).toBe('2.0');
      expect(cancelResponse.error).toBeUndefined();
      const canceled = cancelResponse.result as Task;
      expect(canceled.kind).toBe('task');
      expect(canceled.id).toBe(task.id);
      expect(canceled.status.state).toBe('canceled');

      const getResponse = await rpc('tasks/get', { id: task.id });
      expect((getResponse.result as Task).status.state).toBe('canceled');

      // Release the held turn: its late stream must not resurrect the task
      gate.release();
      await gate.finished;
      const afterRelease = await rpc('tasks/get', { id: task.id });
      expect((afterRelease.result as Task).status.state).toBe('canceled');
    });

    it('accepts a follow-up turn on a non-terminal task, accumulating history with sticky routing', async () => {
      // Turn 1: held in-flight so the task stays non-terminal
      const gate = gatedResponder(streamingResponder(relay, ['First answer.']));
      relay.responder = gate.responder;
      const turn1Response = await rpc('message/send', {
        ...sendParams('First question.', 'agent-backend'),
        configuration: { blocking: false },
      });
      const task = turn1Response.result as Task;
      expect(['submitted', 'working']).toContain(task.status.state);

      // Turn 2: carries the taskId but NO metadata.agentId — routing must
      // stay sticky via the persisted task.metadata.agentId
      relay.responder = streamingResponder(relay, ['Second answer.']);
      const turn2Response = await rpc('message/send', {
        message: {
          kind: 'message',
          role: 'user',
          messageId: `user-msg-${++rpcId}`,
          taskId: task.id,
          parts: [{ kind: 'text', text: 'Second question.' }],
        },
      });

      expect(turn2Response.error).toBeUndefined();
      const completed = turn2Response.result as Task;
      expect(completed.id).toBe(task.id);
      expect(completed.status.state).toBe('completed');
      expect(completed.status.message?.parts[0]).toEqual({
        kind: 'text',
        text: 'Second answer.',
      });

      // Both turns routed to the same agent subject
      expect(relay.agentSubjects).toEqual([
        'relay.agent.default.agent-backend',
        'relay.agent.default.agent-backend',
      ]);

      // History accumulated both user turns plus the follow-up answer
      const getResponse = await rpc('tasks/get', { id: task.id, historyLength: 10 });
      const loaded = getResponse.result as Task;
      const historyTexts = (loaded.history ?? []).map((message) => {
        const part = message.parts[0];
        return part?.kind === 'text' ? `${message.role}:${part.text}` : `${message.role}:?`;
      });
      expect(historyTexts).toContain('user:First question.');
      expect(historyTexts).toContain('user:Second question.');
      expect(historyTexts).toContain('agent:Second answer.');

      // Release turn 1 so its execution settles on its own private reply
      // subject (the per-execution nonce keeps its stream out of turn 2)
      gate.release();
      await gate.finished;
      const afterRelease = await rpc('tasks/get', { id: task.id });
      expect((afterRelease.result as Task).status.state).toBe('completed');
    });
  });

  describe('message/stream', () => {
    it('streams task -> working -> completed with the full text over SSE', async () => {
      relay.responder = streamingResponder(relay, ['Streamed ', 'answer.']);

      const response = await fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++rpcId,
          method: 'message/stream',
          params: sendParams('Stream it.', 'agent-backend'),
        }),
      });

      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const body = await response.text();
      const events = body
        .split('\n\n')
        .filter((block) => block.startsWith('data: '))
        .map(
          (block) =>
            (JSON.parse(block.slice('data: '.length)) as { result: Record<string, unknown> }).result
        );

      // First event: the persisted Task in submitted state
      expect(events[0]!.kind).toBe('task');
      expect((events[0] as unknown as Task).status.state).toBe('submitted');

      const statusUpdates = events.filter((e) => e.kind === 'status-update') as Array<{
        status: Task['status'];
        final: boolean;
      }>;
      expect(statusUpdates.some((e) => e.status.state === 'working')).toBe(true);

      const finalEvent = statusUpdates.at(-1)!;
      expect(finalEvent.final).toBe(true);
      expect(finalEvent.status.state).toBe('completed');
      expect(finalEvent.status.message?.parts[0]).toEqual({
        kind: 'text',
        text: 'Streamed answer.',
      });
    });
  });
});
