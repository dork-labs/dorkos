/**
 * Operations that spend money (DOR-4204), end to end over one real database: an
 * Apify actor run is classed "read" by the service, yet it bills the account
 * owner. No access level covers it, "every agent" never gets it, and running it
 * needs a grant made for that agent and that operation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionAccessLevels,
  connectionOperationGrants,
  connections,
  createDb,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  accessLevelRevisionIds,
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import { ConnectorReconciliationService } from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = new Date('2026-11-13T12:00:00.000Z');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-apify');
const OWNED_AGENTS = new Set(['agent-a', 'agent-b']);

/** The stable refusal code a connector error carries, wherever it keeps it. */
function codeOf(error: unknown): string {
  const value = error as { code?: string; payload?: { code?: string } };
  return value.payload?.code ?? value.code ?? String(error);
}

describe('operations that spend money', () => {
  let db: Db;
  let provider: FakeConnectorProvider;
  let reconciliation: ConnectorReconciliationService;
  let authorization: ConnectorExecutionAuthorizationService;
  let nextId: number;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
      custody: 'self-host',
      toolkitVersion: 'v1',
      toolkits: [{ slug: 'apify', displayName: 'Apify', authKind: 'api-key' }],
    });
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    registry.register(provider, 'material-a');
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'external-apify',
        toolkit: 'apify',
        label: 'Made-up Apify',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    nextId = 0;
    const ownership = {
      ownsAgent: (_owner: unknown, agentId: string) => OWNED_AGENTS.has(agentId),
    };
    reconciliation = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [
        { agentId: 'agent-a', displayName: 'Alpha' },
        { agentId: 'agent-b', displayName: 'Bravo' },
      ],
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
    });
    authorization = new ConnectorExecutionAuthorizationService(db, registry, ownership);
  });

  async function preview(): Promise<ConnectorReconciliationPreview> {
    return reconciliation.preview(
      OWNER,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
  }

  function revisionId(snapshot: ConnectorReconciliationPreview, slug: string): string {
    const candidate = snapshot.candidates.find((entry) => entry.operationSlug === slug);
    if (!candidate) throw new Error(`No ${slug} candidate in the preview.`);
    return candidate.operationRevisionId;
  }

  function run(agentId: string, operationRevisionId: string) {
    return authorization.prepare({
      capabilityId: 'connectors.execute_read',
      principal: createServerPrincipal({
        kind: 'agent',
        owner: OWNER,
        agentId,
        agentPath: `/agents/${agentId}`,
      }),
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId,
        arguments: {},
      }),
    });
  }

  /** The refusal's sentence, wherever the error keeps it. */
  async function sentence(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return (error as { payload?: { error?: string } }).payload?.error;
    }
  }

  async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return codeOf(error);
    }
  }

  // The ticket's own test: an Apify actor run under a Read grant is refused.
  it('refuses an Apify actor run to an agent given Read', async () => {
    const snapshot = await preview();
    const scrape = revisionId(snapshot, 'apify.read');
    expect(snapshot.candidates.find((c) => c.operationSlug === 'apify.read')).toMatchObject({
      capabilityClassification: 'read',
    });
    const readIds = accessLevelRevisionIds(snapshot.candidates, 'read');
    expect(readIds).not.toContain(scrape);
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: readIds, level: 'read' }],
    });
    expect(await refusal(run('agent-a', scrape))).toBe('CONNECTOR_GRANT_REQUIRED');
  });

  it('never lets a Read level be stretched to cover a paid action', async () => {
    const snapshot = await preview();
    await expect(
      reconciliation.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [
          {
            agentId: 'agent-a',
            operationRevisionIds: [revisionId(snapshot, 'apify.read')],
            level: 'read',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
  });

  it('never shares a paid action with every agent', async () => {
    const snapshot = await preview();
    await expect(
      reconciliation.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: { operationRevisionIds: [revisionId(snapshot, 'apify.read')] },
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
  });

  it('refuses a paid action held only through an every-agent grant written before this rule', async () => {
    const snapshot = await preview();
    const scrape = revisionId(snapshot, 'apify.read');
    db.insert(connectionOperationGrants)
      .values({
        id: 'legacy-every-agent',
        subjectType: 'every_agent',
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        connectionId: CONNECTION_ID,
        operationRevisionId: scrape,
        createdBy: OWNER.installationId,
        createdAt: NOW.toISOString(),
      })
      .run();
    expect(await refusal(run('agent-b', scrape))).toBe('CONNECTOR_GRANT_REQUIRED');
    expect(await sentence(run('agent-b', scrape))).toMatch(/spends money/);
  });

  it('refuses a paid action held only through a Read level given before this rule', async () => {
    const snapshot = await preview();
    const scrape = revisionId(snapshot, 'apify.read');
    // What an install that gave agent-a Read before this change holds until its next catalog read.
    db.insert(connectionAccessLevels)
      .values({
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        level: 'read',
        createdBy: OWNER.installationId,
        updatedAt: NOW.toISOString(),
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'legacy-level-row',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: scrape,
        createdBy: OWNER.installationId,
        createdAt: NOW.toISOString(),
      })
      .run();
    expect(await refusal(run('agent-a', scrape))).toBe('CONNECTOR_GRANT_REQUIRED');
    expect(await sentence(run('agent-a', scrape))).toMatch(/spends money/);
  });

  it('runs a paid action for an agent the person picked that action for', async () => {
    const snapshot = await preview();
    const scrape = revisionId(snapshot, 'apify.read');
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: [scrape] }],
    });
    await expect(run('agent-a', scrape)).resolves.toMatchObject({ agentId: 'agent-a' });
    expect(await refusal(run('agent-b', scrape))).toBe('CONNECTOR_GRANT_REQUIRED');
  });
});
