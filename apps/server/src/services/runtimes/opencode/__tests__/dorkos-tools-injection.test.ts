/**
 * What `ensureManaged` registers into an OpenCode sidecar once
 * `runtimes.dorkosTools` is on (spec `tool-only-room-replies` §D4, DOR-1613).
 *
 * ## Why the turn binding is the whole story here
 *
 * The sidecar is one shared process serving every directory, so the runtime's
 * short-lived turn binding has to ride the server's own headers. The internal
 * listener resolves that binding to the canonical agent, session, and cwd.
 *
 * ## The per-turn refresh case
 *
 * `ensureManaged` skips its work when the desired set's signature is unchanged.
 * A new turn bearer changes `headers`, which changes the signature and forces a
 * re-add with the live credential. It is pinned here because a sidecar retaining
 * a revoked previous-turn binding would fail silently.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';

const configState = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('../../../core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config-manager.js')>();
  return {
    ...actual,
    configManager: {
      get: (key: string) => configState.value[key],
      getAll: () => configState.value,
    },
  };
});

const { OpenCodeMcpManager } = await import('../mcp/mcp-manager.js');

/** One recorded `client.mcp.add` call. */
interface AddCall {
  name: string;
  config: Record<string, unknown>;
}

/**
 * A fake sidecar recording every add, and reporting whichever servers a case
 * says are already live (a user's own config, for the collision path).
 */
function fakeSidecar(liveNames: string[] = []) {
  const adds: AddCall[] = [];
  const client = {
    mcp: {
      add: vi.fn(async ({ body }: { body: AddCall }) => {
        adds.push({ name: body.name, config: body.config });
        return { data: { [body.name]: { status: 'connected' as const } } };
      }),
      status: vi.fn(async () => ({
        data: Object.fromEntries(liveNames.map((name) => [name, { status: 'connected' }])),
      })),
      disconnect: vi.fn(async () => ({})),
    },
  } as unknown as OpencodeClient;
  return { client, adds };
}

/** A mesh registry reporting exactly one agent, rooted at `agentPath`. */
function meshWithAgent(agentPath: string): AgentRegistryPort {
  return {
    getByPath: (cwd: string) =>
      cwd === agentPath
        ? { id: '01JAGENT0000000000000000', name: 'researcher', displayName: 'Researcher' }
        : undefined,
    listWithPaths: () => [],
    updateLastSeen: () => {},
  } as unknown as AgentRegistryPort;
}

/** A manager wired to a mesh that knows `agentDir`, with no managed servers. */
function makeManager(agentDir: string) {
  const manager = new OpenCodeMcpManager({
    peekClient: () => null,
    getClient: async () => {
      throw new Error('not used');
    },
  } as never);
  manager.setMeshCore(meshWithAgent(agentDir));
  return manager;
}

/** The already-open binding shared by both internal runtime tool entries. */
function runtimeTools(bearer = 'turn-secret') {
  return {
    url: 'http://127.0.0.1:4341/mcp',
    agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'X-DorkOS-Connector-Runtime': 'opencode',
      'X-DorkOS-Connector-Cwd': encodeURIComponent('/canonical/agent'),
    },
  };
}

describe('the dorkos tool server on an OpenCode reconcile', () => {
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(tmpdir(), 'opencode-dorkos-tools-'));
    configState.value = { runtimes: { dorkosTools: true }, mcp: { enabled: true } };
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it('adds the agent route with the complete turn binding', async () => {
    const { client, adds } = fakeSidecar();
    await makeManager(agentDir).ensureManaged(client, agentDir, runtimeTools());

    const config = adds.find((entry) => entry.name === 'dorkos')?.config as Record<string, unknown>;
    expect(config['type']).toBe('remote');
    expect(config['url']).toBe('http://127.0.0.1:4341/agent-mcp');
    expect(config['enabled']).toBe(true);
    expect(config['headers']).toEqual(runtimeTools().headers);
  });

  it('uses the dedicated IPv4-loopback route returned by the listener', async () => {
    const { client, adds } = fakeSidecar();
    await makeManager(agentDir).ensureManaged(client, agentDir, runtimeTools());
    expect(adds.find((entry) => entry.name === 'dorkos')?.config['url']).toBe(
      'http://127.0.0.1:4341/agent-mcp'
    );
  });

  it('re-adds with the next turn bearer, defeating the no-op skip', async () => {
    // The signature is over the whole desired set, headers included, so a new
    // token is a new signature and the early return does not fire. Same client
    // instance and same desired NAMES on both passes, which is exactly the
    // shape that would otherwise be skipped.
    const { client, adds } = fakeSidecar();
    const manager = makeManager(agentDir);
    await manager.ensureManaged(client, agentDir, runtimeTools('turn-one'));
    await manager.ensureManaged(client, agentDir, runtimeTools('turn-two'));

    const dorkosAdds = adds.filter((entry) => entry.name === 'dorkos');
    expect(dorkosAdds).toHaveLength(2);
    const first = (dorkosAdds[0]?.config as { headers: Record<string, string> }).headers;
    const second = (dorkosAdds[1]?.config as { headers: Record<string, string> }).headers;
    expect(first['Authorization']).toBe('Bearer turn-one');
    expect(second['Authorization']).toBe('Bearer turn-two');
  });

  it('surfaces a user server called dorkos as a failed conflict, and adds nothing', async () => {
    // OpenCode's collision handling is better than codex's silent drop and
    // stays: the roster shows the conflict rather than pretending the user's
    // server is ours.
    const { client, adds } = fakeSidecar(['dorkos']);
    const manager = makeManager(agentDir);
    const result = await manager.ensureManaged(client, agentDir, runtimeTools());

    expect(adds.some((entry) => entry.name === 'dorkos')).toBe(false);
    const conflict = manager.getStatus(agentDir)?.find((entry) => entry.name === 'dorkos');
    expect(conflict?.status).toBe('failed');
    // The remedy has to be one the PERSON can carry out. DorkOS owns the name
    // `dorkos` and cannot move off it, so telling them to rename the managed
    // server — the wording every other collision gets — is an instruction that
    // cannot be followed.
    expect(conflict?.error).toBe(
      'a server named "dorkos" is already configured in OpenCode — rename yours so DorkOS can inject its tools'
    );
    // And the reconcile reports the truth, which is what the prompt is gated on.
    expect(result.dorkosApplied).toBe(false);
  });

  it('reports dorkosApplied false when the add throws, so the prompt stays honest', async () => {
    // The other divergence the prompt gate used to miss: the server was desired
    // and not refused, but registering it failed. An agent told it can post in
    // rooms would spend a turn discovering otherwise.
    const { client, adds } = fakeSidecar();
    vi.mocked(client.mcp.add).mockRejectedValueOnce(new Error('sidecar exploded'));
    const result = await makeManager(agentDir).ensureManaged(client, agentDir, runtimeTools());
    expect(adds.some((entry) => entry.name === 'dorkos')).toBe(false);
    expect(result.dorkosApplied).toBe(false);
  });

  it('reports dorkosApplied true on a successful add, and on every reconcile after it', async () => {
    // The positive half, without which every assertion above is satisfied by a
    // method that always returns false.
    //
    // Both calls carry different turn bindings, so the desired-set signature
    // differs and the sidecar is refreshed with the live credential.
    const { client, adds } = fakeSidecar();
    const manager = makeManager(agentDir);
    expect(
      (await manager.ensureManaged(client, agentDir, runtimeTools('turn-one'))).dorkosApplied
    ).toBe(true);
    expect(
      (await manager.ensureManaged(client, agentDir, runtimeTools('turn-two'))).dorkosApplied
    ).toBe(true);
    expect(adds.filter((entry) => entry.name === 'dorkos')).toHaveLength(2);
  });

  describe('when it withholds', () => {
    it('adds nothing while the experiment is off, and makes no round trip', async () => {
      // The default path for every OpenCode turn in the product. The status
      // read matters as much as the add: this used to be served by an early
      // return on a missing resolver, and the `dorkos` entry made that wrong.
      configState.value = { runtimes: { dorkosTools: false }, mcp: { enabled: true } };
      const { client, adds } = fakeSidecar();
      await makeManager(agentDir).ensureManaged(client, agentDir);

      expect(adds).toHaveLength(0);
      expect(client.mcp.status).not.toHaveBeenCalled();
    });

    it('adds nothing for a directory that hosts no registered agent', async () => {
      const { client, adds } = fakeSidecar();
      await makeManager(agentDir).ensureManaged(client, '/somewhere/else');
      expect(adds).toHaveLength(0);
    });

    it('still adds agent tools when public MCP is off and login is on', async () => {
      configState.value = {
        runtimes: { dorkosTools: true },
        mcp: { enabled: false },
        auth: { enabled: true },
      };
      const { client, adds } = fakeSidecar();
      const result = await makeManager(agentDir).ensureManaged(client, agentDir, runtimeTools());
      expect(result.dorkosApplied).toBe(true);
      expect(adds.find((entry) => entry.name === 'dorkos')?.config['url']).toBe(
        'http://127.0.0.1:4341/agent-mcp'
      );
    });
  });

  describe('connector runtime server', () => {
    it('registers independently of external MCP and the room-tools experiment', async () => {
      configState.value = { runtimes: { dorkosTools: false }, mcp: { enabled: false } };
      const { client, adds } = fakeSidecar();
      const manager = makeManager(agentDir);

      const result = await manager.ensureManaged(
        client,
        '/canonical/repo',
        {
          url: 'http://127.0.0.1:4341/mcp',
          agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
          headers: {
            Authorization: 'Bearer connector-secret',
            'X-DorkOS-Connector-Runtime': 'opencode',
            'X-DorkOS-Connector-Cwd': encodeURIComponent('/canonical/repo'),
          },
        },
        agentDir
      );

      expect(result).toEqual({ dorkosApplied: false, connectorApplied: true });
      expect(adds).toEqual([
        {
          name: 'dorkos_connections',
          config: {
            type: 'remote',
            url: 'http://127.0.0.1:4341/mcp',
            headers: {
              Authorization: 'Bearer connector-secret',
              'X-DorkOS-Connector-Runtime': 'opencode',
              'X-DorkOS-Connector-Cwd': encodeURIComponent('/canonical/repo'),
            },
            enabled: true,
          },
        },
      ]);
      expect(client.mcp.add).toHaveBeenCalledWith(
        expect.objectContaining({ query: { directory: '/canonical/repo' } })
      );
    });

    it('reports registration failure without claiming the connector server exists', async () => {
      const { client } = fakeSidecar();
      vi.mocked(client.mcp.add).mockImplementation(async (options) => {
        if (options?.body?.name === 'dorkos_connections') throw new Error('sidecar add failed');
        return {
          data: {
            [options?.body?.name ?? 'unknown']: { status: 'connected' as const },
          },
        } as never;
      });

      const manager = makeManager(agentDir);
      const result = await manager.ensureManaged(client, agentDir, {
        url: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        headers: { Authorization: 'Bearer connector-secret' },
      });

      expect(result.connectorApplied).toBe(false);
    });

    it('reports an HTTP-success failed status as a connector registration failure', async () => {
      const { client } = fakeSidecar();
      let connectorAttempts = 0;
      vi.mocked(client.mcp.add).mockImplementation(async (options) => {
        const name = options?.body?.name ?? 'unknown';
        if (name === 'dorkos_connections') connectorAttempts += 1;
        return {
          data: {
            [name]:
              name === 'dorkos_connections' && connectorAttempts === 1
                ? { status: 'failed' as const, error: 'connector handshake failed' }
                : { status: 'connected' as const },
          },
        } as never;
      });

      const manager = makeManager(agentDir);
      const result = await manager.ensureManaged(client, agentDir, {
        url: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        headers: { Authorization: 'Bearer connector-secret' },
      });

      expect(result.connectorApplied).toBe(false);

      vi.mocked(client.mcp.status).mockResolvedValueOnce({
        data: {
          dorkos_connections: {
            status: 'failed',
            error: 'connector handshake failed',
          },
        },
      } as never);
      const retried = await manager.ensureManaged(client, agentDir, {
        url: 'http://127.0.0.1:4341/mcp',
        agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
        headers: { Authorization: 'Bearer connector-secret' },
      });
      expect(retried.connectorApplied).toBe(true);
      expect(connectorAttempts).toBe(2);
    });
  });
});
