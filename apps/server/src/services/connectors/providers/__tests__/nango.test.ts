import { describe, expect, it } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
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

  /** The integration keys each connect was started with, in order. */
  readonly startedWith: string[] = [];

  constructor(
    private readonly _integrations: NangoIntegration[] = [
      { uniqueKey: 'gmail', provider: 'google-mail', displayName: 'Gmail', authMode: 'OAUTH2' },
      { uniqueKey: 'slack', provider: 'slack', displayName: 'Slack', authMode: 'OAUTH2' },
    ]
  ) {}

  listIntegrations(): Promise<NangoIntegration[]> {
    if (this._failure) return Promise.reject(this._failure);
    return Promise.resolve([...this._integrations]);
  }

  initiateConnection(input: {
    integration: string;
    label?: string;
  }): Promise<NangoConnectionRequest> {
    if (this._failure) return Promise.reject(this._failure);
    this.startedWith.push(input.integration);
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
// Multi-account (supportsMultiAccount:true), so the suite's two-distinct-ids branch runs.
connectorConformance(makeProvider, {
  name: 'NangoConnectorProvider — conformance',
  toolkit: 'gmail',
});

describe('NangoConnectorProvider — self-host-custody semantics', () => {
  it('disconnect is idempotent for an unknown/already-revoked id', async () => {
    const provider = makeProvider();
    await expect(
      provider.disconnect('nango:conn_nope' as ConnectorExternalAccountRef)
    ).resolves.toBeUndefined();
  });
});

// A Nango integration's key is the person's own name for it; its template id
// says which app it is. Across the port it goes by the app's DorkOS id, so it
// joins the popular app's row instead of listing it twice (DOR-2436).
describe('NangoConnectorProvider — catalog pages', () => {
  // DOR-2237: the kept app list pages one refresh under one signal. Fails if every
  // page re-lists the whole catalog upstream, as Composio did before DOR-2231.
  it('reads the catalog once per read, however many pages it is served in', async () => {
    const client = new FakeNangoClient(
      ['gmail', 'slack', 'notion', 'linear', 'github'].map((key) => ({
        uniqueKey: key,
        provider: key,
        displayName: key,
        authMode: 'OAUTH2',
      }))
    );
    let upstream = 0;
    const list = client.listIntegrations.bind(client);
    client.listIntegrations = () => {
      upstream += 1;
      return list();
    };
    const provider = new NangoConnectorProvider({ client });

    const read = new AbortController().signal;
    const slugs: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.listToolkitPage({ cursor, limit: 2, signal: read });
      if (page.status !== 'ok') throw new Error('page failed');
      slugs.push(...page.toolkits.map((toolkit) => toolkit.slug));
      cursor = page.nextCursor;
    } while (cursor);

    expect(slugs).toHaveLength(5);
    expect(upstream).toBe(1);
    // A new read asks again: keeping the list between reads is the kept app list's job.
    await provider.listToolkitPage({ limit: 2, signal: new AbortController().signal });
    expect(upstream).toBe(2);
  });
});

describe('NangoConnectorProvider — integrations go by their app’s service id', () => {
  function providerOver(integrations: NangoIntegration[]) {
    const client = new FakeNangoClient(integrations);
    return { client, provider: new NangoConnectorProvider({ client }) };
  }

  it('lists a Nango Gmail integration as the Gmail service', async () => {
    const { provider } = providerOver([
      { uniqueKey: 'google-mail', provider: 'google-mail', displayName: 'Gmail' },
    ]);

    await expect(provider.listToolkits()).resolves.toEqual([
      { slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' },
    ]);
  });

  it('connects through the integration’s own key and reports the account under the app', async () => {
    const { client, provider } = providerOver([
      { uniqueKey: 'google-mail', provider: 'google-mail', displayName: 'Gmail' },
    ]);

    const { flowId } = await provider.startConnect('gmail');
    const poll = await provider.pollConnect(flowId);

    expect(client.startedWith).toEqual(['google-mail']);
    expect(poll.account).toMatchObject({ toolkit: 'gmail', label: 'gmail' });
    const accounts = await provider.listAccounts({ toolkit: 'gmail' });
    expect(accounts.map((account) => account.toolkit)).toEqual(['gmail']);
  });

  it('refuses to connect a service no integration goes by', async () => {
    const { client, provider } = providerOver([
      { uniqueKey: 'google-mail', provider: 'google-mail', displayName: 'Gmail' },
    ]);

    await expect(provider.startConnect('dropbox')).rejects.toThrow(/no integration/);
    expect(client.startedWith).toEqual([]);
  });

  it('still finishes a sign-in started under the integration’s old key', async () => {
    // A caller holding an account saved before the rename moved it.
    const { client, provider } = providerOver([
      { uniqueKey: 'google-mail', provider: 'google-mail', displayName: 'Gmail' },
    ]);

    const { flowId } = await provider.startConnect('google-mail');
    const poll = await provider.pollConnect(flowId);

    expect(client.startedWith).toEqual(['google-mail']);
    expect(poll).toMatchObject({ status: 'connected', account: { toolkit: 'google-mail' } });
    // Everywhere else the account goes by the app's id.
    const accounts = await provider.listAccounts();
    expect(accounts.map((account) => account.toolkit)).toEqual(['gmail']);
    await expect(provider.listAccounts({ toolkit: 'google-mail' })).resolves.toEqual([]);
  });

  it('never gives the app’s row to an integration set up later', async () => {
    const home = {
      uniqueKey: 'mail-home',
      provider: 'google-mail',
      displayName: 'Gmail',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const later = {
      uniqueKey: 'a-gmail',
      provider: 'google-mail',
      displayName: 'Gmail',
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    const { client, provider } = providerOver([home, later]);

    const toolkits = await provider.listToolkits();
    expect(toolkits.map((toolkit) => toolkit.slug)).toEqual(['gmail', 'a-gmail']);
    await provider.startConnect('gmail');
    expect(client.startedWith).toEqual(['mail-home']);
  });

  it('asks again, never fails, when naming a connected account’s app fails', async () => {
    const client = new FakeNangoClient([
      { uniqueKey: 'google-mail', provider: 'google-mail', displayName: 'Gmail' },
    ]);
    const provider = new NangoConnectorProvider({ client });
    const { flowId } = await provider.startConnect('gmail');
    const listIntegrations = client.listIntegrations.bind(client);
    client.listIntegrations = () => Promise.reject(new NangoApiError(503, 'unavailable'));

    await expect(provider.pollConnect(flowId)).resolves.toEqual({ status: 'pending' });

    client.listIntegrations = listIntegrations;
    await expect(provider.pollConnect(flowId)).resolves.toMatchObject({
      status: 'connected',
      account: { toolkit: 'gmail' },
    });
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
      const provider = new NangoConnectorProvider({ client });
      await expect(provider.listToolkits()).rejects.toThrow();
    });

    it(`listAccounts PROPAGATES ${label} (never a silent empty list)`, async () => {
      const client = new FakeNangoClient();
      client.failWith(err());
      const provider = new NangoConnectorProvider({ client });
      await expect(provider.listAccounts()).rejects.toThrow();
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
});

describe('assertNangoEncryptionKey — the enforced 256-bit-key gate', () => {
  it('refuses a missing key with a helpful, secret-free error', () => {
    expect(() => assertNangoEncryptionKey(undefined)).toThrow(NangoEncryptionKeyError);
    expect(() => assertNangoEncryptionKey('')).toThrow(/Nango server uses, then restart DorkOS\.$/);
  });

  it('refuses a key of the wrong length (not 256-bit)', () => {
    const shortKey = Buffer.alloc(16).toString('base64');
    expect(() => assertNangoEncryptionKey(shortKey)).toThrow(
      /NANGO_ENCRYPTION_KEY is the wrong length: it has 16 bytes.*then restart DorkOS\.$/
    );
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
    expect(provider?.executionConfigDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(provider)).not.toContain('sk-nango-test');
    expect(JSON.stringify(provider)).not.toContain(provider!.executionConfigDigest);
    // The resolved key + base URL reach the HTTP client seam, not the provider surface.
    expect(seenKey).toBe('sk-nango-test');
    expect(seenBaseUrl).toBe('http://localhost:3003');
  });
});
