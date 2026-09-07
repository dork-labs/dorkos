import { describe, expect, it, vi } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
import type {
  CredentialProvider,
  CredentialResolution,
} from '../../../core/credential-provider.js';
import type {
  ConnectorCatalogPageRequest,
  ConnectorOperationPageRequest,
  ConnectorOperationRevision,
  ConnectorProviderExecuteResult,
  ConnectorProviderInstanceId,
  ConnectorToolkitVersionResult,
} from '@dorkos/shared/connector-schemas';
import {
  ComposioApiError,
  type ComposioAccountStatus,
  type ComposioConnectedAccount,
  type ComposioConnectionRequest,
  type ComposioConnectionState,
  type ComposioHttpClient,
  type ComposioToolkitInfo,
} from '../composio-client.js';
import {
  ComposioConnectorProvider,
  COMPOSIO_API_KEY_REF,
  COMPOSIO_UAK_OPERATIONS_UNSUPPORTED_REASON,
  maybeCreateComposioProvider,
  toComposioAccountId,
  toExternalAccountRef,
} from '../composio.js';
import type {
  ComposioOperationClient,
  ComposioSdkExecuteInput,
} from '@dorkos/connector-providers/composio';

/**
 * In-memory {@link ComposioHttpClient} — the fake Composio cloud the provider is
 * verified against (no network, no key). Mints `ca_…` handles and resolves
 * connect requests to ACTIVE on first poll. `setStatus` drives lifecycle
 * transitions.
 */
class FakeComposioClient implements ComposioHttpClient {
  readonly stateLookups: string[] = [];
  private readonly _accounts = new Map<string, ComposioConnectedAccount>();
  private readonly _requests = new Map<
    string,
    { toolkit: string; alias?: string; caId?: string }
  >();
  private _counter = 0;
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
    this.stateLookups.push(connectionRequestId);
    if (this._failure) return Promise.reject(this._failure);
    const request = this._requests.get(connectionRequestId);
    const existingAccount = this._accounts.get(connectionRequestId);
    if (existingAccount) {
      return Promise.resolve({ status: existingAccount.status, account: existingAccount });
    }
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

  /** Force a connected account's Composio status (drives the null branch). */
  setStatus(caId: string, status: ComposioAccountStatus): void {
    const account = this._accounts.get(caId);
    if (account) account.status = status;
  }

  /** Make every Composio call reject with `err` (drives the transport-degrade path). */
  failWith(err: Error | null): void {
    this._failure = err;
  }
}

/** Exact-version operation fake used to exercise the available capability path. */
class FakeComposioOperationClient implements ComposioOperationClient {
  readonly executions: ComposioSdkExecuteInput[] = [];

  listToolkitPage(request: ConnectorCatalogPageRequest) {
    request.signal.throwIfAborted();
    return Promise.resolve({
      status: 'ok' as const,
      toolkits: [
        { slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' as const },
        { slug: 'slack', displayName: 'Slack', authKind: 'oauth2' as const },
      ],
      truncated: false,
    });
  }

  resolveToolkitVersion(
    toolkit: string,
    signal: AbortSignal
  ): Promise<ConnectorToolkitVersionResult> {
    signal.throwIfAborted();
    return Promise.resolve({ status: 'ok', toolkit, toolkitVersion: '2026-09-02' });
  }

  listOperationSchemas(
    providerInstanceId: ConnectorProviderInstanceId,
    request: ConnectorOperationPageRequest
  ) {
    request.signal.throwIfAborted();
    const operationSlug = request.cursor ? `${request.toolkit}.write` : `${request.toolkit}.read`;
    const operation: Omit<ConnectorOperationRevision, 'id' | 'discoveredAt'> = {
      providerInstanceId,
      toolkit: request.toolkit,
      operationSlug,
      toolkitVersion: request.toolkitVersion,
      schemaHash: `sha256:${operationSlug}`,
      capabilityClassification: request.cursor ? 'write' : 'read',
      retryPolicy: 'never',
      inputSchema: { type: 'object', additionalProperties: false },
    };
    return Promise.resolve({
      status: 'ok' as const,
      page: {
        operations: [operation],
        ...(!request.cursor && { nextCursor: 'page-2' }),
        truncated: !request.cursor,
      },
    });
  }

  async execute(input: ComposioSdkExecuteInput): Promise<ConnectorProviderExecuteResult> {
    if (input.signal.aborted) {
      return {
        status: 'cancelled',
        code: 'CANCELLED_BEFORE_DISPATCH',
        message: 'cancelled',
      };
    }
    if (!(await input.authorizeDispatch())) {
      return {
        status: 'error',
        code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
        message: 'Access changed before the operation was sent.',
        retryable: false,
      };
    }
    this.executions.push(input);
    return { status: 'success', data: { ok: true } };
  }
}

/** Build an AbortError like a `fetch` timeout raises (matched by name, not type). */
function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

function providerWith(
  client: ComposioHttpClient,
  operationClient: ComposioOperationClient | null = new FakeComposioOperationClient()
): ComposioConnectorProvider {
  return new ComposioConnectorProvider({ client, operationClient });
}

function makeProvider(): ComposioConnectorProvider {
  return providerWith(new FakeComposioClient());
}

// The flagship managed adapter clears the same behavioral gate every backend
// does. Multi-account (supportsMultiAccount:true), so the suite's two-distinct-
// ids branch runs.
connectorConformance(makeProvider, {
  name: 'ComposioConnectorProvider — conformance',
  toolkit: 'gmail',
});

describe('ComposioConnectorProvider — managed-custody semantics', () => {
  it('declares the managed, multi-account, brokered-execution capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: 'composio',
      supportsMultiAccount: true,
      custody: 'managed',
    });
  });

  it('wraps the Composio ca_ handle as an opaque, provider-scoped id and back', () => {
    const id = toExternalAccountRef('ca_abc123');
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
    // The provider boundary returns only its private reference; the registry
    // assigns the public DorkOS connection id.
    expect(poll.account?.externalAccountRef.startsWith('composio:')).toBe(true);
  });

  it('yields two distinct, independently-addressable ids for two connects of one toolkit', async () => {
    const provider = makeProvider();

    const first = await provider.startConnect('gmail', { label: 'personal' });
    const personal = (await provider.pollConnect(first.flowId)).account!;
    const second = await provider.startConnect('gmail', { label: 'work' });
    const work = (await provider.pollConnect(second.flowId)).account!;

    expect(personal.externalAccountRef).not.toBe(work.externalAccountRef);
    const accounts = await provider.listAccounts({ toolkit: 'gmail' });
    expect(new Set(accounts.map((a) => a.externalAccountRef)).size).toBe(2);
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
      provider.disconnect('composio:ca_nope' as ConnectorExternalAccountRef)
    ).resolves.toBeUndefined();
  });

  it('routes execution to the exact active private account and immutable provider revision', async () => {
    const operationClient = new FakeComposioOperationClient();
    const managementClient = new FakeComposioClient();
    const provider = providerWith(managementClient, operationClient);
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const account = (await provider.pollConnect(flowId)).account!;
    const operationPage = await provider.listOperationSchemas({
      toolkit: 'gmail',
      toolkitVersion: '2026-09-02',
      limit: 1,
      signal: new AbortController().signal,
    });
    expect(operationPage.status).toBe('ok');
    if (operationPage.status !== 'ok') throw new Error(operationPage.reason);

    await expect(
      provider.execute({
        externalAccountRef: account.externalAccountRef,
        authorizeDispatch: () => true,
        operation: {
          ...operationPage.page.operations[0]!,
          id: 'revision-gmail-read',
          discoveredAt: '2026-09-02T00:00:00.000Z',
        },
        arguments: { query: 'hello' },
        logicalOperationId: 'logical-1',
        attemptId: 'attempt-1',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ status: 'success' });

    expect(operationClient.executions).toHaveLength(1);
    expect(managementClient.stateLookups.at(-1)).toBe(
      toComposioAccountId(account.externalAccountRef)
    );
    expect(operationClient.executions[0]).toMatchObject({
      connectedAccountId: toComposioAccountId(account.externalAccountRef),
      arguments: { query: 'hello' },
      operation: {
        providerInstanceId: provider.instanceId,
        toolkitVersion: '2026-09-02',
      },
    });
  });

  it('checks server authority after the account lookup and before operation dispatch', async () => {
    const operationClient = new FakeComposioOperationClient();
    const managementClient = new FakeComposioClient();
    const provider = providerWith(managementClient, operationClient);
    const { flowId } = await provider.startConnect('gmail', { label: 'personal' });
    const account = (await provider.pollConnect(flowId)).account!;
    const operationPage = await provider.listOperationSchemas({
      toolkit: 'gmail',
      toolkitVersion: '2026-09-02',
      limit: 1,
      signal: new AbortController().signal,
    });
    if (operationPage.status !== 'ok') throw new Error(operationPage.reason);
    const authorizeDispatch = vi.fn().mockResolvedValue(false);

    await expect(
      provider.execute({
        externalAccountRef: account.externalAccountRef,
        authorizeDispatch,
        operation: {
          ...operationPage.page.operations[0]!,
          id: 'revision-gmail-read',
          discoveredAt: '2026-09-02T00:00:00.000Z',
        },
        arguments: {},
        logicalOperationId: 'logical-refused',
        attemptId: 'attempt-refused',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({
      status: 'error',
      code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
    });
    expect(managementClient.stateLookups.at(-1)).toBe(
      toComposioAccountId(account.externalAccountRef)
    );
    expect(authorizeDispatch).toHaveBeenCalledTimes(1);
    expect(operationClient.executions).toEqual([]);
  });

  it('rejects an unknown account, another instance, and retryable metadata before SDK dispatch', async () => {
    const operationClient = new FakeComposioOperationClient();
    const provider = providerWith(new FakeComposioClient(), operationClient);
    const { flowId } = await provider.startConnect('gmail', { label: 'must-not-be-selected' });
    await provider.pollConnect(flowId);
    const baseOperation: ConnectorOperationRevision = {
      id: 'revision-gmail-read',
      providerInstanceId: provider.instanceId,
      toolkit: 'gmail',
      operationSlug: 'gmail.read',
      toolkitVersion: '2026-09-02',
      schemaHash: 'sha256:gmail.read',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: { type: 'object' },
      discoveredAt: '2026-09-02T00:00:00.000Z',
    };
    const command = {
      externalAccountRef: 'composio:ca_missing' as ConnectorExternalAccountRef,
      authorizeDispatch: () => true,
      operation: baseOperation,
      arguments: {},
      logicalOperationId: 'logical-guard',
      attemptId: 'attempt-guard',
      signal: new AbortController().signal,
    };

    await expect(provider.execute(command)).resolves.toMatchObject({
      status: 'error',
      code: 'ACCOUNT_UNAVAILABLE',
    });
    await expect(
      provider.execute({
        ...command,
        operation: {
          ...baseOperation,
          providerInstanceId: 'composio:another' as ConnectorProviderInstanceId,
        },
      })
    ).resolves.toMatchObject({ status: 'error', code: 'PROVIDER_INSTANCE_MISMATCH' });
    await expect(
      provider.execute({
        ...command,
        operation: { ...baseOperation, toolkitVersion: 'latest' },
      })
    ).resolves.toMatchObject({ status: 'error', code: 'INVALID_TOOLKIT_VERSION' });
    await expect(
      provider.execute({
        ...command,
        upstreamIdempotencyKey: 'must-not-forward',
      })
    ).resolves.toMatchObject({ status: 'error', code: 'UNSUPPORTED_RETRY_POLICY' });
    expect(operationClient.executions).toHaveLength(0);
  });
});

// The mock suite structurally can't catch this: the fake client never errors on
// its own, so these lock the degrade contract by forcing the client to reject.
// Provider inventory reads must propagate transport failures so aggregation can surface warnings.
describe('ComposioConnectorProvider — degrade contract on transport failure', () => {
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
    it(`listToolkits PROPAGATES ${label} (the registry turns it into a warning)`, async () => {
      const client = new FakeComposioClient();
      client.failWith(err());
      const provider = providerWith(client);
      await expect(provider.listToolkits()).rejects.toThrow();
    });

    it(`listAccounts PROPAGATES ${label} (never a silent empty list)`, async () => {
      const client = new FakeComposioClient();
      client.failWith(err());
      const provider = providerWith(client);
      await expect(provider.listAccounts()).rejects.toThrow();
    });

    it(`pollConnect maps ${label} to a failure-typed result`, async () => {
      const client = new FakeComposioClient();
      client.failWith(err());
      const provider = providerWith(client);
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
    };
    const provider = providerWith(client);
    await expect(provider.startConnect('gmail')).rejects.toThrow(/no authorize URL/);
  });

  it('does NOT swallow a non-transport error (a genuine bug still surfaces)', async () => {
    const client = new FakeComposioClient();
    client.failWith(new TypeError('bug in mapping'));
    const provider = providerWith(client);
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
    let seenSdkKey: string | undefined;
    const provider = await maybeCreateComposioProvider({
      credentials: fakeCredentials({ [COMPOSIO_API_KEY_REF]: 'sk-composio-test' }),
      makeClient: (opts) => {
        seenKey = opts.apiKey;
        return new FakeComposioClient();
      },
      makeOperationClient: (opts) => {
        seenSdkKey = opts.apiKey;
        return new FakeComposioOperationClient();
      },
    });

    expect(provider).toBeInstanceOf(ComposioConnectorProvider);
    expect(provider?.type).toBe('composio');
    // The resolved key reaches the HTTP client seam, not the provider surface.
    expect(seenKey).toBe('sk-composio-test');
    expect(seenSdkKey).toBe('sk-composio-test');
    expect(provider?.executionConfigDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(provider)).not.toContain('sk-composio-test');
    expect(JSON.stringify(provider)).not.toContain(provider!.executionConfigDigest);
  });

  it('scopes the client to the configured Composio user_id', async () => {
    let seenUserId: string | undefined;
    let seenSdkUserId: string | undefined;
    const instanceId = 'composio:operator-42' as ConnectorProviderInstanceId;
    const provider = await maybeCreateComposioProvider({
      credentials: fakeCredentials({ [COMPOSIO_API_KEY_REF]: 'sk-test' }),
      userId: 'operator-42',
      instanceId,
      makeClient: (opts) => {
        seenUserId = opts.userId;
        return new FakeComposioClient();
      },
      makeOperationClient: (opts) => {
        seenSdkUserId = opts.serverUserId;
        return new FakeComposioOperationClient();
      },
    });
    expect(seenUserId).toBe('operator-42');
    expect(seenSdkUserId).toBe('operator-42');
    expect(provider?.instanceId).toBe(instanceId);
  });

  it('keeps legacy UAK management usable without constructing or calling the SDK', async () => {
    let sdkConstructions = 0;
    const provider = await maybeCreateComposioProvider({
      credentials: fakeCredentials({ [COMPOSIO_API_KEY_REF]: 'uak_legacy_cli_key' }),
      makeClient: () => new FakeComposioClient(),
      makeOperationClient: () => {
        sdkConstructions += 1;
        return new FakeComposioOperationClient();
      },
    });

    expect(provider).not.toBeNull();
    await expect(provider!.listToolkits()).resolves.toHaveLength(2);
    expect(provider!.getCapabilities().capabilities.operations).toEqual({
      status: 'unsupported',
      reason: COMPOSIO_UAK_OPERATIONS_UNSUPPORTED_REASON,
    });
    await expect(
      provider!.resolveToolkitVersion('gmail', new AbortController().signal)
    ).resolves.toEqual({
      status: 'unsupported',
      reason: COMPOSIO_UAK_OPERATIONS_UNSUPPORTED_REASON,
    });
    await expect(
      provider!.execute({
        externalAccountRef: 'composio:ca_legacy' as ConnectorExternalAccountRef,
        authorizeDispatch: () => true,
        operation: {
          id: 'revision-legacy',
          providerInstanceId: provider!.instanceId,
          toolkit: 'gmail',
          operationSlug: 'gmail.read',
          toolkitVersion: '2026-09-02',
          schemaHash: 'sha256:legacy',
          capabilityClassification: 'read',
          retryPolicy: 'never',
          inputSchema: { type: 'object' },
          discoveredAt: '2026-09-02T00:00:00.000Z',
        },
        arguments: {},
        logicalOperationId: 'logical-legacy',
        attemptId: 'attempt-legacy',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      status: 'unsupported',
      reason: COMPOSIO_UAK_OPERATIONS_UNSUPPORTED_REASON,
    });
    expect(sdkConstructions).toBe(0);
  });
});
