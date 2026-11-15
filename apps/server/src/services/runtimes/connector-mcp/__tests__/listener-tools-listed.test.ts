/**
 * DOR-4384: the connector listener tells its host each time the DorkOS tools
 * route answered a `tools/list`, with the bearer it carried, so a Codex thread
 * that never lists its tools can be noticed. Only that route, only an answered
 * list, and never a refused caller.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectorRuntimePrincipalPort,
  ConnectorTurnRefusalReason,
} from '../../../connectors/runtime-principal-port.js';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../../connector-tools.js';
import { startConnectorRuntimeMcpListener, type ConnectorRuntimeMcpListener } from '../listener.js';

const principal = {
  claims: {
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-1' },
    bindingId: 'binding-1',
    runtime: 'codex',
    canonicalSessionId: 'session-1',
    agentId: 'agent-1',
    agentPath: '/repo',
  },
} as ServerPrincipalProof;

function port(
  result:
    | { status: 'resolved'; principal: ServerPrincipalProof }
    | { status: 'refused'; reason: ConnectorTurnRefusalReason }
): ConnectorRuntimePrincipalPort {
  return {
    openTurn: vi.fn(),
    renew: vi.fn(),
    resolve: vi.fn().mockResolvedValue(result),
    revoke: vi.fn(),
  };
}

/** A server with one made-up tool, so it answers `tools/list`. */
function serverWithATool(): McpServer {
  const server = new McpServer({ name: 'listed-test', version: '1.0.0' });
  server.registerTool('ping_team', { description: 'Made-up tool.' }, () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
  }));
  return server;
}

/** An MCP client on `url`, carrying the made-up bearer. */
async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'listed-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          authorization: 'Bearer turn-secret',
          [CONNECTOR_RUNTIME_KIND_HEADER]: 'codex',
          [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/repo'),
        },
      },
    })
  );
  return client;
}

describe('the listener noting an answered DorkOS tool list (DOR-4384)', () => {
  const listeners: ConnectorRuntimeMcpListener[] = [];
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  });

  /** A listener with both routes serving one tool, and a recording hook. */
  async function listen(resolved = true) {
    const onAgentToolsListed = vi.fn();
    const listener = await startConnectorRuntimeMcpListener({
      principals: port(
        resolved ? { status: 'resolved', principal } : { status: 'refused', reason: 'invalid' }
      ),
      serverFactory: serverWithATool,
      agentServerFactory: serverWithATool,
      onAgentToolsListed,
    });
    listeners.push(listener);
    return { listener, onAgentToolsListed };
  }

  it('tells the host the bearer of a tool list the agent route answered', async () => {
    const { listener, onAgentToolsListed } = await listen();
    const client = await connect(listener.agentUrl);
    expect(onAgentToolsListed, 'initialize alone is not a tool list').not.toHaveBeenCalled();
    await client.listTools();
    expect(onAgentToolsListed).toHaveBeenCalledWith('turn-secret');
    await client.close();
  });

  it('says nothing for the connector route’s tool list', async () => {
    const { listener, onAgentToolsListed } = await listen();
    const client = await connect(listener.url);
    await client.listTools();
    expect(onAgentToolsListed).not.toHaveBeenCalled();
    await client.close();
  });

  it('says nothing for a caller the listener refused', async () => {
    const { listener, onAgentToolsListed } = await listen(false);
    await expect(connect(listener.agentUrl)).rejects.toThrow();
    const response = await fetch(listener.agentUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer turn-secret',
        [CONNECTOR_RUNTIME_KIND_HEADER]: 'codex',
        [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/repo'),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(onAgentToolsListed).not.toHaveBeenCalled();
  });
});
