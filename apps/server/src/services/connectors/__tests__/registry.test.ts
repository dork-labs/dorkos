import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectedAccount,
  ConnectedAccountId,
  ConnectorCapabilities,
  ConnectorProvider,
  ConnectorToolkit,
  ConnectPoll,
  ConnectStart,
} from '@dorkos/shared/connector-provider';
import { ConnectorRegistry } from '../registry.js';

/** A provider whose `listAccounts` always rejects — the degradation case. */
class BrokenProvider implements ConnectorProvider {
  readonly type = 'broken';
  getCapabilities(): ConnectorCapabilities {
    return {
      type: this.type,
      supportsMultiAccount: true,
      custody: 'managed',
      exposesOverMcp: true,
      features: {},
    };
  }
  listToolkits(): Promise<ConnectorToolkit[]> {
    return Promise.resolve([]);
  }
  startConnect(): Promise<ConnectStart> {
    return Promise.reject(new Error('broken'));
  }
  pollConnect(): Promise<ConnectPoll> {
    return Promise.resolve({ status: 'failed', error: 'broken' });
  }
  listAccounts(): Promise<ConnectedAccount[]> {
    return Promise.reject(new Error('provider unreachable'));
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  toolServerForAccount() {
    return Promise.resolve(null);
  }
}

/** Connect one account on a fake provider and return the resolved account. */
async function connectOne(
  provider: FakeConnectorProvider,
  toolkit: string,
  label: string
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect(toolkit, { label });
  const { account } = await provider.pollConnect(flowId);
  return account!;
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

  it('routes an account id to its owning provider via the connected_accounts binding', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    const nango = new FakeConnectorProvider({ type: 'nango' });
    registry.register(composio);
    registry.register(nango);

    const account = await connectOne(composio, 'gmail', 'personal');
    registry.recordConnect(account);

    expect(registry.providerForAccount(account.id)).toBe(composio);
    expect(registry.providerForAccount('never-bound' as ConnectedAccountId)).toBeUndefined();
  });

  it('binds an account id first-write-wins (a second record does not re-route it)', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    const account = await connectOne(composio, 'gmail', 'personal');

    registry.recordConnect(account);
    // A second record of the same id under a different provider must not win.
    registry.recordConnect({ ...account, provider: 'nango' });

    const row = registry.providerForAccount(account.id);
    expect(row).toBe(composio);
  });

  it('clears the binding on disconnect (idempotent)', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    const account = await connectOne(composio, 'gmail', 'personal');
    registry.recordConnect(account);

    registry.recordDisconnect(account.id);
    expect(registry.providerForAccount(account.id)).toBeUndefined();
    // Clearing again is a no-op, not a throw.
    expect(() => registry.recordDisconnect(account.id)).not.toThrow();
  });

  it('aggregates accounts across providers', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    const nango = new FakeConnectorProvider({ type: 'nango' });
    registry.register(composio);
    registry.register(nango);
    const a = await connectOne(composio, 'gmail', 'personal');
    const b = await connectOne(nango, 'slack', 'team');

    const { accounts, warnings } = await registry.listAccounts();
    expect(accounts.map((acc) => acc.id).sort()).toEqual([a.id, b.id].sort());
    expect(warnings).toEqual([]);
  });

  it('degrades a throwing provider to a warning while the others still return', async () => {
    const composio = new FakeConnectorProvider({ type: 'composio' });
    registry.register(composio);
    registry.register(new BrokenProvider());
    const a = await connectOne(composio, 'gmail', 'personal');

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
    stuck.listAccounts = () => new Promise<ConnectedAccount[]>(() => {});
    registry.register(stuck);

    const { warnings } = await registry.listAccounts();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/timed out/);
  });
});
