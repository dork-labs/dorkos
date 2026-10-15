/** Four Doc operations through Claude's real SDK MCP projection and real Main services. */
import { canvasDocGrants, eq } from '@dorkos/db';
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

async function grantOwnRoute(f: Awaited<ReturnType<typeof connect>>) {
  expect(await f.client.callTool(f.calls[0]!)).not.toHaveProperty('isError', true);
  const granted = docMcpPayload(await f.client.callTool(f.calls[1]!));
  expect(granted.kind).toBe('granted');
  const grantId = String(granted.grantId);
  if (!f.http.channels.getGrant(grantId)) throw new Error('Actual granted route missing');
  return grantId;
}

describe.each(['chat', 'room'] as const)('Claude %s existing route revocation', (scope) => {
  it('lists the existing revoke tool and lets the recorded opener revoke its own route', async () => {
    const f = await connect(scope);
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

  it('refuses revocation when the authenticated turn is absent', async () => {
    const f = await connect(scope);
    const grantId = await grantOwnRoute(f);
    delete f.session.connectorTurn;
    expect(
      await f.client.callTool({
        name: 'revoke_doc_route',
        arguments: { documentId: f.doc.id, grantId },
      })
    ).toHaveProperty('isError', true);
    expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
  });

  it('refuses revocation after terminal retirement', async () => {
    const f = await connect(scope);
    const grantId = await grantOwnRoute(f);
    await f.turn.revoke('turn_terminal');
    expect(
      await f.client.callTool({
        name: 'revoke_doc_route',
        arguments: { documentId: f.doc.id, grantId },
      })
    ).toHaveProperty('isError', true);
    expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
  });

  it('refuses revocation after current authority is lost', async () => {
    const f = await connect(scope);
    const grantId = await grantOwnRoute(f);
    f.loseAuthority();
    expect(
      await f.client.callTool({
        name: 'revoke_doc_route',
        arguments: { documentId: f.doc.id, grantId },
      })
    ).toHaveProperty('isError', true);
    expect(f.http.channels.getGrant(grantId)?.revokedAt).toBeNull();
  });

  it('refuses a stored grant owned by a different opener even with current document write access', async () => {
    const f = await connect(scope);
    const grantId = await grantOwnRoute(f);
    // Server-side fixture record: the caller remains agent-1, not this recorded opener.
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

  it('cannot substitute a foreign document for the original grant', async () => {
    const f = await connect(scope);
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

it('refuses route revocation after persisted Room membership is removed', async () => {
  const f = await connect('room');
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
