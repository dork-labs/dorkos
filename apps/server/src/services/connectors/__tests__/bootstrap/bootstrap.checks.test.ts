import { describe, it, expect, vi } from 'vitest';
import { KEY_CHECK_COPY } from '@dorkos/shared/connector-schemas';
import { WAY_RECHECK_DELAYS_MS } from '../../bootstrap.js';
import { COMPOSIO_API_KEY_REF } from '../../providers/composio.js';
import { ComposioApiError } from '../../providers/composio-client.js';
import { useBootstrapHarness, useFreshFactsHarness, managedCloud } from './bootstrap.fixtures.js';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-provider';

/** Fresh way and sign-in facts, and the automatic checks that bring a way back (DOR-2501). */
describe('ConnectorProviderBootstrapper', () => {
  const h = useBootstrapHarness();

  describe('fresh way and sign-in facts (DOR-2501)', () => {
    const f = useFreshFactsHarness(h);

    it('starts from the service word at boot: a sign-in that expired while DorkOS was off reads expired', async () => {
      const gmail = f.keepComposioAccount('ca_gmail');
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const bootstrapper = h.makeBootstrapper({
        composioClient: f.scriptedComposioClient(() =>
          Promise.resolve([{ connectedAccountId: 'ca_gmail', toolkit: 'gmail', status: 'EXPIRED' }])
        ),
      });

      await bootstrapper.registerBootProviders();

      expect(h.registry.resolveProvider('composio')).toBeDefined();
      expect(f.signIn(gmail)).toBe('expired');
    });

    it('checks a way that failed for a passing reason again by itself, waiting longer each time, until it answers', async () => {
      vi.useFakeTimers();
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      let outage = true;
      const client = f.scriptedComposioClient(() =>
        outage
          ? Promise.reject(new ComposioApiError(503, 'Service unavailable'))
          : Promise.resolve([])
      );
      const bootstrapper = h.makeBootstrapper({ composioClient: client });

      await bootstrapper.registerBootProviders();
      expect(client.listings).toBe(1);
      expect((await bootstrapper.reload('composio')).error).toBe(KEY_CHECK_COPY.checkingAgain);
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
      expect(h.registry.resolveProvider('composio')).toBeDefined();
      expect(f.instanceStatus(f.composioInstance)).toBe('available');
      expect((await bootstrapper.listStatuses()).find((s) => s.type === 'composio')?.error).toBe(
        undefined
      );

      // Answered: nothing else is scheduled.
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 2);
      expect(client.listings).toBe(4);
    });

    it('never re-checks a key the service refused; the person saves a working one', async () => {
      vi.useFakeTimers();
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-wrong');
      const client = f.scriptedComposioClient(() =>
        Promise.reject(new ComposioApiError(401, 'Invalid API key'))
      );
      const bootstrapper = h.makeBootstrapper({ composioClient: client });

      await bootstrapper.registerBootProviders();
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 3);

      expect(client.listings).toBe(1);
    });

    it('stops every waiting check when the server stops', async () => {
      vi.useFakeTimers();
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const client = f.scriptedComposioClient(() =>
        Promise.reject(new ComposioApiError(503, 'Service unavailable'))
      );
      const bootstrapper = h.makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();

      bootstrapper.stop();
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 3);

      expect(client.listings).toBe(1);
    });

    it('takes a registered way down when it still does not answer, keeps its accounts, then brings it back', async () => {
      vi.useFakeTimers();
      const gmail = f.keepComposioAccount('ca_gmail');
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      let outage = false;
      const client = f.scriptedComposioClient(() =>
        outage
          ? Promise.reject(new Error('Composio request timed out'))
          : Promise.resolve([
              { connectedAccountId: 'ca_gmail', toolkit: 'gmail', status: 'ACTIVE' },
            ])
      );
      const bootstrapper = h.makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();

      outage = true;
      await bootstrapper.recheckWay(f.composioInstance);

      expect(h.registry.resolveProvider('composio')).toBeUndefined();
      expect(f.instanceStatus(f.composioInstance)).toBe('unavailable');
      expect((await bootstrapper.listStatuses()).find((s) => s.type === 'composio')).toMatchObject({
        registered: false,
        error: KEY_CHECK_COPY.checkingAgain,
      });
      // An outage is not a sign-in that ended.
      expect(f.signIn(gmail)).toBe('active');

      outage = false;
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS[0]);
      expect(h.registry.resolveProvider('composio')).toBeDefined();
      expect(f.instanceStatus(f.composioInstance)).toBe('available');
    });

    it('keeps checking the DorkOS account way every 15 minutes through a long outage, and recovers with no Retry (DOR-4229)', async () => {
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
      const bootstrapper = h.makeBootstrapper({
        managedCloud: {
          instanceId,
          configured: () => true,
          executionConfigDigest: () => 'linked-material',
          create: () => managed,
        },
      });
      await bootstrapper.registerBootProviders();

      // The whole backoff runs out, then four hours more, as on Nov 12.
      for (const delay of WAY_RECHECK_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
      const afterBackoff = probes;
      const lastDelay = WAY_RECHECK_DELAYS_MS.at(-1)!;
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
      expect(h.registry.resolveProviderInstance(instanceId)).toBeUndefined();
      // Still checking, once every 15 minutes, never faster.
      expect(probes - afterBackoff).toBe((4 * 60 * 60 * 1000) / lastDelay);
      // So the person still sees DorkOS retrying, with a time, not "press Retry".
      expect(bootstrapper.nextWayCheckAt(instanceId)).toBeDefined();

      // The service answers again: the next check brings the way back on its own.
      outage = false;
      await vi.advanceTimersByTimeAsync(lastDelay);
      expect(h.registry.resolveProviderInstance(instanceId)).toBe(managed);
      expect(bootstrapper.nextWayCheckAt(instanceId)).toBeUndefined();

      // Answered: nothing else is scheduled.
      const recoveredAt = probes;
      await vi.advanceTimersByTimeAsync(lastDelay * 4);
      expect(probes).toBe(recoveredAt);
    });

    it('stops checking a way that never answers, and settles on the person’s one fix', async () => {
      vi.useFakeTimers();
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const client = f.scriptedComposioClient(() =>
        Promise.reject(new Error('Composio request timed out'))
      );
      const bootstrapper = h.makeBootstrapper({ composioClient: client });
      await bootstrapper.registerBootProviders();

      for (const delay of WAY_RECHECK_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
      // One check at boot, then one per wait, then nothing more.
      expect(client.listings).toBe(1 + WAY_RECHECK_DELAYS_MS.length);
      expect(bootstrapper.nextWayCheckAt(f.composioInstance)).toBeUndefined();
      expect(bootstrapper.wayHealth(f.composioInstance, 'gmail')).toEqual({
        status: 'down',
        problem: 'own_key_unavailable',
        anotherWayWorks: false,
      });
      await vi.advanceTimersByTimeAsync(WAY_RECHECK_DELAYS_MS.at(-1)! * 4);
      expect(client.listings).toBe(1 + WAY_RECHECK_DELAYS_MS.length);

      // A check the person starts begins a fresh count.
      await bootstrapper.reload('composio');
      expect(bootstrapper.nextWayCheckAt(f.composioInstance)).toBeDefined();
    });

    it('counts another way only when it reaches this very app', async () => {
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-wrong');
      const instanceId = 'managed-provider' as ConnectorProviderInstanceId;
      const managed = new FakeConnectorProvider({
        instanceId,
        type: 'dorkos-managed',
        custody: 'managed',
        toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
      });
      const bootstrapper = h.makeBootstrapper({
        composioClient: f.scriptedComposioClient(() =>
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
      expect(bootstrapper.wayHealth(f.composioInstance, 'gmail')).toMatchObject({
        anotherWayWorks: false,
      });
      await h.registry.readCatalog(managed, new AbortController().signal);
      expect(bootstrapper.wayHealth(f.composioInstance, 'gmail')).toMatchObject({
        anotherWayWorks: true,
      });
      // It doesn't reach Slack, so connecting Slack again that way can't help.
      expect(bootstrapper.wayHealth(f.composioInstance, 'slack')).toMatchObject({
        anotherWayWorks: false,
      });
    });
  });
});
