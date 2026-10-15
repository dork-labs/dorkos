/** Codex/OpenCode use the existing bearer-authenticated product listener, not Claude's projection. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runtimeDocMcpFixture,
  docMcpPayload,
} from '../../../canvas/doc-channel/__tests__/runtime-doc-mcp-fixture.js';
import { createAgentRuntimeMcpServer } from '../agent-runtime-server.js';
import { startConnectorRuntimeMcpListener } from '../listener.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../../connector-tools.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  let failed = false;
  let first: unknown;
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

async function connect(runtime: 'codex' | 'opencode', scope: 'chat' | 'room') {
  const f = await runtimeDocMcpFixture(runtime, scope);
  cleanups.push(() => f.close());
  const binding = await f.principals.openTurn(
    {
      runtime,
      canonicalSessionId: 'session-1',
      agentPath: f.dir,
      canonicalCwd: f.dir,
      signal: new AbortController().signal,
    },
    { isCurrent: () => true }
  );
  cleanups.push(() => f.principals.revoke(binding.bindingId, 'turn_terminal'));
  const listener = await startConnectorRuntimeMcpListener({
    principals: f.principals,
    serverFactory: () => new McpServer({ name: 'connections', version: '1.0.0' }),
    agentServerFactory: (principal) =>
      createAgentRuntimeMcpServer(f.registry, principal, f.identity),
  });
  cleanups.push(() => listener.close());
  const client = new Client({ name: 'doc-runtime-test', version: '1.0.0' });
  cleanups.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(listener.agentUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${binding.bearer}`,
          [CONNECTOR_RUNTIME_KIND_HEADER]: runtime,
          [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent(f.dir),
        },
      },
    })
  );
  return { ...f, client, binding, listener };
}

describe.each(['codex', 'opencode'] as const)('%s authenticated document tools', (runtime) => {
  describe.each(['chat', 'room'] as const)('%s document', (scope) => {
    it('runs all four real capabilities through the product HTTP listener', async () => {
      const f = await connect(runtime, scope);
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

    it('refuses requests missing the genuine bearer before invoking document tools', async () => {
      const f = await connect(runtime, scope);
      for (const call of f.calls) {
        const response = await fetch(f.listener.agentUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call }),
        });
        expect(response.status).toBe(401);
      }
      expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    });

    it('refuses foreign documents and retired runtime bindings', async () => {
      const f = await connect(runtime, scope);
      for (const call of f.calls)
        expect(
          await f.client.callTool({
            ...call,
            arguments: { ...call.arguments, documentId: f.otherDoc.id },
          })
        ).toHaveProperty('isError', true);
      await f.principals.revoke(f.binding.bindingId, 'turn_terminal');
      await expect(f.client.callTool(f.calls[0]!)).rejects.toThrow();
      expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
    });
  });

  it('refuses all four room tools after actual membership removal', async () => {
    const f = await connect(runtime, 'room');
    f.removeMembership();
    for (const call of f.calls)
      expect(await f.client.callTool(call)).toHaveProperty('isError', true);
    expect(f.http.channels.getChannel(f.doc.id)).toMatchObject({ stateRev: 0, nextDocSeq: 1 });
  });
});
