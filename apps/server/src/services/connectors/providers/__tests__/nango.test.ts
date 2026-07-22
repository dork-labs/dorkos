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
} from '../nango-client.js';
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

function makeProvider(): NangoConnectorProvider {
  return new NangoConnectorProvider({ client: new FakeNangoClient() });
}

// The self-host adapter clears the same behavioral gate every backend does.
// Multi-account (supportsMultiAccount:true), so the suite's two-distinct-ids
// branch runs. Because exposesOverMcp is false, the suite asserts a healthy
// account resolves null; the required unexposable case does too.
connectorConformance(makeProvider, {
  name: 'NangoConnectorProvider — conformance',
  toolkit: 'gmail',
  makeUnexposableAccount: async () => {
    const client = new FakeNangoClient();
    const provider = new NangoConnectorProvider({ client });
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const { account } = await provider.pollConnect(flowId);
    // Expire the connection so its status is unexposable too; toolServerForAccount
    // must resolve null (it always does under exposesOverMcp:false) rather than throw.
    client.setStatus(toNangoConnectionId(account!.id), 'EXPIRED');
    return { provider, accountId: account!.id };
  },
});

describe('NangoConnectorProvider — self-host-custody semantics', () => {
  it('declares the self-host, multi-account, NON-MCP-exposing capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: 'nango',
      supportsMultiAccount: true,
      custody: 'self-host',
      // The honest scope: free Auth+Proxy Nango has no MCP server to expose.
      exposesOverMcp: false,
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

  it('never exposes a tool server (exposesOverMcp:false) — always null, even when healthy', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const account = (await provider.pollConnect(flowId)).account!;

    // A perfectly healthy account still resolves null: the Proxy→MCP wrapper does
    // not exist yet and Nango's own MCP server is never depended on.
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
describe('NangoConnectorProvider — throw-free degrade on transport failure', () => {
  const errors: Array<{ label: string; err: () => Error }> = [
    { label: 'NangoApiError 401 (stale key)', err: () => new NangoApiError(401, 'unauthorized') },
    {
      label: 'NangoApiError 500 (server error)',
      err: () => new NangoApiError(500, 'server error'),
    },
    { label: 'AbortError (fetch timeout)', err: abortError },
  ];

  for (const { label, err } of errors) {
    it(`listToolkits returns empty on ${label}`, async () => {
      const client = new FakeNangoClient();
      client.failWith(err());
      const provider = new NangoConnectorProvider({ client });
      await expect(provider.listToolkits()).resolves.toEqual([]);
    });

    it(`listAccounts returns empty on ${label}`, async () => {
      const client = new FakeNangoClient();
      client.failWith(err());
      const provider = new NangoConnectorProvider({ client });
      await expect(provider.listAccounts()).resolves.toEqual([]);
    });

    it(`pollConnect maps ${label} to a failure-typed result`, async () => {
      const client = new FakeNangoClient();
      client.failWith(err());
      const provider = new NangoConnectorProvider({ client });
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
    };
    const provider = new NangoConnectorProvider({ client });
    await expect(provider.startConnect('gmail')).rejects.toThrow(/no authorize URL/);
  });

  it('does NOT swallow a non-transport error (a genuine bug still surfaces)', async () => {
    const client = new FakeNangoClient();
    client.failWith(new TypeError('bug in mapping'));
    const provider = new NangoConnectorProvider({ client });
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
      credentials: fakeCredentials({}),
      baseUrl: 'http://localhost:3003',
      encryptionKey: VALID_ENCRYPTION_KEY,
    });
    expect(provider).toBeNull();
  });

  it('returns null when the base URL is absent (connector not configured)', async () => {
    const provider = await maybeCreateNangoProvider({
      credentials: fakeCredentials({ [NANGO_SECRET_KEY_REF]: 'sk-nango-test' }),
      encryptionKey: VALID_ENCRYPTION_KEY,
    });
    expect(provider).toBeNull();
  });

  it('REFUSES (throws) when configured but NANGO_ENCRYPTION_KEY is missing', async () => {
    await expect(
      maybeCreateNangoProvider({
        credentials: fakeCredentials({ [NANGO_SECRET_KEY_REF]: 'sk-nango-test' }),
        baseUrl: 'http://localhost:3003',
      })
    ).rejects.toThrow(NangoEncryptionKeyError);
  });

  it('builds the provider when configured with a valid key, holding the key only in the client', async () => {
    let seenKey: string | undefined;
    let seenBaseUrl: string | undefined;
    const provider = await maybeCreateNangoProvider({
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
