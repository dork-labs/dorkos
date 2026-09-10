import { describe, it, expect, beforeEach } from 'vitest';
import {
  agents,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { CredentialProvider, CredentialResolution } from '../../core/credential-provider.js';
import { ConnectorRegistry } from '../registry.js';
import {
  ConnectorProviderBootstrapper,
  TEST_CONNECTOR_API_KEY_REF,
  TEST_CONNECTOR_CREDENTIAL_NAME,
  TEST_CONNECTOR_PROVIDER_TYPE,
} from '../bootstrap.js';
import { MANAGED_CUSTODY_CANONICAL_SENTENCE } from '../custody-disclosure.js';
import { COMPOSIO_API_KEY_REF } from '../providers/composio.js';
import { ComposioApiError, type ComposioHttpClient } from '../providers/composio-client.js';
import { NANGO_SECRET_KEY_REF } from '../providers/nango.js';
import type { NangoHttpClient } from '../providers/nango-client.js';
import type { RawMcpServerDescriptor } from '../providers/raw-mcp.js';
import { ConnectorOperatorQueryService } from '../resources/operator-query-service.js';

/** A valid 256-bit key written in base64 (32 zero bytes) for the enforced gate. */
const VALID_ENCRYPTION_KEY = Buffer.alloc(32).toString('base64');

/**
 * A hermetic Composio client for the bootstrapper's connection check. The
 * probe calls `listConnectedAccounts`; `failProbeWith` drives the wrong-key
 * (401) branch. No method touches the network.
 */
function fakeComposioClient(failProbeWith?: Error): ComposioHttpClient {
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
function fakeNangoClient(): NangoHttpClient {
  return {
    listIntegrations: () => Promise.resolve([]),
    initiateConnection: () => Promise.reject(new Error('not used')),
    getConnectionState: () => Promise.reject(new Error('not used')),
    listConnections: () => Promise.resolve([]),
    deleteConnection: () => Promise.resolve(),
  };
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

describe('ConnectorProviderBootstrapper', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let secrets: Map<string, string>;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    secrets = new Map();
  });

  function makeBootstrapper(opts?: {
    nangoEnv?: () => { baseUrl?: string; encryptionKey?: string };
    rawMcpServers?: () => RawMcpServerDescriptor[];
    testConnector?: ConstructorParameters<typeof ConnectorProviderBootstrapper>[0]['testConnector'];
    onUnregistered?: (providerInstanceId: string, providerType: string) => void;
    /** Error the Composio connection check rejects with (the wrong-key branch). */
    composioProbeError?: Error;
    managedCloud?: ConstructorParameters<typeof ConnectorProviderBootstrapper>[0]['managedCloud'];
  }) {
    return new ConnectorProviderBootstrapper({
      rawMcpPendingConnect: () => undefined,
      registry,
      credentials: fakeCredentials(secrets),
      nangoEnv: opts?.nangoEnv ?? (() => ({})),
      rawMcpServers: opts?.rawMcpServers ?? (() => []),
      // Hermetic vendor clients: without these the post-registration connection
      // check would issue a real network request from the test suite.
      makeComposioClient: () => fakeComposioClient(opts?.composioProbeError),
      makeNangoClient: () => fakeNangoClient(),
      ...(opts?.testConnector && { testConnector: opts.testConnector }),
      ...(opts?.onUnregistered && { onUnregistered: opts.onUnregistered }),
      ...(opts?.managedCloud && { managedCloud: opts.managedCloud }),
    });
  }

  describe('registerBootProviders', () => {
    it('always registers raw-MCP — the empty server list is valid', async () => {
      await makeBootstrapper().registerBootProviders();
      const rawMcp = registry.resolveProvider('mcp');
      expect(rawMcp).toBeDefined();
      await expect(rawMcp!.listToolkits()).resolves.toEqual([]);
      // Nothing else registered on a bare install.
      expect(registry.listProviders().map((p) => p.type)).toEqual(['mcp']);
    });

    it('registers a configured raw-MCP server so it appears in the toolkit aggregation', async () => {
      await makeBootstrapper({
        rawMcpServers: () => [
          {
            slug: 'notion',
            displayName: 'Notion',
            connection: { transport: 'http', url: 'https://mcp.notion.test' },
          },
        ],
      }).registerBootProviders();

      const { toolkits, warnings } = await registry.listToolkits();
      expect(warnings).toEqual([]);
      expect(toolkits.map((tk) => tk.slug)).toContain('notion');
      // recommendConnector routing needs no change: the raw-mcp provider lists
      // the toolkit, so providersForToolkit already finds it.
      const { providers } = await registry.providersForToolkit('notion');
      expect(providers.map((p) => p.type)).toEqual(['mcp']);
    });

    it('registers Composio only when its API key is configured', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      await makeBootstrapper().registerBootProviders();
      expect(registry.resolveProvider('composio')).toBeDefined();
      expect(
        db
          .select({
            mode: connectorProviderInstances.mode,
            custody: connectorProviderInstances.custody,
          })
          .from(connectorProviderInstances)
          .where(eq(connectorProviderInstances.type, 'composio'))
          .get()
      ).toEqual({ mode: 'byo', custody: 'managed' });
    });

    it('registers Nango when configured with a valid encryption key', async () => {
      secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      await makeBootstrapper({
        nangoEnv: () => ({
          baseUrl: 'http://localhost:3003',
          encryptionKey: VALID_ENCRYPTION_KEY,
        }),
      }).registerBootProviders();
      expect(registry.resolveProvider('nango')).toBeDefined();
    });

    it('registers the hosted managed provider only while a linked key is configured', async () => {
      let linked = false;
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const bootstrapper = makeBootstrapper({
        managedCloud: {
          instanceId: managed.instanceId,
          configured: () => linked,
          executionConfigDigest: () => (linked ? 'linked-material' : undefined),
          create: () => managed,
        },
      });

      await bootstrapper.registerBootProviders();
      expect(registry.resolveProviderInstance(managed.instanceId)).toBeUndefined();
      linked = true;
      await bootstrapper.reloadManagedCloud();
      expect(registry.resolveProviderInstance(managed.instanceId)).toBe(managed);
      expect(
        db
          .select({
            digest: connectorProviderInstances.executionConfigDigest,
            generation: connectorProviderInstances.executionConfigGeneration,
            mode: connectorProviderInstances.mode,
          })
          .from(connectorProviderInstances)
          .where(eq(connectorProviderInstances.id, managed.instanceId))
          .get()
      ).toEqual({ digest: 'linked-material', generation: 1, mode: 'managed' });

      const restartedRegistry = new ConnectorRegistry({ db });
      const restarted = new ConnectorProviderBootstrapper({
        rawMcpPendingConnect: () => undefined,
        registry: restartedRegistry,
        credentials: fakeCredentials(secrets),
        nangoEnv: () => ({}),
        rawMcpServers: () => [],
        makeComposioClient: () => fakeComposioClient(),
        makeNangoClient: () => fakeNangoClient(),
        managedCloud: {
          instanceId: managed.instanceId,
          configured: () => linked,
          executionConfigDigest: () => (linked ? 'linked-material' : undefined),
          create: () => managed,
        },
      });
      await restarted.registerBootProviders();
      expect(
        db
          .select({
            generation: connectorProviderInstances.executionConfigGeneration,
            mode: connectorProviderInstances.mode,
          })
          .from(connectorProviderInstances)
          .where(eq(connectorProviderInstances.id, managed.instanceId))
          .get()
      ).toEqual({ generation: 1, mode: 'managed' });
      linked = false;
      await restarted.reloadManagedCloud();
      expect(restartedRegistry.resolveProviderInstance(managed.instanceId)).toBeUndefined();
    });

    it('recovers one failed hosted boot through concurrent normal catalog reads without changing authority', async () => {
      const instanceId = 'managed-provider' as never;
      const healthy = new FakeConnectorProvider({
        instanceId,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const firstBoot = makeBootstrapper({
        managedCloud: {
          instanceId,
          configured: () => true,
          executionConfigDigest: () => 'linked-material',
          create: () => healthy,
        },
      });
      await firstBoot.registerBootProviders();

      const now = '2026-09-10T00:00:00.000Z';
      db.insert(agents)
        .values({
          id: 'agent-a',
          name: 'agent-a',
          displayName: 'Agent A',
          runtime: 'claude-code',
          projectPath: '/agents/a',
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(connections)
        .values({
          id: 'connection-a',
          providerInstanceId: instanceId,
          externalAccountRef: 'account-a',
          toolkit: 'gmail',
          label: 'Gmail',
          status: 'active',
          lifecycleState: 'connected',
          enabled: true,
          grantReconciliationStatus: 'ready',
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(connectorOperationRevisions)
        .values({
          id: 'revision-a',
          providerInstanceId: instanceId,
          toolkit: 'gmail',
          operationSlug: 'GMAIL_GET_PROFILE',
          toolkitVersion: '20260910',
          schemaHash: 'sha256:profile',
          capabilityClassification: 'read',
          retryPolicy: 'never',
          inputSchemaJson: '{}',
          discoveredAt: now,
        })
        .run();
      db.insert(connectionOperationGrants)
        .values({
          id: 'grant-a',
          subjectType: 'agent',
          subjectId: 'agent-a',
          agentId: 'agent-a',
          connectionId: 'connection-a',
          operationRevisionId: 'revision-a',
          createdBy: 'operator',
          createdAt: now,
        })
        .run();

      const restartedRegistry = new ConnectorRegistry({ db });
      let probeCount = 0;
      let releaseRecovery!: () => void;
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      const recovered = new FakeConnectorProvider({
        instanceId,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      recovered.listAccounts = async () => {
        probeCount += 1;
        if (probeCount === 1) throw new Error('temporary hosted outage');
        await recoveryGate;
        return [];
      };
      const restarted = new ConnectorProviderBootstrapper({
        rawMcpPendingConnect: () => undefined,
        registry: restartedRegistry,
        credentials: fakeCredentials(secrets),
        nangoEnv: () => ({}),
        rawMcpServers: () => [],
        makeComposioClient: () => fakeComposioClient(),
        makeNangoClient: () => fakeNangoClient(),
        managedCloud: {
          instanceId,
          configured: () => true,
          executionConfigDigest: () => 'linked-material',
          create: () => recovered,
        },
      });
      await restarted.registerBootProviders();
      expect(restartedRegistry.resolveProviderInstance(instanceId)).toBeUndefined();

      const queries = new ConnectorOperatorQueryService({
        db,
        registry: restartedRegistry,
        recoverManagedProvider: () => restarted.recoverManagedCloud(),
        sessions: { resolveSessionAgent: () => undefined },
        agentOwnership: { ownsAgent: () => false },
      });
      const first = queries.catalog({ signal: new AbortController().signal });
      const second = queries.catalog({ signal: new AbortController().signal });
      await Promise.resolve();
      expect(probeCount).toBe(2);
      releaseRecovery();
      const [firstCatalog, secondCatalog] = await Promise.all([first, second]);

      expect(firstCatalog.services.some((service) => service.serviceSlug === 'gmail')).toBe(true);
      expect(secondCatalog.services.some((service) => service.serviceSlug === 'gmail')).toBe(true);
      expect(probeCount).toBe(2);
      expect(
        db
          .select({ generation: connectorProviderInstances.executionConfigGeneration })
          .from(connectorProviderInstances)
          .where(eq(connectorProviderInstances.id, instanceId))
          .get()
      ).toEqual({ generation: 1 });
      expect(db.select().from(connectionOperationGrants).all()).toEqual([
        expect.objectContaining({ id: 'grant-a', revokedAt: null }),
      ]);

      await restarted.recoverManagedCloud();
      expect(probeCount).toBe(2);
    });

    it('keeps recovery absent when unlinked, unavailable, or the linked material changes in flight', async () => {
      const instanceId = 'managed-provider' as never;
      let linked = false;
      let digest: string | undefined;
      let createCount = 0;
      let probeCount = 0;
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      const managed = new FakeConnectorProvider({
        instanceId,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      managed.listAccounts = async () => {
        probeCount += 1;
        await probeGate;
        return [];
      };
      const bootstrapper = makeBootstrapper({
        managedCloud: {
          instanceId,
          configured: () => linked,
          executionConfigDigest: () => digest,
          create: () => {
            createCount += 1;
            return managed;
          },
        },
      });

      await bootstrapper.registerBootProviders();
      await bootstrapper.recoverManagedCloud();
      expect(createCount).toBe(0);

      linked = true;
      digest = 'linked-material-a';
      const recovery = bootstrapper.recoverManagedCloud();
      await Promise.resolve();
      expect(probeCount).toBe(1);
      digest = 'linked-material-b';
      releaseProbe();
      await recovery;
      expect(registry.resolveProviderInstance(instanceId)).toBeUndefined();

      managed.listAccounts = async () => {
        probeCount += 1;
        throw new Error('hosted readiness is off');
      };
      await bootstrapper.recoverManagedCloud();
      expect(registry.resolveProviderInstance(instanceId)).toBeUndefined();
      expect(probeCount).toBe(2);
    });

    it('logs-and-skips the Nango encryption-key refusal — boot resolves, status carries the error', async () => {
      secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      const bootstrapper = makeBootstrapper({
        nangoEnv: () => ({ baseUrl: 'http://localhost:3003' }), // no encryption key
      });

      // The refusal must not fail the boot path.
      await expect(bootstrapper.registerBootProviders()).resolves.toBeUndefined();
      expect(registry.resolveProvider('nango')).toBeUndefined();

      const statuses = await bootstrapper.listStatuses();
      const nango = statuses.find((s) => s.type === 'nango')!;
      expect(nango.configured).toBe(true);
      expect(nango.registered).toBe(false);
      expect(nango.error).toMatch(/NANGO_ENCRYPTION_KEY/);
    });
  });

  describe('reload — the live credential seam', () => {
    it('registers Composio live after a key write, and unregisters after a delete', async () => {
      const bootstrapper = makeBootstrapper();
      await bootstrapper.registerBootProviders();
      expect(registry.resolveProvider('composio')).toBeUndefined();

      // The credential route writes the key, then reloads: registered, no restart.
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const afterSave = await bootstrapper.reload('composio');
      expect(afterSave).toMatchObject({ type: 'composio', configured: true, registered: true });
      expect(registry.resolveProvider('composio')).toBeDefined();

      // Delete → reload: unregistered again.
      secrets.delete(COMPOSIO_API_KEY_REF);
      const afterDelete = await bootstrapper.reload('composio');
      expect(afterDelete).toMatchObject({ type: 'composio', configured: false, registered: false });
      expect(registry.resolveProvider('composio')).toBeUndefined();
    });

    it('swaps atomically: a reload replaces the previous instance rather than stacking', async () => {
      const bootstrapper = makeBootstrapper();
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-1');
      await bootstrapper.registerBootProviders();
      const first = registry.resolveProvider('composio');

      secrets.set(COMPOSIO_API_KEY_REF, 'ck-2');
      await bootstrapper.reload('composio');
      const second = registry.resolveProvider('composio');
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(registry.listProviders().filter((p) => p.type === 'composio')).toHaveLength(1);
    });

    it('advances material generation when a confined Composio credential changes', async () => {
      const bootstrapper = makeBootstrapper();
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-1');
      await bootstrapper.registerBootProviders();
      const first = db
        .select({
          digest: connectorProviderInstances.executionConfigDigest,
          generation: connectorProviderInstances.executionConfigGeneration,
        })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.type, 'composio'))
        .get()!;

      secrets.set(COMPOSIO_API_KEY_REF, 'ck-2');
      await bootstrapper.reload('composio');
      const second = db
        .select({
          digest: connectorProviderInstances.executionConfigDigest,
          generation: connectorProviderInstances.executionConfigGeneration,
        })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.type, 'composio'))
        .get()!;

      expect(second.digest).not.toBe(first.digest);
      expect(second.generation).toBe(first.generation + 1);
    });

    it('clears a recorded Nango refusal once the reload succeeds', async () => {
      secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      const nangoSettings: { baseUrl: string; encryptionKey?: string } = {
        baseUrl: 'http://localhost:3003',
      };
      const bootstrapper = makeBootstrapper({ nangoEnv: () => ({ ...nangoSettings }) });
      await bootstrapper.registerBootProviders();
      expect((await bootstrapper.reload('nango')).error).toMatch(/NANGO_ENCRYPTION_KEY/);

      nangoSettings.encryptionKey = VALID_ENCRYPTION_KEY;
      const healthy = await bootstrapper.reload('nango');
      expect(healthy.registered).toBe(true);
      expect(healthy.error).toBeUndefined();
    });

    it('the status names which key kind validated once the probe succeeds (DOR-736)', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'uak_founder_key');
      const bootstrapper = makeBootstrapper();
      const status = await bootstrapper.reload('composio');
      // The probe validated the key, so the card can say what it is using.
      expect(status).toMatchObject({ registered: true, keyKind: 'user' });
      // A provider that does not track kinds (nango) simply omits the field.
      const statuses = await bootstrapper.listStatuses();
      expect(statuses.find((s) => s.type === 'nango')!.keyKind).toBeUndefined();
    });

    it('a key that fails the connection check never registers — the founder-401 case', async () => {
      // The exact first-contact failure (DOR-703): a stored key the credential
      // gate accepts, that Composio 401s on every call. "Registered" must mean
      // "actually answers", and the API's own message must reach the status.
      secrets.set(COMPOSIO_API_KEY_REF, 'uak-wrong-kind-of-key');
      const bootstrapper = makeBootstrapper({
        composioProbeError: new ComposioApiError(
          401,
          'Composio request failed (401): Invalid API key: uak**SGn9 Please check you are using a valid API key.'
        ),
      });

      const status = await bootstrapper.reload('composio');
      expect(status).toMatchObject({ type: 'composio', configured: true, registered: false });
      expect(status.error).toMatch(/401/);
      expect(status.error).toMatch(/valid API key/);
      // Unregistered: the toolkit aggregation never even asks it.
      expect(registry.resolveProvider('composio')).toBeUndefined();
    });

    it('a probe failure on re-save of a live provider revokes it (onUnregistered fires)', async () => {
      const unregistered: string[] = [];
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-good');
      const good = makeBootstrapper({
        onUnregistered: (_providerInstanceId, providerType) => unregistered.push(providerType),
      });
      await good.registerBootProviders();
      expect(registry.resolveProvider('composio')).toBeDefined();

      // Same registry, new bootstrapper whose probe fails — models re-saving a
      // broken key over a working one.
      const broken = makeBootstrapper({
        composioProbeError: new ComposioApiError(401, 'unauthorized'),
        onUnregistered: (_providerInstanceId, providerType) => unregistered.push(providerType),
      });
      const status = await broken.reload('composio');
      expect(status.registered).toBe(false);
      expect(registry.resolveProvider('composio')).toBeUndefined();
      expect(unregistered).toEqual(['composio']);
    });

    it('fires onUnregistered exactly when a swap takes a live provider away', async () => {
      const unregistered: string[] = [];
      const bootstrapper = makeBootstrapper({
        onUnregistered: (_providerInstanceId, providerType) => unregistered.push(providerType),
      });
      // Boot with nothing configured: nothing was ever registered → no firing.
      await bootstrapper.registerBootProviders();
      expect(unregistered).toEqual([]);

      // Save → registered; a reload with the key still present is a swap that
      // keeps the provider live → no firing.
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-1');
      await bootstrapper.reload('composio');
      await bootstrapper.reload('composio');
      expect(unregistered).toEqual([]);

      // Delete → the swap takes the live provider away → fires once.
      secrets.delete(COMPOSIO_API_KEY_REF);
      await bootstrapper.reload('composio');
      expect(unregistered).toEqual(['composio']);

      // A repeated delete-reload has nothing left to take away → no re-fire.
      await bootstrapper.reload('composio');
      expect(unregistered).toEqual(['composio']);
    });

    it('fires onUnregistered when a reload REFUSES a previously-live provider', async () => {
      const unregistered: string[] = [];
      secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      const nangoSettings: { baseUrl: string; encryptionKey?: string } = {
        baseUrl: 'http://localhost:3003',
        encryptionKey: VALID_ENCRYPTION_KEY,
      };
      const bootstrapper = makeBootstrapper({
        nangoEnv: () => ({ ...nangoSettings }),
        onUnregistered: (_providerInstanceId, providerType) => unregistered.push(providerType),
      });
      await bootstrapper.registerBootProviders();
      expect(registry.resolveProvider('nango')).toBeDefined();

      // The encryption key disappears: the reload refuses, the provider is
      // gone, and live surfaces must be revoked.
      delete nangoSettings.encryptionKey;
      await bootstrapper.reload('nango');
      expect(registry.resolveProvider('nango')).toBeUndefined();
      expect(unregistered).toEqual(['nango']);
    });

    it('throws for a provider type it does not own', async () => {
      await expect(makeBootstrapper().reload('no-such-provider')).rejects.toThrow(
        /Unknown connector provider/
      );
    });
  });

  describe('status + route validity surface', () => {
    it('maps provider types to their credential-store names; unknown types resolve undefined', () => {
      const bootstrapper = makeBootstrapper();
      expect(bootstrapper.credentialNameFor('composio')).toBe('composio-api-key');
      expect(bootstrapper.credentialNameFor('nango')).toBe('nango-secret-key');
      // test-connector is NOT accepted outside test mode…
      expect(bootstrapper.credentialNameFor(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();
      expect(bootstrapper.credentialNameFor('gmail')).toBeUndefined();
    });

    it('accepts test-connector only when the test spec is present, gated on its credential', async () => {
      const bootstrapper = makeBootstrapper({
        // Slice E supplies the scripted provider; a null factory keeps the seam
        // honest meanwhile (key saved, nothing registered).
        testConnector: { create: async () => null },
      });
      expect(bootstrapper.credentialNameFor(TEST_CONNECTOR_PROVIDER_TYPE)).toBe(
        TEST_CONNECTOR_CREDENTIAL_NAME
      );

      secrets.set(TEST_CONNECTOR_API_KEY_REF, 'test-key');
      const status = await bootstrapper.reload(TEST_CONNECTOR_PROVIDER_TYPE);
      expect(status).toMatchObject({
        type: TEST_CONNECTOR_PROVIDER_TYPE,
        configured: true,
        registered: false,
      });
    });

    it('registers a test provider the injected factory supplies (the Slice E seam)', async () => {
      const bootstrapper = makeBootstrapper({
        testConnector: {
          create: async () =>
            secrets.has(TEST_CONNECTOR_API_KEY_REF)
              ? new FakeConnectorProvider({ type: TEST_CONNECTOR_PROVIDER_TYPE })
              : null,
        },
      });
      await bootstrapper.registerBootProviders();
      expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeUndefined();

      secrets.set(TEST_CONNECTOR_API_KEY_REF, 'test-key');
      const status = await bootstrapper.reload(TEST_CONNECTOR_PROVIDER_TYPE);
      expect(status.registered).toBe(true);
      expect(registry.resolveProvider(TEST_CONNECTOR_PROVIDER_TYPE)).toBeDefined();
    });

    it('lists reference-free statuses whose managed disclosure is the ADR-canonical sentence', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const bootstrapper = makeBootstrapper();
      await bootstrapper.registerBootProviders();

      const statuses = await bootstrapper.listStatuses();
      expect(statuses.map((s) => s.type).sort()).toEqual(['composio', 'nango']);

      const composio = statuses.find((s) => s.type === 'composio')!;
      expect(composio.custody).toBe('managed');
      expect(composio.disclosure).toBe(MANAGED_CUSTODY_CANONICAL_SENTENCE);

      // No status may carry a secret or a reference value.
      const serialized = JSON.stringify(statuses);
      expect(serialized).not.toContain('ck-live-test');
      expect(serialized).not.toContain('file:');
    });
  });
});
