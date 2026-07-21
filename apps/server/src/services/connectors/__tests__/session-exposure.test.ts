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
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import { ConnectorRegistry } from '../registry.js';
import { SessionConnectorService } from '../session-exposure.js';

/**
 * A gateway provider named `'composio'` whose account ids and connection URLs
 * carry NO provider identity — modeling a real managed gateway (Composio's Rube
 * MCP URLs are `rube.app/...`, never `composio`). Used to prove the session
 * tool surface adds no provider leakage even when the owning backend IS Composio.
 */
class CleanComposioProvider implements ConnectorProvider {
  readonly type = 'composio';
  private readonly _live = new Set<string>();

  /** Register an opaque account id as having a live tool server. */
  addLive(accountId: string): void {
    this._live.add(accountId);
  }

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
    return Promise.resolve([{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }]);
  }
  startConnect(): Promise<ConnectStart> {
    return Promise.reject(new Error('not used'));
  }
  pollConnect(): Promise<ConnectPoll> {
    return Promise.resolve({ status: 'failed', error: 'not used' });
  }
  listAccounts(): Promise<ConnectedAccount[]> {
    return Promise.resolve([]);
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  toolServerForAccount(accountId: ConnectedAccountId): Promise<McpAppServerConnection | null> {
    if (!this._live.has(accountId)) return Promise.resolve(null);
    // A clean Rube-style URL: no vendor name, no account-id echo of the provider.
    return Promise.resolve({ transport: 'http', url: `https://rube.example/mcp/${accountId}` });
  }
}

/** Connect one account on a fake provider and persist its routing binding. */
async function connectAndRecord(
  registry: ConnectorRegistry,
  provider: FakeConnectorProvider,
  toolkit: string,
  label: string
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect(toolkit, { label });
  const { account } = await provider.pollConnect(flowId);
  registry.recordConnect(account!);
  return account!;
}

describe('SessionConnectorService', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let service: SessionConnectorService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider({ type: 'fake-connector', custody: 'managed' });
    registry.register(provider);
    service = new SessionConnectorService({ registry });
  });

  it('attaches two Gmail accounts as two distinct named tool servers', async () => {
    const personal = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const work = await connectAndRecord(registry, provider, 'gmail', 'work');

    await service.attach('session-a', personal.id);
    await service.attach('session-a', work.id);

    const { servers, warnings } = service.mcpServersForSession('session-a');
    expect(warnings).toEqual([]);
    expect(Object.keys(servers).sort()).toEqual(['gmail-personal', 'gmail-work']);
    // Two distinct servers, each an addressable MCP connection.
    expect(servers['gmail-personal']).toBeDefined();
    expect(servers['gmail-work']).toBeDefined();
    expect(servers['gmail-personal']).not.toEqual(servers['gmail-work']);
  });

  it('disambiguates two accounts with the same toolkit and label', async () => {
    const first = await connectAndRecord(registry, provider, 'gmail', 'shared');
    const second = await connectAndRecord(registry, provider, 'gmail', 'shared');

    await service.attach('s', first.id);
    await service.attach('s', second.id);

    const { servers } = service.mcpServersForSession('s');
    expect(Object.keys(servers).sort()).toEqual(['gmail-shared', 'gmail-shared-2']);
  });

  it('surfaces the null branch as a warning and never injects the account', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    // Drive the account into the null branch: an expired account resolves null
    // from toolServerForAccount rather than throwing.
    provider.setStatus(account.id, 'expired');

    const result = await service.attach('s', account.id);
    expect(result).toBeDefined();
    expect(result!.account.exposed).toBe(false);
    expect(result!.account.serverName).toBeUndefined();
    expect(result!.warning).toEqual({
      accountId: account.id,
      label: 'personal',
      reason: 'unavailable',
    });

    const { servers, warnings } = service.mcpServersForSession('s');
    expect(servers).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.accountId).toBe(account.id);
  });

  it('maps an expired routing binding to an expired warning reason', async () => {
    // A binding the provider no longer knows (its tool server resolves null),
    // whose cached status is 'expired' — the reason is echoed from the binding.
    const staleId = 'fake-connector:gmail:stale' as ConnectedAccountId;
    registry.recordConnect({
      id: staleId,
      provider: 'fake-connector',
      toolkit: 'gmail',
      label: 'stale',
      status: 'expired',
      custody: 'managed',
    });

    const result = await service.attach('s', staleId);
    expect(result!.warning?.reason).toBe('expired');
  });

  it('returns undefined for an unknown account id (routes map to 404)', async () => {
    const result = await service.attach('s', 'nope' as ConnectedAccountId);
    expect(result).toBeUndefined();
  });

  it('re-shows the custody disclosure at attach', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const result = await service.attach('s', account.id);
    // Managed custody → the canonical ADR sentence appears in the disclosure.
    expect(result!.disclosure).toContain('secure vault');
  });

  it('detaches an account so it is no longer injected (idempotent)', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    await service.attach('s', account.id);
    expect(Object.keys(service.mcpServersForSession('s').servers)).toEqual(['gmail-personal']);

    service.detach('s', account.id);
    expect(service.mcpServersForSession('s').servers).toEqual({});
    // Detaching again is a no-op, not a throw.
    expect(() => service.detach('s', account.id)).not.toThrow();
    expect(() => service.detach('unknown-session', account.id)).not.toThrow();
  });

  it('only injects accounts attached to THIS session', async () => {
    const account = await connectAndRecord(registry, provider, 'gmail', 'personal');
    await service.attach('session-a', account.id);

    expect(Object.keys(service.mcpServersForSession('session-a').servers)).toEqual([
      'gmail-personal',
    ]);
    // A different session never sees an account it did not attach.
    expect(service.mcpServersForSession('session-b').servers).toEqual({});
  });

  it('reports the full connector status for a session', async () => {
    const active = await connectAndRecord(registry, provider, 'gmail', 'personal');
    const other = await connectAndRecord(registry, provider, 'slack', 'team');
    provider.setStatus(other.id, 'revoked');

    await service.attach('s', active.id);
    await service.attach('s', other.id);

    const status = service.status('s');
    expect(status.accounts).toHaveLength(2);
    const activeRow = status.accounts.find((a) => a.accountId === active.id)!;
    expect(activeRow.exposed).toBe(true);
    expect(activeRow.serverName).toBe('gmail-personal');
    const revokedRow = status.accounts.find((a) => a.accountId === other.id)!;
    expect(revokedRow.exposed).toBe(false);
    expect(status.warnings.map((w) => w.accountId)).toEqual([other.id]);
  });

  it('leaks no provider identity into server names or config, even for Composio', async () => {
    const composio = new CleanComposioProvider();
    registry.register(composio);
    // Persist two provider-neutral bindings owned by 'composio'.
    for (const label of ['personal', 'work']) {
      const id = `acct-${label}`;
      composio.addLive(id);
      registry.recordConnect({
        id: id as ConnectedAccountId,
        provider: 'composio',
        toolkit: 'gmail',
        label,
        status: 'active',
        custody: 'managed',
      });
      await service.attach('s', id as ConnectedAccountId);
    }

    const { servers } = service.mcpServersForSession('s');
    expect(Object.keys(servers).sort()).toEqual(['gmail-personal', 'gmail-work']);
    // No provider identity anywhere in the injected surface — names or config.
    const surface = JSON.stringify({ names: Object.keys(servers), config: servers });
    expect(surface).not.toContain('composio');
    expect(surface).not.toContain('nango');
  });
});
