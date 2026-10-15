import { canvasDocGrants, eq } from '@dorkos/db';
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

async function grantOwnRoute(f: Awaited<ReturnType<typeof connect>>) {
  expect(await f.client.callTool(f.calls[0]!)).not.toHaveProperty('isError', true);
  const granted = docMcpPayload(await f.client.callTool(f.calls[1]!));
  expect(granted.kind).toBe('granted');
  const grantId = String(granted.grantId);
  if (!f.http.channels.getGrant(grantId)) throw new Error('Actual grant missing');
  return grantId;
}

describe.each(['codex', 'opencode'] as const)('%s existing route revocation', (runtime) => {
  describe.each(['chat', 'room'] as const)('%s scope', (scope) => {
    it('already lists revoke and revokes an own route through the genuine authenticated listener', async () => {
      const f = await connect(runtime, scope);
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toContain(
        'revoke_doc_route'
      );
      const grantId = await grantOwnRoute(f);
      const result = await f.client.callTool({
        name: 'revoke_doc_route',
        arguments: { documentId: f.doc.id, grantId },
      });
      expect(result).not.toHaveProperty('isError', true);
      expect(docMcpPayload(result)).toEqual({ revoked: true });
      expect(f.http.channels.getGrant(grantId)?.revokedAt).toEqual(expect.any(String));
    });

    it('refuses an unauthenticated revoke request before the handler', async () => {
      const f = await connect(runtime, scope);
      const grantId = await grantOwnRoute(f);
      const response = await fetch(f.listener.agentUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'revoke_doc_route', arguments: { documentId: f.doc.id, grantId } },
        }),
      });
      expect(response.status).toBe(401);
      expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
    });

    it('refuses a revoked bearer instead of retaining earlier runtime authority', async () => {
      const f = await connect(runtime, scope);
      const grantId = await grantOwnRoute(f);
      await f.principals.revoke(f.binding.bindingId, 'turn_terminal');
      await expect(
        f.client.callTool({
          name: 'revoke_doc_route',
          arguments: { documentId: f.doc.id, grantId },
        })
      ).rejects.toThrow();
      expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
    });

    it('refuses a different recorded opener despite current scope access', async () => {
      const f = await connect(runtime, scope);
      const grantId = await grantOwnRoute(f);
      f.db
        .update(canvasDocGrants)
        .set({ openerAgentId: 'different-recorded-opener' })
        .where(eq(canvasDocGrants.grantId, grantId))
        .run();
      const result = await f.client.callTool({
        name: 'revoke_doc_route',
        arguments: { documentId: f.doc.id, grantId },
      });
      expect(result).toHaveProperty('isError', true);
      expect(JSON.stringify(result)).toContain('OPENER_REQUIRED');
      expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
    });

    it('cannot substitute a foreign document for its grant', async () => {
      const f = await connect(runtime, scope);
      const grantId = await grantOwnRoute(f);
      expect(
        await f.client.callTool({
          name: 'revoke_doc_route',
          arguments: { documentId: f.otherDoc.id, grantId },
        })
      ).toHaveProperty('isError', true);
      expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
    });
  });

  it('refuses revocation after actual Room membership removal', async () => {
    const f = await connect(runtime, 'room');
    const grantId = await grantOwnRoute(f);
    f.removeMembership();
    expect(
      await f.client.callTool({
        name: 'revoke_doc_route',
        arguments: { documentId: f.doc.id, grantId },
      })
    ).toHaveProperty('isError', true);
    expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
  });
});
