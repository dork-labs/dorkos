import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { connectorProviderInstances, createDb, eq, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectedAccount,
  ConnectorProviderInstanceId,
  ProviderConnectedAccount,
} from '@dorkos/shared/connector-provider';
import type { ConnectionId } from '@dorkos/shared/connector-schemas';
import { ConnectorCatalogCache } from '../resources/catalog-cache.js';
import { ConnectorRegistry } from '../registry.js';

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
    registry = new ConnectorRegistry({ db, providerTimeoutMs: 100 });
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
    // Aggregation simply no longer includes the unregistered backend.
    const { accounts, warnings } = await registry.listAccounts();
    expect(accounts).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('aggregates accounts across providers', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    const nango = new FakeConnectorProvider({ type: 'nango' });
    registry.register(composio);
    registry.register(nango);
    const a = await connectOne(registry, composio, 'gmail', 'personal');
    const b = await connectOne(registry, nango, 'slack', 'team');

    const { accounts, warnings } = await registry.listAccounts();
    expect(accounts.map((acc) => acc.id).sort()).toEqual([a.id, b.id].sort());
    expect(warnings).toEqual([]);
  });

  it('degrades a throwing provider to a warning while the others still return', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    registry.register(new BrokenProvider());
    const a = await connectOne(registry, composio, 'gmail', 'personal');

    const { accounts, warnings } = await registry.listAccounts();
    expect(accounts.map((acc) => acc.id)).toEqual([a.id]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.provider).toBe('broken');
    expect(warnings[0]!.message).toContain('unreachable');
  });

  it('degrades a timing-out provider to a warning', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    // A provider that never resolves listAccounts — the timeout path.
    const stuck = new BrokenProvider();
    stuck.listAccounts = () => new Promise<ProviderConnectedAccount[]>(() => {});
    registry.register(stuck);

    const { warnings } = await registry.listAccounts();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/timed out/);
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
