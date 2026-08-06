/**
 * The managed-MCP OAuth engine end-to-end (DOR-942), against an in-process mock
 * OAuth provider (RFC 9728 + RFC 8414 discovery, RFC 7591 DCR, PKCE
 * authorization-code exchange). The acceptance path:
 *
 *   mcp.signin → (browser auto-approve) → callback → mcp.poll_signin connected
 *   → token persisted ENCRYPTED → getAccessToken returns it → injection yields
 *   the `Authorization: Bearer` header.
 *
 * The mock's /token endpoint validates PKCE (recomputes the S256 challenge from
 * the verifier the SDK sent and compares it to the one in the authorize URL), so
 * a broken verifier round-trip through the provider + flow store reddens the flow.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExtensionSecretStore, resetKeyCache } from '@dorkos/shared/extension-secrets';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { AgentMcpOAuthService } from '../agent-mcp-oauth-service.js';
import { AgentMcpServerService, type AgentWorkspaceLocator } from '../agent-mcp-server-service.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const ORIGIN = 'https://mcp.test.local';
const SERVER_URL = `${ORIGIN}/mcp`;
const AUTH_CODE = 'auth-code-xyz';
const CALLBACK_BASE = 'http://127.0.0.1:4242';

const tempDirs: string[] = [];
afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/**
 * A scheduler that captures but never fires. The background refresh is out of
 * scope for these flow tests, and letting a real timer fire would race the token
 * write against the temp-dir teardown; the cache's own suite covers scheduling.
 */
const inertScheduler = {
  set: (): ReturnType<typeof setTimeout> => 0 as unknown as ReturnType<typeof setTimeout>,
  clear: (): void => {},
};

/** JSON Response helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Coerce a fetch body into URLSearchParams (the token endpoint is form-encoded). */
function readForm(init?: RequestInit): URLSearchParams {
  const b = init?.body;
  if (!b) return new URLSearchParams();
  if (typeof b === 'string') return new URLSearchParams(b);
  if (b instanceof URLSearchParams) return b;
  return new URLSearchParams(String(b));
}

/** The S256 PKCE challenge for a verifier. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * A mock OAuth-protected MCP server: discovery, DCR, and a PKCE-validating token
 * endpoint. `pkce.challenge` is filled in by the test from the authorize URL, so
 * the token exchange proves the verifier the provider stored matches it.
 */
function mockOAuthFetch(pkce: { challenge: string }): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

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
    if (method === 'POST' && url.endsWith('/register')) {
      const reg = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        redirect_uris?: string[];
      };
      return json({
        client_id: 'test-client-id',
        redirect_uris: reg.redirect_uris ?? [`${CALLBACK_BASE}/api/agents/mcp-oauth/callback`],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'DorkOS',
      });
    }
    if (method === 'POST' && url.endsWith('/token')) {
      const form = readForm(init);
      if (form.get('grant_type') === 'refresh_token') {
        return json({
          access_token: 'access-2',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
        });
      }
      const verifierOk = s256(form.get('code_verifier') ?? '') === pkce.challenge;
      if (form.get('code') !== AUTH_CODE || !verifierOk) {
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({
        access_token: 'access-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
      });
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

/** A workspace whose manifest has one enabled http server for the injection check. */
async function setupWorkspace(): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-ws-'));
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
        name: SERVER,
        enabled: true,
        connection: { transport: 'http', url: SERVER_URL, headers: {}, authKind: 'oauth2' },
        addedAt: '2026-08-06T00:00:00.000Z',
        addedBy: 'operator',
      },
    ],
  };
  await writeManifest(projectPath, manifest);
  return projectPath;
}

describe('AgentMcpOAuthService — full sign-in flow', () => {
  it('signs in, persists an encrypted token, and yields the injected bearer header', async () => {
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    const pkce = { challenge: '' };
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: mockOAuthFetch(pkce),
      cache: { scheduler: inertScheduler },
    });

    // 1. Start sign-in → a real authorize URL, no token yet.
    const started = await oauth.startSignin({
      agentId: AGENT_ID,
      serverName: SERVER,
      serverUrl: SERVER_URL,
    });
    expect(started.alreadyConnected).toBe(false);
    expect(started.authorizeUrl).toContain(`${ORIGIN}/authorize`);
    expect(oauth.pollSignin(started.flowId).status).toBe('pending');
    // Token withheld until the flow completes.
    expect(oauth.getAccessToken(AGENT_ID, SERVER)).toBeUndefined();

    // The mock validates PKCE against the challenge the SDK put in the authorize URL.
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';
    expect(pkce.challenge).not.toBe('');

    // 2. The browser (auto-approved) redirects to the loopback callback with code+state.
    const cb = await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
    expect(cb).toEqual({ connected: true });
    expect(oauth.pollSignin(started.flowId).status).toBe('connected');

    // 3. The access token is now readable SYNCHRONOUSLY (the injection read path).
    expect(oauth.getAccessToken(AGENT_ID, SERVER)).toBe('access-1');

    // 4. It is persisted ENCRYPTED: a fresh store decrypts it, and the raw file is
    //    ciphertext (the plaintext token never appears on disk).
    resetKeyCache();
    const store = new ExtensionSecretStore('mcp-oauth', dorkHome);
    const storedTokens = await store.get(`${AGENT_ID}:${SERVER}:tokens`);
    expect(JSON.parse(storedTokens ?? '{}').access_token).toBe('access-1');
    const rawFile = await fs.readFile(
      path.join(dorkHome, 'extension-secrets', 'mcp-oauth.json'),
      'utf-8'
    );
    expect(rawFile).not.toContain('access-1');
    expect(rawFile).not.toContain('refresh-1');

    // 5. Injection now yields the bearer header for the enabled http server.
    const projectPath = await setupWorkspace();
    const servers = new AgentMcpServerService({
      agents: new FakeLocator(projectPath),
      tokenProvider: oauth,
    });
    const injected = servers.injectableServersForCwd(projectPath)[SERVER];
    expect(injected?.transport === 'http' ? injected.headers?.Authorization : undefined).toBe(
      'Bearer access-1'
    );
  });

  it('reports failed when the callback state is unknown, storing nothing', async () => {
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: mockOAuthFetch({ challenge: '' }),
    });

    const result = await oauth.handleCallback({ state: 'never-started', code: AUTH_CODE });
    expect(result.connected).toBe(false);
    expect(oauth.getAccessToken(AGENT_ID, SERVER)).toBeUndefined();
  });
});

describe('AgentMcpOAuthService.warm — restart staleness (B2)', () => {
  const TARGET = { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL };

  /** Persist a token record directly, stamping the ABSOLUTE `expiresAt` a real save would. */
  async function seedStoredToken(dorkHome: string, expiresAt: number): Promise<void> {
    resetKeyCache();
    const store = new ExtensionSecretStore('mcp-oauth', dorkHome);
    await store.set(
      `${AGENT_ID}:${SERVER}:tokens`,
      JSON.stringify({
        access_token: 'restored-token',
        token_type: 'Bearer',
        // A long RELATIVE lifetime: if warm recomputed expiry from this instead of
        // the absolute `expiresAt`, an old token would look freshly minted.
        expires_in: 3600,
        refresh_token: 'refresh-old',
        expiresAt,
      })
    );
    resetKeyCache();
  }

  it('re-warms a token issued long ago as EXPIRED, not freshly minted', async () => {
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    // Absolute expiry in the past relative to the cache clock (5000).
    await seedStoredToken(dorkHome, 1000);
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: mockOAuthFetch({ challenge: '' }),
      cache: { now: () => 5000, scheduler: inertScheduler },
    });

    await oauth.warm([TARGET]);

    // Reverting the B2 fix (toCachedToken recomputing expiry from the relative
    // `expires_in` at load time instead of trusting the stored absolute `expiresAt`)
    // makes this token read LIVE ('restored-token') and reddens the assertion —
    // exactly the stale-bearer-after-restart the sync cache exists to prevent.
    expect(oauth.getAccessToken(AGENT_ID, SERVER)).toBeUndefined();
  });

  it('re-warms a still-live token as live (proving warm actually primes)', async () => {
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    // Absolute expiry in the future relative to the cache clock (5000).
    await seedStoredToken(dorkHome, 9_000_000);
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: mockOAuthFetch({ challenge: '' }),
      cache: { now: () => 5000, scheduler: inertScheduler },
    });

    await oauth.warm([TARGET]);
    expect(oauth.getAccessToken(AGENT_ID, SERVER)).toBe('restored-token');
  });
});
