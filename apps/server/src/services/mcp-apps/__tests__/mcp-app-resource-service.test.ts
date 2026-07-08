import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import {
  resolveAppResource,
  McpAppResourceError,
  __clearMcpAppResourceCache,
} from '../mcp-app-resource-service.js';

/**
 * Exercises the real short-lived MCP client against the stdio fixture server
 * (spec `mcp-apps-host` §4). The fixture spawns as a Node child, so these are
 * genuine connect → resources/read → close round trips.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/fixture-mcp-app-server.mjs', import.meta.url));

const connection: McpAppServerConnection = {
  transport: 'stdio',
  command: process.execPath,
  args: [FIXTURE],
};

describe('resolveAppResource (fixture MCP server)', () => {
  beforeEach(() => __clearMcpAppResourceCache());

  it('reads a ui:// HTML resource and its sandbox metadata', async () => {
    const res = await resolveAppResource({
      serverName: 'fixture-app',
      uri: 'ui://dashboard/main',
      connection,
    });

    expect(res.mimeType).toContain('text/html');
    expect(res.text).toContain('Fixture Dashboard');
    // The fixture declares a CSP and an (empty) permissions list in resource _meta.
    expect(res.csp).toContain("default-src 'none'");
    expect(res.permissions).toEqual([]);
  });

  it('rejects a non-ui:// scheme before connecting', async () => {
    await expect(
      resolveAppResource({
        serverName: 'fixture-app',
        uri: 'file:///etc/passwd',
        connection,
      })
    ).rejects.toMatchObject({ code: 'INVALID_SCHEME' });
  });

  it('caches by (connection, serverName, uri) — a second read returns the same value', async () => {
    const first = await resolveAppResource({
      serverName: 'fixture-app',
      uri: 'ui://dashboard/main',
      connection,
    });
    const second = await resolveAppResource({
      serverName: 'fixture-app',
      uri: 'ui://dashboard/main',
      connection,
    });
    // Same cached object reference — no re-spawn/re-read occurred.
    expect(second).toBe(first);
  });

  it('does not cross-serve cache entries between same-named servers with different configs', async () => {
    // Two projects can each configure a server called "fixture-app" pointing at
    // different processes. The connection identity is part of the cache key, so
    // one project's cached iframe HTML must never serve the other's request.
    const connectionA: McpAppServerConnection = {
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { PROJECT: 'a' },
    };
    const connectionB: McpAppServerConnection = {
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      env: { PROJECT: 'b' },
    };

    const first = await resolveAppResource({
      serverName: 'fixture-app',
      uri: 'ui://dashboard/main',
      connection: connectionA,
    });
    const second = await resolveAppResource({
      serverName: 'fixture-app',
      uri: 'ui://dashboard/main',
      connection: connectionB,
    });

    // Distinct cache entries: B triggered its own real read (new object), it
    // did NOT get A's cached value back.
    expect(second).not.toBe(first);

    // And each connection's own repeat hit stays cached (sanity).
    const firstAgain = await resolveAppResource({
      serverName: 'fixture-app',
      uri: 'ui://dashboard/main',
      connection: connectionA,
    });
    expect(firstAgain).toBe(first);
  });

  it('throws a typed error (not a raw throw) on read failure', async () => {
    await expect(
      resolveAppResource({
        serverName: 'fixture-app',
        uri: 'ui://does-not-exist',
        connection,
      })
    ).rejects.toBeInstanceOf(McpAppResourceError);
  });
});
