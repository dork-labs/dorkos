import { ConnectorRegistry } from '../../registry.js';
import { describe, it, expect } from 'vitest';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorProviderBootstrapper } from '../../bootstrap.js';
import { COMPOSIO_API_KEY_REF } from '../../providers/composio.js';
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

/** Which way new apps use, and what linking the DorkOS account again closes or keeps. */
describe('ConnectorProviderBootstrapper', () => {
  const h = useBootstrapHarness();

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

      it('leaves every account alone when the same link answers without one', async () => {
        const { cloud } = link('link-1');
        const closed: unknown[] = [];
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...h.bootstrapperOptions(),
          managedCloud: cloud,
          onClosedByNewLink: (accounts) => closed.push(...accounts),
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');

        await bootstrapper.reloadManagedCloud();

        expect(row('connection-old').lifecycleState).toBe('connected');
        expect(closed).toEqual([]);
      });

      it('closes it after unlinking, restarting and linking again with a new link', async () => {
        const first = link('link-1');
        const before = new ConnectorProviderBootstrapper({
          ...h.bootstrapperOptions(),
          managedCloud: first.cloud,
        });
        await before.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');
        first.state.digest = null;
        await before.reloadManagedCloud();
        expect(row('connection-old').lifecycleState).toBe('connected');

        // A restart: a fresh registry and bootstrapper over the same database,
        // now linked again with a different link.
        h.registry = new ConnectorRegistry({ db: h.db });
        const again = link('link-2');
        await freshSideWithOneAccount(again.state);
        const after = new ConnectorProviderBootstrapper({
          ...h.bootstrapperOptions(),
          managedCloud: again.cloud,
        });
        await after.registerBootProviders();

        expect(row('connection-old').lifecycleState).toBe('disconnected');
      });

      it('closes from a recovery under a new link, and not under the same one', async () => {
        const { state, cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...h.bootstrapperOptions(),
          managedCloud: cloud,
        });
        await bootstrapper.registerBootProviders();
        keptManagedRow('connection-old', 'managed-old-account');

        // Same link: recovery registers again and closes nothing.
        h.registry.unregisterProviderInstance('managed-provider' as never);
        await freshSideWithOneAccount(state);
        await bootstrapper.recoverManagedCloud();
        expect(h.registry.resolveProviderInstance('managed-provider' as never)).toBeDefined();
        expect(row('connection-old').lifecycleState).toBe('connected');

        // New link: recovery closes what that link does not list.
        h.registry.unregisterProviderInstance('managed-provider' as never);
        state.digest = 'link-2';
        await bootstrapper.recoverManagedCloud();
        expect(h.registry.resolveProviderInstance('managed-provider' as never)).toBeDefined();
        expect(row('connection-old').lifecycleState).toBe('disconnected');
      });

      it('still closes when the reload after linking again failed and recovery finished it', async () => {
        const { state, cloud } = link('link-1');
        const bootstrapper = new ConnectorProviderBootstrapper({
          ...h.bootstrapperOptions(),
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
    });

    it('names the unlinked DorkOS account while apps connected through it are kept', async () => {
      let linked = true;
      const managed = new FakeConnectorProvider({
        instanceId: 'managed-provider' as never,
        type: 'dorkos-managed',
        custody: 'managed',
      });
      const bootstrapper = h.makeBootstrapper({
        managedCloud: managedCloud(
          () => linked,
          () => managed
        ),
      });
      await bootstrapper.registerBootProviders();
      h.db
        .insert(connections)
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
      h.db
        .update(connections)
        .set({ lifecycleState: 'disconnected' })
        .where(eq(connections.id, 'connection-managed'))
        .run();
      await expect(bootstrapper.appConnections()).resolves.toEqual({
        ways: [],
        newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
      });
    });
  });
});
