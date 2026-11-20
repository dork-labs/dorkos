/**
 * A mini app's paid read goes through the monthly spend limit (DOR-4575):
 * the same reserve as an agent's paid run, refused outright when no limit
 * covers it, and never a card, because a mini app can't answer one.
 *
 * Real migrated database, approval store, reader and spending store; only the
 * provider is a fake. The service, account, mini app and amounts are made up.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  spendingRuns,
  type Db,
} from '@dorkos/db';
import {
  ConnectorProviderInstanceIdSchema,
  type ConnectorProviderExecuteCommand,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorUsageStore } from '../../execution/usage-store.js';
import { SpendingStore } from '../../spending/spending-store.js';
import { initConnectorSpending } from '../../spending/spending-port.js';
import { reserveSpend } from '../../spending/spend-gate.js';
import { ExtensionConnectionApprovalStore } from '../extension-connection-approvals.js';
import { ExtensionConnectionReader } from '../extension-connection-reader.js';
import type { LiveExtensionInstall } from '../live-extension-install.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const CONNECTION = 'acme-scraper';
const RUN = 'APIFY_RUN_ACTOR';
const DOLLAR = 1_000_000;

/** A running install of `price-watch`, declaring one paid read. */
function installOf(): LiveExtensionInstall {
  return {
    extensionId: 'price-watch',
    scope: 'global',
    realPath: '/home/me/.dork/extensions/price-watch',
    origin: 'trusted_source',
    originSource: 'dork-labs/marketplace',
    liveFilesDigest: 'sha256:files-1',
    version: '0.1.0',
    declarations: [{ service: 'apify', access: 'read', operations: [RUN] }],
    isolated: () => true,
  };
}

describe('a mini app paid read', () => {
  let db: Db;
  let commands: ConnectorProviderExecuteCommand[];
  let spending: SpendingStore;
  let reader: ExtensionConnectionReader;
  let activity: Array<{ eventType: string; summary: string }>;
  let notified: string[];

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    commands = [];
    activity = [];
    notified = [];
    const provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
    });
    Object.defineProperty(provider, 'execute', {
      value: async (command: ConnectorProviderExecuteCommand) => {
        commands.push(command);
        if (!(await command.authorizeDispatch())) {
          return { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH', message: 'x' };
        }
        return { status: 'success', data: { items: [] } };
      },
    });
    const registry = new ConnectorRegistry({ db });
    registry.register(provider);
    db.update(connectorProviderInstances)
      .set({
        mode: 'byo',
        ownerKind: 'local_install',
        ownerId: 'install-a',
        executionConfigDigest: 'material-a',
        executionConfigGeneration: 1,
      })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    db.insert(connections)
      .values({
        id: CONNECTION,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'account-ref',
        toolkit: 'apify',
        label: 'Acme Scraper',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'rev-run',
        providerInstanceId: provider.instanceId,
        toolkit: 'apify',
        operationSlug: RUN,
        toolkitVersion: '1',
        schemaHash: 'sha256:rev-run',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object' }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    const approvals = new ExtensionConnectionApprovalStore(db, () => NOW);
    approvals.approve({
      install: installOf(),
      service: 'apify',
      connectionId: CONNECTION,
      approvedBy: 'owner',
    });
    spending = new SpendingStore(db, () => NOW);
    initConnectorSpending({
      store: spending,
      outsider: () => false,
      activity: { emit: async (event) => void activity.push(event) },
      agentName: () => 'Kestrel',
      notify: async (kind) => void notified.push(kind),
    });
    reader = new ExtensionConnectionReader(
      db,
      registry,
      approvals,
      new ConnectorUsageStore(db),
      () => NOW
    );
  });

  afterEach(() => initConnectorSpending(undefined));

  const runs = () => db.select().from(spendingRuns).all();

  it('is refused with no limit set: no card, the app is never called, the meter stays still', async () => {
    spending.setPrice('apify', 1 * DOLLAR);
    await expect(reader.read(installOf(), RUN, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_SPEND_REFUSED',
    });
    expect(commands).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    expect(spending.meter().usedMicro).toBe(0);
    // A card would be raised as a notice; a mini app never gets one.
    expect(notified).toEqual([]);
  });

  it('is refused when the app has no price, since the limit could not count it', async () => {
    spending.setLimit(10 * DOLLAR);
    await expect(reader.read(installOf(), RUN, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_SPEND_REFUSED',
    });
    expect(commands).toHaveLength(0);
    expect(runs()).toHaveLength(0);
  });

  it('is refused when the spend limit is not wired at all', async () => {
    initConnectorSpending(undefined);
    await expect(reader.read(installOf(), RUN, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_SPEND_REFUSED',
    });
    expect(commands).toHaveLength(0);
  });

  it('runs inside the limit, counted on the same meter as agents', async () => {
    spending.setLimit(10 * DOLLAR);
    spending.setPrice('apify', 2 * DOLLAR);
    await expect(reader.read(installOf(), RUN, {})).resolves.toEqual({
      status: 'success',
      data: { items: [] },
    });
    expect(commands).toHaveLength(1);
    expect(spending.meter().usedMicro).toBe(2 * DOLLAR);
    expect(runs()).toEqual([
      expect.objectContaining({ toolkit: 'apify', agentId: 'extension:price-watch' }),
    ]);
    expect(activity).toEqual([expect.objectContaining({ eventType: 'spending.ran' })]);
  });

  it('is refused past the limit, and the app is never called', async () => {
    spending.setLimit(3 * DOLLAR);
    spending.setPrice('apify', 2 * DOLLAR);
    await reader.read(installOf(), RUN, {});
    await expect(reader.read(installOf(), RUN, {})).rejects.toMatchObject({
      code: 'EXTENSION_CONNECTION_SPEND_REFUSED',
    });
    expect(commands).toHaveLength(1);
    expect(spending.meter().usedMicro).toBe(2 * DOLLAR);
  });

  it('gives the reservation back when the read is cancelled before it is sent', async () => {
    spending.setLimit(10 * DOLLAR);
    spending.setPrice('apify', 2 * DOLLAR);
    const stopped = new AbortController();
    stopped.abort();
    await expect(reader.read(installOf(), RUN, {}, stopped.signal)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(commands).toHaveLength(0);
    expect(spending.meter().usedMicro).toBe(0);
  });

  it.each(['extension first', 'agent first'] as const)(
    'shares one reserve with agents, %s: side by side at 60 percent of what is left, exactly one goes through',
    async (order) => {
      spending.setLimit(10 * DOLLAR);
      spending.setPrice('apify', 6 * DOLLAR);
      const extension = () => reader.read(installOf(), RUN, {});
      const agent = async () =>
        reserveSpend(
          {
            actorKind: 'agent',
            agentId: 'agent-kestrel',
            operation: { toolkit: 'apify', operationSlug: RUN },
          },
          'agent-run-1',
          undefined,
          NOW
        );
      const settled = await Promise.allSettled(
        order === 'extension first' ? [extension(), agent()] : [agent(), extension()]
      );
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect(spending.meter().usedMicro).toBe(6 * DOLLAR);
      expect(runs()).toHaveLength(1);
    }
  );
});
