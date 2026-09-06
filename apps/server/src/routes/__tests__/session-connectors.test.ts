import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  connectionOperationGrants,
  connectorOperationRevisions,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../../services/connectors/attachment-store.js';
import { ConnectorRegistry } from '../../services/connectors/registry.js';
import { SessionConnectorService } from '../../services/connectors/session-exposure.js';
import {
  createSessionConnectorsRouter,
  type SessionConnectorsRouterDeps,
} from '../session-connectors.js';

const fixture = swappableServer();

describe('session-connectors retained route', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let agentAccess: AgentConnectorAttachmentStore;
  let sessionAccess: SessionConnectorAttachmentStore;
  let service: SessionConnectorService;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db });
    provider = new FakeConnectorProvider();
    registry.register(provider);
    agentAccess = new AgentConnectorAttachmentStore(db);
    sessionAccess = new SessionConnectorAttachmentStore(db, () => 'agent-a');
    service = new SessionConnectorService({
      db,
      registry,
      agentAttachments: agentAccess,
      sessionAttachments: sessionAccess,
    });
  });

  function mount(
    authorizeOwnerAction: SessionConnectorsRouterDeps['authorizeOwnerAction'] = () => true
  ) {
    const app = express();
    app.use('/api/sessions', createSessionConnectorsRouter({ service, authorizeOwnerAction }));
    return fixture.mount(app);
  }

  it('requires owner authority before reads and retired writes', async () => {
    const app = mount((_req, res) => {
      res.status(403).end();
      return false;
    });
    await request(app).get('/api/sessions/s/connectors').expect(403);
    await request(fixture.server).post('/api/sessions/s/connectors/account-a').expect(403);
    await request(fixture.server).delete('/api/sessions/s/connectors/account-a').expect(403);
  });

  it('returns durable read-only access state', async () => {
    const flow = await provider.startConnect('gmail', { label: 'work' });
    const account = registry.recordConnect(
      provider,
      (await provider.pollConnect(flow.flowId)).account!
    );
    agentAccess.attach('agent-a', account.id);
    db.insert(connectorOperationRevisions)
      .values({
        id: 'revision-a',
        providerInstanceId: provider.instanceId,
        toolkit: account.toolkit,
        operationSlug: 'gmail.read',
        toolkitVersion: 'test-v1',
        schemaHash: 'sha256:route-test',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: JSON.stringify({ type: 'object', properties: {} }),
        discoveredAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    db.insert(connectionOperationGrants)
      .values({
        id: 'grant-a',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: account.id,
        operationRevisionId: 'revision-a',
        createdBy: 'owner',
        createdAt: '2026-09-06T12:00:00.000Z',
      })
      .run();

    const response = await request(mount()).get('/api/sessions/s/connectors').expect(200);
    expect(response.body.accounts[0]).toMatchObject({ accountId: account.id, access: 'inherited' });
    expect(response.body.accounts[0]).not.toHaveProperty('serverName');
    expect(response.body.accounts[0]).not.toHaveProperty('exposed');
  });

  it.each(['post', 'delete'] as const)(
    '%s returns a typed 410 and writes no override',
    async (method) => {
      const response = await request(mount())[method]('/api/sessions/s/connectors/account-a');
      expect(response.status).toBe(410);
      expect(response.body).toEqual({
        code: 'CONNECTOR_ACCESS_MANAGED_IN_CONNECTIONS',
        error: 'Connection access is managed in Connections. Review this agent under /connections.',
      });
      expect(sessionAccess.listForSession('s')).toEqual([]);
    }
  );
});
