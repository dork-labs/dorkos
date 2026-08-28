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
    workspace: { mode: 'home' },
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
    expect((await oauth.pollSignin(started.flowId)).status).toBe('pending');
    // Token withheld until the flow completes.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();

    // The mock validates PKCE against the challenge the SDK put in the authorize URL.
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';
    expect(pkce.challenge).not.toBe('');

    // 2. The browser (auto-approved) redirects to the loopback callback with code+state.
    const cb = await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
    expect(cb).toEqual({ connected: true, serverName: SERVER });
    expect((await oauth.pollSignin(started.flowId)).status).toBe('connected');

    // 3. The access token is now readable SYNCHRONOUSLY (the injection read path).
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');

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
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
  });
});

describe('AgentMcpOAuthService.warm — restart staleness (B2)', () => {
  const TARGET = { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL };

  /** Persist a token record directly, stamping the ABSOLUTE `expiresAt` a real save would. */
  async function seedStoredToken(
    dorkHome: string,
    expiresAt: number,
    serverUrl: string | undefined = SERVER_URL
  ): Promise<void> {
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
        ...(serverUrl === undefined ? {} : { serverUrl }),
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
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
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
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('restored-token');
  });

  it('drops a stored token that was minted for a different url, and deletes it', async () => {
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    // Live by the clock, but issued for a server this name no longer points at —
    // the manifest was edited while the process was down.
    await seedStoredToken(dorkHome, 9_000_000, 'https://old-server.example/mcp');
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: mockOAuthFetch({ challenge: '' }),
      cache: { now: () => 5000, scheduler: inertScheduler },
    });

    await oauth.warm([TARGET]);

    // Reverting the `tokens.serverUrl !== target.serverUrl` guard in
    // `primeFromStore` caches a bearer for the wrong server and reddens this.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
    // And it is gone from disk, not merely withheld — otherwise it would be
    // re-evaluated (and re-refreshed) on every restart forever.
    resetKeyCache();
    const store = new ExtensionSecretStore('mcp-oauth', dorkHome);
    expect(await store.get(`${AGENT_ID}:${SERVER}:tokens`)).toBeNull();
  });
});
/**
 * A mock OAuth server for the refresh path, recording every token-endpoint form
 * it receives and letting a case choose what the refresh grant answers with.
 */
function refreshMock(options: {
  /** Recorded token-endpoint request bodies, in order. */
  seen: URLSearchParams[];
  /** What the refresh grant answers; defaults to a fresh token. */
  respond?: (call: number) => Response | Promise<Response>;
  /** Whether the server publishes RFC 9728 resource metadata (the `resource` source). */
  protectedResource?: boolean;
  /** Called on entry/exit of the token endpoint, for overlap checks. */
  trace?: (event: string) => void;
}): typeof fetch {
  const { seen, respond, protectedResource = true, trace } = options;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.includes('oauth-protected-resource')) {
      return protectedResource
        ? json({ resource: SERVER_URL, authorization_servers: [ORIGIN] })
        : new Response('not found', { status: 404 });
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
      return json({
        client_id: 'test-client-id',
        redirect_uris: [`${CALLBACK_BASE}/api/agents/mcp-oauth/callback`],
        token_endpoint_auth_method: 'none',
      });
    }
    if (method === 'POST' && url.endsWith('/token')) {
      trace?.('token:enter');
      seen.push(new URLSearchParams(String(init?.body)));
      const response =
        (await respond?.(seen.length)) ??
        json({
          access_token: `access-${seen.length + 1}`,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-next',
        });
      trace?.('token:exit');
      return response;
    }
    return new Response('not found', { status: 404 });
  };
}

/** Seed a signed-in server: a stored token set plus its client registration. */
async function seedSignedIn(dorkHome: string, serverUrl = SERVER_URL): Promise<void> {
  resetKeyCache();
  const store = new ExtensionSecretStore('mcp-oauth', dorkHome);
  await store.set(
    `${AGENT_ID}:${SERVER}:client`,
    JSON.stringify({
      client_id: 'test-client-id',
      redirect_uris: [`${CALLBACK_BASE}/api/agents/mcp-oauth/callback`],
    })
  );
  await store.set(
    `${AGENT_ID}:${SERVER}:tokens`,
    JSON.stringify({
      access_token: 'access-1',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-1',
      expiresAt: Date.now() + 3_600_000,
      serverUrl,
    })
  );
  resetKeyCache();
}

/** A service over a throwaway dorkHome, with the backoff wired to never wait. */
async function makeService(
  fetchImpl: typeof fetch,
  delays: number[] = []
): Promise<{ oauth: AgentMcpOAuthService; dorkHome: string }> {
  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
  tempDirs.push(dorkHome);
  return {
    dorkHome,
    oauth: new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl,
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
      sleep: async (ms) => {
        delays.push(ms);
      },
    }),
  };
}

const REFRESH_TARGET = {
  agentId: AGENT_ID,
  serverName: SERVER,
  serverUrl: SERVER_URL,
};

describe('AgentMcpOAuthService.refreshNow — the refresh request itself (DOR-986)', () => {
  it('sends the RFC 8707 `resource` the initial exchange sent, and rotates the cached token', async () => {
    const seen: URLSearchParams[] = [];
    const { oauth, dorkHome } = await makeService(refreshMock({ seen }));
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');

    expect(await oauth.refreshNow(REFRESH_TARGET)).toBe(true);

    expect(seen).toHaveLength(1);
    // The whole point: the hand-rolled `refreshAuthorization` call this replaced
    // sent grant_type/refresh_token/client_id and NOTHING ELSE, so an
    // audience-restricted server either rejected the refresh outright
    // (`invalid_target`) or minted a token for the wrong audience about an hour
    // after every sign-in. Deleting `resource` from the outgoing form reddens this.
    expect(Object.fromEntries(seen[0]!)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'test-client-id',
      resource: SERVER_URL,
    });
    // And the rotation actually landed in the cache the injection path reads.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-2');
  });

  it('omits `resource` when the server publishes no protected-resource metadata', async () => {
    const seen: URLSearchParams[] = [];
    const { oauth, dorkHome } = await makeService(refreshMock({ seen, protectedResource: false }));
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);

    expect(await oauth.refreshNow(REFRESH_TARGET)).toBe(true);
    // The discriminator against hardcoding `resource`: RFC 8707 says send it only
    // when the resource server declares itself, and some servers reject unknown params.
    expect(seen[0]!.has('resource')).toBe(false);
  });

  it('retries a transport failure and keeps the token when a retry succeeds', async () => {
    const seen: URLSearchParams[] = [];
    const delays: number[] = [];
    const { oauth, dorkHome } = await makeService(
      refreshMock({
        seen,
        respond: (call) => {
          if (call === 1) throw new TypeError('fetch failed');
          return json({
            access_token: 'access-after-retry',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-next',
          });
        },
      }),
      delays
    );
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);

    expect(await oauth.refreshNow(REFRESH_TARGET)).toBe(true);

    // Reverting to evict-on-first-failure drops the token here — the
    // boot-while-offline case where every OAuth server dies until a restart.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-after-retry');
    expect(delays).toEqual([1000]);
  });

  it('gives up immediately on a revoked grant, evicting rather than retrying', async () => {
    const seen: URLSearchParams[] = [];
    const delays: number[] = [];
    const { oauth, dorkHome } = await makeService(
      refreshMock({
        seen,
        respond: () => json({ error: 'invalid_grant', error_description: 'revoked' }, 400),
      }),
      delays
    );
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);

    expect(await oauth.refreshNow(REFRESH_TARGET)).toBe(false);

    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
    // The discriminator against retrying everything: a revoked grant will not
    // un-revoke, so there is no backoff and no second refresh presentation.
    expect(delays).toEqual([]);
    expect(seen.map((s) => s.get('grant_type'))).toEqual(['refresh_token']);
  });
});

describe('AgentMcpOAuthService — signing in again after the grant was revoked (DOR-986)', () => {
  it('produces a fresh sign-in link instead of failing forever', async () => {
    const seen: URLSearchParams[] = [];
    const { oauth, dorkHome } = await makeService(
      refreshMock({
        seen,
        respond: () => json({ error: 'invalid_grant', error_description: 'revoked' }, 400),
      })
    );
    await seedSignedIn(dorkHome);

    const started = await oauth.startSignin(REFRESH_TARGET);

    // Without `invalidateCredentials` on the provider this call THROWS
    // InvalidGrantError — the operator's only recovery was to delete the server.
    expect(started.alreadyConnected).toBe(false);
    expect(started.authorizeUrl).toContain(`${ORIGIN}/authorize`);
  });
});

/** A promise and its resolver — for gating on a real event instead of a sleep. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('AgentMcpOAuthService — concurrent sign-in and refresh (DOR-986)', () => {
  it('never has two token requests for one server in flight at once', async () => {
    const seen: URLSearchParams[] = [];
    const trace: string[] = [];
    // Gated on the refresh actually reaching the token endpoint — not on a timer,
    // which would only ever be a guess about how far the other call had got.
    const refreshInside = deferred();
    const held = deferred();

    const { oauth, dorkHome } = await makeService(
      refreshMock({
        seen,
        trace: (event) => {
          trace.push(event);
          if (event === 'token:enter' && trace.length === 1) refreshInside.resolve();
        },
        respond: async (call) => {
          if (call === 1) await held.promise;
          return json({
            access_token: `access-${call + 1}`,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-next',
          });
        },
      })
    );
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);

    const refreshing = oauth.refreshNow(REFRESH_TARGET);
    const signingIn = oauth.startSignin(REFRESH_TARGET);
    // The refresh is now provably inside the token endpoint, and the sign-in has
    // been running long enough to have made its own request if nothing stopped it.
    await refreshInside.promise;
    held.resolve();
    await Promise.all([refreshing, signingIn]);

    // Removing the shared lock interleaves these as
    // ['token:enter', 'token:enter', 'token:exit', 'token:exit'] — two
    // presentations of the same refresh token, which a rotating-refresh-token
    // issuer treats as a replay and answers by revoking the whole grant family.
    expect(trace).toEqual(['token:enter', 'token:exit', 'token:enter', 'token:exit']);
  });

  it('holds a server removal until the refresh already on the wire has finished', async () => {
    const seen: URLSearchParams[] = [];
    const refreshInside = deferred();
    const held = deferred();
    const { oauth, dorkHome } = await makeService(
      refreshMock({
        seen,
        trace: (event) => {
          if (event === 'token:enter') refreshInside.resolve();
        },
        respond: async () => {
          await held.promise;
          return json({
            access_token: 'refreshed-after-removal',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-2',
          });
        },
      })
    );
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);

    const refreshing = oauth.refreshNow(REFRESH_TARGET);
    await refreshInside.promise;
    const forgetting = oauth.forgetServer(AGENT_ID, SERVER);

    // A synchronous probe, no waiting involved: evicting the cached token is
    // `forgetServer`'s first act, so if it were not serialized it would already
    // have happened by now — and its disk delete would then land BEFORE the
    // in-flight refresh writes a brand-new access + refresh token back for a
    // server the operator just removed. Dropping the `exclusive` wrapper reddens
    // this line.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');

    held.resolve();
    await Promise.all([refreshing, forgetting]);

    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
    resetKeyCache();
    const store = new ExtensionSecretStore('mcp-oauth', dorkHome);
    // The consequence that matters: nothing survives on disk. The refresh really
    // did complete (it is what the removal waited for), so this is not the
    // trivially-clean case.
    expect(seen).toHaveLength(1);
    expect(await store.get(`${AGENT_ID}:${SERVER}:tokens`)).toBeNull();
    expect(await store.get(`${AGENT_ID}:${SERVER}:client`)).toBeNull();
  });
});

describe('AgentMcpOAuthService.handleCallback — a reloaded callback page (DOR-986)', () => {
  it('keeps a connected flow connected when the callback is replayed CONCURRENTLY', async () => {
    const pkce = { challenge: '' };
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    const exchangeInside = deferred();
    const held = deferred();
    let tokenCalls = 0;
    const inner = mockOAuthFetch(pkce);
    // Holds the FIRST code→token exchange open, which is the real-world window:
    // the exchange is a network round trip, and a browser reload lands inside it.
    const gated: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if ((init?.method ?? 'GET') === 'POST' && url.endsWith('/token')) {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          exchangeInside.resolve();
          await held.promise;
        }
      }
      return inner(input, init);
    };

    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: gated,
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
    });
    const started = await oauth.startSignin(REFRESH_TARGET);
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';

    const first = oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
    await exchangeInside.promise;
    // The reload. Its already-connected check runs synchronously, right now, while
    // the first exchange is still on the wire and the flow is still `pending` — so
    // an early return placed only OUTSIDE the lock cannot catch it. The second
    // call then runs the exchange with a spent one-shot verifier, throws, and
    // `markFailed` overwrites `connected`.
    const second = oauth.handleCallback({ state: started.flowId, code: AUTH_CODE });
    held.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ connected: true, serverName: SERVER });
    // Moving the inner re-check back outside the `exclusive` block reddens this.
    expect(secondResult).toEqual({ connected: true, serverName: SERVER });
    // What the operator actually sees: the poll must not say the sign-in failed
    // while its token is live and injecting.
    expect((await oauth.pollSignin(started.flowId)).status).toBe('connected');
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');
  });

  it('keeps a connected flow connected when the callback is replayed', async () => {
    const pkce = { challenge: '' };
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: mockOAuthFetch(pkce),
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
    });
    const started = await oauth.startSignin(REFRESH_TARGET);
    pkce.challenge = new URL(started.authorizeUrl!).searchParams.get('code_challenge') ?? '';
    expect(await oauth.handleCallback({ state: started.flowId, code: AUTH_CODE })).toEqual({
      connected: true,
      serverName: SERVER,
    });

    // The operator hits reload on the "Signed in" page.
    const replay = await oauth.handleCallback({
      state: started.flowId,
      code: AUTH_CODE,
    });

    // Without the already-connected early return, the one-shot PKCE verifier is
    // gone, the exchange throws, and `markFailed` overwrites `connected` — so a
    // successful sign-in reported itself as failed while the token still worked.
    expect(replay).toEqual({ connected: true, serverName: SERVER });
    expect((await oauth.pollSignin(started.flowId)).status).toBe('connected');
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');
  });
});

describe('AgentMcpOAuthService — forgetting credentials (DOR-986)', () => {
  it('forgetServer drops the stored token, the registration, and the cached bearer', async () => {
    const { oauth, dorkHome } = await makeService(refreshMock({ seen: [] }));
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('access-1');

    await oauth.forgetServer(AGENT_ID, SERVER);

    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
    resetKeyCache();
    const store = new ExtensionSecretStore('mcp-oauth', dorkHome);
    // Reverting `forgetServer` to a cache-only eviction leaves the encrypted
    // token and refresh token on disk after the operator removed the server.
    expect(await store.get(`${AGENT_ID}:${SERVER}:tokens`)).toBeNull();
    expect(await store.get(`${AGENT_ID}:${SERVER}:client`)).toBeNull();
  });

  it('forgetAgent sweeps the agent’s credentials without naming its servers', async () => {
    const { oauth, dorkHome } = await makeService(refreshMock({ seen: [] }));
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);

    await oauth.forgetAgent(AGENT_ID);

    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
    resetKeyCache();
    const store = new ExtensionSecretStore('mcp-oauth', dorkHome);
    expect(await store.get(`${AGENT_ID}:${SERVER}:tokens`)).toBeNull();
    expect(await store.get(`${AGENT_ID}:${SERVER}:client`)).toBeNull();
  });
});

describe('AgentMcpOAuthService — the hardening the DOR-986 review asked for', () => {
  it('warm waits for a refresh already on the wire, like every other writer', async () => {
    // `warm` used to prime the cache OUTSIDE the target's lock, on the argument
    // that boot is quiet. That argument is about WHEN warm is called, not about
    // what it does — and `primeFromStore` can delete credentials, which is the
    // one thing `forgetServerUnlocked` insists the caller be holding the lock
    // for. Serializing it turns "every caller holds the lock" from an argument
    // into a property. Reverting to a bare `primeFromStore` interleaves these.
    const seen: URLSearchParams[] = [];
    const refreshInside = deferred();
    const held = deferred();
    const order: string[] = [];

    const { oauth, dorkHome } = await makeService(
      refreshMock({
        seen,
        trace: (event) => {
          if (event === 'token:enter') refreshInside.resolve();
        },
        respond: async () => {
          await held.promise;
          return json({
            access_token: 'access-2',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-2',
          });
        },
      })
    );
    await seedSignedIn(dorkHome);
    await oauth.warm([REFRESH_TARGET]);

    const refreshing = oauth.refreshNow(REFRESH_TARGET).then(() => order.push('refresh'));
    // Provably inside the token endpoint before warm is asked for the same target.
    await refreshInside.promise;
    const warming = oauth.warm([REFRESH_TARGET]).then(() => order.push('warm'));
    // Long enough for an unlocked warm — a disk read — to have finished twice over.
    await new Promise((resolve) => setTimeout(resolve, 10));
    held.resolve();
    await Promise.all([refreshing, warming]);

    expect(order).toEqual(['refresh', 'warm']);
  });

  it('bounds a hanging OAuth request end-to-end, not just in the wrapper', async () => {
    // The ceiling was only ever unit-tested on `withRequestTimeout` itself, so
    // dropping the wrapper from the constructor reddened nothing while leaving a
    // hung token endpoint able to hold a target's lock forever. This drives the
    // ENGINE: a fetch that answers nothing and only settles when aborted. With
    // the ceiling wired the sign-in fails fast; without it, it never returns and
    // this test dies on the runner's own timeout — which is the red.
    const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-home-'));
    tempDirs.push(dorkHome);
    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const oauth = new AgentMcpOAuthService({
      dorkHome,
      callbackBaseUrl: CALLBACK_BASE,
      fetchImpl: hangingFetch,
      cache: { scheduler: inertScheduler },
      logger: { warn: () => {} },
      sleep: async () => {},
      requestTimeoutMs: 25,
    });

    await expect(oauth.startSignin(REFRESH_TARGET)).rejects.toThrow();
    // And the lock it held is free again, which is the point of bounding it.
    await expect(oauth.startSignin(REFRESH_TARGET)).rejects.toThrow();
  }, 2_000);
});
