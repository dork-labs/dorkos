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
 *
 * **This suite speaks A2A v0.3 on the wire, deliberately.** The gateway
 * upgraded to protocol v1.0 but keeps accepting v0.3 requests through the
 * SDK's compat layer, and these are the tests that hold us to that: the
 * method names (`message/send`), the message shape (`kind`, `parts[].text`)
 * and the response shape (`'completed'`, not a protobuf enum ordinal) are all
 * the older spelling, and all of it still has to work. A v1.0-native pass over
 * the same stack lives in `a2a-v1-wire.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from '@dorkos/test-utils/db';
import type { RelayCore } from '@dorkos/relay';
import type {
  AgentCancelPayload,
  RelayEnvelope,
  StandardPayload,
} from '@dorkos/shared/relay-schemas';
import { AGENT_CANCEL_SUBJECT_PREFIX } from '@dorkos/shared/relay-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Logger } from '@dorkos/shared/logger';
import { createA2aHandlers } from '../express-handlers.js';
import type { AgentRegistryLike } from '../types.js';

// ---------------------------------------------------------------------------
// The A2A v0.3 wire shapes
//
// Not the SDK's exported types: those describe v1.0, and what comes back on
// this wire is the older spelling the compat layer answers in. Writing them
// out is the point — it is what pins the compatibility promise.
// ---------------------------------------------------------------------------

/** A v0.3 message part. */
interface LegacyPart {
  kind: string;
  text?: string;
}

/** A v0.3 message. */
interface LegacyMessage {
  kind: string;
  role: string;
  messageId: string;
  parts: LegacyPart[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/** A v0.3 task, as returned by `message/send` and `tasks/get`. */
interface LegacyTask {
  kind: string;
  id: string;
  contextId: string;
  status: { state: string; message?: LegacyMessage; timestamp?: string };
  history?: LegacyMessage[];
  artifacts?: unknown[];
  metadata?: Record<string, unknown>;
}

/** A v0.3 status-update event, as streamed over SSE by `message/stream`. */
interface LegacyStatusUpdate {
  kind: string;
  taskId: string;
  final: boolean;
  status: LegacyTask['status'];
}

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
  /**
   * Reply subjects of the turns this fake adapter is executing, standing in for
   * the CCA adapter's own in-flight turn registry — which is what makes a stop
   * request answerable with the truth.
   */
  readonly runningTurns = new Set<string>();
  /** Reply subjects of turns a stop request actually reached. */
  readonly stoppedTurns: string[] = [];
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
      if (envelope.replyTo) this.runningTurns.add(envelope.replyTo);
      // Deliver on a macrotask, like a real agent turn — the gateway's
      // post-publish continuation (the `working` status) must run first
      setTimeout(() => {
        void responder(envelope).finally(() => {
          if (envelope.replyTo) this.runningTurns.delete(envelope.replyTo);
        });
      }, 0);
      return { messageId: envelope.id, deliveredTo: 1 };
    }

    // The adapter's stop subscription: it takes the request only for a turn it
    // is actually executing, and refuses otherwise (deliveredTo 0), exactly as
    // `handleAgentCancel` does.
    if (subject.startsWith(AGENT_CANCEL_SUBJECT_PREFIX)) {
      const { replyTo } = payload as AgentCancelPayload;
      if (!this.runningTurns.has(replyTo)) {
        return { messageId: envelope.id, deliveredTo: 0 };
      }
      this.runningTurns.delete(replyTo);
      this.stoppedTurns.push(replyTo);
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
    namespace: 'default',
    registeredAt: '2026-01-01T00:00:00Z',
    registeredBy: 'mesh',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
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
/** The host-supplied logger, wired the way `routes/a2a.ts` wires the real one. */
let logger: Logger;

beforeEach(async () => {
  relay = new FakeRelay();
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const db = createTestDb();
  const handlers = createA2aHandlers({
    agentRegistry: makeRegistry([makeManifest()]),
    relay: relay as unknown as RelayCore,
    db,
    config: { baseUrl: 'http://127.0.0.1:0', version: '0.0.0-test', authRequired: false },
    logger,
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
    server = app.listen(0, '127.0.0.1', () => resolve());
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

/**
 * A v0.3 `message/send` param block.
 *
 * `blocking: true` is explicit because A2A v0.3 defines the flag's default as
 * `false` — the caller gets the task back as soon as it exists and polls from
 * there. The SDK we used to run blocked anyway when the flag was omitted,
 * which was more generous than its own spec; v1.0's compat layer honors the
 * spec instead. Tests that assert a settled task therefore have to ask to
 * wait, exactly as a real v0.3 client does. The default itself is pinned
 * separately, below.
 */
function sendParams(text: string, agentId?: string) {
  return {
    message: legacyMessage(text, agentId),
    configuration: { blocking: true },
  };
}

/** A v0.3 message body. */
function legacyMessage(text: string, agentId?: string) {
  return {
    kind: 'message',
    role: 'user',
    messageId: `user-msg-${++rpcId}`,
    parts: [{ kind: 'text', text }],
    ...(agentId ? { metadata: { agentId } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2A gateway integration (real jsonRpcHandler + DefaultRequestHandler + SqliteTaskStore)', () => {
  it('serves the fleet agent card at the spec well-known path', async () => {
    const response = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    expect(response.status).toBe(200);
    const card = (await response.json()) as {
      supportedInterfaces: Array<{ protocolVersion: string; protocolBinding: string }>;
    };
    // Both protocol versions are advertised, which is what tells a v0.3 client
    // it may keep talking to us in the older dialect.
    expect(card.supportedInterfaces.map((i) => i.protocolVersion)).toEqual(['1.0', '0.3']);
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
      const task = body.result as LegacyTask;
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
      const task = response.result as LegacyTask;
      expect(task.kind).toBe('task');
      expect(task.status.state).toBe('completed');
      const part = task.status.message?.parts[0];
      expect(part).toEqual({ kind: 'text', text: 'Hello from the agent.' });
    });

    it('persists the task so tasks/get returns state and history', async () => {
      relay.responder = streamingResponder(relay, ['Done.']);

      const sendResponse = await rpc('message/send', sendParams('Do a thing.', 'agent-backend'));
      const task = sendResponse.result as LegacyTask;

      const getResponse = await rpc('tasks/get', { id: task.id, historyLength: 10 });
      expect(getResponse.error).toBeUndefined();
      const loaded = getResponse.result as LegacyTask;
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
      const task = response.result as LegacyTask;
      expect(task.kind).toBe('task');
      expect(task.status.state).toBe('failed');
      const part = task.status.message?.parts[0];
      expect(part?.kind).toBe('text');
      expect((part as { text: string }).text).toContain("Agent 'no-such-agent' not found");

      // The failure itself is persisted and retrievable
      const getResponse = await rpc('tasks/get', { id: task.id });
      expect((getResponse.result as LegacyTask).status.state).toBe('failed');
    });

    it('returns a failed task with a delivery diagnostic when no responder is subscribed', async () => {
      relay.responder = undefined;

      const response = await rpc('message/send', sendParams('Hi.', 'agent-backend'));

      expect(response.error).toBeUndefined();
      const task = response.result as LegacyTask;
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

      const task = response.result as LegacyTask;
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
      const task = sendResponse.result as LegacyTask;
      expect(['submitted', 'working']).toContain(task.status.state);

      const cancelResponse = await rpc('tasks/cancel', { id: task.id });
      expect(cancelResponse.jsonrpc).toBe('2.0');
      expect(cancelResponse.error).toBeUndefined();
      const canceled = cancelResponse.result as LegacyTask;
      expect(canceled.kind).toBe('task');
      expect(canceled.id).toBe(task.id);
      expect(canceled.status.state).toBe('canceled');

      // The turn was actually asked to stop — the whole point. A canceled task
      // whose agent keeps working is the bug this asserts against (DOR-791).
      expect(relay.stoppedTurns).toHaveLength(1);

      const getResponse = await rpc('tasks/get', { id: task.id });
      expect((getResponse.result as LegacyTask).status.state).toBe('canceled');

      // Release the held turn: its late stream must not resurrect the task
      gate.release();
      await gate.finished;
      const afterRelease = await rpc('tasks/get', { id: task.id });
      expect((afterRelease.result as LegacyTask).status.state).toBe('canceled');
    });

    it('refuses tasks/cancel — and leaves the task running — when no runner takes the stop', async () => {
      const gate = gatedResponder(streamingResponder(relay, ['Still working.']));
      relay.responder = gate.responder;

      const sendResponse = await rpc('message/send', {
        ...sendParams('Long-running job.', 'agent-backend'),
        configuration: { blocking: false },
      });
      const task = sendResponse.result as LegacyTask;

      // Whoever was executing this turn is gone — an adapter restart, say. The
      // stop reaches nobody.
      relay.runningTurns.clear();

      const cancelResponse = await rpc('tasks/cancel', { id: task.id });

      // Not "canceled". The model is still running and the caller is told so,
      // rather than being handed a comfortable lie it cannot act on.
      expect(cancelResponse.error).toBeDefined();
      expect((cancelResponse.error as { message: string }).message).toContain('not cancelable');
      // The host's logger is the only place this outcome is legible, so the
      // wiring from createA2aHandlers down to the executor has to be real.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('may still be running'));
      const getResponse = await rpc('tasks/get', { id: task.id });
      expect(['submitted', 'working']).toContain((getResponse.result as LegacyTask).status.state);

      // And the turn it could not stop still finishes normally.
      gate.release();
      await gate.finished;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const afterRelease = await rpc('tasks/get', { id: task.id });
      expect((afterRelease.result as LegacyTask).status.state).toBe('completed');
    });

    it('accepts a follow-up turn on a non-terminal task, accumulating history with sticky routing', async () => {
      // Turn 1: held in-flight so the task stays non-terminal
      const gate = gatedResponder(streamingResponder(relay, ['First answer.']));
      relay.responder = gate.responder;
      const turn1Response = await rpc('message/send', {
        ...sendParams('First question.', 'agent-backend'),
        configuration: { blocking: false },
      });
      const task = turn1Response.result as LegacyTask;
      expect(['submitted', 'working']).toContain(task.status.state);

      // Turn 2: carries the taskId but NO metadata.agentId — routing must
      // stay sticky via the persisted task.metadata.agentId
      relay.responder = streamingResponder(relay, ['Second answer.']);
      const turn2Response = await rpc('message/send', {
        message: { ...legacyMessage('Second question.'), taskId: task.id },
        configuration: { blocking: true },
      });

      expect(turn2Response.error).toBeUndefined();
      const completed = turn2Response.result as LegacyTask;
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
      const loaded = getResponse.result as LegacyTask;
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
      expect((afterRelease.result as LegacyTask).status.state).toBe('completed');
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
      expect((events[0] as unknown as LegacyTask).status.state).toBe('submitted');

      const statusUpdates = events.filter(
        (e) => e.kind === 'status-update'
      ) as unknown as LegacyStatusUpdate[];
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
