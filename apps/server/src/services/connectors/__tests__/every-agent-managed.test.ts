/**
 * "Every agent" on an app connected through a DorkOS account (DOR-2439), end to
 * end over one real database: the owner's reviewed write reaches hosted
 * authority as an owner-wide command, access opens only once hosted authority
 * has applied it, a managed call names the owner-wide scope, and stopping the
 * sharing ends access locally at once and reaches hosted authority too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectionIdSchema,
  ConnectorExecutionTargetSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import {
  ConnectorReconciliationError,
  ConnectorReconciliationService,
} from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';
import type { EveryAgentActivitySink } from '../every-agent-activity.js';
import { ManagedAuthoritySyncService } from '../resources/managed-authority-sync-service.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const OTHER_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const NOW = new Date('2026-09-27T12:00:00.000Z');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');
const HOSTED_REF: Record<string, string> = {
  'gmail.read': '10000000-0000-4000-8000-000000000001',
  'gmail.write': '10000000-0000-4000-8000-000000000002',
};
/** `agent-new` is in no preview: it arrives after the owner shared the app. */
const OWNED_AGENTS = new Set(['agent-a', 'agent-new']);

function codeOf(error: unknown): string {
  const value = error as { code?: string; payload?: { code?: string } };
  return value.payload?.code ?? value.code ?? String(error);
}

type HostedMode = 'applied' | 'pending' | 'rejected' | 'unreachable';

describe('every-agent grants through a DorkOS account', () => {
  let db: Db;
  let provider: FakeConnectorProvider;
  let reconciliation: ConnectorReconciliationService;
  let authorization: ConnectorExecutionAuthorizationService;
  let submitted: ManagedConnectorAuthorityCommand[];
  let hosted: HostedMode;
  let hostedStatus: Map<string, ManagedConnectorAuthorityCommandStatus>;
  let sync: ManagedAuthoritySyncService;
  let activity: { emit: ReturnType<typeof vi.fn<EveryAgentActivitySink['emit']>> };

  function statusFor(
    command: ManagedConnectorAuthorityCommand,
    state: 'applied' | 'pending' | 'rejected'
  ): ManagedConnectorAuthorityCommandStatus {
    const base = {
      version: 1 as const,
      commandId: command.commandId,
      managedConnectionId: command.managedConnectionId,
      scopeVersion: command.scopeVersion,
    };
    if (state === 'applied') return { ...base, state, externalCleanup: 'not_required' };
    if (state === 'rejected') return { ...base, state, rejectionCode: 'revision_unavailable' };
    return { ...base, state };
  }

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
      custody: 'managed',
      toolkitVersion: 'v1',
    });
    const discover = provider.listOperationSchemas.bind(provider);
    vi.spyOn(provider, 'listOperationSchemas').mockImplementation(async (request) => {
      const result = await discover(request);
      if (result.status === 'ok') {
        result.page.operations = result.page.operations.map((operation) => ({
          ...operation,
          providerRevisionRef: HOSTED_REF[operation.operationSlug] ?? HOSTED_REF['gmail.read'],
        }));
      }
      return result;
    });
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
    });
    registry.register(provider, 'material-a', 'managed');
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'managed-connection-a',
        toolkit: 'gmail',
        label: 'Work Gmail',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();

    activity = { emit: vi.fn<EveryAgentActivitySink['emit']>() };
    submitted = [];
    hosted = 'applied';
    hostedStatus = new Map();
    let nextManaged = 0;
    sync = new ManagedAuthoritySyncService({
      db,
      now: () => NOW,
      createId: () => `managed-${++nextManaged}`,
      cloud: {
        submitConnectorAuthorityCommand: async (command) => {
          if (hosted === 'unreachable') {
            throw Object.assign(new Error('offline'), { code: 'network_error' });
          }
          submitted.push(command);
          const status = statusFor(command, hosted);
          hostedStatus.set(command.commandId, status);
          return status;
        },
        readConnectorAuthorityCommand: async (commandId) => {
          const status = hostedStatus.get(commandId);
          if (!status) throw Object.assign(new Error('absent'), { code: 'not_found' });
          return status;
        },
        isLinked: () => false,
      },
    });
    let nextId = 0;
    reconciliation = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [{ agentId: 'agent-a', displayName: 'Alpha' }],
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      managedAuthority: sync,
      activity,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
    });
    authorization = new ConnectorExecutionAuthorizationService(db, registry, {
      ownsAgent: (owner, agentId) =>
        owner.kind === 'local_install' &&
        owner.installationId === OWNER.installationId &&
        OWNED_AGENTS.has(agentId),
    });
  });

  async function preview(owner = OWNER): Promise<ConnectorReconciliationPreview> {
    return reconciliation.preview(
      owner,
      { connectionId: CONNECTION_ID },
      new AbortController().signal
    );
  }

  function revisionId(snapshot: ConnectorReconciliationPreview, slug: string): string {
    const candidate = snapshot.candidates.find((entry) => entry.operationSlug === slug);
    if (!candidate) throw new Error(`No ${slug} candidate in the preview.`);
    return candidate.operationRevisionId;
  }

  function execute(
    agentId: string,
    operationRevisionId: string,
    classification: 'read' | 'write',
    owner: typeof OWNER | typeof OTHER_OWNER = OWNER
  ) {
    return authorization.prepare({
      capabilityId: `connectors.execute_${classification}`,
      principal: createServerPrincipal({
        kind: 'agent',
        owner,
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

  async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise;
      return undefined;
    } catch (error) {
      return codeOf(error);
    }
  }

  async function shareRead(): Promise<ConnectorReconciliationPreview> {
    const snapshot = await preview();
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [revisionId(snapshot, 'gmail.read')] },
    });
    return snapshot;
  }

  it('sends hosted authority one owner-wide command that names no agent', async () => {
    const snapshot = await preview();
    expect(snapshot.everyAgent.available).toBe(true);

    const applied = await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: [revisionId(snapshot, 'gmail.read')] },
    });
    expect(applied.authoritySync).toEqual({ status: 'ready' });
    expect(submitted).toEqual([
      expect.objectContaining({
        kind: 'replace_every_agent_grants',
        managedConnectionId: 'managed-connection-a',
        scopeVersion: 1,
        revisions: [expect.objectContaining({ hostedRevisionId: HOSTED_REF['gmail.read'] })],
      }),
    ]);
    expect(submitted[0]).not.toHaveProperty('agentId');
  });

  it('covers an agent added later, through the owner-wide hosted scope, for the shared action only', async () => {
    const snapshot = await shareRead();
    const read = revisionId(snapshot, 'gmail.read');

    const authorized = await execute('agent-new', read, 'read');
    expect(authorized).toMatchObject({
      agentId: 'agent-new',
      payer: 'dorkos_managed',
      managedGrantSubject: 'every_agent',
      managedGrantScopeVersion: 1,
      managedHostedRevisionId: HOSTED_REF['gmail.read'],
    });
    expect(await refusal(execute('agent-new', revisionId(snapshot, 'gmail.write'), 'write'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );
  });

  it("uses the agent's own hosted grant when it has one, and every agent's for the rest", async () => {
    const snapshot = await preview();
    const read = revisionId(snapshot, 'gmail.read');
    await reconciliation.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [{ agentId: 'agent-a', operationRevisionIds: [read] }],
      everyAgent: { operationRevisionIds: [read] },
    });
    await expect(execute('agent-a', read, 'read')).resolves.toMatchObject({
      managedGrantSubject: 'agent',
    });
    await expect(execute('agent-new', read, 'read')).resolves.toMatchObject({
      managedGrantSubject: 'every_agent',
    });
  });

  it('keeps a new share closed until hosted authority applies it, and closed if it refuses', async () => {
    hosted = 'pending';
    const snapshot = await shareRead();
    const read = revisionId(snapshot, 'gmail.read');
    expect(await refusal(execute('agent-new', read, 'read'))).toBe('CONNECTOR_GRANT_REQUIRED');

    // Hosted authority finishes applying it; the recovery pass reads the receipt.
    const [command] = submitted;
    hostedStatus.set(command!.commandId, statusFor(command!, 'applied'));
    db.update(connectorManagedAuthorityOutbox)
      .set({ nextAttemptAt: null })
      .where(eq(connectorManagedAuthorityOutbox.commandId, command!.commandId))
      .run();
    await sync.recoverPending(new AbortController().signal);
    await expect(execute('agent-new', read, 'read')).resolves.toMatchObject({
      managedGrantSubject: 'every_agent',
    });

    // A widening hosted authority refuses never opens.
    hosted = 'rejected';
    const again = await preview();
    await reconciliation.apply(OWNER, {
      previewId: again.previewId,
      grants: [],
      everyAgent: {
        operationRevisionIds: [revisionId(again, 'gmail.read'), revisionId(again, 'gmail.write')],
      },
    });
    expect(await refusal(execute('agent-new', revisionId(again, 'gmail.write'), 'write'))).toBe(
      'CONNECTOR_GRANT_REQUIRED'
    );
  });

  it('stops at once when the owner stops sharing, even while hosted authority is unreachable', async () => {
    const snapshot = await shareRead();
    const read = revisionId(snapshot, 'gmail.read');
    await expect(execute('agent-new', read, 'read')).resolves.toBeDefined();

    hosted = 'unreachable';
    await expect(reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      revokedCount: 1,
    });
    expect(await refusal(execute('agent-new', read, 'read'))).toBe('CONNECTOR_GRANT_REQUIRED');

    // The stop waits in the outbox and reaches hosted authority once it is back.
    const pending = db
      .select()
      .from(connectorManagedAuthorityOutbox)
      .where(eq(connectorManagedAuthorityOutbox.state, 'pending'))
      .all();
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0]!.requestJson)).toMatchObject({
      kind: 'replace_every_agent_grants',
      revisions: [],
    });
    hosted = 'applied';
    db.update(connectorManagedAuthorityOutbox).set({ nextAttemptAt: null }).run();
    await sync.recoverPending(new AbortController().signal);
    expect(submitted.at(-1)).toMatchObject({
      kind: 'replace_every_agent_grants',
      scopeVersion: 2,
      revisions: [],
    });
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .all()
        .filter((grant) => grant.subjectType === 'every_agent' && grant.revokedAt === null)
    ).toEqual([]);
  });

  it('lets no one but the owner share it, stop it or use it', async () => {
    const snapshot = await shareRead();
    const read = revisionId(snapshot, 'gmail.read');
    const commandsBefore = submitted.length;

    // Another owner can neither widen the owner's sharing with a preview it
    // does not own, nor stop it, nor call through it.
    const fresh = await preview();
    const widened = reconciliation.apply(OTHER_OWNER, {
      previewId: fresh.previewId,
      grants: [],
      everyAgent: {
        operationRevisionIds: [revisionId(fresh, 'gmail.read'), revisionId(fresh, 'gmail.write')],
      },
    });
    await expect(widened).rejects.toBeInstanceOf(ConnectorReconciliationError);
    await expect(reconciliation.revokeEveryAgent(OTHER_OWNER, CONNECTION_ID)).rejects.toMatchObject(
      { code: 'connection_not_found' }
    );
    expect(await refusal(execute('agent-new', read, 'read', OTHER_OWNER))).not.toBeUndefined();
    expect(submitted).toHaveLength(commandsBefore);
    await expect(execute('agent-new', read, 'read')).resolves.toMatchObject({
      managedGrantSubject: 'every_agent',
    });
  });

  function liveEveryAgentRows() {
    return db
      .select()
      .from(connectionOperationGrants)
      .all()
      .filter((grant) => grant.subjectType === 'every_agent' && grant.revokedAt === null);
  }

  async function landEverything(): Promise<void> {
    for (const command of submitted) {
      hostedStatus.set(command.commandId, statusFor(command, 'applied'));
    }
    hosted = 'applied';
    db.update(connectorManagedAuthorityOutbox).set({ nextAttemptAt: null }).run();
    await sync.recoverPending(new AbortController().signal);
  }

  it('stops a share hosted authority has not applied yet, so it cannot open when it lands', async () => {
    hosted = 'pending';
    const snapshot = await shareRead();
    const read = revisionId(snapshot, 'gmail.read');
    expect(liveEveryAgentRows()).toEqual([]);

    // Nothing is live locally, but the share is on its way: stopping it must
    // still reach hosted authority, and must say so in the trail.
    await expect(reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID)).resolves.toEqual({
      connectionId: CONNECTION_ID,
      revokedCount: 0,
    });
    expect(submitted.at(-1)).toMatchObject({
      kind: 'replace_every_agent_grants',
      scopeVersion: 2,
      revisions: [],
    });
    expect(activity.emit).toHaveBeenCalledTimes(2);

    // The share lands late at hosted authority; it never opens here.
    await landEverything();
    expect(liveEveryAgentRows()).toEqual([]);
    expect(await refusal(execute('agent-new', read, 'read'))).toBe('CONNECTOR_GRANT_REQUIRED');
  });

  it('stops a share whose command was already compacted, since it cannot prove it ended', async () => {
    const snapshot = await shareRead();
    const read = revisionId(snapshot, 'gmail.read');
    // Compaction keeps the scope but drops the request body.
    db.update(connectorManagedAuthorityOutbox).set({ requestJson: '{}' }).run();
    db.update(connectionOperationGrants)
      .set({ revokedAt: NOW.toISOString() })
      .where(eq(connectionOperationGrants.subjectType, 'every_agent'))
      .run();
    const before = submitted.length;
    await reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID);
    expect(submitted).toHaveLength(before + 1);
    expect(submitted.at(-1)).toMatchObject({ kind: 'replace_every_agent_grants', revisions: [] });
    expect(await refusal(execute('agent-new', read, 'read'))).toBe('CONNECTOR_GRANT_REQUIRED');
  });

  it('sends nothing more once the sharing already ended', async () => {
    await shareRead();
    await reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID);
    const before = submitted.length;
    await expect(reconciliation.revokeEveryAgent(OWNER, CONNECTION_ID)).resolves.toMatchObject({
      revokedCount: 0,
    });
    expect(submitted).toHaveLength(before);
  });
});
