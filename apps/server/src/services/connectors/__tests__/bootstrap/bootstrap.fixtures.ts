/**
 * Hermetic vendor clients and the per-test harness for the ConnectorProviderBootstrapper tests.
 */
import { beforeEach, afterEach, vi } from 'vitest';
import {
  connections,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-provider';
import type {
  CredentialProvider,
  CredentialResolution,
} from '../../../core/credential-provider.js';
import { ConnectorRegistry } from '../../registry.js';
import { legacyDefaultProviderInstanceId } from '../../legacy-connection-migration.js';
import { ConnectorProviderBootstrapper } from '../../bootstrap.js';
import { toExternalAccountRef as toComposioExternalAccountRef } from '../../providers/composio.js';
import {
  type ComposioConnectedAccount,
  type ComposioHttpClient,
} from '../../providers/composio-client.js';
import { type NangoHttpClient } from '../../providers/nango-client.js';
import type { RawMcpServerDescriptor } from '../../providers/raw-mcp.js';

/** A valid 256-bit key written in base64 (32 zero bytes) for the enforced gate. */
export const VALID_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');

/**
 * A hermetic Composio client for the bootstrapper's connection check. The
 * probe calls `listConnectedAccounts`; `failProbeWith` drives the wrong-key
 * (401) branch. No method touches the network.
 */
export function fakeComposioClient(failProbeWith?: Error): ComposioHttpClient {
  // Mirrors the real client's kind tracking: 'unknown' until a call succeeds.
  let validated = false;
  return {
    keyKind: () => (validated ? 'user' : 'unknown'),
    listToolkits: () => Promise.resolve([]),
    initiateConnection: () => Promise.reject(new Error('not used')),
    getConnectionState: () => Promise.reject(new Error('not used')),
    listConnectedAccounts: () => {
      if (failProbeWith) return Promise.reject(failProbeWith);
      validated = true;
      return Promise.resolve([]);
    },
    deleteConnectedAccount: () => Promise.resolve(),
  };
}

/** The Nango counterpart of {@link fakeComposioClient}. */
export function fakeNangoClient(): NangoHttpClient {
  return {
    listIntegrations: () => Promise.resolve([]),
    initiateConnection: () => Promise.reject(new Error('not used')),
    getConnectionState: () => Promise.reject(new Error('not used')),
    listConnections: () => Promise.resolve([]),
    deleteConnection: () => Promise.resolve(),
  };
}

/** A mutable credential fake: `store` writes stand in for the credential routes. */
export function fakeCredentials(store: Map<string, string>): CredentialProvider {
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

/** The shared per-test state and helpers every bootstrap piece uses. */
export function useBootstrapHarness() {
  const h = {
    db: undefined as unknown as Db,
    registry: undefined as unknown as ConnectorRegistry,
    secrets: undefined as unknown as Map<string, string>,
    built: [] as ConnectorProviderBootstrapper[],
    makeBootstrapper,
    bootstrapperOptions,
  };

  beforeEach(() => {
    h.db = createDb(':memory:');
    runMigrations(h.db);
    h.registry = new ConnectorRegistry({ db: h.db });
    h.secrets = new Map();
  });

  afterEach(() => {
    // A failed check schedules an automatic one; never let it outlive its test.
    for (const bootstrapper of h.built.splice(0)) bootstrapper.stop();
  });

  function makeBootstrapper(opts?: {
    nangoEnv?: () => { baseUrl?: string; encryptionKey?: string };
    rawMcpServers?: () => RawMcpServerDescriptor[];
    testConnector?: ConstructorParameters<typeof ConnectorProviderBootstrapper>[0]['testConnector'];
    /** Error the Composio connection check rejects with (the wrong-key branch). */
    composioProbeError?: Error;
    /** A scripted Composio client, for tests that need its listing to change. */
    composioClient?: ComposioHttpClient;
    managedCloud?: ConstructorParameters<typeof ConnectorProviderBootstrapper>[0]['managedCloud'];
    nangoClient?: NangoHttpClient;
  }) {
    const bootstrapper = new ConnectorProviderBootstrapper({
      rawMcpPendingConnect: () => undefined,
      registry: h.registry,
      credentials: fakeCredentials(h.secrets),
      nangoEnv: opts?.nangoEnv ?? (() => ({})),
      rawMcpServers: opts?.rawMcpServers ?? (() => []),
      // Hermetic vendor clients: without these the post-registration connection
      // check would issue a real network request from the test suite.
      makeComposioClient: () =>
        opts?.composioClient ?? fakeComposioClient(opts?.composioProbeError),
      makeNangoClient: () => opts?.nangoClient ?? fakeNangoClient(),
      ...(opts?.testConnector && { testConnector: opts.testConnector }),
      ...(opts?.managedCloud && { managedCloud: opts.managedCloud }),
    });
    h.built.push(bootstrapper);
    return bootstrapper;
  }

  /** The options {@link makeBootstrapper} builds, for tests that construct one themselves. */
  function bootstrapperOptions() {
    return {
      rawMcpPendingConnect: () => undefined,
      registry: h.registry,
      credentials: fakeCredentials(h.secrets),
      nangoEnv: () => ({}),
      rawMcpServers: () => [],
      makeComposioClient: () => fakeComposioClient(),
      makeNangoClient: () => fakeNangoClient(),
    };
  }
  return h;
}

export function managedCloud(linked: () => boolean, create: () => FakeConnectorProvider) {
  return {
    instanceId: 'managed-provider' as never,
    configured: linked,
    executionConfigDigest: () => (linked() ? 'linked-material' : undefined),
    create,
  };
}

/** State and helpers for the "fresh way and sign-in facts (DOR-2501)" tests. */
export function useFreshFactsHarness(h: ReturnType<typeof useBootstrapHarness>) {
  const f = {
    composioInstance: legacyDefaultProviderInstanceId('composio') as ConnectorProviderInstanceId,
    instanceStatus: (id: string) =>
      h.db
        .select({ status: connectorProviderInstances.status })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, id))
        .get()?.status,
    signIn: (connectionId: string) =>
      h.db
        .select({ status: connections.status })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .get()?.status,
    scriptedComposioClient,
    keepComposioAccount,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A Composio client whose account listing each test scripts. */
  function scriptedComposioClient(
    listing: () => Promise<ComposioConnectedAccount[]>
  ): ComposioHttpClient & { listings: number } {
    const client = {
      listings: 0,
      keyKind: () => 'project' as const,
      listToolkits: () => Promise.resolve([]),
      initiateConnection: () => Promise.reject(new Error('not used')),
      getConnectionState: () => Promise.reject(new Error('not used')),
      listConnectedAccounts: () => {
        client.listings += 1;
        return listing();
      },
      deleteConnectedAccount: () => Promise.resolve(),
    };
    return client;
  }

  /** Keep one signed-in Gmail account connected through Composio. */
  function keepComposioAccount(accountId: string): string {
    const now = '2026-09-28T00:00:00.000Z';
    h.db
      .insert(connectorProviderInstances)
      .values({
        id: f.composioInstance,
        type: 'composio',
        mode: 'byo',
        displayName: 'composio',
        custody: 'managed',
        capabilityJson: '{}',
        status: 'available',
        executionConfigGeneration: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    h.db
      .insert(connections)
      .values({
        id: `connection-${accountId}`,
        providerInstanceId: f.composioInstance,
        externalAccountRef: toComposioExternalAccountRef(accountId),
        toolkit: 'gmail',
        label: 'Gmail',
        status: 'active',
        grantReconciliationStatus: 'ready',
        createdAt: now,
        updatedAt: now,
        lastVerifiedAt: now,
      })
      .run();
    return `connection-${accountId}`;
  }
  return f;
}
