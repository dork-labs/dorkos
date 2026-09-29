/**
 * A level is a promise (ADR 260929-071355): "Read" keeps meaning every action
 * the app lets agents read as the app changes, never more than its class. Over
 * one real database, the app's catalog changes between two reviews and each
 * level's grants follow it, on this computer's own authority and through a
 * DorkOS account, while exact actions stay exactly as chosen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  and,
  connectionAccessLevels,
  connectionOperationGrants,
  connections,
  connectorManagedAuthorityOutbox,
  connectorOperationRevisions,
  createDb,
  eq,
  isNull,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import {
  ConnectionIdSchema,
  ConnectorProviderInstanceIdSchema,
  type ConnectorOperationClassification,
  type ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type { EveryAgentActivitySink } from '../every-agent-activity.js';
import {
  ConnectorReconciliationError,
  ConnectorReconciliationService,
} from '../reconciliation-service.js';
import { ConnectorRegistry } from '../registry.js';
import { ManagedAuthoritySyncService } from '../resources/managed-authority-sync-service.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = new Date('2026-09-29T12:00:00.000Z');
const CONNECTION_ID = ConnectionIdSchema.parse('connection-a');

/** One action in the app's catalog, as the service describes it today. */
interface CatalogAction {
  slug: string;
  classification: ConnectorOperationClassification;
}

/** A hosted revision id per action name, shaped the way hosted authority mints them. */
function hostedRef(slug: string): string {
  const n = [...slug].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function setUp(mode: 'byo' | 'managed') {
  const db = createDb(':memory:');
  runMigrations(db);
  const provider = new FakeConnectorProvider({
    instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
    type: 'fake',
    ...(mode === 'managed' ? { custody: 'managed' as const } : {}),
    toolkitVersion: 'v1',
  });
  const catalog: CatalogAction[] = [
    { slug: 'gmail.list', classification: 'read' },
    { slug: 'gmail.send', classification: 'write' },
    { slug: 'gmail.delete', classification: 'destructive' },
  ];
  vi.spyOn(provider, 'listOperationSchemas').mockImplementation(async (request) => ({
    status: 'ok' as const,
    page: {
      operations: catalog.map((action) => ({
        providerInstanceId: provider.instanceId,
        toolkit: request.toolkit,
        operationSlug: action.slug,
        toolkitVersion: request.toolkitVersion,
        schemaHash: `sha256:${action.slug}`,
        capabilityClassification: action.classification,
        retryPolicy: 'never' as const,
        inputSchema: { type: 'object', additionalProperties: false },
        ...(mode === 'managed' ? { providerRevisionRef: hostedRef(action.slug) } : {}),
      })),
      truncated: false,
    },
  }));
  const registry = new ConnectorRegistry({
    db,
    configuredOwner: { ownerKind: 'local_install', ownerId: OWNER.installationId },
  });
  registry.register(provider, 'material-a', mode);
  db.insert(connections)
    .values({
      id: CONNECTION_ID,
      providerInstanceId: provider.instanceId,
      externalAccountRef: 'external-a',
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
  return { db, provider, registry, catalog };
}

/** What one subject can use right now, by action name and class. */
function liveActions(db: Db, subject: { agentId: string } | 'every_agent'): string[] {
  return db
    .select({
      slug: connectorOperationRevisions.operationSlug,
      classification: connectorOperationRevisions.capabilityClassification,
    })
    .from(connectionOperationGrants)
    .innerJoin(
      connectorOperationRevisions,
      eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
    )
    .where(
      and(
        eq(connectionOperationGrants.connectionId, CONNECTION_ID),
        subject === 'every_agent'
          ? eq(connectionOperationGrants.subjectType, 'every_agent')
          : eq(connectionOperationGrants.subjectId, subject.agentId),
        isNull(connectionOperationGrants.revokedAt)
      )
    )
    .all()
    .map((row) => `${row.slug}:${row.classification}`)
    .sort();
}

function levelIds(snapshot: ConnectorReconciliationPreview, level: 'read' | 'read-write') {
  return snapshot.candidates
    .filter(
      (candidate) =>
        candidate.supported &&
        (candidate.capabilityClassification === 'read' ||
          (level === 'read-write' && candidate.capabilityClassification === 'write'))
    )
    .map((candidate) => candidate.operationRevisionId)
    .sort();
}

function idOf(snapshot: ConnectorReconciliationPreview, slug: string): string {
  const candidate = snapshot.candidates.find(
    (entry) => entry.operationSlug === slug && entry.supported
  );
  if (!candidate) throw new Error(`No offered ${slug} in the preview.`);
  return candidate.operationRevisionId;
}

describe('levels follow the app on this computer', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let catalog: CatalogAction[];
  let service: ConnectorReconciliationService;
  let activity: { emit: ReturnType<typeof vi.fn<EveryAgentActivitySink['emit']>> };

  beforeEach(() => {
    ({ db, registry, catalog } = setUp('byo'));
    activity = { emit: vi.fn<EveryAgentActivitySink['emit']>() };
    let nextId = 0;
    service = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [
        { agentId: 'reader', displayName: 'Reader' },
        { agentId: 'writer', displayName: 'Writer' },
        { agentId: 'exact', displayName: 'Exact' },
      ],
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      activity,
      writer: () => ({ actorType: 'user', actorLabel: 'Someone on this computer' }),
    });
  });

  const preview = () =>
    service.preview(OWNER, { connectionId: CONNECTION_ID }, new AbortController().signal);

  /** Reader holds Read, Writer holds Read and write, Exact picked the list action by hand. */
  async function grantLevels(): Promise<ConnectorReconciliationPreview> {
    const snapshot = await preview();
    await service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [
        { agentId: 'reader', operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
        {
          agentId: 'writer',
          operationRevisionIds: levelIds(snapshot, 'read-write'),
          level: 'read-write',
        },
        { agentId: 'exact', operationRevisionIds: [idOf(snapshot, 'gmail.list')] },
      ],
    });
    return snapshot;
  }

  it('stores the level the owner chose, and shows it back', async () => {
    await grantLevels();
    const again = await preview();
    expect(again.currentGrants).toEqual([
      { agentId: 'exact', operationRevisionIds: [idOf(again, 'gmail.list')] },
      { agentId: 'reader', operationRevisionIds: levelIds(again, 'read'), level: 'read' },
      {
        agentId: 'writer',
        operationRevisionIds: levelIds(again, 'read-write'),
        level: 'read-write',
      },
    ]);
  });

  it('adds a new read action to Read and to Read and write, never to exact actions', async () => {
    await grantLevels();
    catalog.push({ slug: 'gmail.search', classification: 'read' });
    const again = await preview();

    expect(liveActions(db, { agentId: 'reader' })).toEqual([
      'gmail.list:read',
      'gmail.search:read',
    ]);
    expect(liveActions(db, { agentId: 'writer' })).toEqual([
      'gmail.list:read',
      'gmail.search:read',
      'gmail.send:write',
    ]);
    expect(liveActions(db, { agentId: 'exact' })).toEqual(['gmail.list:read']);
    // The page shows the level the owner chose, not "exact actions".
    expect(again.currentGrants.find((grant) => grant.agentId === 'reader')).toEqual({
      agentId: 'reader',
      operationRevisionIds: levelIds(again, 'read'),
      level: 'read',
    });
  });

  it('adds a new write action to Read and write only', async () => {
    await grantLevels();
    catalog.push({ slug: 'gmail.draft', classification: 'write' });
    await preview();

    expect(liveActions(db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    expect(liveActions(db, { agentId: 'writer' })).toEqual([
      'gmail.draft:write',
      'gmail.list:read',
      'gmail.send:write',
    ]);
  });

  it('never adds a new destructive action to any level', async () => {
    await grantLevels();
    catalog.push({ slug: 'gmail.empty_trash', classification: 'destructive' });
    await preview();

    expect(liveActions(db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    expect(liveActions(db, { agentId: 'writer' })).toEqual(['gmail.list:read', 'gmail.send:write']);
  });

  it('takes an action reclassified from read to write out of Read, and keeps it in Read and write', async () => {
    await grantLevels();
    catalog[0] = { slug: 'gmail.list', classification: 'write' };
    await preview();

    expect(liveActions(db, { agentId: 'reader' })).toEqual([]);
    expect(liveActions(db, { agentId: 'writer' })).toEqual([
      'gmail.list:write',
      'gmail.send:write',
    ]);
    // The Read level itself is kept, so a read action that comes back joins again.
    catalog[0] = { slug: 'gmail.list', classification: 'read' };
    await preview();
    expect(liveActions(db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
  });

  it('takes an action reclassified to destructive out of every level', async () => {
    await grantLevels();
    catalog[0] = { slug: 'gmail.list', classification: 'destructive' };
    catalog[1] = { slug: 'gmail.send', classification: 'destructive' };
    await preview();

    expect(liveActions(db, { agentId: 'reader' })).toEqual([]);
    expect(liveActions(db, { agentId: 'writer' })).toEqual([]);
    // An exact pick is never re-pointed: it keeps the revision it was given.
    expect(liveActions(db, { agentId: 'exact' })).toEqual(['gmail.list:read']);
  });

  it('refuses a level that names anything beyond its class, or leaves out part of it', async () => {
    const snapshot = await preview();
    for (const operationRevisionIds of [
      [...levelIds(snapshot, 'read'), idOf(snapshot, 'gmail.send')],
      [...levelIds(snapshot, 'read'), idOf(snapshot, 'gmail.delete')],
      [],
    ]) {
      await expect(
        service.apply(OWNER, {
          previewId: snapshot.previewId,
          grants: [{ agentId: 'reader', operationRevisionIds, level: 'read' }],
        })
      ).rejects.toMatchObject({ code: 'invalid_selection' });
    }
    await expect(
      service.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: {
          operationRevisionIds: [
            ...levelIds(snapshot, 'read-write'),
            idOf(snapshot, 'gmail.delete'),
          ],
          level: 'read-write',
        },
      })
    ).rejects.toBeInstanceOf(ConnectorReconciliationError);
    expect(db.select().from(connectionAccessLevels).all()).toEqual([]);
  });

  it('turns a level into exact actions when the owner picks actions by hand', async () => {
    const snapshot = await grantLevels();
    const again = await preview();
    await service.apply(OWNER, {
      previewId: again.previewId,
      grants: [{ agentId: 'reader', operationRevisionIds: [idOf(snapshot, 'gmail.list')] }],
    });
    catalog.push({ slug: 'gmail.search', classification: 'read' });
    const after = await preview();

    expect(liveActions(db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    expect(after.currentGrants.find((grant) => grant.agentId === 'reader')).not.toHaveProperty(
      'level'
    );
  });

  it('never brings back access that was taken away some other way', async () => {
    await grantLevels();
    registry.removeAgentConnectionAccess('reader', CONNECTION_ID);
    registry.removeAgentAccess('writer');
    catalog.push({ slug: 'gmail.search', classification: 'read' });
    await preview();

    expect(liveActions(db, { agentId: 'reader' })).toEqual([]);
    expect(liveActions(db, { agentId: 'writer' })).toEqual([]);
    expect(db.select().from(connectionAccessLevels).all()).toEqual([]);
  });

  it('ends every level when the account is disconnected', async () => {
    await grantLevels();
    registry.recordDisconnect(CONNECTION_ID);
    expect(db.select().from(connectionAccessLevels).all()).toEqual([]);
  });

  it('keeps every agent on its level as the app changes, and says so in Activity', async () => {
    const snapshot = await preview();
    await service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
    });
    activity.emit.mockClear();
    catalog.push({ slug: 'gmail.search', classification: 'read' });
    catalog.push({ slug: 'gmail.draft', classification: 'write' });
    const again = await preview();

    expect(liveActions(db, 'every_agent')).toEqual(['gmail.list:read', 'gmail.search:read']);
    expect(again.everyAgent).toEqual({
      available: true,
      operationRevisionIds: levelIds(again, 'read'),
      level: 'read',
    });
    expect(activity.emit).toHaveBeenCalledOnce();
    expect(activity.emit.mock.calls[0]![0]).toMatchObject({
      actorType: 'system',
      actorLabel: 'DorkOS',
      resourceId: CONNECTION_ID,
    });

    // Reading the same catalog again changes nothing and records nothing.
    activity.emit.mockClear();
    await preview();
    expect(activity.emit).not.toHaveBeenCalled();

    // Stopping the sharing ends the level too, so nothing re-shares it.
    await service.revokeEveryAgent(OWNER, CONNECTION_ID);
    catalog.push({ slug: 'gmail.labels', classification: 'read' });
    await preview();
    expect(liveActions(db, 'every_agent')).toEqual([]);
  });
});

describe('levels follow the app through a DorkOS account', () => {
  let db: Db;
  let catalog: CatalogAction[];
  let service: ConnectorReconciliationService;
  let sync: ManagedAuthoritySyncService;
  let submitted: ManagedConnectorAuthorityCommand[];
  let hosted: 'applied' | 'pending';
  let hostedStatus: Map<string, ManagedConnectorAuthorityCommandStatus>;

  function statusFor(
    command: ManagedConnectorAuthorityCommand,
    state: 'applied' | 'pending'
  ): ManagedConnectorAuthorityCommandStatus {
    const base = {
      version: 1 as const,
      commandId: command.commandId,
      managedConnectionId: command.managedConnectionId,
      scopeVersion: command.scopeVersion,
    };
    return state === 'applied'
      ? { ...base, state, externalCleanup: 'not_required' }
      : { ...base, state };
  }

  beforeEach(() => {
    let registry: ConnectorRegistry;
    ({ db, registry, catalog } = setUp('managed'));
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
      },
    });
    let nextId = 0;
    service = new ConnectorReconciliationService({
      db,
      registry,
      bootEpoch: 'boot-a',
      listAgents: () => [{ agentId: 'reader', displayName: 'Reader' }],
      now: () => NOW,
      createId: () => `generated-${++nextId}`,
      managedAuthority: sync,
    });
  });

  const preview = () =>
    service.preview(OWNER, { connectionId: CONNECTION_ID }, new AbortController().signal);

  it('stages a new read action through hosted authority, and opens it only once it applies', async () => {
    const snapshot = await preview();
    await service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [
        { agentId: 'reader', operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
      ],
    });
    expect(liveActions(db, { agentId: 'reader' })).toEqual(['gmail.list:read']);

    hosted = 'pending';
    submitted = [];
    catalog.push({ slug: 'gmail.search', classification: 'read' });
    await preview();
    expect(submitted).toEqual([
      expect.objectContaining({
        kind: 'replace_agent_grants',
        agentId: 'reader',
        revisions: expect.arrayContaining([
          expect.objectContaining({ hostedRevisionId: hostedRef('gmail.list') }),
          expect.objectContaining({ hostedRevisionId: hostedRef('gmail.search') }),
        ]),
      }),
    ]);
    // Not wider before hosted authority confirms it.
    expect(liveActions(db, { agentId: 'reader' })).toEqual(['gmail.list:read']);

    // Reading the catalog again while it waits stages nothing new.
    await preview();
    expect(submitted).toHaveLength(1);

    const [command] = submitted;
    hostedStatus.set(command!.commandId, statusFor(command!, 'applied'));
    db.update(connectorManagedAuthorityOutbox)
      .set({ nextAttemptAt: null })
      .where(eq(connectorManagedAuthorityOutbox.commandId, command!.commandId))
      .run();
    await sync.recoverPending(new AbortController().signal);
    expect(liveActions(db, { agentId: 'reader' })).toEqual([
      'gmail.list:read',
      'gmail.search:read',
    ]);
  });

  it('closes an action reclassified out of Read at once, before hosted authority answers', async () => {
    const snapshot = await preview();
    await service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [
        { agentId: 'reader', operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
      ],
    });
    hosted = 'pending';
    catalog[0] = { slug: 'gmail.list', classification: 'write' };
    await preview();
    expect(liveActions(db, { agentId: 'reader' })).toEqual([]);
    expect(submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
  });
});
