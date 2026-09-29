import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  connections,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectedAccount,
  ConnectorExternalAccountRef,
  ConnectorProviderInstanceId,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import type { ConnectionId } from '@dorkos/shared/connector-schemas';
import { ConnectorCatalogCache } from '../resources/catalog-cache.js';
import { ConnectorRegistry, DEFAULT_SIGN_IN_REFRESH_TIMEOUT_MS } from '../registry.js';

/** A provider whose `listAccounts` always rejects — the degradation case. */
class BrokenProvider extends FakeConnectorProvider {
  constructor() {
    super({ type: 'broken' });
  }

  override listAccounts(): Promise<ProviderConnectedAccount[]> {
    return Promise.reject(new Error('provider unreachable'));
  }
}

/** Connect one account on a fake provider and return the resolved account. */
async function connectOne(
  registry: ConnectorRegistry,
  provider: FakeConnectorProvider,
  toolkit: string,
  label: string
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect(toolkit, { label });
  const { account } = await provider.pollConnect(flowId);
  return registry.recordConnect(provider, account!);
}

describe('ConnectorRegistry', () => {
  let db: Db;
  let registry: ConnectorRegistry;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db, providerTimeoutMs: 100, signInRefreshTimeoutMs: 100 });
  });

  it('registers, lists, and resolves providers by type', () => {
    const a = new FakeConnectorProvider({ type: 'composio' });
    const b = new FakeConnectorProvider({ type: 'nango' });
    registry.register(a);
    registry.register(b);

    expect(
      registry
        .listProviders()
        .map((p) => p.type)
        .sort()
    ).toEqual(['composio', 'nango']);
    expect(registry.resolveProvider('composio')).toBe(a);
    expect(registry.resolveProvider('missing')).toBeUndefined();
  });

  it('routes a stable connection id through its canonical private provider binding', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    const nango = new FakeConnectorProvider({ type: 'nango' });
    registry.register(composio);
    registry.register(nango);

    const account = await connectOne(registry, composio, 'gmail', 'personal');

    expect(registry.providerForAccount(account.id)).toBe(composio);
    expect(registry.providerForAccount('never-bound' as ConnectionId)).toBeUndefined();
  });

  it('keeps identical private refs distinct across provider instances', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    const account = await connectOne(registry, composio, 'gmail', 'personal');
    const upstream = (await composio.listAccounts())[0]!;
    const secondInstance = new FakeConnectorProvider({
      type: 'composio',
      instanceId: 'second-composio-instance' as typeof composio.instanceId,
    });
    registry.register(secondInstance);
    const sameExternal = registry.recordConnect(secondInstance, upstream);

    expect(sameExternal.id).not.toBe(account.id);
    expect(registry.providerForAccount(account.id)).toBe(composio);
    expect(registry.providerForAccount(sameExternal.id)).toBe(secondInstance);
    const firstBinding = registry.accountBinding(account.id);
    const secondBinding = registry.accountBinding(sameExternal.id);
    expect(firstBinding).toMatchObject({
      connectionId: account.id,
      externalAccountRef: upstream.externalAccountRef,
    });
    expect(secondBinding).toMatchObject({
      connectionId: sameExternal.id,
      externalAccountRef: upstream.externalAccountRef,
    });
    expect(firstBinding).not.toHaveProperty('accountId');
    expect(secondBinding).not.toHaveProperty('accountId');
  });

  it('retains a revoked ownership tombstone on disconnect (idempotent)', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    const account = await connectOne(registry, composio, 'gmail', 'personal');

    registry.recordDisconnect(account.id);
    expect(registry.providerForAccount(account.id)).toBeUndefined();
    expect(registry.accountBinding(account.id)).toMatchObject({
      provider: 'composio',
      status: 'revoked',
    });
    // Revoking again is a no-op, not a throw.
    expect(() => registry.recordDisconnect(account.id)).not.toThrow();
  });

  it('reactivates only the same provider instance and private account ref', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    const account = await connectOne(registry, composio, 'gmail', 'personal');
    const upstream = (await composio.listAccounts())[0]!;
    registry.recordDisconnect(account.id);

    const nango = new FakeConnectorProvider({
      type: 'nango',
      instanceId: 'nango-personal' as ConnectorProviderInstanceId,
    });
    registry.register(nango);
    const otherConnection = registry.recordConnect(nango, { ...upstream, label: 'wrong owner' });
    expect(otherConnection.id).not.toBe(account.id);
    expect(registry.accountBinding(account.id)).toMatchObject({
      provider: 'composio',
      label: 'personal',
      status: 'revoked',
    });

    const restored = registry.recordConnect(composio, { ...upstream, label: 'reconnected' });
    expect(restored.id).toBe(account.id);
    expect(registry.accountBinding(account.id)).toMatchObject({
      provider: 'composio',
      label: 'reconnected',
      status: 'active',
    });
  });

  it('unregister removes a provider; re-registering the same type works again', () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    registry.unregister('composio');

    expect(registry.resolveProvider('composio')).toBeUndefined();
    expect(registry.listProviders()).toEqual([]);
    // Unregistering an absent type is a no-op, not a throw (reload calls it
    // unconditionally before re-creating a provider).
    expect(() => registry.unregister('composio')).not.toThrow();

    const fresh = new FakeConnectorProvider({ type: 'composio' });
    registry.register(fresh);
    expect(registry.resolveProvider('composio')).toBe(fresh);
  });

  it('unregisters one exact instance and deterministically falls back within its type', () => {
    const first = new FakeConnectorProvider({
      type: 'composio',
      instanceId: 'composio-a' as ConnectorProviderInstanceId,
    });
    const second = new FakeConnectorProvider({
      type: 'composio',
      instanceId: 'composio-b' as ConnectorProviderInstanceId,
    });
    registry.register(first);
    registry.register(second);
    expect(registry.resolveProvider('composio')).toBe(second);

    registry.unregisterProviderInstance(first.instanceId);
    expect(registry.resolveProviderInstance(first.instanceId)).toBeUndefined();
    expect(registry.resolveProvider('composio')).toBe(second);
    expect(
      db
        .select({ status: connectorProviderInstances.status })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, first.instanceId))
        .get()
    ).toEqual({ status: 'unavailable' });

    registry.register(first);
    registry.unregisterProviderInstance(first.instanceId);
    expect(registry.resolveProvider('composio')).toBe(second);
    expect(registry.listProviders()).toEqual([second]);
  });

  it('degrades gracefully for accounts whose provider was unregistered', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    const account = await connectOne(registry, composio, 'gmail', 'personal');

    registry.unregister('composio');

    // The binding row survives (re-registering restores routing), but routing
    // resolves to nothing rather than throwing.
    expect(registry.accountBinding(account.id)).toMatchObject({ provider: 'composio' });
    expect(registry.providerForAccount(account.id)).toBeUndefined();
    // The refresh simply no longer asks the unregistered backend.
    expect(await registry.refreshSignIns()).toEqual({ changes: [], failures: [] });
    expect(registry.accountBinding(account.id)?.status).toBe('active');
  });

  it('marks a kept row unavailable even when nothing is live, so a failed boot check never reads as available', () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    const statusOf = () =>
      db
        .select({ status: connectorProviderInstances.status })
        .from(connectorProviderInstances)
        .where(eq(connectorProviderInstances.id, composio.instanceId))
        .get();
    expect(statusOf()).toEqual({ status: 'available' });

    // A restart: the new registry holds nothing live, and the way's check
    // fails before it registers. The row the last run left must not say
    // the way is available.
    const restarted = new ConnectorRegistry({ db });
    restarted.unregisterProviderInstance(composio.instanceId);

    expect(statusOf()).toEqual({ status: 'unavailable' });
  });

  describe('refreshSignIns', () => {
    const lastVerifiedAt = (id: string) =>
      db
        .select({ at: connections.lastVerifiedAt })
        .from(connections)
        .where(eq(connections.id, id))
        .get()?.at;

    it('records a sign-in the service now reports expired or revoked, across providers', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      const nango = new FakeConnectorProvider({ type: 'nango' });
      registry.register(composio);
      registry.register(nango);
      const gmail = await connectOne(registry, composio, 'gmail', 'personal');
      const slack = await connectOne(registry, nango, 'slack', 'team');
      composio.setStatus(registry.accountBinding(gmail.id)!.externalAccountRef, 'expired');
      nango.setStatus(registry.accountBinding(slack.id)!.externalAccountRef, 'revoked');

      const { changes, failures } = await registry.refreshSignIns();

      expect(failures).toEqual([]);
      expect(changes).toEqual(
        expect.arrayContaining([
          { connectionId: gmail.id, from: 'active', to: 'expired' },
          { connectionId: slack.id, from: 'active', to: 'revoked' },
        ])
      );
      expect(registry.accountBinding(gmail.id)?.status).toBe('expired');
      expect(registry.accountBinding(slack.id)?.status).toBe('revoked');
      // An ended sign-in is never routed to its provider.
      expect(registry.providerForAccount(gmail.id)).toBeUndefined();
    });

    it('brings a sign-in back once the service reports it active again', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      registry.register(composio);
      const gmail = await connectOne(registry, composio, 'gmail', 'personal');
      const ref = registry.accountBinding(gmail.id)!.externalAccountRef;
      composio.setStatus(ref, 'expired');
      await registry.refreshSignIns();
      composio.setStatus(ref, 'active');

      await registry.refreshSignIns();

      expect(registry.accountBinding(gmail.id)?.status).toBe('active');
    });

    it('leaves every account as it was when a listing fails, and reports the failure', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      const broken = new BrokenProvider();
      registry.register(composio);
      registry.register(broken);
      const healthy = await connectOne(registry, composio, 'gmail', 'personal');
      const unreachable = await connectOne(registry, broken, 'slack', 'team');
      const verifiedBefore = lastVerifiedAt(unreachable.id);
      composio.setStatus(registry.accountBinding(healthy.id)!.externalAccountRef, 'expired');

      const { changes, failures } = await registry.refreshSignIns();

      expect(failures).toEqual([
        {
          providerInstanceId: broken.instanceId,
          provider: 'broken',
          message: 'provider unreachable',
        },
      ]);
      // An outage is not a sign-in that ended: the unreachable account keeps
      // its status and its last check time.
      expect(registry.accountBinding(unreachable.id)?.status).toBe('active');
      expect(lastVerifiedAt(unreachable.id)).toBe(verifiedBefore);
      // The reachable provider still refreshed.
      expect(changes).toEqual([{ connectionId: healthy.id, from: 'active', to: 'expired' }]);
    });

    it('reports a listing that times out as a failure', async () => {
      const stuck = new BrokenProvider();
      stuck.listAccounts = () => new Promise<ProviderConnectedAccount[]>(() => {});
      registry.register(stuck);

      const { failures } = await registry.refreshSignIns();

      expect(failures).toHaveLength(1);
      expect(failures[0]!.message).toMatch(/timed out/);
    });

    it('gives a slow, many-page listing its own longer deadline than a page read gets', async () => {
      vi.useFakeTimers();
      try {
        const defaults = new ConnectorRegistry({ db });
        const composio = new FakeConnectorProvider({ type: 'composio' });
        defaults.register(composio);
        const gmail = await connectOne(defaults, composio, 'gmail', 'personal');
        const account = (await composio.listAccounts())[0]!;
        // Well past the 5-second read deadline, inside the refresh's own.
        composio.listAccounts = () =>
          new Promise((resolve) =>
            setTimeout(() => resolve([{ ...account, status: 'expired' }]), 12_000)
          );

        const slow = defaults.refreshSignIns();
        await vi.advanceTimersByTimeAsync(12_000);
        expect(await slow).toMatchObject({ failures: [] });
        expect(defaults.accountBinding(gmail.id)?.status).toBe('expired');

        // A listing that never ends still fails, at the refresh deadline.
        composio.listAccounts = () => new Promise<ProviderConnectedAccount[]>(() => {});
        const stuck = defaults.refreshSignIns();
        await vi.advanceTimersByTimeAsync(DEFAULT_SIGN_IN_REFRESH_TIMEOUT_MS);
        expect((await stuck).failures[0]!.message).toMatch(/timed out after 20000ms/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('records nothing from a status the service did not state', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      registry.register(composio);
      const gmail = await connectOne(registry, composio, 'gmail', 'personal');
      composio.setStatus(registry.accountBinding(gmail.id)!.externalAccountRef, 'expired');
      await registry.refreshSignIns();
      const before = db
        .select({ status: connections.status, at: connections.lastVerifiedAt })
        .from(connections)
        .where(eq(connections.id, gmail.id))
        .get();
      composio.setStatus(registry.accountBinding(gmail.id)!.externalAccountRef, 'unknown');
      await new Promise((resolve) => setTimeout(resolve, 5));

      const { changes, failures } = await registry.refreshSignIns();

      expect({ changes, failures }).toEqual({ changes: [], failures: [] });
      expect(
        db
          .select({ status: connections.status, at: connections.lastVerifiedAt })
          .from(connections)
          .where(eq(connections.id, gmail.id))
          .get()
      ).toEqual(before);
      expect(before?.status).toBe('expired');
    });

    it('records a finished sign-in the service reports without a status as signed in', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      registry.register(composio);
      const { flowId } = await composio.startConnect('gmail', { label: 'work' });
      const { account } = await composio.pollConnect(flowId);

      const connected = registry.recordConnect(composio, { ...account!, status: 'unknown' });

      expect(connected.status).toBe('active');
      expect(registry.accountBinding(connected.id)?.status).toBe('active');
    });

    it('never adds, closes, relabels or moves an account; it only records the sign-in', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      registry.register(composio);
      const listed = await connectOne(registry, composio, 'gmail', 'personal');
      const unlisted = await connectOne(registry, composio, 'slack', 'team');
      registry.setLabel(listed.id, 'Work mail');
      const listedRef = registry.accountBinding(listed.id)!.externalAccountRef;
      composio.listAccounts = () =>
        Promise.resolve([
          // The kept account, under the service's own label and a new app id.
          {
            externalAccountRef: listedRef,
            toolkit: 'google-mail',
            label: 'service label',
            status: 'expired',
            custody: 'managed',
          },
          // An account DorkOS never connected (a leftover sign-in at the service).
          {
            externalAccountRef: 'never-connected' as ConnectorExternalAccountRef,
            toolkit: 'gmail',
            label: 'stranger',
            status: 'active',
            custody: 'managed',
          },
        ]);

      await registry.refreshSignIns();

      expect(db.select().from(connections).all()).toHaveLength(2);
      expect(registry.accountBinding(listed.id)).toMatchObject({
        label: 'Work mail',
        toolkit: 'gmail',
        status: 'expired',
      });
      expect(registry.accountBinding(unlisted.id)?.status).toBe('active');
      expect(
        db
          .select({ lifecycle: connections.lifecycleState })
          .from(connections)
          .where(eq(connections.id, unlisted.id))
          .get()
      ).toEqual({ lifecycle: 'connected' });
    });

    it('leaves an account the service reports mid-sign-in, a paused one keeps its pause, and a closed one stays closed', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      registry.register(composio);
      const pending = await connectOne(registry, composio, 'gmail', 'pending');
      const paused = await connectOne(registry, composio, 'gmail', 'paused');
      const closed = await connectOne(registry, composio, 'slack', 'closed');
      composio.setStatus(registry.accountBinding(pending.id)!.externalAccountRef, 'pending');
      composio.setStatus(registry.accountBinding(paused.id)!.externalAccountRef, 'expired');
      composio.setStatus(registry.accountBinding(closed.id)!.externalAccountRef, 'expired');
      registry.setPaused(paused.id, true);
      registry.recordDisconnect(closed.id);

      await registry.refreshSignIns();

      expect(registry.accountBinding(pending.id)?.status).toBe('active');
      expect(registry.accountBinding(paused.id)?.status).toBe('paused');
      registry.setPaused(paused.id, false);
      expect(registry.accountBinding(paused.id)?.status).toBe('expired');
      expect(
        db
          .select({ status: connections.status })
          .from(connections)
          .where(eq(connections.id, closed.id))
          .get()
      ).toEqual({ status: 'active' });
    });

    it('lets a sign-in that finished after the listing began win over that listing', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      registry.register(composio);
      const gmail = await connectOne(registry, composio, 'gmail', 'personal');
      const account = (await composio.listAccounts())[0]!;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      composio.listAccounts = async () => {
        await blocked;
        return [{ ...account, status: 'expired' }];
      };

      const refresh = registry.refreshSignIns();
      // The owner signs in again while the slow listing is out.
      await new Promise((resolve) => setTimeout(resolve, 5));
      registry.recordConnect(composio, { ...account, status: 'active' });
      release();
      const { changes } = await refresh;

      expect(changes).toEqual([]);
      expect(registry.accountBinding(gmail.id)?.status).toBe('active');
    });

    it('skips a provider that does not list accounts', async () => {
      const silent = new FakeConnectorProvider({ type: 'silent' });
      const capabilities = silent.getCapabilities();
      silent.getCapabilities = () => ({
        ...capabilities,
        capabilities: {
          ...capabilities.capabilities,
          accounts: { status: 'unsupported', reason: 'No account listing.' },
        },
      });
      silent.listAccounts = () => Promise.reject(new Error('should not be asked'));
      registry.register(silent);

      expect(await registry.refreshSignIns()).toEqual({ changes: [], failures: [] });
    });
  });

  describe('markSignInEnded', () => {
    it('marks a signed-in account expired once, and never touches a closed one', async () => {
      const composio = new FakeConnectorProvider({ type: 'composio' });
      registry.register(composio);
      const gmail = await connectOne(registry, composio, 'gmail', 'personal');
      const closed = await connectOne(registry, composio, 'slack', 'team');
      registry.recordDisconnect(closed.id);

      expect(registry.markSignInEnded(gmail.id, 'expired')).toBe(true);
      expect(registry.markSignInEnded(gmail.id, 'revoked')).toBe(false);
      expect(registry.markSignInEnded(closed.id, 'expired')).toBe(false);

      expect(registry.accountBinding(gmail.id)?.status).toBe('expired');
      expect(
        db
          .select({ status: connections.status })
          .from(connections)
          .where(eq(connections.id, closed.id))
          .get()
      ).toEqual({ status: 'active' });
    });
  });

  describe('kept app lists', () => {
    const signal = () => new AbortController().signal;

    it('keeps a provider app list on disk across a restart with the same setup', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-registry-catalog-'));
      try {
        const boot = () =>
          new ConnectorRegistry({ db, catalogCache: new ConnectorCatalogCache({ dir }) });
        const first = new FakeConnectorProvider({ type: 'composio' });
        const firstPages = vi.spyOn(first, 'listToolkitPage');
        const before = boot();
        before.register(first, 'material-a');
        await before.readCatalog(first, signal());
        expect(firstPages).toHaveBeenCalledTimes(1);

        // A restart registers a new object for the same instance and key.
        const second = new FakeConnectorProvider({ type: 'composio' });
        const secondPages = vi.spyOn(second, 'listToolkitPage');
        const after = boot();
        after.register(second, 'material-a');
        const read = await after.readCatalog(second, signal());

        expect(read.status).toBe('ok');
        expect(secondPages).not.toHaveBeenCalled();

        // Removing the service deletes its file.
        after.unregisterProviderInstance(second.instanceId);
        await vi.waitFor(async () => expect(await fs.readdir(dir)).toEqual([]));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('finds an app’s logo address in the kept lists only, never listing upstream', async () => {
      const provider = new FakeConnectorProvider({
        type: 'composio',
        toolkits: [
          {
            slug: 'zendesk',
            displayName: 'Zendesk',
            authKind: 'oauth2',
            logoUrl: 'https://logos.composio.dev/api/zendesk',
          },
          { slug: 'bare', displayName: 'Bare', authKind: 'oauth2' },
        ],
      });
      const pages = vi.spyOn(provider, 'listToolkitPage');
      registry.register(provider, 'material-a');

      // Nothing kept yet: no logo, and no listing to find one.
      await expect(registry.keptLogoUrl('zendesk')).resolves.toBeUndefined();
      expect(pages).not.toHaveBeenCalled();

      await registry.readCatalog(provider, signal());
      await expect(registry.keptLogoUrl('zendesk')).resolves.toBe(
        'https://logos.composio.dev/api/zendesk'
      );
      await expect(registry.keptLogoUrl('bare')).resolves.toBeUndefined();
      await expect(registry.keptLogoUrl('notion')).resolves.toBeUndefined();
      expect(pages).toHaveBeenCalledTimes(1);
    });

    it('drops the kept list when the provider is removed or replaced', async () => {
      const provider = new FakeConnectorProvider({ type: 'composio' });
      const pages = vi.spyOn(provider, 'listToolkitPage');
      registry.register(provider, 'material-a');
      await registry.readCatalog(provider, signal());
      await registry.readCatalog(provider, signal());
      expect(pages).toHaveBeenCalledTimes(1);

      registry.unregisterProviderInstance(provider.instanceId);
      await expect(registry.readCatalog(provider, signal())).rejects.toThrow(
        'composio is no longer set up.'
      );

      registry.register(provider, 'material-a');
      await registry.readCatalog(provider, signal());
      expect(pages).toHaveBeenCalledTimes(2);

      // Registering over a live instance in place is a setup change too.
      const replacement = new FakeConnectorProvider({ type: 'composio' });
      const replacementPages = vi.spyOn(replacement, 'listToolkitPage');
      registry.register(replacement, 'material-a');
      await registry.readCatalog(replacement, signal());
      expect(replacementPages).toHaveBeenCalledTimes(1);
    });

    it('drops every kept copy through one notice, even when the same object registers again', async () => {
      const provider = new FakeConnectorProvider({ type: 'composio' });
      const pages = vi.spyOn(provider, 'listToolkitPage');
      const removed = vi.fn();
      registry.onProviderInstanceRemoved(removed);
      registry.register(provider, 'material-a');
      expect(removed).not.toHaveBeenCalled();
      await registry.readCatalog(provider, signal());

      // A key saved again re-registers the live instance: the app list and
      // everything else kept for the way are dropped together.
      registry.register(provider, 'material-a');
      expect(removed).toHaveBeenCalledWith(provider.instanceId);
      await registry.readCatalog(provider, signal());
      expect(pages).toHaveBeenCalledTimes(2);

      registry.unregisterProviderInstance(provider.instanceId);
      expect(removed).toHaveBeenCalledTimes(2);
    });

    it('finds the providers for a service from the kept list', async () => {
      const provider = new FakeConnectorProvider({ type: 'composio' });
      const pages = vi.spyOn(provider, 'listToolkitPage');
      registry.register(provider, 'material-a');

      expect((await registry.providersForToolkit('gmail')).providers).toEqual([provider]);
      expect((await registry.providersForToolkit('missing')).providers).toEqual([]);
      expect(pages).toHaveBeenCalledTimes(1);
    });
  });
});
