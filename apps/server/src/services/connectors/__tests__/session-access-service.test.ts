import { beforeEach, describe, expect, it } from 'vitest';
import {
  agents,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  createDb,
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

  /** What the execution check reads for agent-a on one account in session-a. */
  const scope = (connectionId: string) =>
    agentGrantScope(db, { agentId: 'agent-a', sessionId: 'session-a', connectionId });
  const overrides = () => db.select().from(sessionConnectionOverrides).all();

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
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-a',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: 'connection-a',
        operationRevisionId: 'revision-a',
        createdBy: 'operator',
        createdAt: NOW,
      })
      .run();
    const query = new ConnectorOperatorQueryService({
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
    expect(scope('connection-a')).toMatchObject({ kind: 'scope' });
  });

  it('turning on is a no-op when the chat already inherits the app', async () => {
    await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(overrides()).toEqual([]);
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

  it('turns a chat handed to another agent back to its current agent’s own access', async () => {
    db.insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-b',
        connectionId: 'connection-a',
        state: 'attached',
        updatedAt: NOW,
      })
      .run();
    expect(scope('connection-a')).toEqual({ kind: 'denied', reason: 'other_agent' });
    await service.setAccess(OWNER, 'session-a', 'connection-a', { on: true });
    expect(scope('connection-a')).toMatchObject({ kind: 'scope' });
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
