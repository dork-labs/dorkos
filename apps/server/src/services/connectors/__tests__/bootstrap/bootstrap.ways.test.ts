import { NANGO_SECRET_KEY_REF } from '../../providers/nango.js';
import { describe, it, expect, vi } from 'vitest';
import { KEY_CHECK_COPY } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { legacyDefaultProviderInstanceId } from '../../legacy-connection-migration.js';
import {
  TEST_CONNECTOR_API_KEY_REF,
  TEST_CONNECTOR_CREDENTIAL_NAME,
  TEST_CONNECTOR_PROVIDER_TYPE,
  WAY_RECHECK_DELAYS_MS,
} from '../../bootstrap.js';
import { MANAGED_CUSTODY_CANONICAL_SENTENCE } from '../../custody-disclosure.js';
import { COMPOSIO_API_KEY_REF } from '../../providers/composio.js';
import { ComposioApiError } from '../../providers/composio-client.js';
import {
  useBootstrapHarness,
  useFreshFactsHarness,
  VALID_ENCRYPTION_KEY,
} from './bootstrap.fixtures.js';
import { connectorProviderInstances, eq } from '@dorkos/db';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-provider';

/** Reloading a provider when its key changes, the status surface, and the automatic checks of each way (DOR-2501). */
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

    it('advances material generation when a confined Composio credential changes', async () => {
      const bootstrapper = h.makeBootstrapper();
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-1');
      await bootstrapper.registerBootProviders();
      const first = h.db
        .select({
          digest: connectorProviderInstances.executionConfigDigest,
          generation: connectorProviderInstances.executionConfigGeneration,
        })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.type, 'composio'))
        .get()!;

      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-2');
      await bootstrapper.reload('composio');
      const second = h.db
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
      h.secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      const nangoSettings: { baseUrl: string; encryptionKey?: string } = {
        baseUrl: 'http://localhost:3003',
      };
      const bootstrapper = h.makeBootstrapper({ nangoEnv: () => ({ ...nangoSettings }) });
      await bootstrapper.registerBootProviders();
      expect((await bootstrapper.reload('nango')).error).toMatch(/NANGO_ENCRYPTION_KEY/);

      nangoSettings.encryptionKey = VALID_ENCRYPTION_KEY;
      const healthy = await bootstrapper.reload('nango');
      expect(healthy.registered).toBe(true);
      expect(healthy.error).toBeUndefined();
    });

    it('takes a previously-live provider away when a reload refuses its setup', async () => {
      h.secrets.set(NANGO_SECRET_KEY_REF, 'sk-nango-test');
      const nangoSettings: { baseUrl: string; encryptionKey?: string } = {
        baseUrl: 'http://localhost:3003',
        encryptionKey: VALID_ENCRYPTION_KEY,
      };
      const bootstrapper = h.makeBootstrapper({ nangoEnv: () => ({ ...nangoSettings }) });
      await bootstrapper.registerBootProviders();
      expect(h.registry.resolveProvider('nango')).toBeDefined();

      delete nangoSettings.encryptionKey;
      await bootstrapper.reload('nango');
      expect(h.registry.resolveProvider('nango')).toBeUndefined();
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

    it('marks a way unavailable at boot when it worked last run and fails its check now', async () => {
      f.keepComposioAccount('ca_gmail');
      expect(f.instanceStatus(f.composioInstance)).toBe('available');
      h.secrets.set(COMPOSIO_API_KEY_REF, 'ck-live');
      const bootstrapper = h.makeBootstrapper({
        composioProbeError: new ComposioApiError(503, 'Service unavailable'),
      });

      await bootstrapper.registerBootProviders();

      expect(h.registry.resolveProvider('composio')).toBeUndefined();
      expect(f.instanceStatus(f.composioInstance)).toBe('unavailable');
    });
  });
});
