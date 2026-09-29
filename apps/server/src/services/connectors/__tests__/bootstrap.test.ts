import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import type {
  ConnectorExternalAccountRef,
  ConnectorProvider,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-provider';
import type { CredentialProvider, CredentialResolution } from '../../core/credential-provider.js';
import { ConnectorRegistry } from '../registry.js';
import { legacyDefaultProviderInstanceId } from '../legacy-connection-migration.js';
import {
  ConnectorProviderBootstrapper,
  WAY_RECHECK_DELAYS_MS,
  TEST_CONNECTOR_API_KEY_REF,
  TEST_CONNECTOR_CREDENTIAL_NAME,
  TEST_CONNECTOR_PROVIDER_TYPE,
} from '../bootstrap.js';
import { MANAGED_CUSTODY_CANONICAL_SENTENCE } from '../custody-disclosure.js';
import {
  COMPOSIO_API_KEY_REF,
  toExternalAccountRef as toComposioExternalAccountRef,
} from '../providers/composio.js';
import {
  ComposioApiError,
  type ComposioConnectedAccount,
  type ComposioHttpClient,
} from '../providers/composio-client.js';
import { NANGO_SECRET_KEY_REF } from '../providers/nango.js';
import { ManagedCloudConnectorProvider } from '../providers/managed/managed-cloud.js';
import { ManagedConnectorCloudError } from '../../core/auth/cloud-link-client.js';
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

  /** Every bootstrapper {@link makeBootstrapper} built, stopped after each test. */
  const built: ConnectorProviderBootstrapper[] = [];

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    secrets = new Map();
  });

  afterEach(() => {
    // A failed check schedules an automatic one; never let it outlive its test.
    for (const bootstrapper of built.splice(0)) bootstrapper.stop();
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
      registry,
      credentials: fakeCredentials(secrets),
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
    built.push(bootstrapper);
    return bootstrapper;
  }

  /** The options {@link makeBootstrapper} builds, for tests that construct one themselves. */
  function bootstrapperOptions() {
    return {
      rawMcpPendingConnect: () => undefined,
      registry,
      credentials: fakeCredentials(secrets),
      nangoEnv: () => ({}),
      rawMcpServers: () => [],
      makeComposioClient: () => fakeComposioClient(),
      makeNangoClient: () => fakeNangoClient(),
    };
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

    describe('saved Nango accounts follow their integration to its popular app (DOR-2436)', () => {
      const nangoEnv = () => ({
        baseUrl: 'http://localhost:3003',
        encryptionKey: VALID_ENCRYPTION_KEY,
      });

      /** Save two accounts under the integration's own key, one of them disconnected. */
      function saveUnderOldKey() {
        const nangoId = legacyDefaultProviderInstanceId('nango') as ConnectorProviderInstanceId;
        const earlier = new FakeConnectorProvider({ instanceId: nangoId, type: 'nango' });
        registry.register(earlier);
        const save = (ref: string) =>
          registry.recordConnect(earlier, {
            externalAccountRef: ref as ConnectorExternalAccountRef,
            toolkit: 'google-mail',
            label: 'google-mail',
            status: 'active',
            custody: 'self-host',
          });
        const live = save('nango:conn_1');
        const disconnected = save('nango:conn_2');
        registry.recordDisconnect(disconnected.id);
        secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
        return { live, disconnected };
      }

      const toolkitOf = (id: string) =>
        db
          .select({ toolkit: connections.toolkit })
          .from(connections)
          .where(eq(connections.id, id))
          .get()?.toolkit;

      it('moves every account saved under the old key when Nango is set up', async () => {
        const { live, disconnected } = saveUnderOldKey();

        await makeBootstrapper({
          nangoEnv,
          nangoClient: {
            ...fakeNangoClient(),
            listIntegrations: () =>
              Promise.resolve([{ uniqueKey: 'google-mail', provider: 'google-mail' }]),
          },
        }).registerBootProviders();

        expect(registry.resolveProvider('nango')).toBeDefined();
        expect(toolkitOf(live.id)).toBe('gmail');
        expect(toolkitOf(disconnected.id)).toBe('gmail');
      });

      it('still registers Nango when moving the accounts fails', async () => {
        const { live } = saveUnderOldKey();
        let reads = 0;

        const status = await makeBootstrapper({
          nangoEnv,
          nangoClient: {
            ...fakeNangoClient(),
            // The connection check reads once; the rename read fails.
            listIntegrations: () =>
              ++reads === 1
                ? Promise.resolve([{ uniqueKey: 'google-mail', provider: 'google-mail' }])
                : Promise.reject(new Error('Nango went away')),
          },
        }).reload('nango');

        // Registered and reported healthy: the move is retried next time.
        expect(status.registered).toBe(true);
        expect(status.error).toBeUndefined();
        expect(registry.resolveProvider('nango')).toBeDefined();
        expect(toolkitOf(live.id)).toBe('google-mail');
      });
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
        // The hosted side still has the account: recovery keeps it as it was.
        return [
          {
            externalAccountRef: 'account-a' as ConnectorExternalAccountRef,
            toolkit: 'gmail',
            label: 'Gmail',
            status: 'active',
            custody: 'managed',
          },
        ];
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

    it('a probe failure on re-save of a live provider takes it away', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-good');
      await makeBootstrapper().registerBootProviders();
      expect(registry.resolveProvider('composio')).toBeDefined();

      // Same registry, new bootstrapper whose probe fails — models re-saving a
      // broken key over a working one.
      const broken = makeBootstrapper({
        composioProbeError: new ComposioApiError(401, 'unauthorized'),
      });
      const status = await broken.reload('composio');
      expect(status.registered).toBe(false);
      expect(registry.resolveProvider('composio')).toBeUndefined();
    });

    it('takes a previously-live provider away when a reload refuses its setup', async () => {
      secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      const nangoSettings: { baseUrl: string; encryptionKey?: string } = {
        baseUrl: 'http://localhost:3003',
        encryptionKey: VALID_ENCRYPTION_KEY,
      };
      const bootstrapper = makeBootstrapper({ nangoEnv: () => ({ ...nangoSettings }) });
      await bootstrapper.registerBootProviders();
      expect(registry.resolveProvider('nango')).toBeDefined();

      delete nangoSettings.encryptionKey;
      await bootstrapper.reload('nango');
      expect(registry.resolveProvider('nango')).toBeUndefined();
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

      // Each status names the provider instance its connections carry — the
      // live one when registered, the deterministic one it registers as when
      // not — so a client can group connections by key exactly.
      expect(composio.providerInstanceId).toBe(registry.resolveProvider('composio')!.instanceId);
      expect(statuses.find((s) => s.type === 'nango')!.providerInstanceId).toBe(
        legacyDefaultProviderInstanceId('nango')
      );

      // No status may carry a secret or a reference value.
      const serialized = JSON.stringify(statuses);
      expect(serialized).not.toContain('ck-live-test');
      expect(serialized).not.toContain('file:');
    });
  });

  describe('appConnections — which way new apps use', () => {
    function managedCloud(linked: () => boolean, create: () => FakeConnectorProvider) {
      return {
        instanceId: 'managed-provider' as never,
        configured: linked,
        executionConfigDigest: () => (linked() ? 'linked-material' : undefined),
        create,
      };
    }

    it('needs the one-time step on a bare install, and raw MCP is never a way', async () => {
      const bootstrapper = makeBootstrapper();
      await bootstrapper.registerBootProviders();
      await expect(bootstrapper.appConnections()).resolves.toEqual({
        ways: [],
        newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
      });
    });

    it('uses the one working key silently, naming the service it signs in through', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const bootstrapper = makeBootstrapper();
      await bootstrapper.registerBootProviders();
      const composio = registry.resolveProvider('composio')!;

      const result = await bootstrapper.appConnections();
      const way = {
        kind: 'own_key',
        type: 'composio',
        status: 'ready',
        providerInstanceId: composio.instanceId,
        canRunActions: true,
        signInThrough: 'Composio',
      };
      expect(result).toEqual({ ways: [way], newApps: { status: 'ready', way } });
      expect(JSON.stringify(result)).not.toContain('ck-live-test');
    });

    it('prefers the person’s own key over a working DorkOS account', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const bootstrapper = makeBootstrapper({
        managedCloud: managedCloud(
          () => true,
          () => managed
        ),
      });
      await bootstrapper.registerBootProviders();

      const { ways, newApps } = await bootstrapper.appConnections();
      expect(ways.map((way) => [way.kind, way.status])).toEqual([
        ['own_key', 'ready'],
        ['dorkos_account', 'ready'],
      ]);
      expect(newApps).toMatchObject({
        status: 'ready',
        way: { kind: 'own_key', type: 'composio' },
      });
    });

    it('uses a working DorkOS account when it is the only way, signing in through Composio', async () => {
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const bootstrapper = makeBootstrapper({
        managedCloud: managedCloud(
          () => true,
          () => managed
        ),
      });
      await bootstrapper.registerBootProviders();

      await expect(bootstrapper.appConnections()).resolves.toMatchObject({
        newApps: {
          status: 'ready',
          way: {
            kind: 'dorkos_account',
            type: 'dorkos-managed',
            providerInstanceId: 'managed-provider',
            signInThrough: 'Composio',
          },
        },
      });
    });

    it('says why when the linked DorkOS account cannot connect apps', async () => {
      const refusing = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      Object.defineProperty(refusing, 'listAccounts', {
        value: () => Promise.reject(new Error('app connections are not available')),
      });
      const bootstrapper = makeBootstrapper({
        managedCloud: managedCloud(
          () => true,
          () => refusing
        ),
      });
      await bootstrapper.registerBootProviders();

      await expect(bootstrapper.appConnections()).resolves.toEqual({
        ways: [
          {
            kind: 'dorkos_account',
            type: 'dorkos-managed',
            status: 'unavailable',
            signInThrough: 'Composio',
          },
        ],
        newApps: { status: 'setup_needed', reason: 'dorkos_account_unavailable' },
      });
    });

    it('does not count a registered way whose provider reports sign-in unavailable', async () => {
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const capabilities = managed.getCapabilities();
      Object.defineProperty(managed, 'getCapabilities', {
        value: () => ({
          ...capabilities,
          capabilities: {
            ...capabilities.capabilities,
            authentication: { status: 'unsupported', reason: 'Not available for this account.' },
          },
        }),
      });
      const bootstrapper = makeBootstrapper({
        managedCloud: managedCloud(
          () => true,
          () => managed
        ),
      });
      await bootstrapper.registerBootProviders();
      // Registered — it answered — but not a way new apps can use.
      expect(registry.resolveProviderInstance(managed.instanceId)).toBe(managed);

      await expect(bootstrapper.appConnections()).resolves.toEqual({
        ways: [
          {
            kind: 'dorkos_account',
            type: 'dorkos-managed',
            status: 'unavailable',
            signInThrough: 'Composio',
          },
        ],
        newApps: { status: 'setup_needed', reason: 'dorkos_account_unavailable' },
      });
    });

    it('names the unlinked DorkOS account while apps connected through it are kept', async () => {
      let linked = true;
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const bootstrapper = makeBootstrapper({
        managedCloud: managedCloud(
          () => linked,
          () => managed
        ),
      });
      await bootstrapper.registerBootProviders();
      db.insert(connections)
        .values({
          id: 'connection-managed',
          providerInstanceId: 'managed-provider',
          externalAccountRef: 'managed-account',
          toolkit: 'gmail',
          label: 'Gmail',
          status: 'active',
          lifecycleState: 'connected',
          enabled: true,
          grantReconciliationStatus: 'ready',
          createdAt: '2026-09-28T00:00:00.000Z',
          updatedAt: '2026-09-28T00:00:00.000Z',
        })
        .run();
      expect(bootstrapper.wayProblem('managed-provider')).toBeUndefined();

      // The cloud revokes the key: the route goes, the Gmail account stays.
      linked = false;
      await bootstrapper.reloadManagedCloud();

      await expect(bootstrapper.appConnections()).resolves.toEqual({
        ways: [
          {
            kind: 'dorkos_account',
            type: 'dorkos-managed',
            status: 'unlinked',
            signInThrough: 'Composio',
          },
        ],
        newApps: { status: 'setup_needed', reason: 'dorkos_account_unlinked' },
      });
      expect(bootstrapper.wayProblem('managed-provider')).toBe('dorkos_account_unlinked');

      // Once nothing is kept through it, an unlinked account is simply not set up.
      db.update(connections)
        .set({ lifecycleState: 'disconnected' })
        .where(eq(connections.id, 'connection-managed'))
        .run();
      await expect(bootstrapper.appConnections()).resolves.toEqual({
        ways: [],
        newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
      });
    });

    describe('after linking again', () => {
      const AT = '2026-09-28T00:00:00.000Z';

      /** A DorkOS account link whose fingerprint the test can change, as a new link does. */
      function link(initial: string | null) {
        const state = {
          digest: initial,
          provider: new FakeConnectorProvider({
            instanceId: 'managed-provider' as never,
            type: 'dorkos-managed',
            custody: 'managed',
            toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
          }) as ConnectorProvider,
        };
        const cloud = {
          instanceId: 'managed-provider' as never,
          configured: () => state.digest !== null,
          executionConfigDigest: () => state.digest ?? undefined,
          create: () => state.provider,
        };
        return { state, cloud };
      }

      function keptManagedRow(id: string, externalAccountRef: string) {
        db.insert(connections)
          .values({
            id,
            providerInstanceId: 'managed-provider',
            externalAccountRef,
            toolkit: 'gmail',
            label: id,
            status: 'active',
            lifecycleState: 'connected',
            enabled: true,
            grantReconciliationStatus: 'ready',
            createdAt: AT,
            updatedAt: AT,
          })
          .run();
      }

      function grantOn(connectionId: string) {
        db.insert(connectorOperationRevisions)
          .values({
            id: `revision-${connectionId}`,
            providerInstanceId: 'managed-provider',
            toolkit: 'gmail',
            operationSlug: `gmail.list.${connectionId}`,
            toolkitVersion: '1',
            schemaHash: 'sha256:x',
            capabilityClassification: 'read',
            retryPolicy: 'never',
            inputSchemaJson: '{}',
            discoveredAt: AT,
          })
          .run();
        db.insert(connectionOperationGrants)
          .values({
            id: `grant-${connectionId}`,
            subjectType: 'agent',
            subjectId: 'agent-x',
            agentId: 'agent-x',
            connectionId,
            operationRevisionId: `revision-${connectionId}`,
            createdBy: 'operator',
            createdAt: AT,
          })
          .run();
      }

      function row(id: string) {
        return db.select().from(connections).where(eq(connections.id, id)).get()!;
      }

      /** A new hosted side for a new link, listing one account of its own. */
      async function freshSideWithOneAccount(state: { provider: ConnectorProvider }) {
        const fresh = new FakeConnectorProvider({
          instanceId: 'managed-provider' as never,
          type: 'dorkos-managed',
          custody: 'managed',
          toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
        });
        const flow = await fresh.startConnect('gmail');
        const poll = await fresh.pollConnect(flow.flowId);
        state.provider = fresh;
        return poll.status === 'connected' ? poll.account!.externalAccountRef : '';
      }

      it('keeps the access of an account the new link still lists, and sends refused changes again', async () => {
        const { state, cloud } = link('link-1');
        const relinked: string[] = [];
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
          onRelinked: (instanceId) => relinked.push(instanceId),
        });
        await bootstrapper.registerBootProviders();
        const kept = await freshSideWithOneAccount(state);
        keptManagedRow('connection-kept', kept);
        grantOn('connection-kept');
        keptManagedRow('connection-other', 'managed-other-account');
        grantOn('connection-other');
        const fresh = state.provider;
        // The same account, linked again: its new link lists this one account.
        state.digest = 'link-2';
        state.provider = fresh;

        await bootstrapper.reloadManagedCloud();

        // Listed: the same account, reached again, keeps what it was given.
        expect(row('connection-kept')).toMatchObject({
          lifecycleState: 'connected',
          grantReconciliationStatus: 'ready',
        });
        // Not listed: closed exactly as before.
        expect(row('connection-other').lifecycleState).toBe('disconnected');
        expect(relinked).toEqual(['managed-provider']);
      });

      it('leaves every account alone when the same link answers without one', async () => {
        const { cloud } = link('link-1');
        const closed: unknown[] = [];
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
          onClosedByNewLink: (accounts) => closed.push(...accounts),
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');

        await bootstrapper.reloadManagedCloud();

        expect(row('connection-old').lifecycleState).toBe('connected');
        expect(closed).toEqual([]);
      });

      it('closes a kept account a new link does not list, keeps one it does, and says so', async () => {
        const { state, cloud } = link('link-1');
        const closed: unknown[] = [];
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
          onClosedByNewLink: (accounts) => closed.push(...accounts),
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');
        grantOn('connection-old');

        state.digest = 'link-2';
        keptManagedRow('connection-new', await freshSideWithOneAccount(state));
        await bootstrapper.reloadManagedCloud();

        // Closed, not removed: it reads as disconnected, and its access has
        // ended. The account may still be live at the service, so cleanup is
        // owed and unknown, as after a local revoke.
        expect(row('connection-old')).toMatchObject({
          lifecycleState: 'disconnected',
          externalCleanupState: 'unknown',
          status: 'revoked',
          enabled: false,
          removedAt: null,
        });
        expect(
          db
            .select()
            .from(connectionOperationGrants)
            .where(eq(connectionOperationGrants.id, 'grant-connection-old'))
            .get()?.revokedAt
        ).toBeTruthy();
        expect(row('connection-new').lifecycleState).toBe('connected');
        expect(closed).toEqual([
          { connectionId: 'connection-old', toolkit: 'gmail', label: 'connection-old' },
        ]);
      });

      it('closes it after unlinking, restarting and linking again with a new link', async () => {
        const first = link('link-1');
        const before = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: first.cloud,
        });
        await before.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');
        first.state.digest = null;
        await before.reloadManagedCloud();
        expect(row('connection-old').lifecycleState).toBe('connected');

        // A restart: a fresh registry and bootstrapper over the same database,
        // now linked again with a different link.
        registry = new ConnectorRegistry({ db });
        const again = link('link-2');
        await freshSideWithOneAccount(again.state);
        const after = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: again.cloud,
        });
        await after.registerBootProviders();

        expect(row('connection-old').lifecycleState).toBe('disconnected');
      });

      it('closes from a recovery under a new link, and not under the same one', async () => {
        const { state, cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');

        // Same link: recovery registers again and closes nothing.
        registry.unregisterProviderInstance('managed-provider' as never);
        await freshSideWithOneAccount(state);
        await bootstrapper.recoverManagedCloud();
        expect(registry.resolveProviderInstance('managed-provider' as never)).toBeDefined();
        expect(row('connection-old').lifecycleState).toBe('connected');

        // New link: recovery closes what that link does not list.
        registry.unregisterProviderInstance('managed-provider' as never);
        state.digest = 'link-2';
        await bootstrapper.recoverManagedCloud();
        expect(registry.resolveProviderInstance('managed-provider' as never)).toBeDefined();
        expect(row('connection-old').lifecycleState).toBe('disconnected');
      });

      it('still closes when the reload after linking again failed and recovery finished it', async () => {
        const { state, cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');

        // Linked again, but the reload's listing fails.
        state.digest = 'link-2';
        const failing = new FakeConnectorProvider({
          instanceId: 'managed-provider' as never,
          type: 'dorkos-managed',
          custody: 'managed',
        });
        Object.defineProperty(failing, 'listAccounts', {
          value: () => Promise.reject(new Error('listing interrupted')),
        });
        state.provider = failing;
        await bootstrapper.reloadManagedCloud();
        expect(row('connection-old').lifecycleState).toBe('connected');

        // A later recovery registers the new link and closes what it lacks.
        await freshSideWithOneAccount(state);
        await bootstrapper.recoverManagedCloud();
        expect(row('connection-old').lifecycleState).toBe('disconnected');
      });

      it('closes nothing the first time the route registers, with no earlier link on record', async () => {
        db.insert(connectorProviderInstances)
          .values({
            id: 'managed-provider',
            type: 'dorkos-managed',
            mode: 'managed',
            displayName: 'dorkos-managed',
            custody: 'managed',
            capabilityJson: '{}',
            status: 'unavailable',
            createdAt: AT,
            updatedAt: AT,
          })
          .run();
        keptManagedRow('connection-old', 'managed-old-account');
        const { cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
        });

        await bootstrapper.registerBootProviders();

        expect(registry.resolveProviderInstance('managed-provider' as never)).toBeDefined();
        expect(row('connection-old').lifecycleState).toBe('connected');
      });

      it('touches nothing when the listing fails', async () => {
        const { state, cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');

        state.digest = 'link-2';
        const failing = new FakeConnectorProvider({
          instanceId: 'managed-provider' as never,
          type: 'dorkos-managed',
          custody: 'managed',
        });
        Object.defineProperty(failing, 'listAccounts', {
          value: () => Promise.reject(new Error('listing interrupted')),
        });
        state.provider = failing;
        await bootstrapper.reloadManagedCloud();

        expect(row('connection-old')).toMatchObject({
          lifecycleState: 'connected',
          status: 'active',
          enabled: true,
        });
      });

      it('touches nothing when the new link answers with only part of its list', async () => {
        const { state, cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...bootstrapperOptions(),
          managedCloud: cloud,
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');

        // The real DorkOS account route, over a first page that says more follow.
        state.digest = 'link-2';
        state.provider = new ManagedCloudConnectorProvider({
          instanceId: 'managed-provider' as never,
          cloud: {
            listManagedConnectorAccounts: async () => ({ accounts: [], nextCursor: 'page-2' }),
          } as never,
          executionContext: () => undefined,
        });
        await bootstrapper.reloadManagedCloud();

        expect(row('connection-old').lifecycleState).toBe('connected');
        expect(registry.resolveProviderInstance('managed-provider' as never)).toBeUndefined();
      });
    });

    it('says which way an account went through is down', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'uak-wrong-kind');
      const refusing = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      Object.defineProperty(refusing, 'listAccounts', {
        value: () => Promise.reject(new Error('app connections are not available')),
      });
      const bootstrapper = makeBootstrapper({
        composioProbeError: new ComposioApiError(401, 'Invalid API key'),
        managedCloud: managedCloud(
          () => true,
          () => refusing
        ),
      });
      await bootstrapper.registerBootProviders();

      expect(bootstrapper.wayProblem('managed-provider')).toBe('dorkos_account_unavailable');
      expect(bootstrapper.wayProblem(legacyDefaultProviderInstanceId('composio'))).toBe(
        'own_key_unavailable'
      );
      // Raw MCP is always registered, so it is never a way that is down, and a
      // route this server does not set up has no fix to name.
      expect(bootstrapper.wayProblem(registry.resolveProvider('mcp')!.instanceId)).toBeUndefined();
      expect(bootstrapper.wayProblem('raw-mcp-dropped-from-config')).toBeUndefined();

      // The same facts as readiness reads them: down with the fix, or unreachable.
      // Nothing else answers and runs actions here (the key was refused too).
      expect(bootstrapper.wayHealth('managed-provider', 'gmail')).toMatchObject({
        status: 'down',
        problem: 'dorkos_account_unavailable',
        anotherWayWorks: false,
      });
      expect(bootstrapper.wayHealth('raw-mcp-dropped-from-config', 'gmail')).toEqual({
        status: 'down',
        problem: 'unreachable',
        anotherWayWorks: false,
      });
      expect(
        bootstrapper.wayHealth(registry.resolveProvider('mcp')!.instanceId, 'gmail')
      ).toMatchObject({
        status: 'up',
      });
    });

    it('says why when the saved key failed its check', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'uak-wrong-kind');
      const bootstrapper = makeBootstrapper({
        composioProbeError: new ComposioApiError(401, 'Invalid API key'),
      });
      await bootstrapper.registerBootProviders();

      await expect(bootstrapper.appConnections()).resolves.toMatchObject({
        ways: [{ kind: 'own_key', type: 'composio', status: 'unavailable' }],
        newApps: { status: 'setup_needed', reason: 'own_key_unavailable' },
      });
    });
  });

  describe('fresh way and sign-in facts (DOR-2501)', () => {
    const composioInstance = legacyDefaultProviderInstanceId(
      'composio'
    ) as ConnectorProviderInstanceId;

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
      db.insert(connectorProviderInstances)
        .values({
          id: composioInstance,
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
      db.insert(connections)
        .values({
          id: `connection-${accountId}`,
          providerInstanceId: composioInstance,
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

    const instanceStatus = (id: string) =>
      db
        .select({ status: connectorProviderInstances.status })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, id))
        .get()?.status;
    const signIn = (connectionId: string) =>
      db
        .select({ status: connections.status })
        .from(connections)
        .where(eq(connections.id, connectionId))
        .get()?.status;

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts from the service word at boot: a sign-in that expired while DorkOS was off reads expired', async () => {
      const gmail = keepComposioAccount('ca_gmail');
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const bootstrapper = makeBootstrapper({
        composioClient: scriptedComposioClient(() =>
          Promise.resolve([{ connectedAccountId: 'ca_gmail', toolkit: 'gmail', status: 'EXPIRED' }])
        ),
      });

      await bootstrapper.registerBootProviders();

      expect(registry.resolveProvider('composio')).toBeDefined();
      expect(signIn(gmail)).toBe('expired');
    });

    it('marks a way unavailable at boot when it worked last run and fails its check now', async () => {
      keepComposioAccount('ca_gmail');
      expect(instanceStatus(composioInstance)).toBe('available');
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const bootstrapper = makeBootstrapper({
        composioProbeError: new ComposioApiError(503, 'Service unavailable'),
      });

      await bootstrapper.registerBootProviders();

      expect(registry.resolveProvider('composio')).toBeUndefined();
      expect(instanceStatus(composioInstance)).toBe('unavailable');
    });

    it('checks a way that failed for a passing reason again by itself, waiting longer each time, until it answers', async () => {
      vi.useFakeTimers();
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      let outage = true;
      const client = scriptedComposioClient(() =>
        outage
          ? Promise.reject(new ComposioApiError(503, 'Service unavailable'))
          : Promise.resolve([])
      );
      const bootstrapper = makeBootstrapper({ composioClient: client });

      await bootstrapper.registerBootProviders();
      expect(client.listings).toBe(1);
      expect((await bootstrapper.reload('composio')).error).toMatch(/unavailable/);
      expect(client.listings).toBe(2);

      // First wait: 30 seconds. Still down, so the next wait doubles.
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[0]);
      expect(client.listings).toBe(3);
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[1] - 1);
      expect(client.listings).toBe(3);

      // The outage ends; the next automatic check brings the way back.
      outage = false;
      await vi.advanceTimersByTimeAsync(1);
      expect(client.listings).toBe(4);
      expect(registry.resolveProvider('composio')).toBeDefined();
      expect(instanceStatus(composioInstance)).toBe('available');
      expect((await bootstrapper.listStatuses()).find((s) => s.type === 'composio')?.error).toBe(
        undefined
      );

      // Answered: nothing else is scheduled.
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 2);
      expect(client.listings).toBe(4);
    });

    it('never re-checks a key the service refused; the person saves a working one', async () => {
      vi.useFakeTimers();
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-wrong');
      const client = scriptedComposioClient(() =>
        Promise.reject(new ComposioApiError(401, 'Invalid API key'))
      );
      const bootstrapper = makeBootstrapper({ composioClient: client });

      await bootstrapper.registerBootProviders();
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 3);

      expect(client.listings).toBe(1);
    });

    it('stops every waiting check when the server stops', async () => {
      vi.useFakeTimers();
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const client = scriptedComposioClient(() =>
        Promise.reject(new ComposioApiError(503, 'Service unavailable'))
      );
      const bootstrapper = makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();

      bootstrapper.stop();
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 3);

      expect(client.listings).toBe(1);
    });

    it('keeps a registered way whose failed listing answers when checked again, recording what it says', async () => {
      const gmail = keepComposioAccount('ca_gmail');
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      let status: 'ACTIVE' | 'EXPIRED' = 'ACTIVE';
      const client = scriptedComposioClient(() =>
        Promise.resolve([{ connectedAccountId: 'ca_gmail', toolkit: 'gmail', status }])
      );
      const bootstrapper = makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();
      const live = registry.resolveProvider('composio');

      status = 'EXPIRED';
      await bootstrapper.recheckWay(composioInstance);

      expect(registry.resolveProvider('composio')).toBe(live);
      expect(signIn(gmail)).toBe('expired');
    });

    it('takes a registered way down when it still does not answer, keeps its accounts, then brings it back', async () => {
      vi.useFakeTimers();
      const gmail = keepComposioAccount('ca_gmail');
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      let outage = false;
      const client = scriptedComposioClient(() =>
        outage
          ? Promise.reject(new Error('Composio request timed out'))
          : Promise.resolve([
              { connectedAccountId: 'ca_gmail', toolkit: 'gmail', status: 'ACTIVE' },
            ])
      );
      const bootstrapper = makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();

      outage = true;
      await bootstrapper.recheckWay(composioInstance);

      expect(registry.resolveProvider('composio')).toBeUndefined();
      expect(instanceStatus(composioInstance)).toBe('unavailable');
      expect((await bootstrapper.listStatuses()).find((s) => s.type === 'composio')).toMatchObject({
        registered: false,
        error: 'Composio request timed out',
      });
      // An outage is not a sign-in that ended.
      expect(signIn(gmail)).toBe('active');

      outage = false;
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[0]);
      expect(registry.resolveProvider('composio')).toBeDefined();
      expect(instanceStatus(composioInstance)).toBe('available');
    });

    it('brings the DorkOS account way back by itself after a passing failure while it stays linked', async () => {
      vi.useFakeTimers();
      const instanceId = 'managed-provider' as ConnectorProviderInstanceId;
      let outage = true;
      let probes = 0;
      const managed = new FakeConnectorProvider({
        instanceId,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      managed.listAccounts = () => {
        probes += 1;
        return outage ? Promise.reject(new Error('hosted outage')) : Promise.resolve([]);
      };
      let linked = true;
      const bootstrapper = makeBootstrapper({
        managedCloud: {
          instanceId,
          configured: () => linked,
          executionConfigDigest: () => (linked ? 'linked-material' : undefined),
          create: () => managed,
        },
      });

      await bootstrapper.registerBootProviders();
      expect(registry.resolveProviderInstance(instanceId)).toBeUndefined();
      outage = false;
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[0]);
      expect(registry.resolveProviderInstance(instanceId)).toBe(managed);
      expect(probes).toBe(2);

      // Unlinked after another failure: nothing more is tried.
      outage = true;
      await bootstrapper.recheckWay(instanceId);
      linked = false;
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 2);
      expect(probes).toBe(3);
    });

    it('stops checking a way that never answers, and settles on the person’s one fix', async () => {
      vi.useFakeTimers();
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const client = scriptedComposioClient(() =>
        Promise.reject(new Error('Composio request timed out'))
      );
      const bootstrapper = makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();

      for (const delay of WAY_RECHECK_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
      // One check at boot, then one per wait, then nothing more.
      expect(client.listings).toBe(1 + WAY_RECHECK_DELAYS_MS.length);
      expect(bootstrapper.nextWayCheckAt(composioInstance)).toBeUndefined();
      expect(bootstrapper.wayHealth(composioInstance, 'gmail')).toEqual({
        status: 'down',
        problem: 'own_key_unavailable',
        anotherWayWorks: false,
      });
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 4);
      expect(client.listings).toBe(1 + WAY_RECHECK_DELAYS_MS.length);

      // A check the person starts begins a fresh count.
      await bootstrapper.reload('composio');
      expect(bootstrapper.nextWayCheckAt(composioInstance)).toBeDefined();
    });

    it('says a way is being checked while its check runs, not that it needs fixing', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      let answer!: (accounts: ComposioConnectedAccount[]) => void;
      let first = true;
      const client = scriptedComposioClient(() => {
        if (first) {
          first = false;
          return Promise.resolve([]);
        }
        return new Promise((resolve) => {
          answer = resolve;
        });
      });
      const bootstrapper = makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();

      // A key saved again: the way is taken down while the new key is checked.
      const reloading = bootstrapper.reload('composio');
      await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
      expect(bootstrapper.wayHealth(composioInstance, 'gmail')).toMatchObject({
        status: 'down',
        problem: 'own_key_unavailable',
        checking: true,
      });
      answer([]);
      await reloading;
      expect(bootstrapper.wayHealth(composioInstance, 'gmail')).toMatchObject({ status: 'up' });
    });

    it('counts another way only when it reaches this very app', async () => {
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-wrong');
      const instanceId = 'managed-provider' as ConnectorProviderInstanceId;
      const managed = new FakeConnectorProvider({
        instanceId,
        type: 'dorkos-managed',
        custody: 'managed',
        toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
      });
      const bootstrapper = makeBootstrapper({
        composioClient: scriptedComposioClient(() =>
          Promise.reject(new ComposioApiError(401, 'Invalid API key'))
        ),
        managedCloud: {
          instanceId,
          configured: () => true,
          executionConfigDigest: () => 'linked-material',
          create: () => managed,
        },
      });
      await bootstrapper.registerBootProviders();

      // Nothing is known yet about which apps the DorkOS account reaches.
      expect(bootstrapper.wayHealth(composioInstance, 'gmail')).toMatchObject({
        anotherWayWorks: false,
      });
      await registry.readCatalog(managed, new AbortController().signal);
      expect(bootstrapper.wayHealth(composioInstance, 'gmail')).toMatchObject({
        anotherWayWorks: true,
      });
      // It doesn't reach Slack, so connecting Slack again that way can't help.
      expect(bootstrapper.wayHealth(composioInstance, 'slack')).toMatchObject({
        anotherWayWorks: false,
      });
    });

    it('says when the next automatic check of a down way is due, and nothing once none is waiting', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'));
      secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      let failure: Error | undefined = new ComposioApiError(503, 'Service unavailable');
      const client = scriptedComposioClient(() =>
        failure ? Promise.reject(failure) : Promise.resolve([])
      );
      const bootstrapper = makeBootstrapper({ composioClient: client });

      expect(bootstrapper.nextWayCheckAt(composioInstance)).toBeUndefined();
      await bootstrapper.registerBootProviders();
      expect(bootstrapper.nextWayCheckAt(composioInstance)).toBe('2026-09-28T12:00:30.000Z');
      // Readiness reads the same time, so the account says DorkOS is on it.
      expect(bootstrapper.wayHealth(composioInstance, 'gmail')).toMatchObject({
        status: 'down',
        problem: 'own_key_unavailable',
        nextCheckAt: '2026-09-28T12:00:30.000Z',
      });
      // Another way's id, or a way DorkOS does not set up, has nothing waiting.
      expect(bootstrapper.nextWayCheckAt('unknown-instance')).toBeUndefined();

      // Still down after the first wait: the next one is a minute later.
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[0]);
      expect(bootstrapper.nextWayCheckAt(composioInstance)).toBe('2026-09-28T12:01:30.000Z');

      // Answers: nothing waiting.
      failure = undefined;
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[1]);
      expect(registry.resolveProvider('composio')).toBeDefined();
      expect(bootstrapper.nextWayCheckAt(composioInstance)).toBeUndefined();

      // A key the service refuses waits for the owner: nothing to show.
      failure = new ComposioApiError(401, 'Invalid API key');
      await bootstrapper.reload('composio');
      expect(bootstrapper.nextWayCheckAt(composioInstance)).toBeUndefined();
      expect(bootstrapper.wayHealth(composioInstance, 'gmail')).not.toHaveProperty('nextCheckAt');
    });

    it.each([
      ['unauthorized', 401, 1],
      ['permission_upgrade_required', 403, 1],
      // A plain refused request, even a 403, can pass: it is checked again.
      ['request_failed', 403, 2],
    ] as const)(
      'on a DorkOS account %s (%i), makes %i check(s) in the first minute',
      async (code, status, expectedProbes) => {
        vi.useFakeTimers();
        const instanceId = 'managed-provider' as ConnectorProviderInstanceId;
        let probes = 0;
        const managed = new FakeConnectorProvider({
          instanceId,
          type: 'dorkos-managed',
          custody: 'managed',
        });
        managed.listAccounts = () => {
          probes += 1;
          return Promise.reject(new ManagedConnectorCloudError(code, status));
        };
        const bootstrapper = makeBootstrapper({
          managedCloud: {
            instanceId,
            configured: () => true,
            executionConfigDigest: () => 'linked-material',
            create: () => managed,
          },
        });

        await bootstrapper.registerBootProviders();
        await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[0]);

        expect(probes).toBe(expectedProbes);
        expect(bootstrapper.nextWayCheckAt(instanceId) !== undefined).toBe(expectedProbes > 1);
      }
    );
  });
});
