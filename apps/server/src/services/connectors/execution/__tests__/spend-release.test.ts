/**
 * The monthly spend limit where a paid run is let go (DOR-4204 PR 2): the
 * broker reserves the run's price against the limit in one synchronous step
 * before the provider is called, so the check and the count cannot be split.
 *
 * Real authorization, broker, usage store and SQLite; only the provider is a
 * fake. The service, account and amounts are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notified = vi.hoisted(() => [] as Array<{ kind: string; payload: unknown }>);
vi.mock('../../../notifications/notification-service.js', () => ({
  notify: vi.fn(async (kind: string, payload: unknown) => {
    notified.push({ kind, payload });
    return { deduped: false };
  }),
}));
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  type Db,
} from '@dorkos/db';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import { ConnectorExecutionBroker } from '../execution-broker.js';
import { ConnectorUsageStore } from '../usage-store.js';
import { SpendingStore } from '../../spending/spending-store.js';
import { initConnectorSpending } from '../../spending/spending-port.js';
import { refuseSpend } from '../../../core/capabilities/spend-permission.js';
import { CapabilityToolError } from '../../../core/capabilities/mcp-envelope.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = new Date('2026-11-14T00:00:00.000Z');
/** A pay-per-use search service, shown to people as "Acme Search". */
const PAID = ConnectionIdSchema.parse('connection-acme-search');
const REVISION = 'revision-acme-search';
const DOLLAR = 1_000_000;
const activity: Array<{ eventType: string; summary: string }> = [];

describe('a paid run where it is let go', () => {
  let db: Db;
  let provider: FakeConnectorProvider;
  let authorization: ConnectorExecutionAuthorizationService;
  let broker: ConnectorExecutionBroker;
  let spending: SpendingStore;
  let outsider: boolean;
  let executeProvider: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createTestDb();
    outsider = false;
    notified.length = 0;
    spending = new SpendingStore(db, () => NOW);
    provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
      custody: 'self-host',
    });
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    registry.register(provider, 'material-a');
    db.insert(connections)
      .values({
        id: PAID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'external-acme-search',
        toolkit: 'tavily',
        label: 'Acme Search',
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
        id: REVISION,
        providerInstanceId: provider.instanceId,
        toolkit: 'tavily',
        operationSlug: 'TAVILY_SEARCH',
        toolkitVersion: 'v1',
        schemaHash: `sha256:${REVISION}`,
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', additionalProperties: false }),
        discoveredAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: `grant-${REVISION}`,
        subjectType: 'agent',
        subjectId: 'agent-kestrel',
        agentId: 'agent-kestrel',
        connectionId: PAID,
        operationRevisionId: REVISION,
        createdBy: 'operator',
        createdAt: NOW.toISOString(),
      })
      .run();
    authorization = new ConnectorExecutionAuthorizationService(db, registry, {
      ownsAgent: (_owner, agentId) => agentId === 'agent-kestrel',
    });
    activity.length = 0;
    initConnectorSpending({
      store: spending,
      outsider: () => outsider,
      activity: { emit: async (event) => void activity.push(event) },
      agentName: () => 'Kestrel',
    });
    executeProvider = vi.spyOn(provider, 'execute').mockImplementation(async (command) => {
      await command.authorizeDispatch();
      return { status: 'success', data: { ok: true } } as never;
    });
    broker = new ConnectorExecutionBroker(
      authorization,
      new ConnectorUsageStore(db),
      { revalidate: () => true },
      () => NOW
    );
  });

  afterEach(() => initConnectorSpending(undefined));

  /** `approved`: a person's yes; `'ordinary'` is a yes on a card that was not about money. */
  async function run(approved: boolean | 'ordinary' = false) {
    const caller = createServerPrincipal({
      kind: 'agent',
      owner: OWNER,
      agentId: 'agent-kestrel',
      agentPath: '/agents/kestrel',
    });
    const target = { connectionId: PAID, operationRevisionId: REVISION, arguments: {} } as const;
    const prepared = await authorization.prepare({
      capabilityId: 'connectors.execute_read',
      target,
      principal: caller,
    });
    return broker.execute({
      capabilityId: 'connectors.execute_read',
      target,
      principal: caller,
      authorityBinding: prepared.authorityBinding,
      ...(approved
        ? {
            approval: {
              via: 'approval' as const,
              approvalId: 'approval-spend',
              authorityBindingDigest: prepared.authorityBinding.approvalScope.digest,
              ...(approved === true ? { spendCard: true as const } : {}),
            },
          }
        : {}),
      surface: 'mcp',
      signal: new AbortController().signal,
    });
  }

  it('says, before it runs, whether a paid run would ask, run or be refused', async () => {
    const preflight = () =>
      authorization.preflight({
        capabilityId: 'connectors.execute_read',
        target: { connectionId: PAID, operationRevisionId: REVISION, arguments: {} },
        principal: createServerPrincipal({
          kind: 'agent',
          owner: OWNER,
          agentId: 'agent-kestrel',
          agentPath: '/agents/kestrel',
        }),
      });
    await expect(preflight()).resolves.toMatchObject({
      spend: { kind: 'ask', reason: 'no-limit' },
    });
    spending.setLimit(DOLLAR);
    spending.setPrice('tavily', 300_000);
    await expect(preflight()).resolves.toMatchObject({ spend: { kind: 'run' } });
  });

  it('never runs a paid action quietly while no limit is set', async () => {
    await expect(run()).rejects.toMatchObject({ payload: { code: 'SPEND_APPROVAL_REQUIRED' } });
    expect(executeProvider).not.toHaveBeenCalled();
  });

  it('runs a paid action a person allowed once with no limit set, and counts it', async () => {
    await expect(run(true)).resolves.toMatchObject({ result: { status: 'success' } });
    expect(spending.meter()).toMatchObject({ unknownRuns: 1 });
  });

  it('never takes a yes on an ordinary card as a yes to spend (Security Must 2)', async () => {
    await expect(run('ordinary')).rejects.toMatchObject({
      payload: { code: 'SPEND_APPROVAL_REQUIRED' },
    });
    spending.setLimit(40 * DOLLAR);
    spending.setPrice('tavily', 300_000);
    db.$client.exec('DROP TABLE spending_runs');
    await expect(run('ordinary')).rejects.toMatchObject({
      payload: { code: 'SPEND_APPROVAL_REQUIRED' },
    });
    expect(executeProvider).not.toHaveBeenCalled();
  });

  it('lets three $0.30 runs fit a $1.00 limit, then refuses the fourth (spec §13 #2)', async () => {
    spending.setLimit(DOLLAR);
    spending.setPrice('tavily', 300_000);
    for (let index = 0; index < 3; index += 1) {
      await expect(run()).resolves.toMatchObject({ result: { status: 'success' } });
    }
    await expect(run()).rejects.toMatchObject({ payload: { code: 'SPEND_LIMIT' } });
    expect(executeProvider).toHaveBeenCalledTimes(3);
    expect(spending.meter().usedMicro).toBe(900_000);
  });

  it('refuses Allow once that would pass the limit, and spends nothing (spec §13 #4)', async () => {
    spending.setLimit(DOLLAR);
    spending.setPrice('tavily', 300_000);
    spending.reserve({
      id: 'earlier',
      toolkit: 'tavily',
      agentId: 'agent-kestrel',
      amountMicro: 800_000,
      source: 'person',
      enforceLimit: true,
    });
    await expect(run(true)).rejects.toMatchObject({ payload: { code: 'SPEND_LIMIT' } });
    expect(executeProvider).not.toHaveBeenCalled();
    expect(spending.meter().usedMicro).toBe(800_000);
  });

  it('lets exactly one of two runs side by side through, at 60% of what is left each (Security Must 3)', async () => {
    spending.setLimit(DOLLAR);
    spending.setPrice('tavily', 600_000);
    const results = await Promise.allSettled([run(), run()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(executeProvider).toHaveBeenCalledTimes(1);
    expect(spending.meter().usedMicro).toBe(600_000);
  });

  it('never spends on an outsider-marked turn, even under the limit (Security Must 1)', async () => {
    spending.setLimit(40 * DOLLAR);
    spending.setPrice('tavily', 300_000);
    outsider = true;
    for (const approved of [false, true]) {
      await expect(run(approved)).rejects.toMatchObject({ payload: { code: 'SPEND_OUTSIDER' } });
    }
    expect(executeProvider).not.toHaveBeenCalled();
    expect(spending.meter()).toMatchObject({ usedMicro: 0, unknownRuns: 0 });
  });

  it('never runs quietly when the meter cannot be read (Security Q8)', async () => {
    spending.setLimit(40 * DOLLAR);
    spending.setPrice('tavily', 300_000);
    db.$client.exec('DROP TABLE spending_runs');
    await expect(run()).rejects.toMatchObject({ payload: { code: 'SPEND_APPROVAL_REQUIRED' } });
    expect(executeProvider).not.toHaveBeenCalled();
  });

  it('tells the person at 80% and at the limit as runs cross them (spec §13 #9)', async () => {
    spending.setLimit(DOLLAR);
    spending.setPrice('tavily', 400_000);
    await run();
    expect(notified).toEqual([]);
    await run();
    expect(notified.map((n) => n.kind)).toEqual(['spending.near-limit']);
    spending.setPrice('tavily', 200_000);
    await run();
    expect(notified.map((n) => n.kind)).toEqual(['spending.near-limit', 'spending.limit-reached']);
  });

  it('writes an Activity line for each paid run, and each refusal (spec §9)', async () => {
    spending.setLimit(DOLLAR);
    spending.setPrice('tavily', 300_000);
    await run();
    await run(true);
    spending.reserve({
      id: 'later',
      toolkit: 'tavily',
      agentId: 'agent-kestrel',
      amountMicro: 400_000,
      source: 'person',
      enforceLimit: true,
    });
    await run().catch(() => undefined);
    outsider = true;
    await run().catch(() => undefined);
    const lines = activity.map((a) => a.summary);
    expect(lines[0]).toMatch(/^Kestrel ran .+ · about \$0\.30 · \$0\.70 left$/);
    expect(lines[1]).toMatch(/^Kestrel ran .+ · allowed once · about \$0\.30$/);
    expect(lines).toContainEqual(
      expect.stringMatching(/^Refused Kestrel: .+ · monthly limit reached$/)
    );
    expect(lines).toContain("Kestrel's paid run was refused: the turn read outside content.");
    expect(activity.every((a) => a.eventType.startsWith('spending.'))).toBe(true);
  });

  it('writes the refusal to Activity once when the gate stops a run before the broker', async () => {
    const preflight = async () =>
      (
        await authorization.preflight({
          capabilityId: 'connectors.execute_read',
          target: { connectionId: PAID, operationRevisionId: REVISION, arguments: {} },
          principal: createServerPrincipal({
            kind: 'agent',
            owner: OWNER,
            agentId: 'agent-kestrel',
            agentPath: '/agents/kestrel',
          }),
        })
      ).spend;
    spending.setLimit(40 * DOLLAR);
    spending.setPrice('tavily', 300_000);
    outsider = true;
    const outside = await preflight();
    expect(activity).toEqual([]);
    expect(() => refuseSpend(outside)).toThrow(CapabilityToolError);
    outsider = false;
    spending.setLimit(DOLLAR);
    spending.reserve({
      id: 'earlier',
      toolkit: 'tavily',
      agentId: 'agent-kestrel',
      amountMicro: DOLLAR,
      source: 'person',
      enforceLimit: true,
    });
    const atLimit = await preflight();
    expect(() => refuseSpend(atLimit)).toThrow(CapabilityToolError);
    expect(activity.map((a) => [a.eventType, a.summary])).toEqual([
      ['spending.refused', "Kestrel's paid run was refused: the turn read outside content."],
      ['spending.refused', expect.stringMatching(/^Refused Kestrel: .+ · monthly limit reached$/)],
    ]);
  });
});
