/** Real Claude SDK MCP projection calls against migrated document services. */
import { canvasDocGrants } from '@dorkos/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeRuntimeMcpFixtures,
  runtimeMcpFixture,
  runtimeRoomMcpFixture,
} from '../../../../canvas/doc-channel/__tests__/runtime-mcp-fixture.js';
import { ConnectorTurnLeaseSupervisor } from '../../../connectors/connector-turn-lease-supervisor.js';
import { NOW } from '../../../../canvas/doc-channel/__tests__/lifecycle-fixtures.js';
import { ClaudeConnectorTurnContext } from '../../connector-turn-context.js';
import { createDorkOsToolServer } from '../index.js';
import type { ConnectorRuntimeTools } from '../../../connector-tools.js';
import type { McpToolDeps } from '../types.js';
import { NotifyBudget } from '../../../../relay/notify-budget.js';

vi.mock('../../../../../env.js', () => ({ env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined } }));
vi.mock('../../../../../lib/version.js', () => ({
  SERVER_VERSION: '0.0.0-test',
  IS_DEV_BUILD: false,
}));

const clients: Client[] = [];
const turns: ClaudeConnectorTurnContext[] = [];
const fixtureSupervisor: NonNullable<ConnectorRuntimeTools['createLeaseSupervisor']> = (options) =>
  new ConnectorTurnLeaseSupervisor({ ...options, now: () => new Date(NOW) });
afterEach(async () => {
  let failed = false;
  let firstCause: unknown;
  const attempt = async (close: () => Promise<unknown>) => {
    try {
      await close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        firstCause = cause;
      }
    }
  };
  for (const client of clients.splice(0)) await attempt(() => client.close());
  for (const turn of turns.splice(0)) await attempt(() => turn.revoke('turn_terminal'));
  await attempt(() => closeRuntimeMcpFixtures());
  if (failed) throw firstCause;
});

async function connect(
  f: Pick<Awaited<ReturnType<typeof runtimeMcpFixture>>, 'principals' | 'registry' | 'identity'>,
  authenticated = true,
  controls: Pick<ConnectorRuntimeTools, 'createLeaseSupervisor'> = {}
) {
  const turn = new ClaudeConnectorTurnContext({
    tools: {
      createLeaseSupervisor: fixtureSupervisor,
      ...controls,
      principals: f.principals,
      listenerUrl: 'http://127.0.0.1:1/mcp',
      agentToolsUrl: 'http://127.0.0.1:1/agent-mcp',
      // No Doc capability belongs to the private connector allowlist.
      isConnectorCapabilityId: (id) => id.startsWith('connectors.'),
    },
    canonicalSessionId: () => 'session-1',
    agentPath: f.identity.agentPath,
    cwd: f.identity.agentPath,
  });
  turns.push(turn);
  const session = {
    eventQueue: [],
    cwd: f.identity.agentPath,
    sdkSessionId: 'session-1',
    ...(authenticated ? { connectorTurn: turn } : {}),
  };
  const deps: McpToolDeps = {
    defaultCwd: f.identity.agentPath,
    dorkHome: '/tmp/dor-2819',
    notifyBudget: new NotifyBudget(),
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
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.instance.connect(serverTransport)]);
  return { client, turn, session };
}

function deferred() {
  let release: () => void = () => {
    throw new Error('Deferred gate was not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function resultPayload(result: unknown) {
  const first = (result as { content?: Array<{ type: string; text?: string }> }).content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string')
    throw new Error('Expected MCP text result');
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('Claude verified Doc capability principal', () => {
  it('executes all four Doc operations through the actual MCP projection', async () => {
    const f = await runtimeMcpFixture();
    const { client } = await connect(f);
    const expected = [
      { configured: true },
      { kind: 'granted' },
      { stateRev: 1 },
      { receipt: { status: 'recorded' } },
    ];
    for (const [index, call] of f.calls.entries()) {
      const result = await client.callTool(call);
      expect(result).not.toHaveProperty('isError', true);
      expect(resultPayload(result)).toMatchObject(expected[index]!);
    }
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 1, nextDocSeq: 3 });
    expect(f.db.select().from(canvasDocGrants).all()).toHaveLength(1);
  });

  it('refuses all four operations without a server-owned turn principal', async () => {
    const f = await runtimeMcpFixture();
    const { client } = await connect(f, false);
    for (const call of f.calls) expect(await client.callTool(call)).toHaveProperty('isError', true);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });

  it('revalidates a previously minted principal when its owner authority is lost', async () => {
    const f = await runtimeMcpFixture();
    const { client } = await connect(f);
    expect(await client.callTool(f.calls[0]!)).not.toHaveProperty('isError', true);
    f.loseAuthority();
    for (const call of f.calls) expect(await client.callTool(call)).toHaveProperty('isError', true);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });

  it.each(['turn_terminal', 'turn_cancelled'] as const)(
    'refuses a retired %s context',
    async (reason) => {
      const f = await runtimeMcpFixture();
      const { client, turn } = await connect(f);
      await client.callTool(f.calls[0]!);
      await turn.revoke(reason);
      for (const call of f.calls)
        expect(await client.callTool(call)).toHaveProperty('isError', true);
    }
  );

  it('uses the new live turn on a warm MCP server without retaining retired authority', async () => {
    const f = await runtimeMcpFixture();
    const { client, turn, session } = await connect(f);
    await client.callTool(f.calls[0]!);
    await turn.revoke('turn_terminal');
    const successor = new ClaudeConnectorTurnContext({
      tools: {
        createLeaseSupervisor: fixtureSupervisor,
        principals: f.principals,
        listenerUrl: 'http://127.0.0.1:1/mcp',
        agentToolsUrl: 'http://127.0.0.1:1/agent-mcp',
        isConnectorCapabilityId: () => false,
      },
      canonicalSessionId: () => 'session-1',
      agentPath: '/agents/one',
      cwd: '/agents/one',
    });
    turns.push(successor);
    session.connectorTurn = successor;
    expect(resultPayload(await client.callTool(f.calls[2]!))).toMatchObject({ stateRev: 1 });
    await expect(turn.resolvePrincipal()).rejects.toThrow(/retired|unavailable/);
  });

  it('does not turn a runtime principal into operator authority over the document opener', async () => {
    const f = await runtimeMcpFixture();
    const { client } = await connect(f);
    const call = f.calls[0]!;
    expect(
      await client.callTool({ ...call, arguments: { ...call.arguments, openerAgentId: 'other' } })
    ).toHaveProperty('isError', true);
    expect(f.store.getChannel(f.doc.id)?.openerAgentId).toBe('agent-1');
  });

  it.each(['open', 'initial resolution'] as const)(
    'refuses retirement during deferred %s without creating a late supervisor',
    async (stage) => {
      const f = await runtimeMcpFixture();
      const entered = deferred();
      const finish = deferred();
      const createLeaseSupervisor = vi.fn(() => ({
        state: 'active' as const,
        stop: vi.fn(),
        assertUsable: vi.fn(),
      }));
      const revoke = vi.spyOn(f.principals, 'revoke');
      if (stage === 'open') {
        const open = f.principals.openTurn.bind(f.principals);
        vi.spyOn(f.principals, 'openTurn').mockImplementation(async (...args) => {
          const binding = await open(...args);
          entered.release();
          await finish.promise;
          return binding;
        });
      } else {
        const resolve = f.principals.resolve.bind(f.principals);
        vi.spyOn(f.principals, 'resolve').mockImplementation(async (...args) => {
          const principal = await resolve(...args);
          entered.release();
          await finish.promise;
          return principal;
        });
      }
      const { turn } = await connect(f, true, { createLeaseSupervisor });
      const resolving = turn.resolvePrincipal();
      const refusal = expect(resolving).rejects.toThrow(/retired|unavailable/);
      await entered.promise;
      const retirement = turn.revoke('turn_terminal');
      expect(createLeaseSupervisor).not.toHaveBeenCalled();
      finish.release();
      await refusal;
      await retirement;
      expect(createLeaseSupervisor).not.toHaveBeenCalled();
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith(expect.any(String), 'turn_terminal');
    }
  );

  it('refuses cancellation during a deferred subsequent resolution', async () => {
    const f = await runtimeMcpFixture();
    const supervisor = { state: 'active' as const, stop: vi.fn(), assertUsable: vi.fn() };
    const createLeaseSupervisor = vi.fn(() => supervisor);
    const entered = deferred();
    const finish = deferred();
    let held = false;
    const resolve = f.principals.resolve.bind(f.principals);
    vi.spyOn(f.principals, 'resolve').mockImplementation(async (...args) => {
      const principal = await resolve(...args);
      if (held) {
        entered.release();
        await finish.promise;
      }
      return principal;
    });
    const revoke = vi.spyOn(f.principals, 'revoke');
    // The hardened context captures its real port methods at construction.
    const { turn } = await connect(f, true, { createLeaseSupervisor });
    await turn.resolvePrincipal();
    held = true;
    const resolving = turn.resolvePrincipal();
    const refusal = expect(resolving).rejects.toThrow();
    await entered.promise;
    await turn.cancel();
    finish.release();
    await refusal;
    expect(createLeaseSupervisor).toHaveBeenCalledTimes(1);
    expect(supervisor.stop).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(expect.any(String), 'turn_cancelled');
  });

  it('cannot select another private document with a tool argument', async () => {
    const f = await runtimeMcpFixture();
    const other = f.canvas.open('session:canonical', 'agent', {
      type: 'markdown',
      content: 'private',
    });
    const { client } = await connect(f);
    for (const call of f.calls) {
      expect(
        await client.callTool({ ...call, arguments: { ...call.arguments, documentId: other.id } })
      ).toHaveProperty('isError', true);
    }
    expect(f.store.getChannel(other.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });
});

describe('Claude member Room document MCP projection', () => {
  const roomSupervisor: NonNullable<ConnectorRuntimeTools['createLeaseSupervisor']> = (options) =>
    new ConnectorTurnLeaseSupervisor(options);
  it('executes all four tools and grants its own route on a writable member Room document', async () => {
    const f = await runtimeRoomMcpFixture();
    const { client } = await connect(f, true, { createLeaseSupervisor: roomSupervisor });
    const expected = [
      { configured: true },
      { kind: 'granted' },
      { stateRev: 1 },
      { receipt: { status: 'recorded' } },
    ];
    for (const [index, call] of f.calls.entries()) {
      const result = await client.callTool(call);
      expect(result).not.toHaveProperty('isError', true);
      expect(resultPayload(result)).toMatchObject(expected[index]!);
    }
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 1, nextDocSeq: 3 });
  });
  it('refuses every Room tool without the server-minted turn principal', async () => {
    const f = await runtimeRoomMcpFixture();
    const { client } = await connect(f, false, { createLeaseSupervisor: roomSupervisor });
    for (const call of f.calls) expect(await client.callTool(call)).toHaveProperty('isError', true);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });
  it('refuses nonmember documents and all writes after persisted membership removal', async () => {
    const f = await runtimeRoomMcpFixture();
    const { client } = await connect(f, true, { createLeaseSupervisor: roomSupervisor });
    for (const call of f.calls)
      expect(
        await client.callTool({
          ...call,
          arguments: { ...call.arguments, documentId: f.otherDoc.id },
        })
      ).toHaveProperty('isError', true);
    f.removeMembership();
    for (const call of f.calls) expect(await client.callTool(call)).toHaveProperty('isError', true);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    expect(f.store.getChannel(f.otherDoc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });
});
