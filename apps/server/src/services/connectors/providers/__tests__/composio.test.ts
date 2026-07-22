import { describe, expect, it } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import type {
  CredentialProvider,
  CredentialResolution,
} from '../../../core/credential-provider.js';
import {
  ComposioApiError,
  type ComposioAccountStatus,
  type ComposioConnectedAccount,
  type ComposioConnectionRequest,
  type ComposioConnectionState,
  type ComposioHttpClient,
  type ComposioMcpSession,
  type ComposioToolkitInfo,
} from '../composio-client.js';
import {
  ComposioConnectorProvider,
  COMPOSIO_API_KEY_REF,
  maybeCreateComposioProvider,
  toComposioAccountId,
  toConnectedAccountId,
} from '../composio.js';

/**
 * In-memory {@link ComposioHttpClient} — the fake Composio cloud the provider is
 * verified against (no network, no key). Mints `ca_…` handles, resolves connect
 * requests to ACTIVE on first poll, and exposes a Rube MCP session per active
 * account. `setStatus`/`setLiveSessions` drive the null branch.
 */
class FakeComposioClient implements ComposioHttpClient {
  private readonly _accounts = new Map<string, ComposioConnectedAccount>();
  private readonly _requests = new Map<
    string,
    { toolkit: string; alias?: string; caId?: string }
  >();
  private _counter = 0;
  private _liveSessions = true;
  private _failure: Error | null = null;

  private readonly _toolkits: ComposioToolkitInfo[] = [
    { slug: 'gmail', name: 'Gmail', authScheme: 'OAUTH2' },
    { slug: 'slack', name: 'Slack', authScheme: 'OAUTH2' },
  ];

  listToolkits(): Promise<ComposioToolkitInfo[]> {
    if (this._failure) return Promise.reject(this._failure);
    return Promise.resolve([...this._toolkits]);
  }

  initiateConnection(input: {
    toolkit: string;
    alias?: string;
  }): Promise<ComposioConnectionRequest> {
    if (this._failure) return Promise.reject(this._failure);
    this._counter += 1;
    const connectionRequestId = `cr_${this._counter}`;
    this._requests.set(connectionRequestId, { toolkit: input.toolkit, alias: input.alias });
    return Promise.resolve({
      connectionRequestId,
      redirectUrl: `https://connect.composio.test/${input.toolkit}?cr=${connectionRequestId}`,
    });
  }

  getConnectionState(connectionRequestId: string): Promise<ComposioConnectionState> {
    if (this._failure) return Promise.reject(this._failure);
    const request = this._requests.get(connectionRequestId);
    if (!request) {
      return Promise.resolve({
        status: 'FAILED',
        error: `unknown request '${connectionRequestId}'`,
      });
    }
    if (!request.caId) {
      this._counter += 1;
      const caId = `ca_${this._counter}`;
      this._accounts.set(caId, {
        connectedAccountId: caId,
        toolkit: request.toolkit,
        ...(request.alias && { alias: request.alias }),
        status: 'ACTIVE',
      });
      request.caId = caId;
    }
    const account = this._accounts.get(request.caId);
    if (!account || account.status !== 'ACTIVE') {
      return Promise.resolve({ status: account?.status ?? 'FAILED' });
    }
    return Promise.resolve({ status: 'ACTIVE', account });
  }

  listConnectedAccounts(opts?: { toolkit?: string }): Promise<ComposioConnectedAccount[]> {
    if (this._failure) return Promise.reject(this._failure);
    const all = [...this._accounts.values()];
    return Promise.resolve(opts?.toolkit ? all.filter((a) => a.toolkit === opts.toolkit) : all);
  }

  deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    // Idempotent — deleting an unknown id is a no-op (mirrors the real 404 swallow).
    this._accounts.delete(connectedAccountId);
    return Promise.resolve();
  }

  mcpSessionForAccount(connectedAccountId: string): Promise<ComposioMcpSession | null> {
    if (this._failure) return Promise.reject(this._failure);
    const account = this._accounts.get(connectedAccountId);
    if (!account || account.status !== 'ACTIVE' || !this._liveSessions) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      url: `https://rube.app/mcp/${connectedAccountId}`,
      headers: { 'x-api-key': 'test-key' },
    });
  }

  /** Force a connected account's Composio status (drives the null branch). */
  setStatus(caId: string, status: ComposioAccountStatus): void {
    const account = this._accounts.get(caId);
    if (account) account.status = status;
  }

  /** Toggle whether Rube MCP sessions are available for active accounts. */
  setLiveSessions(live: boolean): void {
    this._liveSessions = live;
  }

  /** Make every Composio call reject with `err` (drives the transport-degrade path). */
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

function makeProvider(): ComposioConnectorProvider {
  return new ComposioConnectorProvider({ client: new FakeComposioClient() });
}

// The flagship managed adapter clears the same behavioral gate every backend
// does. Multi-account (supportsMultiAccount:true), so the suite's two-distinct-
// ids branch runs. The null branch is arranged by expiring a connected account.
connectorConformance(makeProvider, {
  name: 'ComposioConnectorProvider — conformance',
  toolkit: 'gmail',
  makeUnexposableAccount: async () => {
    const client = new FakeComposioClient();
    const provider = new ComposioConnectorProvider({ client });
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const { account } = await provider.pollConnect(flowId);
    // Expire the underlying Composio account: its Rube session goes away, so
    // toolServerForAccount must resolve null rather than throw.
    client.setStatus(toComposioAccountId(account!.id), 'EXPIRED');
    return { provider, accountId: account!.id };
  },
});

describe('ComposioConnectorProvider — managed-custody semantics', () => {
  it('declares the managed, multi-account, MCP-exposing capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: 'composio',
      supportsMultiAccount: true,
      custody: 'managed',
      exposesOverMcp: true,
    });
  });

  it('wraps the Composio ca_ handle as an opaque, provider-scoped id and back', () => {
    const id = toConnectedAccountId('ca_abc123');
    expect(id).toBe('composio:ca_abc123');
    expect(toComposioAccountId(id)).toBe('ca_abc123');
  });

  it('carries the connect label as the account alias and echoes managed custody', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });
    const poll = await provider.pollConnect(flowId);

    expect(poll.status).toBe('connected');
    expect(poll.account?.label).toBe('work');
    expect(poll.account?.custody).toBe('managed');
    expect(poll.account?.provider).toBe('composio');
    // No raw ca_ handle leaks past the port — the id is the wrapped form.
    expect(poll.account?.id.startsWith('composio:')).toBe(true);
  });

  it('yields two distinct, independently-addressable ids for two connects of one toolkit', async () => {
    const provider = makeProvider();

    const first = await provider.startConnect('gmail', { label: 'personal' });
    const personal = (await provider.pollConnect(first.flowId)).account!;
    const second = await provider.startConnect('gmail', { label: 'work' });
    const work = (await provider.pollConnect(second.flowId)).account!;

    expect(personal.id).not.toBe(work.id);
    const accounts = await provider.listAccounts({ toolkit: 'gmail' });
    expect(new Set(accounts.map((a) => a.id)).size).toBe(2);

    // Both are addressable to their own Rube MCP tool server.
    const personalServer = await provider.toolServerForAccount(personal.id);
    const workServer = await provider.toolServerForAccount(work.id);
    expect(personalServer).not.toBeNull();
    expect(workServer).not.toBeNull();
    expect(personalServer).not.toEqual(workServer);
  });

  it('exposes an active account as a Rube MCP http connection', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const account = (await provider.pollConnect(flowId)).account!;

    const connection = await provider.toolServerForAccount(account.id);
    expect(connection).toMatchObject({
      transport: 'http',
      url: expect.stringContaining('rube.app/mcp'),
    });
    // The injected connection carries NO provider identity in its shape.
    expect(JSON.stringify(connection)).not.toContain('composio');
  });

  it('returns null (never throws) when Composio has no live MCP session', async () => {
    const client = new FakeComposioClient();
    const provider = new ComposioConnectorProvider({ client });
    const { flowId } = await provider.startConnect('gmail');
    const account = (await provider.pollConnect(flowId)).account!;

    client.setLiveSessions(false);
    await expect(provider.toolServerForAccount(account.id)).resolves.toBeNull();
  });

  it('surfaces a failed Composio connect as a typed failure, never a throw', async () => {
    const provider = makeProvider();
    const poll = await provider.pollConnect('cr_does_not_exist');
    expect(poll.status).toBe('failed');
    expect(poll.error).toBeTruthy();
  });

  it('disconnect is idempotent for an unknown/already-revoked id', async () => {
    const provider = makeProvider();
    await expect(
      provider.disconnect('composio:ca_nope' as ConnectedAccountId)
    ).resolves.toBeUndefined();
  });
});

// The mock suite structurally can't catch this: the fake client never errors on
// its own, so these lock the degrade contract by forcing the client to reject.
// Session-exposure awaits toolServerForAccount UNGUARDED — a throw here would 500
// the attach route instead of degrading to attach-recorded-with-warning.
describe('ComposioConnectorProvider — throw-free degrade on transport failure', () => {
  const errors: Array<{ label: string; err: () => Error }> = [
    {
      label: 'ComposioApiError 401 (stale key)',
      err: () => new ComposioApiError(401, 'unauthorized'),
    },
    {
      label: 'ComposioApiError 500 (server error)',
      err: () => new ComposioApiError(500, 'server error'),
    },
    { label: 'AbortError (fetch timeout)', err: abortError },
  ];

  for (const { label, err } of errors) {
    it(`toolServerForAccount resolves null on ${label}`, async () => {
      const client = new FakeComposioClient();
      const provider = new ComposioConnectorProvider({ client });
      const { flowId } = await provider.startConnect('gmail');
      const account = (await provider.pollConnect(flowId)).account!;

      client.failWith(err());
      await expect(provider.toolServerForAccount(account.id)).resolves.toBeNull();
    });

    it(`listToolkits returns empty on ${label}`, async () => {
      const client = new FakeComposioClient();
      client.failWith(err());
      const provider = new ComposioConnectorProvider({ client });
      await expect(provider.listToolkits()).resolves.toEqual([]);
    });

    it(`listAccounts returns empty on ${label}`, async () => {
      const client = new FakeComposioClient();
      client.failWith(err());
      const provider = new ComposioConnectorProvider({ client });
      await expect(provider.listAccounts()).resolves.toEqual([]);
    });

    it(`pollConnect maps ${label} to a failure-typed result`, async () => {
      const client = new FakeComposioClient();
      client.failWith(err());
      const provider = new ComposioConnectorProvider({ client });
      const poll = await provider.pollConnect('cr_anything');
      expect(poll.status).toBe('failed');
      expect(poll.error).toBeTruthy();
    });
  }

  it('startConnect throws a typed error when Composio returns no authorize URL', async () => {
    // A NullUrlClient returns a connection request with an empty redirectUrl —
    // the picker must not silently open an empty authorize URL.
    const client: ComposioHttpClient = {
      listToolkits: () => Promise.resolve([{ slug: 'gmail', name: 'Gmail', authScheme: 'OAUTH2' }]),
      initiateConnection: () => Promise.resolve({ connectionRequestId: 'cr_1', redirectUrl: '' }),
      getConnectionState: () => Promise.resolve({ status: 'INITIATED' }),
      listConnectedAccounts: () => Promise.resolve([]),
      deleteConnectedAccount: () => Promise.resolve(),
      mcpSessionForAccount: () => Promise.resolve(null),
    };
    const provider = new ComposioConnectorProvider({ client });
    await expect(provider.startConnect('gmail')).rejects.toThrow(/no authorize URL/);
  });

  it('does NOT swallow a non-transport error (a genuine bug still surfaces)', async () => {
    const client = new FakeComposioClient();
    client.failWith(new TypeError('bug in mapping'));
    const provider = new ComposioConnectorProvider({ client });
    await expect(provider.listToolkits()).rejects.toThrow(/bug in mapping/);
  });
});

describe('maybeCreateComposioProvider — the configured-only registry gate', () => {
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

  it('returns null when the API key is unconfigured (dangling reference)', async () => {
    const provider = await maybeCreateComposioProvider({ credentials: fakeCredentials({}) });
    expect(provider).toBeNull();
  });

  it('builds the provider when the API key resolves, holding the key only in the client', async () => {
    let seenKey: string | undefined;
    const provider = await maybeCreateComposioProvider({
      credentials: fakeCredentials({ [COMPOSIO_API_KEY_REF]: 'sk-composio-test' }),
      makeClient: (opts) => {
        seenKey = opts.apiKey;
        return new FakeComposioClient();
      },
    });

    expect(provider).toBeInstanceOf(ComposioConnectorProvider);
    expect(provider?.type).toBe('composio');
    // The resolved key reaches the HTTP client seam, not the provider surface.
    expect(seenKey).toBe('sk-composio-test');
  });

  it('scopes the client to the configured Composio user_id', async () => {
    let seenUserId: string | undefined;
    await maybeCreateComposioProvider({
      credentials: fakeCredentials({ [COMPOSIO_API_KEY_REF]: 'sk-test' }),
      userId: 'operator-42',
      makeClient: (opts) => {
        seenUserId = opts.userId;
        return new FakeComposioClient();
      },
    });
    expect(seenUserId).toBe('operator-42');
  });
});
