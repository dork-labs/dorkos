/**
 * The `dorkos://` resource-parity gate.
 *
 * Both MCP servers must expose the SAME read-only resources. They did not:
 * `dorkos://sessions`, `dorkos://agents`, `dorkos://skills`, and
 * `dorkos://capabilities` were registered only on the external `/mcp` server, so
 * every third-party MCP client could ask a running DorkOS "what sessions are
 * active?" and the user's own in-session agent could not. That is the exact
 * inversion the agents-as-operators program exists to close
 * (`specs/agents-as-operators/02-specification.md`).
 *
 * These tests drive REAL `McpServer` instances over the SDK's in-memory transport
 * and ask each one through the protocol, rather than counting registration calls:
 * a stub server would pass while the wire surface stayed broken.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { noopLogger } from '@dorkos/shared/logger';

import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import { createDorkOsToolServer } from '../../../runtimes/claude-code/mcp-tools/index.js';
import { createExternalMcpServer } from '../../mcp-server.js';
import { composeDorkOsCapabilityRegistry } from '../../self-description/dorkos-registry.js';
import { DORKOS_RESOURCE_URIS } from '../index.js';
import { NotifyBudget } from '../../../relay/notify-budget.js';

/** A hermetic `McpToolDeps` carrying only what the resources actually read. */
function makeDeps(): McpToolDeps {
  return {
    notifyBudget: new NotifyBudget(),
    transcriptReader: {
      listSessions: async () => [],
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dorkos-resource-parity',
    meshCore: {
      list: () => [],
      get: () => undefined,
    } as unknown as McpToolDeps['meshCore'],
    runtimeRegistry: {
      listRuntimes: () => [],
      resolveForSession: async () => {
        throw new Error('no runtime');
      },
    } as unknown as McpToolDeps['runtimeRegistry'],
  };
}

/** Connect a client to `server` over the in-memory transport pair. */
async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'parity-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Every concrete resource URI the server reports through `resources/list`. */
async function listedUris(server: McpServer): Promise<string[]> {
  const client = await connect(server);
  try {
    const { resources } = await client.listResources();
    return resources.map((r) => r.uri);
  } finally {
    await client.close();
  }
}

const deps = makeDeps();
const registry = composeDorkOsCapabilityRegistry({ logger: noopLogger, operatorDeps: deps });

describe('dorkos:// resources on the in-session server', () => {
  it('lists all four state-of-the-world resources', async () => {
    const uris = await listedUris(
      createDorkOsToolServer(deps, undefined, undefined, undefined, registry).instance
    );
    expect(uris.sort()).toEqual([...DORKOS_RESOURCE_URIS].sort());
  });

  it('serves dorkos://capabilities: the full catalog the tool and route project from', async () => {
    const client = await connect(
      createDorkOsToolServer(deps, undefined, undefined, undefined, registry).instance
    );
    try {
      const result = await client.readResource({ uri: 'dorkos://capabilities' });
      const block = result.contents[0];
      expect(block?.mimeType).toBe('application/json');
      const catalog = JSON.parse(String(block?.text)) as {
        catalogVersion: string;
        capabilities: { id: string }[];
      };
      expect(catalog.catalogVersion).toBe(registry.catalog().catalogVersion);
      expect(catalog.capabilities.map((c) => c.id)).toContain('capabilities.list');
    } finally {
      await client.close();
    }
  });

  it('serves dorkos://sessions: the answer no in-session agent could get before', async () => {
    const client = await connect(
      createDorkOsToolServer(deps, undefined, undefined, undefined, registry).instance
    );
    try {
      const result = await client.readResource({ uri: 'dorkos://sessions' });
      const payload = JSON.parse(String(result.contents[0]?.text)) as { sessions: unknown[] };
      expect(payload.sessions).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('does not advertise a resources/list_changed push channel it never sends', async () => {
    const client = await connect(
      createDorkOsToolServer(deps, undefined, undefined, undefined, registry).instance
    );
    try {
      expect(client.getServerCapabilities()?.resources).toEqual({ listChanged: false });
    } finally {
      await client.close();
    }
  });
});

describe('parity between the two servers', () => {
  it('both expose exactly the same resource URIs', async () => {
    const inSession = await listedUris(
      createDorkOsToolServer(deps, undefined, undefined, undefined, registry).instance
    );
    const external = await listedUris(createExternalMcpServer(deps, undefined, registry));
    expect(inSession.sort()).toEqual(external.sort());
  });
});
