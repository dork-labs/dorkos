/**
 * The `mcp.signin` / `mcp.poll_signin` capabilities (DOR-942): they wire the
 * agent-facing verbs to the OAuth engine, return the custody disclosure verbatim,
 * carry the flow to `connected`, and guard the not-an-OAuth-server / unknown-
 * server / engine-absent cases with structured errors.
 *
 * The happy path runs against the same in-process mock OAuth provider the engine
 * test uses; here it is driven THROUGH the capability handlers.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { noopLogger } from '@dorkos/shared/logger';
import { AgentRegistry } from '@dorkos/mesh';
import { createTestDb } from '@dorkos/test-utils/db';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest, McpServerTransport } from '@dorkos/shared/mesh-schemas';

import { mcpDomain } from '../mcp-capabilities.js';
import { AgentMcpOAuthService } from '../agent-mcp-oauth-service.js';
import { AgentMcpServerService, type AgentWorkspaceLocator } from '../agent-mcp-server-service.js';
import type { CapabilityDeps } from '../../core/capabilities/index.js';
import type { CapabilityDefinition } from '../../core/capabilities/index.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const ORIGIN = 'https://mcp.test.local';
const SERVER_URL = `${ORIGIN}/mcp`;
const AUTH_CODE = 'auth-code-xyz';
const CALLBACK_BASE = 'http://127.0.0.1:4242';

function capability(id: string): CapabilityDefinition {
  const found = mcpDomain.capabilities.find((c) => c.id === id);
  if (!found) throw new Error(`mcp domain no longer declares ${id}`);
  return found;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function readForm(init?: RequestInit): URLSearchParams {
  const b = init?.body;
  if (!b) return new URLSearchParams();
  return typeof b === 'string' ? new URLSearchParams(b) : new URLSearchParams(String(b));
}

/** Minimal OAuth provider mock (discovery + DCR + PKCE token exchange). */
function mockOAuthFetch(pkce: { challenge: string }): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('oauth-protected-resource')) {
      return json({ resource: SERVER_URL, authorization_servers: [ORIGIN] });
    }
    if (url.includes('oauth-authorization-server') || url.includes('openid-configuration')) {
      return json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.endsWith('/register')) {
      return json({
        client_id: 'test-client-id',
        redirect_uris: [`${CALLBACK_BASE}/api/agents/mcp-oauth/callback`],
        token_endpoint_auth_method: 'none',
      });
    }
    if (url.endsWith('/token')) {
      const form = readForm(init);
      const ok =
        form.get('code') === AUTH_CODE &&
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') === pkce.challenge;
      return ok
        ? json({
            access_token: 'access-1',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'r-1',
          })
        : json({ error: 'invalid_grant' }, 400);
    }
    return new Response('not found', { status: 404 });
  };
}

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

async function setup(connection: McpServerTransport): Promise<{
  deps: CapabilityDeps;
  pkce: { challenge: string };
  projectPath: string;
}> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-signin-'));
  tempDirs.push(projectPath);
  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-signin-home-'));
  tempDirs.push(dorkHome);
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
        name: SERVER,
        enabled: true,
        connection,
        addedAt: '2026-08-06T00:00:00.000Z',
        addedBy: 'operator',
      },
    ],
  };
  await writeManifest(projectPath, manifest);
  const pkce = { challenge: '' };
  const service = new AgentMcpServerService({ agents: new FakeLocator(projectPath) });
  const oauth = new AgentMcpOAuthService({
    dorkHome,
    callbackBaseUrl: CALLBACK_BASE,
    fetchImpl: mockOAuthFetch(pkce),
  });
  const deps: CapabilityDeps = {
    logger: noopLogger,
    mcpDeps: { service, agents: new AgentRegistry(createTestDb()), oauth },
  };
  return { deps, pkce, projectPath };
}

const HTTP_SERVER: McpServerTransport = { transport: 'http', url: SERVER_URL, headers: {} };

describe('mcp.signin / mcp.poll_signin', () => {
  it('starts a sign-in, returns the disclosure verbatim, and reaches connected', async () => {
    const { deps, pkce } = await setup(HTTP_SERVER);
    const oauth = deps.mcpDeps!.oauth!;

    const started = (await capability('mcp.signin').invoke(
      deps,
      { agentId: AGENT_ID, name: SERVER },
      {
        identity: undefined,
      } as never
    )) as {
      flowId: string;
      authorizeUrl?: string;
      alreadyConnected: boolean;
      disclosure: string;
      message: string;
    };
    expect(started.alreadyConnected).toBe(false);
    expect(started.authorizeUrl).toContain(`${ORIGIN}/authorize`);
    // The custody disclosure is shown verbatim and names the server.
    expect(started.disclosure).toContain('encrypted on this computer');
    expect(started.message).toContain(`[Sign in to ${SERVER}]`);

    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';
    const cb = await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
    expect(cb.connected).toBe(true);

    const poll = await capability('mcp.poll_signin').invoke(
      deps,
      { flowId: started.flowId },
      {} as never
    );
    expect(poll).toEqual({ status: 'connected' });
  });

  it('records authKind: oauth2 on the entry once the provider accepts the sign-in (DOR-985)', async () => {
    // The seeded server carries NO authKind — the state every server added
    // before DorkOS knew to ask is in, and the reason the row never offered a
    // sign-in after a restart.
    const { deps, projectPath } = await setup(HTTP_SERVER);

    await capability('mcp.signin').invoke(deps, { agentId: AGENT_ID, name: SERVER }, {} as never);

    // Reaching a real authorize URL means the provider's OAuth discovery
    // answered. Dropping the `learnOAuthAuthKind` call from the handler leaves
    // this undefined and reddens.
    const manifest = await readManifest(projectPath);
    const connection = manifest?.mcpServers[0]?.connection;
    expect(connection?.transport === 'http' ? connection.authKind : undefined).toBe('oauth2');
  });

  it('rejects sign-in for a local (stdio) server', async () => {
    const { deps } = await setup({ transport: 'stdio', command: 'x', args: [], env: {} });
    await expect(
      capability('mcp.signin').invoke(deps, { agentId: AGENT_ID, name: SERVER }, {} as never)
    ).rejects.toMatchObject({ name: 'CapabilityToolError' });
  });

  it('reports an unknown server as SERVER_NOT_FOUND', async () => {
    const { deps } = await setup(HTTP_SERVER);
    await expect(
      capability('mcp.signin').invoke(deps, { agentId: AGENT_ID, name: 'nope' }, {} as never)
    ).rejects.toMatchObject({ name: 'CapabilityToolError', payload: { code: 'SERVER_NOT_FOUND' } });
  });

  it('fails clearly when the OAuth engine is not wired', async () => {
    const { deps } = await setup(HTTP_SERVER);
    const withoutOAuth: CapabilityDeps = {
      ...deps,
      mcpDeps: { service: deps.mcpDeps!.service, agents: deps.mcpDeps!.agents },
    };
    await expect(
      capability('mcp.poll_signin').invoke(withoutOAuth, { flowId: 'x' }, {} as never)
    ).rejects.toMatchObject({
      name: 'CapabilityToolError',
      payload: { code: 'SIGNIN_UNAVAILABLE' },
    });
  });
});
