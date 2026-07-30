import { describe, expect, it } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import type {
  CredentialProvider,
  CredentialResolution,
} from '../../../core/credential-provider.js';
import {
  NangoApiError,
  type NangoConnection,
  type NangoConnectionRequest,
  type NangoConnectionState,
  type NangoConnectionStatus,
  type NangoHttpClient,
  type NangoIntegration,
  type NangoProxyRequest,
  type NangoProxyResponse,
} from '../nango-client.js';
import { NangoProxyMcp } from '../nango-proxy-mcp.js';
import {
  NangoConnectorProvider,
  NangoEncryptionKeyError,
  NANGO_SECRET_KEY_REF,
  assertNangoEncryptionKey,
  maybeCreateNangoProvider,
  toConnectedAccountId,
  toNangoConnectionId,
} from '../nango.js';

/**
 * In-memory {@link NangoHttpClient} — the fake self-hosted Nango the provider is
 * verified against (no network, no key). Mints `connectionId`s, resolves connect
 * requests to ACTIVE on first poll, and lists/deletes connections. `setStatus`
 * drives the expired/revoked (unexposable) branch; `failWith` drives the
 * transport-degrade path.
 */
class FakeNangoClient implements NangoHttpClient {
  private readonly _connections = new Map<string, NangoConnection>();
  private readonly _requests = new Map<
    string,
    { integration: string; label?: string; connectionId?: string }
  >();
  private _counter = 0;
  private _failure: Error | null = null;

  private readonly _integrations: NangoIntegration[] = [
    { uniqueKey: 'gmail', provider: 'google-mail', displayName: 'Gmail', authMode: 'OAUTH2' },
    { uniqueKey: 'slack', provider: 'slack', displayName: 'Slack', authMode: 'OAUTH2' },
  ];

  listIntegrations(): Promise<NangoIntegration[]> {
    if (this._failure) return Promise.reject(this._failure);
    return Promise.resolve([...this._integrations]);
  }

  initiateConnection(input: {
    integration: string;
    label?: string;
  }): Promise<NangoConnectionRequest> {
    if (this._failure) return Promise.reject(this._failure);
    this._counter += 1;
    const connectionRequestId = `cs_${this._counter}`;
    this._requests.set(connectionRequestId, {
      integration: input.integration,
      label: input.label,
    });
    return Promise.resolve({
      connectionRequestId,
      authorizeUrl: `https://connect.nango.test?connect_session_token=${connectionRequestId}`,
    });
  }

  getConnectionState(connectionRequestId: string): Promise<NangoConnectionState> {
    if (this._failure) return Promise.reject(this._failure);
    const request = this._requests.get(connectionRequestId);
    if (!request) {
      return Promise.resolve({
        status: 'ERROR',
        error: `unknown request '${connectionRequestId}'`,
      });
    }
    if (!request.connectionId) {
      this._counter += 1;
      const connectionId = `conn_${this._counter}`;
      this._connections.set(connectionId, {
        connectionId,
        integration: request.integration,
        ...(request.label && { label: request.label }),
        status: 'ACTIVE',
      });
      request.connectionId = connectionId;
    }
    const connection = this._connections.get(request.connectionId);
    if (!connection || connection.status !== 'ACTIVE') {
      return Promise.resolve({ status: connection?.status ?? 'ERROR' });
    }
    return Promise.resolve({ status: 'ACTIVE', connection });
  }

  listConnections(opts?: { integration?: string }): Promise<NangoConnection[]> {
    if (this._failure) return Promise.reject(this._failure);
    const all = [...this._connections.values()];
    return Promise.resolve(
      opts?.integration ? all.filter((c) => c.integration === opts.integration) : all
    );
  }

  deleteConnection(connectionId: string): Promise<void> {
    // Idempotent — deleting an unknown id is a no-op (mirrors the real 404 swallow).
    this._connections.delete(connectionId);
    return Promise.resolve();
  }

  proxyRequest(_input: NangoProxyRequest): Promise<NangoProxyResponse> {
    if (this._failure) return Promise.reject(this._failure);
    return Promise.resolve({ status: 200, body: '{"ok":true}' });
  }

  /** Force a connection's Nango status (drives the expired/revoked branch). */
  setStatus(connectionId: string, status: NangoConnectionStatus): void {
    const connection = this._connections.get(connectionId);
    if (connection) connection.status = status;
  }

  /** Make every Nango call reject with `err` (drives the transport-degrade path). */
  failWith(err: Error | null): void {
    this._failure = err;
  }
}

/** Build an AbortError like a `fetch` timeout raises (matched by name, not type). */
function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** A valid 256-bit key written in base64 (32 zero bytes) for the enforced gate. */
const VALID_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');

/** A fresh Proxy→MCP wrapper for one provider under test. */
function makeProxy(): NangoProxyMcp {
  return new NangoProxyMcp({ localOrigin: 'http://127.0.0.1:4242' });
}

function makeProvider(): NangoConnectorProvider {
  return new NangoConnectorProvider({ client: new FakeNangoClient(), proxy: makeProxy() });
}

// The self-host adapter clears the same behavioral gate every backend does.
// Multi-account (supportsMultiAccount:true), so the suite's two-distinct-ids
// branch runs. With exposesOverMcp:true (DOR-415), the suite runs the TRUE
// branch: a healthy account must expose a well-formed MCP connection, and the
// required unexposable case still resolves null.
connectorConformance(makeProvider, {
  name: 'NangoConnectorProvider — conformance',
  toolkit: 'gmail',
  makeUnexposableAccount: async () => {
    const client = new FakeNangoClient();
    const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const { account } = await provider.pollConnect(flowId);
    // Expire the connection: a non-ACTIVE account must resolve null (the
    // documented null branch), never throw.
    client.setStatus(toNangoConnectionId(account!.id), 'EXPIRED');
    return { provider, accountId: account!.id };
  },
});

describe('NangoConnectorProvider — self-host-custody semantics', () => {
  it('declares the self-host, multi-account, MCP-exposing capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: 'nango',
      supportsMultiAccount: true,
      custody: 'self-host',
      // Tools ride the DorkOS Proxy→MCP wrapper (DOR-415), never Nango's
      // Enterprise-gated MCP server.
      exposesOverMcp: true,
    });
  });

  it('wraps the Nango connectionId as an opaque, provider-scoped id and back', () => {
    const id = toConnectedAccountId('conn_abc123');
    expect(id).toBe('nango:conn_abc123');
    expect(toNangoConnectionId(id)).toBe('conn_abc123');
  });

  it('carries the connect label as the connection tag and echoes self-host custody', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });
    const poll = await provider.pollConnect(flowId);

    expect(poll.status).toBe('connected');
    expect(poll.account?.label).toBe('work');
    expect(poll.account?.custody).toBe('self-host');
    expect(poll.account?.provider).toBe('nango');
    // No raw connectionId leaks past the port — the id is the wrapped form.
    expect(poll.account?.id.startsWith('nango:')).toBe(true);
  });

  it('yields two distinct, independently-addressable ids for two connects of one integration', async () => {
    const provider = makeProvider();

    const first = await provider.startConnect('gmail', { label: 'personal' });
    const personal = (await provider.pollConnect(first.flowId)).account!;
    const second = await provider.startConnect('gmail', { label: 'work' });
    const work = (await provider.pollConnect(second.flowId)).account!;

    expect(personal.id).not.toBe(work.id);
    const accounts = await provider.listAccounts({ toolkit: 'gmail' });
    expect(new Set(accounts.map((a) => a.id)).size).toBe(2);
  });

  it('exposes an ACTIVE account as the wrapper connection (bearer-gated local endpoint)', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const account = (await provider.pollConnect(flowId)).account!;

    const connection = await provider.toolServerForAccount(account.id);
    expect(connection).not.toBeNull();
    expect(connection).toMatchObject({ transport: 'http' });
    const http = connection as { url: string; headers?: Record<string, string> };
    // The wrapper's local endpoint, addressed by the opaque account id…
    expect(http.url).toBe(
      `http://127.0.0.1:4242/api/connectors/nango/mcp/${encodeURIComponent(account.id)}`
    );
    // …gated by a per-account bearer token (never the Nango secret key).
    expect(http.headers?.authorization).toMatch(/^Bearer [0-9a-f]{64}$/);
  });

  it('resolves null for a non-ACTIVE account (the documented null branch)', async () => {
    const client = new FakeNangoClient();
    const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const account = (await provider.pollConnect(flowId)).account!;

    client.setStatus(toNangoConnectionId(account.id), 'EXPIRED');
    await expect(provider.toolServerForAccount(account.id)).resolves.toBeNull();
  });

  it('resolves null on a transport failure while resolving the account, never a throw', async () => {
    const client = new FakeNangoClient();
    const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const account = (await provider.pollConnect(flowId)).account!;

    client.failWith(new NangoApiError(401, 'unauthorized'));
    await expect(provider.toolServerForAccount(account.id)).resolves.toBeNull();
  });

  it('surfaces a failed Nango connect as a typed failure, never a throw', async () => {
    const provider = makeProvider();
    const poll = await provider.pollConnect('cs_does_not_exist');
    expect(poll.status).toBe('failed');
    expect(poll.error).toBeTruthy();
  });

  it('disconnect is idempotent for an unknown/already-revoked id', async () => {
    const provider = makeProvider();
    await expect(
      provider.disconnect('nango:conn_nope' as ConnectedAccountId)
    ).resolves.toBeUndefined();
  });
});

// The mock suite structurally can't catch this: the fake client never errors on
// its own, so these lock the degrade contract by forcing the client to reject.
describe('NangoConnectorProvider — degrade contract on transport failure', () => {
  const errors: Array<{ label: string; err: () => Error }> = [
    { label: 'NangoApiError 401 (stale key)', err: () => new NangoApiError(401, 'unauthorized') },
    {
      label: 'NangoApiError 500 (server error)',
      err: () => new NangoApiError(500, 'server error'),
    },
    { label: 'AbortError (fetch timeout)', err: abortError },
  ];

  for (const { label, err } of errors) {
    it(`listToolkits PROPAGATES ${label} (the registry turns it into a warning)`, async () => {
      const client = new FakeNangoClient();
      client.failWith(err());
      const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
      await expect(provider.listToolkits()).rejects.toThrow();
    });

    it(`listAccounts PROPAGATES ${label} (never a silent empty list)`, async () => {
      const client = new FakeNangoClient();
      client.failWith(err());
      const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
      await expect(provider.listAccounts()).rejects.toThrow();
    });

    it(`pollConnect maps ${label} to a failure-typed result`, async () => {
      const client = new FakeNangoClient();
      client.failWith(err());
      const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
      const poll = await provider.pollConnect('cs_anything');
      expect(poll.status).toBe('failed');
      expect(poll.error).toBeTruthy();
    });
  }

  it('startConnect throws a typed error when Nango returns no authorize URL', async () => {
    const client: NangoHttpClient = {
      listIntegrations: () =>
        Promise.resolve([{ uniqueKey: 'gmail', provider: 'google-mail', authMode: 'OAUTH2' }]),
      initiateConnection: () => Promise.resolve({ connectionRequestId: 'cs_1', authorizeUrl: '' }),
      getConnectionState: () => Promise.resolve({ status: 'PENDING' }),
      listConnections: () => Promise.resolve([]),
      deleteConnection: () => Promise.resolve(),
      proxyRequest: () => Promise.resolve({ status: 200, body: '' }),
    };
    const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
    await expect(provider.startConnect('gmail')).rejects.toThrow(/no authorize URL/);
  });

  it('does NOT swallow a non-transport error (a genuine bug still surfaces)', async () => {
    const client = new FakeNangoClient();
    client.failWith(new TypeError('bug in mapping'));
    const provider = new NangoConnectorProvider({ client, proxy: makeProxy() });
    await expect(provider.listToolkits()).rejects.toThrow(/bug in mapping/);
  });
});

describe('assertNangoEncryptionKey — the enforced 256-bit-key gate', () => {
  it('accepts a valid 256-bit base64 key', () => {
    expect(() => assertNangoEncryptionKey(VALID_ENCRYPTION_KEY)).not.toThrow();
  });

  it('refuses a missing key with a helpful, secret-free error', () => {
    expect(() => assertNangoEncryptionKey(undefined)).toThrow(NangoEncryptionKeyError);
    expect(() => assertNangoEncryptionKey('')).toThrow(/NANGO_ENCRYPTION_KEY is not set/);
  });

  it('refuses a key of the wrong length (not 256-bit)', () => {
    const shortKey = Buffer.alloc(16).toString('base64');
    expect(() => assertNangoEncryptionKey(shortKey)).toThrow(/256-bit/);
  });
});

describe('maybeCreateNangoProvider — the configured-only registry gate', () => {
  /** A credential provider that resolves exactly the refs it is seeded with. */
  function fakeCredentials(resolved: Record<string, string>): CredentialProvider {
    return {
      resolve(ref: string): Promise<CredentialResolution> {
        const secret = resolved[ref];
        if (secret === undefined) {
          return Promise.resolve({ ok: false, reason: 'unresolved', ref, message: 'absent' });
        }
        return Promise.resolve({ ok: true, secret });
      },
    };
  }

  it('returns null when the secret key is unconfigured (dangling reference)', async () => {
    const provider = await maybeCreateNangoProvider({
      proxy: makeProxy(),
      credentials: fakeCredentials({}),
      baseUrl: 'http://localhost:3003',
      encryptionKey: VALID_ENCRYPTION_KEY,
    });
    expect(provider).toBeNull();
  });

  it('returns null when the base URL is absent (connector not configured)', async () => {
    const provider = await maybeCreateNangoProvider({
      proxy: makeProxy(),
      credentials: fakeCredentials({ [NANGO_SECRET_KEY_REF]: 'sk-nango-test' }),
      encryptionKey: VALID_ENCRYPTION_KEY,
    });
    expect(provider).toBeNull();
  });

  it('REFUSES (throws) when configured but NANGO_ENCRYPTION_KEY is missing', async () => {
    await expect(
      maybeCreateNangoProvider({
        proxy: makeProxy(),
        credentials: fakeCredentials({ [NANGO_SECRET_KEY_REF]: 'sk-nango-test' }),
        baseUrl: 'http://localhost:3003',
      })
    ).rejects.toThrow(NangoEncryptionKeyError);
  });

  it('builds the provider when configured with a valid key, holding the key only in the client', async () => {
    let seenKey: string | undefined;
    let seenBaseUrl: string | undefined;
    const provider = await maybeCreateNangoProvider({
      proxy: makeProxy(),
      credentials: fakeCredentials({ [NANGO_SECRET_KEY_REF]: 'sk-nango-test' }),
      baseUrl: 'http://localhost:3003',
      encryptionKey: VALID_ENCRYPTION_KEY,
      makeClient: (opts) => {
        seenKey = opts.secretKey;
        seenBaseUrl = opts.baseUrl;
        return new FakeNangoClient();
      },
    });

    expect(provider).toBeInstanceOf(NangoConnectorProvider);
    expect(provider?.type).toBe('nango');
    // The resolved key + base URL reach the HTTP client seam, not the provider surface.
    expect(seenKey).toBe('sk-nango-test');
    expect(seenBaseUrl).toBe('http://localhost:3003');
  });
});
