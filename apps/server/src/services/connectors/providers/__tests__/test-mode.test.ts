import { beforeEach, describe, expect, it } from 'vitest';
import { connectorConformance } from '@dorkos/test-utils';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
import type {
  CredentialProvider,
  CredentialResolution,
} from '../../../core/credential-provider.js';
import { ConnectorRegistry } from '../../registry.js';
import {
  ConnectorProviderBootstrapper,
  TEST_CONNECTOR_API_KEY_REF,
  TEST_CONNECTOR_PROVIDER_TYPE,
} from '../../bootstrap.js';
import { maybeCreateTestModeConnectorProvider, TestModeConnectorProvider } from '../test-mode.js';

const LOCAL_ORIGIN = 'http://127.0.0.1:4243';

function makeProvider(): TestModeConnectorProvider {
  return new TestModeConnectorProvider({ localOrigin: LOCAL_ORIGIN });
}

/** A mutable credential fake: `store` writes stand in for the credential routes. */
function fakeCredentials(store: Map<string, string>): CredentialProvider {
  return {
    resolve(ref: string): Promise<CredentialResolution> {
      const secret = store.get(ref);
      if (secret === undefined) {
        return Promise.resolve({ ok: false, reason: 'unresolved', ref, message: 'absent' });
      }
      return Promise.resolve({ ok: true, secret });
    },
  };
}

// The scripted e2e backend clears the same behavioral gate every real backend
// does (task E1 acceptance). Multi-account, so the two-distinct-ids branch runs.
connectorConformance(makeProvider, {
  name: 'TestModeConnectorProvider — conformance',
  toolkit: 'gmail',
});

describe('TestModeConnectorProvider — scripted semantics', () => {
  it('declares the managed, multi-account, brokered-execution capability shape', () => {
    const caps = makeProvider().getCapabilities();
    expect(caps).toMatchObject({
      type: TEST_CONNECTOR_PROVIDER_TYPE,
      supportsMultiAccount: true,
      custody: 'managed',
    });
  });

  it('lists the scripted gmail + slack toolkits', async () => {
    const toolkits = await makeProvider().listToolkits();
    expect(toolkits.map((tk) => tk.slug)).toEqual(['gmail', 'slack']);
  });

  it('pins a concrete toolkit version and paginates exact operation schemas', async () => {
    const provider = makeProvider();
    const version = await provider.resolveToolkitVersion('gmail', new AbortController().signal);
    expect(version).toEqual({ status: 'ok', toolkit: 'gmail', toolkitVersion: '2026-09-01' });

    const first = await provider.listOperationSchemas({
      toolkit: 'gmail',
      toolkitVersion: '2026-09-01',
      limit: 2,
      signal: new AbortController().signal,
    });
    expect(first).toMatchObject({
      status: 'ok',
      page: {
        truncated: true,
        nextCursor: '2',
        operations: [
          { operationSlug: 'gmail.messages.list', capabilityClassification: 'read' },
          { operationSlug: 'gmail.messages.send', capabilityClassification: 'write' },
        ],
      },
    });
    if (first.status !== 'ok') throw new Error('expected operation page');
    const second = await provider.listOperationSchemas({
      toolkit: 'gmail',
      toolkitVersion: '2026-09-01',
      cursor: first.page.nextCursor,
      limit: 2,
      signal: new AbortController().signal,
    });
    expect(second).toMatchObject({
      status: 'ok',
      page: {
        truncated: false,
        operations: [
          { operationSlug: 'gmail.messages.delete', capabilityClassification: 'destructive' },
        ],
      },
    });
  });

  it('executes only the exact connected account and immutable operation revision', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });
    const connected = await provider.pollConnect(flowId);
    if (connected.status !== 'connected' || !connected.account) {
      throw new Error('expected connected test account');
    }
    const schemas = await provider.listOperationSchemas({
      toolkit: 'gmail',
      toolkitVersion: '2026-09-01',
      limit: 1,
      signal: new AbortController().signal,
    });
    if (schemas.status !== 'ok') throw new Error('expected operation schema');
    const result = await provider.execute({
      externalAccountRef: connected.account.externalAccountRef,
      authorizeDispatch: () => true,
      operation: {
        id: 'revision-1',
        ...schemas.page.operations[0],
        discoveredAt: '2026-09-06T00:00:00.000Z',
      },
      arguments: { query: 'from:ada' },
      logicalOperationId: 'logical-1',
      attemptId: 'attempt-1',
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      status: 'success',
      data: { ok: true, operation: 'gmail.messages.list', accountLabel: 'work' },
      providerLogId: 'test-log-attempt-1',
    });

    const wrongAccount = await provider.execute({
      externalAccountRef: 'private-other-account' as ConnectorExternalAccountRef,
      authorizeDispatch: () => true,
      operation: {
        id: 'revision-1',
        ...schemas.page.operations[0],
        discoveredAt: '2026-09-06T00:00:00.000Z',
      },
      arguments: {},
      logicalOperationId: 'logical-2',
      attemptId: 'attempt-2',
      signal: new AbortController().signal,
    });
    expect(wrongAccount).toMatchObject({ status: 'error', code: 'TEST_OPERATION_MISMATCH' });
  });

  it('returns typed cancellation before deterministic execution dispatch', async () => {
    const provider = makeProvider();
    const controller = new AbortController();
    controller.abort();
    expect(
      await provider.execute({
        externalAccountRef: 'private-account' as ConnectorExternalAccountRef,
        authorizeDispatch: () => true,
        operation: {
          id: 'revision-1',
          providerInstanceId: provider.instanceId,
          toolkit: 'gmail',
          operationSlug: 'gmail.messages.list',
          toolkitVersion: '2026-09-01',
          schemaHash: 'test-gmail-list-v1',
          capabilityClassification: 'read',
          retryPolicy: 'never',
          inputSchema: {},
          discoveredAt: '2026-09-06T00:00:00.000Z',
        },
        arguments: {},
        logicalOperationId: 'logical-1',
        attemptId: 'attempt-1',
        signal: controller.signal,
      })
    ).toMatchObject({ status: 'cancelled', code: 'CANCELLED_BEFORE_DISPATCH' });
  });

  it('points the authorize URL at the local no-op page — everything stays on-machine', async () => {
    const provider = makeProvider();
    const start = await provider.startConnect('gmail', { label: 'work' });
    expect(start.authorizeUrl).toBe(
      `${LOCAL_ORIGIN}/api/test/connect-approved?flow=${start.flowId}`
    );
  });

  it('connects instantly with the given label, stable across re-polls', async () => {
    const provider = makeProvider();
    const { flowId } = await provider.startConnect('gmail', { label: 'work' });

    const first = await provider.pollConnect(flowId);
    expect(first.status).toBe('connected');
    expect(first.account).toMatchObject({ toolkit: 'gmail', label: 'work', status: 'active' });

    const second = await provider.pollConnect(flowId);
    expect(second.account?.externalAccountRef).toBe(first.account?.externalAccountRef);
  });
});

describe('maybeCreateTestModeConnectorProvider — the credential gate', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let secrets: Map<string, string>;
  let bootstrapper: ConnectorProviderBootstrapper;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    secrets = new Map();
    const credentials = fakeCredentials(secrets);
    // The exact wiring index.ts uses under DORKOS_TEST_RUNTIME: the bootstrapper's
    // test-connector spec runs this factory on boot and on every credential reload.
    bootstrapper = new ConnectorProviderBootstrapper({
      rawMcpPendingConnect: () => undefined,
      registry,
      credentials,
      nangoEnv: () => ({}),
      rawMcpServers: () => [],
      testConnector: {
        create: () =>
          maybeCreateTestModeConnectorProvider({ credentials, localOrigin: LOCAL_ORIGIN }),
      },
    });
  });

  it('resolves null while no key is saved', async () => {
    await expect(
      maybeCreateTestModeConnectorProvider({
        credentials: fakeCredentials(new Map()),
        localOrigin: LOCAL_ORIGIN,
      })
    ).resolves.toBeNull();
  });

  it('is absent after boot without a key — configured:false, registered:false', async () => {
    await bootstrapper.registerBootProviders();
    expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();

    const status = (await bootstrapper.listStatuses()).find(
      (s) => s.type === TEST_CONNECTOR_PROVIDER_TYPE
    )!;
    expect(status).toMatchObject({ configured: false, registered: false, custody: 'managed' });
  });

  it('registers live on key save + reload, and unregisters on delete + reload', async () => {
    await bootstrapper.registerBootProviders();

    // The credential route's write: store the key, then reload the provider.
    secrets.set(TEST_CONNECTOR_API_KEY_REF, 'test-key');
    const saved = await bootstrapper.reload(TEST_CONNECTOR_PROVIDER_TYPE);
    expect(saved).toMatchObject({ configured: true, registered: true });
    expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeInstanceOf(
      TestModeConnectorProvider
    );

    // The delete path: key gone, provider unregistered — no restart anywhere.
    secrets.delete(TEST_CONNECTOR_API_KEY_REF);
    const deleted = await bootstrapper.reload(TEST_CONNECTOR_PROVIDER_TYPE);
    expect(deleted).toMatchObject({ configured: false, registered: false });
    expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();
  });

  it('is entirely absent without the test-mode seam — the production bootstrapper refuses the type', async () => {
    const production = new ConnectorProviderBootstrapper({
      rawMcpPendingConnect: () => undefined,
      registry,
      credentials: fakeCredentials(secrets),
      nangoEnv: () => ({}),
      rawMcpServers: () => [],
    });
    await production.registerBootProviders();

    // The credential routes validate via credentialNameFor — undefined = 400.
    expect(production.credentialNameFor(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();
    await expect(production.reload(TEST_CONNECTOR_PROVIDER_TYPE)).rejects.toThrow(
      /Unknown connector provider/
    );
  });
});
