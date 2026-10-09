/** Doc capability calls through the real authenticated Codex/OpenCode HTTP route. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeRuntimeMcpFixtures,
  runtimeMcpFixture,
  runtimeRoomMcpFixture,
} from '../../../canvas/doc-channel/__tests__/runtime-mcp-fixture.js';
import { createAgentRuntimeMcpServer } from '../agent-runtime-server.js';
import { startConnectorRuntimeMcpListener, type ConnectorRuntimeMcpListener } from '../listener.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../../connector-tools.js';

const clients: Client[] = [];
const listeners: ConnectorRuntimeMcpListener[] = [];
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
  for (const listener of listeners.splice(0)) await attempt(() => listener.close());
  await attempt(() => closeRuntimeMcpFixtures());
  if (failed) throw firstCause;
});

async function connect(runtime: 'codex' | 'opencode', scope: 'chat' | 'room' = 'chat') {
  const f =
    scope === 'room' ? await runtimeRoomMcpFixture(runtime) : await runtimeMcpFixture(runtime);
  const binding = await f.principals.openTurn(
    {
      runtime,
      canonicalSessionId: 'session-1',
      agentPath: f.identity.agentPath,
      canonicalCwd: f.identity.agentPath,
      signal: new AbortController().signal,
    },
    { isCurrent: () => true }
  );
  const listener = await startConnectorRuntimeMcpListener({
    principals: f.principals,
    serverFactory: () => new McpServer({ name: 'connections', version: '1.0.0' }),
    agentServerFactory: (principal) =>
      createAgentRuntimeMcpServer(f.registry, principal, f.identity),
  });
  listeners.push(listener);
  const client = new Client({ name: 'doc-runtime-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(listener.agentUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${binding.bearer}`,
          [CONNECTOR_RUNTIME_KIND_HEADER]: runtime,
          [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent(f.identity.agentPath),
        },
      },
    })
  );
  return { ...f, client, binding, listener };
}

describe.each(['codex', 'opencode'] as const)('%s authenticated Doc tools', (runtime) => {
  it('executes the four actual Doc capabilities using the server-minted bearer', async () => {
    const f = await connect(runtime);
    for (const call of f.calls)
      expect(await f.client.callTool(call)).not.toHaveProperty('isError', true);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 1, nextDocSeq: 3 });
  });

  it('refuses cross-document access and revocation without replaying earlier authority', async () => {
    const f = await connect(runtime);
    if (!('canvas' in f)) throw new Error('Actual chat fixture required');
    const other = f.canvas.open('session:canonical', 'agent', {
      type: 'markdown',
      content: 'private',
    });
    for (const call of f.calls) {
      expect(
        await f.client.callTool({ ...call, arguments: { ...call.arguments, documentId: other.id } })
      ).toHaveProperty('isError', true);
    }
    expect(f.store.getChannel(other.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    await f.principals.revoke(f.binding.bindingId, 'turn_terminal');
    await expect(f.client.callTool(f.calls[0]!)).rejects.toThrow();
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });

  it('refuses an unauthenticated request before projecting document tools', async () => {
    const f = await connect(runtime);
    const response = await fetch(f.listener.agentUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: f.calls[0] }),
    });
    expect(response.status).toBe(401);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });
});

describe.each(['codex', 'opencode'] as const)(
  '%s member Room document authenticated MCP',
  (runtime) => {
    it('refuses all four Room tools without the genuine responder credential', async () => {
      const f = await connect(runtime, 'room');
      for (const call of f.calls) {
        const response = await fetch(f.listener.agentUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call }),
        });
        expect(response.status).toBe(401);
      }
      expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    });

    it('executes all four tools using the real authenticated product listener', async () => {
      const f = await connect(runtime, 'room');
      const expected = [
        { configured: true },
        { kind: 'granted' },
        { stateRev: 1 },
        { receipt: { status: 'recorded' } },
      ];
      for (const [index, call] of f.calls.entries()) {
        const result = await f.client.callTool(call);
        expect(result).not.toHaveProperty('isError', true);
        const text = (result.content as Array<{ type: string; text?: string }>).find(
          (block) => block.type === 'text'
        )?.text;
        if (!text) throw new Error('Actual MCP payload missing');
        expect(JSON.parse(text)).toMatchObject(expected[index]!);
      }
      expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 1, nextDocSeq: 3 });
    });
    it('refuses all four tools after persisted Room membership is removed', async () => {
      const f = await connect(runtime, 'room');
      if (!('removeMembership' in f)) throw new Error('Actual Room fixture required');
      for (const call of f.calls)
        expect(
          await f.client.callTool({
            ...call,
            arguments: { ...call.arguments, documentId: f.otherDoc.id },
          })
        ).toHaveProperty('isError', true);
      f.removeMembership();
      for (const call of f.calls)
        expect(await f.client.callTool(call)).toHaveProperty('isError', true);
      expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    });
  }
);
