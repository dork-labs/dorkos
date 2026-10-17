/** Doc capability calls through the real authenticated Codex/OpenCode HTTP route. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { closeRuntimeMcpFixtures, runtimeMcpFixture } from '../../../canvas/doc-channel/__tests__/runtime-mcp-fixture.js';
import { createAgentRuntimeMcpServer } from '../agent-runtime-server.js';
import { startConnectorRuntimeMcpListener, type ConnectorRuntimeMcpListener } from '../listener.js';
import { CONNECTOR_RUNTIME_CWD_HEADER, CONNECTOR_RUNTIME_KIND_HEADER } from '../../connector-tools.js';

const clients: Client[] = [];
const listeners: ConnectorRuntimeMcpListener[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  closeRuntimeMcpFixtures();
});

async function connect(runtime: 'codex' | 'opencode') {
  const f = await runtimeMcpFixture(runtime);
  const binding = await f.principals.openTurn({
    runtime, canonicalSessionId: 'session-1', agentPath: '/agents/one',
    canonicalCwd: '/agents/one', signal: new AbortController().signal,
  }, { isCurrent: () => true });
  const listener = await startConnectorRuntimeMcpListener({
    principals: f.principals,
    serverFactory: () => new McpServer({ name: 'connections', version: '1.0.0' }),
    agentServerFactory: (principal) => createAgentRuntimeMcpServer(f.registry, principal, f.identity),
  });
  listeners.push(listener);
  const client = new Client({ name: 'doc-runtime-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(listener.agentUrl), {
    requestInit: { headers: {
      authorization: `Bearer ${binding.bearer}`,
      [CONNECTOR_RUNTIME_KIND_HEADER]: runtime,
      [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/agents/one'),
    } },
  }));
  return { ...f, client, binding, listener };
}

describe.each(['codex', 'opencode'] as const)('%s authenticated Doc tools', (runtime) => {
  it('executes the four actual Doc capabilities using the server-minted bearer', async () => {
    const f = await connect(runtime);
    for (const call of f.calls) expect(await f.client.callTool(call)).not.toHaveProperty('isError', true);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 1, nextDocSeq: 3 });
  });

  it('refuses cross-document access and revocation without replaying earlier authority', async () => {
    const f = await connect(runtime);
    const other = f.canvas.open('session:canonical', 'agent', { type: 'markdown', content: 'private' });
    for (const call of f.calls) {
      expect(await f.client.callTool({ ...call, arguments: { ...call.arguments, documentId: other.id } }))
        .toHaveProperty('isError', true);
    }
    expect(f.store.getChannel(other.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    await f.principals.revoke(f.binding.bindingId, 'turn_terminal');
    await expect(f.client.callTool(f.calls[0]!)).rejects.toThrow();
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });

  it('refuses an unauthenticated request before projecting document tools', async () => {
    const f = await connect(runtime);
    const response = await fetch(f.listener.agentUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: f.calls[0] }),
    });
    expect(response.status).toBe(401);
    expect(f.store.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });
});
