import { beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  createDb,
  eq,
  isNull,
  runMigrations,
  sessionConnectionOverrides,
  type Db,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { SessionConnectorAttachmentStore } from '../attachment-store.js';
import { agentGrantScope } from '../execution/agent-grant-scope.js';
import { ConnectorRegistry } from '../registry.js';
import { ConnectorOperatorQueryService } from '../resources/operator-query-service.js';
import { ConnectorSessionAccessService } from '../resources/session-access-service.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const FOREIGN_OWNER = { kind: 'local_install', installationId: 'install-b' } as const;
const PROVIDER_ID = ConnectorProviderInstanceIdSchema.parse('provider-a');
const NOW = '2026-09-28T18:00:00.000Z';

function connection(id: string) {
  return {
    id,
    providerInstanceId: PROVIDER_ID,
    externalAccountRef: `private-${id}`,
    toolkit: 'gmail',
    label: id,
    status: 'active' as const,
    lifecycleState: 'connected' as const,
    enabled: true,
    grantReconciliationStatus: 'ready' as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('ConnectorSessionAccessService', () => {
  let db: Db;
  let service: ConnectorSessionAccessService;
  let query: ConnectorOperatorQueryService;

  /** What the execution check reads for agent-a on one account in session-a. */
  const scope = (connectionId: string) =>
    agentGrantScope(db, { agentId: 'agent-a', sessionId: 'session-a', connectionId });
  const overrides = () => db.select().from(sessionConnectionOverrides).all();
  /**
   * The revisions an agent can actually use on connection-a in session-a, read
   * exactly as the execution check reads them, or why it is denied.
   */
  const usable = (agentId: string) => {
    const resolved = agentGrantScope(db, {
      agentId,
      sessionId: 'session-a',
      connectionId: 'connection-a',
    });
    if (resolved.kind === 'denied') return resolved.reason;
    return db
      .select({ id: connectionOperationGrants.operationRevisionId })
      .from(connectionOperationGrants)
      .where(
        and(
          resolved.subject,
          eq(connectionOperationGrants.connectionId, 'connection-a'),
          isNull(connectionOperationGrants.revokedAt)
        )
      )
      .all()
      .map((row) => row.id)
      .sort();
  };
  /** Give the chat its own hand-picked grant: agentId may use `revision` here only. */
  const chatGrant = (agentId: string, revision: string) =>
    db
      .insert(connectionOperationGrants)
      .values({
        id: `session-grant-${agentId}-${revision}`,
        subjectType: 'session',
        subjectId: 'session-a',
        agentId,
        connectionId: 'connection-a',
        operationRevisionId: revision,
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
  const override = (agentId: string, state: 'attached' | 'detached') =>
    db
      .insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId,
        connectionId: 'connection-a',
        state,
        updatedAt: NOW,
      })
      .run();

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    const registry = new ConnectorRegistry({
      db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    registry.register(
      new FakeConnectorProvider({
        instanceId: PROVIDER_ID,
        type: 'fake',
        custody: 'managed',
        toolkits: [
          {
            slug: 'gmail',
            displayName: 'Gmail',
            authKind: 'oauth2',
            authentication: { status: 'available' },
          },
        ],
      }),
      'material-a'
    );
    db.insert(agents)
      .values({
        id: 'agent-a',
        name: 'agent-a',
        displayName: 'Researcher',
        runtime: 'claude-code',
        projectPath: '/agents/agent-a',
        registeredAt: NOW,
        updatedAt: NOW,
      })
      .run();
    // connection-a: given to agent-a account-wide. connection-b: never given.
    db.insert(connections)
      .values([connection('connection-a'), connection('connection-b')])
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-send',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.send',
        toolkitVersion: '20260901',
        schemaHash: 'sha256:send',
        capabilityClassification: 'write',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
        discoveredAt: NOW,
      })
      .run();
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'gmail.messages.list',
        toolkitVersion: '20260901',
        schemaHash: 'sha256:a',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
        discoveredAt: NOW,
      })
      .run();
    // Account-wide, agent-a may read and send on connection-a.
    db.insert(connectionOperationGrants)
      .values(
        ['revision-a', 'revision-send'].map((revision) => ({
          id: `grant-${revision}`,
          subjectType: 'agent' as const,
          subjectId: 'agent-a',
          agentId: 'agent-a',
          connectionId: 'connection-a',
          operationRevisionId: revision,
          createdBy: 'operator',
          createdAt: NOW,
        }))
      )
      .run();
    query = new ConnectorOperatorQueryService({
      db,
      registry,
      sessions: {
        resolveSessionAgent: (owner, sessionId) =>
          owner.kind === 'local_install' &&
          owner.installationId === OWNER.installationId &&
          sessionId === 'session-a'
            ? { agentId: 'agent-a' }
            : undefined,
      },
      agentOwnership: { ownsAgent: () => true },
    });
    service = new ConnectorSessionAccessService({
      db,
      query,
      overrides: new SessionConnectorAttachmentStore(db, () => undefined),
    });
  });

  it('turns an app off for one chat and back on to exactly the agent’s account-wide access', async () => {
    const off = await service.setAccess(OWNER, 'session-a', 'connection-a', { on: false });
    expect(off.connections).toMatchObject([
      {
        connectionId: 'connection-a',
        thisChat: 'off',
        readiness: { reason: 'off_for_this_chat' },
      },
    ]);
    expect(scope('connection-a')).toEqual({ kind: 'denied', reason: 'detached' });
    // Only this chat: another chat of the same agent is untouched.
    expect(
      agentGrantScope(db, {
        agentId: 'agent-a',
        sessionId: 'session-z',
        connectionId: 'connection-a',
      })
    ).toMatchObject({ kind: 'scope' });

    const on = await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(on.connections).toMatchObject([
      {
        connectionId: 'connection-a',
        source: 'agent',
        thisChat: 'on',
        readiness: { state: 'ready' },
      },
    ]);
    expect(overrides()).toEqual([]);
    expect(usable('agent-a')).toEqual(['revision-a', 'revision-send']);
  });

  it('turning on is a no-op when the chat already inherits the app', async () => {
    await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(overrides()).toEqual([]);
  });

  it('turns a chat the owner narrowed by hand off and back on to exactly what it had', async () => {
    // The chat may only read, although the agent may also send everywhere else.
    chatGrant('agent-a', 'revision-a');
    override('agent-a', 'attached');
    const before = { overrides: overrides(), usable: usable('agent-a') };
    expect(before.usable).toEqual(['revision-a']);
    const start = await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    // Already on: nothing written.
    expect(overrides()).toEqual(before.overrides);
    expect(start.connections).toMatchObject([
      { source: 'this_chat', thisChat: 'on', operationRevisionIds: ['revision-a'] },
    ]);

    const off = await service.setAccess(OWNER, 'session-a', 'connection-a', { on: false });
    expect(off.connections).toMatchObject([
      {
        thisChat: 'off',
        readiness: {
          reason: 'off_for_this_chat',
          fix: { action: 'turn_on_for_this_chat', fixableBy: 'person' },
        },
      },
    ]);
    expect(usable('agent-a')).toBe('detached');
    // Off leaves the chat's own grant in place, so on can put it back.
    expect(
      db
        .select()
        .from(connectionOperationGrants)
        .all()
        .filter((row) => row.subjectType === 'session' && row.revokedAt === null)
    ).toHaveLength(1);

    const on = await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(on).toEqual(start);
    expect(usable('agent-a')).toEqual(before.usable);
    expect(overrides()).toMatchObject(
      before.overrides.map(({ updatedAt: _updatedAt, ...row }) => row)
    );
  });

  it('never widens a chat past what the agent was given account-wide', async () => {
    // Even with a turned-off row already on the account, the agent was never
    // given it, so turning it on could only add access: refused, row untouched.
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: 'connection-b',
        state: 'detached',
        updatedAt: NOW,
      })
      .run();
    await expect(
      service.setAccess(OWNER, 'session-a', 'connection-b', { on: true })
    ).rejects.toMatchObject({ code: 'connection_not_found' });
    await expect(
      service.setAccess(OWNER, 'session-a', 'connection-b', { on: false })
    ).rejects.toMatchObject({ code: 'connection_not_found' });
    expect(overrides()).toMatchObject([{ connectionId: 'connection-b', state: 'detached' }]);
  });

  it('turns a chat handed over from another agent on to only its current agent’s access', async () => {
    // agent-b had this app turned off here before the chat moved to agent-a.
    override('agent-b', 'detached');
    expect(usable('agent-a')).toBe('other_agent');
    await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(overrides()).toEqual([]);
    expect(usable('agent-a')).toEqual(['revision-a', 'revision-send']);

    // With agent-a's own chat grant, the handover lands on that, not wider.
    chatGrant('agent-a', 'revision-a');
    override('agent-b', 'detached');
    await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(overrides()).toMatchObject([{ agentId: 'agent-a', state: 'attached' }]);
    expect(usable('agent-a')).toEqual(['revision-a']);
  });

  it('refuses to drop a limit the owner set on this chat for another agent', async () => {
    // The owner limited this chat to sending for agent-b, then it moved to agent-a.
    chatGrant('agent-b', 'revision-send');
    override('agent-b', 'attached');
    const before = overrides();
    await expect(
      service.setAccess(OWNER, 'session-a', 'connection-a', { on: true })
    ).rejects.toMatchObject({
      code: 'session_access_other_agent',
      message: expect.stringContaining('another agent'),
    });
    // The chat's view offers no switch there, and no fix that would be refused.
    const view = await query.sessionConnections(OWNER, 'session-a');
    expect(view.connections[0]?.thisChat).toBeUndefined();
    expect(view.connections[0]?.readiness.fix).toBeUndefined();
    // Untouched: handed back, agent-b still has only what the owner picked.
    expect(overrides()).toEqual(before);
    expect(usable('agent-b')).toEqual(['revision-send']);
    expect(usable('agent-a')).toBe('other_agent');

    // Once agent-b's own grant is revoked there is no limit left to drop.
    db.update(connectionOperationGrants)
      .set({ revokedAt: NOW })
      .where(eq(connectionOperationGrants.id, 'session-grant-agent-b-revision-send'))
      .run();
    await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(overrides()).toEqual([]);
  });

  it('does not count a chat’s revoked grants as its own: on goes back to the agent’s access', async () => {
    chatGrant('agent-a', 'revision-a');
    db.update(connectionOperationGrants)
      .set({ revokedAt: NOW })
      .where(eq(connectionOperationGrants.id, 'session-grant-agent-a-revision-a'))
      .run();
    override('agent-a', 'detached');
    await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(overrides()).toEqual([]);
    expect(usable('agent-a')).toEqual(['revision-a', 'revision-send']);
  });

  it('refuses an unknown chat, a foreign owner’s chat, and a malformed account id', async () => {
    await expect(
      service.setAccess(OWNER, 'session-x', 'connection-a', { on: false })
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(
      service.setAccess(FOREIGN_OWNER, 'session-a', 'connection-a', { on: false })
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(service.setAccess(OWNER, 'session-a', '', { on: false })).rejects.toThrow();
    expect(overrides()).toEqual([]);
  });
});
