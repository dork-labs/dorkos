/** Four Doc operations through Claude's real SDK MCP projection and real Main services. */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runtimeDocMcpFixture,
  docMcpPayload,
} from '../../../../canvas/doc-channel/__tests__/runtime-doc-mcp-fixture.js';
import { ClaudeConnectorTurnContext } from '../../connector-turn-context.js';
import { createDorkOsToolServer } from '../index.js';
import type { McpToolDeps } from '../types.js';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined, DORKOS_OLLAMA_URL: 'http://127.0.0.1:11434' },
}));
vi.mock('../../../../../lib/version.js', () => ({
  SERVER_VERSION: '0.0.0-test',
  IS_DEV_BUILD: false,
}));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  let first: unknown;
  let failed = false;
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
});

async function connect(scope: 'chat' | 'room', authenticated = true) {
  const f = await runtimeDocMcpFixture('claude-code', scope);
  cleanups.push(() => f.close());
  const turn = new ClaudeConnectorTurnContext({
    tools: {
      principals: f.principals,
      listenerUrl: 'http://127.0.0.1:1/mcp',
      agentToolsUrl: 'http://127.0.0.1:1/agent-mcp',
      isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
    },
    canonicalSessionId: () => 'session-1',
    agentPath: f.dir,
    cwd: f.dir,
  });
  cleanups.push(() => turn.revoke('turn_terminal'));
  const session = {
    eventQueue: [],
    cwd: f.dir,
    sdkSessionId: 'session-1',
    ...(authenticated ? { connectorTurn: turn } : {}),
  };
  const deps: McpToolDeps = {
    defaultCwd: f.dir,
    dorkHome: f.dir,
    transcriptReader: {
      listSessions: async () => [],
    } as unknown as McpToolDeps['transcriptReader'],
  };
  const server = createDorkOsToolServer(
    deps,
    session,
    'request-id',
    undefined,
    f.registry,
    new Set(),
    undefined,
    false
  );
  const client = new Client({ name: 'doc-principal-test', version: '1.0.0' });
  cleanups.push(() => client.close());
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.instance.connect(right)]);
  return { ...f, client, turn, session };
}

describe.each(['chat', 'room'] as const)('Claude %s Doc tools', (scope) => {
  it('configures and grants its own route, patches state and sends through the actual MCP server', async () => {
    const f = await connect(scope);
    const expected = [
      { configured: true },
      { kind: 'granted' },
      { stateRev: 1 },
      { receipt: { status: 'recorded' } },
    ];
    for (const [index, call] of f.calls.entries()) {
      const result = await f.client.callTool(call);
      expect(result).not.toHaveProperty('isError', true);
      expect(docMcpPayload(result)).toMatchObject(expected[index]!);
    }
    expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 1, nextDocSeq: 3 });
  });

  it('refuses every operation without an authenticated turn', async () => {
    const f = await connect(scope, false);
    for (const call of f.calls)
      expect(await f.client.callTool(call)).toHaveProperty('isError', true);
    expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });

  it('refuses a foreign document and cannot change the recorded opener', async () => {
    const f = await connect(scope);
    for (const call of f.calls)
      expect(
        await f.client.callTool({
          ...call,
          arguments: { ...call.arguments, documentId: f.otherDoc.id },
        })
      ).toHaveProperty('isError', true);
    const call = f.calls[0]!;
    expect(
      await f.client.callTool({
        ...call,
        arguments: { ...call.arguments, openerAgentId: 'foreign-agent' },
      })
    ).toHaveProperty('isError', true);
    expect(f.http.channels.getChannel(f.otherDoc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    expect(f.http.channels.getChannel(f.doc.id)?.openerAgentId).toBe('agent-1');
  });

  it('refuses current authority loss after the principal was first resolved', async () => {
    const f = await connect(scope);
    expect(await f.client.callTool(f.calls[0]!)).not.toHaveProperty('isError', true);
    f.loseAuthority();
    for (const call of f.calls)
      expect(await f.client.callTool(call)).toHaveProperty('isError', true);
    expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });

  it.each(['turn_terminal', 'turn_cancelled'] as const)(
    'refuses the retired %s turn',
    async (reason) => {
      const f = await connect(scope);
      await f.client.callTool(f.calls[0]!);
      await f.turn.revoke(reason);
      for (const call of f.calls)
        expect(await f.client.callTool(call)).toHaveProperty('isError', true);
      expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    }
  );
});

it('refuses all four room operations after persisted membership is removed', async () => {
  const f = await connect('room');
  f.removeMembership();
  for (const call of f.calls) expect(await f.client.callTool(call)).toHaveProperty('isError', true);
  expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
});

it('reports the decided room app-ack limit without recording a false acknowledgment', async () => {
  const f = await connect('room');
  await f.client.callTool(f.calls[0]!);
  const grant = docMcpPayload(await f.client.callTool(f.calls[1]!));
  expect(grant.kind).toBe('granted');
  const grantRow = f.http.channels.getGrant(String(grant.grantId));
  if (!grantRow) throw new Error('Actual own-route grant missing');
  const eventId = randomUUID();
  const now = new Date().toISOString();
  f.http.channels.appendEvent({
    documentId: f.doc.id,
    eventId,
    direction: 'upstream',
    type: 'task.done',
    payload: {},
    envelopeHash: 'a'.repeat(64),
    envelopeBytes: 100,
    provenance: {},
    receivedAt: now,
  });
  f.http.channels.insertBatch({
    batchId: 'room-batch',
    documentId: f.doc.id,
    scope: f.http.channels.getChannel(f.doc.id)!.scope,
    routeId: grantRow.routeId,
    grantId: grantRow.grantId,
    grantRevision: grantRow.revision,
    generation: 'generation',
    inputEventIds: [eventId],
    effectivePayload: {},
    dueAt: now,
    status: 'turn_done',
    turnId: 'room-turn',
    createdAt: now,
    updatedAt: now,
  });
  const ack = {
    name: 'canvas_send',
    arguments: {
      documentId: f.doc.id,
      eventId: randomUUID(),
      type: 'app.ack',
      payload: {
        batchId: 'room-batch',
        routeId: grantRow.routeId,
        eventIds: [eventId],
        outcome: 'handled',
      },
    },
  };
  const before = f.http.channels.getChannel(f.doc.id)!.nextDocSeq;
  const result = await f.client.callTool(ack);
  expect(result).toHaveProperty('isError', true);
  expect(JSON.stringify(result)).toContain('ROOM_APP_ACK_RESPONDER_UNAVAILABLE');
  expect(f.http.channels.getChannel(f.doc.id)!.nextDocSeq).toBe(before);
});
