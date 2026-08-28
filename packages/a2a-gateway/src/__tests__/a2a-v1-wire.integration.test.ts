/**
 * Integration: the gateway driven over the A2A **v1.0** wire.
 *
 * The sibling `a2a-gateway.integration.test.ts` drives the same stack in the
 * v0.3 dialect and proves we did not break the agents that still speak it.
 * This one proves the other half — that the dialect we upgraded to actually
 * works — because "the v0.3 tests still pass" would also be true of a gateway
 * that never learned v1.0 at all.
 *
 * The differences it pins are the ones a real v1.0 peer will hit: PascalCase
 * method names (`SendMessage`, not `message/send`), flat parts (`{ text }`,
 * not `{ kind: 'text', text }`), named enum values (`ROLE_USER`,
 * `TASK_STATE_COMPLETED`), and `returnImmediately` in place of `blocking`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
} from '@a2a-js/sdk/client';
import { Role, TaskState, type Task } from '@a2a-js/sdk';
import type { RelayCore } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createA2aHandlers } from '../express-handlers.js';
import { textPart } from '../a2a-model.js';
import type { AgentRegistryLike } from '../types.js';

// ---------------------------------------------------------------------------
// The A2A v1.0 wire shapes, as JSON
// ---------------------------------------------------------------------------

/** A v1.0 message part: the content key IS the discriminator. */
interface V1Part {
  text?: string;
  url?: string;
  data?: unknown;
}

/** A v1.0 message. */
interface V1Message {
  messageId: string;
  role: string;
  parts: V1Part[];
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A v1.0 `SendMessage` result.
 *
 * v1.0 wraps the result in a oneof rather than returning the Task or Message
 * bare the way v0.3 did — the key names which of the two came back.
 */
interface V1SendResult {
  task?: V1Task;
  message?: V1Message;
}

/** A v1.0 task. */
interface V1Task {
  id: string;
  contextId: string;
  status: { state: string; message?: V1Message; timestamp?: string };
  history?: V1Message[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// A minimal relay that streams a scripted reply back to the executor
// ---------------------------------------------------------------------------

/** Streams `chunks` as text_delta events, then a terminal done. */
class ScriptedRelay {
  private readonly subscriptions = new Map<string, Set<(envelope: RelayEnvelope) => void>>();
  private idCounter = 0;
  /** Text chunks the fake agent streams back. Empty means nothing responds. */
  chunks: string[] = [];
  /** Whether any agent is subscribed at all. */
  hasResponder = true;

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
    const id = `env-${++this.idCounter}`;

    if (subject.startsWith('relay.agent.')) {
      if (!this.hasResponder) return { messageId: id, deliveredTo: 0 };
      const replyTo = options.replyTo;
      if (replyTo) {
        // Reply on a macrotask, like a real turn: the gateway's post-publish
        // `working` status has to land first.
        setTimeout(() => {
          for (const chunk of this.chunks) {
            this.deliver(replyTo, { type: 'text_delta', data: { text: chunk } });
          }
          this.deliver(replyTo, { type: 'done', data: { sessionId: 's-1' } });
        }, 0);
      }
      return { messageId: id, deliveredTo: 1 };
    }

    const handlers = this.subscriptions.get(subject) ?? new Set();
    for (const handler of handlers) handler(this.envelope(id, subject, payload));
    return { messageId: id, deliveredTo: handlers.size };
  }

  private deliver(subject: string, payload: unknown): void {
    const handlers = this.subscriptions.get(subject) ?? new Set();
    for (const handler of handlers)
      handler(this.envelope(`env-${++this.idCounter}`, subject, payload));
  }

  private envelope(id: string, subject: string, payload: unknown): RelayEnvelope {
    return {
      id,
      subject,
      from: 'agent:s-1',
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
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeManifest(id = 'agent-backend'): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id,
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
  } as AgentManifest;
}

function makeRegistry(agents: AgentManifest[]): AgentRegistryLike {
  return {
    get: (id: string) => agents.find((a) => a.id === id),
    list: () => agents,
  };
}

let server: Server;
let baseUrl: string;
let relay: ScriptedRelay;
let rpcId = 0;

beforeEach(async () => {
  relay = new ScriptedRelay();

  // Listen BEFORE mounting, so the cards can advertise the real port. A card's
  // interface URL is what a real client dials, so it has to be absolute and
  // correct — and Express happily accepts routes added after `listen`, which
  // avoids binding a port twice and racing another process for it.
  const app = express();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const handlers = createA2aHandlers({
    agentRegistry: makeRegistry([makeManifest()]),
    relay: relay as unknown as RelayCore,
    db: createTestDb(),
    config: { baseUrl, version: '0.0.0-test', authRequired: false },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });

  app.get('/.well-known/agent-card.json', handlers.fleetCard);
  app.get('/a2a/agents/:id/card', handlers.agentCard);
  app.post('/a2a/agents/:id', handlers.agentJsonRpc);
  app.use('/a2a', handlers.jsonRpc);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** A v1.0 `SendMessage` param block. */
function sendParams(text: string, agentId?: string) {
  return {
    message: {
      messageId: `user-msg-${++rpcId}`,
      role: 'ROLE_USER',
      // Flat: the content key is the discriminator, and there is no `kind`.
      parts: [{ text }],
      ...(agentId ? { metadata: { agentId } } : {}),
    },
    // v1.0's inverted spelling of v0.3's `blocking`. Absent means "wait",
    // which is the opposite of what absent meant in v0.3.
    configuration: { returnImmediately: false },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2A gateway over the v1.0 wire', () => {
  it('advertises a v1.0 JSON-RPC interface on the fleet card', async () => {
    const response = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    const card = (await response.json()) as {
      supportedInterfaces: Array<{ protocolVersion: string; protocolBinding: string }>;
    };

    expect(card.supportedInterfaces).toContainEqual(
      expect.objectContaining({ protocolVersion: '1.0', protocolBinding: 'JSONRPC' })
    );
  });

  it('completes a SendMessage turn with the accumulated text', async () => {
    relay.chunks = ['Hello ', 'from ', 'v1.'];

    const response = await rpc('SendMessage', sendParams('Say hello.', 'agent-backend'));

    expect(response.error).toBeUndefined();
    const task = (response.result as V1SendResult).task!;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    // Flat part, agent role spelled as the named enum value. `mediaType` is a
    // v1.0 addition — it sits on every part now, not just file ones.
    expect(task.status.message?.parts[0]).toEqual({
      text: 'Hello from v1.',
      mediaType: 'text/plain',
    });
    expect(task.status.message?.role).toBe('ROLE_AGENT');
    expect(task.metadata).toEqual(expect.objectContaining({ agentId: 'agent-backend' }));
  });

  it('persists the turn so GetTask returns its state and history', async () => {
    relay.chunks = ['Done.'];

    const sent = await rpc('SendMessage', sendParams('Do a thing.', 'agent-backend'));
    const task = (sent.result as V1SendResult).task!;

    const fetched = await rpc('GetTask', { id: task.id, historyLength: 10 });
    expect(fetched.error).toBeUndefined();
    const loaded = fetched.result as V1Task;
    expect(loaded.id).toBe(task.id);
    expect(loaded.status.state).toBe('TASK_STATE_COMPLETED');

    const historyTexts = (loaded.history ?? []).map((m) => `${m.role}:${m.parts[0]?.text ?? '?'}`);
    expect(historyTexts).toContain('ROLE_USER:Do a thing.');
    expect(historyTexts).toContain('ROLE_AGENT:Done.');
  });

  it('routes a per-agent endpoint without metadata.agentId', async () => {
    relay.chunks = ['Bound.'];

    const response = await fetch(`${baseUrl}/a2a/agents/agent-backend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'SendMessage',
        params: sendParams('Hi.'),
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.error).toBeUndefined();
    expect((body.result as V1SendResult).task!.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('rejects an untargeted fleet message with an actionable error', async () => {
    const response = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'SendMessage',
        params: sendParams('Hi.'),
      }),
    });

    // The routing guard has to recognize the v1.0 method name too — it reads
    // the body before the SDK dispatches, so a name it does not know would let
    // an untargeted message straight through.
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain('metadata.agentId');
  });

  it('fails the task with a delivery diagnostic when nothing is subscribed', async () => {
    relay.hasResponder = false;

    const response = await rpc('SendMessage', sendParams('Hi.', 'agent-backend'));

    const task = (response.result as V1SendResult).task!;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(task.status.message?.parts[0]?.text).toContain('no subscribers');
  });

  it("is discoverable and drivable by the SDK's own v1.0 client", async () => {
    // Everything above drives the wire by hand, which pins the format but
    // cannot catch a card a real client refuses to build a transport from.
    // This one hands the whole job to the SDK: it fetches the card, picks a
    // transport off `supportedInterfaces`, and speaks v1.0 to us.
    relay.chunks = ['Hello ', 'real client.'];

    const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
    const client = await factory.createFromUrl(`${baseUrl}/a2a/agents/agent-backend/card`, '');

    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: crypto.randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [textPart('Run the tests.')],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    });

    const task = result as Task;
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task.status?.message?.parts[0]?.content).toEqual({
      $case: 'text',
      value: 'Hello real client.',
    });
  });
});

// ---------------------------------------------------------------------------
// ListTasks, on a fleet of two
// ---------------------------------------------------------------------------

/**
 * `ListTasks` answers a different question at each endpoint.
 *
 * On `/a2a` it is a fleet-wide survey. On `/a2a/agents/:id` the agent is bound
 * from the URL — everything else on that endpoint is about that one agent, and
 * a listing that ignored the binding would hand a caller who asked about one
 * agent every other agent's tasks, full message history included.
 */
describe('ListTasks scoping', () => {
  let scopedServer: Server;
  let scopedUrl: string;

  /** A `ListTasks` response, as JSON. */
  interface V1ListTasks {
    tasks: V1Task[];
    totalSize: number;
  }

  async function postTo(
    path: string,
    method: string,
    params: unknown
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${scopedUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  /** List tasks at `path`, failing loudly rather than asserting on an error body. */
  async function listTasksAt(path: string): Promise<V1ListTasks> {
    const body = await postTo(path, 'ListTasks', { tenant: '', contextId: '', pageToken: '' });
    expect(body.error).toBeUndefined();
    return body.result as unknown as V1ListTasks;
  }

  beforeEach(async () => {
    const scopedRelay = new ScriptedRelay();
    scopedRelay.chunks = ['Done.'];

    const app = express();
    await new Promise<void>((resolve) => {
      scopedServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    scopedUrl = `http://127.0.0.1:${(scopedServer.address() as AddressInfo).port}`;

    const handlers = createA2aHandlers({
      agentRegistry: makeRegistry([makeManifest('agent-backend'), makeManifest('agent-frontend')]),
      relay: scopedRelay as unknown as RelayCore,
      db: createTestDb(),
      config: { baseUrl: scopedUrl, version: '0.0.0-test', authRequired: false },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    app.post('/a2a/agents/:id', handlers.agentJsonRpc);
    app.use('/a2a', handlers.jsonRpc);

    // One finished task per agent, each on its own endpoint.
    for (const agentId of ['agent-backend', 'agent-frontend']) {
      const sent = await postTo(`/a2a/agents/${agentId}`, 'SendMessage', sendParams('Do a thing.'));
      expect(sent.error).toBeUndefined();
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      scopedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('returns only the bound agent’s tasks on the per-agent endpoint', async () => {
    const listed = await listTasksAt('/a2a/agents/agent-backend');

    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]!.metadata).toEqual(
      expect.objectContaining({ agentId: 'agent-backend' })
    );
    // The count is scoped too — a total that counted the whole fleet would
    // page a caller through tasks it is never shown.
    expect(listed.totalSize).toBe(1);
  });

  it('scopes to whichever agent the URL names', async () => {
    const listed = await listTasksAt('/a2a/agents/agent-frontend');

    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]!.metadata).toEqual(
      expect.objectContaining({ agentId: 'agent-frontend' })
    );
  });

  it('returns every agent’s tasks on the fleet endpoint', async () => {
    const listed = await listTasksAt('/a2a');

    expect(listed.totalSize).toBe(2);
    expect(listed.tasks.map((t) => t.metadata?.agentId).sort()).toEqual([
      'agent-backend',
      'agent-frontend',
    ]);
  });

  it('refuses to fetch another agent’s task from a per-agent endpoint', async () => {
    // The endpoint's promise is one agent, and `GetTask` has to keep it too —
    // a listing scoped to one agent while a lookup hands over any task by id
    // is not a boundary, it is a speed bump.
    const fleetList = await listTasksAt('/a2a');
    const frontendTask = fleetList.tasks.find((t) => t.metadata?.agentId === 'agent-frontend')!;

    const wrongEndpoint = await postTo('/a2a/agents/agent-backend', 'GetTask', {
      id: frontendTask.id,
    });
    expect(wrongEndpoint.error).toBeDefined();
    expect((wrongEndpoint.error as { message: string }).message).toMatch(/not found/i);

    // Its own endpoint still answers, and so does the fleet endpoint — the
    // scoping must not have simply broken lookups.
    const ownEndpoint = await postTo('/a2a/agents/agent-frontend', 'GetTask', {
      id: frontendTask.id,
    });
    expect(ownEndpoint.error).toBeUndefined();
    expect((ownEndpoint.result as V1Task).id).toBe(frontendTask.id);

    const fleetEndpoint = await postTo('/a2a', 'GetTask', { id: frontendTask.id });
    expect(fleetEndpoint.error).toBeUndefined();
  });

  it('overrules a bound-agent header that disagrees with the URL', async () => {
    // The other half of the header's safety: the fleet endpoint deletes it
    // (below), and the per-agent endpoint OVERWRITES it. Without the
    // overwrite, a caller could stand on one agent's endpoint and read
    // another's tasks by naming it in the header.
    const response = await fetch(`${scopedUrl}/a2a/agents/agent-backend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dorkos-a2a-agent': 'agent-frontend' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'ListTasks',
        params: { tenant: '', contextId: '', pageToken: '' },
      }),
    });
    const listed = (await response.json()).result as V1ListTasks;

    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]!.metadata).toEqual(
      expect.objectContaining({ agentId: 'agent-backend' })
    );
  });

  it('ignores a bound-agent header a client sends itself', async () => {
    // The binding travels on a header the handlers set, so the fleet endpoint
    // has to strip whatever the caller sent — otherwise a scoping mechanism
    // becomes a way to ask the fleet endpoint questions in someone's name.
    const response = await fetch(`${scopedUrl}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dorkos-a2a-agent': 'agent-backend' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'ListTasks',
        params: { tenant: '', contextId: '', pageToken: '' },
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect((body.result as unknown as V1ListTasks).totalSize).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The documented client, against a token-gated deployment
// ---------------------------------------------------------------------------

/**
 * With login on, DorkOS gates card reads as well as calls. That splits the
 * client's fetch in two: the transport sends messages, but the card is
 * downloaded by a separate resolver that falls back to the global `fetch`.
 * The guide's snippet has to authenticate both, and these two tests are what
 * hold it to that — the first fails exactly the way a reader's copy-paste
 * would if the snippet only authenticated the transport.
 */
describe('a token-gated deployment', () => {
  const TOKEN = 'test-token';
  let guardedServer: Server;
  let guardedUrl: string;
  let guardedRelay: ScriptedRelay;

  /** Injects the bearer token the guard below demands. */
  const authedFetch: typeof fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${TOKEN}` },
    });

  beforeEach(async () => {
    guardedRelay = new ScriptedRelay();
    guardedRelay.chunks = ['Authenticated.'];

    const app = express();
    await new Promise<void>((resolve) => {
      guardedServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    guardedUrl = `http://127.0.0.1:${(guardedServer.address() as AddressInfo).port}`;

    const handlers = createA2aHandlers({
      agentRegistry: makeRegistry([makeManifest()]),
      relay: guardedRelay as unknown as RelayCore,
      db: createTestDb(),
      config: { baseUrl: guardedUrl, version: '0.0.0-test', authRequired: true },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    // Guards cards AND calls, which is the posture with login turned on.
    app.use((req, res, next) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    });
    app.get('/a2a/agents/:id/card', handlers.agentCard);
    app.post('/a2a/agents/:id', handlers.agentJsonRpc);
    app.use('/a2a', handlers.jsonRpc);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      guardedServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('rejects card discovery when only the transport is authenticated', async () => {
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: authedFetch })],
    });

    // The card never reaches the transport's fetch, so this dies at discovery.
    await expect(
      factory.createFromUrl(`${guardedUrl}/a2a/agents/agent-backend/card`, '')
    ).rejects.toThrow();
  });

  it('completes a turn when the card resolver is authenticated too', async () => {
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: authedFetch })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authedFetch }),
    });
    const client = await factory.createFromUrl(`${guardedUrl}/a2a/agents/agent-backend/card`, '');

    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: crypto.randomUUID(),
        contextId: '',
        taskId: '',
        role: Role.ROLE_USER,
        parts: [textPart('Run the tests.')],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    });

    const task = result as Task;
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(task.status?.message?.parts[0]?.content).toEqual({
      $case: 'text',
      value: 'Authenticated.',
    });
  });
});
