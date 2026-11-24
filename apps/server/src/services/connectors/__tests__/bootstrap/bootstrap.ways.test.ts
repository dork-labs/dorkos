import { describe, it, expect } from 'vitest';
import { KEY_CHECK_COPY } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { legacyDefaultProviderInstanceId } from '../../legacy-connection-migration.js';
import {
  TEST_CONNECTOR_API_KEY_REF,
  TEST_CONNECTOR_CREDENTIAL_NAME,
  TEST_CONNECTOR_PROVIDER_TYPE,
  ConnectorProviderBootstrapper,
} from '../../bootstrap.js';
import { MANAGED_CUSTODY_CANONICAL_SENTENCE } from '../../custody-disclosure.js';
import { COMPOSIO_API_KEY_REF } from '../../providers/composio.js';
import { ComposioApiError } from '../../providers/composio-client.js';
import { useBootstrapHarness, managedCloud } from './bootstrap.fixtures.js';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  eq,
} from '@dorkos/db';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import { ManagedCloudConnectorProvider } from '../../providers/managed/managed-cloud.js';

/** Reloading a provider when its key changes, the status surface, which way new apps use, and linking again. */
describe('ConnectorProviderBootstrapper', () => {
  const h = useBootstrapHarness();

  describe('reload — the live credential seam', () => {
    it('registers Composio live after a key write, and unregisters after a delete', async () => {
      const bootstrapper = h.makeBootstrapper();
      await bootstrapper.registerBootProviders();
      expect(h.registry.resolveProvider('composio')).toBeUndefined();

      // The credential route writes the key, then reloads: registered, no restart.
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const afterSave = await bootstrapper.reload('composio');
      expect(afterSave).toMatchObject({ type: 'composio', configured: true, registered: true });
      expect(h.registry.resolveProvider('composio')).toBeDefined();

      // Delete → reload: unregistered again.
      h.secrets.delete(COMPOSIO_API_KEY_REF);
      const afterDelete = await bootstrapper.reload('composio');
      expect(afterDelete).toMatchObject({ type: 'composio', configured: false, registered: false });
      expect(h.registry.resolveProvider('composio')).toBeUndefined();
    });

    it('swaps atomically: a reload replaces the previous instance rather than stacking', async () => {
      const bootstrapper = h.makeBootstrapper();
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-1');
      await bootstrapper.registerBootProviders();
      const first = h.registry.resolveProvider('composio');

      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-2');
      await bootstrapper.reload('composio');
      const second = h.registry.resolveProvider('composio');
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(h.registry.listProviders().filter((p) => p.type === 'composio')).toHaveLength(1);
    });

    it('the status names which key kind validated once the probe succeeds (DOR-736)', async () => {
      h.secrets.set(COMPOSIO_API_KEY_REF, 'uak_founder_key');
      const bootstrapper = h.makeBootstrapper();
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
      // "actually answers", and the person reads one plain line about the key.
      h.secrets.set(COMPOSIO_API_KEY_REF, 'uak-wrong-kind-of-key');
      const bootstrapper = h.makeBootstrapper({
        composioProbeError: new ComposioApiError(
          401,
          'Composio request failed (401): Invalid API key: uak**SGn9 Please check you are using a valid API key.'
        ),
      });

      const status = await bootstrapper.reload('composio');
      expect(status).toMatchObject({ type: 'composio', configured: true, registered: false });
      // The service's own text goes to the log; the person reads one plain line.
      expect(status.error).toBe(KEY_CHECK_COPY.refused);
      expect(status.error).not.toMatch(/401|uak/);
      // Unregistered: the toolkit aggregation never even asks it.
      expect(h.registry.resolveProvider('composio')).toBeUndefined();
    });

    it('a probe failure on re-save of a live provider takes it away', async () => {
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-good');
      await h.makeBootstrapper().registerBootProviders();
      expect(h.registry.resolveProvider('composio')).toBeDefined();

      // Same registry, new bootstrapper whose probe fails — models re-saving a
      // broken key over a working one.
      const broken = h.makeBootstrapper({
        composioProbeError: new ComposioApiError(401, 'unauthorized'),
      });
      const status = await broken.reload('composio');
      expect(status.registered).toBe(false);
      expect(h.registry.resolveProvider('composio')).toBeUndefined();
    });
  });

  describe('status + route validity surface', () => {
    it('accepts test-connector only when the test spec is present, gated on its credential', async () => {
      const bootstrapper = h.makeBootstrapper({
        // Slice E supplies the scripted provider; a null factory keeps the seam
        // honest meanwhile (key saved, nothing registered).
        testConnector: { create: async () => null },
      });
      expect(bootstrapper.credentialNameFor(TEST_CONNECTOR_PROVIDER_TYPE)).toBe(
        TEST_CONNECTOR_CREDENTIAL_NAME
      );

      h.secrets.set(TEST_CONNECTOR_API_KEY_REF, 'test-key');
      const status = await bootstrapper.reload(TEST_CONNECTOR_PROVIDER_TYPE);
      expect(status).toMatchObject({
        type: TEST_CONNECTOR_PROVIDER_TYPE,
        configured: true,
        registered: false,
      });
    });

    it('lists reference-free statuses whose managed disclosure is the ADR-canonical sentence', async () => {
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const bootstrapper = h.makeBootstrapper();
      await bootstrapper.registerBootProviders();

      const statuses = await bootstrapper.listStatuses();
      expect(statuses.map((s) => s.type).sort()).toEqual(['composio', 'nango']);

      const composio = statuses.find((s) => s.type === 'composio')!;
      expect(composio.custody).toBe('managed');
      expect(composio.disclosure).toBe(MANAGED_CUSTODY_CANONICAL_SENTENCE);

      // Each status names the provider instance its connections carry — the
      // live one when registered, the deterministic one it registers as when
      // not — so a client can group connections by key exactly.
      expect(composio.providerInstanceId).toBe(h.registry.resolveProvider('composio')!.instanceId);
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
    it('needs the one-time step on a bare install, and raw MCP is never a way', async () => {
      const bootstrapper = h.makeBootstrapper();
      await bootstrapper.registerBootProviders();
      await expect(bootstrapper.appConnections()).resolves.toEqual({
        ways: [],
        newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
      });
    });

    it('uses the one working key silently, naming the service it signs in through', async () => {
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const bootstrapper = h.makeBootstrapper();
      await bootstrapper.registerBootProviders();
      const composio = h.registry.resolveProvider('composio')!;

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
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live-test');
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const bootstrapper = h.makeBootstrapper({
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
        h.db
          .insert(connections)
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
        h.db
          .insert(connectorOperationRevisions)
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
        h.db
          .insert(connectionOperationGrants)
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
        return h.db.select().from(connections).where(eq(connections.id, id)).get()!;
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
          ...h.bootstrapperOptions(),
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

      it('closes a kept account a new link does not list, keeps one it does, and says so', async () => {
        const { state, cloud } = link('link-1');
        const closed: unknown[] = [];
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...h.bootstrapperOptions(),
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
          h.db
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

      it('closes nothing the first time the route registers, with no earlier link on record', async () => {
        h.db
          .insert(connectorProviderInstances)
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
          ...h.bootstrapperOptions(),
          managedCloud: cloud,
        });

        await bootstrapper.registerBootProviders();

        expect(h.registry.resolveProviderInstance('managed-provider' as never)).toBeDefined();
        expect(row('connection-old').lifecycleState).toBe('connected');
      });

      it('touches nothing when the listing fails', async () => {
        const { state, cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...h.bootstrapperOptions(),
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
          ...h.bootstrapperOptions(),
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
        expect(h.registry.resolveProviderInstance('managed-provider' as never)).toBeUndefined();
      });
    });
  });
});
