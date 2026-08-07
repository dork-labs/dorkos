/**
 * Signing in to a provider that will not register DorkOS automatically (DOR-982),
 * driven through the REAL MCP SDK `auth()` over an in-process mock OAuth server.
 *
 * The whole fallback rests on one SDK behaviour that DorkOS does not control:
 * `auth()` calls `provider.clientInformation()` first and skips RFC 7591
 * registration entirely when it answers. That is pinned here against the real
 * `auth()` — a mock of our own provider would only prove what we already assume.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionSecretStore, resetKeyCache } from '@dorkos/shared/extension-secrets';

import { AgentMcpOAuthService } from '../agent-mcp-oauth-service.js';

const AGENT_ID = '01HV7KJZZZ0000000000000000';
const SERVER = 'granola';
const ORIGIN = 'https://mcp.test.local';
const SERVER_URL = `${ORIGIN}/mcp`;
const CALLBACK_BASE = 'http://127.0.0.1:4242';
const TARGET = { agentId: AGENT_ID, serverName: SERVER, serverUrl: SERVER_URL };

const tempDirs: string[] = [];
afterEach(async () => {
  resetKeyCache();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A scheduler that captures but never fires; background refresh is out of scope. */
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

/** What every request the mock server saw, so a test can assert one never happened. */
interface Seen {
  urls: string[];
}

/**
 * A mock OAuth provider that advertises a registration endpoint but REFUSES to
 * use it — the real-world shape of "you must pre-register your app with us".
 */
function refusingRegistrationFetch(seen: Seen): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    seen.urls.push(url);
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
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
    }
    if (method === 'POST' && url.endsWith('/register')) {
      return new Response('<html>Not Found</html>', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  };
}

/** A service over a throwaway dorkHome, wired to one mock provider. */
async function makeService(fetchImpl: typeof fetch): Promise<{
  oauth: AgentMcpOAuthService;
  dorkHome: string;
}> {
  const dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manual-client-'));
  tempDirs.push(dorkHome);
  const oauth = new AgentMcpOAuthService({
    dorkHome,
    callbackBaseUrl: CALLBACK_BASE,
    fetchImpl,
    cache: { scheduler: inertScheduler },
    logger: { warn: () => {} },
  });
  return { oauth, dorkHome };
}

/**
 * The raw encrypted record stored under one key, decrypted.
 *
 * A FRESH store instance every call, deliberately: `ExtensionSecretStore` caches
 * the decrypted map per instance, so a long-lived handle would keep answering
 * from before the service wrote — which is a stale reader, not a passing test.
 */
async function storedRecord(
  dorkHome: string,
  kind: 'client' | 'tokens'
): Promise<Record<string, unknown> | null> {
  const raw = await new ExtensionSecretStore('mcp-oauth', dorkHome).get(
    `${AGENT_ID}:${SERVER}:${kind}`
  );
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('operator-supplied app credentials', () => {
  it('makes the SDK skip registration entirely and sign in as the operator’s app', async () => {
    const seen: Seen = { urls: [] };
    const { oauth } = await makeService(refusingRegistrationFetch(seen));

    // Without credentials the provider's refusal is fatal — this is the state the
    // fallback exists to rescue.
    await expect(oauth.startSignin(TARGET)).rejects.toThrow();
    expect(seen.urls.some((u) => u.endsWith('/register'))).toBe(true);

    seen.urls.length = 0;
    await oauth.saveManualClientInfo(TARGET, {
      clientId: 'operator-app-id',
      clientSecret: 'operator-app-secret',
    });

    const started = await oauth.startSignin(TARGET);

    // The pin: `clientInformation()` answered, so `auth()` never asked to register.
    // Drop the `clientInformation()` read from the provider (or stop persisting
    // the manual record) and a /register hit reappears here.
    expect(seen.urls.some((u) => u.endsWith('/register'))).toBe(false);
    expect(started.alreadyConnected).toBe(false);
    const authorizeUrl = new URL(started.authorizeUrl ?? '');
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${ORIGIN}/authorize`);
    expect(authorizeUrl.searchParams.get('client_id')).toBe('operator-app-id');
    // The secret is a token-endpoint credential and must never ride the authorize
    // URL, which lands in the person's browser history.
    expect(started.authorizeUrl).not.toContain('operator-app-secret');
  });

  it('stores the credentials encrypted, marked as the operator’s own', async () => {
    const seen: Seen = { urls: [] };
    const { oauth, dorkHome } = await makeService(refusingRegistrationFetch(seen));

    await oauth.saveManualClientInfo(TARGET, {
      clientId: 'operator-app-id',
      clientSecret: 'operator-app-secret',
    });

    expect(await oauth.clientOrigin(AGENT_ID, SERVER)).toBe('manual');
    const record = await storedRecord(dorkHome, 'client');
    expect(record).toMatchObject({
      client_id: 'operator-app-id',
      client_secret: 'operator-app-secret',
      origin: 'manual',
    });

    // Encrypted at rest: the secret must not be readable in the store file.
    const onDisk = await fs.readFile(
      path.join(dorkHome, 'extension-secrets', 'mcp-oauth.json'),
      'utf8'
    );
    expect(onDisk).not.toContain('operator-app-secret');
    expect(onDisk).not.toContain('operator-app-id');
  });

  it('omits the secret when the provider issued none', async () => {
    const seen: Seen = { urls: [] };
    const { oauth, dorkHome } = await makeService(refusingRegistrationFetch(seen));

    await oauth.saveManualClientInfo(TARGET, { clientId: 'public-app' });

    const record = await storedRecord(dorkHome, 'client');
    expect(record).toMatchObject({ client_id: 'public-app', origin: 'manual' });
    expect(record).not.toHaveProperty('client_secret');
  });

  it('forgets the sign-in the old client identity earned', async () => {
    const seen: Seen = { urls: [] };
    const { oauth, dorkHome } = await makeService(refusingRegistrationFetch(seen));
    const store = new ExtensionSecretStore('mcp-oauth', dorkHome);

    // A server that HAD signed in under an automatic registration.
    await store.set(
      `${AGENT_ID}:${SERVER}:client`,
      JSON.stringify({ client_id: 'auto-registered', redirect_uris: [], origin: 'dcr' })
    );
    await store.set(
      `${AGENT_ID}:${SERVER}:tokens`,
      JSON.stringify({
        access_token: 'live-token',
        token_type: 'Bearer',
        refresh_token: 'live-refresh',
        serverUrl: SERVER_URL,
      })
    );
    await oauth.warm([TARGET]);
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBe('live-token');

    await oauth.saveManualClientInfo(TARGET, { clientId: 'operator-app-id' });

    // Dropping the eviction leaves the old bearer live in the cache AND on disk,
    // so the next turn would present a token minted for a client that no longer
    // exists — this is what reddens.
    expect(oauth.getAccessToken(AGENT_ID, SERVER, SERVER_URL)).toBeUndefined();
    expect(await storedRecord(dorkHome, 'tokens')).toBeNull();
    expect(await storedRecord(dorkHome, 'client')).toMatchObject({
      client_id: 'operator-app-id',
      origin: 'manual',
    });
  });

  it('retires a sign-in link already handed out for the old client', async () => {
    const seen: Seen = { urls: [] };
    const { oauth } = await makeService(refusingRegistrationFetch(seen));

    await oauth.saveManualClientInfo(TARGET, { clientId: 'first-app' });
    const first = await oauth.startSignin(TARGET);
    expect(oauth.liveSigninFor(AGENT_ID, SERVER)?.flowId).toBe(first.flowId);

    await oauth.saveManualClientInfo(TARGET, { clientId: 'second-app' });

    // The link in the person's tab authorizes `first-app`, which is no longer the
    // identity DorkOS holds. It must not be redeemable.
    expect(oauth.liveSigninFor(AGENT_ID, SERVER)).toBeUndefined();
    expect(await oauth.pollSignin(first.flowId)).toEqual({
      status: 'failed',
      error: 'This sign-in link expired. Please start again.',
    });
  });

  it('serializes against a concurrent operation on the same server', async () => {
    const order: string[] = [];
    let releaseSignin: (() => void) | undefined;
    const gated: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('oauth-protected-resource')) {
        order.push('signin:discovery');
        // Hold the sign-in inside the lock until the save has been asked for.
        await new Promise<void>((resolve) => {
          releaseSignin = resolve;
        });
      }
      return refusingRegistrationFetch({ urls: [] })(input, init);
    };
    const { oauth, dorkHome } = await makeService(gated);

    const signin = oauth.startSignin(TARGET).catch(() => 'failed' as const);
    // Let the sign-in reach its first request (and therefore hold the lock).
    await new Promise((resolve) => setImmediate(resolve));

    const save = oauth
      .saveManualClientInfo(TARGET, { clientId: 'operator-app-id' })
      .then(() => order.push('save:done'));
    await new Promise((resolve) => setImmediate(resolve));

    // The save must NOT have landed while the sign-in still holds the lock —
    // otherwise it would delete a registration the in-flight `auth()` is midway
    // through writing, and the two would interleave on one server's store.
    expect(order).toEqual(['signin:discovery']);
    expect(await storedRecord(dorkHome, 'client')).toBeNull();

    releaseSignin?.();
    await signin;
    await save;
    expect(order).toEqual(['signin:discovery', 'save:done']);
    expect(await oauth.clientOrigin(AGENT_ID, SERVER)).toBe('manual');
  });
});
