import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  apikey,
  connections,
  connectorProviderInstances,
  connectionOperationGrants,
  connectorOperationRevisions,
  createDb,
  runMigrations,
} from '@dorkos/db';
import type { ConnectorOwnerAuthority } from '../../services/connectors/principal/server-principal.js';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import { ConnectorManagementActionService } from '../../services/connectors/management-action-service.js';
import { ConnectionIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorProgramPrincipalService } from '../../services/connectors/principal/program-principal-service.js';
import { ConnectorSubscriptionStore } from '../../services/connectors/events/subscription-store.js';
import { ConnectorEventAccessQueryService } from '../../services/connectors/events/access-query-service.js';
import { createConnectorExecutionRouter } from '../connector-execution.js';

const target = swappableServer();
const now = '2026-09-07T12:00:00.000Z';
const owner = { kind: 'user', userId: 'owner-a' } as const;
const dispose: Array<() => void> = [];
afterEach(() => {
  dispose.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
});

function fixture() {
  const db = createDb(':memory:');
  runMigrations(db);
  dispose.push(() => db.$client.close());
  const registry = new ConnectorRegistry({ db });
  for (const id of ['a', 'b'])
    db.insert(apikey)
      .values({
        id: `key-${id}`,
        referenceId: `owner-${id}`,
        key: `stored-hash-${id}`,
        enabled: true,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      })
      .run();
  const programs = new ConnectorProgramPrincipalService(db, () => new Date(now));
  const store = new ConnectorSubscriptionStore(db);
  const ownership = {
    ownsAgent: vi.fn(
      async (caller: ConnectorOwnerAuthority, agentId: string) =>
        caller.kind === 'user' &&
        caller.userId === owner.userId &&
        ['agent-a', 'agent-b'].includes(agentId)
    ),
  };
  const managed = { ready: vi.fn(() => true) };
  const access = new ConnectorEventAccessQueryService(store, ownership, programs, managed);

  function seed(suffix: string, agentId = 'agent-a', accountOwner: string = owner.userId) {
    const providerInstanceId = `provider-${suffix}`;
    const connectionId = `account-${suffix}`;
    db.insert(connectorProviderInstances)
      .values({
        id: providerInstanceId,
        type: 'test',
        mode: 'byo',
        displayName: 'Synthetic',
        custody: 'self-host',
        capabilityJson: '{}',
        status: 'available',
        ownerKind: 'user',
        ownerId: accountOwner,
        executionConfigGeneration: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(connections)
      .values({
        id: connectionId,
        providerInstanceId,
        externalAccountRef: `private-account-${suffix}`,
        toolkit: 'gmail',
        label: `Mail ${suffix}`,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const scopeOwner = { kind: 'user', userId: accountOwner } as const;
    const [definition] = store.discover(
      store.connection(scopeOwner, connectionId),
      [
        {
          eventType: 'NEW_MAIL',
          displayName: 'New mail',
          toolkit: 'gmail',
          toolkitVersion: 'v1',
          definitionHash: `sha256:${'a'.repeat(64)}`,
          filterSchema: { type: 'object', properties: { label: { type: 'string' } } },
          payloadSchema: {},
          deliveryMode: 'unknown',
          expectedCadenceSeconds: null,
        },
      ],
      now
    );
    const selection = store.propose(
      scopeOwner,
      {
        connectionId: connectionId as never,
        definitionId: definition.id,
        agentId,
        destination: { kind: 'agent', id: agentId },
        filter: { label: 'Work' },
      },
      now
    );
    // Persist the result of prior receive approval, with no operation grant.
    db.$client
      .prepare(
        "UPDATE connector_event_bindings SET state = 'ready', provider_trigger_ref = 'private-trigger' WHERE id = ?"
      )
      .run(selection.bindingId);
    db.$client
      .prepare('UPDATE connector_event_subscriptions SET enabled = 1 WHERE id = ?')
      .run(selection.subscriptionId);
    return { ...selection, connectionId };
  }
  const app = express();
  app.use(
    '/api/connectors',
    createConnectorExecutionRouter({
      connectorRegistry: { migrationHealth: () => ({ status: 'ready', migrated: false }) },
      capabilities: { invoke: vi.fn() },
      authorization: { capabilityIdForTarget: vi.fn() },
      access: {
        listConnections: vi.fn(),
        listOperations: vi.fn(),
        listAgentUsage: vi.fn(),
        listOperatorUsage: vi.fn(),
      },
      eventAccess: access,
      programPrincipals: programs,
      resolveOwner: (user) => (user ? { kind: 'user', userId: user.userId } : undefined),
      loginEnabled: () => true,
      trustedOrigins: () => ['http://localhost:4242'],
      verifyUser: async (req) =>
        req.headers.authorization === 'Bearer good'
          ? { userId: 'owner-a', credential: 'api-key', credentialId: 'key-a' }
          : req.headers.authorization === 'Bearer other'
            ? { userId: 'owner-b', credential: 'api-key', credentialId: 'key-b' }
            : req.headers.authorization === 'Bearer cookie'
              ? { userId: 'owner-a', credential: 'cookie' }
              : null,
    })
  );
  target.mount(app);
  const get = (query: Record<string, string | number> = { agentId: 'agent-a' }) =>
    request(target.server)
      .get('/api/connectors/accessible/subscriptions')
      .set('Authorization', 'Bearer good')
      .query(query);
  return { db, registry, store, programs, ownership, managed, seed, get };
}

describe('program-scoped notification subscription reads', () => {
  it('returns only the selected receive-only agent and owner, with safe exact scope aliases', async () => {
    const f = fixture();
    const selected = f.seed('selected');
    f.seed('other-agent', 'agent-b');
    f.seed('foreign-owner', 'agent-a', 'owner-b');
    const pending = f.seed('pending');
    f.db.$client
      .prepare('UPDATE connector_event_subscriptions SET enabled = 0 WHERE id = ?')
      .run(pending.subscriptionId);
    const revoked = f.seed('revoked');
    f.store.revoke(owner, revoked.subscriptionId, now);
    const response = await f.get().expect(200);
    expect(response.body.agentId).toBe('agent-a');
    expect(response.body.subscriptions).toHaveLength(1);
    expect(response.body.subscriptions[0]).toMatchObject({
      id: selected.subscriptionId,
      connectionId: selected.connectionId,
      label: 'Mail selected',
      toolkit: 'gmail',
      agentId: 'agent-a',
      state: 'active',
      filter: { label: 'Work' },
      deliveryMode: 'unknown',
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-account|private-trigger|providerInstanceId|payload|webhookSecret|foreign-owner|other-agent/
    );
    expect(f.db.select().from(connectionOperationGrants).all()).toHaveLength(0);
  });

  it('keeps receive visibility after actual operation-only grant removal', async () => {
    const f = fixture();
    const selected = f.seed('selected');
    f.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'read-revision',
        providerInstanceId: 'provider-selected',
        toolkit: 'gmail',
        operationSlug: 'LIST_MAIL',
        toolkitVersion: 'v1',
        schemaHash: 'hash',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{}',
        discoveredAt: now,
      })
      .run();
    const actions = new ConnectorManagementActionService({
      db: f.db,
      registry: f.registry,
      authorityCleanup: {
        revokeAgent: vi.fn(),
        revokeAgentConnection: vi.fn(),
        revokeConnection: vi.fn(),
      },
      now: () => new Date(now),
    });
    const action = {
      version: 1,
      kind: 'set_agent_access',
      connectionId: ConnectionIdSchema.parse(selected.connectionId),
      agentId: 'agent-a',
      operationRevisionIds: ['read-revision'],
    } as const;
    await actions.apply(owner, {
      ...action,
      operationRevisionIds: [...action.operationRevisionIds],
    });
    expect(f.db.select().from(connectionOperationGrants).get()?.revokedAt).toBeNull();
    await actions.apply(owner, { ...action, operationRevisionIds: [] });
    expect(f.db.select().from(connectionOperationGrants).get()?.revokedAt).toBe(now);
    expect((await f.get().expect(200)).body.subscriptions[0]).toMatchObject({
      id: selected.subscriptionId,
      state: 'active',
    });
  });

  it('marks managed receive grants unavailable without an exact ACK and omits an obsolete provider generation', async () => {
    const f = fixture();
    const selected = f.seed('selected');
    f.db.$client.exec("UPDATE connector_provider_instances SET mode = 'managed'");
    f.managed.ready.mockReturnValue(false);
    expect((await f.get().expect(200)).body.subscriptions[0].state).toBe('unavailable');
    expect(f.managed.ready).toHaveBeenCalledWith(selected.subscriptionId, selected.scopeVersion);
    f.managed.ready.mockReturnValue(true);
    expect((await f.get().expect(200)).body.subscriptions[0].state).toBe('active');
    f.db.$client.exec('UPDATE connector_provider_instances SET execution_config_generation = 2');
    expect((await f.get().expect(200)).body.subscriptions).toEqual([]);
  });

  it('requires the explicit agent and refuses unknown scope selectors', async () => {
    const f = fixture();
    f.seed('selected');
    await f.get({}).expect(400);
    await f.get({ agentId: ' ' }).expect(400);
    await f.get({ agentId: 'agent-a', ownerId: 'owner-b' }).expect(400);
    await f.get({ agentId: 'foreign-agent' }).expect(404);
    await f.get({ agentId: 'agent-a', limit: 101 }).expect(400);
    await f.get({ agentId: 'agent-a', cursor: 'invalid' }).expect(400);
  });

  it('refuses missing, cookie-only, other-owner and inherited agent identity credentials', async () => {
    const f = fixture();
    f.seed('selected');
    await request(target.server)
      .get('/api/connectors/accessible/subscriptions?agentId=agent-a')
      .expect(401);
    await request(target.server)
      .get('/api/connectors/accessible/subscriptions?agentId=agent-a')
      .set('Authorization', 'Bearer cookie')
      .expect(401);
    await request(target.server)
      .get('/api/connectors/accessible/subscriptions?agentId=agent-a')
      .set('Authorization', 'Bearer other')
      .expect(404);
    await f.get().set('X-DorkOS-Agent', 'even-an-invalid-agent-token').expect(403);
  });

  it.each(['disabled', 'reassigned', 'expired'] as const)(
    'revalidates a %s program key after asynchronous agent ownership and before reading',
    async (change) => {
      const f = fixture();
      f.seed('selected');
      f.ownership.ownsAgent.mockImplementationOnce(async () => {
        await Promise.resolve();
        f.db.$client.exec(
          change === 'disabled'
            ? "UPDATE apikey SET enabled = 0 WHERE id = 'key-a'"
            : change === 'reassigned'
              ? "UPDATE apikey SET reference_id = 'owner-b' WHERE id = 'key-a'"
              : "UPDATE apikey SET expires_at = 1 WHERE id = 'key-a'"
        );
        return true;
      });
      const projection = vi.spyOn(f.store, 'get');
      await f.get().expect(401);
      expect(projection).not.toHaveBeenCalled();
    }
  );

  it('paginates the same agent deterministically and rejects another agent cursor', async () => {
    const f = fixture();
    const a = f.seed('a');
    const b = f.seed('b');
    f.seed('c', 'agent-b');
    const first = await f.get({ agentId: 'agent-a', limit: 1 }).expect(200);
    const second = await f
      .get({ agentId: 'agent-a', limit: 1, cursor: first.body.nextCursor })
      .expect(200);
    expect([first.body.subscriptions[0].id, second.body.subscriptions[0].id].sort()).toEqual(
      [a.subscriptionId, b.subscriptionId].sort()
    );
    expect(second.body.nextCursor).toBeUndefined();
    await f.get({ agentId: 'agent-b', cursor: first.body.nextCursor }).expect(400);
  });

  it('reports connection pause without implying readiness, and drops revoked receive grants', async () => {
    const f = fixture();
    const selected = f.seed('selected');
    f.db.$client
      .prepare('UPDATE connections SET enabled = 0 WHERE id = ?')
      .run(selected.connectionId);
    expect((await f.get().expect(200)).body.subscriptions[0].state).toBe('unavailable');
    f.store.revoke(owner, selected.subscriptionId, now);
    expect((await f.get().expect(200)).body.subscriptions).toEqual([]);
  });
});
