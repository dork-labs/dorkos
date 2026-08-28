/**
 * What `ensureManaged` registers into an OpenCode sidecar once
 * `runtimes.dorkosTools` is on (spec `tool-only-room-replies` §D4, DOR-1613).
 *
 * ## Why the headers are the whole story here
 *
 * This is OpenCode's ONLY per-agent identity channel, and structurally so: the
 * sidecar is one shared process serving every directory, with a fixed
 * environment, so there is no `DORKOS_AGENT_TOKEN` env seam of the kind codex
 * and claude-code use — and there never will be. If the token does not ride the
 * server's own `headers`, it does not ride at all, and every room post lands in
 * the install owner's name.
 *
 * ## The re-mint case, which used to be true by accident
 *
 * `ensureManaged` skips its work when the desired set's signature is unchanged.
 * A freshly minted token changes `headers`, which changes the signature, which
 * defeats the skip and forces a re-add with the live credential. That fell out
 * of hashing the whole desired set rather than its names — correct, and nothing
 * said so. It is pinned here, because the failure it prevents is silent: a
 * long-lived agent whose token quietly expires and whose every room write then
 * 401s.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/index.js';

const envState = vi.hoisted(() => ({
  DORKOS_HOST: 'localhost',
  DORKOS_PORT: 4242,
  MCP_API_KEY: undefined as string | undefined,
}));

vi.mock('../../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../env.js')>();
  return { ...actual, env: envState };
});

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

vi.mock('../../../core/auth/mcp-local-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/auth/mcp-local-token.js')>();
  return { ...actual, getMcpLocalToken: () => 'dork_mcp_local_abc123' };
});

const { OpenCodeMcpManager } = await import('../mcp-manager.js');

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
        return {};
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

describe('the dorkos tool server on an OpenCode reconcile', () => {
  let agentDir: string;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(tmpdir(), 'opencode-dorkos-tools-'));
    envState.DORKOS_HOST = 'localhost';
    envState.DORKOS_PORT = 4242;
    envState.MCP_API_KEY = undefined;
    configState.value = { runtimes: { dorkosTools: true }, mcp: { enabled: true } };
    db = createTestDb();
    initAgentIdentityService(db);
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(agentDir, { recursive: true, force: true });
  });

  it('adds a remote dorkos server carrying both headers', async () => {
    const { client, adds } = fakeSidecar();
    await makeManager(agentDir).ensureManaged(client, agentDir);

    expect(adds).toHaveLength(1);
    expect(adds[0]?.name).toBe('dorkos');
    const config = adds[0]?.config as Record<string, unknown>;
    expect(config['type']).toBe('remote');
    expect(config['url']).toBe('http://localhost:4242/mcp');
    expect(config['enabled']).toBe(true);
    const headers = config['headers'] as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer dork_mcp_local_abc123');
    expect(headers['x-dorkos-agent']).toEqual(expect.any(String));
    expect(headers['x-dorkos-agent']).not.toBe('');
  });

  it('never dials 127.0.0.1 (DOR-723)', async () => {
    const { client, adds } = fakeSidecar();
    await makeManager(agentDir).ensureManaged(client, agentDir);
    expect(String((adds[0]?.config as Record<string, unknown>)['url'])).not.toContain('127.0.0.1');
  });

  it('re-adds with a FRESH token on the next reconcile, defeating the no-op skip', async () => {
    // The signature is over the whole desired set, headers included, so a new
    // token is a new signature and the early return does not fire. Same client
    // instance and same desired NAMES on both passes, which is exactly the
    // shape that would otherwise be skipped.
    const { client, adds } = fakeSidecar();
    const manager = makeManager(agentDir);
    await manager.ensureManaged(client, agentDir);
    await manager.ensureManaged(client, agentDir);

    expect(adds).toHaveLength(2);
    const first = (adds[0]?.config as { headers: Record<string, string> }).headers;
    const second = (adds[1]?.config as { headers: Record<string, string> }).headers;
    expect(second['x-dorkos-agent']).not.toBe(first['x-dorkos-agent']);
  });

  it('surfaces a user server called dorkos as a failed conflict, and adds nothing', async () => {
    // OpenCode's collision handling is better than codex's silent drop and
    // stays: the roster shows the conflict rather than pretending the user's
    // server is ours.
    const { client, adds } = fakeSidecar(['dorkos']);
    const manager = makeManager(agentDir);
    const result = await manager.ensureManaged(client, agentDir);

    expect(adds).toHaveLength(0);
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
    const result = await makeManager(agentDir).ensureManaged(client, agentDir);
    expect(adds).toHaveLength(0);
    expect(result.dorkosApplied).toBe(false);
  });

  it('reports dorkosApplied true on a successful add, and again on the cheap re-check', async () => {
    // The positive half, without which every assertion above is satisfied by a
    // method that always returns false.
    const { client } = fakeSidecar();
    const manager = makeManager(agentDir);
    expect((await manager.ensureManaged(client, agentDir)).dorkosApplied).toBe(true);
    expect((await manager.ensureManaged(client, agentDir)).dorkosApplied).toBe(true);
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

    it('adds nothing when the MCP endpoint is off', async () => {
      configState.value = { runtimes: { dorkosTools: true }, mcp: { enabled: false } };
      const { client, adds } = fakeSidecar();
      await makeManager(agentDir).ensureManaged(client, agentDir);
      expect(adds).toHaveLength(0);
    });
  });
});
