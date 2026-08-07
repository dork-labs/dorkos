/**
 * The managed-MCP OAuth seams on {@link AgentMcpServerService} (DOR-942):
 *
 * 1. Injection merges an `Authorization: Bearer` header into an http/sse entry
 *    **iff** the token provider has a live token for it — both branches asserted,
 *    plus that an existing header is preserved and stdio never gets one.
 * 2. `test()` classifies a 401 probe as `needsAuth: true`, and a non-401 failure
 *    keeps `needsAuth` absent.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

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

/** Write a manifest with one enabled http server (and its existing headers). */
async function setupWorkspace(
  headers: Record<string, string> = { 'X-Existing': '1' }
): Promise<string> {
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
          url: REMOTE_URL,
          headers,
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

/** The URL the manifest fixture declares for the remote server. */
const REMOTE_URL = 'https://mcp.example/mcp';

/** A token provider that hands out `token` only for (AGENT_ID, REMOTE) at its URL. */
function providerWith(token: string | undefined): McpOAuthTokenProvider & {
  forgotten: string[];
} {
  const forgotten: string[] = [];
  return {
    forgotten,
    getAccessToken: (agentId, serverName, serverUrl) =>
      agentId === AGENT_ID && serverName === REMOTE && serverUrl === REMOTE_URL ? token : undefined,
    forgetServer: async (agentId, serverName) => {
      forgotten.push(`${agentId}:${serverName}`);
    },
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
    // Stated as a fact about a header map that must EXIST — the old spelling of
    // this line was satisfied by `remote` being undefined, so a bug that dropped
    // the server from injection entirely would have passed it (DOR-986).
    expect(remote?.transport).toBe('http');
    const headers = remote?.transport === 'http' ? remote.headers : undefined;
    expect(headers).toBeDefined();
    expect(Object.keys(headers!)).not.toContain('Authorization');
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

describe('AgentMcpServerService — bearer injection is bound to the URL (DOR-986)', () => {
  it('asks for the token under the entry’s CURRENT url, so a re-pointed server gets nothing', async () => {
    const projectPath = await setupWorkspace();
    // This provider only answers for the URL the manifest declared. A service that
    // looks a token up by name alone would still get one here.
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: {
        getAccessToken: (_agentId, _name, serverUrl) =>
          serverUrl === 'https://somewhere-else.example/mcp' ? 'stale-token' : undefined,
        forgetServer: async () => {},
      },
    });

    const remote = service.injectableServersForCwd(projectPath)[REMOTE];
    // Reverting `getAccessToken(agentId, name, connection.url)` to the two-argument
    // form makes the provider's URL check unreachable and injects `stale-token`.
    expect(remote?.transport === 'http' ? remote.headers : undefined).toEqual({
      'X-Existing': '1',
    });
  });

  it('replaces a differently-cased authorization header instead of sending both', async () => {
    const projectPath = await setupWorkspace({ authorization: 'Bearer manual-old' });
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: providerWith('live-token'),
    });

    const remote = service.injectableServersForCwd(projectPath)[REMOTE];
    const headers = remote?.transport === 'http' ? remote.headers : undefined;
    // HTTP header names are case-insensitive, object keys are not: without the
    // case-insensitive strip this map carries BOTH `authorization` and
    // `Authorization`, and undici sends two — the server picks whichever it likes.
    expect(headers).toEqual({ Authorization: 'Bearer live-token' });
  });
});

describe('AgentMcpServerService — credentials follow the server (DOR-986)', () => {
  it('clears the stored sign-in when the server is removed', async () => {
    const projectPath = await setupWorkspace();
    const tokenProvider = providerWith('live-token');
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider,
    });

    await service.remove(AGENT_ID, REMOTE);

    // Reverting the `forgetOAuthCredentials` call in `remove` leaves the encrypted
    // token, the client registration and a live refresh timer behind — the row is
    // gone from the UI and the credential is not.
    expect(tokenProvider.forgotten).toEqual([`${AGENT_ID}:${REMOTE}`]);
  });

  it('clears the stored sign-in when the server is re-pointed at a new url', async () => {
    const projectPath = await setupWorkspace();
    const tokenProvider = providerWith('live-token');
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider,
    });

    await service.update({
      agentId: AGENT_ID,
      name: REMOTE,
      connection: { transport: 'http', url: 'https://elsewhere.example/mcp', headers: {} },
    });

    expect(tokenProvider.forgotten).toEqual([`${AGENT_ID}:${REMOTE}`]);
  });

  it('keeps the sign-in when an update leaves the url alone', async () => {
    const projectPath = await setupWorkspace();
    const tokenProvider = providerWith('live-token');
    const service = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider,
    });

    await service.disable(AGENT_ID, REMOTE);
    await service.enable(AGENT_ID, REMOTE);

    // The discriminator: clearing on every update would sign the operator out
    // every time they toggled a server off and on again.
    expect(tokenProvider.forgotten).toEqual([]);
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
