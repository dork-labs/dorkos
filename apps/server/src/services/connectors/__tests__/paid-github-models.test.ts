/**
 * GitHub Models calls spend money (DOR-4460), end to end over one real
 * database: GitHub is an ordinary service, but its model calls bill the account
 * owner and come back classed "read". An agent given Read can still list
 * issues, and can never run a model.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionAccessLevels,
  connectionOperationGrants,
  connections,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  accessLevelRevisionIds,
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorOperationRevision,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import { ConnectorReconciliationService } from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = new Date('2026-11-15T12:00:00.000Z');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-github');
const MODEL_CALLS = [
  'GITHUB_CREATE_INFERENCE_CHAT_COMPLETIONS',
  'GITHUB_CREATE_INFERENCE_EMBEDDINGS',
];
const LIST_ISSUES = 'GITHUB_LIST_ISSUES';

/** A fake GitHub that lists Composio's real operation names, every one classed read. */
class FakeGitHubProvider extends FakeConnectorProvider {
  override async listOperationSchemas(request: {
    toolkit: string;
    toolkitVersion: string;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }) {
    request.signal.throwIfAborted();
    const operations: Omit<ConnectorOperationRevision, 'id' | 'discoveredAt'>[] = [
      ...MODEL_CALLS,
      LIST_ISSUES,
    ].map((operationSlug) => ({
      providerInstanceId: this.instanceId,
      toolkit: request.toolkit,
      operationSlug,
      toolkitVersion: request.toolkitVersion,
      schemaHash: `sha256:${operationSlug.toLowerCase()}`,
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: { type: 'object', additionalProperties: false },
    }));
    return { status: 'ok' as const, page: { operations, truncated: false } };
  }
}

/** The stable refusal code a connector error carries, wherever it keeps it. */
async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const value = error as { code?: string; payload?: { code?: string } };
    return value.payload?.code ?? value.code ?? String(error);
  }
}

describe('GitHub Models calls under a Read grant', () => {
  let db: Db;
  let reconciliation: ConnectorReconciliationService;
  let authorization: ConnectorExecutionAuthorizationService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    const provider = new FakeGitHubProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
      custody: 'self-host',
      toolkitVersion: 'v1',
      toolkits: [{ slug: 'github', displayName: 'GitHub', authKind: 'oauth2' }],
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
        externalAccountRef: 'external-github',
        toolkit: 'github',
        label: 'Made-up GitHub',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    let nextId = 0;
    reconciliation = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [{ agentId: 'agent-a', displayName: 'Alpha' }],
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
    });
    authorization = new ConnectorExecutionAuthorizationService(db, registry, {
      ownsAgent: (_owner: unknown, agentId: string) => agentId === 'agent-a',
    });
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

  function run(operationRevisionId: string) {
    return authorization.prepare({
      capabilityId: 'connectors.execute_read',
      principal: createServerPrincipal({
        kind: 'agent',
        owner: OWNER,
        agentId: 'agent-a',
        agentPath: '/agents/agent-a',
      }),
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId,
        arguments: {},
      }),
    });
  }

  it('refuses every GitHub model call to an agent given Read, and still lists issues', async () => {
    const snapshot = await preview();
    const readIds = accessLevelRevisionIds(snapshot.candidates, 'read');
    expect(readIds).toEqual([revisionId(snapshot, LIST_ISSUES)]);
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: readIds, level: 'read' }],
    });
    await expect(run(revisionId(snapshot, LIST_ISSUES))).resolves.toMatchObject({
      agentId: 'agent-a',
    });
    for (const slug of MODEL_CALLS) {
      expect(await refusal(run(revisionId(snapshot, slug)))).toBe('CONNECTOR_GRANT_REQUIRED');
    }
  });

  it('refuses a GitHub model call held through a Read level given before this rule', async () => {
    const snapshot = await preview();
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
    for (const slug of MODEL_CALLS) {
      db.insert(connectionOperationGrants)
        .values({
          id: `legacy-${slug}`,
          subjectType: 'agent',
          subjectId: 'agent-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: revisionId(snapshot, slug),
          createdBy: OWNER.installationId,
          createdAt: NOW.toISOString(),
        })
        .run();
      expect(await refusal(run(revisionId(snapshot, slug)))).toBe('CONNECTOR_GRANT_REQUIRED');
    }
  });

  it('never lets a Read level be stretched to cover a GitHub model call', async () => {
    const snapshot = await preview();
    await expect(
      reconciliation.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [
          {
            agentId: 'agent-a',
            operationRevisionIds: [...MODEL_CALLS, LIST_ISSUES].map((slug) =>
              revisionId(snapshot, slug)
            ),
            level: 'read',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'invalid_selection' });
  });
});
