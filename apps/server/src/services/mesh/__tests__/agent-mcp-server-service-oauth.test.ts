/**
 * The managed-MCP OAuth seams on {@link AgentMcpServerService} (DOR-942, DOR-985):
 *
 * 1. Injection merges an `Authorization: Bearer` header into an http/sse entry
 *    **iff** the token provider has a live token for it — both branches asserted,
 *    plus that an existing header is preserved and stdio never gets one.
 * 2. `test()` classifies a 401 probe as `needsAuth: true`, and a non-401 failure
 *    keeps `needsAuth` absent.
 * 3. `list()` decorates each entry with a derived `authStatus`, which is never
 *    written to disk, and a 401 probe teaches the entry `authKind: 'oauth2'`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';

import {
  AgentMcpServerService,
  type AgentWorkspaceLocator,
  type McpOAuthTokenProvider,
} from '../agent-mcp-server-service.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const REMOTE = 'granola';

class FakeLocator implements AgentWorkspaceLocator {
  constructor(private readonly projectPath: string) {}
  get(agentId: string): { projectPath: string } | undefined {
    return agentId === AGENT_ID ? { projectPath: this.projectPath } : undefined;
  }
}

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Write a manifest with one enabled http server (and its existing header). */
async function setupWorkspace(): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-'));
  tempDirs.push(projectPath);
  const manifest: AgentManifest = {
    id: AGENT_ID,
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-06T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [
      {
        name: REMOTE,
        enabled: true,
        connection: {
          transport: 'http',
          url: 'https://mcp.example/mcp',
          headers: { 'X-Existing': '1' },
          authKind: 'oauth2',
        },
        addedAt: '2026-08-06T00:00:00.000Z',
        addedBy: 'operator',
      },
    ],
  };
  await writeManifest(projectPath, manifest);
  return projectPath;
}

/** Write a manifest whose single server carries exactly `connection`. */
async function setupWorkspaceWith(connection: McpServerTransport): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-authstatus-'));
  tempDirs.push(projectPath);
  const manifest: AgentManifest = {
    id: AGENT_ID,
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-06T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    enabledToolGroups: {},
    mcpServers: [
      {
        name: REMOTE,
        enabled: true,
        connection,
        addedAt: '2026-08-06T00:00:00.000Z',
        addedBy: 'operator',
      },
    ],
  };
  await writeManifest(projectPath, manifest);
  return projectPath;
}

/** The http connection an OAuth-protected server has once it is known to be one. */
const OAUTH_HTTP: McpServerTransport = {
  transport: 'http',
  url: 'https://mcp.example/mcp',
  headers: {},
  authKind: 'oauth2',
};

/** The same server before anything has established that it wants a sign-in. */
const PLAIN_HTTP: McpServerTransport = {
  transport: 'http',
  url: 'https://mcp.example/mcp',
  headers: {},
};

/** A token provider that hands out `token` only for (AGENT_ID, REMOTE). */
function providerWith(token: string | undefined): McpOAuthTokenProvider {
  return {
    getAccessToken: (agentId, serverName) =>
      agentId === AGENT_ID && serverName === REMOTE ? token : undefined,
  };
}

describe('AgentMcpServerService — OAuth bearer injection', () => {
  it('merges the bearer header when a live token exists, preserving existing headers', async () => {
    const projectPath = await setupWorkspace();
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith('live-token'),
    });

    const servers = service.injectableServersForCwd(projectPath);
    const remote = servers[REMOTE];
    expect(remote?.transport).toBe('http');
    // Reverting `mergeOAuthHeaders` (returning the base untouched) drops the
    // Authorization header and reddens this branch.
    expect(remote?.transport === 'http' ? remote.headers : undefined).toEqual({
      'X-Existing': '1',
      Authorization: 'Bearer live-token',
    });
  });

  it('withholds the bearer header when no live token exists (safe default)', async () => {
    const projectPath = await setupWorkspace();
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith(undefined),
    });

    const servers = service.injectableServersForCwd(projectPath);
    const remote = servers[REMOTE];
    // The negative branch: no token → no header. Reverting the presence guard so
    // it always merges (e.g. `Bearer undefined`) reddens this.
    expect(remote?.transport === 'http' ? remote.headers : undefined).toEqual({
      'X-Existing': '1',
    });
    expect(remote && 'headers' in remote ? 'Authorization' in remote.headers! : false).toBe(false);
  });

  it('never injects a bearer with no token provider wired at all', async () => {
    const projectPath = await setupWorkspace();
    const service = new AgentMcpServerService({ agents: new FakeLocator(projectPath) });

    const servers = service.injectableServersForCwd(projectPath);
    const remote = servers[REMOTE];
    expect(remote?.transport === 'http' ? remote.headers : undefined).toEqual({
      'X-Existing': '1',
    });
  });
});

describe('AgentMcpServerService.test — 401 classification', () => {
  it('reports needsAuth on a 401 probe, keeping the raw error', async () => {
    const projectPath = await setupWorkspace();
    const probeFetch: typeof fetch = async () =>
      new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      probeFetch,
    });

    const result = await service.test(AGENT_ID, REMOTE);
    // Reverting `isUnauthorizedProbeError` to always-false drops needsAuth and reddens this.
    expect(result.ok).toBe(false);
    expect(result.needsAuth).toBe(true);
    expect(result.error).toEqual(expect.any(String));
  });

  it('does NOT report needsAuth on a non-401 failure', async () => {
    const projectPath = await setupWorkspace();
    const probeFetch: typeof fetch = async () => new Response('Boom', { status: 500 });
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      probeFetch,
    });

    const result = await service.test(AGENT_ID, REMOTE);
    // The discriminator: a 500 is an ordinary failure, not needs-auth. Reverting
    // `isUnauthorizedProbeError` to always-true would wrongly set needsAuth here.
    expect(result.ok).toBe(false);
    expect(result.needsAuth).toBeUndefined();
  });
});

describe('AgentMcpServerService.test — probing with the OAuth bearer (DOR-985)', () => {
  /** A probe fetch that records the `Authorization` it was called with, then 401s. */
  function recordingProbeFetch(seen: (string | null)[]): typeof fetch {
    return async (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer' },
      });
    };
  }

  it('sends the live token, so Test dials what a turn would dial', async () => {
    const projectPath = await setupWorkspaceWith(OAUTH_HTTP);
    const seen: (string | null)[] = [];
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith('live-token'),
      probeFetch: recordingProbeFetch(seen),
    });

    await service.test(AGENT_ID, REMOTE);

    // Probing the bare stored connection (the pre-fix behaviour) sends nothing
    // here, so a server the operator had just signed into answered 401 forever
    // and the row co-rendered "Connected" with "Needs sign-in — click Sign in".
    expect(seen[0]).toBe('Bearer live-token');
  });

  it('withholds the header when no token is held, and still classifies the 401', async () => {
    const projectPath = await setupWorkspaceWith(OAUTH_HTTP);
    const seen: (string | null)[] = [];
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith(undefined),
      probeFetch: recordingProbeFetch(seen),
    });

    const result = await service.test(AGENT_ID, REMOTE);

    // The safe default is unchanged: no token → no header → needs-auth.
    expect(seen[0]).toBeNull();
    expect(result).toMatchObject({ ok: false, needsAuth: true });
  });

  it('never writes the bearer back to the manifest', async () => {
    const projectPath = await setupWorkspaceWith(OAUTH_HTTP);
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith('live-token'),
      probeFetch: recordingProbeFetch([]),
    });

    await service.test(AGENT_ID, REMOTE);

    // The merged connection is a per-probe copy. Baking a token into the stored
    // entry would strand an expired one on disk in plain text.
    const raw = await fs.readFile(path.join(projectPath, '.dork', 'agent.json'), 'utf-8');
    expect(raw).not.toContain('live-token');
    expect(raw).not.toContain('Authorization');
  });
});

describe('AgentMcpServerService.list — derived authStatus (DOR-985)', () => {
  it('reports connected when a live token exists, even with no authKind on the entry', async () => {
    const projectPath = await setupWorkspaceWith(PLAIN_HTTP);
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith('live-token'),
    });

    const [server] = await service.list(AGENT_ID);
    // A live token is the same lookup injection makes; dropping the token branch
    // from `deriveAuthStatus` leaves this undefined and reddens.
    expect(server?.authStatus).toBe('connected');
  });

  it('reports needs-auth for an oauth2 entry with no live token', async () => {
    const projectPath = await setupWorkspaceWith(OAUTH_HTTP);
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith(undefined),
    });

    const [server] = await service.list(AGENT_ID);
    // This is the whole point of the field: a freshly-started server, no turn yet,
    // and the row can still say the server needs signing in.
    expect(server?.authStatus).toBe('needs-auth');
  });

  it('has no opinion about a remote server that has never demanded auth', async () => {
    const projectPath = await setupWorkspaceWith(PLAIN_HTTP);
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith(undefined),
    });

    const [server] = await service.list(AGENT_ID);
    // The negative branch: guessing needs-auth for every tokenless remote server
    // would put a Sign in button on servers that authenticate by static header.
    expect(server?.authStatus).toBeUndefined();
  });

  it('has no opinion about an oauth2 entry the operator authenticated by hand', async () => {
    const projectPath = await setupWorkspaceWith({
      ...OAUTH_HTTP,
      headers: { authorization: 'Bearer operator-supplied' },
    });
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith(undefined),
    });

    const [server] = await service.list(AGENT_ID);
    // The entry carries its own credential (lower-cased here on purpose — HTTP
    // header names are case-insensitive), so DorkOS holding no token is not a
    // problem to nag about. Dropping the guard puts a Sign in button on a server
    // that does not need one.
    expect(server?.authStatus).toBeUndefined();
  });

  it('has no opinion about a stdio server, even with a token cached under its name', async () => {
    const projectPath = await setupWorkspaceWith({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith('live-token'),
    });

    const [server] = await service.list(AGENT_ID);
    // A local command has no OAuth endpoint; dropping the stdio guard would call
    // this one connected off a token that could never be sent anywhere.
    expect(server?.authStatus).toBeUndefined();
  });

  it('never writes authStatus to the manifest on disk', async () => {
    const projectPath = await setupWorkspaceWith(OAUTH_HTTP);
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith('live-token'),
    });

    const [listed] = await service.list(AGENT_ID);
    expect(listed?.authStatus).toBe('connected');

    // Read the RAW file, not the parsed manifest: Zod would strip an unknown key
    // and hide a leak. Persisting the decoration would freeze a moment as config.
    const raw = await fs.readFile(path.join(projectPath, '.dork', 'agent.json'), 'utf-8');
    expect(raw).not.toContain('authStatus');
  });
});

describe('AgentMcpServerService — learning authKind from evidence (DOR-985)', () => {
  it('records authKind: oauth2 on the manifest when the probe gets a 401', async () => {
    const projectPath = await setupWorkspaceWith(PLAIN_HTTP);
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      probeFetch: async () =>
        new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }),
    });

    const before = await readManifest(projectPath);
    expect(
      before?.mcpServers[0]?.connection.transport === 'http'
        ? before.mcpServers[0].connection.authKind
        : 'n/a'
    ).toBeUndefined();

    await service.test(AGENT_ID, REMOTE);

    // The write-through is what makes the heal survive a restart: drop the
    // `learnOAuthAuthKind` call from `test()` and this stays undefined.
    const after = await readManifest(projectPath);
    const connection = after?.mcpServers[0]?.connection;
    expect(connection?.transport === 'http' ? connection.authKind : undefined).toBe('oauth2');

    // And the next listing says needs-auth off that stored hint alone.
    const [server] = await service.list(AGENT_ID);
    expect(server?.authStatus).toBe('needs-auth');
  });

  it('does NOT record authKind when the probe fails for some other reason', async () => {
    const projectPath = await setupWorkspaceWith(PLAIN_HTTP);
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      probeFetch: async () => new Response('Boom', { status: 500 }),
    });

    await service.test(AGENT_ID, REMOTE);

    // The discriminator: an unreachable server is not an OAuth server. Learning
    // on every failure would put a Sign in button on a server that is merely down.
    const after = await readManifest(projectPath);
    const connection = after?.mcpServers[0]?.connection;
    expect(connection?.transport === 'http' ? connection.authKind : undefined).toBeUndefined();
  });

  it('leaves a stdio entry alone and reports no write', async () => {
    const projectPath = await setupWorkspaceWith({
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
    });
    const service = new AgentMcpServerService({ agents: new FakeLocator(projectPath) });

    expect(await service.learnOAuthAuthKind(AGENT_ID, REMOTE)).toBe(false);
    const after = await readManifest(projectPath);
    expect(after?.mcpServers[0]?.connection.transport).toBe('stdio');
  });

  it('is idempotent — a second call does not rewrite an entry already marked', async () => {
    const projectPath = await setupWorkspaceWith(OAUTH_HTTP);
    const service = new AgentMcpServerService({ agents: new FakeLocator(projectPath) });

    expect(await service.learnOAuthAuthKind(AGENT_ID, REMOTE)).toBe(false);
  });
});
