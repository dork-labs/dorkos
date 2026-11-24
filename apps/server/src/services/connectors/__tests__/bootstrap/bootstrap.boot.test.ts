import { describe, it, expect } from 'vitest';
import {
  agents,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  eq,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectorExternalAccountRef,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../../registry.js';
import { legacyDefaultProviderInstanceId } from '../../legacy-connection-migration.js';
import { ConnectorProviderBootstrapper } from '../../bootstrap.js';
import { COMPOSIO_API_KEY_REF } from '../../providers/composio.js';
import { NANGO_SECRET_KEY_REF } from '../../providers/nango.js';
import { ConnectorOperatorQueryService } from '../../resources/operator-query-service.js';
import {
  VALID_ENCRYPTION_KEY,
  fakeComposioClient,
  fakeNangoClient,
  fakeCredentials,
  useBootstrapHarness,
} from './bootstrap.fixtures.js';

/** Registering providers at boot, and recovering a failed hosted boot. */
describe('ConnectorProviderBootstrapper', () => {
  const h = useBootstrapHarness();

  describe('registerBootProviders', () => {
    it('registers a configured raw-MCP server so it appears in the toolkit aggregation', async () => {
      await h
        .makeBootstrapper({
          rawMcpServers: () => [
            {
              slug: 'notion',
              displayName: 'Notion',
              connection: { transport: 'http', url: 'https://mcp.notion.test' },
            },
          ],
        })
        .registerBootProviders();

      const { toolkits, warnings } = await h.registry.listToolkits();
      expect(warnings).toEqual([]);
      expect(toolkits.map((tk) => tk.slug)).toContain('notion');
      // recommendConnector routing needs no change: the raw-mcp provider lists
      // the toolkit, so providersForToolkit already finds it.
      const { providers } = await h.registry.providersForToolkit('notion');
      expect(providers.map((p) => p.type)).toEqual(['mcp']);
    });

    it('registers Composio only when its API key is configured', async () => {
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      await h.makeBootstrapper().registerBootProviders();
      expect(h.registry.resolveProvider('composio')).toBeDefined();
      expect(
        h.db
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
      h.secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      await h
        .makeBootstrapper({
          nangoEnv: () => ({
            baseUrl: 'http://localhost:3003',
            encryptionKey: VALID_ENCRYPTION_KEY,
          }),
        })
        .registerBootProviders();
      expect(h.registry.resolveProvider('nango')).toBeDefined();
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
        h.registry.register(earlier);
        const save = (ref: string) =>
          h.registry.recordConnect(earlier, {
            externalAccountRef: ref as ConnectorExternalAccountRef,
            toolkit: 'google-mail',
            label: 'google-mail',
            status: 'active',
            custody: 'self-host',
          });
        const live = save('nango:conn_1');
        const disconnected = save('nango:conn_2');
        h.registry.recordDisconnect(disconnected.id);
        h.secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
        return { live, disconnected };
      }

      const toolkitOf = (id: string) =>
        h.db
          .select({ toolkit: connections.toolkit })
          .from(connections)
          .where(eq(connections.id, id))
          .get()?.toolkit;

      it('moves every account saved under the old key when Nango is set up', async () => {
        const { live, disconnected } = saveUnderOldKey();

        await h
          .makeBootstrapper({
            nangoEnv,
            nangoClient: {
              ...fakeNangoClient(),
              listIntegrations: () =>
                Promise.resolve([{ uniqueKey: 'google-mail', provider: 'google-mail' }]),
            },
          })
          .registerBootProviders();

        expect(h.registry.resolveProvider('nango')).toBeDefined();
        expect(toolkitOf(live.id)).toBe('gmail');
        expect(toolkitOf(disconnected.id)).toBe('gmail');
      });
    });

    it('registers the hosted managed provider only while a linked key is configured', async () => {
      let linked = false;
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const bootstrapper = h.makeBootstrapper({
        managedCloud: {
          instanceId: managed.instanceId,
          configured: () => linked,
          executionConfigDigest: () => (linked ? 'linked-material' : undefined),
          create: () => managed,
        },
      });

      await bootstrapper.registerBootProviders();
      expect(h.registry.resolveProviderInstance(managed.instanceId)).toBeUndefined();
      linked = true;
      await bootstrapper.reloadManagedCloud();
      expect(h.registry.resolveProviderInstance(managed.instanceId)).toBe(managed);
      expect(
        h.db
          .select({
            digest: connectorProviderInstances.executionConfigDigest,
            generation: connectorProviderInstances.executionConfigGeneration,
            mode: connectorProviderInstances.mode,
          })
          .from(connectorProviderInstances)
          .where(eq(connectorProviderInstances.id, managed.instanceId))
          .get()
      ).toEqual({ digest: 'linked-material', generation: 1, mode: 'managed' });

      const restartedRegistry = new ConnectorRegistry({ db: h.db });
      const restarted = new ConnectorProviderBootstrapper({
        rawMcpPendingConnect: () => undefined,
        registry: restartedRegistry,
        credentials: fakeCredentials(h.secrets),
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
        h.db
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
      const firstBoot = h.makeBootstrapper({
        managedCloud: {
          instanceId,
          configured: () => true,
          executionConfigDigest: () => 'linked-material',
          create: () => healthy,
        },
      });
      await firstBoot.registerBootProviders();

      const now = '2026-09-10T00:00:00.000Z';
      h.db
        .insert(agents)
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
      h.db
        .insert(connections)
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
      h.db
        .insert(connectorOperationRevisions)
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
      h.db
        .insert(connectionOperationGrants)
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

      const restartedRegistry = new ConnectorRegistry({ db: h.db });
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
        credentials: fakeCredentials(h.secrets),
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
        db: h.db,
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
        h.db
          .select({ generation: connectorProviderInstances.executionConfigGeneration })
          .from(connectorProviderInstances)
          .where(eq(connectorProviderInstances.id, instanceId))
          .get()
      ).toEqual({ generation: 1 });
      expect(h.db.select().from(connectionOperationGrants).all()).toEqual([
        expect.objectContaining({ id: 'grant-a', revokedAt: null }),
      ]);

      await restarted.recoverManagedCloud();
      expect(probeCount).toBe(2);
    });
  });
});
